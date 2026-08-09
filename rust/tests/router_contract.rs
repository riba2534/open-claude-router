use std::{
    collections::{HashSet, VecDeque},
    convert::Infallible,
    net::SocketAddr,
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
use open_claude_router::{
    AppState, build_app,
    model_log::{LogMode, ModelInteractionLogger, ModelLogConfig},
};
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

async fn chat_tool_upstream(
    State(state): State<MockState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Json<Value> {
    let name = body
        .pointer("/tool_choice/function/name")
        .and_then(Value::as_str)
        .unwrap()
        .to_owned();
    state.count.fetch_add(1, Ordering::SeqCst);
    state.requests.lock().await.push_back((headers, body));
    Json(json!({
        "id":"chatcmpl-tool","model":"upstream-chat",
        "choices":[{"message":{"role":"assistant","content":null,"tool_calls":[{
            "id":"call_new","type":"function","function":{"name":name,"arguments":"{}"}
        }]},"finish_reason":"tool_calls"}]
    }))
}

async fn chat_tool_stream_upstream(
    State(state): State<MockState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let name = body
        .pointer("/tool_choice/function/name")
        .and_then(Value::as_str)
        .unwrap()
        .to_owned();
    state.count.fetch_add(1, Ordering::SeqCst);
    state.requests.lock().await.push_back((headers, body));
    let event = json!({
        "id":"chatcmpl-tool-stream","model":"upstream-chat",
        "choices":[{"delta":{"tool_calls":[{
            "index":0,"id":"call_new","type":"function",
            "function":{"name":name,"arguments":"{}"}
        }]},"finish_reason":"tool_calls"}]
    });
    let mut response = Response::new(Body::from(format!("data: {event}\n\ndata: [DONE]\n\n")));
    response
        .headers_mut()
        .insert("content-type", "text/event-stream".parse().unwrap());
    response
}

async fn echo_upstream(Json(body): Json<Value>) -> Json<Value> {
    let model = body
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or("missing-model");
    Json(json!({
        "id":format!("chatcmpl-{model}"),"object":"chat.completion","model":model,
        "choices":[{"index":0,"message":{"role":"assistant","content":model},"finish_reason":"stop"}],
        "usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}
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

async fn retry_hint_upstream(
    State(state): State<MockState>,
    Path(case): Path<String>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    state.count.fetch_add(1, Ordering::SeqCst);
    state.requests.lock().await.push_back((headers, body));
    let (status, content_type, response_body) = match case.as_str() {
        "both" | "date" | "invalid" => (
            StatusCode::TOO_MANY_REQUESTS,
            "application/json",
            Body::from(r#"{"error":{"message":"retry later"}}"#),
        ),
        "logical" => (
            StatusCode::OK,
            "application/json",
            Body::from(r#"{"error":{"message":"logical retry","type":"invalid_request_error"}}"#),
        ),
        "malformed" => (StatusCode::OK, "application/json", Body::from("{not-json")),
        "stream" => (
            StatusCode::OK,
            "text/event-stream",
            Body::from(concat!(
                "data: {\"id\":\"retry-stream\",\"model\":\"m\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}]}\n\n",
                "data: [DONE]\n\n"
            )),
        ),
        _ => unreachable!("unknown retry-hint fixture"),
    };
    let mut response = Response::new(response_body);
    *response.status_mut() = status;
    response
        .headers_mut()
        .insert("content-type", content_type.parse().unwrap());
    response
        .headers_mut()
        .insert("authorization", "must-not-leak".parse().unwrap());
    response
        .headers_mut()
        .insert("set-cookie", "secret=must-not-leak".parse().unwrap());
    response
        .headers_mut()
        .insert("x-provider-secret", "must-not-leak".parse().unwrap());
    response
        .headers_mut()
        .insert("x-should-retry", "false".parse().unwrap());
    match case.as_str() {
        "both" => {
            response
                .headers_mut()
                .insert("retry-after", "17".parse().unwrap());
            response
                .headers_mut()
                .insert("retry-after-ms", "250".parse().unwrap());
        }
        "date" => {
            response.headers_mut().insert(
                "retry-after",
                "Sun, 06 Nov 1994 08:49:37 GMT".parse().unwrap(),
            );
        }
        "invalid" => {
            response
                .headers_mut()
                .append("retry-after", "5".parse().unwrap());
            response
                .headers_mut()
                .append("retry-after", "6".parse().unwrap());
            response
                .headers_mut()
                .insert("retry-after-ms", "12junk".parse().unwrap());
        }
        "logical" => {
            response
                .headers_mut()
                .insert("retry-after", "19".parse().unwrap());
            response
                .headers_mut()
                .insert("retry-after-ms", "275".parse().unwrap());
        }
        "malformed" => {
            response
                .headers_mut()
                .insert("retry-after", "23".parse().unwrap());
        }
        "stream" => {
            response
                .headers_mut()
                .insert("retry-after", "3".parse().unwrap());
            response
                .headers_mut()
                .insert("retry-after-ms", "75".parse().unwrap());
        }
        _ => unreachable!("unknown retry-hint fixture"),
    }
    response
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
        .headers_mut()
        .insert("retry-after", "29".parse().unwrap());
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

async fn malformed_tool_upstream(
    State(state): State<MockState>,
    Json(body): Json<Value>,
) -> Json<Value> {
    state.count.fetch_add(1, Ordering::SeqCst);
    state
        .requests
        .lock()
        .await
        .push_back((HeaderMap::new(), body));
    Json(json!({
        "id":"chat_bad_tool","model":"upstream-chat",
        "choices":[{"message":{"role":"assistant","content":null,"tool_calls":[{
            "id":"call_bad","type":"function",
            "function":{"name":"read","arguments":"{"}
        }]},"finish_reason":"tool_calls"}]
    }))
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

async fn protocol_stream_upstream(
    State(state): State<MockState>,
    Path(case): Path<String>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    state.count.fetch_add(1, Ordering::SeqCst);
    state.requests.lock().await.push_back((headers, body));
    let body = match case.as_str() {
        "responses-sparse" => Body::from(concat!(
            "data: {\"type\":\"response.output_text.delta\",\"output_index\":0,\"content_index\":1,\"delta\":\"second\"}\n\n",
            "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"r\",\"model\":\"m\",\"status\":\"completed\",\"output\":[{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"first \"},{\"type\":\"output_text\",\"text\":\"second\"}]}]}}\n\n",
            "data: [DONE]\n\n"
        )),
        "chat-metadata" => Body::from(concat!(
            "data: {\"id\":\"chat-meta\",\"model\":\"m\",\"choices\":[],\"usage\":{\"prompt_tokens\":1}}\n\n",
            "data: [DONE]\n\n"
        )),
        "chat-name-delta" => Body::from(concat!(
            "data: {\"id\":\"chat-name\",\"model\":\"m\",\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":\"get_\",\"arguments\":\"{}\"}}]},\"finish_reason\":null}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"name\":\"weather\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n",
            "data: [DONE]\n\n"
        )),
        "chat-incomplete-tool" => Body::from(concat!(
            "data: {\"id\":\"chat-partial\",\"model\":\"m\",\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"{partial\"}}]},\"finish_reason\":\"length\"}]}\n\n",
            "data: [DONE]\n\n"
        )),
        "responses-done-skeleton" => Body::from(concat!(
            "data: {\"type\":\"response.output_text.delta\",\"output_index\":0,\"content_index\":0,\"delta\":\"hello\"}\n\n",
            "data: {\"type\":\"response.output_item.done\",\"output_index\":0,\"item\":{\"type\":\"message\",\"id\":\"m\",\"content\":[]}}\n\n",
            "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"r\",\"model\":\"m\",\"status\":\"completed\",\"output\":[]}}\n\n",
            "data: [DONE]\n\n"
        )),
        "responses-incomplete-tool" => Body::from(concat!(
            "data: {\"type\":\"response.incomplete\",\"response\":{\"id\":\"r\",\"model\":\"m\",\"status\":\"incomplete\",\"output\":[{\"type\":\"function_call\",\"status\":\"incomplete\",\"arguments\":\"{partial\"}]}}\n\n",
            "data: [DONE]\n\n"
        )),
        "responses-refusal-order" => {
            let stream = async_stream::stream! {
                yield Ok::<_, Infallible>(Bytes::from_static(
                    concat!(
                        "data: {\"type\":\"response.output_item.added\",\"output_index\":1,\"item\":{\"type\":\"message\",\"id\":\"message_1\",\"content\":[]}}\n\n",
                        "data: {\"type\":\"response.refusal.delta\",\"item_id\":\"message_1\",\"content_index\":0,\"delta\":\"denied\"}\n\n"
                    ).as_bytes(),
                ));
                tokio::time::sleep(Duration::from_millis(250)).await;
                yield Ok::<_, Infallible>(Bytes::from_static(concat!(
                    "data: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"type\":\"function_call\",\"arguments\":\"{broken\"}}\n\n",
                    "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"r\",\"model\":\"m\",\"status\":\"completed\",\"output\":[{\"type\":\"function_call\",\"arguments\":\"{broken\"},{\"type\":\"message\",\"id\":\"message_1\",\"role\":\"assistant\",\"content\":[{\"type\":\"refusal\",\"refusal\":\"denied\"}]}]}}\n\n",
                    "data: [DONE]\n\n"
                ).as_bytes()));
            };
            Body::from_stream(stream)
        }
        _ => unreachable!("unknown protocol stream fixture"),
    };
    let mut response = Response::new(body);
    response
        .headers_mut()
        .insert("content-type", "text/event-stream".parse().unwrap());
    response
}

async fn start_mock() -> (String, MockState) {
    let state = MockState::default();
    let app = Router::new()
        .route("/chat", post(chat_upstream))
        .route("/chat-tool", post(chat_tool_upstream))
        .route("/chat-tool-stream", post(chat_tool_stream_upstream))
        .route("/echo", post(echo_upstream))
        .route("/responses", post(responses_upstream))
        .route("/chat-stream", post(chat_stream_upstream))
        .route("/chat-truncated", post(truncated_chat_stream_upstream))
        .route("/responses-stream", post(responses_stream_upstream))
        .route(
            "/responses-truncated",
            post(truncated_responses_stream_upstream),
        )
        .route("/protocol-stream/{case}", post(protocol_stream_upstream))
        .route("/status/{status}", post(status_upstream))
        .route("/retry-hint/{case}", post(retry_hint_upstream))
        .route(
            "/status-truncated/{status}",
            post(truncated_status_upstream),
        )
        .route("/slow", post(slow_upstream))
        .route("/logical-error", post(logical_error_upstream))
        .route("/malformed-json", post(malformed_json_upstream))
        .route("/malformed-tool", post(malformed_tool_upstream))
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

async fn start_streaming_hanging_upstream(
    format: &str,
) -> (String, oneshot::Receiver<()>, oneshot::Receiver<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let (started_tx, started_rx) = oneshot::channel();
    let (closed_tx, closed_rx) = oneshot::channel();
    let payload = if format == "responses" {
        concat!(
            "data: {\"type\":\"response.created\",\"response\":{\"id\":\"r\",\"model\":\"m\",\"status\":\"in_progress\",\"output\":[]}}\n\n",
            "data: {\"type\":\"response.output_text.delta\",\"output_index\":0,\"content_index\":0,\"delta\":\"first\"}\n\n"
        )
    } else {
        "data: {\"id\":\"c\",\"model\":\"m\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"first\"},\"finish_reason\":null}]}\n\n"
    };
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
        socket
            .write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n{payload}"
                )
                .as_bytes(),
            )
            .await
            .unwrap();
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
    (format!("http://{addr}/stream"), started_rx, closed_rx)
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

fn test_router_with_model_logger(model_logger: ModelInteractionLogger) -> Router {
    build_app(Arc::new(AppState {
        client: reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap(),
        access_tokens: HashSet::new(),
        model_logger,
    }))
}

fn authenticated_test_router() -> Router {
    build_app(Arc::new(AppState {
        client: reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap(),
        access_tokens: HashSet::from(["service-secret".to_owned()]),
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

fn long_tool_body(stream: bool) -> (Value, String, String, String) {
    let exact_64 = "s".repeat(64);
    let shared = "x".repeat(64);
    let long_a = format!("{shared}A");
    let long_b = format!("{shared}B");
    let body = json!({
        "model":"m","max_tokens":32,"stream":stream,
        "tools":[
            {"name":exact_64,"input_schema":{"type":"object"}},
            {"name":long_a,"input_schema":{"type":"object"}},
            {"name":long_b,"input_schema":{"type":"object"}}
        ],
        "tool_choice":{"type":"tool","name":long_a},
        "messages":[
            {"role":"user","content":"start"},
            {"role":"assistant","content":[{
                "type":"tool_use","id":"call_history","name":long_a,"input":{}
            }]},
            {"role":"user","content":[{
                "type":"tool_result","tool_use_id":"call_history","content":"ok"
            }]}
        ]
    });
    (body, exact_64, long_a, long_b)
}

#[tokio::test]
async fn final_model_and_max_tokens_are_validated_before_upstream() {
    let (base, mock) = start_mock().await;
    let make_request = |body: Value, model_override: Option<&str>, format: Option<&str>| {
        let upstream = if format == Some("responses") {
            format!("{base}/responses")
        } else {
            format!("{base}/chat")
        };
        let mut builder = Request::builder()
            .method("POST")
            .uri("/v1/messages")
            .header("content-type", "application/json")
            .header("x-upstream-url", upstream)
            .header("x-upstream-authorization", "Bearer secret");
        if let Some(model) = model_override {
            builder = builder.header("x-upstream-model", model);
        }
        if let Some(format) = format {
            builder = builder.header("x-upstream-format", format);
        }
        builder
            .body(Body::from(serde_json::to_vec(&body).unwrap()))
            .unwrap()
    };

    for body in [
        json!({"max_tokens":1,"messages":[]}),
        json!({"model":"","max_tokens":1,"messages":[]}),
        json!({"model":"m","messages":[]}),
        json!({"model":"m","max_tokens":null,"messages":[]}),
        json!({"model":"m","max_tokens":"1","messages":[]}),
        json!({"model":"m","max_tokens":1.5,"messages":[]}),
        json!({"model":"m","max_tokens":-1,"messages":[]}),
        json!({"model":"m","max_tokens":0,"stream":true,"messages":[]}),
    ] {
        let response = test_router()
            .oneshot(make_request(body, None, None))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }
    assert_eq!(mock.count.load(Ordering::SeqCst), 0);

    let response = test_router()
        .oneshot(make_request(
            json!({"model":7,"max_tokens":0,"messages":[]}),
            Some("override-model"),
            None,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let (_, chat) = mock.requests.lock().await.pop_front().unwrap();
    assert_eq!(chat["model"], "override-model");
    assert_eq!(chat["max_tokens"], 0);

    let response = test_router()
        .oneshot(make_request(
            json!({"model":"m","max_tokens":0,"messages":[]}),
            None,
            Some("responses"),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let (_, responses) = mock.requests.lock().await.pop_front().unwrap();
    assert_eq!(responses["max_output_tokens"], 0);
    assert!(responses.get("max_tokens").is_none());
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
async fn socket_peer_ip_and_route_mode_are_written_to_audit_log() {
    let (base, _) = start_mock().await;
    let directory = std::env::temp_dir().join(format!("ocr-router-audit-{}", uuid::Uuid::new_v4()));
    let model_logger = ModelInteractionLogger::new(ModelLogConfig {
        mode: LogMode::Metadata,
        directory: directory.clone(),
        retention_days: 7,
        max_body_bytes: 1024,
    });
    model_logger.start().await;
    let app = build_app(Arc::new(AppState {
        client: reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap(),
        access_tokens: HashSet::new(),
        model_logger: model_logger.clone(),
    }));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .unwrap();
    });

    let response = reqwest::Client::new()
        .post(format!("http://{addr}/v1/messages"))
        .header("content-type", "application/json")
        .header("x-upstream-url", format!("{base}/chat"))
        .header("x-upstream-authorization", "Bearer secret")
        .body(serde_json::to_vec(&anthropic_body(false)).unwrap())
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let _ = response.bytes().await.unwrap();
    model_logger.flush().await;

    let path = directory.join(format!(
        "model-interactions-{}.ndjson",
        chrono::Utc::now().format("%Y-%m-%d")
    ));
    let entries = tokio::fs::read_to_string(path)
        .await
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(entries.len(), 2);
    assert!(
        entries
            .iter()
            .any(|entry| entry["event"] == "model_request")
    );
    assert!(
        entries
            .iter()
            .any(|entry| entry["event"] == "model_response")
    );
    let request_id = entries[0]["request_id"].clone();
    for entry in entries {
        assert_eq!(entry["client_ip"], "127.0.0.1");
        assert_eq!(entry["route_mode"], "header");
        assert_eq!(entry["request_id"], request_id);
    }

    server.abort();
    tokio::fs::remove_dir_all(directory).await.unwrap();
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
async fn chat_tool_names_are_consistent_and_reversible_across_the_router() {
    let (base, mock) = start_mock().await;
    let (body, exact_64, long_a, long_b) = long_tool_body(false);
    let response = send(
        test_router(),
        "/v1/messages",
        &format!("{base}/chat-tool"),
        body,
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let result: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 1 << 20).await.unwrap()).unwrap();
    assert_eq!(result.pointer("/content/0/name"), Some(&json!(long_a)));

    let (_, outbound) = mock.requests.lock().await.pop_front().unwrap();
    let exact_wire = outbound
        .pointer("/tools/0/function/name")
        .and_then(Value::as_str)
        .unwrap();
    let wire_a = outbound
        .pointer("/tools/1/function/name")
        .and_then(Value::as_str)
        .unwrap();
    let wire_b = outbound
        .pointer("/tools/2/function/name")
        .and_then(Value::as_str)
        .unwrap();
    assert_eq!(exact_wire, exact_64);
    assert!(wire_a.len() <= 64);
    assert!(wire_b.len() <= 64);
    assert_ne!(wire_a, wire_b);
    assert_eq!(
        outbound
            .pointer("/tool_choice/function/name")
            .and_then(Value::as_str),
        Some(wire_a)
    );
    assert_eq!(
        outbound
            .pointer("/messages/1/tool_calls/0/function/name")
            .and_then(Value::as_str),
        Some(wire_a)
    );
    assert_ne!(wire_a, long_a);
    assert_ne!(wire_b, long_b);
}

#[tokio::test]
async fn chat_stream_restores_the_original_tool_name_through_router_context() {
    let (base, mock) = start_mock().await;
    let (body, _, long_a, _) = long_tool_body(true);
    let response = send(
        test_router(),
        "/v1/messages",
        &format!("{base}/chat-tool-stream"),
        body,
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let text = String::from_utf8(
        to_bytes(response.into_body(), 1 << 20)
            .await
            .unwrap()
            .to_vec(),
    )
    .unwrap();
    let (_, outbound) = mock.requests.lock().await.pop_front().unwrap();
    let wire = outbound
        .pointer("/tool_choice/function/name")
        .and_then(Value::as_str)
        .unwrap();
    assert_ne!(wire, long_a);
    assert!(text.contains(&serde_json::to_string(&long_a).unwrap()));
    assert!(!text.contains(&serde_json::to_string(wire).unwrap()));
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
async fn responses_history_pairs_65_character_call_ids_without_renaming_tools() {
    let (base, mock) = start_mock().await;
    let exact_64 = "c".repeat(64);
    let long_65 = "d".repeat(65);
    let tool_name_128 = "t".repeat(128);
    let body = json!({
        "model":"m","max_tokens":32,
        "tools":[{"name":tool_name_128,"input_schema":{"type":"object"}}],
        "messages":[
            {"role":"user","content":"start"},
            {"role":"assistant","content":[
                {"type":"tool_use","id":exact_64,"name":tool_name_128,"input":{"n":1}},
                {"type":"tool_use","id":long_65,"name":tool_name_128,"input":{"n":2}}
            ]},
            {"role":"user","content":[
                {"type":"tool_result","tool_use_id":exact_64,"content":"one"},
                {"type":"tool_result","tool_use_id":long_65,"content":"two"}
            ]}
        ]
    });
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

    let (_, outbound) = mock.requests.lock().await.pop_front().unwrap();
    assert_eq!(
        outbound.pointer("/tools/0/name"),
        Some(&json!(tool_name_128))
    );
    let input = outbound.get("input").and_then(Value::as_array).unwrap();
    let calls = input
        .iter()
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("function_call"))
        .collect::<Vec<_>>();
    let outputs = input
        .iter()
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("function_call_output"))
        .collect::<Vec<_>>();
    assert_eq!(calls[0].get("call_id"), Some(&json!(exact_64)));
    assert_eq!(outputs[0].get("call_id"), calls[0].get("call_id"));
    let long_wire = calls[1].get("call_id").and_then(Value::as_str).unwrap();
    assert_eq!(long_wire.chars().count(), 64);
    assert_ne!(long_wire, long_65);
    assert_eq!(outputs[1].get("call_id"), calls[1].get("call_id"));
    assert_eq!(calls[1].get("name"), Some(&json!(tool_name_128)));
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
async fn responses_sparse_content_index_merges_with_populated_terminal_contract() {
    let (base, mock) = start_mock().await;
    let response = test_router()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/messages")
                .header("content-type", "application/json")
                .header(
                    "x-upstream-url",
                    format!("{base}/protocol-stream/responses-sparse"),
                )
                .header("x-upstream-authorization", "Bearer secret")
                .header("x-upstream-format", "responses")
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
    assert_eq!(
        result.pointer("/content/0/text"),
        Some(&json!("first second"))
    );
    assert_eq!(mock.count.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn chat_metadata_only_done_is_retryable_stream_error_contract() {
    let (base, mock) = start_mock().await;
    let response = send(
        test_router(),
        "/v1/messages",
        &format!("{base}/protocol-stream/chat-metadata"),
        anthropic_body(true),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = String::from_utf8(
        to_bytes(response.into_body(), 1 << 20)
            .await
            .unwrap()
            .to_vec(),
    )
    .unwrap();
    assert!(body.contains("event: error"));
    assert!(body.contains("upstream Chat stream was empty"));
    assert!(!body.contains("event: message_start"));
    assert!(!body.contains("event: message_stop"));
    assert_eq!(mock.count.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn responses_out_of_order_refusal_is_buffered_until_safe_contract() {
    let (base, mock) = start_mock().await;
    let response = test_router()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/messages")
                .header("content-type", "application/json")
                .header(
                    "x-upstream-url",
                    format!("{base}/protocol-stream/responses-refusal-order"),
                )
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
    assert!(
        tokio::time::timeout(Duration::from_millis(100), stream.next())
            .await
            .is_err(),
        "unsafe output_index=1 refusal text leaked before the earlier item arrived"
    );
    let mut body = String::new();
    while let Some(chunk) = stream.next().await {
        body.push_str(std::str::from_utf8(&chunk.unwrap()).unwrap());
    }
    assert!(body.contains("suppressed by refusal"));
    assert!(body.contains("suppressed by refusal unknown"));
    assert!(body.contains("denied"));
    assert!(body.contains("event: message_stop"));
    assert!(body.contains("\"stop_reason\":\"refusal\""));
    assert!(!body.contains("event: error"));
    assert_eq!(mock.count.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn responses_output_item_done_skeleton_preserves_streamed_delta_contract() {
    let (base, mock) = start_mock().await;
    let response = test_router()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/messages")
                .header("content-type", "application/json")
                .header(
                    "x-upstream-url",
                    format!("{base}/protocol-stream/responses-done-skeleton"),
                )
                .header("x-upstream-authorization", "Bearer secret")
                .header("x-upstream-format", "responses")
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
    assert_eq!(result.pointer("/content/0/text"), Some(&json!("hello")));
    assert_eq!(mock.count.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn chat_fragmented_function_name_is_merged_through_live_route_contract() {
    let (base, mock) = start_mock().await;
    let response = send(
        test_router(),
        "/v1/messages",
        &format!("{base}/protocol-stream/chat-name-delta"),
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
    assert!(body.contains("\"name\":\"get_weather\""));
    assert!(body.contains("event: message_stop"));
    assert!(!body.contains("event: error"));
    assert_eq!(mock.count.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn incomplete_tools_without_identity_remain_non_executable_contract() {
    let (base, mock) = start_mock().await;
    let chat = send(
        test_router(),
        "/v1/messages",
        &format!("{base}/protocol-stream/chat-incomplete-tool"),
        anthropic_body(true),
    )
    .await;
    let chat =
        String::from_utf8(to_bytes(chat.into_body(), 1 << 20).await.unwrap().to_vec()).unwrap();
    assert!(chat.contains("incomplete tool_use unknown"));
    assert!(chat.contains("\"stop_reason\":\"max_tokens\""));
    assert!(!chat.contains("\"type\":\"tool_use\""));
    assert!(!chat.contains("event: error"));

    let responses = test_router()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/messages")
                .header("content-type", "application/json")
                .header(
                    "x-upstream-url",
                    format!("{base}/protocol-stream/responses-incomplete-tool"),
                )
                .header("x-upstream-authorization", "Bearer secret")
                .header("x-upstream-format", "responses")
                .body(Body::from(
                    serde_json::to_vec(&anthropic_body(true)).unwrap(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    let responses = String::from_utf8(
        to_bytes(responses.into_body(), 1 << 20)
            .await
            .unwrap()
            .to_vec(),
    )
    .unwrap();
    assert!(responses.contains("incomplete function_call unknown"));
    assert!(responses.contains("\"stop_reason\":\"max_tokens\""));
    assert!(!responses.contains("\"type\":\"tool_use\""));
    assert!(!responses.contains("event: error"));
    assert_eq!(mock.count.load(Ordering::SeqCst), 2);
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
async fn retry_hints_are_allowlisted_validated_and_preserved_without_retrying() {
    let (base, mock) = start_mock().await;

    let response = send(
        test_router(),
        "/v1/messages",
        &format!("{base}/retry-hint/both"),
        anthropic_body(false),
    )
    .await;
    assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(response.headers()["x-should-retry"], "true");
    assert_eq!(response.headers()["retry-after"], "17");
    assert_eq!(response.headers()["retry-after-ms"], "250");
    for name in [
        "authorization",
        "set-cookie",
        "x-provider-secret",
        "www-authenticate",
    ] {
        assert!(response.headers().get(name).is_none(), "leaked {name}");
    }
    assert_eq!(mock.count.load(Ordering::SeqCst), 1);

    let response = send(
        test_router(),
        "/v1/messages",
        &format!("{base}/retry-hint/date"),
        anthropic_body(false),
    )
    .await;
    assert_eq!(
        response.headers()["retry-after"],
        "Sun, 06 Nov 1994 08:49:37 GMT"
    );
    assert!(response.headers().get("retry-after-ms").is_none());
    assert_eq!(mock.count.load(Ordering::SeqCst), 2);

    let response = send(
        test_router(),
        "/v1/messages",
        &format!("{base}/retry-hint/invalid"),
        anthropic_body(false),
    )
    .await;
    assert_eq!(response.headers()["x-should-retry"], "true");
    assert!(response.headers().get("retry-after").is_none());
    assert!(response.headers().get("retry-after-ms").is_none());
    assert_eq!(mock.count.load(Ordering::SeqCst), 3);
}

#[tokio::test]
async fn retry_hints_survive_logical_and_protocol_errors() {
    let (base, mock) = start_mock().await;
    let response = send(
        test_router(),
        "/v1/messages",
        &format!("{base}/retry-hint/logical"),
        anthropic_body(false),
    )
    .await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(response.headers()["x-should-retry"], "true");
    assert_eq!(response.headers()["retry-after"], "19");
    assert_eq!(response.headers()["retry-after-ms"], "275");

    let response = send(
        test_router(),
        "/v1/messages",
        &format!("{base}/retry-hint/malformed"),
        anthropic_body(false),
    )
    .await;
    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
    assert_eq!(response.headers()["x-should-retry"], "true");
    assert_eq!(response.headers()["retry-after"], "23");
    assert_eq!(mock.count.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn live_sse_exposes_initial_retry_hints_without_forwarding_other_headers() {
    let (base, mock) = start_mock().await;
    let response = send(
        test_router(),
        "/v1/messages",
        &format!("{base}/retry-hint/stream"),
        anthropic_body(true),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["retry-after"], "3");
    assert_eq!(response.headers()["retry-after-ms"], "75");
    assert!(response.headers().get("x-should-retry").is_none());
    assert!(response.headers().get("authorization").is_none());
    assert!(response.headers().get("set-cookie").is_none());
    assert!(response.headers().get("x-provider-secret").is_none());
    let body = String::from_utf8(
        to_bytes(response.into_body(), 1 << 20)
            .await
            .unwrap()
            .to_vec(),
    )
    .unwrap();
    assert!(body.contains("event: message_stop"));
    assert_eq!(mock.count.load(Ordering::SeqCst), 1);
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
    assert_eq!(response.headers()["retry-after"], "29");
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
    assert_eq!(response.headers()["retry-after"], "29");
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
async fn malformed_completed_tool_arguments_are_retryable_and_single_attempt() {
    let (base, mock) = start_mock().await;
    let response = send(
        test_router(),
        "/v1/messages",
        &format!("{base}/malformed-tool"),
        anthropic_body(false),
    )
    .await;
    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
    assert_eq!(response.headers()["x-should-retry"], "true");
    let body: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 1 << 20).await.unwrap()).unwrap();
    assert_eq!(body.pointer("/error/type"), Some(&json!("api_error")));
    assert_eq!(
        body.pointer("/error/message"),
        Some(&json!(
            "upstream tool arguments must be a valid JSON object"
        ))
    );
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
async fn oversized_request_body_uses_anthropic_error_envelope() {
    let response = test_router()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/messages")
                .header("content-type", "application/json")
                .header(
                    "x-upstream-url",
                    "https://upstream.example.com/v1/chat/completions",
                )
                .header("x-upstream-authorization", "Bearer secret")
                .body(Body::from(vec![b'x'; 32 * 1024 * 1024 + 1]))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(
        response
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok()),
        Some("application/json")
    );
    let body: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 1 << 20).await.unwrap()).unwrap();
    assert_eq!(body["type"], "error");
    assert_eq!(
        body.pointer("/error/type"),
        Some(&json!("request_too_large"))
    );
    assert_eq!(
        body.pointer("/error/message"),
        Some(&json!("Request body is too large"))
    );
}

#[tokio::test]
async fn count_tokens_validates_routes_in_both_access_modes() {
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
    assert_eq!(header_response.status(), StatusCode::OK);
    let result: Value = serde_json::from_slice(
        &to_bytes(header_response.into_body(), 1 << 20)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(result["input_tokens"], 0);

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
    assert_eq!(embedded_response.status(), StatusCode::OK);
    let result: Value = serde_json::from_slice(
        &to_bytes(embedded_response.into_body(), 1 << 20)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(result["input_tokens"], 0);
}

#[tokio::test]
async fn downstream_disconnect_before_headers_cancels_upstream_request() {
    let (upstream, started, closed) = start_hanging_upstream().await;
    let directory = std::env::temp_dir().join(format!("ocr-cancel-audit-{}", uuid::Uuid::new_v4()));
    let model_logger = ModelInteractionLogger::new(ModelLogConfig {
        mode: LogMode::Metadata,
        directory: directory.clone(),
        retention_days: 7,
        max_body_bytes: 1024,
    });
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = test_router_with_model_logger(model_logger.clone());
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .unwrap();
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
    tokio::task::yield_now().await;
    model_logger.flush().await;
    let path = directory.join(format!(
        "model-interactions-{}.ndjson",
        chrono::Utc::now().format("%Y-%m-%d")
    ));
    let entries = tokio::fs::read_to_string(path)
        .await
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    assert!(
        entries
            .iter()
            .any(|entry| entry["event"] == "model_request")
    );
    let cancelled = entries
        .iter()
        .find(|entry| entry["event"] == "model_cancelled")
        .expect("disconnect before headers must leave an audit terminal");
    assert_eq!(cancelled["stage"], "waiting_for_upstream_response");
    assert_eq!(cancelled["client_ip"], "127.0.0.1");
    server.abort();
    tokio::fs::remove_dir_all(directory).await.unwrap();
}

#[tokio::test]
async fn downstream_disconnect_after_first_stream_frame_cancels_both_upstream_formats() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        axum::serve(listener, test_router()).await.unwrap();
    });

    for format in ["chat-completions", "responses"] {
        let (upstream, started, closed) = start_streaming_hanging_upstream(format).await;
        let payload = serde_json::to_vec(&anthropic_body(true)).unwrap();
        let mut downstream = TcpStream::connect(addr).await.unwrap();
        let request = format!(
            "POST /v1/messages HTTP/1.1\r\nHost: {addr}\r\nContent-Type: application/json\r\nX-Upstream-Url: {upstream}\r\nX-Upstream-Authorization: Bearer secret\r\nX-Upstream-Format: {format}\r\nContent-Length: {}\r\n\r\n",
            payload.len()
        );
        downstream.write_all(request.as_bytes()).await.unwrap();
        downstream.write_all(&payload).await.unwrap();
        tokio::time::timeout(Duration::from_secs(2), started)
            .await
            .expect("upstream must start streaming")
            .unwrap();
        let mut first = [0_u8; 4096];
        let count = tokio::time::timeout(Duration::from_secs(2), downstream.read(&mut first))
            .await
            .expect("router must forward the first converted frame")
            .unwrap();
        assert!(count > 0);
        drop(downstream);
        tokio::time::timeout(Duration::from_secs(2), closed)
            .await
            .expect("dropping the downstream stream must cancel its upstream reader")
            .unwrap();
    }
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
async fn access_mode_format_and_response_shape_matrix_remains_orthogonal() {
    let (base, mock) = start_mock().await;
    let authority = base.strip_prefix("http://").unwrap();
    let router = authenticated_test_router();

    for embedded in [false, true] {
        for (format, endpoint) in [("chat-completions", "chat"), ("responses", "responses")] {
            for stream in [false, true] {
                let uri = if embedded {
                    format!("/http://{authority}/{endpoint}/v1/messages")
                } else {
                    "/v1/messages".to_owned()
                };
                let mut request = Request::builder()
                    .method("POST")
                    .uri(uri)
                    .header("content-type", "application/json")
                    .header("x-upstream-format", format);
                request = if embedded {
                    request
                        .header("authorization", "Bearer upstream-secret")
                        .header("x-ocr-token", "service-secret")
                } else {
                    request
                        .header("authorization", "Bearer service-secret")
                        .header("x-upstream-url", format!("{base}/{endpoint}"))
                        .header("x-upstream-authorization", "Custom upstream-secret")
                };
                let mut body = anthropic_body(stream);
                body["messages"][0]["content"] = json!("matrix");
                let response = router
                    .clone()
                    .oneshot(
                        request
                            .body(Body::from(serde_json::to_vec(&body).unwrap()))
                            .unwrap(),
                    )
                    .await
                    .unwrap();
                assert_eq!(response.status(), StatusCode::OK);
                let bytes = to_bytes(response.into_body(), 1 << 20).await.unwrap();
                if stream {
                    let text = String::from_utf8(bytes.to_vec()).unwrap();
                    assert!(text.contains("event: message_start"));
                    assert!(text.contains("event: message_stop"));
                } else {
                    let value: Value = serde_json::from_slice(&bytes).unwrap();
                    assert_eq!(value["type"], "message");
                    assert_eq!(value["stop_reason"], "end_turn");
                }
            }
        }
    }

    let requests = mock.requests.lock().await;
    assert_eq!(requests.len(), 8);
    assert_eq!(
        requests
            .iter()
            .filter(|(headers, _)| headers["authorization"] == "upstream-secret")
            .count(),
        4
    );
    assert_eq!(
        requests
            .iter()
            .filter(|(headers, _)| headers["authorization"] == "Custom upstream-secret")
            .count(),
        4
    );
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
            .contains("is provider-owned and cannot be translated")
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
    let (base, _) = start_mock().await;
    let router = test_router();
    let upstream = format!("{base}/echo");
    let requests = (0..512).map(|index| {
        let router = router.clone();
        let upstream = upstream.clone();
        async move {
            let mut body = anthropic_body(false);
            body["model"] = json!(format!("client-{index}"));
            let response = send(router, "/v1/messages", &upstream, body).await;
            let status = response.status();
            let body: Value =
                serde_json::from_slice(&to_bytes(response.into_body(), 1 << 20).await.unwrap())
                    .unwrap();
            (index, status, body)
        }
    });
    let responses = futures_util::future::join_all(requests).await;
    for (index, status, body) in responses {
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            body.pointer("/content/0/text"),
            Some(&json!(format!("client-{index}")))
        );
    }
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
