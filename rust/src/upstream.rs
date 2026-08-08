use axum::http::{HeaderMap, StatusCode};
use bytes::{Bytes, BytesMut};
use futures_util::StreamExt;
use reqwest::Client;
use serde_json::Value;

use crate::error::{ApiError, error_type_for_status};

const MAX_ERROR_CHARS: usize = 4096;
pub const MAX_BUFFERED_UPSTREAM_BODY_BYTES: usize = 64 * 1024 * 1024;

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
        ApiError::new(
            StatusCode::BAD_GATEWAY,
            "api_error",
            "upstream_unreachable",
            format!("upstream fetch failed: {error}"),
        )
        .retryable()
    })
}

/// Reads a body that must be buffered, retaining a bounded prefix before a
/// transport failure or size violation. Callers still have the upstream HTTP
/// status, so a truncated non-2xx response keeps its original retry contract.
pub async fn read_upstream_body(response: reqwest::Response) -> (Bytes, Option<String>) {
    read_upstream_body_stream(response.bytes_stream(), MAX_BUFFERED_UPSTREAM_BODY_BYTES).await
}

async fn read_upstream_body_stream<S, E>(stream: S, max_bytes: usize) -> (Bytes, Option<String>)
where
    S: futures_util::Stream<Item = Result<Bytes, E>>,
    E: std::fmt::Display,
{
    futures_util::pin_mut!(stream);
    let mut body = BytesMut::new();
    while let Some(next) = stream.next().await {
        match next {
            Ok(chunk) => {
                let remaining = max_bytes.saturating_sub(body.len());
                if chunk.len() > remaining {
                    body.extend_from_slice(&chunk[..remaining]);
                    return (
                        body.freeze(),
                        Some(format!(
                            "buffered upstream response exceeds the {max_bytes}-byte limit"
                        )),
                    );
                }
                body.extend_from_slice(&chunk);
            }
            Err(error) => return (body.freeze(), Some(error.to_string())),
        }
    }
    (body.freeze(), None)
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

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::stream;

    #[tokio::test]
    async fn buffered_body_limit_accepts_exact_size_and_retains_bounded_prefix() {
        let exact = stream::iter([Ok::<_, std::io::Error>(Bytes::from_static(b"12345"))]);
        let (body, error) = read_upstream_body_stream(exact, 5).await;
        assert_eq!(body, Bytes::from_static(b"12345"));
        assert!(error.is_none());

        let oversized = stream::iter([
            Ok::<_, std::io::Error>(Bytes::from_static(b"123")),
            Ok::<_, std::io::Error>(Bytes::from_static(b"456")),
        ]);
        let (body, error) = read_upstream_body_stream(oversized, 5).await;
        assert_eq!(body, Bytes::from_static(b"12345"));
        assert_eq!(
            error.as_deref(),
            Some("buffered upstream response exceeds the 5-byte limit")
        );
    }
}
