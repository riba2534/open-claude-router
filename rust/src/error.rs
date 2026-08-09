use axum::{
    Json,
    http::{HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use thiserror::Error;

const MAX_RETRY_HINT_LENGTH: usize = 128;

#[derive(Clone, Debug, Default)]
pub(crate) struct RetryHints {
    retry_after: Option<HeaderValue>,
    retry_after_ms: Option<HeaderValue>,
}

impl RetryHints {
    pub(crate) fn from_headers(headers: &HeaderMap) -> Self {
        Self {
            retry_after: single_valid_header(headers, "retry-after", valid_retry_after),
            retry_after_ms: single_valid_header(
                headers,
                "retry-after-ms",
                valid_nonnegative_decimal,
            ),
        }
    }

    pub(crate) fn apply(&self, headers: &mut HeaderMap) {
        if let Some(value) = &self.retry_after {
            headers.insert("retry-after", value.clone());
        }
        if let Some(value) = &self.retry_after_ms {
            headers.insert("retry-after-ms", value.clone());
        }
    }
}

fn single_valid_header(
    headers: &HeaderMap,
    name: &'static str,
    validate: fn(&str) -> bool,
) -> Option<HeaderValue> {
    let mut values = headers.get_all(name).iter();
    let value = values.next()?;
    if values.next().is_some() {
        return None;
    }
    let raw = value.to_str().ok()?;
    if raw.is_empty() || raw.len() > MAX_RETRY_HINT_LENGTH || !validate(raw) {
        return None;
    }
    Some(value.clone())
}

fn valid_retry_after(raw: &str) -> bool {
    valid_nonnegative_decimal(raw) || httpdate::parse_http_date(raw).is_ok()
}

fn valid_nonnegative_decimal(raw: &str) -> bool {
    raw.bytes().all(|byte| byte.is_ascii_digit())
}

#[derive(Debug, Error)]
#[error("{message}")]
pub struct ApiError {
    pub status: StatusCode,
    pub error_type: &'static str,
    pub code: &'static str,
    pub message: String,
    pub retryable: bool,
    pub request_id: Option<String>,
    retry_hints: Option<Box<RetryHints>>,
}

impl ApiError {
    pub fn new(
        status: StatusCode,
        error_type: &'static str,
        code: &'static str,
        message: impl Into<String>,
    ) -> Self {
        Self {
            status,
            error_type,
            code,
            message: message.into(),
            retryable: false,
            request_id: None,
            retry_hints: None,
        }
    }

    pub fn retryable(mut self) -> Self {
        self.retryable = true;
        self
    }

    pub fn with_request_id(mut self, request_id: Option<String>) -> Self {
        self.request_id = request_id;
        self
    }

    pub(crate) fn with_retry_hints(mut self, retry_hints: RetryHints) -> Self {
        self.retry_hints = Some(Box::new(retry_hints));
        self
    }

    pub fn body(&self) -> Value {
        json!({
            "type": "error",
            "request_id": self.request_id,
            "error": { "type": self.error_type, "message": self.message }
        })
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let retryable = self.retryable;
        let status = self.status;
        let mut response = (status, Json(self.body())).into_response();
        if retryable {
            response
                .headers_mut()
                .insert("x-should-retry", http::HeaderValue::from_static("true"));
            if let Some(retry_hints) = &self.retry_hints {
                retry_hints.apply(response.headers_mut());
            }
        }
        response
    }
}

pub fn error_type_for_status(status: StatusCode) -> &'static str {
    match status.as_u16() {
        400 => "invalid_request_error",
        401 => "authentication_error",
        402 => "billing_error",
        403 => "permission_error",
        404 => "not_found_error",
        409 => "conflict_error",
        413 => "request_too_large",
        429 => "rate_limit_error",
        504 => "timeout_error",
        529 => "overloaded_error",
        _ => "api_error",
    }
}

pub fn status_from_openai_error(error: &Value, http_status: StatusCode) -> StatusCode {
    if http_status.is_client_error() || http_status.is_server_error() {
        return http_status;
    }
    let detail_code = error
        .get("code")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    let type_code = error
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    let raw = infer_status_from_openai_error_code(&detail_code)
        .or_else(|| infer_status_from_openai_error_code(&type_code))
        .unwrap_or(502);
    StatusCode::from_u16(raw).unwrap_or(StatusCode::BAD_GATEWAY)
}

fn infer_status_from_openai_error_code(code: &str) -> Option<u16> {
    if code.is_empty() {
        None
    } else if code == "overloaded" || code == "overloaded_error" {
        Some(529)
    } else if code.contains("rate_limit") || code.contains("quota") {
        Some(429)
    } else if code.contains("billing") {
        Some(402)
    } else if code.contains("authentication")
        || code.contains("invalid_api_key")
        || code == "unauthorized"
    {
        Some(401)
    } else if code.contains("permission") || code == "forbidden" {
        Some(403)
    } else if code.contains("not_found") {
        Some(404)
    } else if code.contains("conflict") {
        Some(409)
    } else if code.contains("request_too_large") {
        Some(413)
    } else if code.contains("timeout") {
        Some(504)
    } else if code == "server_error" || code.contains("internal_error") {
        Some(500)
    } else if code.contains("invalid_request")
        || code.contains("unsupported")
        || code.contains("invalid_value")
        || code.starts_with("invalid_")
        || code.starts_with("empty_")
        || code.starts_with("failed_to_")
        || code == "bad_request"
    {
        Some(400)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn retry_hints_accept_only_single_bounded_protocol_values() {
        let mut headers = HeaderMap::new();
        headers.insert("retry-after", HeaderValue::from_static("17"));
        headers.insert("retry-after-ms", HeaderValue::from_static("250"));
        let mut output = HeaderMap::new();
        RetryHints::from_headers(&headers).apply(&mut output);
        assert_eq!(output["retry-after"], "17");
        assert_eq!(output["retry-after-ms"], "250");

        headers.insert(
            "retry-after",
            HeaderValue::from_static("Sun, 06 Nov 1994 08:49:37 GMT"),
        );
        let mut output = HeaderMap::new();
        RetryHints::from_headers(&headers).apply(&mut output);
        assert_eq!(output["retry-after"], "Sun, 06 Nov 1994 08:49:37 GMT");

        headers.append("retry-after", HeaderValue::from_static("18"));
        headers.insert("retry-after-ms", HeaderValue::from_static("12junk"));
        let mut output = HeaderMap::new();
        RetryHints::from_headers(&headers).apply(&mut output);
        assert!(output.get("retry-after").is_none());
        assert!(output.get("retry-after-ms").is_none());

        let mut headers = HeaderMap::new();
        headers.insert(
            "retry-after-ms",
            HeaderValue::from_str(&"1".repeat(MAX_RETRY_HINT_LENGTH)).unwrap(),
        );
        let mut output = HeaderMap::new();
        RetryHints::from_headers(&headers).apply(&mut output);
        assert_eq!(output["retry-after-ms"], "1".repeat(MAX_RETRY_HINT_LENGTH));

        headers.insert(
            "retry-after-ms",
            HeaderValue::from_str(&"1".repeat(MAX_RETRY_HINT_LENGTH + 1)).unwrap(),
        );
        let mut output = HeaderMap::new();
        RetryHints::from_headers(&headers).apply(&mut output);
        assert!(output.get("retry-after-ms").is_none());
    }

    #[test]
    fn logical_error_uses_known_code_before_type() {
        let status = status_from_openai_error(
            &json!({"code":"invalid_api_key","type":"invalid_request_error"}),
            StatusCode::OK,
        );
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    #[test]
    fn logical_error_falls_back_from_unknown_code_to_known_type() {
        let status = status_from_openai_error(
            &json!({"code":"vendor_model_error","type":"invalid_request_error"}),
            StatusCode::OK,
        );
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }
}
