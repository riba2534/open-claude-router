use std::collections::{HashMap, HashSet};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde_json::{Map, Value, json};

use super::{ChatToolNameMap, bounded_json, invalid};
use crate::error::ApiError;

const TOOL_RESULT_ERROR_MARKER: &str =
    "[open-claude-router tool_result metadata: {\"is_error\":true}]";
const TOOL_RESULT_MOVED_TEXT: &str =
    "[tool_result multimodal content moved to the following user message]";

pub fn transform_anthropic_request(request: &Value) -> Result<Value, ApiError> {
    transform_anthropic_request_with_file_map(request, &HashMap::new())
}

pub(crate) fn validate_final_outbound_request(request: &Value) -> Result<(), ApiError> {
    if !request
        .get("model")
        .and_then(Value::as_str)
        .is_some_and(|model| !model.trim().is_empty())
    {
        return Err(invalid(
            "model must resolve to a non-empty string after applying upstream model controls",
        ));
    }
    let max_tokens = match request.get("max_tokens") {
        Some(max_tokens) if max_tokens.as_u64().is_some() => max_tokens.as_u64().unwrap(),
        _ => {
            return Err(invalid("max_tokens must be a non-negative integer"));
        }
    };
    if max_tokens == 0 {
        if request.get("stream").and_then(Value::as_bool) == Some(true) {
            return Err(invalid("max_tokens 0 cannot be combined with streaming"));
        }
        if request
            .pointer("/reasoning/enabled")
            .and_then(Value::as_bool)
            == Some(true)
        {
            return Err(invalid(
                "max_tokens 0 cannot be combined with enabled thinking",
            ));
        }
        if request
            .get("response_format")
            .is_some_and(|value| !value.is_null())
        {
            return Err(invalid(
                "max_tokens 0 cannot be combined with structured output",
            ));
        }
        if matches!(
            request.get("tool_choice"),
            Some(Value::String(choice)) if choice == "required"
        ) || request.pointer("/tool_choice/type").and_then(Value::as_str) == Some("function")
        {
            return Err(invalid(
                "max_tokens 0 cannot be combined with forced tool choice",
            ));
        }
    }
    Ok(())
}

fn transform_anthropic_request_with_file_map(
    request: &Value,
    file_map: &HashMap<String, String>,
) -> Result<Value, ApiError> {
    validate_request(request, file_map)?;
    let object = request.as_object().expect("validated object");
    let mut messages = Vec::<Value>::new();

    if let Some(system) = object.get("system") {
        match system {
            Value::String(text) if !text.is_empty() => {
                messages.push(json!({"role":"system", "content":text}));
            }
            Value::Array(parts) => {
                let content = normalize_system_blocks(parts);
                if !content.is_empty() {
                    messages.push(json!({"role":"system", "content":content}));
                }
            }
            _ => {}
        }
    }

    let request_messages = object
        .get("messages")
        .and_then(Value::as_array)
        .expect("validated messages");
    for message in request_messages {
        let role = message.get("role").and_then(Value::as_str).unwrap();
        let content = message.get("content").expect("validated content");
        if role == "system" {
            match content {
                Value::String(text) => messages.push(json!({"role":"system","content":text})),
                Value::Array(parts) => {
                    let expanded = expand_system_blocks(parts)
                        .into_iter()
                        .filter(|part| {
                            !matches!(
                                part.get("type").and_then(Value::as_str),
                                Some("tool_addition" | "tool_removal")
                            )
                        })
                        .cloned()
                        .collect::<Vec<_>>();
                    let normalized = normalize_system_blocks(&expanded);
                    if !normalized.is_empty() {
                        messages.push(json!({"role":"system","content":normalized}));
                    }
                }
                _ => unreachable!(),
            }
            continue;
        }
        match content {
            Value::String(text) => {
                messages.push(json!({"role":role,"content":text}));
            }
            Value::Array(parts) if role == "user" => {
                let mut tool_count = 0;
                for part in parts {
                    if part.get("type").and_then(Value::as_str) == Some("tool_result") {
                        tool_count += 1;
                        messages.push(json!({
                            "role":"tool",
                            "content":convert_tool_result_content(
                                part.get("content"),
                                part.get("is_error").and_then(Value::as_bool) == Some(true),
                                file_map,
                            ),
                            "tool_call_id":part.get("tool_use_id").and_then(Value::as_str).unwrap_or_default(),
                            "cache_control":part.get("cache_control").cloned()
                        }));
                        strip_null_fields(messages.last_mut().unwrap());
                    }
                }
                let mut visible = Vec::new();
                for part in parts {
                    match part.get("type").and_then(Value::as_str) {
                        Some("tool_result") => {}
                        Some("text") => {
                            if let Some(text) = part.get("text").and_then(Value::as_str)
                                && !text.is_empty()
                            {
                                let mut converted = json!({"type":"text","text":text});
                                if let Some(cache) = part.get("cache_control") {
                                    converted["cache_control"] = cache.clone();
                                }
                                visible.push(converted);
                            }
                        }
                        Some("image") => match convert_image(part, file_map) {
                            Some(image) => visible.push(image),
                            None => visible.push(json!({"type":"text","text":bounded_json(part)})),
                        },
                        Some("document") => visible.extend(convert_document_blocks(part, file_map)),
                        Some("search_result") => visible.extend(convert_search_result(part)),
                        _ => visible.push(json!({"type":"text","text":bounded_json(part)})),
                    }
                }
                if !visible.is_empty() {
                    messages.push(json!({"role":"user","content":visible}));
                } else if tool_count == 0 {
                    messages.push(json!({"role":"user","content":""}));
                }
            }
            Value::Array(parts) if role == "assistant" => {
                let mut output_blocks = Vec::new();
                let mut text = Vec::new();
                let mut calls = Vec::new();
                let mut thinking_blocks: Vec<Value> = Vec::new();
                let mut pending_thinking: Vec<Value> = Vec::new();
                for part in parts {
                    match part.get("type").and_then(Value::as_str) {
                        Some("text") => {
                            let value =
                                part.get("text").and_then(Value::as_str).unwrap_or_default();
                            output_blocks.push(json!({"type":"text","text":value}));
                            if !value.is_empty() {
                                text.push(value.to_owned());
                            }
                            thinking_blocks.append(&mut pending_thinking);
                        }
                        Some("tool_use") => {
                            let id = part.get("id").and_then(Value::as_str).unwrap();
                            let name = part.get("name").and_then(Value::as_str).unwrap();
                            let input = part.get("input").cloned().unwrap_or_else(|| json!({}));
                            output_blocks
                                .push(json!({"type":"tool_use","id":id,"name":name,"input":input}));
                            calls.push(json!({
                                "id":id,
                                "type":"function",
                                "function":{"name":name,"arguments":serde_json::to_string(&input).unwrap_or_else(|_| "{}".into())}
                            }));
                            for block in &mut pending_thinking {
                                block["tool_call_id"] = Value::String(id.to_owned());
                            }
                            thinking_blocks.append(&mut pending_thinking);
                        }
                        Some("thinking") => {
                            let thinking = part
                                .get("thinking")
                                .and_then(Value::as_str)
                                .unwrap_or_default();
                            let signature = part.get("signature").and_then(Value::as_str).unwrap();
                            output_blocks.push(json!({"type":"thinking","thinking":thinking,"signature":signature}));
                            pending_thinking
                                .push(json!({"content":thinking,"signature":signature}));
                        }
                        _ => {
                            let fallback = bounded_json(part);
                            output_blocks.push(json!({"type":"text","text":fallback}));
                            text.push(fallback);
                            thinking_blocks.append(&mut pending_thinking);
                        }
                    }
                }
                thinking_blocks.append(&mut pending_thinking);
                let mut converted = json!({
                    "role":"assistant",
                    "content":text.join("\n"),
                    "output_blocks":output_blocks,
                });
                if !calls.is_empty() {
                    converted["tool_calls"] = Value::Array(calls);
                }
                if let Some(first) = thinking_blocks.first() {
                    converted["thinking"] = json!({
                        "content":first.get("content").cloned().unwrap_or(Value::String(String::new())),
                        "signature":first.get("signature").cloned().unwrap_or(Value::Null)
                    });
                    converted["thinking_blocks"] = Value::Array(thinking_blocks);
                }
                messages.push(converted);
            }
            Value::Array(_) => unreachable!(),
            _ => unreachable!(),
        }
    }

    let active_tools = resolve_active_tools(object.get("tools"), request_messages)?;
    let active_names = active_tools
        .iter()
        .filter_map(|tool| tool.get("name").and_then(Value::as_str))
        .collect::<HashSet<_>>();
    if let Some(choice) = object.get("tool_choice") {
        if choice.get("type").and_then(Value::as_str) == Some("tool") {
            let name = choice.get("name").and_then(Value::as_str).unwrap();
            if !active_names.contains(name) {
                return Err(invalid(format!(
                    "tool_choice references inactive tool {}",
                    serde_json::to_string(name).unwrap()
                )));
            }
        }
        if choice.get("type").and_then(Value::as_str) == Some("any") && active_names.is_empty() {
            return Err(invalid("tool_choice any requires at least one active tool"));
        }
    }

    let mut result = Map::new();
    result.insert("messages".into(), Value::Array(messages));
    copy_if_present(object, &mut result, "model", "model");
    copy_if_present(object, &mut result, "max_tokens", "max_tokens");
    copy_if_present(object, &mut result, "temperature", "temperature");
    copy_if_present(object, &mut result, "top_p", "top_p");
    copy_if_present(object, &mut result, "stop_sequences", "stop");
    copy_if_present(object, &mut result, "stream", "stream");
    if !active_tools.is_empty() {
        result.insert(
            "tools".into(),
            Value::Array(
                active_tools
                    .into_iter()
                    .map(|tool| {
                        let parameters = tool
                            .get("input_schema")
                            .cloned()
                            .unwrap_or_else(|| json!({"type":"object","properties":{}}));
                        let mut function = json!({
                            "name":tool.get("name").cloned().unwrap_or(Value::Null),
                            "description":tool.get("description").and_then(Value::as_str).unwrap_or_default(),
                            "parameters":parameters,
                        });
                        if let Some(strict) = tool.get("strict") {
                            function["strict"] = strict.clone();
                        }
                        json!({"type":"function","function":function})
                    })
                    .collect(),
            ),
        );
    }
    if let Some(format) = object
        .get("output_config")
        .and_then(|value| value.get("format"))
        && format.get("type").and_then(Value::as_str) == Some("json_schema")
    {
        result.insert(
            "response_format".into(),
            json!({
                "type":"json_schema",
                "json_schema":{
                    "name":"anthropic_output",
                    "schema":format.get("schema").cloned().unwrap_or(Value::Null),
                    "strict":true
                }
            }),
        );
    }
    let explicit_effort = object
        .get("output_config")
        .and_then(|value| value.get("effort"))
        .and_then(Value::as_str);
    if let Some(effort) = explicit_effort {
        result.insert("reasoning_effort".into(), Value::String(effort.to_owned()));
    }
    if let Some(thinking) = object.get("thinking")
        && matches!(
            thinking.get("type").and_then(Value::as_str),
            Some("enabled" | "adaptive")
        )
    {
        let effort = explicit_effort.map(ToOwned::to_owned).or_else(|| {
            thinking
                .get("budget_tokens")
                .and_then(Value::as_i64)
                .and_then(think_level)
        });
        let mut reasoning = json!({"enabled":true});
        if let Some(effort) = effort {
            reasoning["effort"] = Value::String(effort);
        }
        if let Some(display) = thinking.get("display").and_then(Value::as_str) {
            reasoning["display"] = Value::String(display.to_owned());
        }
        result.insert("reasoning".into(), reasoning);
    }
    if let Some(choice) = object.get("tool_choice") {
        if let Some(disable) = choice
            .get("disable_parallel_tool_use")
            .and_then(Value::as_bool)
        {
            result.insert("parallel_tool_calls".into(), Value::Bool(!disable));
        }
        match choice.get("type").and_then(Value::as_str) {
            Some("tool") => {
                result.insert(
                    "tool_choice".into(),
                    json!({
                        "type":"function",
                        "function":{"name":choice.get("name").cloned().unwrap_or(Value::Null)}
                    }),
                );
            }
            Some("any") => {
                result.insert("tool_choice".into(), Value::String("required".into()));
            }
            Some(kind) => {
                result.insert("tool_choice".into(), Value::String(kind.to_owned()));
            }
            None => {}
        }
    }
    Ok(Value::Object(result))
}

pub fn prepare_chat_request(body: &mut Value) {
    let _ = prepare_chat_request_with_tool_names(body);
}

/// Chat-specific request preparation; returns the tool-name map it applied.
pub fn prepare_chat_request_with_tool_names(body: &mut Value) -> ChatToolNameMap {
    let tool_names = ChatToolNameMap::new(collect_chat_tool_names(body));
    apply_chat_tool_names(body, &tool_names);
    scrub_cache_control(body);
    let reasoning_enabled =
        body.pointer("/reasoning/enabled").and_then(Value::as_bool) == Some(true);
    convert_thinking_to_reasoning_content(body, reasoning_enabled);
    normalize_multimodal_tool_results(body);
    if let Some(object) = body.as_object_mut() {
        object.remove("reasoning");
        if object.get("stream").and_then(Value::as_bool) == Some(true) {
            object.insert("stream_options".into(), json!({"include_usage":true}));
        }
    }
    if let Some(messages) = body.get_mut("messages").and_then(Value::as_array_mut) {
        for message in messages {
            if let Some(object) = message.as_object_mut() {
                object.remove("output_blocks");
            }
        }
    }
    tool_names
}

fn collect_chat_tool_names(body: &Value) -> Vec<String> {
    let mut names = Vec::new();
    if let Some(tools) = body.get("tools").and_then(Value::as_array) {
        names.extend(tools.iter().filter_map(|tool| {
            tool.pointer("/function/name")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        }));
    }
    if let Some(name) = body
        .pointer("/tool_choice/function/name")
        .and_then(Value::as_str)
    {
        names.push(name.to_owned());
    }
    for message in body
        .get("messages")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if let Some(calls) = message.get("tool_calls").and_then(Value::as_array) {
            names.extend(calls.iter().filter_map(|call| {
                call.pointer("/function/name")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned)
            }));
        }
        if let Some(name) = message
            .pointer("/function_call/name")
            .and_then(Value::as_str)
        {
            names.push(name.to_owned());
        }
    }
    names
}

fn apply_chat_tool_names(body: &mut Value, names: &ChatToolNameMap) {
    if let Some(tools) = body.get_mut("tools").and_then(Value::as_array_mut) {
        for tool in tools {
            replace_name_at_pointer(tool, "/function/name", names);
        }
    }
    if let Some(choice) = body.get_mut("tool_choice") {
        replace_name_at_pointer(choice, "/function/name", names);
    }
    if let Some(messages) = body.get_mut("messages").and_then(Value::as_array_mut) {
        for message in messages {
            if let Some(calls) = message.get_mut("tool_calls").and_then(Value::as_array_mut) {
                for call in calls {
                    replace_name_at_pointer(call, "/function/name", names);
                }
            }
            replace_name_at_pointer(message, "/function_call/name", names);
        }
    }
}

fn replace_name_at_pointer(value: &mut Value, pointer: &str, names: &ChatToolNameMap) {
    let Some(original) = value
        .pointer(pointer)
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
    else {
        return;
    };
    let wire = names.wire_name(&original);
    if wire != original
        && let Some(slot) = value.pointer_mut(pointer)
    {
        *slot = Value::String(wire.to_owned());
    }
}

pub(crate) fn scrub_cache_control(body: &mut Value) {
    if let Some(messages) = body.get_mut("messages").and_then(Value::as_array_mut) {
        for message in messages {
            let Some(object) = message.as_object_mut() else {
                continue;
            };
            object.remove("cache_control");
            if let Some(parts) = object.get_mut("content").and_then(Value::as_array_mut) {
                for part in parts {
                    if let Some(part) = part.as_object_mut() {
                        part.remove("cache_control");
                    }
                }
            }
        }
    }
}

fn validate_request(request: &Value, file_map: &HashMap<String, String>) -> Result<(), ApiError> {
    let object = request
        .as_object()
        .ok_or_else(|| invalid("request body must be a JSON object"))?;
    if let Some(system) = object.get("system") {
        if !system.is_string() && !system.is_array() {
            return Err(invalid(
                "system must be a string or an array of content blocks",
            ));
        }
        if let Some(blocks) = system.as_array() {
            for (block_index, block) in blocks.iter().enumerate() {
                let block = block
                    .as_object()
                    .ok_or_else(|| invalid("system content blocks must be objects"))?;
                if !block
                    .get("type")
                    .and_then(Value::as_str)
                    .is_some_and(|kind| !kind.is_empty())
                {
                    return Err(invalid(format!(
                        "system[{block_index}].type must be a non-empty string"
                    )));
                }
                if block.get("type").and_then(Value::as_str) == Some("text") {
                    if !block.get("text").is_some_and(Value::is_string) {
                        return Err(invalid("system text blocks require a string text field"));
                    }
                    validate_text_citations(&Value::Object(block.clone()), "system text block")?;
                }
            }
        }
    }
    if object
        .get("container")
        .is_some_and(|value| !value.is_null())
    {
        return Err(invalid(
            "Anthropic container state has no replay-safe OpenAI equivalent",
        ));
    }
    let messages = object
        .get("messages")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("messages must be an array"))?;
    let mut has_citations_enabled_content = false;
    for (index, message) in messages.iter().enumerate() {
        let message = message
            .as_object()
            .ok_or_else(|| {
                invalid(format!(
                    "messages[{index}] must be an object with role \"user\", \"assistant\", or \"system\"; received undefined"
                ))
            })?;
        let received_role = message
            .get("role")
            .map(|role| serde_json::to_string(role).unwrap_or_else(|_| "undefined".into()))
            .unwrap_or_else(|| "undefined".into());
        let role = message
            .get("role")
            .and_then(Value::as_str)
            .filter(|role| matches!(*role, "user" | "assistant" | "system"))
            .ok_or_else(|| {
                invalid(format!(
                    "messages[{index}] must be an object with role \"user\", \"assistant\", or \"system\"; received {}",
                    received_role
                ))
            })?;
        let content = message
            .get("content")
            .ok_or_else(|| invalid("each message must include content"))?;
        if !content.is_string() && !content.is_array() {
            return Err(invalid(
                "message content must be a string or an array of blocks",
            ));
        }
        if let Some(parts) = content.as_array() {
            for (part_index, part) in parts.iter().enumerate() {
                let part_object = part
                    .as_object()
                    .ok_or_else(|| invalid("message content blocks must be objects"))?;
                let kind = part_object
                    .get("type")
                    .and_then(Value::as_str)
                    .filter(|kind| !kind.is_empty())
                    .ok_or_else(|| {
                        invalid(format!(
                            "messages[{index}].content[{part_index}].type must be a non-empty string"
                        ))
                    })?;
                if is_server_history_block(kind) {
                    return Err(invalid(
                        "Anthropic server-tool history has no OpenAI function-tool equivalent",
                    ));
                }
                match kind {
                    "text" => {
                        if !part_object.get("text").is_some_and(Value::is_string) {
                            return Err(invalid("text blocks require string text"));
                        }
                        validate_text_citations(part, &format!("messages[{index}].content text"))?;
                    }
                    "image" => {
                        if role != "user" {
                            return Err(invalid("image blocks are only valid in user messages"));
                        }
                        validate_image(part, index, file_map)?;
                    }
                    "document" => {
                        if role != "user" {
                            return Err(invalid("document blocks are only valid in user messages"));
                        }
                        has_citations_enabled_content |= validate_document(
                            part,
                            &format!("messages[{index}].content document"),
                            file_map,
                        )?;
                    }
                    "search_result" => {
                        if role != "user" {
                            return Err(invalid(
                                "search_result blocks are only valid in user messages",
                            ));
                        }
                        has_citations_enabled_content |= validate_search_result(
                            part,
                            &format!("messages[{index}].content search_result"),
                        )?;
                    }
                    "mid_conv_system" => {
                        if role != "system" {
                            return Err(invalid(
                                "mid_conv_system blocks are only valid in system messages",
                            ));
                        }
                        let inner = part_object
                            .get("content")
                            .and_then(Value::as_array)
                            .ok_or_else(|| invalid("mid_conv_system.content must be an array"))?;
                        for block in inner {
                            let supported =
                                block
                                    .get("type")
                                    .and_then(Value::as_str)
                                    .is_some_and(|kind| {
                                        matches!(kind, "text" | "tool_addition" | "tool_removal")
                                    });
                            if !block.is_object() || !supported {
                                return Err(invalid(
                                    "mid_conv_system.content supports only text and tool-change blocks",
                                ));
                            }
                            if block.get("type").and_then(Value::as_str) == Some("text")
                                && !block.get("text").is_some_and(Value::is_string)
                            {
                                return Err(invalid(
                                    "mid_conv_system text blocks require a string text field",
                                ));
                            }
                        }
                    }
                    "tool_addition" | "tool_removal" if role != "system" => {
                        return Err(invalid(
                            "tool_addition and tool_removal blocks are only valid in system messages",
                        ));
                    }
                    "tool_use" => {
                        if role != "assistant"
                            || !part_object
                                .get("id")
                                .and_then(Value::as_str)
                                .is_some_and(|v| !v.is_empty())
                            || !part_object
                                .get("name")
                                .and_then(Value::as_str)
                                .is_some_and(|v| !v.is_empty())
                            || !part_object.get("input").is_some_and(Value::is_object)
                        {
                            return Err(invalid(
                                "assistant tool_use blocks require non-empty id/name and an object input",
                            ));
                        }
                        if let Some(caller) = part_object.get("caller") {
                            let caller = caller.as_object().ok_or_else(|| {
                                invalid(
                                    "assistant tool_use caller must be a caller object when provided",
                                )
                            })?;
                            if caller.get("type").and_then(Value::as_str) != Some("direct") {
                                return Err(invalid("assistant tool_use caller must be direct"));
                            }
                        }
                    }
                    "tool_result" => {
                        if role != "user"
                            || !part_object
                                .get("tool_use_id")
                                .and_then(Value::as_str)
                                .is_some_and(|v| !v.is_empty())
                        {
                            return Err(invalid(
                                "user tool_result blocks require a non-empty tool_use_id",
                            ));
                        }
                        if part_object.get("is_error").is_some_and(|v| !v.is_boolean()) {
                            return Err(invalid(
                                "tool_result.is_error must be a boolean when provided",
                            ));
                        }
                        has_citations_enabled_content |= validate_tool_result_content(
                            part_object.get("content"),
                            &format!("messages[{index}].tool_result.content"),
                            file_map,
                        )?;
                    }
                    "thinking" => {
                        if role != "assistant" {
                            return Err(invalid(
                                "thinking blocks are only valid in assistant messages",
                            ));
                        }
                        if !part_object
                            .get("signature")
                            .and_then(Value::as_str)
                            .is_some_and(|v| !v.is_empty())
                        {
                            return Err(invalid(
                                "assistant thinking blocks must include a non-empty signature",
                            ));
                        }
                        if !part_object.get("thinking").is_some_and(Value::is_string) {
                            return Err(invalid(
                                "assistant thinking blocks require a string thinking field",
                            ));
                        }
                    }
                    "redacted_thinking" => {
                        return Err(invalid(
                            "redacted_thinking history has no replay-safe OpenAI equivalent",
                        ));
                    }
                    "compaction" | "fallback" | "container_upload" => {
                        return Err(invalid(format!(
                            "Anthropic {kind} blocks have no replay-safe OpenAI equivalent"
                        )));
                    }
                    _ => {}
                }
            }
        }
    }
    validate_mid_conversation_system_placement(messages)?;
    let references_dynamic_tools = messages.iter().any(message_references_dynamic_tools);
    if references_dynamic_tools
        && object
            .get("tools")
            .and_then(Value::as_array)
            .is_none_or(Vec::is_empty)
    {
        return Err(invalid(
            "tool changes and tool references require declared tools",
        ));
    }
    if let Some(tools) = object.get("tools") {
        let tools = tools
            .as_array()
            .ok_or_else(|| invalid("tools must be an array"))?;
        let mut names = HashSet::new();
        for tool in tools {
            let tool = tool
                .as_object()
                .ok_or_else(|| invalid("each tool must be an object"))?;
            if tool
                .get("type")
                .and_then(Value::as_str)
                .is_some_and(is_server_tool_type)
            {
                return Err(invalid(
                    "Anthropic server-side tools have no OpenAI function-tool equivalent",
                ));
            }
            if tool
                .get("type")
                .and_then(Value::as_str)
                .is_some_and(is_typed_client_tool_type)
            {
                return Err(invalid(
                    "Anthropic typed client tools require a version-specific OpenAI function schema",
                ));
            }
            let name = tool
                .get("name")
                .and_then(Value::as_str)
                .filter(|name| !name.is_empty())
                .ok_or_else(|| invalid("each client tool must have a non-empty name"))?;
            if !names.insert(name) {
                return Err(invalid(format!(
                    "duplicate client tool name {}",
                    serde_json::to_string(name).unwrap()
                )));
            }
            if tool
                .get("input_schema")
                .is_some_and(|schema| !schema.is_object())
            {
                return Err(invalid("tool.input_schema must be an object when provided"));
            }
            if tool.get("strict").is_some_and(|value| !value.is_boolean()) {
                return Err(invalid("tool.strict must be a boolean when provided"));
            }
            if tool
                .get("defer_loading")
                .is_some_and(|value| !value.is_boolean())
            {
                return Err(invalid(
                    "tool.defer_loading must be a boolean when provided",
                ));
            }
            if let Some(callers) = tool.get("allowed_callers") {
                let callers = callers.as_array().filter(|callers| !callers.is_empty());
                let known = callers.is_some_and(|callers| {
                    callers.iter().all(|caller| {
                        matches!(
                            caller.as_str(),
                            Some(
                                "direct"
                                    | "code_execution_20250825"
                                    | "code_execution_20260120"
                                    | "code_execution_20260521"
                            )
                        )
                    })
                });
                if !known {
                    return Err(invalid(
                        "tool.allowed_callers must contain known caller values",
                    ));
                }
                if callers.is_some_and(|callers| {
                    callers
                        .iter()
                        .any(|caller| caller.as_str() != Some("direct"))
                }) {
                    return Err(invalid(
                        "code-execution tool callers have no OpenAI function-tool equivalent",
                    ));
                }
            }
        }
        if !tools.is_empty()
            && tools
                .iter()
                .all(|tool| tool.get("defer_loading").and_then(Value::as_bool) == Some(true))
        {
            return Err(invalid("at least one tool must not use defer_loading"));
        }
    }
    if let Some(choice) = object.get("tool_choice") {
        let choice = choice
            .as_object()
            .ok_or_else(|| invalid("tool_choice must be an object"))?;
        let kind = choice
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !matches!(kind, "auto" | "any" | "tool" | "none") {
            return Err(invalid(
                "tool_choice.type must be \"auto\", \"any\", \"tool\", or \"none\"",
            ));
        }
        if kind == "tool"
            && !choice
                .get("name")
                .and_then(Value::as_str)
                .is_some_and(|name| !name.is_empty())
        {
            return Err(invalid("named tool_choice must include a non-empty name"));
        }
        if choice
            .get("disable_parallel_tool_use")
            .is_some_and(|value| !value.is_boolean())
        {
            return Err(invalid(
                "tool_choice.disable_parallel_tool_use must be a boolean when provided",
            ));
        }
        if kind == "none" && choice.contains_key("disable_parallel_tool_use") {
            return Err(invalid(
                "tool_choice none cannot include disable_parallel_tool_use",
            ));
        }
    }
    if let Some(output_config) = object.get("output_config")
        && !output_config.is_object()
    {
        return Err(invalid("output_config must be an object"));
    }
    if let Some(format) = object
        .get("output_config")
        .and_then(|value| value.get("format"))
        .filter(|value| !value.is_null())
    {
        let valid = format.is_object()
            && format.get("type").and_then(Value::as_str) == Some("json_schema")
            && format.get("schema").is_some_and(Value::is_object);
        if !valid {
            return Err(invalid(
                "output_config.format must be a \"json_schema\" object with an object schema",
            ));
        }
        if has_citations_enabled_content {
            return Err(invalid(
                "output_config.format cannot be combined with document or search_result citations",
            ));
        }
    }
    if has_citations_enabled_content {
        return Err(invalid(
            "document and search_result citations have no OpenAI protocol equivalent",
        ));
    }
    if let Some(effort) = object
        .get("output_config")
        .and_then(|value| value.get("effort"))
        && !effort.is_null()
        && !matches!(
            effort.as_str(),
            Some("low" | "medium" | "high" | "xhigh" | "max")
        )
    {
        return Err(invalid(
            "output_config.effort must be \"low\", \"medium\", \"high\", \"xhigh\", \"max\", or null",
        ));
    }
    if let Some(thinking) = object.get("thinking") {
        let thinking = thinking
            .as_object()
            .ok_or_else(|| invalid("thinking must be an object"))?;
        let kind = thinking
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !matches!(kind, "enabled" | "adaptive" | "disabled") {
            return Err(invalid(
                "thinking.type must be \"enabled\", \"adaptive\", or \"disabled\"",
            ));
        }
        if thinking.get("display").is_some_and(|display| {
            !display.is_null() && !matches!(display.as_str(), Some("summarized" | "omitted"))
        }) {
            return Err(invalid(
                "thinking.display must be \"summarized\", \"omitted\", or null",
            ));
        }
        if kind == "disabled" && thinking.contains_key("display") {
            return Err(invalid(
                "thinking.display is not valid when thinking is disabled",
            ));
        }
        if kind == "enabled" {
            let valid_budget = thinking
                .get("budget_tokens")
                .and_then(Value::as_i64)
                .is_some_and(|budget| budget >= 1024);
            if !valid_budget {
                return Err(invalid(
                    "thinking.budget_tokens must be a finite integer greater than or equal to 1024 when thinking is enabled",
                ));
            }
        } else if thinking.contains_key("budget_tokens") {
            return Err(invalid(
                "thinking.budget_tokens is only valid when thinking.type is enabled",
            ));
        }
        if kind == "enabled"
            && matches!(
                object
                    .get("tool_choice")
                    .and_then(|value| value.get("type"))
                    .and_then(Value::as_str),
                Some("any" | "tool")
            )
        {
            return Err(invalid(
                "forced tool_choice is not compatible with manually enabled thinking",
            ));
        }
    }
    Ok(())
}

fn message_references_dynamic_tools(message: &Value) -> bool {
    let Some(parts) = message.get("content").and_then(Value::as_array) else {
        return false;
    };
    parts.iter().any(|part| {
        let kind = part.get("type").and_then(Value::as_str);
        if matches!(
            kind,
            Some("tool_reference" | "tool_addition" | "tool_removal")
        ) {
            return true;
        }
        if kind == Some("mid_conv_system") {
            return part
                .get("content")
                .and_then(Value::as_array)
                .is_some_and(|content| {
                    content.iter().any(|nested| {
                        matches!(
                            nested.get("type").and_then(Value::as_str),
                            Some("tool_reference" | "tool_addition" | "tool_removal")
                        )
                    })
                });
        }
        if kind == Some("tool_result") {
            return part
                .get("content")
                .and_then(Value::as_array)
                .is_some_and(|content| {
                    content.iter().any(|nested| {
                        nested.get("type").and_then(Value::as_str) == Some("tool_reference")
                    })
                });
        }
        false
    })
}

fn validate_image(
    part: &Value,
    index: usize,
    file_map: &HashMap<String, String>,
) -> Result<(), ApiError> {
    let label = format!("messages[{index}].content image");
    let source = part
        .get("source")
        .and_then(Value::as_object)
        .ok_or_else(|| invalid(format!("{label}.source must be an object")))?;
    match source.get("type").and_then(Value::as_str) {
        Some("file") => validate_mapped_file_source(source, &label, file_map),
        Some("base64") => {
            let data = source.get("data").and_then(Value::as_str);
            let self_describing = data.is_some_and(is_base64_data_url);
            let media = source
                .get("media_type")
                .and_then(Value::as_str)
                .is_some_and(|media| !media.is_empty());
            if data.is_none() || (!self_describing && !media) {
                Err(invalid(format!(
                    "{label} base64 sources require string data and a non-empty media_type",
                )))
            } else {
                Ok(())
            }
        }
        Some("url")
            if !source
                .get("url")
                .and_then(Value::as_str)
                .is_some_and(|url| !url.is_empty()) =>
        {
            Err(invalid(format!(
                "{label} URL sources require a non-empty url"
            )))
        }
        Some(_) => Ok(()),
        None => Err(invalid(format!(
            "{label}.source.type must be a non-empty string"
        ))),
    }
}

fn validate_mapped_file_source(
    source: &Map<String, Value>,
    label: &str,
    file_map: &HashMap<String, String>,
) -> Result<(), ApiError> {
    if file_map.is_empty() {
        return Err(invalid(format!(
            "{label}.source.type \"file\" is provider-owned and cannot be translated to an OpenAI file id"
        )));
    }
    let file_id = source
        .get("file_id")
        .and_then(Value::as_str)
        .filter(|file_id| !file_id.is_empty())
        .ok_or_else(|| invalid(format!("{label}.source.file_id must be a non-empty string")))?;
    if !file_map
        .get(file_id)
        .is_some_and(|mapped| !mapped.is_empty())
    {
        return Err(invalid(format!(
            "{label}.source.type \"file\" is provider-owned and cannot be translated to an OpenAI file id"
        )));
    }
    Ok(())
}

fn is_base64_data_url(value: &str) -> bool {
    if !is_data_url(value) {
        return false;
    }
    let Some(comma) = value.as_bytes().iter().position(|byte| *byte == b',') else {
        return false;
    };
    let header = &value.as_bytes()[..comma];
    header.len() >= b";base64".len()
        && header[header.len() - b";base64".len()..].eq_ignore_ascii_case(b";base64")
}

fn is_data_url(value: &str) -> bool {
    value
        .get(..5)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("data:"))
}

fn validate_text_citations(part: &Value, label: &str) -> Result<(), ApiError> {
    let Some(citations) = part.get("citations") else {
        return Ok(());
    };
    if citations.is_null() {
        return Ok(());
    }
    let citations = citations.as_array().ok_or_else(|| {
        invalid(format!(
            "{label}.citations must be an array or null when provided"
        ))
    })?;
    if !citations.is_empty() {
        return Err(invalid(format!(
            "{label}.citations have no OpenAI protocol equivalent"
        )));
    }
    Ok(())
}

fn validate_optional_document_metadata(part: &Value, label: &str) -> Result<(), ApiError> {
    for key in ["title", "context"] {
        if let Some(value) = part.get(key)
            && !value.is_null()
            && !value.is_string()
        {
            return Err(invalid(format!(
                "{label}.{key} must be a string or null when provided"
            )));
        }
    }
    if let Some(citations) = part.get("citations")
        && !citations.is_null()
        && (!citations.is_object() || !citations.get("enabled").is_some_and(Value::is_boolean))
    {
        return Err(invalid(format!(
            "{label}.citations must include a boolean enabled value"
        )));
    }
    Ok(())
}

fn validate_document(
    part: &Value,
    label: &str,
    file_map: &HashMap<String, String>,
) -> Result<bool, ApiError> {
    validate_optional_document_metadata(part, label)?;
    let source = part
        .get("source")
        .and_then(Value::as_object)
        .ok_or_else(|| invalid(format!("{label}.source must be an object")))?;
    match source.get("type").and_then(Value::as_str) {
        Some("file") => validate_mapped_file_source(source, label, file_map)?,
        Some("base64") => {
            let data = source.get("data").and_then(Value::as_str);
            let self_describing = data.is_some_and(is_base64_data_url);
            let has_media = source
                .get("media_type")
                .and_then(Value::as_str)
                .is_some_and(|media| !media.is_empty());
            if data.is_none() || (!self_describing && !has_media) {
                return Err(invalid(format!(
                    "{label} base64 sources require string data and a non-empty media_type"
                )));
            }
        }
        Some("text") => {
            if !source.get("data").is_some_and(Value::is_string) {
                return Err(invalid(format!("{label} text sources require string data")));
            }
        }
        Some("url") => {
            if !source
                .get("url")
                .and_then(Value::as_str)
                .is_some_and(|url| !url.is_empty())
            {
                return Err(invalid(format!(
                    "{label} URL sources require a non-empty url"
                )));
            }
        }
        Some("content") => match source.get("content") {
            Some(Value::String(_)) => {}
            Some(Value::Array(blocks)) => {
                for (index, block) in blocks.iter().enumerate() {
                    if !block.is_object() {
                        return Err(invalid(format!(
                            "{label}.source.content[{index}] must be a block"
                        )));
                    }
                    match block.get("type").and_then(Value::as_str) {
                        Some("text") => {
                            if !block.get("text").is_some_and(Value::is_string) {
                                return Err(invalid(format!(
                                    "{label}.source.content[{index}].text must be a string"
                                )));
                            }
                            validate_text_citations(
                                block,
                                &format!("{label}.source.content[{index}]"),
                            )?;
                        }
                        Some("image") => validate_image_with_label(
                            block,
                            &format!("{label}.source.content[{index}]"),
                            file_map,
                        )?,
                        Some(kind) if !kind.is_empty() => {}
                        _ => {
                            return Err(invalid(format!(
                                "{label}.source.content[{index}].type must be a non-empty string"
                            )));
                        }
                    }
                }
            }
            _ => {
                return Err(invalid(format!(
                    "{label} content sources require a string or block array"
                )));
            }
        },
        Some(_) => {}
        None => {
            return Err(invalid(format!(
                "{label}.source.type must be a non-empty string"
            )));
        }
    }
    Ok(part.pointer("/citations/enabled").and_then(Value::as_bool) == Some(true))
}

fn validate_image_with_label(
    part: &Value,
    label: &str,
    file_map: &HashMap<String, String>,
) -> Result<(), ApiError> {
    let source = part
        .get("source")
        .and_then(Value::as_object)
        .ok_or_else(|| invalid(format!("{label}.source must be an object")))?;
    match source.get("type").and_then(Value::as_str) {
        Some("file") => validate_mapped_file_source(source, label, file_map),
        Some("base64") => {
            let data = source.get("data").and_then(Value::as_str);
            let self_describing = data.is_some_and(is_base64_data_url);
            let has_media = source
                .get("media_type")
                .and_then(Value::as_str)
                .is_some_and(|media| !media.is_empty());
            if data.is_none() || (!self_describing && !has_media) {
                Err(invalid(format!(
                    "{label} base64 sources require string data and a non-empty media_type"
                )))
            } else {
                Ok(())
            }
        }
        Some("url") => {
            if source
                .get("url")
                .and_then(Value::as_str)
                .is_some_and(|url| !url.is_empty())
            {
                Ok(())
            } else {
                Err(invalid(format!(
                    "{label} URL sources require a non-empty url"
                )))
            }
        }
        Some(_) => Ok(()),
        None => Err(invalid(format!(
            "{label}.source.type must be a non-empty string"
        ))),
    }
}

fn validate_search_result(part: &Value, label: &str) -> Result<bool, ApiError> {
    let title_valid = part
        .get("title")
        .and_then(Value::as_str)
        .is_some_and(|value| !value.is_empty());
    let source_valid = part
        .get("source")
        .and_then(Value::as_str)
        .is_some_and(|value| !value.is_empty());
    if !title_valid || !source_valid {
        return Err(invalid(format!(
            "{label} requires non-empty title and source strings"
        )));
    }
    let content = part
        .get("content")
        .and_then(Value::as_array)
        .filter(|content| !content.is_empty())
        .ok_or_else(|| {
            invalid(format!(
                "{label}.content must be a non-empty array of text blocks"
            ))
        })?;
    for (index, block) in content.iter().enumerate() {
        let valid = block.is_object()
            && block.get("type").and_then(Value::as_str) == Some("text")
            && block
                .get("text")
                .and_then(Value::as_str)
                .is_some_and(|text| !text.is_empty());
        if !valid {
            return Err(invalid(format!(
                "{label}.content[{index}] must be a text block with non-empty text"
            )));
        }
        validate_text_citations(block, &format!("{label}.content[{index}]"))?;
    }
    if let Some(citations) = part.get("citations")
        && !citations.is_null()
        && (!citations.is_object() || !citations.get("enabled").is_some_and(Value::is_boolean))
    {
        return Err(invalid(format!(
            "{label}.citations must include a boolean enabled value"
        )));
    }
    Ok(part.pointer("/citations/enabled").and_then(Value::as_bool) == Some(true))
}

fn validate_tool_result_content(
    content: Option<&Value>,
    label: &str,
    file_map: &HashMap<String, String>,
) -> Result<bool, ApiError> {
    let Some(content) = content else {
        return Ok(false);
    };
    if content.is_null() || content.is_string() {
        return Ok(false);
    }
    let blocks = content.as_array().ok_or_else(|| {
        invalid(format!(
            "{label} must be a string or an array of content blocks"
        ))
    })?;
    let mut has_citations = false;
    let mut has_search_result = false;
    let mut has_other_visible_content = false;
    for (index, block) in blocks.iter().enumerate() {
        let block_label = format!("{label}[{index}]");
        if !block.is_object() {
            return Err(invalid(format!("{block_label} must be a content block")));
        }
        match block.get("type").and_then(Value::as_str) {
            Some("text") => {
                has_other_visible_content = true;
                if !block.get("text").is_some_and(Value::is_string) {
                    return Err(invalid(format!("{block_label}.text must be a string")));
                }
                validate_text_citations(block, &block_label)?;
            }
            Some("image") => {
                has_other_visible_content = true;
                validate_image_with_label(block, &block_label, file_map)?;
            }
            Some("document") => {
                has_other_visible_content = true;
                has_citations |= validate_document(block, &block_label, file_map)?;
            }
            Some("search_result") => {
                has_search_result = true;
                has_citations |= validate_search_result(block, &block_label)?;
            }
            Some("tool_reference")
                if !block
                    .get("tool_name")
                    .and_then(Value::as_str)
                    .is_some_and(|name| !name.is_empty()) =>
            {
                return Err(invalid(format!(
                    "{block_label} requires a non-empty tool_name"
                )));
            }
            _ => {}
        }
    }
    if has_search_result && has_other_visible_content {
        return Err(invalid(format!(
            "{label} cannot mix search_result blocks with other visible content blocks"
        )));
    }
    Ok(has_citations)
}

fn validate_mid_conversation_system_placement(messages: &[Value]) -> Result<(), ApiError> {
    let mut index = 0;
    while index < messages.len() {
        if messages[index].get("role").and_then(Value::as_str) != Some("system") {
            index += 1;
            continue;
        }
        let group_start = index;
        while index < messages.len()
            && messages[index].get("role").and_then(Value::as_str) == Some("system")
        {
            index += 1;
        }
        let valid_previous = group_start > 0
            && (messages[group_start - 1]
                .get("role")
                .and_then(Value::as_str)
                == Some("user")
                || assistant_ends_with_server_tool_result(&messages[group_start - 1]));
        if !valid_previous {
            return Err(invalid(
                "mid-conversation system messages must follow a user turn or an assistant server-tool result",
            ));
        }
        if messages
            .get(index)
            .is_some_and(|message| message.get("role").and_then(Value::as_str) != Some("assistant"))
        {
            return Err(invalid(
                "mid-conversation system messages must be final or followed by an assistant turn",
            ));
        }
    }
    Ok(())
}

fn assistant_ends_with_server_tool_result(message: &Value) -> bool {
    let Some(last) = message
        .get("content")
        .and_then(Value::as_array)
        .and_then(|content| content.last())
    else {
        return false;
    };
    let is_server_result = last
        .get("type")
        .and_then(Value::as_str)
        .is_some_and(|kind| {
            matches!(
                kind,
                "web_search_tool_result"
                    | "web_fetch_tool_result"
                    | "code_execution_tool_result"
                    | "bash_code_execution_tool_result"
                    | "text_editor_code_execution_tool_result"
                    | "mcp_tool_result"
            )
        });
    is_server_result
        && last
            .get("tool_use_id")
            .and_then(Value::as_str)
            .is_some_and(|id| !id.is_empty())
}

fn is_server_tool_type(kind: &str) -> bool {
    kind == "mcp_toolset"
        || [
            "web_search",
            "web_fetch",
            "code_execution",
            "advisor",
            "tool_search_tool_regex",
            "tool_search_tool_bm25",
        ]
        .iter()
        .any(|prefix| kind == *prefix || kind.starts_with(&format!("{prefix}_")))
}

fn is_typed_client_tool_type(kind: &str) -> bool {
    ["bash", "computer", "memory", "text_editor"]
        .iter()
        .any(|prefix| kind == *prefix || kind.starts_with(&format!("{prefix}_")))
}

fn is_server_history_block(kind: &str) -> bool {
    matches!(kind, "server_tool_use" | "mcp_tool_use")
        || matches!(
            kind,
            "web_search_tool_result"
                | "web_fetch_tool_result"
                | "code_execution_tool_result"
                | "bash_code_execution_tool_result"
                | "text_editor_code_execution_tool_result"
                | "tool_search_tool_result"
                | "advisor_tool_result"
                | "mcp_tool_result"
        )
}

fn normalize_system_blocks(parts: &[Value]) -> Vec<Value> {
    parts
        .iter()
        .filter_map(|part| {
            if part.get("type").and_then(Value::as_str) == Some("text") {
                let text = part.get("text").and_then(Value::as_str)?;
                if text.is_empty() {
                    return None;
                }
                let mut value = json!({"type":"text","text":text});
                if let Some(cache) = part.get("cache_control") {
                    value["cache_control"] = cache.clone();
                }
                Some(value)
            } else {
                Some(json!({"type":"text","text":bounded_json(part)}))
            }
        })
        .collect()
}

fn expand_system_blocks(parts: &[Value]) -> Vec<&Value> {
    let mut expanded = Vec::new();
    for part in parts {
        if part.get("type").and_then(Value::as_str) == Some("mid_conv_system") {
            if let Some(content) = part.get("content").and_then(Value::as_array) {
                expanded.extend(content);
            }
        } else {
            expanded.push(part);
        }
    }
    expanded
}

fn convert_image(part: &Value, file_map: &HashMap<String, String>) -> Option<Value> {
    let source = part.get("source")?;
    let source_type = source.get("type")?.as_str()?;
    if source_type == "file" {
        let mapped = source
            .get("file_id")
            .and_then(Value::as_str)
            .and_then(|file_id| file_map.get(file_id))?;
        return Some(json!({"type":"image_file","image_file":{"file_id":mapped}}));
    }
    let url = match source_type {
        "url" => source.get("url")?.as_str()?.to_owned(),
        "base64" => {
            let data = source.get("data")?.as_str()?;
            if is_base64_data_url(data) {
                data.to_owned()
            } else {
                format!(
                    "data:{};base64,{data}",
                    source
                        .get("media_type")
                        .and_then(Value::as_str)
                        .unwrap_or("application/octet-stream")
                )
            }
        }
        _ => return None,
    };
    Some(json!({"type":"image_url","image_url":{"url":url}}))
}

fn convert_document_blocks(part: &Value, file_map: &HashMap<String, String>) -> Vec<Value> {
    let Some(source) = part.get("source") else {
        return vec![json!({"type":"text","text":bounded_json(part)})];
    };
    if source.get("type").and_then(Value::as_str) == Some("content") {
        let mut result = vec![document_metadata(part)];
        match source.get("content") {
            Some(Value::String(text)) => result.push(json!({"type":"text","text":text})),
            Some(Value::Array(parts)) => {
                for content in parts {
                    if content.get("type").and_then(Value::as_str) == Some("text") {
                        result.push(json!({"type":"text","text":content.get("text").and_then(Value::as_str).unwrap_or_default()}));
                    } else if content.get("type").and_then(Value::as_str) == Some("image") {
                        result.push(convert_image(content, file_map).unwrap_or_else(
                            || json!({"type":"text","text":bounded_json(content)}),
                        ));
                    } else {
                        result.push(json!({"type":"text","text":bounded_json(content)}));
                    }
                }
            }
            _ => {}
        }
        return result;
    }
    let filename = part
        .get("title")
        .and_then(Value::as_str)
        .filter(|title| !title.is_empty())
        .unwrap_or_else(|| {
            if source.get("type").and_then(Value::as_str) == Some("text") {
                "document.txt"
            } else {
                "document.pdf"
            }
        });
    let mut file = json!({"filename":filename});
    match source.get("type").and_then(Value::as_str) {
        Some("file") => {
            let Some(mapped) = source
                .get("file_id")
                .and_then(Value::as_str)
                .and_then(|file_id| file_map.get(file_id))
            else {
                return vec![json!({"type":"text","text":bounded_json(part)})];
            };
            file["file_id"] = Value::String(mapped.clone());
        }
        Some("base64") => {
            let data = source
                .get("data")
                .and_then(Value::as_str)
                .unwrap_or_default();
            file["file_data"] = Value::String(if is_data_url(data) {
                data.to_owned()
            } else {
                format!(
                    "data:{};base64,{data}",
                    source
                        .get("media_type")
                        .and_then(Value::as_str)
                        .unwrap_or("application/pdf")
                )
            });
        }
        Some("text") => {
            let data = source
                .get("data")
                .and_then(Value::as_str)
                .unwrap_or_default();
            file["file_data"] =
                Value::String(format!("data:text/plain;base64,{}", STANDARD.encode(data)));
        }
        Some("url") => {
            file["file_url"] = source.get("url").cloned().unwrap_or(Value::Null);
        }
        _ => return vec![json!({"type":"text","text":bounded_json(part)})],
    }
    let mut result = Vec::new();
    if part.get("context").is_some_and(|value| !value.is_null()) {
        result.push(document_metadata(part));
    }
    result.push(json!({
        "type":"file",
        "file":file,
        "fallback_text":document_fallback(part)
    }));
    result
}

fn document_metadata(part: &Value) -> Value {
    let metadata = json!({
        "title":part.get("title").cloned().unwrap_or(Value::Null),
        "context":part.get("context").cloned().unwrap_or(Value::Null)
    });
    json!({"type":"text","text":format!("[open-claude-router document metadata: {}]", serde_json::to_string(&metadata).unwrap())})
}

fn document_fallback(part: &Value) -> String {
    let source = part.get("source").unwrap_or(&Value::Null);
    let title = part
        .get("title")
        .and_then(Value::as_str)
        .filter(|title| !title.is_empty())
        .map(|title| format!(" {}", serde_json::to_string(title).unwrap()))
        .unwrap_or_default();
    match source.get("type").and_then(Value::as_str) {
        Some("file") => format!("[document{title}: mapped file]"),
        Some("url") => format!(
            "[document{title}: {}]",
            source
                .get("url")
                .and_then(Value::as_str)
                .unwrap_or_default()
        ),
        Some("base64") => format!(
            "[document{title}: {}, {} base64 chars]",
            source
                .get("media_type")
                .and_then(Value::as_str)
                .unwrap_or("application/octet-stream"),
            source
                .get("data")
                .and_then(Value::as_str)
                .map(str::len)
                .unwrap_or_default()
        ),
        Some("text") => format!(
            "{}{}",
            if title.is_empty() {
                String::new()
            } else {
                format!("[document{title}]\n")
            },
            source
                .get("data")
                .and_then(Value::as_str)
                .unwrap_or_default()
        ),
        _ => bounded_json(part),
    }
}

fn convert_search_result(part: &Value) -> Vec<Value> {
    let metadata = json!({
        "title":part.get("title").cloned().unwrap_or(Value::Null),
        "source":part.get("source").cloned().unwrap_or(Value::Null)
    });
    let mut result = vec![json!({
        "type":"text",
        "text":format!("[open-claude-router search_result metadata: {}]", serde_json::to_string(&metadata).unwrap())
    })];
    if let Some(content) = part.get("content").and_then(Value::as_array) {
        result.extend(content.iter().map(|item| {
            json!({
                "type":"text",
                "text":item.get("text").and_then(Value::as_str).unwrap_or_default()
            })
        }));
    }
    result
}

fn convert_tool_result_content(
    content: Option<&Value>,
    is_error: bool,
    file_map: &HashMap<String, String>,
) -> Value {
    let mut result = Vec::new();
    if is_error {
        result.push(json!({"type":"text","text":TOOL_RESULT_ERROR_MARKER}));
    }
    match content {
        None | Some(Value::Null) => {}
        Some(Value::String(text)) if !is_error => return Value::String(text.clone()),
        Some(Value::String(text)) => result.push(json!({"type":"text","text":text})),
        Some(Value::Array(parts)) => {
            for part in parts {
                if part.get("type").and_then(Value::as_str) == Some("tool_reference") {
                    continue;
                }
                match part.get("type").and_then(Value::as_str) {
                    Some("text") => result.push(json!({"type":"text","text":part.get("text").and_then(Value::as_str).unwrap_or_default()})),
                    Some("image") => result.push(convert_image(part, file_map).unwrap_or_else(|| json!({"type":"text","text":bounded_json(part)}))),
                    Some("document") => result.extend(convert_document_blocks(part, file_map)),
                    Some("search_result") => result.extend(convert_search_result(part)),
                    _ => result.push(json!({"type":"text","text":bounded_json(part)})),
                }
            }
        }
        Some(other) => result.push(json!({"type":"text","text":bounded_json(other)})),
    }
    if result.is_empty() {
        Value::String(String::new())
    } else {
        Value::Array(result)
    }
}

fn resolve_active_tools(tools: Option<&Value>, messages: &[Value]) -> Result<Vec<Value>, ApiError> {
    let Some(tools) = tools.and_then(Value::as_array) else {
        return Ok(Vec::new());
    };
    let declared = tools
        .iter()
        .filter_map(|tool| {
            tool.get("name")
                .and_then(Value::as_str)
                .map(|name| (name, tool))
        })
        .collect::<HashMap<_, _>>();
    let mut active = tools
        .iter()
        .filter(|tool| tool.get("defer_loading").and_then(Value::as_bool) != Some(true))
        .filter_map(|tool| tool.get("name").and_then(Value::as_str))
        .collect::<HashSet<_>>();
    for message in messages {
        let Some(parts) = message.get("content").and_then(Value::as_array) else {
            continue;
        };
        if message.get("role").and_then(Value::as_str) == Some("system") {
            for block in expand_system_blocks(parts) {
                let Some(kind @ ("tool_addition" | "tool_removal")) =
                    block.get("type").and_then(Value::as_str)
                else {
                    continue;
                };
                let reference = block.get("tool").unwrap_or(&Value::Null);
                let name = reference
                    .get("name")
                    .and_then(Value::as_str)
                    .filter(|name| !name.is_empty());
                if reference.get("type").and_then(Value::as_str) != Some("tool_reference")
                    || name.is_none()
                {
                    return Err(invalid(format!(
                        "{kind} currently requires a named tool_reference; MCP tool-change references have no OpenAI function-tool equivalent"
                    )));
                }
                let name = name.unwrap();
                if !declared.contains_key(name) {
                    return Err(invalid(format!(
                        "{kind} references undeclared tool {}",
                        serde_json::to_string(name).unwrap()
                    )));
                }
                if kind == "tool_addition" {
                    active.insert(name);
                } else {
                    active.remove(name);
                }
            }
        } else if message.get("role").and_then(Value::as_str) == Some("user") {
            for block in parts {
                if block.get("type").and_then(Value::as_str) != Some("tool_result") {
                    continue;
                }
                let items = block
                    .get("content")
                    .and_then(Value::as_array)
                    .map(Vec::as_slice)
                    .unwrap_or(&[]);
                for item in items {
                    if item.get("type").and_then(Value::as_str) == Some("tool_reference") {
                        let name = item.get("tool_name").and_then(Value::as_str).ok_or_else(
                            || {
                                invalid(
                                    "tool_result tool_reference must include a non-empty tool_name",
                                )
                            },
                        )?;
                        if !declared.contains_key(name) {
                            return Err(invalid(format!(
                                "tool_result tool_reference references undeclared tool {}",
                                serde_json::to_string(name).unwrap()
                            )));
                        }
                        active.insert(name);
                    }
                }
            }
        }
    }
    Ok(tools
        .iter()
        .filter(|tool| {
            tool.get("name")
                .and_then(Value::as_str)
                .is_some_and(|name| active.contains(name))
        })
        .cloned()
        .collect())
}

fn convert_thinking_to_reasoning_content(body: &mut Value, reasoning_enabled: bool) {
    let Some(messages) = body.get_mut("messages").and_then(Value::as_array_mut) else {
        return;
    };
    for message in messages {
        if message.get("role").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        let joined = message
            .get("thinking_blocks")
            .and_then(Value::as_array)
            .map(|blocks| {
                blocks
                    .iter()
                    .filter_map(|block| {
                        block
                            .get("content")
                            .and_then(Value::as_str)
                            .filter(|s| !s.is_empty())
                            .map(ToOwned::to_owned)
                            .or_else(|| {
                                block
                                    .get("signature")
                                    .and_then(Value::as_str)
                                    .and_then(decode_chat_signature)
                            })
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default();
        let single = message
            .pointer("/thinking/content")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(ToOwned::to_owned)
            .or_else(|| {
                message
                    .pointer("/thinking/signature")
                    .and_then(Value::as_str)
                    .and_then(decode_chat_signature)
            });
        let has_calls = message
            .get("tool_calls")
            .and_then(Value::as_array)
            .is_some_and(|calls| !calls.is_empty());
        if let Some(object) = message.as_object_mut() {
            if !joined.is_empty() {
                object.insert("reasoning_content".into(), Value::String(joined));
            } else if let Some(single) = single {
                object.insert("reasoning_content".into(), Value::String(single));
            } else if reasoning_enabled && has_calls {
                object.insert("reasoning_content".into(), Value::String(String::new()));
            }
            object.remove("thinking");
            object.remove("thinking_blocks");
        }
    }
}

fn normalize_multimodal_tool_results(body: &mut Value) {
    let Some(messages) = body.get_mut("messages").and_then(Value::as_array_mut) else {
        return;
    };
    let mut normalized = Vec::new();
    let mut pending: Vec<(Vec<Value>, String)> = Vec::new();
    let mut ordinal = 0;
    for mut message in std::mem::take(messages) {
        normalize_file_parts(&mut message);
        if message.get("role").and_then(Value::as_str) != Some("tool") {
            flush_sidecars(&mut normalized, &mut pending, Some(&mut message));
            normalized.push(message);
            continue;
        }
        ordinal += 1;
        if let Some(parts) = message.get("content").and_then(Value::as_array) {
            let text = parts
                .iter()
                .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
                .cloned()
                .collect::<Vec<_>>();
            let multimodal = parts
                .iter()
                .filter(|part| {
                    matches!(
                        part.get("type").and_then(Value::as_str),
                        Some("image_url" | "file")
                    )
                })
                .cloned()
                .collect::<Vec<_>>();
            if !multimodal.is_empty() {
                let provenance = match message.get("tool_call_id").and_then(Value::as_str) {
                    Some(id) => {
                        json!({"tool_index":ordinal,"tool_call_id_utf16be_base64url":encode_utf16be(id)})
                    }
                    None => json!({"tool_index":ordinal}),
                };
                pending.push((
                    multimodal.clone(),
                    format!(
                        "[tool_result multimodal content {}]",
                        serde_json::to_string(&provenance).unwrap()
                    ),
                ));
            }
            message["content"] = if text.len() == 1 {
                text[0]
                    .get("text")
                    .cloned()
                    .unwrap_or(Value::String(String::new()))
            } else if !text.is_empty() {
                Value::Array(text)
            } else if !multimodal.is_empty() {
                Value::String(TOOL_RESULT_MOVED_TEXT.into())
            } else {
                Value::String(String::new())
            };
        } else if message.get("content").is_none_or(Value::is_null) {
            message["content"] = Value::String(String::new());
        }
        normalized.push(message);
    }
    flush_sidecars(&mut normalized, &mut pending, None);
    *messages = normalized;
}

fn normalize_file_parts(message: &mut Value) {
    let Some(parts) = message.get_mut("content").and_then(Value::as_array_mut) else {
        return;
    };
    for part in parts {
        if part.get("type").and_then(Value::as_str) == Some("image_file") {
            if let Some(id) = part.pointer("/image_file/file_id").and_then(Value::as_str) {
                *part = json!({"type":"file","file":{"file_id":id}});
            }
        } else if part.get("type").and_then(Value::as_str) == Some("file") {
            let fallback = part
                .get("fallback_text")
                .and_then(Value::as_str)
                .unwrap_or("[unsupported document omitted]")
                .to_owned();
            let Some(file) = part.get("file").and_then(Value::as_object) else {
                *part = json!({"type":"text","text":fallback});
                continue;
            };
            if file.get("file_data").is_some_and(Value::is_string)
                || file.get("file_id").is_some_and(Value::is_string)
            {
                let mut output = Map::new();
                for key in ["file_data", "file_id", "filename"] {
                    if let Some(value) = file.get(key).filter(|value| value.is_string()) {
                        output.insert(key.into(), value.clone());
                    }
                }
                *part = json!({"type":"file","file":output});
            } else {
                *part = json!({"type":"text","text":fallback});
            }
        }
    }
}

fn flush_sidecars(
    normalized: &mut Vec<Value>,
    pending: &mut Vec<(Vec<Value>, String)>,
    next: Option<&mut Value>,
) {
    if pending.is_empty() {
        return;
    }
    let mut parts = Vec::new();
    let multiple = pending.len() > 1;
    for (bytes, marker) in pending.drain(..) {
        parts.extend(bytes);
        if multiple {
            parts.push(json!({"type":"text","text":marker}));
        }
    }
    if let Some(next) = next.filter(|next| next.get("role").and_then(Value::as_str) == Some("user"))
    {
        let existing = match next.get("content") {
            Some(Value::Array(parts)) => parts.clone(),
            Some(Value::String(text)) if !text.is_empty() => {
                vec![json!({"type":"text","text":text})]
            }
            _ => Vec::new(),
        };
        parts.extend(existing);
        next["content"] = Value::Array(parts);
    } else {
        normalized.push(json!({"role":"user","content":parts}));
    }
}

fn encode_utf16be(value: &str) -> String {
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    let mut bytes = Vec::with_capacity(value.encode_utf16().count() * 2);
    for unit in value.encode_utf16() {
        bytes.extend_from_slice(&unit.to_be_bytes());
    }
    URL_SAFE_NO_PAD.encode(bytes)
}

fn decode_chat_signature(signature: &str) -> Option<String> {
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    let encoded = signature.strip_prefix("ocr-chat-reasoning-v1:")?;
    let decoded = URL_SAFE_NO_PAD.decode(encoded).ok()?;
    serde_json::from_slice::<Value>(&decoded)
        .ok()?
        .get("reasoning_content")?
        .as_str()
        .map(ToOwned::to_owned)
}

fn think_level(budget: i64) -> Option<String> {
    Some(
        if budget <= 1024 {
            "low"
        } else if budget <= 8192 {
            "medium"
        } else {
            "high"
        }
        .to_owned(),
    )
}

fn copy_if_present(
    source: &Map<String, Value>,
    target: &mut Map<String, Value>,
    source_key: &str,
    target_key: &str,
) {
    if let Some(value) = source.get(source_key) {
        target.insert(target_key.into(), value.clone());
    }
}

fn strip_null_fields(value: &mut Value) {
    if let Some(object) = value.as_object_mut() {
        object.retain(|_, value| !value.is_null());
    }
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;
    use serde_json::json;

    use super::*;

    #[test]
    fn converts_multimodal_user_content() {
        let result = transform_anthropic_request(&json!({
            "model":"claude-test","max_tokens":32,
            "messages":[{"role":"user","content":[
                {"type":"image","source":{"type":"base64","media_type":"image/png","data":"AA=="}},
                {"type":"text","text":"describe"},
                {"type":"image","source":{"type":"url","url":"https://example.com/a.png"}}
            ]}]
        }))
        .unwrap();
        assert_eq!(
            result.pointer("/messages/0/content").unwrap(),
            &json!([
                {"type":"image_url","image_url":{"url":"data:image/png;base64,AA=="}},
                {"type":"text","text":"describe"},
                {"type":"image_url","image_url":{"url":"https://example.com/a.png"}}
            ])
        );
    }

    #[test]
    fn enabled_thinking_requires_budget() {
        let error = transform_anthropic_request(&json!({
            "model":"claude-test","max_tokens":32,
            "messages":[],"thinking":{"type":"enabled","budget_tokens":12}
        }))
        .unwrap_err();
        assert_eq!(error.status, axum::http::StatusCode::BAD_REQUEST);
    }

    #[test]
    fn dynamic_tool_references_require_non_empty_tools() {
        for messages in [
            json!([
                {"role":"user","content":"load tools"},
                {"role":"system","content":[{
                    "type":"tool_addition","tool":{"name":"lookup"}
                }]},
                {"role":"assistant","content":"ready"}
            ]),
            json!([{"role":"user","content":[{
                "type":"tool_result","tool_use_id":"call_1","content":[{
                    "type":"tool_reference","tool_name":"lookup"
                }]
            }]}]),
        ] {
            let error = transform_anthropic_request(&json!({
                "model":"claude-test","max_tokens":32,"messages":messages
            }))
            .unwrap_err();
            assert_eq!(error.status, axum::http::StatusCode::BAD_REQUEST);
            assert_eq!(
                error.message,
                "tool changes and tool references require declared tools"
            );
        }
    }

    #[test]
    fn validates_required_request_shape() {
        for body in [
            json!({"messages":[]}),
            json!({"model":"","messages":[]}),
            json!({"model":"m","max_tokens":-1,"messages":[]}),
        ] {
            transform_anthropic_request(&body).unwrap();
        }
        let error = transform_anthropic_request(&json!({"model":"m","max_tokens":1,"messages":{}}))
            .unwrap_err();
        assert_eq!(error.message, "messages must be an array");
    }

    #[test]
    fn validates_model_and_max_tokens_after_model_controls() {
        for body in [
            json!({"model":"m","max_tokens":0}),
            json!({"model":"m","max_tokens":1}),
        ] {
            validate_final_outbound_request(&body).unwrap();
        }
        for body in [
            json!({"max_tokens":1}),
            json!({"model":"","max_tokens":1}),
            json!({"model":7,"max_tokens":1}),
            json!({"model":"m"}),
            json!({"model":"m","max_tokens":null}),
            json!({"model":"m","max_tokens":"1"}),
            json!({"model":"m","max_tokens":1.5}),
            json!({"model":"m","max_tokens":-1}),
        ] {
            let error = validate_final_outbound_request(&body).unwrap_err();
            assert_eq!(error.status, axum::http::StatusCode::BAD_REQUEST);
            assert!(!error.retryable);
        }
        let overflow: Value =
            serde_json::from_str(r#"{"model":"m","max_tokens":18446744073709551616}"#).unwrap();
        assert!(validate_final_outbound_request(&overflow).is_err());
    }

    #[test]
    fn zero_max_tokens_rejects_incompatible_generation_controls() {
        for body in [
            json!({"model":"m","max_tokens":0,"stream":true}),
            json!({"model":"m","max_tokens":0,"reasoning":{"enabled":true}}),
            json!({"model":"m","max_tokens":0,"response_format":{"type":"json_schema"}}),
            json!({"model":"m","max_tokens":0,"tool_choice":"required"}),
            json!({"model":"m","max_tokens":0,"tool_choice":{"type":"function","function":{"name":"read"}}}),
        ] {
            assert!(validate_final_outbound_request(&body).is_err());
        }
    }

    #[test]
    fn rejects_duplicate_tools_non_object_schemas_and_nested_text_type_errors() {
        for body in [
            json!({"model":"m","max_tokens":1,"messages":[],"tools":[
                {"name":"same","input_schema":{"type":"object"}},
                {"name":"same","input_schema":{"type":"object"}}
            ]}),
            json!({"model":"m","max_tokens":1,"messages":[],"tools":[
                {"name":"bad","input_schema":"not-an-object"}
            ]}),
            json!({"model":"m","max_tokens":1,"messages":[
                {"role":"assistant","content":[{"type":"thinking","thinking":7,"signature":"sig"}]}
            ]}),
            json!({"model":"m","max_tokens":1,"messages":[
                {"role":"user","content":"before"},
                {"role":"system","content":[{"type":"mid_conv_system","content":[{"type":"text","text":7}]}]}
            ]}),
        ] {
            let error = transform_anthropic_request(&body).unwrap_err();
            assert_eq!(error.status, axum::http::StatusCode::BAD_REQUEST);
        }
    }

    #[test]
    fn ignores_fields_without_an_openai_mapping() {
        let result = transform_anthropic_request(&json!({
            "model":"m","max_tokens":1,"messages":[],
            "metadata":{"user_id":"user-1","future":true},
            "service_tier":"standard_only",
            "top_k":3,"cache_control":{"type":"ephemeral"},"inference_geo":"us"
        }))
        .unwrap();
        for field in [
            "safety_identifier",
            "service_tier",
            "top_k",
            "cache_control",
            "inference_geo",
        ] {
            assert!(result.get(field).is_none());
        }
    }

    #[test]
    fn provider_owned_file_sources_are_rejected() {
        let request = json!({
            "model":"m","max_tokens":1,"messages":[{"role":"user","content":[
                {"type":"image","source":{"type":"file","file_id":"client-image"}},
                {"type":"document","title":"report.pdf","source":{"type":"file","file_id":"client-doc"}}
            ]}]
        });
        let error = transform_anthropic_request(&request).unwrap_err();
        assert_eq!(
            error.message,
            "messages[0].content image.source.type \"file\" is provider-owned and cannot be translated to an OpenAI file id"
        );
    }

    #[test]
    fn preserves_case_insensitive_self_describing_data_urls() {
        let result = transform_anthropic_request(&json!({
            "model":"m","max_tokens":1,"messages":[{"role":"user","content":[
                {"type":"image","source":{"type":"base64","data":"DATA:image/png;BASE64,AA=="}}
            ]}]
        }))
        .unwrap();
        assert_eq!(
            result.pointer("/messages/0/content/0/image_url/url"),
            Some(&json!("DATA:image/png;BASE64,AA=="))
        );
    }

    #[test]
    fn chat_tool_aliases_cover_declarations_choice_and_assistant_history() {
        let exact_64 = "s".repeat(64);
        let shared = "x".repeat(64);
        let long_a = format!("{shared}A");
        let long_b = format!("{shared}B");
        let long_128 = "z".repeat(128);
        let mut body = transform_anthropic_request(&json!({
            "model":"m","max_tokens":32,
            "tools":[
                {"name":exact_64,"input_schema":{"type":"object"}},
                {"name":long_a,"input_schema":{"type":"object"}},
                {"name":long_b,"input_schema":{"type":"object"}},
                {"name":long_128,"input_schema":{"type":"object"}},
                {"name":"Read","input_schema":{"type":"object"}},
                {"name":"read","input_schema":{"type":"object"}},
                {"name":"_foo","input_schema":{"type":"object"}},
                {"name":"-foo","input_schema":{"type":"object"}}
            ],
            "tool_choice":{"type":"tool","name":long_a},
            "messages":[
                {"role":"user","content":"start"},
                {"role":"assistant","content":[{
                    "type":"tool_use","id":"call_1","name":long_a,"input":{}
                }]},
                {"role":"user","content":[{
                    "type":"tool_result","tool_use_id":"call_1","content":"ok"
                }]}
            ]
        }))
        .unwrap();

        let names = prepare_chat_request_with_tool_names(&mut body);
        let wire_a = names.wire_name(&long_a);
        let wire_b = names.wire_name(&long_b);
        let wire_128 = names.wire_name(&long_128);

        assert_eq!(names.wire_name(&exact_64), exact_64);
        for legal in ["Read", "read", "_foo", "-foo"] {
            assert_eq!(names.wire_name(legal), legal);
        }
        for wire in [wire_a, wire_b, wire_128] {
            assert!(wire.len() <= 64);
        }
        assert_ne!(wire_a, wire_b);
        assert_eq!(body.pointer("/tools/1/function/name"), Some(&json!(wire_a)));
        assert_eq!(body.pointer("/tools/2/function/name"), Some(&json!(wire_b)));
        assert_eq!(
            body.pointer("/tool_choice/function/name"),
            Some(&json!(wire_a))
        );
        assert_eq!(
            body.pointer("/messages/1/tool_calls/0/function/name"),
            Some(&json!(wire_a))
        );
    }

    #[test]
    fn output_config_json_schema_maps_to_each_openai_protocol() {
        let request = json!({
            "model":"m","max_tokens":32,"messages":[{"role":"user","content":"json"}],
            "output_config":{"format":{
                "type":"json_schema",
                "schema":{
                    "type":"object",
                    "properties":{"answer":{"type":"string"}},
                    "required":["answer"],
                    "additionalProperties":false
                }
            }}
        });
        let unified = transform_anthropic_request(&request).unwrap();

        let mut chat = unified.clone();
        prepare_chat_request(&mut chat);
        assert_eq!(
            chat.pointer("/response_format"),
            Some(&json!({
                "type":"json_schema",
                "json_schema":{
                    "name":"anthropic_output",
                    "schema":{
                        "type":"object",
                        "properties":{"answer":{"type":"string"}},
                        "required":["answer"],
                        "additionalProperties":false
                    },
                    "strict":true
                }
            }))
        );

        let mut responses = unified;
        crate::transform::transform_responses_request(&mut responses).unwrap();
        assert!(responses.get("response_format").is_none());
        assert_eq!(
            responses.pointer("/text/format"),
            Some(&json!({
                "type":"json_schema",
                "name":"anthropic_output",
                "schema":{
                    "type":"object",
                    "properties":{"answer":{"type":"string"}},
                    "required":["answer"],
                    "additionalProperties":false
                },
                "strict":true
            }))
        );
    }

    #[test]
    fn mid_conversation_system_text_keeps_turn_order_for_both_protocols() {
        let request = json!({
            "model":"m","max_tokens":32,
            "messages":[
                {"role":"user","content":"before"},
                {"role":"system","content":[{"type":"mid_conv_system","content":[
                    {"type":"text","text":"temporary rule"}
                ]}]},
                {"role":"assistant","content":"ack"},
                {"role":"user","content":"after"}
            ]
        });
        let unified = transform_anthropic_request(&request).unwrap();

        let mut chat = unified.clone();
        prepare_chat_request(&mut chat);
        assert_eq!(
            chat["messages"]
                .as_array()
                .unwrap()
                .iter()
                .map(|message| message["role"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["user", "system", "assistant", "user"]
        );
        assert_eq!(
            chat.pointer("/messages/1/content"),
            Some(&json!([{"type":"text","text":"temporary rule"}]))
        );

        let mut responses = unified;
        crate::transform::transform_responses_request(&mut responses).unwrap();
        assert_eq!(
            responses["input"]
                .as_array()
                .unwrap()
                .iter()
                .map(|message| message["role"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["user", "system", "assistant", "user"]
        );
        assert_eq!(
            responses.pointer("/input/1/content"),
            Some(&json!([{"type":"input_text","text":"temporary rule"}]))
        );
    }

    #[test]
    fn documents_preserve_supported_bytes_and_bound_chat_url_degradation() {
        let request = json!({
            "model":"m","max_tokens":32,
            "messages":[{"role":"user","content":[
                {"type":"document","title":"base.pdf","source":{
                    "type":"base64","media_type":"application/pdf","data":"AA=="
                }},
                {"type":"document","title":"notes.txt","source":{
                    "type":"text","media_type":"text/plain","data":"hello"
                }},
                {"type":"document","title":"remote.pdf","source":{
                    "type":"url","url":"https://example.com/remote.pdf"
                }}
            ]}]
        });
        let unified = transform_anthropic_request(&request).unwrap();

        let mut chat = unified.clone();
        prepare_chat_request(&mut chat);
        assert_eq!(
            chat.pointer("/messages/0/content/0"),
            Some(&json!({"type":"file","file":{
                "filename":"base.pdf","file_data":"data:application/pdf;base64,AA=="
            }}))
        );
        assert_eq!(
            chat.pointer("/messages/0/content/1"),
            Some(&json!({"type":"file","file":{
                "filename":"notes.txt","file_data":"data:text/plain;base64,aGVsbG8="
            }}))
        );
        assert_eq!(
            chat.pointer("/messages/0/content/2"),
            Some(&json!({
                "type":"text",
                "text":"[document \"remote.pdf\": https://example.com/remote.pdf]"
            }))
        );

        let mut responses = unified;
        crate::transform::transform_responses_request(&mut responses).unwrap();
        assert_eq!(
            responses.pointer("/input/0/content"),
            Some(&json!([
                {"type":"input_file","filename":"base.pdf","file_data":"data:application/pdf;base64,AA=="},
                {"type":"input_file","filename":"notes.txt","file_data":"data:text/plain;base64,aGVsbG8="},
                {"type":"input_file","filename":"remote.pdf","file_url":"https://example.com/remote.pdf"}
            ]))
        );
    }

    #[test]
    fn multimodal_tool_result_uses_chat_sidecar_and_responses_typed_output() {
        let request = json!({
            "model":"m","max_tokens":32,
            "messages":[
                {"role":"user","content":"run"},
                {"role":"assistant","content":[{
                    "type":"tool_use","id":"call_1","name":"inspect","input":{}
                }]},
                {"role":"user","content":[{
                    "type":"tool_result","tool_use_id":"call_1","content":[
                        {"type":"text","text":"text result"},
                        {"type":"image","source":{
                            "type":"base64","media_type":"image/png","data":"AA=="
                        }},
                        {"type":"document","title":"result.pdf","source":{
                            "type":"base64","media_type":"application/pdf","data":"AQ=="
                        }}
                    ]
                }]}
            ]
        });
        let unified = transform_anthropic_request(&request).unwrap();

        let mut chat = unified.clone();
        prepare_chat_request(&mut chat);
        assert_eq!(chat.pointer("/messages/2/role"), Some(&json!("tool")));
        assert_eq!(
            chat.pointer("/messages/2/content"),
            Some(&json!("text result"))
        );
        assert_eq!(chat.pointer("/messages/3/role"), Some(&json!("user")));
        assert_eq!(
            chat.pointer("/messages/3/content"),
            Some(&json!([
                {"type":"image_url","image_url":{"url":"data:image/png;base64,AA=="}},
                {"type":"file","file":{
                    "filename":"result.pdf","file_data":"data:application/pdf;base64,AQ=="
                }}
            ]))
        );

        let mut responses = unified;
        crate::transform::transform_responses_request(&mut responses).unwrap();
        let output = responses["input"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["type"] == "function_call_output")
            .unwrap();
        assert_eq!(output["call_id"], "call_1");
        assert_eq!(
            output["output"],
            json!([
                {"type":"input_text","text":"text result"},
                {"type":"input_image","image_url":"data:image/png;base64,AA=="},
                {"type":"input_file","filename":"result.pdf","file_data":"data:application/pdf;base64,AQ=="}
            ])
        );
    }

    #[test]
    fn citations_and_server_tools_fail_locally_instead_of_silent_conversion() {
        let fixtures = [
            (
                json!({"model":"m","max_tokens":32,"messages":[{"role":"user","content":[{
                    "type":"text","text":"quoted","citations":[{"type":"char_location"}]
                }]}]}),
                "citations have no OpenAI protocol equivalent",
            ),
            (
                json!({"model":"m","max_tokens":32,"messages":[{"role":"user","content":[{
                    "type":"document","source":{"type":"text","data":"doc"},
                    "citations":{"enabled":true}
                }]}]}),
                "document and search_result citations have no OpenAI protocol equivalent",
            ),
            (
                json!({"model":"m","max_tokens":32,"messages":[],"tools":[{
                    "type":"web_search_20250305","name":"web_search"
                }]}),
                "Anthropic server-side tools have no OpenAI function-tool equivalent",
            ),
            (
                json!({"model":"m","max_tokens":32,"messages":[{"role":"assistant","content":[{
                    "type":"server_tool_use","id":"server_1","name":"web_search","input":{}
                }]}]}),
                "Anthropic server-tool history has no OpenAI function-tool equivalent",
            ),
        ];
        for (fixture, expected) in fixtures {
            let error = transform_anthropic_request(&fixture).unwrap_err();
            assert_eq!(error.status, axum::http::StatusCode::BAD_REQUEST);
            assert!(
                error.message.contains(expected),
                "expected {expected:?} in {:?}",
                error.message
            );
        }
    }

    #[test]
    fn adaptive_omitted_thinking_requests_encrypted_responses_state_without_summary() {
        let request = json!({
            "model":"m","max_tokens":32,"messages":[{"role":"user","content":"solve"}],
            "thinking":{"type":"adaptive","display":"omitted"},
            "output_config":{"effort":"high"}
        });
        let mut body = transform_anthropic_request(&request).unwrap();
        assert_eq!(
            body.pointer("/reasoning"),
            Some(&json!({"enabled":true,"effort":"high","display":"omitted"}))
        );

        crate::transform::transform_responses_request(&mut body).unwrap();
        assert_eq!(body.pointer("/reasoning"), Some(&json!({"effort":"high"})));
        assert_eq!(
            body.pointer("/include"),
            Some(&json!(["reasoning.encrypted_content"]))
        );
        assert!(body.pointer("/reasoning/summary").is_none());
    }
}
