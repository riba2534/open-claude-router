use std::{
    collections::{HashSet, VecDeque},
    convert::Infallible,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};

use axum::{
    Json, Router,
    body::{Body, Bytes, to_bytes},
    extract::{Path, State},
    http::{HeaderMap, Request, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
};
use futures_util::StreamExt;
use open_claude_router::{AppState, build_app, model_log::ModelInteractionLogger};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::{Mutex, oneshot},
    time::Duration,
};
use tower::ServiceExt;

#[derive(Clone, Default)]
struct MockState {
    requests: Arc<Mutex<VecDeque<(HeaderMap, Value)>>>,
    count: Arc<AtomicUsize>,
}

async fn chat_upstream(
    State(state): State<MockState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Json<Value> {
    state.count.fetch_add(1, Ordering::SeqCst);
    state.requests.lock().await.push_back((headers, body));
    Json(json!({
        "id":"chatcmpl-contract","object":"chat.completion","model":"upstream-chat",
        "choices":[{"index":0,"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}],
        "usage":{"prompt_tokens":5,"completion_tokens":1,"total_tokens":6,"prompt_tokens_details":{"cached_tokens":2}}
    }))
}

async fn responses_upstream(
    State(state): State<MockState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Json<Value> {
    state.count.fetch_add(1, Ordering::SeqCst);
    state.requests.lock().await.push_back((headers, body));
    Json(json!({
        "id":"resp_contract","object":"response","status":"completed","model":"upstream-responses",
        "output":[
            {"type":"reasoning","id":"reason_1","summary":[{"type":"summary_text","text":"thinking"}],"encrypted_content":"opaque"},
            {"type":"message","id":"msg_1","status":"completed","role":"assistant","content":[{"type":"output_text","text":"done"}]}
        ],
        "usage":{"input_tokens":7,"output_tokens":3,"total_tokens":10,"input_tokens_details":{"cached_tokens":1},"output_tokens_details":{"reasoning_tokens":2}}
    }))
}

async fn status_upstream(
    State(state): State<MockState>,
    Path(status): Path<u16>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    state.count.fetch_add(1, Ordering::SeqCst);
    state.requests.lock().await.push_back((headers, body));
    (
        StatusCode::from_u16(status).unwrap(),
        Json(json!({"error":{"message":format!("upstream {status}")}})),
    )
}

async fn truncated_status_upstream(
    State(state): State<MockState>,
    Path(status): Path<u16>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    state.count.fetch_add(1, Ordering::SeqCst);
    state.requests.lock().await.push_back((headers, body));
    let stream = async_stream::stream! {
        yield Ok::<_, std::io::Error>(Bytes::from_static(b"{\"error\":{\"message\":\"partial"));
        tokio::time::sleep(Duration::from_millis(25)).await;
        yield Err(std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "mock response body truncated"));
    };
    let mut response = Response::new(Body::from_stream(stream));
    *response.status_mut() = StatusCode::from_u16(status).unwrap();
    response
        .headers_mut()
        .insert("content-type", "application/json".parse().unwrap());
    response
}

async fn slow_upstream(State(state): State<MockState>, Json(_body): Json<Value>) -> Json<Value> {
    state.count.fetch_add(1, Ordering::SeqCst);
    tokio::time::sleep(Duration::from_secs(2)).await;
    Json(json!({
        "id":"slow","object":"chat.completion","model":"upstream-chat",
        "choices":[{"index":0,"message":{"role":"assistant","content":"late"},"finish_reason":"stop"}]
    }))
}

async fn logical_error_upstream(Json(_body): Json<Value>) -> Json<Value> {
    Json(json!({
        "error":{
            "message":"bad request according to generic type",
            "code":"vendor_model_error",
            "type":"invalid_request_error"
        }
    }))
}

async fn malformed_json_upstream(
    State(state): State<MockState>,
    Json(body): Json<Value>,
) -> Response {
    state.count.fetch_add(1, Ordering::SeqCst);
    state
        .requests
        .lock()
        .await
        .push_back((HeaderMap::new(), body));
    let mut response = Response::new(Body::from("{not-json"));
    response
        .headers_mut()
        .insert("content-type", "application/json".parse().unwrap());
    response
}

async fn chat_stream_upstream(Json(_body): Json<Value>) -> Response {
    let stream = async_stream::stream! {
        yield Ok::<_, Infallible>(Bytes::from_static(
            b"data: {\"id\":\"stream_1\",\"model\":\"stream-model\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"first\"},\"finish_reason\":null}]}\n\n",
        ));
        tokio::time::sleep(Duration::from_millis(250)).await;
        yield Ok::<_, Infallible>(Bytes::from_static(
            b"data: {\"id\":\"stream_1\",\"model\":\"stream-model\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\" second\"},\"finish_reason\":\"stop\"}]}\n\ndata: {\"choices\":[],\"usage\":{\"prompt_tokens\":4,\"completion_tokens\":2,\"total_tokens\":6}}\n\ndata: [DONE]\n\n",
        ));
    };
    let mut response = Response::new(Body::from_stream(stream));
    response
        .headers_mut()
        .insert("content-type", "text/event-stream".parse().unwrap());
    response
}

async fn truncated_chat_stream_upstream(Json(_body): Json<Value>) -> Response {
    let mut response = Response::new(Body::from(
        "data: {\"id\":\"truncated\",\"model\":\"m\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"partial\"},\"finish_reason\":null}]}\n\n",
    ));
    response
        .headers_mut()
        .insert("content-type", "text/event-stream".parse().unwrap());
    response
}

async fn responses_stream_upstream(Json(_body): Json<Value>) -> Response {
    let stream = async_stream::stream! {
        yield Ok::<_, Infallible>(Bytes::from_static(
            b"data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_stream\",\"model\":\"responses-model\",\"status\":\"in_progress\",\"output\":[]}}\n\ndata: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"type\":\"message\",\"id\":\"item_1\",\"role\":\"assistant\",\"status\":\"in_progress\",\"content\":[]}}\n\ndata: {\"type\":\"response.output_text.delta\",\"output_index\":0,\"item_id\":\"item_1\",\"content_index\":0,\"delta\":\"first\"}\n\n",
        ));
        tokio::time::sleep(Duration::from_millis(250)).await;
        yield Ok::<_, Infallible>(Bytes::from_static(
            b"data: {\"type\":\"response.output_text.done\",\"output_index\":0,\"item_id\":\"item_1\",\"content_index\":0,\"text\":\"first second\"}\n\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_stream\",\"model\":\"responses-model\",\"status\":\"completed\",\"output\":[],\"usage\":{\"input_tokens\":3,\"output_tokens\":2,\"total_tokens\":5}}}\n\ndata: [DONE]\n\n",
        ));
    };
    let mut response = Response::new(Body::from_stream(stream));
    response
        .headers_mut()
        .insert("content-type", "text/event-stream".parse().unwrap());
    response
}

async fn truncated_responses_stream_upstream(Json(_body): Json<Value>) -> Response {
    let mut response = Response::new(Body::from(
        "data: {\"type\":\"response.output_text.delta\",\"output_index\":0,\"item_id\":\"item_1\",\"content_index\":0,\"delta\":\"partial\"}\n\n",
    ));
    response
        .headers_mut()
        .insert("content-type", "text/event-stream".parse().unwrap());
    response
}

async fn start_mock() -> (String, MockState) {
    let state = MockState::default();
    let app = Router::new()
        .route("/chat", post(chat_upstream))
        .route("/responses", post(responses_upstream))
        .route("/chat-stream", post(chat_stream_upstream))
        .route("/chat-truncated", post(truncated_chat_stream_upstream))
        .route("/responses-stream", post(responses_stream_upstream))
        .route(
            "/responses-truncated",
            post(truncated_responses_stream_upstream),
        )
        .route("/status/{status}", post(status_upstream))
        .route(
            "/status-truncated/{status}",
            post(truncated_status_upstream),
        )
        .route("/slow", post(slow_upstream))
        .route("/logical-error", post(logical_error_upstream))
        .route("/malformed-json", post(malformed_json_upstream))
        .with_state(state.clone());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://{addr}"), state)
}

async fn start_hanging_upstream() -> (String, oneshot::Receiver<()>, oneshot::Receiver<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let (started_tx, started_rx) = oneshot::channel();
    let (closed_tx, closed_rx) = oneshot::channel();
    tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        let mut buffer = [0_u8; 4096];
        loop {
            let count = socket.read(&mut buffer).await.unwrap();
            if count == 0 {
                return;
            }
            request.extend_from_slice(&buffer[..count]);
            let Some(header_end) = request.windows(4).position(|part| part == b"\r\n\r\n") else {
                continue;
            };
            let headers = String::from_utf8_lossy(&request[..header_end]);
            let content_length = headers
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().ok())
                        .flatten()
                })
                .unwrap_or(0);
            if request.len() >= header_end + 4 + content_length {
                break;
            }
        }
        let _ = started_tx.send(());
        loop {
            match socket.read(&mut buffer).await {
                Ok(0) | Err(_) => {
                    let _ = closed_tx.send(());
                    return;
                }
                Ok(_) => {}
            }
        }
    });
    (format!("http://{addr}/hang"), started_rx, closed_rx)
}

fn test_router() -> Router {
    build_app(Arc::new(AppState {
        client: reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap(),
        access_tokens: HashSet::new(),
        model_logger: ModelInteractionLogger::disabled(),
    }))
}

fn test_router_with_client(client: reqwest::Client) -> Router {
    build_app(Arc::new(AppState {
        client,
        access_tokens: HashSet::new(),
        model_logger: ModelInteractionLogger::disabled(),
    }))
}

fn anthropic_body(stream: bool) -> Value {
    json!({
        "model":"claude-client","max_tokens":32,"stream":stream,
        "system":"system prompt",
        "messages":[{"role":"user","content":[
            {"type":"text","text":"hello"},
            {"type":"image","source":{"type":"base64","media_type":"image/png","data":"AA=="}}
        ]}],
        "tools":[{"name":"read","description":"read file","input_schema":{"type":"object","properties":{"path":{"type":"string"}}}}],
        "tool_choice":{"type":"auto"}
    })
}

async fn send(router: Router, url: &str, upstream: &str, body: Value) -> axum::response::Response {
    router
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(url)
                .header("content-type", "application/json")
                .header("x-upstream-url", upstream)
                .header("x-upstream-authorization", "Custom upstream-secret")
                .body(Body::from(serde_json::to_vec(&body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap()
}

#[tokio::test]
async fn chat_route_converts_both_protocol_boundaries_and_isolates_headers() {
    let (base, mock) = start_mock().await;
    let response = test_router()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/messages")
                .header("content-type", "application/json")
                .header("x-upstream-url", format!("{base}/chat"))
                .header("x-upstream-authorization", "Custom upstream-secret")
                .header("x-upstream-model", "mapped-model")
                .header("x-upstream-headers", r#"{"x-tenant":"tenant-a"}"#)
                .header("anthropic-version", "must-not-leak")
                .header("user-agent", "must-not-leak")
                .body(Body::from(
                    serde_json::to_vec(&anthropic_body(false)).unwrap(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let result: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 1 << 20).await.unwrap()).unwrap();
    assert_eq!(result["type"], "message");
    assert_eq!(result["stop_reason"], "end_turn");
    assert_eq!(result.pointer("/content/0/text"), Some(&json!("ok")));
    assert_eq!(result.pointer("/usage/input_tokens"), Some(&json!(3)));

    let (headers, outbound) = mock.requests.lock().await.pop_front().unwrap();
    assert_eq!(headers["authorization"], "Custom upstream-secret");
    assert_eq!(headers["x-tenant"], "tenant-a");
    assert!(headers.get("anthropic-version").is_none());
    assert_ne!(
        headers
            .get("user-agent")
            .and_then(|value| value.to_str().ok()),
        Some("must-not-leak")
    );
    assert_eq!(outbound["model"], "mapped-model");
    assert_eq!(
        outbound.pointer("/messages/1/content/1/type"),
        Some(&json!("image_url"))
    );
    assert!(outbound.get("reasoning").is_none());
}

#[tokio::test]
async fn responses_route_maps_request_and_returns_replayable_reasoning() {
    let (base, mock) = start_mock().await;
    let mut body = anthropic_body(false);
    body["thinking"] = json!({"type":"enabled","budget_tokens":4096});
    let response = test_router()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/messages")
                .header("content-type", "application/json")
                .header("x-upstream-url", format!("{base}/responses"))
                .header("x-upstream-authorization", "Bearer secret")
                .header("x-upstream-format", "responses")
                .body(Body::from(serde_json::to_vec(&body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let result: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 1 << 20).await.unwrap()).unwrap();
    assert_eq!(result.pointer("/content/0/type"), Some(&json!("thinking")));
    assert!(
        result
            .pointer("/content/0/signature")
            .and_then(Value::as_str)
            .unwrap()
            .starts_with("ocr-responses-reasoning-v1:")
    );
    assert_eq!(result.pointer("/content/1/text"), Some(&json!("done")));
    assert_eq!(
        result.pointer("/usage/output_tokens_details/thinking_tokens"),
        Some(&json!(2))
    );

    let (_, outbound) = mock.requests.lock().await.pop_front().unwrap();
    assert_eq!(outbound["max_output_tokens"], 32);
    assert!(outbound.get("max_tokens").is_none());
    assert_eq!(outbound["include"], json!(["reasoning.encrypted_content"]));
    assert_eq!(
        outbound.pointer("/input/1/content/1/type"),
        Some(&json!("input_image"))
    );
}

#[tokio::test]
async fn responses_sse_is_incrementally_parsed_and_synthesized() {
    let (base, _) = start_mock().await;
    let response = test_router()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/messages")
                .header("content-type", "application/json")
                .header("x-upstream-url", format!("{base}/responses-stream"))
                .header("x-upstream-authorization", "Bearer secret")
                .header("x-upstream-format", "responses")
                .body(Body::from(
                    serde_json::to_vec(&anthropic_body(true)).unwrap(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let mut stream = response.into_body().into_data_stream();
    let first = tokio::time::timeout(Duration::from_millis(150), stream.next())
        .await
        .expect("Responses text must start before the delayed terminal event")
        .unwrap()
        .unwrap();
    assert!(
        String::from_utf8(first.to_vec())
            .unwrap()
            .contains("message_start")
    );
    let mut rest = String::new();
    while let Some(chunk) = stream.next().await {
        rest.push_str(std::str::from_utf8(&chunk.unwrap()).unwrap());
    }
    assert!(rest.contains("first"));
    assert!(rest.contains(" second"));
    assert!(rest.contains("event: message_stop"));
    assert!(!rest.contains("event: error"));
}

#[tokio::test]
async fn truncated_responses_sse_never_claims_success() {
    let (base, _) = start_mock().await;
    let response = test_router()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/messages")
                .header("content-type", "application/json")
                .header("x-upstream-url", format!("{base}/responses-truncated"))
                .header("x-upstream-authorization", "Bearer secret")
                .header("x-upstream-format", "responses")
                .body(Body::from(
                    serde_json::to_vec(&anthropic_body(true)).unwrap(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    let body = String::from_utf8(
        to_bytes(response.into_body(), 1 << 20)
            .await
            .unwrap()
            .to_vec(),
    )
    .unwrap();
    assert!(body.contains("event: error"));
    assert!(!body.contains("event: message_stop"));
}

#[tokio::test]
async fn every_upstream_error_is_single_attempt_and_retryable() {
    let (base, mock) = start_mock().await;
    for status in [
        300, 400, 401, 402, 403, 404, 408, 409, 413, 422, 429, 500, 502, 504, 529,
    ] {
        let before = mock.count.load(Ordering::SeqCst);
        let response = send(
            test_router(),
            "/v1/messages",
            &format!("{base}/status/{status}"),
            anthropic_body(false),
        )
        .await;
        assert_eq!(response.status().as_u16(), status);
        assert_eq!(response.headers()["x-should-retry"], "true");
        assert_eq!(mock.count.load(Ordering::SeqCst), before + 1);
    }
}

#[tokio::test]
async fn truncated_non_2xx_body_keeps_status_type_retry_and_single_attempt() {
    let (base, mock) = start_mock().await;
    let response = send(
        test_router(),
        "/v1/messages",
        &format!("{base}/status-truncated/429"),
        anthropic_body(false),
    )
    .await;
    assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(response.headers()["x-should-retry"], "true");
    let body: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 1 << 20).await.unwrap()).unwrap();
    assert_eq!(
        body.pointer("/error/type"),
        Some(&json!("rate_limit_error"))
    );
    assert_eq!(mock.count.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn successful_response_body_read_failure_is_retryable_bad_gateway() {
    let (base, mock) = start_mock().await;
    let response = send(
        test_router(),
        "/v1/messages",
        &format!("{base}/status-truncated/200"),
        anthropic_body(false),
    )
    .await;
    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
    assert_eq!(response.headers()["x-should-retry"], "true");
    assert_eq!(mock.count.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn malformed_success_json_is_retryable_bad_gateway_and_single_attempt() {
    let (base, mock) = start_mock().await;
    let response = send(
        test_router(),
        "/v1/messages",
        &format!("{base}/malformed-json"),
        anthropic_body(false),
    )
    .await;
    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
    assert_eq!(response.headers()["x-should-retry"], "true");
    let body: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 1 << 20).await.unwrap()).unwrap();
    assert_eq!(body.pointer("/error/type"), Some(&json!("api_error")));
    assert_eq!(mock.count.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn upstream_timeout_is_retryable_bad_gateway_and_never_retried_in_router() {
    let (base, mock) = start_mock().await;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(50))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    let response = send(
        test_router_with_client(client),
        "/v1/messages",
        &format!("{base}/slow"),
        anthropic_body(false),
    )
    .await;
    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
    assert_eq!(response.headers()["x-should-retry"], "true");
    assert_eq!(mock.count.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn unknown_logical_error_code_falls_back_to_known_type_for_both_formats() {
    let (base, _) = start_mock().await;
    for format in [None, Some("responses")] {
        let mut request = Request::builder()
            .method("POST")
            .uri("/v1/messages")
            .header("content-type", "application/json")
            .header("x-upstream-url", format!("{base}/logical-error"))
            .header("x-upstream-authorization", "Bearer secret");
        if let Some(format) = format {
            request = request.header("x-upstream-format", format);
        }
        let response = test_router()
            .oneshot(
                request
                    .body(Body::from(
                        serde_json::to_vec(&anthropic_body(false)).unwrap(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let retry = response.headers().get("x-should-retry").cloned();
        let body: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 1 << 20).await.unwrap())
                .unwrap();
        assert_eq!(
            status,
            StatusCode::BAD_REQUEST,
            "format={format:?}, body={body}"
        );
        assert_eq!(retry.as_ref().unwrap(), "true");
        assert_eq!(
            body.pointer("/error/type"),
            Some(&json!("invalid_request_error"))
        );
    }
}

#[tokio::test]
async fn json_post_routes_reject_missing_content_type_with_415() {
    let (base, mock) = start_mock().await;
    let body = serde_json::to_vec(&anthropic_body(false)).unwrap();
    let header_response = test_router()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/messages")
                .header("x-upstream-url", format!("{base}/chat"))
                .header("x-upstream-authorization", "Bearer secret")
                .body(Body::from(body.clone()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(header_response.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);

    let authority = base.strip_prefix("http://").unwrap();
    let embedded_response = test_router()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/http://{authority}/chat/v1/messages"))
                .header("authorization", "Bearer upstream-secret")
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        embedded_response.status(),
        StatusCode::UNSUPPORTED_MEDIA_TYPE
    );
    assert_eq!(mock.count.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn count_tokens_validates_required_fields_in_both_access_modes() {
    let invalid = json!({"messages":[]});
    let serialized = serde_json::to_vec(&invalid).unwrap();
    let header_response = test_router()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/messages/count_tokens")
                .header("content-type", "application/json")
                .body(Body::from(serialized.clone()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(header_response.status(), StatusCode::BAD_REQUEST);
    let error: Value = serde_json::from_slice(
        &to_bytes(header_response.into_body(), 1 << 20)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        error.pointer("/error/message"),
        Some(&json!("model must be a non-empty string"))
    );

    let embedded_response = test_router()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/https://upstream.example.com/v1/messages/count_tokens")
                .header("content-type", "application/json")
                .header("authorization", "Bearer upstream-secret")
                .body(Body::from(serialized))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(embedded_response.status(), StatusCode::BAD_REQUEST);
    let error: Value = serde_json::from_slice(
        &to_bytes(embedded_response.into_body(), 1 << 20)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        error.pointer("/error/message"),
        Some(&json!("model must be a non-empty string"))
    );
}

#[tokio::test]
async fn downstream_disconnect_before_headers_cancels_upstream_request() {
    let (upstream, started, closed) = start_hanging_upstream().await;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        axum::serve(listener, test_router()).await.unwrap();
    });

    let payload = serde_json::to_vec(&anthropic_body(false)).unwrap();
    let mut downstream = TcpStream::connect(addr).await.unwrap();
    let request = format!(
        "POST /v1/messages HTTP/1.1\r\nHost: {addr}\r\nContent-Type: application/json\r\nX-Upstream-Url: {upstream}\r\nX-Upstream-Authorization: Bearer secret\r\nContent-Length: {}\r\n\r\n",
        payload.len()
    );
    downstream.write_all(request.as_bytes()).await.unwrap();
    downstream.write_all(&payload).await.unwrap();
    tokio::time::timeout(Duration::from_secs(2), started)
        .await
        .expect("router must start the upstream request")
        .unwrap();
    drop(downstream);
    tokio::time::timeout(Duration::from_secs(2), closed)
        .await
        .expect("dropping the downstream connection must cancel the pending reqwest future")
        .unwrap();
    server.abort();
}

#[tokio::test]
async fn embedded_path_preserves_upstream_authorization_value() {
    let (base, mock) = start_mock().await;
    let authority = base.strip_prefix("http://").unwrap();
    let uri = format!("/http://{authority}/chat/v1/messages");
    let response = test_router()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(uri)
                .header("content-type", "application/json")
                .header("authorization", "Bearer Custom upstream-value")
                .body(Body::from(
                    serde_json::to_vec(&anthropic_body(false)).unwrap(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let (headers, _) = mock.requests.lock().await.pop_front().unwrap();
    assert_eq!(headers["authorization"], "Custom upstream-value");
}

#[tokio::test]
async fn file_map_is_applied_in_header_and_embedded_modes_without_leaking_client_id() {
    let (base, mock) = start_mock().await;
    let mut body = anthropic_body(false);
    body["messages"][0]["content"] = json!([{
        "type":"image",
        "source":{"type":"file","file_id":"file-client"}
    }]);
    let serialized = serde_json::to_vec(&body).unwrap();
    let header_response = test_router()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/messages")
                .header("content-type", "application/json")
                .header("x-upstream-url", format!("{base}/chat"))
                .header("x-upstream-authorization", "Bearer secret")
                .header("x-upstream-file-map", r#"{"file-client":"file-upstream"}"#)
                .body(Body::from(serialized.clone()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(header_response.status(), StatusCode::OK);

    let authority = base.strip_prefix("http://").unwrap();
    let embedded_response = test_router()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/http://{authority}/chat/v1/messages"))
                .header("content-type", "application/json")
                .header("authorization", "Bearer upstream-secret")
                .header("x-upstream-file-map", r#"{"file-client":"file-upstream"}"#)
                .body(Body::from(serialized))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(embedded_response.status(), StatusCode::OK);

    let mut requests = mock.requests.lock().await;
    assert_eq!(requests.len(), 2);
    for (_, outbound) in requests.drain(..) {
        assert_eq!(
            outbound.pointer("/messages/1/content/0/file/file_id"),
            Some(&json!("file-upstream"))
        );
        assert!(
            !serde_json::to_string(&outbound)
                .unwrap()
                .contains("file-client")
        );
    }
}

#[tokio::test]
async fn unmapped_provider_file_id_is_rejected_before_upstream() {
    let (base, mock) = start_mock().await;
    let mut body = anthropic_body(false);
    body["messages"][0]["content"] = json!([{
        "type":"document",
        "source":{"type":"file","file_id":"file-client"}
    }]);
    let response = send(test_router(), "/v1/messages", &format!("{base}/chat"), body).await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let error: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 1 << 20).await.unwrap()).unwrap();
    assert!(
        error
            .pointer("/error/message")
            .and_then(Value::as_str)
            .unwrap()
            .contains("has no X-Upstream-File-Map entry")
    );
    assert_eq!(mock.count.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn json_upstream_becomes_complete_sse_when_client_requests_streaming() {
    let (base, _) = start_mock().await;
    let response = send(
        test_router(),
        "/v1/messages",
        &format!("{base}/chat"),
        anthropic_body(true),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert!(
        response.headers()["content-type"]
            .to_str()
            .unwrap()
            .contains("text/event-stream")
    );
    let text = String::from_utf8(
        to_bytes(response.into_body(), 1 << 20)
            .await
            .unwrap()
            .to_vec(),
    )
    .unwrap();
    assert!(text.contains("event: message_start"));
    assert!(text.contains("event: message_stop"));
    assert!(text.contains("text_delta"));
}

#[tokio::test]
async fn concurrent_requests_share_the_pool_without_cross_talk() {
    let (base, mock) = start_mock().await;
    let router = test_router();
    let upstream = format!("{base}/chat");
    let requests = (0..128).map(|_| {
        let router = router.clone();
        let upstream = upstream.clone();
        async move { send(router, "/v1/messages", &upstream, anthropic_body(false)).await }
    });
    let responses = futures_util::future::join_all(requests).await;
    assert!(
        responses
            .iter()
            .all(|response| response.status() == StatusCode::OK)
    );
    assert_eq!(mock.count.load(Ordering::SeqCst), 128);
}

#[tokio::test]
async fn chat_sse_is_forwarded_incrementally_before_upstream_finishes() {
    let (base, _) = start_mock().await;
    let response = send(
        test_router(),
        "/v1/messages",
        &format!("{base}/chat-stream"),
        anthropic_body(true),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let mut stream = response.into_body().into_data_stream();
    let first = tokio::time::timeout(Duration::from_millis(150), stream.next())
        .await
        .expect("the first converted frame must arrive before the delayed terminal chunk")
        .unwrap()
        .unwrap();
    let first = String::from_utf8(first.to_vec()).unwrap();
    assert!(first.contains("message_start"));

    let mut rest = String::new();
    while let Some(chunk) = stream.next().await {
        rest.push_str(std::str::from_utf8(&chunk.unwrap()).unwrap());
    }
    assert!(rest.contains("first"));
    assert!(rest.contains(" second"));
    assert!(rest.contains("message_stop"));
    assert!(rest.contains("\"input_tokens\":4"));
}

#[tokio::test]
async fn truncated_chat_sse_preserves_text_but_never_claims_success() {
    let (base, _) = start_mock().await;
    let response = send(
        test_router(),
        "/v1/messages",
        &format!("{base}/chat-truncated"),
        anthropic_body(true),
    )
    .await;
    let body = String::from_utf8(
        to_bytes(response.into_body(), 1 << 20)
            .await
            .unwrap()
            .to_vec(),
    )
    .unwrap();
    assert!(body.contains("partial"));
    assert!(body.contains("event: error"));
    assert!(!body.contains("event: message_stop"));
}
