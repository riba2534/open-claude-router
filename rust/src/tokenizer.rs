use std::sync::OnceLock;

use serde_json::Value;
use tiktoken_rs::{CoreBPE, o200k_base};

const MESSAGE_OVERHEAD: usize = 4;
const IMAGE_TOKENS: usize = 256;

static O200K_ENCODER: OnceLock<Result<CoreBPE, ()>> = OnceLock::new();

fn encoder() -> Option<&'static CoreBPE> {
    O200K_ENCODER
        .get_or_init(|| o200k_base().map_err(|_| ()))
        .as_ref()
        .ok()
}

fn count_text(text: &str) -> usize {
    if text.is_empty() {
        return 0;
    }
    encoder()
        .map(|encoder| encoder.encode_ordinary(text).len())
        .unwrap_or_else(|| text.chars().count().div_ceil(4))
}

fn count_json(value: &Value) -> usize {
    count_text(&serde_json::to_string(value).unwrap_or_default())
}

/// Matches the original TypeScript estimator. This endpoint is deliberately a
/// small local approximation, not a second protocol validator or tokenizer.
pub fn count_anthropic_tokens(request: &Value) -> usize {
    let Some(request) = request.as_object() else {
        return 0;
    };
    let mut total = 0usize;

    match request.get("system") {
        Some(Value::String(text)) => total += count_text(text),
        Some(Value::Array(parts)) => {
            for part in parts {
                if part.get("type").and_then(Value::as_str) == Some("text")
                    && let Some(text) = part.get("text").and_then(Value::as_str)
                    && !text.is_empty()
                {
                    total += count_text(text);
                }
            }
        }
        _ => {}
    }

    if let Some(messages) = request.get("messages").and_then(Value::as_array) {
        for message in messages {
            match message.get("content") {
                Some(Value::String(text)) => total += count_text(text),
                Some(Value::Array(parts)) => {
                    for part in parts {
                        match part.get("type").and_then(Value::as_str) {
                            Some("text") => {
                                if let Some(text) = part.get("text").and_then(Value::as_str)
                                    && !text.is_empty()
                                {
                                    total += count_text(text);
                                }
                            }
                            Some("tool_use") => {
                                if let Some(input) = part.get("input") {
                                    total += count_json(input);
                                }
                            }
                            Some("tool_result") => {
                                if let Some(content) = part.get("content") {
                                    total += match content {
                                        Value::String(text) => count_text(text),
                                        other => count_json(other),
                                    };
                                }
                            }
                            Some("image") => total += IMAGE_TOKENS,
                            _ => {}
                        }
                    }
                }
                _ => {}
            }
            total += MESSAGE_OVERHEAD;
        }
    }

    if let Some(tools) = request.get("tools").and_then(Value::as_array) {
        for tool in tools {
            if let Some(name) = tool.get("name").and_then(Value::as_str) {
                total += count_text(name);
            }
            if let Some(description) = tool.get("description").and_then(Value::as_str)
                && !description.is_empty()
            {
                total += count_text(description);
            }
            if let Some(schema) = tool.get("input_schema") {
                total += count_json(schema);
            }
        }
    }

    total
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::count_anthropic_tokens;

    #[test]
    fn matches_typescript_estimator_fixtures() {
        assert_eq!(
            count_anthropic_tokens(&json!({
                "model":"m","messages":[{"role":"user","content":"hello"}]
            })),
            5
        );
        assert_eq!(
            count_anthropic_tokens(&json!({
                "system":"你是一个严谨的助手",
                "messages":[
                    {"role":"user","content":"Hello, 世界 👋"},
                    {"role":"assistant","content":[{"type":"text","text":"当然可以。"}]}
                ]
            })),
            23
        );
        assert_eq!(
            count_anthropic_tokens(&json!({
                "messages":[{"role":"user","content":[
                    {"type":"image","source":{"type":"url","url":"https://example.com/a.png"}},
                    {"type":"tool_result","tool_use_id":"call_1","content":[{"type":"text","text":"result"}]}
                ]}],
                "tools":[{"name":"lookup","description":"look up a value","input_schema":{"type":"object","properties":{"id":{"type":"string"}}}}]
            })),
            290
        );
        assert_eq!(
            count_anthropic_tokens(&json!({
                "messages":[{"role":"assistant","content":[
                    {"type":"tool_use","id":"call_1","name":"write","input":{"path":"a.txt","content":"line\nline"}}
                ]}]
            })),
            16
        );
    }

    #[test]
    fn ignores_document_bytes_like_typescript() {
        assert_eq!(
            count_anthropic_tokens(&json!({
                "messages":[{"role":"user","content":[
                    {"type":"document","source":{"type":"base64","media_type":"application/pdf","data":"A".repeat(8192)}}
                ]}]
            })),
            4
        );
    }
}
