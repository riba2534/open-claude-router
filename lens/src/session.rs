//! Session threading heuristic. A Claude Code task shows up at the router as
//! dozens of requests sharing one system prompt and one opening user message
//! while the message list grows each turn. Hashing (client_ip, system-prompt
//! head, first-user-message head) groups the whole task into one session
//! without any client-side cooperation. Distinct tasks differ in their opening
//! message, so collisions require identical prompts from the same IP — an
//! acceptable merge for a dashboard heuristic.

use serde_json::Value;
use sha2::{Digest, Sha256};

const SYSTEM_HEAD: usize = 2048;
const USER_HEAD: usize = 1024;
const HINT_CHARS: usize = 120;

pub struct SessionInfo {
    pub key: String,
    pub hint: Option<String>,
}

pub fn derive(format: &str, client_ip: Option<&str>, payload: &Value) -> SessionInfo {
    let (system, first_user) = match format {
        "responses" => responses_parts(payload),
        _ => chat_parts(payload),
    };
    let mut hasher = Sha256::new();
    hasher.update(client_ip.unwrap_or_default().as_bytes());
    hasher.update([0x1f]);
    hasher.update(head(&system, SYSTEM_HEAD).as_bytes());
    hasher.update([0x1f]);
    hasher.update(head(&first_user, USER_HEAD).as_bytes());
    let digest = hasher.finalize();
    let key = digest[..8]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let hint = {
        // Claude Code 会把注入的 <system-reminder> 块放在首条用户消息前面，
        // 作为展示提示时跳过它们，取真正的用户内容。
        let trimmed = first_user.trim();
        let trimmed = match trimmed.rfind("</system-reminder>") {
            Some(pos) => {
                let after = trimmed[pos + "</system-reminder>".len()..].trim();
                if after.is_empty() { trimmed } else { after }
            }
            None => trimmed,
        };
        if trimmed.is_empty() {
            None
        } else {
            let mut chars = trimmed.chars();
            let mut hint = chars.by_ref().take(HINT_CHARS).collect::<String>();
            if chars.next().is_some() {
                hint.push('…');
            }
            Some(hint)
        }
    };
    SessionInfo { key, hint }
}

fn chat_parts(payload: &Value) -> (String, String) {
    let mut system = String::new();
    let mut first_user = String::new();
    if let Some(messages) = payload.get("messages").and_then(Value::as_array) {
        for message in messages {
            match message.get("role").and_then(Value::as_str) {
                Some("system") | Some("developer") if system.is_empty() => {
                    system = content_text(message.get("content"));
                }
                Some("user") if first_user.is_empty() => {
                    first_user = content_text(message.get("content"));
                }
                _ => {}
            }
            if !system.is_empty() && !first_user.is_empty() {
                break;
            }
        }
    }
    (system, first_user)
}

fn responses_parts(payload: &Value) -> (String, String) {
    let system = payload
        .get("instructions")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let mut first_user = String::new();
    match payload.get("input") {
        Some(Value::String(text)) => first_user = text.clone(),
        Some(Value::Array(items)) => {
            for item in items {
                let is_message = item.get("type").and_then(Value::as_str) == Some("message")
                    || (item.get("type").is_none() && item.get("role").is_some());
                if is_message && item.get("role").and_then(Value::as_str) == Some("user") {
                    first_user = content_text(item.get("content"));
                    break;
                }
            }
        }
        _ => {}
    }
    (system, first_user)
}

/// Flattens string-or-parts content into text; image parts become a marker so
/// two sessions differing only by attached image still hash apart.
fn content_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => {
            let mut text = String::new();
            for part in parts {
                match part.get("type").and_then(Value::as_str) {
                    Some("text") | Some("input_text") | Some("output_text") => {
                        if let Some(chunk) = part.get("text").and_then(Value::as_str) {
                            text.push_str(chunk);
                        }
                    }
                    Some("image_url") | Some("input_image") => text.push_str("[image]"),
                    _ => {}
                }
            }
            text
        }
        _ => String::new(),
    }
}

fn head(text: &str, limit: usize) -> String {
    text.chars().take(limit).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn growing_conversation_keeps_one_session() {
        let turn1 = json!({"messages":[
            {"role":"system","content":"你是运维助手"},
            {"role":"user","content":"排查一下路由器"}
        ]});
        let turn2 = json!({"messages":[
            {"role":"system","content":"你是运维助手"},
            {"role":"user","content":"排查一下路由器"},
            {"role":"assistant","content":"先看日志"},
            {"role":"user","content":"日志在哪"}
        ]});
        let a = derive("chat-completions", Some("10.0.0.1"), &turn1);
        let b = derive("chat-completions", Some("10.0.0.1"), &turn2);
        assert_eq!(a.key, b.key);
        assert_eq!(a.hint.as_deref(), Some("排查一下路由器"));
    }

    #[test]
    fn different_opening_message_forks_the_session() {
        let base =
            json!({"messages":[{"role":"system","content":"s"},{"role":"user","content":"任务A"}]});
        let other =
            json!({"messages":[{"role":"system","content":"s"},{"role":"user","content":"任务B"}]});
        assert_ne!(
            derive("chat-completions", Some("10.0.0.1"), &base).key,
            derive("chat-completions", Some("10.0.0.1"), &other).key,
        );
        assert_ne!(
            derive("chat-completions", Some("10.0.0.1"), &base).key,
            derive("chat-completions", Some("10.0.0.2"), &base).key,
        );
    }

    #[test]
    fn responses_format_uses_instructions_and_first_user_item() {
        let payload = json!({
            "instructions": "你是 KB 助手",
            "input": [
                {"type":"message","role":"user","content":[{"type":"input_text","text":"查一下规则"}]}
            ]
        });
        let info = derive("responses", Some("10.0.0.1"), &payload);
        assert_eq!(info.hint.as_deref(), Some("查一下规则"));
        assert_eq!(info.key.len(), 16);
    }
}
