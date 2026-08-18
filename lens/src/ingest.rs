use std::{
    fs,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    time::Duration,
};

use rusqlite::params;
use serde_json::Value;
use tracing::{info, warn};

use crate::{db::Db, derive::derive_response};

const POLL_INTERVAL: Duration = Duration::from_secs(2);

/// Tails every model-interactions-*.ndjson file in the log directory with a
/// per-file byte offset persisted in SQLite, so restarts resume where they
/// stopped and files removed by the router's retention sweep are forgotten.
pub fn run(db: Db, dir: PathBuf) {
    info!(directory = %dir.display(), "lens ingester watching model interaction logs");
    loop {
        if let Err(error) = scan_once(&db, &dir) {
            warn!(%error, "ingest scan failed; retrying");
        }
        std::thread::sleep(POLL_INTERVAL);
    }
}

fn scan_once(db: &Db, dir: &Path) -> Result<(), String> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        // The directory appears once the router writes its first entry.
        Err(_) => return Ok(()),
    };
    let mut files: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| {
                    name.starts_with("model-interactions-") && name.ends_with(".ndjson")
                })
        })
        .collect();
    files.sort();
    for path in files {
        ingest_file(db, &path).map_err(|error| format!("{}: {error}", path.display()))?;
    }
    Ok(())
}

fn ingest_file(db: &Db, path: &Path) -> Result<(), String> {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("non-utf8 file name")?
        .to_owned();
    let size = fs::metadata(path).map_err(|error| error.to_string())?.len();
    let mut offset: u64 = db
        .with(|conn| {
            conn.query_row(
                "SELECT offset FROM ingest_state WHERE file = ?1",
                params![name],
                |row| row.get::<_, i64>(0),
            )
            .map(|value| value as u64)
            .or(Ok(0))
        })
        .map_err(|error| error.to_string())?;
    if size < offset {
        // Truncated or replaced file: start over.
        offset = 0;
    }
    if size == offset {
        return Ok(());
    }
    let mut file = fs::File::open(path).map_err(|error| error.to_string())?;
    file.seek(SeekFrom::Start(offset))
        .map_err(|error| error.to_string())?;
    let mut buffer = Vec::with_capacity((size - offset) as usize);
    file.read_to_end(&mut buffer)
        .map_err(|error| error.to_string())?;
    // Only consume complete lines; a partially flushed tail waits for the next poll.
    let consumed = match buffer.iter().rposition(|byte| *byte == b'\n') {
        Some(last_newline) => last_newline + 1,
        None => return Ok(()),
    };
    let mut applied = 0usize;
    for line in buffer[..consumed].split(|byte| *byte == b'\n') {
        if line.is_empty() {
            continue;
        }
        match serde_json::from_slice::<Value>(line) {
            Ok(entry) => {
                if let Err(error) = apply_entry(db, &entry) {
                    warn!(%error, "failed to apply log entry");
                } else {
                    applied += 1;
                }
            }
            Err(error) => warn!(%error, "skipping malformed ndjson line"),
        }
    }
    let new_offset = offset + consumed as u64;
    db.with(|conn| {
        conn.execute(
            "INSERT INTO ingest_state (file, offset) VALUES (?1, ?2)
             ON CONFLICT(file) DO UPDATE SET offset = excluded.offset",
            params![name, new_offset as i64],
        )
    })
    .map_err(|error| error.to_string())?;
    if applied > 0 {
        info!(file = %name, applied, "ingested log entries");
    }
    Ok(())
}

fn apply_entry(db: &Db, entry: &Value) -> Result<(), String> {
    let event = entry.get("event").and_then(Value::as_str).unwrap_or("");
    let request_id = entry
        .get("request_id")
        .and_then(Value::as_str)
        .ok_or("entry without request_id")?;
    let ts = entry.get("timestamp").and_then(Value::as_str).unwrap_or("");
    let ts_unix = chrono::DateTime::parse_from_rfc3339(ts)
        .map(|parsed| parsed.timestamp())
        .unwrap_or(0);
    // Terminal entries may arrive without their request line (the router's
    // bounded queue is allowed to drop entries), so every event upserts the
    // shared metadata first.
    db.with(|conn| {
        conn.execute(
            "INSERT INTO exchanges (request_id, ts, ts_unix, upstream_url, format, model, stream, client_ip, route_mode)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(request_id) DO NOTHING",
            params![
                request_id,
                ts,
                ts_unix,
                entry.get("upstream_url").and_then(Value::as_str),
                entry.get("format").and_then(Value::as_str),
                model_name(entry.get("model")),
                entry.get("stream").and_then(Value::as_bool).map(i64::from),
                entry.get("client_ip").and_then(Value::as_str),
                entry.get("route_mode").and_then(Value::as_str),
            ],
        )
    })
    .map_err(|error| error.to_string())?;

    match event {
        "model_request" => apply_request(db, request_id, entry),
        "model_response" => apply_response(db, request_id, entry),
        "model_cancelled" => apply_terminal(
            db,
            request_id,
            entry,
            "cancelled",
            entry.get("stage").and_then(Value::as_str),
            None,
        ),
        "model_transport_error" => apply_terminal(
            db,
            request_id,
            entry,
            "transport_error",
            None,
            entry.pointer("/error/message").and_then(Value::as_str),
        ),
        other => Err(format!("unknown event {other}")),
    }
}

fn apply_request(db: &Db, request_id: &str, entry: &Value) -> Result<(), String> {
    let body = body_string(entry);
    db.with(|conn| {
        conn.execute(
            "UPDATE exchanges SET req_body = ?2, req_bytes = ?3, req_truncated = ?4 WHERE request_id = ?1",
            params![
                request_id,
                body,
                entry.get("body_bytes").and_then(Value::as_i64),
                entry
                    .get("body_truncated")
                    .and_then(Value::as_bool)
                    .map(i64::from),
            ],
        )
    })
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn apply_response(db: &Db, request_id: &str, entry: &Value) -> Result<(), String> {
    let status = entry.get("status").and_then(Value::as_i64).unwrap_or(0);
    let outcome = if (200..300).contains(&status) {
        "ok"
    } else {
        "http_error"
    };
    let format = entry.get("format").and_then(Value::as_str).unwrap_or("");
    let content_type = entry
        .pointer("/headers/content-type")
        .and_then(Value::as_str)
        .unwrap_or("");
    let body_json = entry.get("body");
    let body_text = entry.get("body_text").and_then(Value::as_str);
    let derived = if outcome == "ok" {
        derive_response(format, content_type, body_json, body_text)
    } else {
        Default::default()
    };
    let read_error = entry
        .pointer("/read_error/message")
        .and_then(Value::as_str)
        .map(str::to_owned);
    db.with(|conn| {
        conn.execute(
            "UPDATE exchanges SET
               outcome = ?2, status = ?3, duration_ms = ?4, complete = ?5, protocol_complete = ?6,
               error_message = ?7, resp_headers = ?8, resp_body = ?9, resp_bytes = ?10, resp_truncated = ?11,
               agg_response = ?12, finish_reason = ?13,
               input_tokens = ?14, output_tokens = ?15, cached_tokens = ?16, reasoning_tokens = ?17,
               preview = ?18
             WHERE request_id = ?1",
            params![
                request_id,
                outcome,
                status,
                entry.get("duration_ms").and_then(Value::as_i64),
                entry.get("complete").and_then(Value::as_bool).map(i64::from),
                entry
                    .get("protocol_complete")
                    .and_then(Value::as_bool)
                    .map(i64::from),
                read_error,
                entry.get("headers").map(Value::to_string),
                body_string(entry),
                entry.get("body_bytes").and_then(Value::as_i64),
                entry
                    .get("body_truncated")
                    .and_then(Value::as_bool)
                    .map(i64::from),
                derived.agg_response.as_ref().map(Value::to_string),
                derived.finish_reason,
                derived.input_tokens,
                derived.output_tokens,
                derived.cached_tokens,
                derived.reasoning_tokens,
                derived.preview,
            ],
        )
    })
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn apply_terminal(
    db: &Db,
    request_id: &str,
    entry: &Value,
    outcome: &str,
    cancel_stage: Option<&str>,
    error_message: Option<&str>,
) -> Result<(), String> {
    db.with(|conn| {
        conn.execute(
            "UPDATE exchanges SET outcome = ?2, duration_ms = ?3, cancel_stage = ?4, error_message = ?5
             WHERE request_id = ?1",
            params![
                request_id,
                outcome,
                entry.get("duration_ms").and_then(Value::as_i64),
                cancel_stage,
                error_message,
            ],
        )
    })
    .map_err(|error| error.to_string())?;
    Ok(())
}

/// The router logs bodies either as parsed JSON (`body`) or as raw text
/// (`body_text`, used for SSE and truncated payloads). Store one canonical
/// text column either way.
fn body_string(entry: &Value) -> Option<String> {
    if let Some(body) = entry.get("body") {
        return Some(body.to_string());
    }
    entry
        .get("body_text")
        .and_then(Value::as_str)
        .map(str::to_owned)
}

fn model_name(model: Option<&Value>) -> Option<String> {
    match model? {
        Value::String(name) => Some(name.clone()),
        Value::Null => None,
        other => Some(other.to_string()),
    }
}
