use std::sync::OnceLock;

use axum::http::StatusCode;
use serde_json::Value;
use tiktoken_rs::{CoreBPE, o200k_base};

use crate::error::ApiError;

const MESSAGE_OVERHEAD: usize = 4;
const STRUCTURED_BLOCK_OVERHEAD: usize = 2;
const TOOL_OVERHEAD: usize = 4;
const IMAGE_TOKENS: usize = 256;
const BINARY_DOCUMENT_TOKENS: usize = 1024;
const DOCUMENT_REFERENCE_TOKENS: usize = 64;

static O200K_ENCODER: OnceLock<Result<CoreBPE, ()>> = OnceLock::new();

#[cfg(test)]
static O200K_INITIALIZATIONS: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(0);

fn cached_o200k_encoder() -> Option<&'static CoreBPE> {
    O200K_ENCODER
        .get_or_init(|| {
            #[cfg(test)]
            O200K_INITIALIZATIONS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            o200k_base().map_err(|_| ())
        })
        .as_ref()
        .ok()
}

fn count_text(encoder: Option<&CoreBPE>, text: &str) -> usize {
    if text.is_empty() {
        0
    } else {
        encoder
            .map(|encoder| encoder.encode_ordinary(text).len())
            .unwrap_or_else(|| text.chars().count().div_ceil(4))
    }
}

fn count_json(encoder: Option<&CoreBPE>, value: &Value) -> usize {
    count_text(encoder, &serde_json::to_string(value).unwrap_or_default())
}

fn count_optional_json(encoder: Option<&CoreBPE>, value: Option<&Value>) -> usize {
    value.map(|value| count_json(encoder, value)).unwrap_or(0)
}

fn count_optional_text(encoder: Option<&CoreBPE>, value: Option<&Value>) -> usize {
    value
        .and_then(Value::as_str)
        .map(|value| count_text(encoder, value))
        .unwrap_or(0)
}

/// Token estimation contract:
/// o200k text/JSON tokens plus the constants above; recursive structured
/// blocks count their typed fields, while image and binary-document payloads
/// use fixed costs so base64 bytes are never tokenized.
fn count_content(encoder: Option<&CoreBPE>, content: &Value) -> usize {
    match content {
        Value::String(text) => count_text(encoder, text),
        Value::Array(parts) => parts.iter().map(|part| count_content(encoder, part)).sum(),
        Value::Object(_) => count_content_block(encoder, content),
        Value::Null => 0,
        other => count_json(encoder, other),
    }
}

fn count_content_block(encoder: Option<&CoreBPE>, block: &Value) -> usize {
    let cache = count_optional_json(encoder, block.get("cache_control"));
    match block.get("type").and_then(Value::as_str) {
        Some("text") => {
            count_optional_text(encoder, block.get("text")) + cache + STRUCTURED_BLOCK_OVERHEAD
        }
        Some("thinking") => {
            count_optional_text(encoder, block.get("thinking"))
                + count_optional_text(encoder, block.get("signature"))
                + cache
                + STRUCTURED_BLOCK_OVERHEAD
        }
        Some("redacted_thinking") => {
            count_optional_text(encoder, block.get("data")) + cache + STRUCTURED_BLOCK_OVERHEAD
        }
        Some("image") => {
            let source = block.get("source").unwrap_or(&Value::Null);
            let mut metadata = serde_json::Map::new();
            for field in ["type", "media_type", "url", "file_id"] {
                if let Some(value) = source.get(field) {
                    metadata.insert(field.into(), value.clone());
                }
            }
            IMAGE_TOKENS + count_json(encoder, &Value::Object(metadata)) + cache
        }
        Some("document") => {
            let source = block.get("source").unwrap_or(&Value::Null);
            let source_tokens = match source.get("type").and_then(Value::as_str) {
                Some("text") => count_optional_text(encoder, source.get("data")),
                Some("content") => source
                    .get("content")
                    .map(|content| count_content(encoder, content))
                    .unwrap_or(0),
                Some("base64") => {
                    BINARY_DOCUMENT_TOKENS + count_optional_text(encoder, source.get("media_type"))
                }
                Some("url") => {
                    DOCUMENT_REFERENCE_TOKENS + count_optional_text(encoder, source.get("url"))
                }
                Some("file") => {
                    DOCUMENT_REFERENCE_TOKENS + count_optional_text(encoder, source.get("file_id"))
                }
                _ => count_json(encoder, source),
            };
            source_tokens
                + count_optional_text(encoder, block.get("title"))
                + count_optional_text(encoder, block.get("context"))
                + count_optional_json(encoder, block.get("citations"))
                + cache
                + STRUCTURED_BLOCK_OVERHEAD
        }
        Some("search_result") => {
            count_optional_text(encoder, block.get("title"))
                + count_optional_text(encoder, block.get("source"))
                + block
                    .get("content")
                    .map(|content| count_content(encoder, content))
                    .unwrap_or(0)
                + count_optional_json(encoder, block.get("citations"))
                + cache
                + STRUCTURED_BLOCK_OVERHEAD
        }
        Some("tool_use") => {
            count_optional_text(encoder, block.get("id"))
                + count_optional_text(encoder, block.get("name"))
                + count_optional_json(encoder, block.get("input"))
                + count_optional_json(encoder, block.get("caller"))
                + cache
                + TOOL_OVERHEAD
        }
        Some("tool_result") => {
            count_optional_text(encoder, block.get("tool_use_id"))
                + block
                    .get("content")
                    .map(|content| count_content(encoder, content))
                    .unwrap_or(0)
                + usize::from(block.get("is_error").and_then(Value::as_bool) == Some(true))
                + cache
                + TOOL_OVERHEAD
        }
        Some("mid_conv_system") => {
            block
                .get("content")
                .map(|content| count_content(encoder, content))
                .unwrap_or(0)
                + cache
                + STRUCTURED_BLOCK_OVERHEAD
        }
        _ => count_json(encoder, block) + STRUCTURED_BLOCK_OVERHEAD,
    }
}

pub fn validate_count_tokens_request(request: &Value) -> Result<(), ApiError> {
    if !request.is_object() {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_request_error",
            "invalid_body",
            "request body must be a JSON object",
        ));
    }
    if !request
        .get("model")
        .and_then(Value::as_str)
        .is_some_and(|model| !model.trim().is_empty())
    {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_request_error",
            "invalid_body",
            "model must be a non-empty string",
        ));
    }
    if !request.get("messages").is_some_and(Value::is_array) {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_request_error",
            "invalid_body",
            "messages must be an array",
        ));
    }
    Ok(())
}

pub fn count_anthropic_tokens(request: &Value) -> usize {
    let encoder = cached_o200k_encoder();
    let mut total = 0usize;
    if let Some(system) = request.get("system") {
        total = total.saturating_add(count_content(encoder, system));
    }
    if let Some(messages) = request.get("messages").and_then(Value::as_array) {
        for message in messages {
            if !message.is_object() {
                total = total
                    .saturating_add(count_json(encoder, message))
                    .saturating_add(MESSAGE_OVERHEAD);
                continue;
            }
            total = total
                .saturating_add(count_optional_text(encoder, message.get("role")))
                .saturating_add(
                    message
                        .get("content")
                        .map(|content| count_content(encoder, content))
                        .unwrap_or(0),
                )
                .saturating_add(MESSAGE_OVERHEAD);
        }
    }
    if let Some(tools) = request.get("tools").and_then(Value::as_array) {
        for tool in tools {
            if !tool.is_object() {
                total = total
                    .saturating_add(count_json(encoder, tool))
                    .saturating_add(TOOL_OVERHEAD);
                continue;
            }
            total = total
                .saturating_add(count_optional_text(encoder, tool.get("name")))
                .saturating_add(count_optional_text(encoder, tool.get("description")))
                .saturating_add(count_optional_json(encoder, tool.get("input_schema")))
                .saturating_add(count_optional_json(encoder, tool.get("type")))
                .saturating_add(count_optional_json(encoder, tool.get("strict")))
                .saturating_add(count_optional_json(encoder, tool.get("defer_loading")))
                .saturating_add(count_optional_json(encoder, tool.get("allowed_callers")))
                .saturating_add(count_optional_json(encoder, tool.get("cache_control")))
                .saturating_add(TOOL_OVERHEAD);
        }
    }
    for field in ["tool_choice", "thinking", "output_config", "cache_control"] {
        total = total.saturating_add(count_optional_json(encoder, request.get(field)));
    }
    total
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn counts_images_and_turn_overhead() {
        let request = json!({
            "model":"m",
            "messages": [{"role":"user","content":[{
                "type":"image","source":{"type":"base64","media_type":"image/png","data":"AA=="}
            }]}]
        });
        let count = count_anthropic_tokens(&request);
        assert!(count >= IMAGE_TOKENS + MESSAGE_OVERHEAD);
    }

    #[test]
    fn binary_document_cost_does_not_depend_on_base64_length() {
        let request = |data: String| {
            json!({
                "model":"m","messages":[{"role":"user","content":[{
                    "type":"document","source":{"type":"base64","media_type":"application/pdf","data":data}
                }]}]
            })
        };
        assert_eq!(
            count_anthropic_tokens(&request("AA==".into())),
            count_anthropic_tokens(&request("A".repeat(1_000_000)))
        );
    }

    #[test]
    fn typed_metadata_and_recursive_content_are_counted() {
        let base = json!({
            "model":"m","messages":[{"role":"assistant","content":[{
                "type":"tool_use","id":"call","name":"lookup","input":{"q":"x"}
            }]}]
        });
        let mut enriched = base.clone();
        enriched["messages"][0]["content"][0]["caller"] = json!({"type":"direct"});
        enriched["messages"][0]["content"][0]["cache_control"] = json!({"type":"ephemeral"});
        assert!(count_anthropic_tokens(&enriched) > count_anthropic_tokens(&base));
    }

    #[test]
    fn count_tokens_validation_uses_shared_required_messages() {
        for request in [Value::Null, json!([])] {
            let error = validate_count_tokens_request(&request).unwrap_err();
            assert_eq!(error.message, "request body must be a JSON object");
        }
        let error = validate_count_tokens_request(&json!({"messages":[]})).unwrap_err();
        assert_eq!(error.message, "model must be a non-empty string");
        let error = validate_count_tokens_request(&json!({"model":"m","messages":{}})).unwrap_err();
        assert_eq!(error.message, "messages must be an array");
    }

    #[test]
    fn tokenizer_is_initialized_only_once_across_repeated_counts() {
        let request = json!({
            "model":"m",
            "messages":[{"role":"user","content":"repeatable"}]
        });
        let expected = count_anthropic_tokens(&request);
        for _ in 0..32 {
            assert_eq!(count_anthropic_tokens(&request), expected);
        }
        assert!(O200K_ENCODER.get().is_some());
        assert_eq!(
            O200K_INITIALIZATIONS.load(std::sync::atomic::Ordering::Relaxed),
            1
        );
    }
}
