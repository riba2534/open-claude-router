use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::{Value, json};
use uuid::Uuid;

use super::{bounded_json, protocol_error};
use crate::{
    error::{ApiError, error_type_for_status, status_from_openai_error},
    sse::format_sse_event,
};

const CHAT_SIGNATURE_PREFIX: &str = "ocr-chat-reasoning-v1:";

pub fn transform_chat_json_response(
    payload: &Value,
    omit_thinking: bool,
) -> Result<Value, ApiError> {
    if let Some(error) = payload.get("error") {
        let status = status_from_openai_error(error, axum::http::StatusCode::OK);
        return Err(ApiError::new(
            status,
            error_type_for_status(status),
            "upstream_logical_error",
            error
                .get("message")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
                .unwrap_or_else(|| bounded_json(error)),
        )
        .retryable()
        .with_request_id(
            payload
                .get("request_id")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned),
        ));
    }
    let choice = payload
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .ok_or_else(|| protocol_error("upstream Chat response contains no choice message"))?;
    let message = choice
        .get("message")
        .ok_or_else(|| protocol_error("upstream Chat response contains no choice message"))?;
    let finish_reason = choice.get("finish_reason").and_then(Value::as_str);
    let refusal_text = message
        .get("refusal")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let is_refusal = finish_reason == Some("content_filter") || !refusal_text.is_empty();
    let incomplete = finish_reason == Some("length") || is_refusal;
    let mut content = Vec::new();

    if let Some(blocks) = message.get("output_blocks").and_then(Value::as_array) {
        for block in blocks {
            match block.get("type").and_then(Value::as_str) {
                Some("thinking") => content.push(json!({
                    "type":"thinking",
                    "thinking":if omit_thinking { "" } else { block.get("thinking").and_then(Value::as_str).unwrap_or_default() },
                    "signature":block.get("signature").cloned().unwrap_or(Value::Null)
                })),
                Some("text") => content.push(json!({"type":"text","text":block.get("text").and_then(Value::as_str).unwrap_or_default()})),
                Some("tool_use") => content.push(json!({
                    "type":"tool_use",
                    "id":block.get("id").cloned().unwrap_or(Value::Null),
                    "name":block.get("name").cloned().unwrap_or(Value::Null),
                    "input":parse_tool_input(block.get("input"))?,
                    "caller":{"type":"direct"}
                })),
                Some("server_tool_use" | "web_search_tool_result") => content.push(block.clone()),
                _ => content.push(json!({"type":"text","text":bounded_json(block)})),
            }
        }
    } else {
        let mut thinking_by_call: std::collections::HashMap<String, Vec<Value>> =
            std::collections::HashMap::new();
        if let Some(blocks) = message.get("thinking_blocks").and_then(Value::as_array) {
            for block in blocks {
                let text = block
                    .get("content")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let signature = block
                    .get("signature")
                    .and_then(Value::as_str)
                    .filter(|signature| is_router_signature(signature))
                    .map(ToOwned::to_owned)
                    .unwrap_or_else(|| encode_chat_signature(text));
                let anthropic = json!({
                    "type":"thinking",
                    "thinking":if omit_thinking { "" } else { text },
                    "signature":signature
                });
                if let Some(call_id) = block.get("tool_call_id").and_then(Value::as_str) {
                    thinking_by_call
                        .entry(call_id.to_owned())
                        .or_default()
                        .push(anthropic);
                } else {
                    content.push(anthropic);
                }
            }
        } else {
            let thinking = message
                .pointer("/thinking/content")
                .and_then(Value::as_str)
                .or_else(|| message.get("reasoning_content").and_then(Value::as_str));
            let original_signature = message
                .pointer("/thinking/signature")
                .and_then(Value::as_str);
            if thinking.is_some_and(|text| !text.is_empty()) || original_signature.is_some() {
                let text = thinking.unwrap_or_default();
                let signature = original_signature
                    .filter(|signature| is_router_signature(signature))
                    .map(ToOwned::to_owned)
                    .unwrap_or_else(|| encode_chat_signature(text));
                content.push(json!({
                    "type":"thinking",
                    "thinking":if omit_thinking { "" } else { text },
                    "signature":signature
                }));
            }
        }

        let mut content_texts = Vec::new();
        match message.get("content") {
            Some(Value::String(text)) if !text.is_empty() => {
                content_texts.push(text.clone());
                content.push(json!({"type":"text","text":text}));
            }
            Some(Value::Array(parts)) => {
                for part in parts {
                    let text = match part {
                        Value::String(text) => text.clone(),
                        _ if part.get("type").and_then(Value::as_str) == Some("text") => part
                            .get("text")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_owned(),
                        _ if part.get("type").and_then(Value::as_str) == Some("image_url") => {
                            "[generated image omitted]".to_owned()
                        }
                        _ => bounded_json(part),
                    };
                    content_texts.push(text.clone());
                    content.push(json!({"type":"text","text":text}));
                }
            }
            _ => {}
        }
        let citations = message
            .get("annotations")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|item| {
                item.get("type").and_then(Value::as_str) == Some("url_citation")
                    && item
                        .pointer("/url_citation/url")
                        .and_then(Value::as_str)
                        .is_some_and(|url| !url.is_empty())
            })
            .cloned()
            .collect::<Vec<_>>();
        if !citations.is_empty() {
            content.push(json!({"type":"text","text":bounded_json(&json!({
                "type":"openai_url_citations","annotations":citations
            }))}));
        }
        if let Some(transcript) = message.pointer("/audio/transcript").and_then(Value::as_str)
            && !transcript.is_empty()
            && !content_texts.iter().any(|existing| existing == transcript)
            && content_texts.concat() != transcript
        {
            content.push(json!({"type":"text","text":transcript}));
        }
        if message
            .pointer("/audio/data")
            .and_then(Value::as_str)
            .is_some_and(|data| !data.is_empty())
        {
            content.push(json!({"type":"text","text":"[generated audio omitted]"}));
        }
        if !refusal_text.is_empty() {
            content.push(json!({"type":"text","text":refusal_text}));
        }
        if let Some(calls) = message.get("tool_calls").and_then(Value::as_array) {
            for call in calls {
                let id = call
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|id| !id.is_empty())
                    .ok_or_else(|| {
                        protocol_error("upstream tool call is missing id or function name")
                    })?;
                let name = call
                    .pointer("/function/name")
                    .and_then(Value::as_str)
                    .filter(|name| !name.is_empty())
                    .ok_or_else(|| {
                        protocol_error("upstream tool call is missing id or function name")
                    })?;
                if let Some(reasoning) = thinking_by_call.remove(id) {
                    content.extend(reasoning);
                }
                let arguments = call
                    .pointer("/function/arguments")
                    .cloned()
                    .unwrap_or_else(|| Value::String("{}".into()));
                if incomplete {
                    content.push(json!({"type":"text","text":format!(
                        "[incomplete tool_use {name}: {}]",
                        arguments.as_str().unwrap_or_default()
                    )}));
                } else {
                    content.push(json!({
                        "type":"tool_use",
                        "id":id,
                        "name":name,
                        "input":parse_tool_input(Some(&arguments))?,
                        "caller":{"type":"direct"}
                    }));
                }
            }
        } else if let Some(name) = message
            .pointer("/function_call/name")
            .and_then(Value::as_str)
        {
            let arguments = message.pointer("/function_call/arguments").cloned();
            if incomplete {
                content.push(json!({"type":"text","text":format!(
                    "[incomplete tool_use {name}: {}]",
                    arguments.as_ref().and_then(Value::as_str).unwrap_or_default()
                )}));
            } else {
                content.push(json!({
                    "type":"tool_use",
                    "id":format!("call_{}",Uuid::new_v4()),
                    "name":name,
                    "input":parse_tool_input(arguments.as_ref())?,
                    "caller":{"type":"direct"}
                }));
            }
        }
        for orphan in thinking_by_call.into_values() {
            content.extend(orphan);
        }
    }

    let stop_reason = if is_refusal {
        "refusal"
    } else {
        match finish_reason {
            Some("stop") => "end_turn",
            Some("length") => "max_tokens",
            Some("tool_calls" | "function_call") => "tool_use",
            other => {
                return Err(protocol_error(format!(
                    "unsupported upstream finish_reason: {}",
                    serde_json::to_string(&other).unwrap_or_default()
                )));
            }
        }
    };
    Ok(json!({
        "id":payload.get("id").cloned().unwrap_or_else(|| Value::String(format!("msg_{}",Uuid::new_v4()))),
        "type":"message",
        "role":"assistant",
        "container":null,
        "model":payload.get("model").cloned().unwrap_or_else(|| Value::String("unknown".into())),
        "content":content,
        "stop_reason":stop_reason,
        "stop_sequence":null,
        "stop_details":if is_refusal { json!({"type":"refusal","category":null,"explanation":if refusal_text.is_empty() { Value::Null } else { Value::String(refusal_text.into()) }}) } else { Value::Null },
        "usage":convert_usage(payload.get("usage"), payload.get("service_tier"))
    }))
}

pub fn anthropic_json_to_sse(message: &Value) -> Result<String, ApiError> {
    let mut frames = String::new();
    let start = json!({
        "type":"message_start",
        "message":{
            "id":message.get("id").cloned().unwrap_or(Value::Null),
            "type":"message","role":"assistant",
            "content":[],
            "model":message.get("model").cloned().unwrap_or(Value::String("unknown".into())),
            "stop_reason":null,"stop_sequence":null,"stop_details":null,
            "container":null,
            "usage":message.get("usage").cloned().unwrap_or_else(empty_usage)
        }
    });
    frames.push_str(&format_sse_event("message_start", &start));
    for (index, block) in message
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .enumerate()
    {
        frames.push_str(&anthropic_content_block_to_sse(block, index));
    }
    frames.push_str(&anthropic_terminal_to_sse(message));
    Ok(frames)
}

pub fn anthropic_content_block_to_sse(block: &Value, index: usize) -> String {
    let mut frames = String::new();
    let kind = block.get("type").and_then(Value::as_str).unwrap_or("text");
    let initial = match kind {
        "text" => json!({"type":"text","text":"","citations":null}),
        "thinking" => json!({
            "type":"thinking","thinking":"",
            "signature":block.get("signature").cloned().unwrap_or(Value::String(String::new()))
        }),
        "tool_use" => json!({
            "type":"tool_use",
            "id":block.get("id").cloned().unwrap_or(Value::Null),
            "name":block.get("name").cloned().unwrap_or(Value::Null),
            "input":{},"caller":{"type":"direct"}
        }),
        _ => block.clone(),
    };
    frames.push_str(&format_sse_event(
        "content_block_start",
        &json!({
            "type":"content_block_start","index":index,"content_block":initial
        }),
    ));
    match kind {
        "text" => {
            let text = block
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if !text.is_empty() {
                frames.push_str(&format_sse_event("content_block_delta", &json!({
                    "type":"content_block_delta","index":index,"delta":{"type":"text_delta","text":text}
                })));
            }
        }
        "thinking" => {
            let text = block
                .get("thinking")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if !text.is_empty() {
                frames.push_str(&format_sse_event("content_block_delta", &json!({
                    "type":"content_block_delta","index":index,"delta":{"type":"thinking_delta","thinking":text}
                })));
            }
            if let Some(signature) = block.get("signature").and_then(Value::as_str) {
                frames.push_str(&format_sse_event("content_block_delta", &json!({
                    "type":"content_block_delta","index":index,"delta":{"type":"signature_delta","signature":signature}
                })));
            }
        }
        "tool_use" => {
            frames.push_str(&format_sse_event("content_block_delta", &json!({
                "type":"content_block_delta","index":index,"delta":{
                    "type":"input_json_delta",
                    "partial_json":serde_json::to_string(block.get("input").unwrap_or(&json!({}))).unwrap_or_else(|_| "{}".into())
                }
            })));
        }
        _ => {}
    }
    frames.push_str(&format_sse_event(
        "content_block_stop",
        &json!({
            "type":"content_block_stop","index":index
        }),
    ));
    frames
}

pub fn anthropic_terminal_to_sse(message: &Value) -> String {
    let mut frames = String::new();
    frames.push_str(&format_sse_event(
        "message_delta",
        &json!({
            "type":"message_delta",
            "delta":{
                "stop_reason":message.get("stop_reason").cloned().unwrap_or(Value::Null),
                "stop_sequence":message.get("stop_sequence").cloned().unwrap_or(Value::Null),
                "stop_details":message.get("stop_details").cloned().unwrap_or(Value::Null),
                "container":null
            },
            "usage":delta_usage(message.get("usage"))
        }),
    ));
    frames.push_str(&format_sse_event(
        "message_stop",
        &json!({"type":"message_stop"}),
    ));
    frames
}

fn parse_tool_input(raw: Option<&Value>) -> Result<Value, ApiError> {
    let parsed = match raw {
        Some(Value::String(text)) => serde_json::from_str(text)
            .map_err(|_| protocol_error("upstream tool arguments must be a valid JSON object"))?,
        Some(value) => value.clone(),
        None => json!({}),
    };
    if !parsed.is_object() {
        return Err(protocol_error(
            "upstream tool arguments must decode to a JSON object",
        ));
    }
    Ok(parsed)
}

fn encode_chat_signature(content: &str) -> String {
    let envelope = json!({"reasoning_content":content});
    format!(
        "{CHAT_SIGNATURE_PREFIX}{}",
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(&envelope).unwrap())
    )
}

fn is_router_signature(signature: &str) -> bool {
    signature.starts_with(CHAT_SIGNATURE_PREFIX)
        || signature.starts_with("ocr-responses-reasoning-v1:")
}

fn convert_usage(usage: Option<&Value>, service_tier: Option<&Value>) -> Value {
    let usage = usage.unwrap_or(&Value::Null);
    let cached = usage
        .pointer("/prompt_tokens_details/cached_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let written = usage
        .pointer("/prompt_tokens_details/cache_write_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let prompt = usage
        .get("prompt_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let reasoning = usage
        .pointer("/completion_tokens_details/reasoning_tokens")
        .and_then(Value::as_u64);
    json!({
        "cache_creation":null,
        "cache_creation_input_tokens":written,
        "cache_read_input_tokens":cached,
        "inference_geo":null,
        "input_tokens":prompt.saturating_sub(cached + written),
        "output_tokens":usage.get("completion_tokens").and_then(Value::as_u64).unwrap_or(0),
        "output_tokens_details":reasoning.map(|tokens| json!({"thinking_tokens":tokens})),
        "server_tool_use":null,
        "service_tier":match service_tier.and_then(Value::as_str) {
            Some("default" | "standard") => Some("standard"),
            Some("priority" | "fast") => Some("priority"),
            _ => None,
        }
    })
}

fn delta_usage(usage: Option<&Value>) -> Value {
    let usage = usage.cloned().unwrap_or_else(empty_usage);
    json!({
        "cache_creation_input_tokens":usage.get("cache_creation_input_tokens").and_then(Value::as_u64).unwrap_or(0),
        "cache_read_input_tokens":usage.get("cache_read_input_tokens").and_then(Value::as_u64).unwrap_or(0),
        "input_tokens":usage.get("input_tokens").and_then(Value::as_u64).unwrap_or(0),
        "output_tokens":usage.get("output_tokens").and_then(Value::as_u64).unwrap_or(0),
        "output_tokens_details":usage.get("output_tokens_details").cloned().unwrap_or(Value::Null),
        "server_tool_use":usage.get("server_tool_use").cloned().unwrap_or(Value::Null)
    })
}

fn empty_usage() -> Value {
    json!({
        "cache_creation":null,"cache_creation_input_tokens":0,
        "cache_read_input_tokens":0,"inference_geo":null,"input_tokens":0,
        "output_tokens":0,"output_tokens_details":null,"server_tool_use":null,
        "service_tier":null
    })
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;
    use serde_json::json;

    use super::*;

    #[test]
    fn converts_chat_json_with_usage_and_tool() {
        let result = transform_chat_json_response(
            &json!({
                "id":"c1","model":"m","choices":[{"message":{"role":"assistant","content":"ok","tool_calls":[{"id":"call_1","type":"function","function":{"name":"read","arguments":"{\"p\":1}"}}]},"finish_reason":"tool_calls"}],
                "usage":{"prompt_tokens":10,"completion_tokens":2,"prompt_tokens_details":{"cached_tokens":3}}
            }),
            false,
        )
        .unwrap();
        assert_eq!(result["stop_reason"], "tool_use");
        assert_eq!(
            result.pointer("/content/1/caller/type"),
            Some(&json!("direct"))
        );
        assert_eq!(result.pointer("/usage/input_tokens"), Some(&json!(7)));
    }

    #[test]
    fn synthesis_is_a_complete_anthropic_stream() {
        let text = anthropic_json_to_sse(&json!({
            "id":"m1","model":"m","content":[{"type":"text","text":"hi"}],
            "stop_reason":"end_turn","stop_sequence":null,"stop_details":null,"usage":empty_usage()
        }))
        .unwrap();
        assert!(text.contains("event: message_start"));
        assert!(text.contains("event: message_stop"));
    }
}
