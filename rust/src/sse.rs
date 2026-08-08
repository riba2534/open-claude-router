use std::collections::{BTreeMap, HashSet};

use bytes::Bytes;
use serde_json::{Value, json};

use crate::{error::ApiError, transform::protocol_error};

const MAX_EVENT_BYTES: usize = 1024 * 1024;

#[derive(Debug)]
pub struct ParsedSse {
    pub events: Vec<String>,
    pub saw_done: bool,
}

#[derive(Default)]
pub struct IncrementalSseDecoder {
    buffer: Vec<u8>,
    data_lines: Vec<String>,
    event_size: usize,
    done: bool,
}

pub struct DecodedSse {
    pub events: Vec<String>,
    pub saw_done: bool,
}

impl IncrementalSseDecoder {
    pub fn push(&mut self, chunk: &[u8]) -> Result<DecodedSse, ApiError> {
        if self.done {
            return Ok(DecodedSse {
                events: Vec::new(),
                saw_done: true,
            });
        }
        self.buffer.extend_from_slice(chunk);
        self.scan(false)
    }

    pub fn finish(&mut self) -> Result<DecodedSse, ApiError> {
        self.scan(true)
    }

    fn scan(&mut self, eof: bool) -> Result<DecodedSse, ApiError> {
        let mut output = Vec::new();
        while let Some(index) = self
            .buffer
            .iter()
            .position(|byte| *byte == b'\n' || *byte == b'\r')
        {
            if self.buffer[index] == b'\r' && index + 1 == self.buffer.len() && !eof {
                break;
            }
            let consume =
                if self.buffer[index] == b'\r' && self.buffer.get(index + 1) == Some(&b'\n') {
                    index + 2
                } else {
                    index + 1
                };
            let line = std::str::from_utf8(&self.buffer[..index])
                .map_err(|_| protocol_error("upstream SSE contains invalid UTF-8"))?
                .to_owned();
            self.buffer.drain(..consume);
            self.process_line(&line, &mut output)?;
            if self.done {
                self.buffer.clear();
                break;
            }
        }
        if eof && !self.done {
            if !self.buffer.is_empty() {
                let line = std::str::from_utf8(&self.buffer)
                    .map_err(|_| protocol_error("upstream SSE contains invalid UTF-8"))?
                    .to_owned();
                self.buffer.clear();
                self.process_line(&line, &mut output)?;
            }
            self.dispatch(&mut output);
        }
        Ok(DecodedSse {
            events: output,
            saw_done: self.done,
        })
    }

    fn process_line(&mut self, line: &str, output: &mut Vec<String>) -> Result<(), ApiError> {
        self.event_size = self.event_size.saturating_add(line.len() + 1);
        if self.event_size > MAX_EVENT_BYTES {
            return Err(protocol_error("upstream SSE event exceeds the 1 MiB bound"));
        }
        if line.is_empty() {
            self.dispatch(output);
            return Ok(());
        }
        if line.starts_with(':') {
            return Ok(());
        }
        let (field, value) = line
            .split_once(':')
            .map(|(field, value)| (field, value.strip_prefix(' ').unwrap_or(value)))
            .unwrap_or((line, ""));
        if field == "data" {
            self.data_lines.push(value.to_owned());
        }
        Ok(())
    }

    fn dispatch(&mut self, output: &mut Vec<String>) {
        if !self.data_lines.is_empty() {
            let data = self.data_lines.join("\n");
            if data.trim() == "[DONE]" {
                self.done = true;
            } else {
                output.push(data);
            }
        }
        self.data_lines.clear();
        self.event_size = 0;
    }
}

pub fn format_sse_event(event: &str, data: &Value) -> String {
    format!(
        "event: {event}\ndata: {}\n\n",
        serde_json::to_string(data).unwrap_or_else(|_| "{}".into())
    )
}

pub fn parse_sse_bytes(bytes: &[u8]) -> Result<ParsedSse, ApiError> {
    let text = std::str::from_utf8(bytes)
        .map_err(|_| protocol_error("upstream SSE contains invalid UTF-8"))?;
    let mut events = Vec::new();
    let mut data_lines = Vec::new();
    let mut event_size = 0usize;
    let mut saw_done = false;
    for line in split_sse_lines(text) {
        event_size = event_size.saturating_add(line.len() + 1);
        if event_size > MAX_EVENT_BYTES {
            return Err(protocol_error("upstream SSE event exceeds the 1 MiB bound"));
        }
        if line.is_empty() {
            if !data_lines.is_empty() {
                let data = data_lines.join("\n");
                if data.trim() == "[DONE]" {
                    saw_done = true;
                    break;
                }
                events.push(data);
            }
            data_lines.clear();
            event_size = 0;
            continue;
        }
        if line.starts_with(':') {
            continue;
        }
        let (field, value) = line
            .split_once(':')
            .map(|(field, value)| (field, value.strip_prefix(' ').unwrap_or(value)))
            .unwrap_or((line, ""));
        if field == "data" {
            data_lines.push(value);
        }
    }
    if !data_lines.is_empty() {
        let data = data_lines.join("\n");
        if data.trim() == "[DONE]" {
            saw_done = true;
        } else {
            events.push(data);
        }
    }
    Ok(ParsedSse { events, saw_done })
}

fn split_sse_lines(text: &str) -> Vec<&str> {
    let bytes = text.as_bytes();
    let mut lines = Vec::new();
    let mut start = 0;
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'\n' {
            let end = if index > start && bytes[index - 1] == b'\r' {
                index - 1
            } else {
                index
            };
            lines.push(&text[start..end]);
            start = index + 1;
        } else if bytes[index] == b'\r' {
            lines.push(&text[start..index]);
            if bytes.get(index + 1) == Some(&b'\n') {
                index += 1;
            }
            start = index + 1;
        }
        index += 1;
    }
    if start < text.len() {
        lines.push(&text[start..]);
    }
    lines
}

pub fn aggregate_chat_sse(bytes: Bytes) -> Result<Value, ApiError> {
    let parsed = parse_sse_bytes(&bytes)?;
    let mut id = None;
    let mut model = None;
    let mut service_tier = None;
    let mut content = String::new();
    let mut reasoning = String::new();
    let mut refusal = String::new();
    let mut finish_reason = None;
    let mut usage = None;
    let mut tool_calls: BTreeMap<u64, Value> = BTreeMap::new();
    let mut legacy_function = json!({"name":"","arguments":""});
    let mut has_legacy_function = false;
    for raw in parsed.events {
        let event: Value = serde_json::from_str(&raw)
            .map_err(|_| protocol_error("upstream Chat SSE contains malformed JSON"))?;
        if let Some(error) = event.get("error") {
            return Ok(json!({"error":error,"request_id":event.get("request_id").cloned()}));
        }
        if id.is_none() {
            id = event.get("id").cloned();
        }
        if model.is_none() {
            model = event.get("model").cloned();
        }
        if service_tier.is_none() {
            service_tier = event.get("service_tier").cloned();
        }
        if event.get("usage").is_some_and(|value| !value.is_null()) {
            usage = event.get("usage").cloned();
        }
        let Some(choice) = event
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|choices| choices.first())
        else {
            continue;
        };
        if choice
            .get("finish_reason")
            .is_some_and(|value| !value.is_null())
        {
            finish_reason = choice.get("finish_reason").cloned();
        }
        let delta = choice.get("delta").unwrap_or(&Value::Null);
        match delta.get("content") {
            Some(Value::String(text)) => {
                content.push_str(text.as_str());
            }
            Some(Value::Array(parts)) => {
                for part in parts {
                    let text = part.get("text").and_then(Value::as_str).unwrap_or_else(|| {
                        if part.get("type").and_then(Value::as_str) == Some("image_url") {
                            "[generated image omitted]"
                        } else {
                            ""
                        }
                    });
                    content.push_str(text);
                }
            }
            _ => {}
        }
        if let Some(text) = delta.get("reasoning_content").and_then(Value::as_str) {
            reasoning.push_str(text);
        }
        if let Some(text) = delta.get("refusal").and_then(Value::as_str) {
            refusal.push_str(text);
        }
        if let Some(calls) = delta.get("tool_calls").and_then(Value::as_array) {
            for call in calls {
                let index = call.get("index").and_then(Value::as_u64).unwrap_or(0);
                let current = tool_calls.entry(index).or_insert_with(|| {
                    json!({
                        "id":"","type":"function","function":{"name":"","arguments":""}
                    })
                });
                append_json_string(current, "/id", call.get("id").and_then(Value::as_str));
                append_json_string(
                    current,
                    "/function/name",
                    call.pointer("/function/name").and_then(Value::as_str),
                );
                append_json_string(
                    current,
                    "/function/arguments",
                    call.pointer("/function/arguments").and_then(Value::as_str),
                );
            }
        }
        if let Some(function) = delta.get("function_call") {
            has_legacy_function = true;
            append_json_string(
                &mut legacy_function,
                "/name",
                function.get("name").and_then(Value::as_str),
            );
            append_json_string(
                &mut legacy_function,
                "/arguments",
                function.get("arguments").and_then(Value::as_str),
            );
        }
    }
    if finish_reason.is_none() {
        if parsed.saw_done {
            finish_reason = Some(if tool_calls.is_empty() && !has_legacy_function {
                Value::String("stop".into())
            } else {
                Value::String("length".into())
            });
        } else {
            return Err(protocol_error(
                "upstream stream ended before a terminal event",
            ));
        }
    }
    let mut message = json!({
        "role":"assistant",
        "content":if content.is_empty() { Value::Null } else { Value::String(content) },
        "reasoning_content":if reasoning.is_empty() { Value::Null } else { Value::String(reasoning) },
        "refusal":if refusal.is_empty() { Value::Null } else { Value::String(refusal) },
    });
    if !tool_calls.is_empty() {
        message["tool_calls"] = Value::Array(tool_calls.into_values().collect());
    }
    if has_legacy_function {
        message["function_call"] = legacy_function;
    }
    strip_nulls(&mut message);
    let mut result = json!({
        "id":id.unwrap_or_else(|| Value::String(format!("chatcmpl_{}",uuid::Uuid::new_v4()))),
        "object":"chat.completion",
        "model":model.unwrap_or_else(|| Value::String("unknown".into())),
        "service_tier":service_tier,
        "choices":[{"index":0,"message":message,"finish_reason":finish_reason}],
        "usage":usage
    });
    strip_nulls(&mut result);
    Ok(result)
}

pub struct ResponsesSseAggregator {
    terminal: Option<Value>,
    response_meta: Value,
    items: BTreeMap<u64, Value>,
    item_ids: std::collections::HashMap<String, u64>,
    finalized_message_parts: HashSet<(u64, u64, String)>,
    finalized_reasoning_parts: HashSet<(u64, u64, String)>,
    saw_terminal: bool,
}

impl Default for ResponsesSseAggregator {
    fn default() -> Self {
        Self {
            terminal: None,
            response_meta: json!({}),
            items: BTreeMap::new(),
            item_ids: std::collections::HashMap::new(),
            finalized_message_parts: HashSet::new(),
            finalized_reasoning_parts: HashSet::new(),
            saw_terminal: false,
        }
    }
}

impl ResponsesSseAggregator {
    pub fn push_raw(&mut self, raw: &str) -> Result<(), ApiError> {
        let event: Value = serde_json::from_str(raw)
            .map_err(|_| protocol_error("upstream Responses SSE contains malformed JSON"))?;
        let kind = event
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        match kind {
            "response.created" | "response.in_progress" => {
                if let Some(response) = event.get("response") {
                    merge_response_meta(&mut self.response_meta, response);
                }
            }
            "response.output_item.added" | "response.output_item.done" => {
                let index = event
                    .get("output_index")
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                if let Some(item) = event.get("item") {
                    let slot = self.items.entry(index).or_insert_with(|| item.clone());
                    merge_item(slot, item);
                    register_message_snapshots(&mut self.finalized_message_parts, index, item);
                    register_reasoning_snapshots(&mut self.finalized_reasoning_parts, index, item);
                    if let Some(id) = item.get("id").and_then(Value::as_str) {
                        self.item_ids.insert(id.to_owned(), index);
                    }
                }
            }
            "response.output_text.delta" | "response.output_text.done" => {
                let index = event_index(&event, &self.item_ids);
                let content_index = event
                    .get("content_index")
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                let key = (index, content_index, "output_text".to_owned());
                if kind.ends_with(".delta") && self.finalized_message_parts.contains(&key) {
                    return Ok(());
                }
                let item = self.items.entry(index).or_insert_with(|| json!({
                    "type":"message","id":event.get("item_id").cloned(),"status":"completed","role":"assistant","content":[]
                }));
                append_message_part(
                    item,
                    content_index,
                    "output_text",
                    event
                        .get(if kind.ends_with(".delta") {
                            "delta"
                        } else {
                            "text"
                        })
                        .and_then(Value::as_str),
                    kind.ends_with(".done"),
                )?;
                if kind.ends_with(".done") {
                    self.finalized_message_parts.insert(key);
                }
            }
            "response.refusal.delta" | "response.refusal.done" => {
                let index = event_index(&event, &self.item_ids);
                let content_index = event
                    .get("content_index")
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                let key = (index, content_index, "refusal".to_owned());
                if kind.ends_with(".delta") && self.finalized_message_parts.contains(&key) {
                    return Ok(());
                }
                let item = self.items.entry(index).or_insert_with(|| json!({"type":"message","status":"completed","role":"assistant","content":[]}));
                append_message_part(
                    item,
                    content_index,
                    "refusal",
                    event
                        .get(if kind.ends_with(".delta") {
                            "delta"
                        } else {
                            "refusal"
                        })
                        .and_then(Value::as_str),
                    kind.ends_with(".done"),
                )?;
                if kind.ends_with(".done") {
                    self.finalized_message_parts.insert(key);
                }
            }
            "response.function_call_arguments.delta" | "response.function_call_arguments.done" => {
                let index = event_index(&event, &self.item_ids);
                let item = self.items.entry(index).or_insert_with(|| json!({
                    "type":"function_call","id":event.get("item_id").cloned(),"call_id":event.get("call_id").cloned(),"name":event.get("name").cloned(),"arguments":""
                }));
                let field = if kind.ends_with(".delta") {
                    "delta"
                } else {
                    "arguments"
                };
                append_snapshot_or_delta(
                    item,
                    "arguments",
                    event.get(field).and_then(Value::as_str),
                    kind.ends_with(".done"),
                )?;
            }
            "response.reasoning_text.delta"
            | "response.reasoning_text.done"
            | "response.reasoning_summary_text.delta"
            | "response.reasoning_summary_text.done" => {
                let index = event_index(&event, &self.item_ids);
                let is_summary = kind.contains("summary");
                let part_index = event
                    .get("summary_index")
                    .or_else(|| event.get("content_index"))
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                let part_key = (
                    index,
                    part_index,
                    if is_summary { "summary" } else { "content" }.to_owned(),
                );
                if kind.ends_with(".delta") && self.finalized_reasoning_parts.contains(&part_key) {
                    return Ok(());
                }
                let item = self.items.entry(index).or_insert_with(|| json!({
                    "type":"reasoning","id":event.get("item_id").cloned(),"summary":[],"content":[]
                }));
                let key = if is_summary { "summary" } else { "content" };
                let part_type = if is_summary {
                    "summary_text"
                } else {
                    "reasoning_text"
                };
                append_array_text_part(
                    item,
                    key,
                    part_index,
                    part_type,
                    event
                        .get(if kind.ends_with(".delta") {
                            "delta"
                        } else {
                            "text"
                        })
                        .and_then(Value::as_str),
                    kind.ends_with(".done"),
                )?;
                if kind.ends_with(".done") {
                    self.finalized_reasoning_parts.insert(part_key);
                }
            }
            "response.completed" | "response.incomplete" => {
                let response = event
                    .get("response")
                    .filter(|response| response.is_object())
                    .ok_or_else(|| {
                        protocol_error("upstream Responses terminal event is missing response")
                    })?;
                let expected = if kind == "response.completed" {
                    "completed"
                } else {
                    "incomplete"
                };
                if response
                    .get("status")
                    .and_then(Value::as_str)
                    .is_some_and(|status| status != expected)
                {
                    return Err(protocol_error(
                        "upstream Responses terminal event/status mismatch",
                    ));
                }
                self.saw_terminal = true;
                self.terminal = Some(response.clone());
            }
            "response.failed" | "response.cancelled" => {
                self.saw_terminal = true;
                self.terminal = Some(event.get("response").cloned().unwrap_or_else(|| {
                    json!({
                        "status":if kind == "response.cancelled" { "cancelled" } else { "failed" },
                        "error":event.get("error").cloned(),
                        "output":[]
                    })
                }));
            }
            "error" => {
                let error = event.get("error").cloned().unwrap_or(event.clone());
                self.saw_terminal = true;
                self.terminal = Some(json!({"status":"failed","error":error,"output":[]}));
            }
            _ => {}
        }
        Ok(())
    }

    pub fn finish(self) -> Result<Value, ApiError> {
        if !self.saw_terminal {
            return Err(protocol_error(
                "upstream Responses stream ended without a terminal response event",
            ));
        }
        let stream_model = self
            .response_meta
            .get("model")
            .cloned()
            .unwrap_or_else(|| Value::String("unknown".into()));
        let mut response = self.terminal.unwrap_or(self.response_meta);
        response["model"] = stream_model;
        validate_terminal_functions(
            &self.items,
            response
                .get("output")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or(&[]),
        )?;
        let terminal_output_empty = response
            .get("output")
            .and_then(Value::as_array)
            .is_none_or(Vec::is_empty);
        if terminal_output_empty {
            response["output"] = Value::Array(self.items.into_values().collect());
        }
        if response.get("status").is_none() {
            response["status"] = Value::String("completed".into());
        }
        response["__ocr_stream_aggregated"] = Value::Bool(true);
        Ok(response)
    }
}

fn validate_terminal_functions(
    streamed: &BTreeMap<u64, Value>,
    terminal: &[Value],
) -> Result<(), ApiError> {
    for (index, item) in streamed {
        let Some(expected) = function_identity(item) else {
            continue;
        };
        let Some(actual_item) = terminal.get(*index as usize) else {
            return Err(protocol_error(
                "upstream Responses terminal output omitted a function call",
            ));
        };
        if actual_item.get("type").and_then(Value::as_str) != Some("function_call") {
            return Err(protocol_error(
                "upstream Responses terminal output omitted a function call",
            ));
        }
        let bare_compatibility_skeleton = actual_item.get("id").is_none()
            && actual_item.get("call_id").is_none()
            && actual_item.get("name").is_none()
            && actual_item.get("arguments").is_none()
            && actual_item.get("status").is_none();
        if bare_compatibility_skeleton {
            continue;
        }
        if function_identity(actual_item).as_ref() != Some(&expected) {
            return Err(protocol_error(
                "upstream Responses terminal function identity mismatch",
            ));
        }
    }
    Ok(())
}

fn function_identity(item: &Value) -> Option<(String, String, String)> {
    if item.get("type").and_then(Value::as_str) != Some("function_call") {
        return None;
    }
    let item_id = item
        .get("id")
        .or_else(|| item.get("call_id"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())?;
    let call_id = item
        .get("call_id")
        .or_else(|| item.get("id"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())?;
    let name = item
        .get("name")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())?;
    Some((item_id.to_owned(), call_id.to_owned(), name.to_owned()))
}

pub fn aggregate_responses_sse(bytes: Bytes) -> Result<Value, ApiError> {
    let parsed = parse_sse_bytes(&bytes)?;
    let mut aggregator = ResponsesSseAggregator::default();
    for raw in parsed.events {
        aggregator.push_raw(&raw)?;
    }
    aggregator.finish()
}

fn event_index(event: &Value, ids: &std::collections::HashMap<String, u64>) -> u64 {
    event
        .get("output_index")
        .and_then(Value::as_u64)
        .or_else(|| {
            event
                .get("item_id")
                .and_then(Value::as_str)
                .and_then(|id| ids.get(id).copied())
        })
        .unwrap_or(0)
}

fn append_json_string(target: &mut Value, pointer: &str, value: Option<&str>) {
    let Some(value) = value else { return };
    if let Some(slot) = target.pointer_mut(pointer) {
        let mut current = slot.as_str().unwrap_or_default().to_owned();
        current.push_str(value);
        *slot = Value::String(current);
    }
}

fn strip_nulls(value: &mut Value) {
    if let Some(object) = value.as_object_mut() {
        object.retain(|_, value| !value.is_null());
    }
}

fn merge_response_meta(target: &mut Value, source: &Value) {
    let Some(target) = target.as_object_mut() else {
        return;
    };
    let Some(source) = source.as_object() else {
        return;
    };
    for (key, value) in source {
        if key != "output" && !value.is_null() {
            target.insert(key.clone(), value.clone());
        }
    }
}

fn merge_item(target: &mut Value, source: &Value) {
    let Some(target) = target.as_object_mut() else {
        return;
    };
    let Some(source) = source.as_object() else {
        return;
    };
    for (key, value) in source {
        if !value.is_null() && !(value.is_string() && value.as_str() == Some("")) {
            target.insert(key.clone(), value.clone());
        }
    }
}

fn register_message_snapshots(
    finalized: &mut HashSet<(u64, u64, String)>,
    output_index: u64,
    item: &Value,
) {
    if item.get("type").and_then(Value::as_str) != Some("message") {
        return;
    }
    for (content_index, part) in item
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .enumerate()
    {
        let (kind, text) = match part.get("type").and_then(Value::as_str) {
            Some("output_text") => ("output_text", part.get("text").and_then(Value::as_str)),
            Some("refusal") => ("refusal", part.get("refusal").and_then(Value::as_str)),
            _ => continue,
        };
        if text.is_some_and(|text| !text.is_empty()) {
            finalized.insert((output_index, content_index as u64, kind.to_owned()));
        }
    }
}

fn register_reasoning_snapshots(
    finalized: &mut HashSet<(u64, u64, String)>,
    output_index: u64,
    item: &Value,
) {
    if item.get("type").and_then(Value::as_str) != Some("reasoning") {
        return;
    }
    for (field, part_type) in [("summary", "summary"), ("content", "content")] {
        for (part_index, part) in item
            .get(field)
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .enumerate()
        {
            if part
                .get("text")
                .and_then(Value::as_str)
                .is_some_and(|text| !text.is_empty())
            {
                finalized.insert((output_index, part_index as u64, part_type.to_owned()));
            }
        }
    }
}

fn append_message_part(
    item: &mut Value,
    index: u64,
    kind: &str,
    text: Option<&str>,
    done: bool,
) -> Result<(), ApiError> {
    let key = if kind == "refusal" { "refusal" } else { "text" };
    if item.get("content").and_then(Value::as_array).is_none() {
        item["content"] = json!([]);
    }
    let parts = item["content"].as_array_mut().unwrap();
    while parts.len() <= index as usize {
        parts.push(json!({"type":kind,key:""}));
    }
    let part = &mut parts[index as usize];
    let existing = part
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let incoming = text.unwrap_or_default();
    let next = if done {
        if incoming.starts_with(&existing) {
            incoming.to_owned()
        } else {
            return Err(protocol_error(format!(
                "upstream Responses {} is inconsistent",
                if kind == "refusal" {
                    "refusal"
                } else {
                    "output text"
                }
            )));
        }
    } else {
        format!("{existing}{incoming}")
    };
    part[key] = Value::String(next);
    Ok(())
}

fn append_snapshot_or_delta(
    item: &mut Value,
    key: &str,
    text: Option<&str>,
    done: bool,
) -> Result<(), ApiError> {
    let existing = item.get(key).and_then(Value::as_str).unwrap_or_default();
    let incoming = text.unwrap_or_default();
    let next = if done {
        if incoming.starts_with(existing) {
            incoming.to_owned()
        } else {
            return Err(protocol_error(
                "upstream Responses function arguments are inconsistent",
            ));
        }
    } else {
        format!("{existing}{incoming}")
    };
    item[key] = Value::String(next);
    Ok(())
}

fn append_array_text_part(
    item: &mut Value,
    key: &str,
    index: u64,
    kind: &str,
    text: Option<&str>,
    done: bool,
) -> Result<(), ApiError> {
    if item.get(key).and_then(Value::as_array).is_none() {
        item[key] = json!([]);
    }
    let parts = item[key].as_array_mut().unwrap();
    while parts.len() <= index as usize {
        parts.push(json!({"type":kind,"text":""}));
    }
    let part = &mut parts[index as usize];
    let existing = part.get("text").and_then(Value::as_str).unwrap_or_default();
    let incoming = text.unwrap_or_default();
    let next = if done {
        if incoming.starts_with(existing) {
            incoming.to_owned()
        } else {
            return Err(protocol_error(format!(
                "upstream Responses {} is inconsistent",
                if kind == "reasoning_text" {
                    "reasoning text"
                } else {
                    "reasoning summary"
                }
            )));
        }
    } else {
        format!("{existing}{incoming}")
    };
    part["text"] = Value::String(next);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decoder_joins_data_fields_and_stops_at_done() {
        let parsed =
            parse_sse_bytes(b"data: {\"a\":\ndata: 1}\r\n\r\ndata: [DONE]\n\ndata: ignored\n\n")
                .unwrap();
        assert_eq!(parsed.events, vec!["{\"a\":\n1}"]);
        assert!(parsed.saw_done);
    }

    #[test]
    fn chat_aggregate_keeps_usage_after_finish() {
        let bytes = Bytes::from_static(b"data: {\"id\":\"c\",\"model\":\"m\",\"choices\":[{\"delta\":{\"content\":\"hi\"},\"finish_reason\":\"stop\"}]}\n\ndata: {\"choices\":[],\"usage\":{\"prompt_tokens\":2,\"completion_tokens\":1}}\n\ndata: [DONE]\n\n");
        let result = aggregate_chat_sse(bytes).unwrap();
        assert_eq!(result.pointer("/usage/prompt_tokens"), Some(&json!(2)));
    }
}
