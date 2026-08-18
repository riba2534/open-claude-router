use bytes::Bytes;
use open_claude_router::sse::{aggregate_chat_sse, aggregate_responses_sse};
use serde_json::Value;

const PREVIEW_CHARS: usize = 240;

/// Values reconstructed from a terminal upstream response body, reusing the
/// router's own SSE aggregators so the semantics match forwarding exactly.
#[derive(Default)]
pub struct Derived {
    pub agg_response: Option<Value>,
    pub finish_reason: Option<String>,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub cached_tokens: Option<i64>,
    pub reasoning_tokens: Option<i64>,
    pub preview: Option<String>,
}

pub fn derive_response(
    format: &str,
    content_type: &str,
    body_json: Option<&Value>,
    body_text: Option<&str>,
) -> Derived {
    let final_json = if is_sse(content_type, body_text) {
        let raw = Bytes::from(body_text.unwrap_or_default().as_bytes().to_vec());
        let aggregated = match format {
            "responses" => aggregate_responses_sse(raw),
            _ => aggregate_chat_sse(raw),
        };
        // Cancelled or truncated streams legitimately fail aggregation;
        // the dashboard then falls back to the raw event view.
        aggregated.ok()
    } else if let Some(body) = body_json {
        Some(body.clone())
    } else {
        body_text.and_then(|text| serde_json::from_str::<Value>(text).ok())
    };

    let Some(final_json) = final_json else {
        return Derived::default();
    };
    let mut derived = match format {
        "responses" => extract_responses(&final_json),
        _ => extract_chat(&final_json),
    };
    derived.agg_response = Some(final_json);
    derived
}

fn is_sse(content_type: &str, body_text: Option<&str>) -> bool {
    if content_type
        .to_ascii_lowercase()
        .contains("text/event-stream")
    {
        return true;
    }
    body_text.is_some_and(|text| {
        let head = text.trim_start();
        head.starts_with("data:") || head.starts_with("event:")
    })
}

fn extract_chat(response: &Value) -> Derived {
    let usage = response.get("usage");
    let choice = response.pointer("/choices/0");
    let message = choice.and_then(|choice| choice.get("message"));
    let mut preview = message
        .and_then(|message| message.get("content"))
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_default();
    if preview.trim().is_empty()
        && let Some(calls) = message
            .and_then(|message| message.get("tool_calls"))
            .and_then(Value::as_array)
    {
        let names = calls
            .iter()
            .filter_map(|call| call.pointer("/function/name").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join(", ");
        preview = format!("→ tool_calls: {names}");
    }
    Derived {
        agg_response: None,
        finish_reason: choice
            .and_then(|choice| choice.get("finish_reason"))
            .and_then(Value::as_str)
            .map(str::to_owned),
        input_tokens: int_at(usage, "/prompt_tokens"),
        output_tokens: int_at(usage, "/completion_tokens"),
        cached_tokens: int_at(usage, "/prompt_tokens_details/cached_tokens"),
        reasoning_tokens: int_at(usage, "/completion_tokens_details/reasoning_tokens"),
        preview: non_empty_preview(preview),
    }
}

fn extract_responses(response: &Value) -> Derived {
    let usage = response.get("usage");
    let mut preview = String::new();
    let mut tool_names = Vec::new();
    if let Some(output) = response.get("output").and_then(Value::as_array) {
        for item in output {
            match item.get("type").and_then(Value::as_str) {
                Some("message") => {
                    if let Some(parts) = item.get("content").and_then(Value::as_array) {
                        for part in parts {
                            if part.get("type").and_then(Value::as_str) == Some("output_text")
                                && let Some(text) = part.get("text").and_then(Value::as_str)
                            {
                                preview.push_str(text);
                            }
                        }
                    }
                }
                Some("function_call") => {
                    if let Some(name) = item.get("name").and_then(Value::as_str) {
                        tool_names.push(name.to_owned());
                    }
                }
                _ => {}
            }
        }
    }
    if preview.trim().is_empty() && !tool_names.is_empty() {
        preview = format!("→ function_call: {}", tool_names.join(", "));
    }
    let mut finish = response
        .get("status")
        .and_then(Value::as_str)
        .map(str::to_owned);
    if let Some(reason) = response
        .pointer("/incomplete_details/reason")
        .and_then(Value::as_str)
    {
        finish = Some(format!("incomplete: {reason}"));
    }
    Derived {
        agg_response: None,
        finish_reason: finish,
        input_tokens: int_at(usage, "/input_tokens"),
        output_tokens: int_at(usage, "/output_tokens"),
        cached_tokens: int_at(usage, "/input_tokens_details/cached_tokens"),
        reasoning_tokens: int_at(usage, "/output_tokens_details/reasoning_tokens"),
        preview: non_empty_preview(preview),
    }
}

fn int_at(root: Option<&Value>, pointer: &str) -> Option<i64> {
    root?.pointer(pointer)?.as_i64()
}

fn non_empty_preview(text: String) -> Option<String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    let mut chars = trimmed.chars();
    let mut bounded = chars.by_ref().take(PREVIEW_CHARS).collect::<String>();
    if chars.next().is_some() {
        bounded.push('…');
    }
    Some(bounded)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn chat_json_body_yields_usage_and_preview() {
        let body = json!({
            "choices": [{
                "finish_reason": "stop",
                "message": {"content": "hello world"}
            }],
            "usage": {
                "prompt_tokens": 12,
                "completion_tokens": 5,
                "prompt_tokens_details": {"cached_tokens": 4},
                "completion_tokens_details": {"reasoning_tokens": 2}
            }
        });
        let derived = derive_response("chat-completions", "application/json", Some(&body), None);
        assert_eq!(derived.finish_reason.as_deref(), Some("stop"));
        assert_eq!(derived.input_tokens, Some(12));
        assert_eq!(derived.output_tokens, Some(5));
        assert_eq!(derived.cached_tokens, Some(4));
        assert_eq!(derived.reasoning_tokens, Some(2));
        assert_eq!(derived.preview.as_deref(), Some("hello world"));
        assert!(derived.agg_response.is_some());
    }

    #[test]
    fn chat_sse_stream_is_aggregated() {
        let sse = concat!(
            "data: {\"id\":\"c1\",\"object\":\"chat.completion.chunk\",\"model\":\"m\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"hi \"}}]}\n\n",
            "data: {\"id\":\"c1\",\"object\":\"chat.completion.chunk\",\"model\":\"m\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"there\"},\"finish_reason\":\"stop\"}]}\n\n",
            "data: {\"id\":\"c1\",\"object\":\"chat.completion.chunk\",\"model\":\"m\",\"choices\":[],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":2}}\n\n",
            "data: [DONE]\n\n"
        );
        let derived = derive_response("chat-completions", "text/event-stream", None, Some(sse));
        assert_eq!(derived.preview.as_deref(), Some("hi there"));
        assert_eq!(derived.finish_reason.as_deref(), Some("stop"));
        assert_eq!(derived.input_tokens, Some(3));
    }

    #[test]
    fn cancelled_stream_falls_back_to_raw() {
        let sse = "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"par\"}}]}\n\n";
        let derived = derive_response("chat-completions", "text/event-stream", None, Some(sse));
        assert!(derived.agg_response.is_none());
        assert!(derived.preview.is_none());
    }
}
