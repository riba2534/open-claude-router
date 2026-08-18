use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicU64, AtomicUsize, Ordering},
    },
    time::{Instant, SystemTime, UNIX_EPOCH},
};

use chrono::{DateTime, Duration as ChronoDuration, Utc};
use serde_json::{Value, json};
use tokio::{fs, io::AsyncWriteExt};
use tracing::{error, info};
use url::Url;

const MAX_BODY_READ_ERROR_CHARS: usize = 1024;
/// Sized in enqueued entries, not requests: `begin()` queues two entries per
/// request (client_request + model_request), so 512 keeps headroom for 256
/// in-flight requests before terminal entries start being dropped.
const MAX_PENDING_WRITES: usize = 512;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LogMode {
    Full,
    Metadata,
    Off,
}

#[derive(Clone, Debug)]
pub struct ModelLogConfig {
    pub mode: LogMode,
    pub directory: PathBuf,
    pub retention_days: u64,
    pub max_body_bytes: usize,
}

impl ModelLogConfig {
    pub fn from_env() -> Result<Self, String> {
        let mode = match std::env::var("OCR_MODEL_LOG_MODE")
            .unwrap_or_else(|_| "full".into())
            .trim()
            .to_ascii_lowercase()
            .as_str()
        {
            "full" => LogMode::Full,
            "metadata" => LogMode::Metadata,
            "off" => LogMode::Off,
            _ => return Err("OCR_MODEL_LOG_MODE must be full, metadata, or off".into()),
        };
        let directory = std::env::var("OCR_MODEL_LOG_DIR")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("logs"));
        Ok(Self {
            mode,
            directory,
            retention_days: parse_integer("OCR_MODEL_LOG_RETENTION_DAYS", 7, 0)?,
            max_body_bytes: parse_integer("OCR_MODEL_LOG_MAX_BODY_BYTES", 1024 * 1024, 1)? as usize,
        })
    }

    pub fn enabled(&self) -> bool {
        self.mode != LogMode::Off && self.retention_days > 0
    }
}

fn parse_integer(name: &str, default: u64, minimum: u64) -> Result<u64, String> {
    let raw = std::env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty());
    parse_integer_value(name, raw.as_deref(), default, minimum)
}

fn parse_integer_value(
    name: &str,
    raw: Option<&str>,
    default: u64,
    minimum: u64,
) -> Result<u64, String> {
    let Some(raw) = raw else {
        return Ok(default);
    };
    raw.trim()
        .parse::<u64>()
        .ok()
        .filter(|value| *value >= minimum)
        .ok_or_else(|| format!("{name} must be an integer >= {minimum}"))
}

#[derive(Clone)]
pub struct ModelInteractionLogger {
    config: Arc<ModelLogConfig>,
    write_lock: Arc<tokio::sync::Mutex<()>>,
    pending_writes: Arc<AtomicUsize>,
    writes_drained: Arc<tokio::sync::Notify>,
    last_error_log_second: Arc<AtomicU64>,
    suppressed_errors: Arc<AtomicUsize>,
}

pub struct ExchangeMetadata {
    pub request_id: String,
    pub upstream_url: String,
    pub format: String,
    pub model: Option<Value>,
    pub stream: bool,
    pub client_ip: Option<String>,
    pub client_tag: Option<String>,
    pub route_mode: String,
}

pub struct Exchange {
    pub request_id: String,
    pub upstream_url: String,
    pub format: String,
    pub model: Option<Value>,
    pub stream: bool,
    pub started_at: Instant,
    client_ip: Option<String>,
    client_tag: Option<String>,
    route_mode: String,
    phase: &'static str,
    terminal_recorded: bool,
    logger: ModelInteractionLogger,
}

impl Exchange {
    pub fn mark_upstream_response_started(&mut self) {
        self.phase = "reading_upstream_response";
    }
}

impl Drop for Exchange {
    fn drop(&mut self) {
        if self.terminal_recorded || !self.logger.config.enabled() {
            return;
        }
        let mut entry = base_entry(self, "model_cancelled");
        entry["duration_ms"] = json!(self.started_at.elapsed().as_millis() as u64);
        entry["stage"] = json!(self.phase);
        self.logger.append(entry);
        self.terminal_recorded = true;
    }
}

impl ModelInteractionLogger {
    pub fn from_env() -> Result<Self, String> {
        Ok(Self::new(ModelLogConfig::from_env()?))
    }

    pub fn new(config: ModelLogConfig) -> Self {
        Self {
            config: Arc::new(config),
            write_lock: Arc::new(tokio::sync::Mutex::new(())),
            pending_writes: Arc::new(AtomicUsize::new(0)),
            writes_drained: Arc::new(tokio::sync::Notify::new()),
            last_error_log_second: Arc::new(AtomicU64::new(0)),
            suppressed_errors: Arc::new(AtomicUsize::new(0)),
        }
    }

    pub fn disabled() -> Self {
        Self::new(ModelLogConfig {
            mode: LogMode::Off,
            directory: PathBuf::from("logs"),
            retention_days: 0,
            max_body_bytes: 1024 * 1024,
        })
    }

    pub async fn start(&self) {
        if !self.config.enabled() {
            info!("model interaction logging disabled");
            return;
        }
        if let Err(cause) = fs::create_dir_all(&self.config.directory).await {
            self.log_io_error("initialization", &cause);
            return;
        }
        self.cleanup_expired().await;
        let cleaner = self.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(60 * 60)).await;
                cleaner.cleanup_expired().await;
            }
        });
        info!(
            mode = ?self.config.mode,
            directory = %self.config.directory.display(),
            retention_days = self.config.retention_days,
            max_body_bytes = self.config.max_body_bytes,
            "model interaction logging enabled"
        );
    }

    /// Starts an exchange record. `client_body` is the original Anthropic
    /// Messages payload as received from the client, paired with the raw
    /// request body length the caller already measured; when provided it is
    /// logged as a separate `client_request` entry so operators can inspect
    /// both sides of the protocol conversion. It obeys the same mode and
    /// body-size bounds as every other entry and never includes credentials
    /// (the router only ever passes the parsed JSON body).
    pub fn begin(
        &self,
        metadata: ExchangeMetadata,
        client_body: Option<(&Value, usize)>,
        outbound: &Value,
    ) -> Exchange {
        let exchange = Exchange {
            request_id: metadata.request_id,
            upstream_url: sanitize_url(&metadata.upstream_url),
            format: metadata.format,
            model: metadata.model,
            stream: metadata.stream,
            started_at: Instant::now(),
            client_ip: metadata.client_ip,
            client_tag: metadata.client_tag,
            route_mode: metadata.route_mode,
            phase: "waiting_for_upstream_response",
            terminal_recorded: false,
            logger: self.clone(),
        };
        if self.config.enabled() {
            if let Some((client_body, received_bytes)) = client_body {
                let mut entry = base_entry(&exchange, "client_request");
                if self.config.mode == LogMode::Metadata {
                    // Metadata mode never emits body content, so skip the full
                    // serialization and record the wire length the caller
                    // already measured. Full mode keeps reporting the compact
                    // serialized length so body_truncated stays consistent
                    // with the captured bytes.
                    add_body(
                        &mut entry,
                        &[],
                        received_bytes,
                        "application/json",
                        &self.config,
                    );
                } else {
                    let serialized = serialize_body(client_body);
                    add_body(
                        &mut entry,
                        &serialized,
                        serialized.len(),
                        "application/json",
                        &self.config,
                    );
                }
                self.append(entry);
            }
            // The outbound body exists only as parsed JSON here (reqwest
            // serializes it independently when sending, behind a frozen
            // interface), so one serialization is still required to give
            // body_bytes a meaningful value even in Metadata mode.
            let serialized = serialize_body(outbound);
            let mut entry = base_entry(&exchange, "model_request");
            add_body(
                &mut entry,
                &serialized,
                serialized.len(),
                "application/json",
                &self.config,
            );
            self.append(entry);
        }
        exchange
    }

    pub fn response(
        &self,
        exchange: &mut Exchange,
        status: u16,
        headers: Value,
        bytes: &[u8],
        complete: bool,
    ) {
        self.response_with_read_error(exchange, status, headers, bytes, complete, None);
    }

    pub fn response_read_error(
        &self,
        exchange: &mut Exchange,
        status: u16,
        headers: Value,
        bytes: &[u8],
        message: &str,
    ) {
        self.response_with_read_error(exchange, status, headers, bytes, false, Some(message));
    }

    fn response_with_read_error(
        &self,
        exchange: &mut Exchange,
        status: u16,
        headers: Value,
        bytes: &[u8],
        complete: bool,
        read_error: Option<&str>,
    ) {
        if !self.config.enabled() {
            exchange.terminal_recorded = true;
            return;
        }
        let content_type = headers
            .get("content-type")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let mut entry = base_entry(exchange, "model_response");
        entry["status"] = json!(status);
        entry["headers"] = headers;
        entry["duration_ms"] = json!(exchange.started_at.elapsed().as_millis() as u64);
        entry["complete"] = json!(complete);
        if let Some(message) = read_error {
            entry["read_error"] = json!({
                "name":"Error",
                "message":bound_body_read_error(message)
            });
        }
        add_body(&mut entry, bytes, bytes.len(), &content_type, &self.config);
        self.append(entry);
        exchange.terminal_recorded = true;
    }

    pub fn streaming_capture(
        &self,
        exchange: Exchange,
        status: u16,
        headers: Value,
    ) -> StreamingCapture {
        StreamingCapture {
            logger: self.clone(),
            exchange,
            status,
            headers,
            captured: Vec::new(),
            total: 0,
            finished: false,
            body_read_error: None,
            protocol_complete: false,
        }
    }

    pub fn transport_error(&self, exchange: &mut Exchange, message: &str) {
        if !self.config.enabled() {
            exchange.terminal_recorded = true;
            return;
        }
        let mut entry = base_entry(exchange, "model_transport_error");
        entry["duration_ms"] = json!(exchange.started_at.elapsed().as_millis() as u64);
        entry["error"] = json!({"name":"Error","message":message});
        self.append(entry);
        exchange.terminal_recorded = true;
    }

    fn append(&self, entry: Value) {
        let logger = self.clone();
        if logger
            .pending_writes
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |pending| {
                (pending < MAX_PENDING_WRITES).then_some(pending + 1)
            })
            .is_err()
        {
            logger.log_io_error(
                "queue",
                &std::io::Error::new(
                    std::io::ErrorKind::WouldBlock,
                    "model interaction log queue is full; entry dropped",
                ),
            );
            return;
        }
        tokio::spawn(async move {
            let _guard = logger.write_lock.lock().await;
            if let Err(cause) = append_entry(&logger.config, &entry).await {
                logger.log_io_error("append", &cause);
            }
            logger.pending_writes.fetch_sub(1, Ordering::AcqRel);
            logger.writes_drained.notify_waiters();
        });
    }

    /// Waits for every write scheduled before or during the wait to finish.
    /// The server calls this after graceful HTTP shutdown, when no request can
    /// enqueue another interaction entry.
    pub async fn flush(&self) {
        loop {
            let drained = self.writes_drained.notified();
            if self.pending_writes.load(Ordering::Acquire) == 0 {
                return;
            }
            drained.await;
        }
    }

    fn log_io_error(&self, operation: &'static str, cause: &std::io::Error) {
        const THROTTLE_SECONDS: u64 = 60;
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let mut previous = self.last_error_log_second.load(Ordering::Relaxed);
        loop {
            if previous != 0 && now.saturating_sub(previous) < THROTTLE_SECONDS {
                self.suppressed_errors.fetch_add(1, Ordering::Relaxed);
                return;
            }
            match self.last_error_log_second.compare_exchange_weak(
                previous,
                now,
                Ordering::Relaxed,
                Ordering::Relaxed,
            ) {
                Ok(_) => break,
                Err(actual) => previous = actual,
            }
        }
        let suppressed = self.suppressed_errors.swap(0, Ordering::Relaxed);
        error!(
            error = %cause,
            operation,
            suppressed,
            "model interaction logging failed; forwarding is unaffected"
        );
    }

    async fn cleanup_expired(&self) {
        let _guard = self.write_lock.lock().await;
        let mut entries = match fs::read_dir(&self.config.directory).await {
            Ok(entries) => entries,
            Err(cause) => {
                self.log_io_error("cleanup", &cause);
                return;
            }
        };
        let cutoff = Utc::now().date_naive()
            - ChronoDuration::days(self.config.retention_days.saturating_sub(1) as i64);
        while let Ok(Some(entry)) = entries.next_entry().await {
            let name = entry.file_name().to_string_lossy().into_owned();
            let Some(date) = name
                .strip_prefix("model-interactions-")
                .and_then(|name| name.strip_suffix(".ndjson"))
                .and_then(|date| chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").ok())
            else {
                continue;
            };
            if date < cutoff
                && let Err(cause) = fs::remove_file(entry.path()).await
            {
                self.log_io_error("cleanup", &cause);
            }
        }
    }
}

pub struct StreamingCapture {
    logger: ModelInteractionLogger,
    exchange: Exchange,
    status: u16,
    headers: Value,
    captured: Vec<u8>,
    total: usize,
    finished: bool,
    body_read_error: Option<String>,
    protocol_complete: bool,
}

impl StreamingCapture {
    pub fn push(&mut self, bytes: &[u8]) {
        self.total = self.total.saturating_add(bytes.len());
        if self.logger.config.mode == LogMode::Full
            && self.captured.len() < self.logger.config.max_body_bytes
        {
            let remaining = self.logger.config.max_body_bytes - self.captured.len();
            self.captured
                .extend_from_slice(&bytes[..bytes.len().min(remaining)]);
        }
    }

    pub fn finish(mut self) {
        self.record(true);
        self.finished = true;
    }

    /// Marks an upstream body read failure. Dropping the capture will record
    /// this separately from a downstream cancellation while keeping the error
    /// text bounded for operational logs.
    pub fn mark_read_error(&mut self, message: &str) {
        self.body_read_error = Some(bound_body_read_error(message));
    }

    /// Marks a formal upstream protocol terminal such as Chat `[DONE]` or a
    /// Responses terminal event. The HTTP body may still be cancelled after
    /// this point, so this remains separate from `complete` (body EOF).
    pub fn mark_protocol_complete(&mut self) {
        self.protocol_complete = true;
    }

    fn record(&mut self, complete: bool) {
        if !self.logger.config.enabled() {
            self.exchange.terminal_recorded = true;
            return;
        }
        let content_type = self
            .headers
            .get("content-type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let mut entry = base_entry(&self.exchange, "model_response");
        entry["status"] = json!(self.status);
        entry["headers"] = self.headers.clone();
        entry["duration_ms"] = json!(self.exchange.started_at.elapsed().as_millis() as u64);
        entry["complete"] = json!(complete);
        entry["protocol_complete"] = json!(self.protocol_complete);
        if !complete {
            if let Some(error) = self.body_read_error.as_ref() {
                entry["read_error"] = json!({"name":"Error","message":error});
            } else {
                entry["body_cancelled"] = json!(true);
            }
        }
        add_body(
            &mut entry,
            &self.captured,
            self.total,
            content_type,
            &self.logger.config,
        );
        self.logger.append(entry);
        self.exchange.terminal_recorded = true;
    }
}

fn bound_body_read_error(message: &str) -> String {
    let mut chars = message.chars();
    let mut bounded = chars
        .by_ref()
        .take(MAX_BODY_READ_ERROR_CHARS)
        .collect::<String>();
    if chars.next().is_some() {
        bounded.pop();
        bounded.push('…');
    }
    bounded
}

impl Drop for StreamingCapture {
    fn drop(&mut self) {
        if !self.finished {
            self.record(false);
        }
    }
}

fn serialize_body(body: &Value) -> Vec<u8> {
    serde_json::to_vec(body).unwrap_or_else(|error| {
        serde_json::to_vec(&json!({"serialization_error":error.to_string()})).unwrap()
    })
}

fn base_entry(exchange: &Exchange, event: &str) -> Value {
    json!({
        "timestamp":DateTime::<Utc>::from(std::time::SystemTime::now()).to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "event":event,
        "request_id":exchange.request_id,
        "upstream_url":exchange.upstream_url,
        "format":exchange.format,
        "model":exchange.model,
        "stream":exchange.stream,
        "client_ip":exchange.client_ip,
        "client_tag":exchange.client_tag,
        "route_mode":exchange.route_mode
    })
}

fn add_body(
    entry: &mut Value,
    bytes: &[u8],
    total: usize,
    content_type: &str,
    config: &ModelLogConfig,
) {
    entry["body_bytes"] = json!(total);
    if config.mode == LogMode::Metadata {
        return;
    }
    let captured = &bytes[..bytes.len().min(config.max_body_bytes)];
    let truncated = total > captured.len();
    entry["body_truncated"] = json!(truncated);
    if !truncated
        && content_type.to_ascii_lowercase().contains("json")
        && let Ok(body) = serde_json::from_slice::<Value>(captured)
    {
        entry["body"] = body;
        return;
    }
    entry["body_text"] = Value::String(String::from_utf8_lossy(captured).into_owned());
}

async fn append_entry(config: &ModelLogConfig, entry: &Value) -> std::io::Result<()> {
    fs::create_dir_all(&config.directory).await?;
    let date = entry
        .get("timestamp")
        .and_then(Value::as_str)
        .and_then(|timestamp| DateTime::parse_from_rfc3339(timestamp).ok())
        .map(|timestamp| timestamp.format("%Y-%m-%d").to_string())
        .unwrap_or_else(|| Utc::now().format("%Y-%m-%d").to_string());
    let path = config
        .directory
        .join(format!("model-interactions-{date}.ndjson"));
    let mut options = fs::OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        options.mode(0o600);
    }
    let mut file = options.open(path).await?;
    let mut line = serde_json::to_vec(entry).unwrap_or_else(|_| b"{}".to_vec());
    line.push(b'\n');
    file.write_all(&line).await
}

fn sanitize_url(raw: &str) -> String {
    let Ok(mut url) = Url::parse(raw) else {
        return "[invalid upstream URL]".into();
    };
    let _ = url.set_username("");
    let _ = url.set_password(None);
    url.set_query(None);
    url.set_fragment(None);
    url.to_string()
}

pub fn selected_headers(headers: &reqwest::header::HeaderMap) -> Value {
    let mut selected = serde_json::Map::new();
    for name in [
        "content-type",
        "content-length",
        "request-id",
        "x-request-id",
        "openai-request-id",
    ] {
        if let Some(value) = headers.get(name).and_then(|value| value.to_str().ok()) {
            selected.insert(name.into(), Value::String(value.to_owned()));
        }
    }
    Value::Object(selected)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_logger(
        directory: PathBuf,
        mode: LogMode,
        retention_days: u64,
    ) -> ModelInteractionLogger {
        ModelInteractionLogger::new(ModelLogConfig {
            mode,
            directory,
            retention_days,
            max_body_bytes: 8,
        })
    }

    #[test]
    fn sanitizes_credentials_and_query() {
        assert_eq!(
            sanitize_url("https://user:pass@upstream.example.com/v1?a=secret#x"),
            "https://upstream.example.com/v1"
        );
    }

    #[test]
    fn retention_days_default_to_seven_and_accept_user_override() {
        assert_eq!(
            parse_integer_value("OCR_MODEL_LOG_RETENTION_DAYS", None, 7, 0).unwrap(),
            7
        );
        assert_eq!(
            parse_integer_value("OCR_MODEL_LOG_RETENTION_DAYS", Some("30"), 7, 0).unwrap(),
            30
        );
        assert_eq!(
            parse_integer_value("OCR_MODEL_LOG_RETENTION_DAYS", Some("0"), 7, 0).unwrap(),
            0
        );
        assert!(parse_integer_value("OCR_MODEL_LOG_RETENTION_DAYS", Some("-1"), 7, 0).is_err());
    }

    #[test]
    fn metadata_omits_bodies_and_full_mode_is_bounded() {
        let mut metadata = json!({});
        add_body(
            &mut metadata,
            b"secret body",
            11,
            "text/plain",
            &ModelLogConfig {
                mode: LogMode::Metadata,
                directory: PathBuf::new(),
                retention_days: 7,
                max_body_bytes: 4,
            },
        );
        assert_eq!(metadata["body_bytes"], 11);
        assert!(metadata.get("body").is_none());
        assert!(metadata.get("body_text").is_none());

        let mut full = json!({});
        add_body(
            &mut full,
            b"secret body",
            11,
            "text/plain",
            &ModelLogConfig {
                mode: LogMode::Full,
                directory: PathBuf::new(),
                retention_days: 7,
                max_body_bytes: 4,
            },
        );
        assert_eq!(full["body_text"], "secr");
        assert_eq!(full["body_truncated"], true);
    }

    #[tokio::test]
    async fn concurrent_appends_remain_valid_ndjson() {
        let directory =
            std::env::temp_dir().join(format!("ocr-model-log-{}", uuid::Uuid::new_v4()));
        let logger = test_logger(directory.clone(), LogMode::Full, 7);
        for sequence in 0..128 {
            logger.append(json!({
                "timestamp":Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                "event":"test",
                "sequence":sequence
            }));
        }
        logger.flush().await;
        let path = directory.join(format!(
            "model-interactions-{}.ndjson",
            Utc::now().format("%Y-%m-%d")
        ));
        let text = fs::read_to_string(&path).await.unwrap();
        let lines = text.lines().collect::<Vec<_>>();
        assert_eq!(lines.len(), 128);
        for line in lines {
            serde_json::from_str::<Value>(line).expect("every line is complete JSON");
        }
        fs::remove_dir_all(&directory).await.unwrap();
    }

    #[tokio::test]
    async fn pending_write_queue_is_bounded_when_storage_stalls() {
        let directory =
            std::env::temp_dir().join(format!("ocr-model-log-{}", uuid::Uuid::new_v4()));
        let logger = test_logger(directory.clone(), LogMode::Metadata, 7);
        let guard = logger.write_lock.lock().await;
        for sequence in 0..(MAX_PENDING_WRITES * 4) {
            logger.append(json!({"event":"test","sequence":sequence}));
        }
        assert_eq!(
            logger.pending_writes.load(Ordering::Acquire),
            MAX_PENDING_WRITES
        );
        drop(guard);
        logger.flush().await;
        let path = directory.join(format!(
            "model-interactions-{}.ndjson",
            Utc::now().format("%Y-%m-%d")
        ));
        assert_eq!(
            fs::read_to_string(&path).await.unwrap().lines().count(),
            MAX_PENDING_WRITES
        );
        fs::remove_dir_all(&directory).await.unwrap();
    }

    #[tokio::test]
    async fn cleanup_keeps_exact_utc_retention_window() {
        let directory =
            std::env::temp_dir().join(format!("ocr-model-log-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).await.unwrap();
        for age in 0..10 {
            let date = Utc::now().date_naive() - ChronoDuration::days(age);
            fs::write(
                directory.join(format!("model-interactions-{date}.ndjson")),
                b"{}\n",
            )
            .await
            .unwrap();
        }
        fs::write(directory.join("unrelated.txt"), b"keep")
            .await
            .unwrap();
        let logger = test_logger(directory.clone(), LogMode::Full, 7);
        logger.cleanup_expired().await;
        let mut entries = fs::read_dir(&directory).await.unwrap();
        let mut model_files = 0;
        let mut unrelated = false;
        while let Some(entry) = entries.next_entry().await.unwrap() {
            let name = entry.file_name().to_string_lossy().into_owned();
            model_files += usize::from(name.starts_with("model-interactions-"));
            unrelated |= name == "unrelated.txt";
        }
        assert_eq!(model_files, 7);
        assert!(unrelated);
        fs::remove_dir_all(&directory).await.unwrap();
    }

    #[tokio::test]
    async fn streaming_read_error_is_bounded_and_not_logged_as_cancellation() {
        let directory =
            std::env::temp_dir().join(format!("ocr-model-log-{}", uuid::Uuid::new_v4()));
        let logger = test_logger(directory.clone(), LogMode::Metadata, 7);
        let exchange = logger.begin(
            ExchangeMetadata {
                request_id: "read-error".into(),
                upstream_url: "https://upstream.example.com/v1".into(),
                format: "responses".into(),
                model: None,
                stream: true,
                client_ip: Some("203.0.113.8".into()),
                client_tag: Some("stream-caller".into()),
                route_mode: "header".into(),
            },
            None,
            &json!({}),
        );
        let mut capture = logger.streaming_capture(exchange, 200, json!({}));
        capture.push(b"partial");
        capture.mark_read_error(&"x".repeat(MAX_BODY_READ_ERROR_CHARS + 100));
        drop(capture);
        logger.flush().await;

        let path = directory.join(format!(
            "model-interactions-{}.ndjson",
            Utc::now().format("%Y-%m-%d")
        ));
        let text = fs::read_to_string(path).await.unwrap();
        let entry: Value = text
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .find(|entry| entry["event"] == "model_response")
            .unwrap();
        assert_eq!(entry["complete"], false);
        assert_eq!(entry["protocol_complete"], false);
        assert_eq!(entry["client_ip"], "203.0.113.8");
        assert_eq!(entry["client_tag"], "stream-caller");
        assert_eq!(entry["route_mode"], "header");
        assert!(entry.get("body_cancelled").is_none());
        let read_error = entry["read_error"]["message"].as_str().unwrap();
        assert_eq!(read_error.chars().count(), MAX_BODY_READ_ERROR_CHARS);
        assert!(read_error.ends_with('…'));
        fs::remove_dir_all(&directory).await.unwrap();
    }

    #[tokio::test]
    async fn dropped_exchange_records_client_ip_route_and_cancellation_stage() {
        let directory =
            std::env::temp_dir().join(format!("ocr-model-log-{}", uuid::Uuid::new_v4()));
        let logger = test_logger(directory.clone(), LogMode::Metadata, 7);
        let exchange = logger.begin(
            ExchangeMetadata {
                request_id: "cancelled-before-headers".into(),
                upstream_url: "https://upstream.example.com/v1".into(),
                format: "chat-completions".into(),
                model: Some(json!("model-a")),
                stream: true,
                client_ip: Some("198.51.100.24".into()),
                client_tag: Some("canary-a".into()),
                route_mode: "embedded-path".into(),
            },
            None,
            &json!({"model":"model-a","messages":[]}),
        );
        drop(exchange);
        logger.flush().await;

        let path = directory.join(format!(
            "model-interactions-{}.ndjson",
            Utc::now().format("%Y-%m-%d")
        ));
        let entries = fs::read_to_string(path)
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
        let cancelled = entries
            .iter()
            .find(|entry| entry["event"] == "model_cancelled")
            .unwrap();
        assert_eq!(cancelled["stage"], "waiting_for_upstream_response");
        for entry in &entries {
            assert_eq!(entry["client_ip"], "198.51.100.24");
            assert_eq!(entry["client_tag"], "canary-a");
            assert_eq!(entry["route_mode"], "embedded-path");
            assert_eq!(entry["request_id"], "cancelled-before-headers");
        }
        fs::remove_dir_all(&directory).await.unwrap();
    }

    #[tokio::test]
    async fn client_request_is_logged_alongside_model_request() {
        let directory =
            std::env::temp_dir().join(format!("ocr-model-log-{}", uuid::Uuid::new_v4()));
        let logger = test_logger(directory.clone(), LogMode::Full, 7);
        let mut exchange = logger.begin(
            ExchangeMetadata {
                request_id: "both-sides".into(),
                upstream_url: "https://upstream.example.com/v1".into(),
                format: "chat-completions".into(),
                model: Some(json!("m")),
                stream: false,
                client_ip: None,
                client_tag: Some("cli-runner".into()),
                route_mode: "header".into(),
            },
            Some((&json!({"model":"m","max_tokens":1}), 42)),
            &json!({"model":"m"}),
        );
        logger.response(&mut exchange, 200, json!({}), b"{}", true);
        logger.flush().await;

        let path = directory.join(format!(
            "model-interactions-{}.ndjson",
            Utc::now().format("%Y-%m-%d")
        ));
        let entries = fs::read_to_string(path)
            .await
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0]["event"], "client_request");
        assert_eq!(entries[0]["request_id"], "both-sides");
        for entry in &entries {
            assert_eq!(entry["client_tag"], "cli-runner");
        }
        // The Full-mode body capture is bounded at 8 bytes in test_logger, so
        // the client payload arrives truncated as text rather than JSON.
        assert_eq!(entries[0]["body_truncated"], true);
        assert_eq!(entries[1]["event"], "model_request");
        assert_eq!(entries[2]["event"], "model_response");
        fs::remove_dir_all(&directory).await.unwrap();
    }

    #[tokio::test]
    async fn metadata_client_request_records_wire_length_without_serializing() {
        let directory =
            std::env::temp_dir().join(format!("ocr-model-log-{}", uuid::Uuid::new_v4()));
        let logger = test_logger(directory.clone(), LogMode::Metadata, 7);
        let mut exchange = logger.begin(
            ExchangeMetadata {
                request_id: "metadata-lengths".into(),
                upstream_url: "https://upstream.example.com/v1".into(),
                format: "chat-completions".into(),
                model: Some(json!("m")),
                stream: false,
                client_ip: None,
                client_tag: None,
                route_mode: "header".into(),
            },
            Some((&json!({"model":"m","max_tokens":1}), 999)),
            &json!({"model":"m"}),
        );
        logger.response(&mut exchange, 200, json!({}), b"{}", true);
        logger.flush().await;

        let path = directory.join(format!(
            "model-interactions-{}.ndjson",
            Utc::now().format("%Y-%m-%d")
        ));
        let entries = fs::read_to_string(path)
            .await
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .collect::<Vec<_>>();
        let client = entries
            .iter()
            .find(|entry| entry["event"] == "client_request")
            .unwrap();
        // Metadata mode reports the raw wire length passed by the caller and
        // never captures body content.
        assert_eq!(client["body_bytes"], 999);
        assert!(client.get("body").is_none());
        assert!(client.get("body_text").is_none());
        let request = entries
            .iter()
            .find(|entry| entry["event"] == "model_request")
            .unwrap();
        assert!(request["body_bytes"].as_u64().unwrap() > 0);
        fs::remove_dir_all(&directory).await.unwrap();
    }

    #[tokio::test]
    async fn protocol_terminal_is_distinct_from_http_body_eof() {
        let directory =
            std::env::temp_dir().join(format!("ocr-model-log-{}", uuid::Uuid::new_v4()));
        let logger = test_logger(directory.clone(), LogMode::Metadata, 7);
        let exchange = logger.begin(
            ExchangeMetadata {
                request_id: "protocol-terminal".into(),
                upstream_url: "https://upstream.example.com/v1".into(),
                format: "chat-completions".into(),
                model: None,
                stream: true,
                client_ip: None,
                client_tag: None,
                route_mode: "header".into(),
            },
            None,
            &json!({}),
        );
        let mut capture = logger.streaming_capture(exchange, 200, json!({}));
        capture.mark_protocol_complete();
        drop(capture);
        logger.flush().await;

        let path = directory.join(format!(
            "model-interactions-{}.ndjson",
            Utc::now().format("%Y-%m-%d")
        ));
        let response = fs::read_to_string(path)
            .await
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .find(|entry| entry["event"] == "model_response")
            .unwrap();
        assert_eq!(response["complete"], false);
        assert_eq!(response["protocol_complete"], true);
        assert_eq!(response["body_cancelled"], true);
        assert!(response["client_tag"].is_null());
        fs::remove_dir_all(&directory).await.unwrap();
    }

    #[tokio::test]
    async fn transport_error_carries_client_tag() {
        let directory =
            std::env::temp_dir().join(format!("ocr-model-log-{}", uuid::Uuid::new_v4()));
        let logger = test_logger(directory.clone(), LogMode::Metadata, 7);
        let mut exchange = logger.begin(
            ExchangeMetadata {
                request_id: "transport-error".into(),
                upstream_url: "https://upstream.example.com/v1".into(),
                format: "chat-completions".into(),
                model: None,
                stream: false,
                client_ip: None,
                client_tag: Some("canary-b".into()),
                route_mode: "header".into(),
            },
            None,
            &json!({}),
        );
        logger.transport_error(&mut exchange, "connection refused");
        logger.flush().await;

        let path = directory.join(format!(
            "model-interactions-{}.ndjson",
            Utc::now().format("%Y-%m-%d")
        ));
        let entries = fs::read_to_string(path)
            .await
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .collect::<Vec<_>>();
        let error = entries
            .iter()
            .find(|entry| entry["event"] == "model_transport_error")
            .unwrap();
        assert_eq!(error["client_tag"], "canary-b");
        assert_eq!(error["error"]["message"], "connection refused");
        fs::remove_dir_all(&directory).await.unwrap();
    }
}
