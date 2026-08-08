use axum::http::{HeaderMap, StatusCode};
use reqwest::Client;
use serde_json::Value;

use crate::error::{ApiError, error_type_for_status};

const MAX_ERROR_CHARS: usize = 4096;

pub async fn call_upstream(
    client: &Client,
    url: &str,
    authorization: &str,
    extra_headers: HeaderMap,
    body: &Value,
) -> Result<reqwest::Response, ApiError> {
    let mut request = client
        .post(url)
        .header("content-type", "application/json")
        .header("accept", "application/json, text/event-stream")
        .header("authorization", authorization);
    for (name, value) in extra_headers {
        if let Some(name) = name {
            request = request.header(name, value);
        }
    }
    request.json(body).send().await.map_err(|error| {
        let text = error.to_string();
        let aborted = text.to_ascii_lowercase().contains("timeout")
            || text.to_ascii_lowercase().contains("cancel");
        ApiError::new(
            if aborted {
                StatusCode::from_u16(499).unwrap()
            } else {
                StatusCode::BAD_GATEWAY
            },
            if aborted {
                "request_canceled"
            } else {
                "api_error"
            },
            if aborted {
                "client_disconnected"
            } else {
                "upstream_unreachable"
            },
            format!("upstream fetch failed: {text}"),
        )
    })
}

pub fn upstream_http_error(status: StatusCode, bytes: &[u8]) -> ApiError {
    let status_text = status.canonical_reason().unwrap_or("upstream error");
    let body = String::from_utf8_lossy(bytes).into_owned();
    let parsed = serde_json::from_str::<Value>(&body).ok();
    let message = parsed
        .as_ref()
        .and_then(|value| value.pointer("/error/message").and_then(Value::as_str))
        .or_else(|| {
            parsed
                .as_ref()
                .and_then(|value| value.get("message").and_then(Value::as_str))
        })
        .filter(|message| !message.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| {
            if body.is_empty() {
                status_text.to_owned()
            } else {
                body
            }
        });
    let request_id = parsed
        .as_ref()
        .and_then(|value| value.get("request_id").and_then(Value::as_str))
        .map(ToOwned::to_owned);
    ApiError::new(
        status,
        error_type_for_status(status),
        "upstream_http_error",
        bound_message(message, status),
    )
    .with_request_id(request_id)
    .retryable()
}

fn bound_message(message: String, status: StatusCode) -> String {
    if message.chars().count() <= MAX_ERROR_CHARS {
        return message;
    }
    let prefix = message.chars().take(MAX_ERROR_CHARS).collect::<String>();
    format!(
        "{prefix} […upstream HTTP {} body truncated, {} chars total]",
        status.as_u16(),
        message.chars().count()
    )
}
