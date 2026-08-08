use std::{collections::BTreeMap, convert::Infallible};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use bytes::Bytes;
use futures_util::{Stream, StreamExt};
use serde_json::{Value, json};

use crate::{
    error::ApiError,
    model_log::StreamingCapture,
    sse::{IncrementalSseDecoder, ResponsesSseAggregator, format_sse_event},
    transform::{
        anthropic_content_block_to_sse, anthropic_json_to_sse, anthropic_terminal_to_sse,
        protocol_error, transform_responses_json,
    },
};

pub fn convert_chat_sse_stream(
    response: reqwest::Response,
    omit_thinking: bool,
    mut capture: StreamingCapture,
) -> impl Stream<Item = Result<Bytes, Infallible>> {
    let mut upstream = response.bytes_stream();
    async_stream::stream! {
        let mut decoder = IncrementalSseDecoder::default();
        let mut state = ChatStreamState::new(omit_thinking);
        let mut stopped_at_done = false;
        while let Some(next) = upstream.next().await {
            match next {
                Ok(chunk) => {
                    capture.push(&chunk);
                    match decoder.push(&chunk) {
                        Ok(decoded) => {
                            for raw in decoded.events {
                                match state.on_raw_event(&raw) {
                                    Ok(frames) => for frame in frames {
                                        yield Ok(Bytes::from(frame));
                                    },
                                    Err(error) => {
                                        yield Ok(Bytes::from(error_frame(&error)));
                                        return;
                                    }
                                }
                            }
                            if decoded.saw_done {
                                stopped_at_done = true;
                                break;
                            }
                        }
                        Err(error) => {
                            yield Ok(Bytes::from(error_frame(&error)));
                            return;
                        }
                    }
                }
                Err(error) => {
                    yield Ok(Bytes::from(error_frame(&protocol_error(format!("upstream stream read failed: {error}")))));
                    return;
                }
            }
        }
        if !stopped_at_done {
            match decoder.finish() {
                Ok(decoded) => {
                    for raw in decoded.events {
                        match state.on_raw_event(&raw) {
                            Ok(frames) => for frame in frames { yield Ok(Bytes::from(frame)); },
                            Err(error) => {
                                yield Ok(Bytes::from(error_frame(&error)));
                                return;
                            }
                        }
                    }
                    stopped_at_done = decoded.saw_done;
                }
                Err(error) => {
                    yield Ok(Bytes::from(error_frame(&error)));
                    return;
                }
            }
        }
        match state.finish(stopped_at_done) {
            Ok(frames) => for frame in frames { yield Ok(Bytes::from(frame)); },
            Err(error) => yield Ok(Bytes::from(error_frame(&error))),
        }
        capture.finish();
    }
}

/// Consumes Responses SSE incrementally so the router never buffers the raw
/// upstream body. Text-only Responses streams are forwarded at first-token
/// latency; streams whose earlier reasoning/tool items require replay state
/// stay buffered until those items can be sealed safely. Dropping the
/// downstream body drops the reqwest byte stream and records an incomplete
/// capture, propagating cancellation.
pub fn convert_responses_sse_stream(
    response: reqwest::Response,
    omit_thinking: bool,
    mut capture: StreamingCapture,
) -> impl Stream<Item = Result<Bytes, Infallible>> {
    let mut upstream = response.bytes_stream();
    async_stream::stream! {
        let mut decoder = IncrementalSseDecoder::default();
        let mut aggregator = ResponsesSseAggregator::default();
        let mut progressive = ResponsesProgressiveState::default();
        let mut stopped_at_done = false;
        while let Some(next) = upstream.next().await {
            let chunk = match next {
                Ok(chunk) => chunk,
                Err(error) => {
                    yield Ok(Bytes::from(error_frame(&protocol_error(format!("upstream stream read failed: {error}")))));
                    return;
                }
            };
            capture.push(&chunk);
            let decoded = match decoder.push(&chunk) {
                Ok(decoded) => decoded,
                Err(error) => {
                    yield Ok(Bytes::from(error_frame(&error)));
                    return;
                }
            };
            for raw in decoded.events {
                if let Err(error) = aggregator.push_raw(&raw) {
                    yield Ok(Bytes::from(error_frame(&error)));
                    return;
                }
                match progressive.on_raw_event(&raw) {
                    Ok(frames) => for frame in frames {
                        yield Ok(Bytes::from(frame));
                    },
                    Err(error) => {
                        yield Ok(Bytes::from(error_frame(&error)));
                        return;
                    }
                }
            }
            if decoded.saw_done {
                stopped_at_done = true;
                break;
            }
        }
        if !stopped_at_done {
            let decoded = match decoder.finish() {
                Ok(decoded) => decoded,
                Err(error) => {
                    yield Ok(Bytes::from(error_frame(&error)));
                    return;
                }
            };
            for raw in decoded.events {
                if let Err(error) = aggregator.push_raw(&raw) {
                    yield Ok(Bytes::from(error_frame(&error)));
                    return;
                }
                match progressive.on_raw_event(&raw) {
                    Ok(frames) => for frame in frames {
                        yield Ok(Bytes::from(frame));
                    },
                    Err(error) => {
                        yield Ok(Bytes::from(error_frame(&error)));
                        return;
                    }
                }
            }
        }
        let result = aggregator
            .finish()
            .and_then(|payload| transform_responses_json(&payload, omit_thinking))
            .and_then(|message| progressive.finish(&message));
        capture.finish();
        match result {
            Ok(frames) => yield Ok(Bytes::from(frames)),
            Err(error) => yield Ok(Bytes::from(error_frame(&error))),
        }
    }
}

#[derive(Default)]
struct ResponsesProgressiveState {
    blocked_before_text: bool,
    started: bool,
    message_id: Option<String>,
    model: Option<String>,
    service_tier: Option<String>,
    emitted_text: String,
}

impl ResponsesProgressiveState {
    fn on_raw_event(&mut self, raw: &str) -> Result<Vec<String>, ApiError> {
        let event: Value = serde_json::from_str(raw)
            .map_err(|_| protocol_error("upstream Responses SSE contains malformed JSON"))?;
        let kind = event
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if matches!(kind, "response.created" | "response.in_progress")
            && let Some(response) = event.get("response")
        {
            if let Some(id) = response.get("id").and_then(Value::as_str) {
                self.message_id = Some(id.to_owned());
            }
            if let Some(model) = response.get("model").and_then(Value::as_str) {
                self.model = Some(model.to_owned());
            }
            if let Some(tier) = response.get("service_tier").and_then(Value::as_str) {
                self.service_tier = Some(tier.to_owned());
            }
        }
        if !self.started {
            if matches!(
                kind,
                "response.reasoning_text.delta"
                    | "response.reasoning_text.done"
                    | "response.reasoning_summary_text.delta"
                    | "response.reasoning_summary_text.done"
                    | "response.function_call_arguments.delta"
                    | "response.function_call_arguments.done"
            ) {
                self.blocked_before_text = true;
            }
            if matches!(
                kind,
                "response.output_item.added" | "response.output_item.done"
            ) && event
                .pointer("/item/type")
                .and_then(Value::as_str)
                .is_some_and(|item_type| item_type != "message")
            {
                self.blocked_before_text = true;
            }
        }
        let text = match kind {
            "response.output_text.delta" | "response.refusal.delta" => {
                event.get("delta").and_then(Value::as_str)
            }
            _ => None,
        };
        let Some(text) = text.filter(|text| !text.is_empty()) else {
            return Ok(Vec::new());
        };
        if self.blocked_before_text {
            return Ok(Vec::new());
        }
        let mut frames = Vec::new();
        if !self.started {
            self.started = true;
            let id = self
                .message_id
                .clone()
                .unwrap_or_else(|| format!("msg_{}", uuid::Uuid::new_v4()));
            let model = self.model.clone().unwrap_or_else(|| "unknown".into());
            frames.push(format_sse_event(
                "message_start",
                &json!({
                    "type":"message_start",
                    "message":{
                        "id":id,"type":"message","role":"assistant","content":[],"model":model,
                        "stop_reason":null,"stop_sequence":null,"stop_details":null,"container":null,
                        "usage":initial_responses_usage(self.service_tier.as_deref())
                    }
                }),
            ));
            frames.push(format_sse_event(
                "content_block_start",
                &json!({
                    "type":"content_block_start","index":0,
                    "content_block":{"type":"text","text":"","citations":null}
                }),
            ));
        }
        self.emitted_text.push_str(text);
        frames.push(format_sse_event(
            "content_block_delta",
            &json!({
                "type":"content_block_delta","index":0,
                "delta":{"type":"text_delta","text":text}
            }),
        ));
        Ok(frames)
    }

    fn finish(self, message: &Value) -> Result<String, ApiError> {
        if !self.started {
            return anthropic_json_to_sse(message);
        }
        let content = message
            .get("content")
            .and_then(Value::as_array)
            .ok_or_else(|| protocol_error("Responses stream produced invalid Anthropic content"))?;
        let first_text = content
            .first()
            .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
            .and_then(|block| block.get("text"))
            .and_then(Value::as_str)
            .ok_or_else(|| {
                protocol_error(
                    "upstream Responses terminal output does not match streamed text order",
                )
            })?;
        let Some(suffix) = first_text.strip_prefix(&self.emitted_text) else {
            return Err(protocol_error(
                "upstream Responses terminal output text is inconsistent",
            ));
        };
        let mut frames = String::new();
        if !suffix.is_empty() {
            frames.push_str(&format_sse_event(
                "content_block_delta",
                &json!({
                    "type":"content_block_delta","index":0,
                    "delta":{"type":"text_delta","text":suffix}
                }),
            ));
        }
        frames.push_str(&format_sse_event(
            "content_block_stop",
            &json!({"type":"content_block_stop","index":0}),
        ));
        for (index, block) in content.iter().enumerate().skip(1) {
            frames.push_str(&anthropic_content_block_to_sse(block, index));
        }
        frames.push_str(&anthropic_terminal_to_sse(message));
        Ok(frames)
    }
}

fn initial_responses_usage(service_tier: Option<&str>) -> Value {
    json!({
        "cache_creation":null,
        "cache_creation_input_tokens":0,
        "cache_read_input_tokens":0,
        "inference_geo":null,
        "input_tokens":0,
        "output_tokens":0,
        "output_tokens_details":null,
        "server_tool_use":null,
        "service_tier":match service_tier {
            Some("default" | "standard") => Some("standard"),
            Some("priority" | "fast") => Some("priority"),
            _ => None,
        }
    })
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum BlockKind {
    Text,
    Thinking,
}

#[derive(Default)]
struct ToolBuffer {
    id: String,
    name: String,
    arguments: String,
}

struct ChatStreamState {
    omit_thinking: bool,
    started: bool,
    message_id: String,
    model: String,
    service_tier: Option<String>,
    next_index: usize,
    open: Option<(BlockKind, usize)>,
    reasoning_replay: String,
    reasoning_signature: Option<String>,
    tools: BTreeMap<u64, ToolBuffer>,
    finish_reason: Option<String>,
    usage: Option<Value>,
    refusal: String,
    saw_semantic_content: bool,
    failed: bool,
}

impl ChatStreamState {
    fn new(omit_thinking: bool) -> Self {
        Self {
            omit_thinking,
            started: false,
            message_id: format!("msg_{}", uuid::Uuid::new_v4()),
            model: "unknown".into(),
            service_tier: None,
            next_index: 0,
            open: None,
            reasoning_replay: String::new(),
            reasoning_signature: None,
            tools: BTreeMap::new(),
            finish_reason: None,
            usage: None,
            refusal: String::new(),
            saw_semantic_content: false,
            failed: false,
        }
    }

    fn on_raw_event(&mut self, raw: &str) -> Result<Vec<String>, ApiError> {
        let event: Value = serde_json::from_str(raw)
            .map_err(|_| protocol_error("upstream Chat SSE contains malformed JSON"))?;
        if let Some(error) = event.get("error") {
            self.failed = true;
            return Err(protocol_error(
                error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("upstream stream error"),
            ));
        }
        if let Some(id) = event.get("id").and_then(Value::as_str) {
            self.message_id = id.to_owned();
        }
        if let Some(model) = event.get("model").and_then(Value::as_str) {
            self.model = model.to_owned();
        }
        if let Some(tier) = event.get("service_tier").and_then(Value::as_str) {
            self.service_tier = Some(tier.to_owned());
        }
        if event.get("usage").is_some_and(|usage| !usage.is_null()) {
            self.usage = event.get("usage").cloned();
        }
        let mut frames = self.ensure_started();
        let Some(choice) = event
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|choices| choices.first())
        else {
            return Ok(frames);
        };
        if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
            self.finish_reason = Some(reason.to_owned());
        }
        let delta = choice.get("delta").unwrap_or(&Value::Null);
        if let Some(text) = delta
            .get("reasoning_content")
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
        {
            self.saw_semantic_content = true;
            frames.extend(self.emit_thinking(text));
        }
        if let Some(signature) = delta
            .get("signature")
            .or_else(|| delta.pointer("/thinking/signature"))
            .and_then(Value::as_str)
        {
            self.reasoning_signature = Some(signature.to_owned());
        }
        match delta.get("content") {
            Some(Value::String(text)) if !text.is_empty() => {
                self.saw_semantic_content = true;
                frames.extend(self.emit_text(text));
            }
            Some(Value::Array(parts)) => {
                for part in parts {
                    let text = if part.get("type").and_then(Value::as_str) == Some("text") {
                        part.get("text").and_then(Value::as_str).unwrap_or_default()
                    } else if part.get("type").and_then(Value::as_str) == Some("image_url") {
                        "[generated image omitted]"
                    } else {
                        ""
                    };
                    if !text.is_empty() {
                        self.saw_semantic_content = true;
                        frames.extend(self.emit_text(text));
                    }
                }
            }
            _ => {}
        }
        if let Some(text) = delta
            .get("refusal")
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
        {
            self.refusal.push_str(text);
            self.saw_semantic_content = true;
            frames.extend(self.emit_text(text));
        }
        if let Some(calls) = delta.get("tool_calls").and_then(Value::as_array) {
            for call in calls {
                let index = call.get("index").and_then(Value::as_u64).unwrap_or(0);
                let tool = self.tools.entry(index).or_default();
                if let Some(id) = call.get("id").and_then(Value::as_str) {
                    tool.id.push_str(id);
                }
                if let Some(name) = call.pointer("/function/name").and_then(Value::as_str) {
                    tool.name.push_str(name);
                }
                if let Some(arguments) = call.pointer("/function/arguments").and_then(Value::as_str)
                {
                    tool.arguments.push_str(arguments);
                }
            }
        }
        if let Some(function) = delta.get("function_call") {
            let tool = self.tools.entry(0).or_default();
            if tool.id.is_empty() {
                tool.id = format!("call_{}", uuid::Uuid::new_v4());
            }
            if let Some(name) = function.get("name").and_then(Value::as_str) {
                tool.name.push_str(name);
            }
            if let Some(arguments) = function.get("arguments").and_then(Value::as_str) {
                tool.arguments.push_str(arguments);
            }
        }
        Ok(frames)
    }

    fn finish(&mut self, saw_done: bool) -> Result<Vec<String>, ApiError> {
        if self.failed {
            return Ok(Vec::new());
        }
        if !self.started && !self.saw_semantic_content && self.tools.is_empty() {
            return Err(protocol_error("upstream Chat stream was empty"));
        }
        let mut frames = self.ensure_started();
        frames.extend(self.close_open());
        let mut reason = self.finish_reason.clone();
        if reason.is_none() {
            if saw_done {
                reason = Some(if self.tools.is_empty() {
                    "stop".into()
                } else {
                    "length".into()
                });
            } else {
                return Err(protocol_error(
                    "upstream stream ended before a terminal event",
                ));
            }
        }
        let reason = reason.unwrap();
        let is_refusal = reason == "content_filter" || !self.refusal.is_empty();
        let complete_tools =
            matches!(reason.as_str(), "tool_calls" | "function_call") && !is_refusal;
        let tools = std::mem::take(&mut self.tools);
        for (_, tool) in tools {
            if complete_tools {
                if tool.id.is_empty() || tool.name.is_empty() {
                    return Err(protocol_error(
                        "upstream tool call is missing id or function name",
                    ));
                }
                let input: Value = serde_json::from_str(if tool.arguments.is_empty() {
                    "{}"
                } else {
                    &tool.arguments
                })
                .map_err(|_| {
                    protocol_error("upstream tool arguments must be a valid JSON object")
                })?;
                if !input.is_object() {
                    return Err(protocol_error(
                        "upstream tool arguments must decode to a JSON object",
                    ));
                }
                let index = self.next_index;
                self.next_index += 1;
                frames.push(format_sse_event(
                    "content_block_start",
                    &json!({
                        "type":"content_block_start","index":index,
                        "content_block":{"type":"tool_use","id":tool.id,"name":tool.name,"input":{},"caller":{"type":"direct"}}
                    }),
                ));
                frames.push(format_sse_event(
                    "content_block_delta",
                    &json!({
                        "type":"content_block_delta","index":index,
                        "delta":{"type":"input_json_delta","partial_json":serde_json::to_string(&input).unwrap()}
                    }),
                ));
                frames.push(format_sse_event(
                    "content_block_stop",
                    &json!({"type":"content_block_stop","index":index}),
                ));
            } else {
                frames.extend(self.emit_complete_text(&format!(
                    "[incomplete tool_use {}: {}]",
                    if tool.name.is_empty() {
                        "unknown"
                    } else {
                        &tool.name
                    },
                    tool.arguments.chars().take(4096).collect::<String>()
                )));
            }
        }
        let stop_reason = if is_refusal {
            "refusal"
        } else {
            match reason.as_str() {
                "stop" => "end_turn",
                "length" => "max_tokens",
                "tool_calls" | "function_call" => "tool_use",
                other => {
                    return Err(protocol_error(format!(
                        "unsupported upstream finish_reason: {}",
                        serde_json::to_string(other).unwrap()
                    )));
                }
            }
        };
        let usage = delta_usage(self.usage.as_ref());
        frames.push(format_sse_event(
            "message_delta",
            &json!({
                "type":"message_delta",
                "delta":{
                    "stop_reason":stop_reason,"stop_sequence":null,
                    "stop_details":if is_refusal { json!({"type":"refusal","category":null,"explanation":if self.refusal.is_empty() { Value::Null } else { Value::String(self.refusal.clone()) }}) } else { Value::Null },
                    "container":null
                },
                "usage":usage
            }),
        ));
        frames.push(format_sse_event(
            "message_stop",
            &json!({"type":"message_stop"}),
        ));
        Ok(frames)
    }

    fn ensure_started(&mut self) -> Vec<String> {
        if self.started {
            return Vec::new();
        }
        self.started = true;
        vec![format_sse_event(
            "message_start",
            &json!({
                "type":"message_start",
                "message":{
                    "id":self.message_id,"type":"message","role":"assistant","content":[],"model":self.model,
                    "stop_reason":null,"stop_sequence":null,"stop_details":null,"container":null,
                    "usage":full_usage(None, self.service_tier.as_deref())
                }
            }),
        )]
    }

    fn emit_text(&mut self, text: &str) -> Vec<String> {
        let mut frames = self.ensure_block(BlockKind::Text);
        if !text.is_empty() {
            let index = self.open.unwrap().1;
            frames.push(format_sse_event(
                "content_block_delta",
                &json!({"type":"content_block_delta","index":index,"delta":{"type":"text_delta","text":text}}),
            ));
        }
        frames
    }

    fn emit_thinking(&mut self, text: &str) -> Vec<String> {
        let mut frames = self.ensure_block(BlockKind::Thinking);
        self.reasoning_replay.push_str(text);
        if !self.omit_thinking && !text.is_empty() {
            let index = self.open.unwrap().1;
            frames.push(format_sse_event(
                "content_block_delta",
                &json!({"type":"content_block_delta","index":index,"delta":{"type":"thinking_delta","thinking":text}}),
            ));
        }
        frames
    }

    fn ensure_block(&mut self, kind: BlockKind) -> Vec<String> {
        if self.open.is_some_and(|(current, _)| current == kind) {
            return Vec::new();
        }
        let mut frames = self.close_open();
        let index = self.next_index;
        self.next_index += 1;
        let block = match kind {
            BlockKind::Text => json!({"type":"text","text":"","citations":null}),
            BlockKind::Thinking => json!({"type":"thinking","thinking":"","signature":""}),
        };
        frames.push(format_sse_event(
            "content_block_start",
            &json!({"type":"content_block_start","index":index,"content_block":block}),
        ));
        self.open = Some((kind, index));
        frames
    }

    fn close_open(&mut self) -> Vec<String> {
        let Some((kind, index)) = self.open.take() else {
            return Vec::new();
        };
        let mut frames = Vec::new();
        if kind == BlockKind::Thinking {
            let signature = self
                .reasoning_signature
                .take()
                .unwrap_or_else(|| encode_chat_signature(&self.reasoning_replay));
            frames.push(format_sse_event(
                "content_block_delta",
                &json!({"type":"content_block_delta","index":index,"delta":{"type":"signature_delta","signature":signature}}),
            ));
            self.reasoning_replay.clear();
        }
        frames.push(format_sse_event(
            "content_block_stop",
            &json!({"type":"content_block_stop","index":index}),
        ));
        frames
    }

    fn emit_complete_text(&mut self, text: &str) -> Vec<String> {
        let mut frames = self.emit_text(text);
        frames.extend(self.close_open());
        frames
    }
}

fn encode_chat_signature(content: &str) -> String {
    format!(
        "ocr-chat-reasoning-v1:{}",
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(&json!({"reasoning_content":content})).unwrap())
    )
}

fn full_usage(usage: Option<&Value>, service_tier: Option<&str>) -> Value {
    let usage = usage.unwrap_or(&Value::Null);
    let cached = usage
        .pointer("/prompt_tokens_details/cached_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let written = usage
        .pointer("/prompt_tokens_details/cache_write_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let reasoning = usage
        .pointer("/completion_tokens_details/reasoning_tokens")
        .and_then(Value::as_u64);
    json!({
        "cache_creation":null,"cache_creation_input_tokens":written,"cache_read_input_tokens":cached,
        "inference_geo":null,
        "input_tokens":usage.get("prompt_tokens").and_then(Value::as_u64).unwrap_or(0).saturating_sub(cached + written),
        "output_tokens":usage.get("completion_tokens").and_then(Value::as_u64).unwrap_or(0),
        "output_tokens_details":reasoning.map(|tokens| json!({"thinking_tokens":tokens})),
        "server_tool_use":null,
        "service_tier":match service_tier { Some("default"|"standard") => Some("standard"), Some("priority"|"fast") => Some("priority"), _ => None }
    })
}

fn delta_usage(usage: Option<&Value>) -> Value {
    let full = full_usage(usage, None);
    json!({
        "cache_creation_input_tokens":full["cache_creation_input_tokens"],
        "cache_read_input_tokens":full["cache_read_input_tokens"],
        "input_tokens":full["input_tokens"],
        "output_tokens":full["output_tokens"],
        "output_tokens_details":full["output_tokens_details"],
        "server_tool_use":null
    })
}

fn error_frame(error: &ApiError) -> String {
    format_sse_event(
        "error",
        &json!({
            "type":"error",
            "error":{"type":error.error_type,"message":error.message}
        }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_parallel_chat_fields_do_not_split_semantic_blocks() {
        let mut state = ChatStreamState::new(false);
        let events = [
            json!({
                "id":"chatcmpl-live-shape","model":"test-model",
                "choices":[{"delta":{"role":"assistant","content":"","reasoning_content":""},"finish_reason":null}]
            }),
            json!({
                "choices":[{"delta":{"content":"","reasoning_content":"think"},"finish_reason":null}]
            }),
            json!({
                "choices":[{"delta":{"content":"answer","reasoning_content":""},"finish_reason":null}]
            }),
            json!({
                "choices":[{"delta":{"content":"","reasoning_content":""},"finish_reason":"stop"}]
            }),
        ];
        let mut frames = Vec::new();
        for event in events {
            frames.extend(state.on_raw_event(&event.to_string()).unwrap());
        }
        frames.extend(state.finish(false).unwrap());

        let payloads = frames
            .iter()
            .map(|frame| {
                frame
                    .lines()
                    .find_map(|line| line.strip_prefix("data: "))
                    .map(|payload| serde_json::from_str::<Value>(payload).unwrap())
                    .unwrap()
            })
            .collect::<Vec<_>>();
        let starts = payloads
            .iter()
            .filter(|payload| {
                payload.get("type").and_then(Value::as_str) == Some("content_block_start")
            })
            .map(|payload| {
                payload
                    .pointer("/content_block/type")
                    .and_then(Value::as_str)
                    .unwrap()
            })
            .collect::<Vec<_>>();
        assert_eq!(starts, ["thinking", "text"]);
        let text = payloads
            .iter()
            .filter_map(|payload| payload.pointer("/delta/text").and_then(Value::as_str))
            .collect::<String>();
        assert_eq!(text, "answer");
        let thinking = payloads
            .iter()
            .filter_map(|payload| payload.pointer("/delta/thinking").and_then(Value::as_str))
            .collect::<String>();
        assert_eq!(thinking, "think");
    }
}
