mod request;
mod response;
mod responses;

pub use request::{prepare_chat_request, transform_anthropic_request};
pub use response::{
    anthropic_content_block_to_sse, anthropic_json_to_sse, anthropic_terminal_to_sse,
    transform_chat_json_response,
};
pub use responses::{transform_responses_json, transform_responses_request};

use axum::http::StatusCode;

use crate::error::ApiError;

const MAX_FALLBACK_CHARS: usize = 4096;

fn invalid(message: impl Into<String>) -> ApiError {
    ApiError::new(
        StatusCode::BAD_REQUEST,
        "invalid_request_error",
        "invalid_body",
        message,
    )
}

pub(crate) fn protocol_error(message: impl Into<String>) -> ApiError {
    ApiError::new(
        StatusCode::BAD_GATEWAY,
        "api_error",
        "upstream_protocol_error",
        message,
    )
}

fn bounded_json(value: &serde_json::Value) -> String {
    let text = serde_json::to_string(value).unwrap_or_default();
    if text.chars().count() <= MAX_FALLBACK_CHARS {
        text
    } else {
        let block_type = value
            .get("type")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("content");
        format!(
            "[unsupported {block_type} block omitted: {} chars]",
            text.chars().count()
        )
    }
}
