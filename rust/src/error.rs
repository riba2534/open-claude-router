use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use thiserror::Error;

#[derive(Debug, Error)]
#[error("{message}")]
pub struct ApiError {
    pub status: StatusCode,
    pub error_type: &'static str,
    pub code: &'static str,
    pub message: String,
    pub retryable: bool,
    pub request_id: Option<String>,
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
