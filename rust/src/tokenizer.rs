use serde_json::Value;
use tiktoken_rs::{CoreBPE, o200k_base};

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

pub fn count_anthropic_tokens(request: &Value) -> usize {
    let encoder = o200k_base().ok();
    let encoder = encoder.as_ref();
    let mut total = 0;
    match request.get("system") {
        Some(Value::String(text)) => total += count_text(encoder, text),
        Some(Value::Array(parts)) => {
            for part in parts {
                if part.get("type").and_then(Value::as_str) == Some("text")
                    && let Some(text) = part.get("text").and_then(Value::as_str)
                {
                    total += count_text(encoder, text);
                }
            }
        }
        _ => {}
    }
    if let Some(messages) = request.get("messages").and_then(Value::as_array) {
        for message in messages {
            match message.get("content") {
                Some(Value::String(text)) => total += count_text(encoder, text),
                Some(Value::Array(parts)) => {
                    for part in parts {
                        match part.get("type").and_then(Value::as_str) {
                            Some("text") => {
                                if let Some(text) = part.get("text").and_then(Value::as_str) {
                                    total += count_text(encoder, text);
                                }
                            }
                            Some("tool_use") => {
                                if let Some(input) = part.get("input") {
                                    total += count_json(encoder, input);
                                }
                            }
                            Some("tool_result") => match part.get("content") {
                                Some(Value::String(text)) => total += count_text(encoder, text),
                                Some(content) => total += count_json(encoder, content),
                                None => {}
                            },
                            Some("image") => total += 256,
                            _ => {}
                        }
                    }
                }
                _ => {}
            }
            total += 4;
        }
    }
    if let Some(tools) = request.get("tools").and_then(Value::as_array) {
        for tool in tools {
            if let Some(name) = tool.get("name").and_then(Value::as_str) {
                total += count_text(encoder, name);
            }
            if let Some(description) = tool.get("description").and_then(Value::as_str) {
                total += count_text(encoder, description);
            }
            if let Some(schema) = tool.get("input_schema") {
                total += count_json(encoder, schema);
            }
        }
    }
    total
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn counts_images_and_turn_overhead() {
        let count = count_anthropic_tokens(&json!({
            "messages": [{"role":"user","content":[{"type":"image"}]}]
        }));
        assert_eq!(count, 260);
    }
}
