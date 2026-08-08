use std::{collections::HashSet, sync::Arc};

use axum::{
    Json, Router,
    body::{Body, Bytes},
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, Method, StatusCode, Uri, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde_json::{Value, json};
use tower_http::{catch_panic::CatchPanicLayer, trace::TraceLayer};
use tracing::{info, warn};

use crate::{
    auth::{
        Endpoint, UpstreamConfig, UpstreamFormat, apply_effort_controls, check_embedded_mode_auth,
        check_header_mode_auth, is_embedded_upstream_path, parse_access_tokens,
        parse_effort_levels, parse_effort_map, parse_embedded_upstream, parse_model_map,
        parse_upstream_config, parse_upstream_format, parse_upstream_headers,
        resolve_upstream_model,
    },
    error::ApiError,
    model_log::{ModelInteractionLogger, selected_headers},
    sse::{aggregate_chat_sse, aggregate_responses_sse},
    streaming::{convert_chat_sse_stream, convert_responses_sse_stream},
    tokenizer::count_anthropic_tokens,
    transform::{
        anthropic_json_to_sse, prepare_chat_request, transform_anthropic_request,
        transform_chat_json_response, transform_responses_json, transform_responses_request,
    },
    upstream::{call_upstream, upstream_http_error},
};

#[derive(Clone)]
pub struct AppState {
    pub client: reqwest::Client,
    pub access_tokens: HashSet<String>,
    pub model_logger: ModelInteractionLogger,
}

impl AppState {
    pub fn from_env(client: reqwest::Client) -> Self {
        let access_tokens = parse_access_tokens(std::env::var("OCR_ACCESS_TOKENS").ok().as_deref());
        if access_tokens.is_empty() {
            warn!(
                "service access token whitelist disabled — anyone with the URL can use this proxy"
            );
        } else {
            info!(
                count = access_tokens.len(),
                "service access token whitelist enabled"
            );
        }
        Self {
            client,
            access_tokens,
            model_logger: ModelInteractionLogger::from_env()
                .unwrap_or_else(|error| panic!("invalid model log configuration: {error}")),
        }
    }
}

pub fn build_app(state: Arc<AppState>) -> Router {
    Router::new()
        .route(
            "/",
            get(|| async {
                Json(json!({
                    "name":"open-claude-router",
                    "description":"routing-stateless Anthropic <-> OpenAI bridge — Rust high-concurrency implementation"
                }))
            }),
        )
        .route("/healthz", get(|| async { Json(json!({"status":"ok"})) }))
        .route("/v1/messages", post(header_messages))
        .route("/v1/messages/count_tokens", post(header_count_tokens))
        .fallback(fallback)
        .layer(DefaultBodyLimit::max(32 * 1024 * 1024))
        .layer(CatchPanicLayer::new())
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

async fn header_messages(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, ApiError> {
    check_header_mode_auth(&headers, &state.access_tokens)?;
    let format = parse_upstream_format(&headers)?;
    let mut upstream = parse_upstream_config(&headers)?;
    let payload = parse_json_body(&body)?;
    let model_map = parse_model_map(&headers)?;
    upstream.model = resolve_upstream_model(
        payload.get("model").and_then(Value::as_str),
        upstream.model.as_deref(),
        &model_map,
    );
    forward(state, headers, payload, format, upstream).await
}

async fn header_count_tokens(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, ApiError> {
    check_header_mode_auth(&headers, &state.access_tokens)?;
    let payload = parse_json_body(&body)?;
    Ok(Json(json!({"input_tokens":count_anthropic_tokens(&payload)})).into_response())
}

async fn fallback(
    State(state): State<Arc<AppState>>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, ApiError> {
    if method != Method::POST || !is_embedded_upstream_path(&uri) {
        return Err(ApiError::new(
            StatusCode::NOT_FOUND,
            "not_found_error",
            "not_found",
            format!("unknown path: {}", uri.path()),
        ));
    }
    check_embedded_mode_auth(&headers, &state.access_tokens)?;
    let format = parse_upstream_format(&headers)?;
    let (mut upstream, endpoint) = parse_embedded_upstream(&uri, &headers)?;
    let payload = parse_json_body(&body)?;
    if endpoint == Endpoint::CountTokens {
        return Ok(Json(json!({"input_tokens":count_anthropic_tokens(&payload)})).into_response());
    }
    let model_map = parse_model_map(&headers)?;
    upstream.model = resolve_upstream_model(
        payload.get("model").and_then(Value::as_str),
        upstream.model.as_deref(),
        &model_map,
    );
    forward(state, headers, payload, format, upstream).await
}

fn parse_json_body(bytes: &[u8]) -> Result<Value, ApiError> {
    let payload: Value = serde_json::from_slice(bytes).map_err(|error| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_request_error",
            "invalid_body",
            format!("request body must be valid JSON: {error}"),
        )
    })?;
    if !payload.is_object() {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_request_error",
            "invalid_body",
            "request body must be a JSON object",
        ));
    }
    Ok(payload)
}

async fn forward(
    state: Arc<AppState>,
    headers: HeaderMap,
    payload: Value,
    format: UpstreamFormat,
    upstream: UpstreamConfig,
) -> Result<Response, ApiError> {
    let wants_stream = payload.get("stream").and_then(Value::as_bool) == Some(true);
    let omit_thinking =
        payload.pointer("/thinking/display").and_then(Value::as_str) == Some("omitted");
    let mut outbound = transform_anthropic_request(&payload)?;
    if let Some(model) = upstream.model.as_ref() {
        outbound["model"] = Value::String(model.clone());
    }
    let effort_map = parse_effort_map(&headers)?;
    let effort_levels = parse_effort_levels(&headers)?;
    apply_effort_controls(&mut outbound, &effort_map, &effort_levels);
    match format {
        UpstreamFormat::ChatCompletions => prepare_chat_request(&mut outbound),
        UpstreamFormat::Responses => transform_responses_request(&mut outbound)?,
    }
    let extra_headers = parse_upstream_headers(&headers)?;
    let outbound_model = outbound
        .get("model")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("unknown");
    info!(
        model = outbound_model,
        stream = wants_stream,
        format = format.as_str(),
        "forwarding"
    );
    let exchange = state.model_logger.begin(
        uuid::Uuid::new_v4().to_string(),
        &upstream.url,
        format.as_str(),
        outbound.get("model").cloned(),
        wants_stream,
        &outbound,
    );
    let upstream_response = match call_upstream(
        &state.client,
        &upstream.url,
        &upstream.authorization,
        extra_headers,
        &outbound,
    )
    .await
    {
        Ok(response) => response,
        Err(error) => {
            state
                .model_logger
                .transport_error(&exchange, &error.message);
            return Err(error);
        }
    };
    let response_status = upstream_response.status();
    let response_headers = selected_headers(upstream_response.headers());
    let is_sse = upstream_response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.contains("text/event-stream"));
    if response_status.is_success() && is_sse && wants_stream {
        let capture = state.model_logger.streaming_capture(
            exchange,
            response_status.as_u16(),
            response_headers,
        );
        let body = match format {
            UpstreamFormat::ChatCompletions => Body::from_stream(convert_chat_sse_stream(
                upstream_response,
                omit_thinking,
                capture,
            )),
            UpstreamFormat::Responses => Body::from_stream(convert_responses_sse_stream(
                upstream_response,
                omit_thinking,
                capture,
            )),
        };
        let mut response = Response::new(body);
        response
            .headers_mut()
            .insert(header::CONTENT_TYPE, "text/event-stream".parse().unwrap());
        response
            .headers_mut()
            .insert(header::CACHE_CONTROL, "no-cache".parse().unwrap());
        return Ok(response);
    }
    let response_bytes = upstream_response.bytes().await.map_err(|error| {
        let api_error = ApiError::new(
            StatusCode::BAD_GATEWAY,
            "api_error",
            "upstream_stream_error",
            format!("upstream response read failed: {error}"),
        );
        state
            .model_logger
            .transport_error(&exchange, &api_error.message);
        api_error
    })?;
    state.model_logger.response(
        &exchange,
        response_status.as_u16(),
        response_headers,
        &response_bytes,
        true,
    );
    if !response_status.is_success() {
        return Err(upstream_http_error(response_status, &response_bytes));
    }
    let upstream_payload = if is_sse {
        match format {
            UpstreamFormat::ChatCompletions => aggregate_chat_sse(response_bytes)?,
            UpstreamFormat::Responses => aggregate_responses_sse(response_bytes)?,
        }
    } else {
        serde_json::from_slice::<Value>(&response_bytes).map_err(|error| {
            ApiError::new(
                StatusCode::BAD_GATEWAY,
                "api_error",
                "upstream_protocol_error",
                format!("upstream response is not valid JSON: {error}"),
            )
        })?
    };
    let anthropic = match format {
        UpstreamFormat::ChatCompletions => {
            transform_chat_json_response(&upstream_payload, omit_thinking)?
        }
        UpstreamFormat::Responses => transform_responses_json(&upstream_payload, omit_thinking)?,
    };
    if wants_stream {
        let text = anthropic_json_to_sse(&anthropic)?;
        let mut response = Response::new(Body::from(text));
        response
            .headers_mut()
            .insert(header::CONTENT_TYPE, "text/event-stream".parse().unwrap());
        response
            .headers_mut()
            .insert(header::CACHE_CONTROL, "no-cache".parse().unwrap());
        Ok(response)
    } else {
        Ok(Json(anthropic).into_response())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::to_bytes, http::Request};
    use tower::ServiceExt;

    fn state() -> Arc<AppState> {
        Arc::new(AppState {
            client: reqwest::Client::new(),
            access_tokens: HashSet::new(),
            model_logger: ModelInteractionLogger::disabled(),
        })
    }

    #[tokio::test]
    async fn health_endpoint() {
        let response = build_app(state())
            .oneshot(
                Request::builder()
                    .uri("/healthz")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            to_bytes(response.into_body(), 1024).await.unwrap(),
            Bytes::from_static(b"{\"status\":\"ok\"}")
        );
    }

    #[tokio::test]
    async fn missing_upstream_is_anthropic_error() {
        let response = build_app(state())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/messages")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"messages":[]}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body = to_bytes(response.into_body(), 4096).await.unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&body).unwrap()["type"],
            "error"
        );
    }
}
