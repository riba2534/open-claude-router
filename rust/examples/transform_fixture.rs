use std::io::{self, Read};

use open_claude_router::{
    error::ApiError,
    sse::{aggregate_chat_sse, aggregate_responses_sse},
    tokenizer::count_anthropic_tokens,
    transform::{
        prepare_chat_request, transform_anthropic_request, transform_chat_json_response,
        transform_responses_json, transform_responses_request,
    },
};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Deserialize)]
struct Fixture {
    mode: String,
    value: Value,
    #[serde(default)]
    omit_thinking: bool,
    #[serde(default)]
    saw_done: bool,
}

fn main() {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input).unwrap();
    let fixtures: Vec<Fixture> = serde_json::from_str(&input).unwrap();
    let output = fixtures
        .into_iter()
        .map(|fixture| {
            convert(
                &fixture.mode,
                &fixture.value,
                fixture.omit_thinking,
                fixture.saw_done,
            )
        })
        .collect::<Vec<_>>();
    println!("{}", serde_json::to_string(&output).unwrap());
}

fn convert(mode: &str, source: &Value, omit_thinking: bool, saw_done: bool) -> Value {
    let result: Result<Value, ApiError> = (|| {
        if mode == "token-count" {
            return Ok(json!(count_anthropic_tokens(source)));
        }
        if mode == "chat-response" {
            return transform_chat_json_response(source, omit_thinking);
        }
        if mode == "responses-response" {
            return transform_responses_json(source, omit_thinking);
        }
        if mode == "chat-sse-response" || mode == "responses-sse-response" {
            let mut text = source
                .as_array()
                .expect("SSE fixture value must be an array")
                .iter()
                .map(|event| format!("data: {}\n\n", serde_json::to_string(event).unwrap()))
                .collect::<String>();
            if saw_done {
                text.push_str("data: [DONE]\n\n");
            }
            let aggregated = if mode == "chat-sse-response" {
                aggregate_chat_sse(text.into())?
            } else {
                aggregate_responses_sse(text.into())?
            };
            return if mode == "chat-sse-response" {
                transform_chat_json_response(&aggregated, omit_thinking)
            } else {
                transform_responses_json(&aggregated, omit_thinking)
            };
        }
        let mut transformed = transform_anthropic_request(source)?;
        match mode {
            "unified" => {}
            "chat" => prepare_chat_request(&mut transformed),
            "responses" => transform_responses_request(&mut transformed)?,
            _ => panic!("unknown fixture mode {mode}"),
        }
        Ok(transformed)
    })();
    match result {
        Ok(value) => json!({"ok":true,"value":value}),
        Err(error) => json!({
            "ok":false,
            "status":error.status.as_u16(),
            "type":error.error_type,
            "message":error.message
        }),
    }
}
