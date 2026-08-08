use std::{path::PathBuf, sync::Arc, time::Instant};

use chrono::{DateTime, Duration as ChronoDuration, Utc};
use serde_json::{Value, json};
use tokio::{fs, io::AsyncWriteExt};
use tracing::{error, info};
use url::Url;

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
    let Some(raw) = std::env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
    else {
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
}

#[derive(Clone, Debug)]
pub struct Exchange {
    pub request_id: String,
    pub upstream_url: String,
    pub format: String,
    pub model: Option<Value>,
    pub stream: bool,
    pub started_at: Instant,
}

impl ModelInteractionLogger {
    pub fn from_env() -> Result<Self, String> {
        Ok(Self {
            config: Arc::new(ModelLogConfig::from_env()?),
            write_lock: Arc::new(tokio::sync::Mutex::new(())),
        })
    }

    pub fn disabled() -> Self {
        Self {
            config: Arc::new(ModelLogConfig {
                mode: LogMode::Off,
                directory: PathBuf::from("logs"),
                retention_days: 0,
                max_body_bytes: 1024 * 1024,
            }),
            write_lock: Arc::new(tokio::sync::Mutex::new(())),
        }
    }

    pub async fn start(&self) {
        if !self.config.enabled() {
            info!("model interaction logging disabled");
            return;
        }
        if let Err(cause) = fs::create_dir_all(&self.config.directory).await {
            error!(error = %cause, "model interaction logging initialization failed; forwarding is unaffected");
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

    pub fn begin(
        &self,
        request_id: String,
        upstream_url: &str,
        format: &str,
        model: Option<Value>,
        stream: bool,
        outbound: &Value,
    ) -> Exchange {
        let exchange = Exchange {
            request_id,
            upstream_url: sanitize_url(upstream_url),
            format: format.to_owned(),
            model,
            stream,
            started_at: Instant::now(),
        };
        if self.config.enabled() {
            let serialized = serde_json::to_vec(outbound).unwrap_or_else(|error| {
                serde_json::to_vec(&json!({"serialization_error":error.to_string()})).unwrap()
            });
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
        exchange: &Exchange,
        status: u16,
        headers: Value,
        bytes: &[u8],
        complete: bool,
    ) {
        if !self.config.enabled() {
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
        add_body(&mut entry, bytes, bytes.len(), &content_type, &self.config);
        self.append(entry);
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
        }
    }

    pub fn transport_error(&self, exchange: &Exchange, message: &str) {
        if !self.config.enabled() {
            return;
        }
        let mut entry = base_entry(exchange, "model_transport_error");
        entry["duration_ms"] = json!(exchange.started_at.elapsed().as_millis() as u64);
        entry["error"] = json!({"name":"Error","message":message});
        self.append(entry);
    }

    fn append(&self, entry: Value) {
        let logger = self.clone();
        tokio::spawn(async move {
            let _guard = logger.write_lock.lock().await;
            if let Err(cause) = append_entry(&logger.config, &entry).await {
                error!(error = %cause, "model interaction logging failed; forwarding is unaffected");
            }
        });
    }

    async fn cleanup_expired(&self) {
        let _guard = self.write_lock.lock().await;
        let mut entries = match fs::read_dir(&self.config.directory).await {
            Ok(entries) => entries,
            Err(cause) => {
                error!(error = %cause, "model interaction log cleanup failed; forwarding is unaffected");
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
                error!(error = %cause, "model interaction log cleanup failed; forwarding is unaffected");
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

    fn record(&self, complete: bool) {
        if !self.logger.config.enabled() {
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
        if !complete {
            entry["body_cancelled"] = json!(true);
        }
        add_body(
            &mut entry,
            &self.captured,
            self.total,
            content_type,
            &self.logger.config,
        );
        self.logger.append(entry);
    }
}

impl Drop for StreamingCapture {
    fn drop(&mut self) {
        if !self.finished {
            self.record(false);
        }
    }
}

fn base_entry(exchange: &Exchange, event: &str) -> Value {
    json!({
        "timestamp":DateTime::<Utc>::from(std::time::SystemTime::now()).to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "event":event,
        "request_id":exchange.request_id,
        "upstream_url":exchange.upstream_url,
        "format":exchange.format,
        "model":exchange.model,
        "stream":exchange.stream
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
        ModelInteractionLogger {
            config: Arc::new(ModelLogConfig {
                mode,
                directory,
                retention_days,
                max_body_bytes: 8,
            }),
            write_lock: Arc::new(tokio::sync::Mutex::new(())),
        }
    }

    #[test]
    fn sanitizes_credentials_and_query() {
        assert_eq!(
            sanitize_url("https://user:pass@upstream.example.com/v1?a=secret#x"),
            "https://upstream.example.com/v1"
        );
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
        let path = directory.join(format!(
            "model-interactions-{}.ndjson",
            Utc::now().format("%Y-%m-%d")
        ));
        let mut text = String::new();
        for _ in 0..200 {
            text = fs::read_to_string(&path).await.unwrap_or_default();
            if text.lines().count() == 128 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        let lines = text.lines().collect::<Vec<_>>();
        assert_eq!(lines.len(), 128);
        for line in lines {
            serde_json::from_str::<Value>(line).expect("every line is complete JSON");
        }
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
}
