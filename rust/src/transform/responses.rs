use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::{Map, Value, json};

use super::{identity::ResponsesCallIdMap, protocol_error};
use crate::{
    error::{ApiError, error_type_for_status, status_from_openai_error},
    transform::request::scrub_cache_control,
};

const SIGNATURE_PREFIX: &str = "ocr-responses-reasoning-v1:";

#[allow(clippy::collapsible_if)]
pub fn transform_responses_request(body: &mut Value) -> Result<(), ApiError> {
    scrub_cache_control(body);
    let object = body.as_object_mut().expect("unified request is object");
    let call_ids =
        ResponsesCallIdMap::new(collect_responses_history_call_ids(object.get("messages")));
    if let Some(max_tokens) = object.remove("max_tokens") {
        object.insert("max_output_tokens".into(), max_tokens);
    }
    object.remove("stop");
    let explicit_effort = object
        .get("reasoning_effort")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    let reasoning = object.get("reasoning").cloned();
    let reasoning_enabled = reasoning
        .as_ref()
        .and_then(|reasoning| reasoning.get("enabled"))
        .and_then(Value::as_bool)
        == Some(true);
    let display_omitted = reasoning
        .as_ref()
        .and_then(|reasoning| reasoning.get("display"))
        .and_then(Value::as_str)
        == Some("omitted");
    let effort = explicit_effort.or_else(|| {
        reasoning
            .as_ref()
            .and_then(|reasoning| reasoning.get("effort"))
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
    });
    if effort.is_some() || (reasoning_enabled && !display_omitted) {
        let mut output = Map::new();
        if let Some(effort) = effort {
            output.insert("effort".into(), Value::String(effort));
        }
        if reasoning_enabled && !display_omitted {
            output.insert("summary".into(), Value::String("detailed".into()));
        }
        object.insert("reasoning".into(), Value::Object(output));
    } else {
        object.remove("reasoning");
    }
    if reasoning_enabled {
        object.insert("include".into(), json!(["reasoning.encrypted_content"]));
    }
    object.remove("reasoning_effort");

    let messages = object
        .remove("messages")
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default();
    let mut input = Vec::new();
    for message in messages {
        let role = message
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if role == "assistant" {
            if let Some(blocks) = message.get("output_blocks").and_then(Value::as_array) {
                let before = input.len();
                for block in blocks {
                    match block.get("type").and_then(Value::as_str) {
                        Some("thinking") => {
                            if let Some(replay) = block
                                .get("signature")
                                .and_then(Value::as_str)
                                .and_then(decode_reasoning_signature)
                            {
                                input.push(replayed_reasoning(replay));
                            }
                        }
                        Some("tool_use") => input.push(json!({
                            "type":"function_call",
                            "call_id":block.get("id").and_then(Value::as_str).map(|id| call_ids.wire_id(id)).unwrap_or_default(),
                            "name":block.get("name").cloned().unwrap_or(Value::Null),
                            "arguments":serde_json::to_string(block.get("input").unwrap_or(&json!({}))).unwrap_or_else(|_| "{}".into())
                        })),
                        Some("text") => input.push(json!({
                            "role":"assistant",
                            "content":block.get("text").and_then(Value::as_str).unwrap_or_default()
                        })),
                        _ => {}
                    }
                }
                if input.len() == before {
                    input.push(json!({"role":"assistant","content":""}));
                }
                continue;
            }
        }

        let normalized_content = match message.get("content") {
            Some(Value::Array(parts)) => Value::Array(
                parts
                    .iter()
                    .filter_map(normalize_content)
                    .collect::<Vec<_>>(),
            ),
            Some(content) => content.clone(),
            None => Value::String(String::new()),
        };
        if role == "tool" {
            let call_id = message
                .get("tool_call_id")
                .and_then(Value::as_str)
                .map(|id| call_ids.wire_id(id))
                .unwrap_or_default();
            input.push(json!({
                "type":"function_call_output",
                "call_id":call_id,
                "output":normalized_content
            }));
            continue;
        }

        let mut paired_reasoning: std::collections::HashMap<String, Vec<Value>> =
            std::collections::HashMap::new();
        if role == "assistant" {
            let blocks = message
                .get("thinking_blocks")
                .and_then(Value::as_array)
                .cloned()
                .or_else(|| message.get("thinking").cloned().map(|value| vec![value]))
                .unwrap_or_default();
            for block in blocks {
                let Some(replay) = block
                    .get("signature")
                    .and_then(Value::as_str)
                    .and_then(decode_reasoning_signature)
                else {
                    continue;
                };
                let item = replayed_reasoning(replay);
                if let Some(call_id) = block.get("tool_call_id").and_then(Value::as_str) {
                    paired_reasoning
                        .entry(call_id.to_owned())
                        .or_default()
                        .push(item);
                } else {
                    input.push(item);
                }
            }
        }

        let has_calls = message
            .get("tool_calls")
            .and_then(Value::as_array)
            .is_some_and(|calls| !calls.is_empty());
        let has_content = match &normalized_content {
            Value::String(text) => !text.is_empty(),
            Value::Array(parts) => !parts.is_empty(),
            _ => false,
        };
        if role != "assistant" || has_content || !has_calls {
            input.push(json!({"role":role,"content":normalized_content}));
        }
        if role == "assistant" {
            if let Some(calls) = message.get("tool_calls").and_then(Value::as_array) {
                for call in calls {
                    let id = call.get("id").and_then(Value::as_str).unwrap_or_default();
                    if let Some(reasoning) = paired_reasoning.remove(id) {
                        input.extend(reasoning);
                    }
                    input.push(json!({
                        "type":"function_call",
                        "arguments":call.pointer("/function/arguments").cloned().unwrap_or(Value::String("{}".into())),
                        "name":call.pointer("/function/name").cloned().unwrap_or(Value::String(String::new())),
                        "call_id":call_ids.wire_id(id)
                    }));
                }
            }
        }
    }
    object.insert("input".into(), Value::Array(input));

    if let Some(tools) = object.get_mut("tools").and_then(Value::as_array_mut) {
        for tool in tools {
            let function = tool.get("function").cloned().unwrap_or(Value::Null);
            *tool = json!({
                "type":tool.get("type").cloned().unwrap_or(Value::String("function".into())),
                "name":function.get("name").cloned().unwrap_or(Value::Null),
                "description":function.get("description").cloned().unwrap_or(Value::String(String::new())),
                "parameters":function.get("parameters").cloned().unwrap_or_else(|| json!({"type":"object","properties":{}})),
                "strict":function.get("strict").and_then(Value::as_bool).unwrap_or(false)
            });
        }
    }
    if let Some(response_format) = object.remove("response_format") {
        if response_format.get("type").and_then(Value::as_str) == Some("json_schema") {
            let schema = response_format
                .get("json_schema")
                .cloned()
                .unwrap_or(Value::Null);
            object.insert(
                "text".into(),
                json!({"format":{
                    "type":"json_schema",
                    "name":schema.get("name").cloned().unwrap_or(Value::Null),
                    "schema":schema.get("schema").cloned().unwrap_or(Value::Null),
                    "strict":schema.get("strict").cloned().unwrap_or(Value::Bool(true))
                }}),
            );
        }
    }
    if let Some(choice) = object.get_mut("tool_choice") {
        if choice.get("type").and_then(Value::as_str) == Some("function") {
            if let Some(name) = choice.pointer("/function/name").cloned() {
                *choice = json!({"type":"function","name":name});
            }
        }
    }
    for message in object
        .get_mut("input")
        .and_then(Value::as_array_mut)
        .into_iter()
        .flatten()
    {
        if let Some(object) = message.as_object_mut() {
            object.remove("reasoning_content");
        }
    }
    Ok(())
}

fn collect_responses_history_call_ids(messages: Option<&Value>) -> Vec<String> {
    let mut ids = Vec::new();
    for message in messages.and_then(Value::as_array).into_iter().flatten() {
        if let Some(blocks) = message.get("output_blocks").and_then(Value::as_array) {
            ids.extend(blocks.iter().filter_map(|block| {
                (block.get("type").and_then(Value::as_str) == Some("tool_use"))
                    .then(|| {
                        block
                            .get("id")
                            .and_then(Value::as_str)
                            .map(ToOwned::to_owned)
                    })
                    .flatten()
            }));
        }
        if let Some(calls) = message.get("tool_calls").and_then(Value::as_array) {
            ids.extend(calls.iter().filter_map(|call| {
                call.get("id")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned)
            }));
        }
        if message.get("role").and_then(Value::as_str) == Some("tool")
            && let Some(id) = message.get("tool_call_id").and_then(Value::as_str)
        {
            ids.push(id.to_owned());
        }
    }
    ids
}

pub fn transform_responses_json(payload: &Value, omit_reasoning: bool) -> Result<Value, ApiError> {
    if let Some(error) = payload.get("error").filter(|error| !error.is_null()) {
        let status = status_from_openai_error(error, axum::http::StatusCode::OK);
        return Err(ApiError::new(
            status,
            error_type_for_status(status),
            "upstream_logical_error",
            error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("Responses request failed"),
        )
        .retryable());
    }
    validate_responses_status(payload)?;
    let output = payload
        .get("output")
        .and_then(Value::as_array)
        .ok_or_else(|| protocol_error("upstream Responses payload is missing output"))?;
    let mut content = Vec::new();
    let mut pending_reasoning = Vec::new();
    let mut has_tool = false;
    let mut incomplete_call = false;
    let mut refusal = String::new();
    let mut emitted_audio_omission = false;
    for item in output {
        let kind = item.get("type").and_then(Value::as_str).unwrap_or_default();
        if let Some(reason) = unsupported_responses_item_reason(item) {
            return Err(protocol_error(format!(
                "upstream Responses {reason} has no replay-safe Anthropic Messages equivalent"
            )));
        }
        match kind {
            "reasoning" => {
                let id = item
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|id| !id.is_empty())
                    .ok_or_else(|| {
                        protocol_error("upstream Responses reasoning item is missing id")
                    })?;
                let text = reasoning_text(item);
                let encrypted = item
                    .get("encrypted_content")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty());
                if omit_reasoning && !text.is_empty() && encrypted.is_none() {
                    return Err(protocol_error("upstream omitted encrypted reasoning state"));
                }
                if omit_reasoning && encrypted.is_none() {
                    continue;
                }
                let signature =
                    encode_reasoning_signature(item, !omit_reasoning).ok_or_else(|| {
                        protocol_error(format!(
                            "upstream Responses reasoning item {id} cannot be replayed"
                        ))
                    })?;
                pending_reasoning.push(json!({
                    "type":"thinking",
                    "thinking":if omit_reasoning { "" } else { text.as_str() },
                    "signature":signature
                }));
            }
            "function_call" => {
                let call_id = item
                    .get("call_id")
                    .or_else(|| item.get("id"))
                    .and_then(Value::as_str)
                    .filter(|id| !id.is_empty())
                    .ok_or_else(|| {
                        protocol_error(
                            "upstream Responses function_call is missing call_id or name",
                        )
                    })?;
                let name = item
                    .get("name")
                    .and_then(Value::as_str)
                    .filter(|name| !name.is_empty())
                    .ok_or_else(|| {
                        protocol_error(
                            "upstream Responses function_call is missing call_id or name",
                        )
                    })?;
                let is_incomplete = payload.get("status").and_then(Value::as_str)
                    == Some("incomplete")
                    || item.get("status").and_then(Value::as_str) == Some("incomplete");
                content.append(&mut pending_reasoning);
                let arguments = item
                    .get("arguments")
                    .cloned()
                    .unwrap_or_else(|| Value::String("{}".into()));
                if is_incomplete {
                    incomplete_call = true;
                    content.push(incomplete_tool_diagnostic(name, &arguments));
                } else {
                    let input = parse_tool_arguments(&arguments)?;
                    content.push(json!({
                        "type":"tool_use",
                        "id":call_id,
                        "name":name,
                        "input":input,
                        "caller":{"type":"direct"}
                    }));
                    has_tool = true;
                }
            }
            "message" => {
                content.append(&mut pending_reasoning);
                for part in item
                    .get("content")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    match part.get("type").and_then(Value::as_str) {
                        Some("output_text") => content.push(json!({
                            "type":"text",
                            "text":part.get("text").and_then(Value::as_str).unwrap_or_default()
                        })),
                        Some("refusal") => {
                            let text = part.get("refusal").and_then(Value::as_str).unwrap_or_default();
                            refusal.push_str(text);
                            content.push(json!({"type":"text","text":text}));
                        }
                        Some("output_image" | "output_image_base64") => {
                            content.push(json!({"type":"text","text":"[generated image omitted]"}));
                        }
                        Some("output_audio") => {
                            if !emitted_audio_omission {
                                emitted_audio_omission = true;
                                content.push(json!({"type":"text","text":"[generated audio omitted]"}));
                            }
                            if let Some(transcript) = part
                                .get("transcript")
                                .and_then(Value::as_str)
                                .filter(|transcript| !transcript.is_empty())
                            {
                                content.push(json!({"type":"text","text":transcript}));
                            }
                        }
                        _ => content.push(json!({"type":"text","text":bounded_responses("message content", part)})),
                    }
                    for annotation in part
                        .get("annotations")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                    {
                        content.push(json!({"type":"text","text":bounded_responses("citation annotation", annotation)}));
                    }
                }
            }
            "image_generation_call" => {
                content.append(&mut pending_reasoning);
                content.push(json!({"type":"text","text":"[generated image omitted]"}));
            }
            _ => {
                content.append(&mut pending_reasoning);
                content.push(json!({"type":"text","text":bounded_responses(&format!("output item {kind}"), item)}));
            }
        }
    }
    content.append(&mut pending_reasoning);
    if incomplete_call {
        for block in &mut content {
            if block.get("type").and_then(Value::as_str) != Some("tool_use") {
                continue;
            }
            let name = block
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_owned();
            let raw = block.get("input").cloned().unwrap_or_else(|| json!({}));
            *block = incomplete_tool_diagnostic(&name, &raw);
        }
        has_tool = false;
    }
    if payload
        .get("__ocr_stream_aggregated")
        .and_then(Value::as_bool)
        == Some(true)
    {
        content = coalesce_adjacent_text_blocks(content);
    }
    let response_incomplete =
        payload.get("status").and_then(Value::as_str) == Some("incomplete") || incomplete_call;
    let content_filter = payload
        .pointer("/incomplete_details/reason")
        .and_then(Value::as_str)
        == Some("content_filter");
    let is_refusal = !refusal.is_empty() || (response_incomplete && content_filter);
    let stop_reason = if is_refusal {
        "refusal"
    } else if response_incomplete {
        "max_tokens"
    } else if has_tool {
        "tool_use"
    } else {
        "end_turn"
    };
    Ok(json!({
        "id":payload.get("id").cloned().unwrap_or_else(|| Value::String(format!("msg_{}", uuid::Uuid::new_v4()))),
        "type":"message",
        "role":"assistant",
        "container":null,
        "model":payload.get("model").cloned().unwrap_or(Value::String("unknown".into())),
        "content":content,
        "stop_reason":stop_reason,
        "stop_sequence":null,
        "stop_details":if is_refusal { json!({"type":"refusal","category":null,"explanation":if refusal.is_empty() { Value::Null } else { Value::String(refusal) }}) } else { Value::Null },
        "usage":convert_responses_usage(payload.get("usage"), payload.get("service_tier"))
    }))
}

fn coalesce_adjacent_text_blocks(blocks: Vec<Value>) -> Vec<Value> {
    let mut output: Vec<Value> = Vec::with_capacity(blocks.len());
    for block in blocks {
        if block.get("type").and_then(Value::as_str) == Some("text")
            && let Some(previous) = output.last_mut()
            && previous.get("type").and_then(Value::as_str) == Some("text")
        {
            let mut combined = previous
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            combined.push_str(
                block
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
            );
            previous["text"] = Value::String(combined);
            continue;
        }
        output.push(block);
    }
    output
}

fn unsupported_responses_item_reason(item: &Value) -> Option<String> {
    match item.get("type").and_then(Value::as_str) {
        Some("program" | "program_output") => Some("programmatic tool-calling state".into()),
        Some("compaction") => Some("compaction state".into()),
        Some("function_call_output") => Some("function-call output state".into()),
        Some("function_call") => item
            .get("caller")
            .filter(|caller| !caller.is_null())
            .filter(|caller| caller.get("type").and_then(Value::as_str) != Some("direct"))
            .map(|caller| {
                format!(
                    "function caller {}",
                    serde_json::to_string(caller.get("type").unwrap_or(&Value::Null))
                        .unwrap_or_else(|_| "null".into())
                )
            }),
        _ => None,
    }
}

fn normalize_content(content: &Value) -> Option<Value> {
    match content.get("type").and_then(Value::as_str) {
        Some("text") => Some(
            json!({"type":"input_text","text":content.get("text").and_then(Value::as_str).unwrap_or_default()}),
        ),
        Some("image_url") => Some(
            json!({"type":"input_image","image_url":content.pointer("/image_url/url").cloned().unwrap_or(Value::Null)}),
        ),
        Some("image_file") => Some(
            json!({"type":"input_image","file_id":content.pointer("/image_file/file_id").cloned().unwrap_or(Value::Null)}),
        ),
        Some("file") => {
            let mut result = Map::new();
            result.insert("type".into(), Value::String("input_file".into()));
            for key in ["file_data", "file_id", "file_url", "filename"] {
                if let Some(value) = content
                    .pointer(&format!("/file/{key}"))
                    .filter(|value| value.is_string())
                {
                    result.insert(key.into(), value.clone());
                }
            }
            Some(Value::Object(result))
        }
        _ => None,
    }
}

fn encode_reasoning_signature(item: &Value, include_visible: bool) -> Option<String> {
    let id = item.get("id").and_then(Value::as_str)?;
    let mut envelope = json!({"id":id});
    if let Some(encrypted) = item
        .get("encrypted_content")
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
    {
        envelope["encrypted_content"] = Value::String(encrypted.to_owned());
    } else if include_visible {
        if let Some(summary) = item.get("summary").and_then(Value::as_array) {
            let summary = summary
                .iter()
                .filter(|part| part.get("text").is_some_and(Value::is_string))
                .cloned()
                .collect::<Vec<_>>();
            if !summary.is_empty() {
                envelope["summary"] = Value::Array(summary);
            }
        }
        if let Some(content) = item.get("content").and_then(Value::as_array) {
            let content = content
                .iter()
                .filter(|part| {
                    part.get("type").and_then(Value::as_str) == Some("reasoning_text")
                        && part.get("text").is_some_and(Value::is_string)
                })
                .cloned()
                .collect::<Vec<_>>();
            if !content.is_empty() {
                envelope["content"] = Value::Array(content);
            }
        }
    }
    Some(format!(
        "{SIGNATURE_PREFIX}{}",
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(&envelope).ok()?)
    ))
}

fn decode_reasoning_signature(signature: &str) -> Option<Value> {
    let encoded = signature.strip_prefix(SIGNATURE_PREFIX)?;
    let decoded = URL_SAFE_NO_PAD.decode(encoded).ok()?;
    let value: Value = serde_json::from_slice(&decoded).ok()?;
    value
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())?;
    Some(value)
}

fn replayed_reasoning(value: Value) -> Value {
    json!({
        "type":"reasoning",
        "id":value.get("id").cloned().unwrap_or(Value::Null),
        "encrypted_content":value.get("encrypted_content").cloned(),
        "summary":value.get("summary").cloned().unwrap_or_else(|| json!([])),
        "content":value.get("content").cloned()
    })
    .pipe(strip_null_object)
}

fn strip_null_object(mut value: Value) -> Value {
    if let Some(object) = value.as_object_mut() {
        object.retain(|_, value| !value.is_null());
    }
    value
}

trait Pipe: Sized {
    fn pipe<T>(self, f: impl FnOnce(Self) -> T) -> T {
        f(self)
    }
}
impl<T> Pipe for T {}

fn parse_tool_arguments(raw: &Value) -> Result<Value, ApiError> {
    let parsed = if let Some(raw) = raw.as_str() {
        serde_json::from_str(raw).map_err(|_| {
            protocol_error("upstream Responses function_call arguments must be a valid JSON object")
        })?
    } else {
        raw.clone()
    };
    if !parsed.is_object() {
        return Err(protocol_error(
            "upstream Responses function_call arguments must be a valid JSON object",
        ));
    }
    Ok(parsed)
}

fn incomplete_tool_diagnostic(name: &str, raw: &Value) -> Value {
    let raw = raw
        .as_str()
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| serde_json::to_string(raw).unwrap_or_default());
    let length = raw.chars().count();
    let mut bounded = raw.chars().take(4096).collect::<String>();
    if length > 4096 {
        bounded.push('…');
    }
    json!({"type":"text","text":format!("[incomplete function_call {name}: {bounded}]")})
}

fn reasoning_text(item: &Value) -> String {
    let content = item
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|part| part.get("type").and_then(Value::as_str) == Some("reasoning_text"))
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .collect::<String>();
    if !content.is_empty() {
        return content;
    }
    item.get("summary")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .collect()
}

fn validate_responses_status(payload: &Value) -> Result<(), ApiError> {
    let status = payload
        .get("status")
        .and_then(Value::as_str)
        .ok_or_else(|| protocol_error("upstream Responses payload status must be a string"))?;
    if matches!(status, "completed" | "incomplete") {
        return Ok(());
    }
    if status == "failed" {
        let error = payload.get("error").cloned().unwrap_or(Value::Null);
        let http_status = status_from_openai_error(&error, axum::http::StatusCode::OK);
        return Err(ApiError::new(
            http_status,
            error_type_for_status(http_status),
            "upstream_responses_error",
            error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("Responses request failed"),
        )
        .retryable());
    }
    if status == "cancelled" {
        return Err(ApiError::new(
            axum::http::StatusCode::CONFLICT,
            "conflict_error",
            "response_cancelled",
            payload
                .pointer("/error/message")
                .and_then(Value::as_str)
                .unwrap_or("Responses request was cancelled"),
        )
        .retryable());
    }
    Err(protocol_error(format!(
        "upstream Responses returned non-terminal status {}",
        serde_json::to_string(status).unwrap()
    ))
    .retryable())
}

fn bounded_responses(kind: &str, value: &Value) -> String {
    let serialized = serde_json::to_string(value).unwrap_or_default();
    if serialized.chars().count() > 4096 {
        format!(
            "[unsupported Responses {kind} omitted: {} chars]",
            serialized.chars().count()
        )
    } else {
        format!("[unsupported Responses {kind}: {serialized}]")
    }
}

fn convert_responses_usage(usage: Option<&Value>, service_tier: Option<&Value>) -> Value {
    let usage = usage.unwrap_or(&Value::Null);
    let cached = usage
        .pointer("/input_tokens_details/cached_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let written = usage
        .pointer("/input_tokens_details/cache_write_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let input = usage
        .get("input_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0)
        .saturating_sub(cached + written);
    let reasoning = usage
        .pointer("/output_tokens_details/reasoning_tokens")
        .and_then(Value::as_u64);
    json!({
        "cache_creation":null,
        "cache_creation_input_tokens":written,
        "cache_read_input_tokens":cached,
        "inference_geo":null,
        "input_tokens":input,
        "output_tokens":usage.get("output_tokens").and_then(Value::as_u64).unwrap_or(0),
        "output_tokens_details":reasoning.map(|tokens| json!({"thinking_tokens":tokens})),
        "server_tool_use":null,
        "service_tier":match service_tier.and_then(Value::as_str) { Some("default"|"standard") => Some("standard"), Some("priority"|"fast") => Some("priority"), _ => None }
    })
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;
    use serde_json::json;

    use super::*;

    #[test]
    fn request_maps_max_tokens_and_typed_input() {
        let mut body = json!({
            "model":"m","max_tokens":12,
            "messages":[{"role":"user","content":[{"type":"text","text":"hi"}]}]
        });
        transform_responses_request(&mut body).unwrap();
        assert_eq!(body["max_output_tokens"], 12);
        assert_eq!(
            body.pointer("/input/0/content/0/type"),
            Some(&json!("input_text"))
        );
    }

    #[test]
    fn request_drops_stop_sequences_like_typescript() {
        let mut body = json!({"messages":[],"stop":["END"]});
        transform_responses_request(&mut body).unwrap();
        assert!(body.get("stop").is_none());

        let mut empty = json!({"messages":[],"stop":[]});
        transform_responses_request(&mut empty).unwrap();
        assert!(empty.get("stop").is_none());
    }

    #[test]
    fn request_pairs_long_history_call_ids_and_keeps_responses_tool_names() {
        let exact_64 = "c".repeat(64);
        let long_65 = "d".repeat(65);
        let tool_name_128 = "t".repeat(128);
        let mut body = crate::transform::transform_anthropic_request(&json!({
            "model":"m","max_tokens":32,
            "tools":[{"name":tool_name_128,"input_schema":{"type":"object"}}],
            "messages":[
                {"role":"user","content":"start"},
                {"role":"assistant","content":[
                    {"type":"tool_use","id":exact_64,"name":tool_name_128,"input":{"n":1}},
                    {"type":"tool_use","id":long_65,"name":tool_name_128,"input":{"n":2}}
                ]},
                {"role":"user","content":[
                    {"type":"tool_result","tool_use_id":exact_64,"content":"one"},
                    {"type":"tool_result","tool_use_id":long_65,"content":"two"}
                ]}
            ]
        }))
        .unwrap();

        transform_responses_request(&mut body).unwrap();
        assert_eq!(body.pointer("/tools/0/name"), Some(&json!(tool_name_128)));
        let input = body.get("input").and_then(Value::as_array).unwrap();
        let calls = input
            .iter()
            .filter(|item| item.get("type").and_then(Value::as_str) == Some("function_call"))
            .collect::<Vec<_>>();
        let outputs = input
            .iter()
            .filter(|item| item.get("type").and_then(Value::as_str) == Some("function_call_output"))
            .collect::<Vec<_>>();
        assert_eq!(calls.len(), 2);
        assert_eq!(outputs.len(), 2);
        assert_eq!(calls[0].get("call_id"), Some(&json!(exact_64)));
        assert_eq!(outputs[0].get("call_id"), Some(&json!(exact_64)));
        assert_eq!(calls[0].get("name"), Some(&json!(tool_name_128)));
        let long_wire = calls[1].get("call_id").and_then(Value::as_str).unwrap();
        assert_ne!(long_wire, long_65);
        assert_eq!(long_wire.chars().count(), 64);
        assert_eq!(outputs[1].get("call_id"), calls[1].get("call_id"));
    }

    #[test]
    fn json_response_rejects_null_or_non_string_status() {
        for status in [Value::Null, json!(7)] {
            let error =
                transform_responses_json(&json!({"status":status,"output":[]}), false).unwrap_err();
            assert_eq!(error.status, axum::http::StatusCode::BAD_GATEWAY);
            assert_eq!(
                error.message,
                "upstream Responses payload status must be a string"
            );
        }
    }

    #[test]
    fn json_response_maps_top_level_logical_error() {
        let error = transform_responses_json(
            &json!({"error":{"type":"invalid_request_error","message":"bad model"}}),
            false,
        )
        .unwrap_err();
        assert_eq!(error.status, axum::http::StatusCode::BAD_REQUEST);
        assert_eq!(error.message, "bad model");
        assert!(error.retryable);
    }

    #[test]
    fn malformed_completed_function_is_a_retryable_protocol_error() {
        let error = transform_responses_json(
            &json!({
                "id":"r","status":"completed","output":[{
                    "type":"function_call","call_id":"call_1","name":"lookup",
                    "arguments":"{broken","status":"completed"
                }]
            }),
            false,
        )
        .unwrap_err();
        assert_eq!(error.status, axum::http::StatusCode::BAD_GATEWAY);
        assert!(error.retryable);
    }

    #[test]
    fn one_malformed_parallel_function_fails_the_response() {
        let error = transform_responses_json(
            &json!({
                "status":"completed","output":[
                    {"type":"function_call","call_id":"good","name":"good","arguments":"{}"},
                    {"type":"function_call","call_id":"bad","name":"bad","arguments":"{"}
                ]
            }),
            false,
        )
        .unwrap_err();
        assert_eq!(error.status, axum::http::StatusCode::BAD_GATEWAY);
        assert!(error.retryable);
    }

    #[test]
    fn reasoning_signature_replays_required_id_and_hidden_state() {
        let response = transform_responses_json(
            &json!({
                "status":"completed","output":[{
                    "type":"reasoning","id":"reason_1","encrypted_content":"opaque",
                    "summary":[{"type":"summary_text","text":"summary"}]
                }]
            }),
            true,
        )
        .unwrap();
        let signature = response
            .pointer("/content/0/signature")
            .and_then(Value::as_str)
            .unwrap();
        let mut request = json!({
            "messages":[{"role":"assistant","output_blocks":[{
                "type":"thinking","thinking":"","signature":signature
            }]}]
        });
        transform_responses_request(&mut request).unwrap();
        assert_eq!(request.pointer("/input/0/type"), Some(&json!("reasoning")));
        assert_eq!(request.pointer("/input/0/id"), Some(&json!("reason_1")));
        assert_eq!(
            request.pointer("/input/0/encrypted_content"),
            Some(&json!("opaque"))
        );
        assert_eq!(request.pointer("/input/0/summary"), Some(&json!([])));
    }

    #[test]
    fn output_audio_omits_bytes_once_and_preserves_transcript() {
        let result = transform_responses_json(
            &json!({
                "status":"completed","output":[{"type":"message","content":[
                    {"type":"output_audio","data":"AAAA","transcript":"one"},
                    {"type":"output_audio","data":"BBBB","transcript":"two"}
                ]}]
            }),
            false,
        )
        .unwrap();
        let text = result["content"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|block| block.get("text").and_then(Value::as_str))
            .collect::<String>();
        assert_eq!(text, "[generated audio omitted]onetwo");
        assert!(!result.to_string().contains("AAAA"));
        assert!(!result.to_string().contains("BBBB"));
    }

    #[test]
    fn json_response_preserves_reasoning_and_tool_order() {
        let result = transform_responses_json(&json!({
            "id":"resp_1","status":"completed","model":"m",
            "output":[
                {"type":"reasoning","id":"r1","summary":[{"type":"summary_text","text":"think"}],"encrypted_content":"enc"},
                {"type":"function_call","call_id":"call_1","name":"read","arguments":"{\"p\":1}"}
            ],
            "usage":{"input_tokens":4,"output_tokens":2,"total_tokens":6}
        }), false).unwrap();
        assert_eq!(result.pointer("/content/0/type"), Some(&json!("thinking")));
        assert_eq!(result.pointer("/content/1/type"), Some(&json!("tool_use")));
        assert_eq!(result["stop_reason"], "tool_use");
    }

    #[test]
    fn responses_usage_separates_cache_read_and_write_from_input() {
        let result = transform_responses_json(
            &json!({
                "id":"resp_usage","model":"m","status":"completed","output":[],
                "usage":{
                    "input_tokens":17,"output_tokens":4,"total_tokens":21,
                    "input_tokens_details":{"cached_tokens":5,"cache_write_tokens":3},
                    "output_tokens_details":{"reasoning_tokens":2}
                }
            }),
            false,
        )
        .unwrap();
        let usage = &result["usage"];
        assert_eq!(usage["input_tokens"], 9);
        assert_eq!(usage["cache_read_input_tokens"], 5);
        assert_eq!(usage["cache_creation_input_tokens"], 3);
        assert_eq!(usage["output_tokens"], 4);
        assert_eq!(
            usage.pointer("/output_tokens_details/thinking_tokens"),
            Some(&json!(2))
        );
        assert_eq!(
            usage["input_tokens"].as_u64().unwrap()
                + usage["cache_read_input_tokens"].as_u64().unwrap()
                + usage["cache_creation_input_tokens"].as_u64().unwrap(),
            17
        );
    }
}
