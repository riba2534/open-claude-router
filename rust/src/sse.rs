use std::collections::{BTreeMap, HashSet};

use bytes::Bytes;
use serde_json::{Value, json};

use crate::{error::ApiError, transform::protocol_error};

const MAX_EVENT_BYTES: usize = 16 * 1024 * 1024;
const MAX_EVENT_LINES: usize = 65_536;

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
    event_lines: usize,
    done: bool,
}

#[derive(Debug)]
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
        self.ensure_pending_event_is_bounded()?;
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

    fn ensure_pending_event_is_bounded(&self) -> Result<(), ApiError> {
        if self.event_size.saturating_add(self.buffer.len()) > MAX_EVENT_BYTES {
            return Err(protocol_error(
                "upstream SSE event exceeds the 16 MiB bound",
            ));
        }
        Ok(())
    }

    fn process_line(&mut self, line: &str, output: &mut Vec<String>) -> Result<(), ApiError> {
        self.event_size = self.event_size.saturating_add(line.len() + 1);
        if !line.is_empty() {
            self.event_lines = self.event_lines.saturating_add(1);
        }
        if self.event_size > MAX_EVENT_BYTES || self.event_lines > MAX_EVENT_LINES {
            return Err(protocol_error(
                "upstream SSE event exceeds the 16 MiB or 65536-line bound",
            ));
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
        self.event_lines = 0;
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
    let mut event_lines = 0usize;
    let mut saw_done = false;
    for line in split_sse_lines(text) {
        event_size = event_size.saturating_add(line.len() + 1);
        if !line.is_empty() {
            event_lines = event_lines.saturating_add(1);
        }
        if event_size > MAX_EVENT_BYTES || event_lines > MAX_EVENT_LINES {
            return Err(protocol_error(
                "upstream SSE event exceeds the 16 MiB or 65536-line bound",
            ));
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
            event_lines = 0;
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
    let mut output_blocks = Vec::new();
    let mut legacy_function = json!({"name":"","arguments":""});
    let mut has_legacy_function = false;
    let mut saw_terminal = false;
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
        if saw_terminal {
            continue;
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
        let thinking_delta = delta
            .get("reasoning_content")
            .or_else(|| delta.pointer("/thinking/content"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !thinking_delta.is_empty() {
            append_aggregate_block_text(&mut output_blocks, "thinking", "thinking", thinking_delta);
        }
        if let Some(signature) = delta
            .get("signature")
            .or_else(|| delta.pointer("/thinking/signature"))
            .and_then(Value::as_str)
        {
            if let Some(block) = output_blocks
                .iter_mut()
                .rev()
                .find(|block| block.get("type").and_then(Value::as_str) == Some("thinking"))
            {
                block["signature"] = Value::String(signature.to_owned());
            } else {
                output_blocks.push(json!({
                    "type":"thinking","thinking":"","signature":signature
                }));
            }
        }
        match delta.get("content") {
            Some(Value::String(text)) => {
                content.push_str(text.as_str());
                append_aggregate_block_text(&mut output_blocks, "text", "text", text);
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
                        _ => bounded_sse_json(part),
                    };
                    content.push_str(&text);
                    append_aggregate_block_text(&mut output_blocks, "text", "text", &text);
                }
            }
            _ => {}
        }
        reasoning.push_str(thinking_delta);
        if let Some(text) = delta.get("refusal").and_then(Value::as_str) {
            refusal.push_str(text);
            append_aggregate_block_text(&mut output_blocks, "text", "text", text);
        }
        if let Some(annotations) = delta.get("annotations").and_then(Value::as_array) {
            let citations = annotations
                .iter()
                .filter(|annotation| {
                    annotation.get("type").and_then(Value::as_str) == Some("url_citation")
                        && annotation
                            .pointer("/url_citation/url")
                            .and_then(Value::as_str)
                            .is_some_and(|url| !url.is_empty())
                })
                .cloned()
                .collect::<Vec<_>>();
            if !citations.is_empty() {
                append_aggregate_block_text(
                    &mut output_blocks,
                    "text",
                    "text",
                    &bounded_sse_json(&json!({
                        "type":"openai_url_citations","annotations":citations
                    })),
                );
            }
        }
        if let Some(block) = delta
            .get("response_output_block")
            .filter(|block| block.is_object())
        {
            append_aggregate_block_text(
                &mut output_blocks,
                "text",
                "text",
                &bounded_sse_json(block),
            );
        }
        if let Some(calls) = delta.get("tool_calls").and_then(Value::as_array) {
            for call in calls {
                let index = call.get("index").and_then(Value::as_u64).unwrap_or(0);
                if !tool_calls.contains_key(&index) {
                    output_blocks.push(json!({"type":"__tool_call","index":index}));
                }
                let current = tool_calls.entry(index).or_insert_with(|| {
                    json!({
                        "id":"","type":"function","function":{"name":"","arguments":""}
                    })
                });
                set_json_string(current, "/id", call.get("id").and_then(Value::as_str));
                set_json_string(
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
        saw_terminal = choice
            .get("finish_reason")
            .is_some_and(|value| !value.is_null());
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
    for block in &mut output_blocks {
        if block.get("type").and_then(Value::as_str) != Some("__tool_call") {
            continue;
        }
        let index = block.get("index").and_then(Value::as_u64).unwrap_or(0);
        let call = tool_calls.get(&index).cloned().unwrap_or_else(|| json!({}));
        *block = json!({
            "type":"tool_use",
            "id":call.get("id").cloned().unwrap_or(Value::String(String::new())),
            "name":call.pointer("/function/name").cloned().unwrap_or(Value::String(String::new())),
            "input":call.pointer("/function/arguments").cloned().unwrap_or(Value::String("{}".into()))
        });
    }
    if !output_blocks.is_empty() {
        message["output_blocks"] = Value::Array(output_blocks);
    }
    if !tool_calls.is_empty() {
        message["tool_calls"] = Value::Array(tool_calls.values().cloned().collect());
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
    emitted_audio_omission: bool,
    audio_omission_index: Option<u64>,
    audio_transcripts: std::collections::HashMap<u64, String>,
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
            emitted_audio_omission: false,
            audio_omission_index: None,
            audio_transcripts: std::collections::HashMap::new(),
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
        if self.saw_terminal {
            return Ok(());
        }
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
            "response.audio.transcript.delta" | "response.output_audio_transcript.delta" => {
                let index = event_index(&event, &self.item_ids);
                if let Some(delta) = event.get("delta").and_then(Value::as_str) {
                    self.audio_transcripts
                        .entry(index)
                        .or_default()
                        .push_str(delta);
                }
                let content_index = event
                    .get("content_index")
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                let item = self.items.entry(index).or_insert_with(|| {
                    json!({"type":"message","status":"completed","role":"assistant","content":[]})
                });
                append_message_part(
                    item,
                    content_index,
                    "output_text",
                    event.get("delta").and_then(Value::as_str),
                    false,
                )?;
            }
            "response.audio.delta" | "response.output_audio.delta" => {
                if !self.emitted_audio_omission {
                    self.emitted_audio_omission = true;
                    let index = event_index(&event, &self.item_ids);
                    self.audio_omission_index = Some(index);
                    let content_index = event
                        .get("content_index")
                        .and_then(Value::as_u64)
                        .unwrap_or(0);
                    let item = self.items.entry(index).or_insert_with(|| {
                        json!({"type":"message","status":"completed","role":"assistant","content":[]})
                    });
                    append_message_part(
                        item,
                        content_index,
                        "output_text",
                        Some("[generated audio omitted]"),
                        false,
                    )?;
                }
            }
            "response.audio.transcript.done"
            | "response.audio.done"
            | "response.output_audio_transcript.done"
            | "response.output_audio.done" => {}
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
                if response.get("status").and_then(Value::as_str) != Some(expected) {
                    return Err(protocol_error(
                        "upstream Responses terminal event/status mismatch",
                    ));
                }
                self.saw_terminal = true;
                self.terminal = Some(response.clone());
            }
            "response.failed" | "response.cancelled" => {
                self.saw_terminal = true;
                let mut response = event.get("response").cloned().unwrap_or_else(|| {
                    json!({
                        "status":if kind == "response.cancelled" { "cancelled" } else { "failed" },
                        "error":event.get("error").cloned(),
                        "output":[]
                    })
                });
                if response.get("status").is_none_or(Value::is_null) {
                    response["status"] = Value::String(
                        if kind == "response.cancelled" {
                            "cancelled"
                        } else {
                            "failed"
                        }
                        .into(),
                    );
                }
                self.terminal = Some(response);
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

    pub fn finish(mut self) -> Result<Value, ApiError> {
        if !self.saw_terminal {
            return Err(protocol_error(
                "upstream Responses stream ended without a terminal response event",
            ));
        }
        let response_meta_model = self.response_meta.get("model").cloned();
        let mut response = self.terminal.unwrap_or(self.response_meta);
        let stream_model = response_meta_model
            .or_else(|| response.get("model").cloned())
            .unwrap_or_else(|| Value::String("unknown".into()));
        response["model"] = stream_model;
        merge_streamed_audio_semantics(
            &mut response,
            &mut self.items,
            self.audio_omission_index,
            &self.audio_transcripts,
        );
        for item in self.items.values_mut() {
            normalize_stream_part_indices(item);
        }
        if let Some(output) = response.get_mut("output").and_then(Value::as_array_mut) {
            for item in output {
                normalize_stream_part_indices(item);
            }
        }
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
        response["__ocr_stream_aggregated"] = Value::Bool(true);
        Ok(response)
    }
}

fn merge_streamed_audio_semantics(
    response: &mut Value,
    streamed: &mut BTreeMap<u64, Value>,
    omission_index: Option<u64>,
    transcripts: &std::collections::HashMap<u64, String>,
) {
    let Some(output) = response.get_mut("output").and_then(Value::as_array_mut) else {
        return;
    };
    let mut omission_seen = omission_index.is_some();
    for (index, terminal_item) in output.iter_mut().enumerate() {
        let terminal_audio = terminal_item
            .get("content")
            .and_then(Value::as_array)
            .filter(|parts| {
                !parts.is_empty()
                    && parts.iter().all(|part| {
                        part.get("type").and_then(Value::as_str) == Some("output_audio")
                    })
            });
        let Some(audio_parts) = terminal_audio else {
            continue;
        };
        let terminal_transcript = audio_parts
            .iter()
            .filter_map(|part| part.get("transcript").and_then(Value::as_str))
            .collect::<String>();
        let index = index as u64;
        let streamed_transcript = transcripts.get(&index).map(String::as_str).unwrap_or("");
        let item = streamed.entry(index).or_insert_with(
            || json!({"type":"message","status":"completed","role":"assistant","content":[]}),
        );
        if !omission_seen {
            omission_seen = true;
            append_message_part(
                item,
                0,
                "output_text",
                Some("[generated audio omitted]"),
                false,
            )
            .expect("audio fallback append is infallible");
        }
        let transcript_suffix = terminal_transcript
            .strip_prefix(streamed_transcript)
            .unwrap_or("");
        if !transcript_suffix.is_empty() {
            append_message_part(item, 0, "output_text", Some(transcript_suffix), false)
                .expect("audio transcript append is infallible");
        }
        *terminal_item = item.clone();
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

fn set_json_string(target: &mut Value, pointer: &str, value: Option<&str>) {
    let Some(value) = value else { return };
    if let Some(slot) = target.pointer_mut(pointer) {
        *slot = Value::String(value.to_owned());
    }
}

fn append_aggregate_block_text(blocks: &mut Vec<Value>, block_type: &str, field: &str, text: &str) {
    if text.is_empty() {
        return;
    }
    if let Some(previous) = blocks.last_mut()
        && previous.get("type").and_then(Value::as_str) == Some(block_type)
    {
        let mut combined = previous
            .get(field)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        combined.push_str(text);
        previous[field] = Value::String(combined);
    } else {
        blocks.push(json!({"type":block_type,field:text}));
    }
}

fn bounded_sse_json(value: &Value) -> String {
    let serialized = serde_json::to_string(value).unwrap_or_default();
    let length = serialized.chars().count();
    if length <= 4096 {
        serialized
    } else {
        format!("[unsupported upstream content omitted: {length} chars]")
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
    let position = parts
        .iter()
        .position(|part| part.get("__ocr_stream_part_index").and_then(Value::as_u64) == Some(index))
        .or_else(|| {
            usize::try_from(index)
                .ok()
                .filter(|position| *position < parts.len())
                .filter(|position| parts[*position].get("__ocr_stream_part_index").is_none())
        })
        .unwrap_or_else(|| {
            parts.push(json!({
                "type":kind,
                key:"",
                "__ocr_stream_part_index":index
            }));
            parts.len() - 1
        });
    let part = &mut parts[position];
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
    let position = parts
        .iter()
        .position(|part| part.get("__ocr_stream_part_index").and_then(Value::as_u64) == Some(index))
        .or_else(|| {
            usize::try_from(index)
                .ok()
                .filter(|position| *position < parts.len())
                .filter(|position| parts[*position].get("__ocr_stream_part_index").is_none())
        })
        .unwrap_or_else(|| {
            parts.push(json!({
                "type":kind,
                "text":"",
                "__ocr_stream_part_index":index
            }));
            parts.len() - 1
        });
    let part = &mut parts[position];
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

fn normalize_stream_part_indices(item: &mut Value) {
    for key in ["content", "summary"] {
        let Some(parts) = item.get_mut(key).and_then(Value::as_array_mut) else {
            continue;
        };
        let mut indexed = parts
            .drain(..)
            .enumerate()
            .map(|(position, part)| {
                let index = part
                    .get("__ocr_stream_part_index")
                    .and_then(Value::as_u64)
                    .unwrap_or(position as u64);
                (index, position, part)
            })
            .collect::<Vec<_>>();
        indexed.sort_by_key(|(index, position, _)| (*index, *position));
        parts.extend(indexed.into_iter().map(|(_, _, mut part)| {
            if let Some(object) = part.as_object_mut() {
                object.remove("__ocr_stream_part_index");
            }
            part
        }));
    }
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

    #[test]
    fn decoder_accepts_events_up_to_sixteen_mib() {
        let payload = "x".repeat(1024 * 1024 + 1);
        let input = format!("data: {payload}\n\n");
        let parsed = parse_sse_bytes(input.as_bytes()).unwrap();
        assert_eq!(parsed.events, vec![payload]);
    }

    #[test]
    fn incremental_decoder_rejects_chunked_unterminated_line_over_bound() {
        let mut decoder = IncrementalSseDecoder::default();
        let chunk = vec![b'x'; 1024 * 1024];
        for _ in 0..16 {
            let decoded = decoder.push(&chunk).unwrap();
            assert!(decoded.events.is_empty());
        }

        let error = decoder.push(b"x").unwrap_err();
        assert_eq!(error.message, "upstream SSE event exceeds the 16 MiB bound");

        let mut decoder = IncrementalSseDecoder {
            event_size: MAX_EVENT_BYTES - 1,
            ..Default::default()
        };
        assert!(decoder.push(b"x").is_ok());
        assert_eq!(
            decoder.push(b"x").unwrap_err().message,
            "upstream SSE event exceeds the 16 MiB bound"
        );
    }

    #[test]
    fn incremental_decoder_accepts_exact_bound_crlf_and_multiple_events() {
        let payload = "x".repeat(MAX_EVENT_BYTES - "data: ".len() - 2);
        let exact_event = format!("data: {payload}\r\n\r\n");
        let mut decoder = IncrementalSseDecoder::default();
        let decoded = decoder.push(exact_event.as_bytes()).unwrap();
        assert_eq!(decoded.events, vec![payload]);

        let first = decoder.push(b"data: one\r").unwrap();
        assert!(first.events.is_empty());
        let rest = decoder.push(b"\n\r\ndata: two\n\n").unwrap();
        assert_eq!(rest.events, vec!["one", "two"]);
    }

    #[test]
    fn decoders_reject_events_with_more_than_65536_lines() {
        let input = "data:x\n".repeat(MAX_EVENT_LINES + 1);
        let error = parse_sse_bytes(input.as_bytes()).unwrap_err();
        assert_eq!(
            error.message,
            "upstream SSE event exceeds the 16 MiB or 65536-line bound"
        );

        let mut decoder = IncrementalSseDecoder {
            event_lines: MAX_EVENT_LINES,
            ..Default::default()
        };
        let error = decoder.push(b"data:x\n").unwrap_err();
        assert_eq!(
            error.message,
            "upstream SSE event exceeds the 16 MiB or 65536-line bound"
        );
    }

    #[test]
    fn chat_aggregate_ignores_semantics_after_terminal() {
        let bytes = Bytes::from_static(
            b"data: {\"choices\":[{\"delta\":{\"content\":\"before\"},\"finish_reason\":\"stop\"}]}\n\ndata: {\"choices\":[{\"delta\":{\"content\":\"after\"},\"finish_reason\":null}]}\n\ndata: [DONE]\n\n",
        );
        let result = aggregate_chat_sse(bytes).unwrap();
        assert_eq!(
            result.pointer("/choices/0/message/content"),
            Some(&json!("before"))
        );
    }

    #[test]
    fn chat_aggregate_preserves_text_tool_text_order_and_replaces_snapshots() {
        let bytes = Bytes::from_static(
            b"data: {\"choices\":[{\"delta\":{\"content\":\"before\"},\"finish_reason\":null}]}\n\ndata: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":\"lookup\",\"arguments\":\"{\\\"q\\\":\"}}]},\"finish_reason\":null}]}\n\ndata: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":\"lookup\",\"arguments\":\"1}\"}}]},\"finish_reason\":null}]}\n\ndata: {\"choices\":[{\"delta\":{\"content\":\"after\"},\"finish_reason\":null}]}\n\ndata: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n",
        );
        let result = aggregate_chat_sse(bytes).unwrap();
        assert_eq!(
            result.pointer("/choices/0/message/output_blocks"),
            Some(&json!([
                {"type":"text","text":"before"},
                {"type":"tool_use","id":"call_1","name":"lookup","input":"{\"q\":1}"},
                {"type":"text","text":"after"}
            ]))
        );
        assert_eq!(
            result.pointer("/choices/0/message/tool_calls/0/id"),
            Some(&json!("call_1"))
        );
        assert_eq!(
            result.pointer("/choices/0/message/tool_calls/0/function/name"),
            Some(&json!("lookup"))
        );
    }

    #[test]
    fn responses_aggregator_ignores_events_after_terminal() {
        let mut aggregator = ResponsesSseAggregator::default();
        aggregator
            .push_raw(
                &json!({
                    "type":"response.completed",
                    "response":{"id":"r","status":"completed","output":[]}
                })
                .to_string(),
            )
            .unwrap();
        aggregator
            .push_raw(
                &json!({
                    "type":"response.output_text.delta","output_index":0,
                    "content_index":0,"delta":"late"
                })
                .to_string(),
            )
            .unwrap();
        let response = aggregator.finish().unwrap();
        assert_eq!(response["output"], json!([]));
        assert_eq!(response["model"], "unknown");
    }

    #[test]
    fn responses_completed_terminal_preserves_error_for_logical_mapping() {
        let mut aggregator = ResponsesSseAggregator::default();
        aggregator
            .push_raw(
                &json!({
                    "type":"response.completed",
                    "response":{"status":"completed","error":{"message":"boom"},"output":[]}
                })
                .to_string(),
            )
            .unwrap();
        let response = aggregator.finish().unwrap();
        assert_eq!(response.pointer("/error/message"), Some(&json!("boom")));
    }

    #[test]
    fn responses_audio_and_transcript_events_preserve_visible_semantics_once() {
        let mut aggregator = ResponsesSseAggregator::default();
        for event in [
            json!({"type":"response.audio.transcript.delta","output_index":0,"delta":"hello"}),
            json!({"type":"response.audio.delta","output_index":0,"delta":"AAAA"}),
            json!({"type":"response.audio.delta","output_index":0,"delta":"BBBB"}),
            json!({"type":"response.completed","response":{"id":"r","status":"completed","output":[]}}),
        ] {
            aggregator.push_raw(&event.to_string()).unwrap();
        }
        let response = aggregator.finish().unwrap();
        assert_eq!(
            response.pointer("/output/0/content/0/text"),
            Some(&json!("hello[generated audio omitted]"))
        );
    }

    #[test]
    fn populated_audio_terminal_supplements_stream_without_base64_or_duplication() {
        let mut aggregator = ResponsesSseAggregator::default();
        for event in [
            json!({"type":"response.output_audio.delta","output_index":0,"delta":"AA=="}),
            json!({"type":"response.output_audio_transcript.delta","output_index":0,"delta":"spo"}),
            json!({"type":"response.completed","response":{
                "id":"r","model":"m","status":"completed","output":[{
                    "type":"message","role":"assistant","content":[{
                        "type":"output_audio","data":"AA==","transcript":"spoken"
                    }]
                }]
            }}),
        ] {
            aggregator.push_raw(&event.to_string()).unwrap();
        }
        let response = aggregator.finish().unwrap();
        assert_eq!(response["model"], "m");
        assert_eq!(
            response.pointer("/output/0/content/0/text"),
            Some(&json!("[generated audio omitted]spoken"))
        );
        assert!(!response.to_string().contains("AA=="));
    }

    #[test]
    fn responses_terminal_status_must_be_expected_string() {
        for status in [Value::Null, json!(7)] {
            let mut aggregator = ResponsesSseAggregator::default();
            let error = aggregator
                .push_raw(
                    &json!({
                        "type":"response.completed",
                        "response":{"status":status,"output":[]}
                    })
                    .to_string(),
                )
                .unwrap_err();
            assert_eq!(
                error.message,
                "upstream Responses terminal event/status mismatch"
            );
            assert!(error.retryable);
        }
    }

    #[test]
    fn responses_sparse_content_indices_do_not_allocate_holes() {
        let mut aggregator = ResponsesSseAggregator::default();
        for (content_index, delta) in [(u64::MAX, "late"), (0, "first")] {
            aggregator
                .push_raw(
                    &json!({
                        "type":"response.output_text.delta",
                        "output_index":0,
                        "content_index":content_index,
                        "delta":delta
                    })
                    .to_string(),
                )
                .unwrap();
        }
        aggregator
            .push_raw(
                &json!({
                    "type":"response.completed",
                    "response":{"id":"r","model":"m","status":"completed","output":[]}
                })
                .to_string(),
            )
            .unwrap();
        let response = aggregator.finish().unwrap();
        assert_eq!(
            response.pointer("/output/0/content"),
            Some(&json!([
                {"type":"output_text","text":"first"},
                {"type":"output_text","text":"late"}
            ]))
        );
        assert!(!response.to_string().contains("__ocr_stream_part_index"));
    }

    #[test]
    fn responses_sparse_reasoning_indices_do_not_allocate_holes() {
        let mut aggregator = ResponsesSseAggregator::default();
        for (summary_index, delta) in [(u64::MAX, "late"), (0, "first")] {
            aggregator
                .push_raw(
                    &json!({
                        "type":"response.reasoning_summary_text.delta",
                        "output_index":0,
                        "summary_index":summary_index,
                        "delta":delta
                    })
                    .to_string(),
                )
                .unwrap();
        }
        aggregator
            .push_raw(
                &json!({
                    "type":"response.completed",
                    "response":{"id":"r","model":"m","status":"completed","output":[]}
                })
                .to_string(),
            )
            .unwrap();
        let response = aggregator.finish().unwrap();
        assert_eq!(
            response.pointer("/output/0/summary"),
            Some(&json!([
                {"type":"summary_text","text":"first"},
                {"type":"summary_text","text":"late"}
            ]))
        );
        assert!(!response.to_string().contains("__ocr_stream_part_index"));
    }

    #[test]
    fn responses_interleaved_out_of_order_function_calls_use_official_indices() {
        let mut aggregator = ResponsesSseAggregator::default();
        let terminal_output = json!([
            {
                "type":"function_call","id":"item_a","call_id":"call_a",
                "name":"tool_a","arguments":"{\"a\":1}","status":"completed"
            },
            {
                "type":"function_call","id":"item_b","call_id":"call_b",
                "name":"tool_b","arguments":"{\"b\":2}","status":"completed"
            }
        ]);
        let events = [
            json!({
                "type":"response.created","sequence_number":0,
                "response":{"id":"resp_parallel","model":"m","status":"in_progress","output":[]}
            }),
            json!({
                "type":"response.output_item.added","sequence_number":1,"output_index":1,
                "item":{"type":"function_call","id":"item_b","call_id":"call_b",
                    "name":"tool_b","arguments":"","status":"in_progress"}
            }),
            json!({
                "type":"response.output_item.added","sequence_number":2,"output_index":0,
                "item":{"type":"function_call","id":"item_a","call_id":"call_a",
                    "name":"tool_a","arguments":"","status":"in_progress"}
            }),
            json!({
                "type":"response.function_call_arguments.delta","sequence_number":3,
                "output_index":1,"item_id":"item_b","delta":"{\"b\":"
            }),
            json!({
                "type":"response.function_call_arguments.delta","sequence_number":4,
                "output_index":0,"item_id":"item_a","delta":"{\"a\":"
            }),
            json!({
                "type":"response.function_call_arguments.delta","sequence_number":5,
                "output_index":1,"item_id":"item_b","delta":"2}"
            }),
            json!({
                "type":"response.function_call_arguments.delta","sequence_number":6,
                "output_index":0,"item_id":"item_a","delta":"1}"
            }),
            json!({
                "type":"response.function_call_arguments.done","sequence_number":7,
                "output_index":1,"item_id":"item_b","arguments":"{\"b\":2}"
            }),
            json!({
                "type":"response.function_call_arguments.done","sequence_number":8,
                "output_index":0,"item_id":"item_a","arguments":"{\"a\":1}"
            }),
            json!({
                "type":"response.output_item.done","sequence_number":9,"output_index":1,
                "item":terminal_output[1].clone()
            }),
            json!({
                "type":"response.output_item.done","sequence_number":10,"output_index":0,
                "item":terminal_output[0].clone()
            }),
            json!({
                "type":"response.completed","sequence_number":11,
                "response":{
                    "id":"resp_parallel","model":"m","status":"completed",
                    "output":terminal_output,
                    "usage":{
                        "input_tokens":17,"output_tokens":4,"total_tokens":21,
                        "input_tokens_details":{"cached_tokens":5,"cache_write_tokens":3}
                    }
                }
            }),
        ];
        for event in events {
            aggregator.push_raw(&event.to_string()).unwrap();
        }

        let payload = aggregator.finish().unwrap();
        assert_eq!(payload.pointer("/output/0/id"), Some(&json!("item_a")));
        assert_eq!(
            payload.pointer("/output/0/arguments"),
            Some(&json!("{\"a\":1}"))
        );
        assert_eq!(payload.pointer("/output/1/id"), Some(&json!("item_b")));
        assert_eq!(
            payload.pointer("/output/1/arguments"),
            Some(&json!("{\"b\":2}"))
        );

        let message = crate::transform::transform_responses_json(&payload, false).unwrap();
        assert_eq!(message.pointer("/content/0/id"), Some(&json!("call_a")));
        assert_eq!(message.pointer("/content/0/input"), Some(&json!({"a":1})));
        assert_eq!(message.pointer("/content/1/id"), Some(&json!("call_b")));
        assert_eq!(message.pointer("/content/1/input"), Some(&json!({"b":2})));
        assert_eq!(message.pointer("/usage/input_tokens"), Some(&json!(9)));
        assert_eq!(
            message.pointer("/usage/cache_read_input_tokens"),
            Some(&json!(5))
        );
        assert_eq!(
            message.pointer("/usage/cache_creation_input_tokens"),
            Some(&json!(3))
        );
    }
}
