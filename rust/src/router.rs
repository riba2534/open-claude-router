use std::{
    collections::HashSet,
    convert::Infallible,
    net::{IpAddr, SocketAddr},
    sync::Arc,
};

use axum::{
    Json, Router,
    body::{Body, Bytes},
    extract::{ConnectInfo, DefaultBodyLimit, FromRequestParts, State, rejection::BytesRejection},
    http::{HeaderMap, Method, StatusCode, Uri, header, request::Parts},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde_json::{Value, json};
use tower_http::{catch_panic::CatchPanicLayer, trace::TraceLayer};
use tracing::{info, warn};

use crate::{
    auth::{
        Endpoint, UpstreamConfig, UpstreamFormat, apply_effort_controls, check_embedded_mode_auth,
        check_header_mode_auth, is_embedded_upstream_path, parse_access_tokens, parse_client_tag,
        parse_effort_levels, parse_effort_map, parse_embedded_upstream, parse_model_map,
        parse_upstream_config, parse_upstream_format, parse_upstream_headers,
        resolve_upstream_model,
    },
    error::{ApiError, RetryHints},
    model_log::{ExchangeMetadata, ModelInteractionLogger, selected_headers},
    sse::{aggregate_chat_sse, aggregate_responses_sse},
    streaming::{convert_chat_sse_stream_with_tool_names, convert_responses_sse_stream},
    tokenizer::count_anthropic_tokens,
    transform::{
        anthropic_json_to_sse, prepare_chat_request_with_tool_names, transform_anthropic_request,
        transform_chat_json_response_with_tool_names, transform_responses_json,
        transform_responses_request, validate_final_outbound_request,
    },
    upstream::{call_upstream, read_upstream_body, upstream_http_error},
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
                    "description":"routing-stateless Anthropic <-> OpenAI bridge — pass X-Upstream-Url + X-Upstream-Authorization (+ X-Upstream-Model) headers per request"
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

/// The production server injects `ConnectInfo<SocketAddr>` per TCP
/// connection. Keeping this extractor infallible preserves direct Router
/// unit tests and non-socket service use, where the audit field is `null`.
struct ClientPeer(Option<SocketAddr>);

impl<S> FromRequestParts<S> for ClientPeer
where
    S: Send + Sync,
{
    type Rejection = Infallible;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        Ok(Self(
            parts
                .extensions
                .get::<ConnectInfo<SocketAddr>>()
                .map(|connect_info| connect_info.0),
        ))
    }
}

fn canonical_client_ip(peer: Option<SocketAddr>) -> Option<String> {
    match peer?.ip() {
        IpAddr::V6(ip) if ip.to_ipv4_mapped().is_some() => {
            ip.to_ipv4_mapped().map(|ip| ip.to_string())
        }
        ip => Some(ip.to_string()),
    }
}

async fn header_messages(
    ClientPeer(peer): ClientPeer,
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> Result<Response, ApiError> {
    let body = extract_body(body)?;
    ensure_json_content_type(&headers)?;
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
    forward(
        state,
        headers,
        payload,
        format,
        upstream,
        canonical_client_ip(peer),
        "header",
    )
    .await
}

async fn header_count_tokens(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> Result<Response, ApiError> {
    let body = extract_body(body)?;
    ensure_json_content_type(&headers)?;
    check_header_mode_auth(&headers, &state.access_tokens)?;
    let payload = parse_json_body(&body)?;
    Ok(Json(json!({"input_tokens":count_anthropic_tokens(&payload)})).into_response())
}

async fn fallback(
    ClientPeer(peer): ClientPeer,
    State(state): State<Arc<AppState>>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> Result<Response, ApiError> {
    let body = extract_body(body)?;
    if method != Method::POST || !is_embedded_upstream_path(&uri) {
        return Err(ApiError::new(
            StatusCode::NOT_FOUND,
            "not_found_error",
            "not_found",
            format!("unknown path: {}", uri.path()),
        ));
    }
    ensure_json_content_type(&headers)?;
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
    forward(
        state,
        headers,
        payload,
        format,
        upstream,
        canonical_client_ip(peer),
        "embedded-path",
    )
    .await
}

fn extract_body(body: Result<Bytes, BytesRejection>) -> Result<Bytes, ApiError> {
    body.map_err(|rejection| {
        if rejection.status() == StatusCode::PAYLOAD_TOO_LARGE {
            ApiError::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                "request_too_large",
                "request_too_large",
                "Request body is too large",
            )
        } else {
            ApiError::new(
                StatusCode::BAD_REQUEST,
                "invalid_request_error",
                "invalid_body",
                rejection.body_text(),
            )
        }
    })
}

fn ensure_json_content_type(headers: &HeaderMap) -> Result<(), ApiError> {
    let raw = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    let media_type = raw
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    let is_json = media_type == "application/json"
        || (media_type.starts_with("application/") && media_type.ends_with("+json"));
    if is_json {
        return Ok(());
    }
    Err(ApiError::new(
        StatusCode::UNSUPPORTED_MEDIA_TYPE,
        "invalid_request_error",
        "unsupported_media_type",
        if raw.is_empty() {
            "Content-Type must be application/json".to_owned()
        } else {
            format!("unsupported Content-Type: {raw} (expected application/json)")
        },
    ))
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
    client_ip: Option<String>,
    route_mode: &str,
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
    validate_final_outbound_request(&outbound)?;
    let chat_tool_names = match format {
        UpstreamFormat::ChatCompletions => {
            Some(prepare_chat_request_with_tool_names(&mut outbound))
        }
        UpstreamFormat::Responses => {
            transform_responses_request(&mut outbound)?;
            None
        }
    };
    let extra_headers = parse_upstream_headers(&headers)?;
    let outbound_model = outbound
        .get("model")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("unknown");
    let request_id = uuid::Uuid::new_v4().to_string();
    info!(
        request_id,
        model = outbound_model,
        stream = wants_stream,
        format = format.as_str(),
        "forwarding"
    );
    let mut exchange = state.model_logger.begin(
        ExchangeMetadata {
            request_id,
            upstream_url: upstream.url.clone(),
            format: format.as_str().to_owned(),
            model: outbound.get("model").cloned(),
            stream: wants_stream,
            client_ip,
            client_tag: parse_client_tag(&headers),
            route_mode: route_mode.to_owned(),
        },
        Some(&payload),
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
                .transport_error(&mut exchange, &error.message);
            return Err(error);
        }
    };
    exchange.mark_upstream_response_started();
    let response_status = upstream_response.status();
    let retry_hints = RetryHints::from_headers(upstream_response.headers());
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
            UpstreamFormat::ChatCompletions => {
                Body::from_stream(convert_chat_sse_stream_with_tool_names(
                    upstream_response,
                    omit_thinking,
                    capture,
                    chat_tool_names.clone().unwrap_or_default(),
                ))
            }
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
        retry_hints.apply(response.headers_mut());
        return Ok(response);
    }
    let (response_bytes, read_error) = read_upstream_body(upstream_response).await;
    if let Some(error) = read_error {
        state.model_logger.response_read_error(
            &mut exchange,
            response_status.as_u16(),
            response_headers,
            &response_bytes,
            &error,
        );
        if !response_status.is_success() {
            return Err(
                upstream_http_error(response_status, &response_bytes).with_retry_hints(retry_hints)
            );
        }
        return Err(ApiError::new(
            StatusCode::BAD_GATEWAY,
            "api_error",
            "upstream_stream_error",
            format!("upstream response read failed: {error}"),
        )
        .retryable()
        .with_retry_hints(retry_hints));
    }
    state.model_logger.response(
        &mut exchange,
        response_status.as_u16(),
        response_headers,
        &response_bytes,
        true,
    );
    if !response_status.is_success() {
        return Err(
            upstream_http_error(response_status, &response_bytes).with_retry_hints(retry_hints)
        );
    }
    let upstream_payload = if is_sse {
        match format {
            UpstreamFormat::ChatCompletions => aggregate_chat_sse(response_bytes),
            UpstreamFormat::Responses => aggregate_responses_sse(response_bytes),
        }
        .map_err(|error| error.with_retry_hints(retry_hints.clone()))?
    } else {
        serde_json::from_slice::<Value>(&response_bytes).map_err(|error| {
            ApiError::new(
                StatusCode::BAD_GATEWAY,
                "api_error",
                "upstream_protocol_error",
                format!("upstream response is not valid JSON: {error}"),
            )
            .retryable()
            .with_retry_hints(retry_hints.clone())
        })?
    };
    let anthropic = match format {
        UpstreamFormat::ChatCompletions => transform_chat_json_response_with_tool_names(
            &upstream_payload,
            omit_thinking,
            chat_tool_names
                .as_ref()
                .expect("chat tool names initialized"),
        )
        .map_err(|error| error.with_retry_hints(retry_hints.clone()))?,
        UpstreamFormat::Responses => transform_responses_json(&upstream_payload, omit_thinking)
            .map_err(|error| error.with_retry_hints(retry_hints.clone()))?,
    };
    if wants_stream {
        let text = anthropic_json_to_sse(&anthropic)
            .map_err(|error| error.with_retry_hints(retry_hints))?;
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

    #[test]
    fn client_ip_is_canonicalized_from_socket_peer() {
        assert_eq!(
            canonical_client_ip(Some("192.0.2.10:1234".parse().unwrap())),
            Some("192.0.2.10".into())
        );
        assert_eq!(
            canonical_client_ip(Some("[::ffff:192.0.2.11]:1234".parse().unwrap())),
            Some("192.0.2.11".into())
        );
        assert_eq!(canonical_client_ip(None), None);
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
    async fn root_metadata_is_stable() {
        let response = build_app(state())
            .oneshot(Request::builder().uri("/").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.unwrap()).unwrap();
        assert_eq!(
            body["description"],
            "routing-stateless Anthropic <-> OpenAI bridge — pass X-Upstream-Url + X-Upstream-Authorization (+ X-Upstream-Model) headers per request"
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
