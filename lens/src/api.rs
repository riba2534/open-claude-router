use std::sync::Arc;

use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use rusqlite::{Connection, params_from_iter, types::Value as SqlValue};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::db::Db;

pub struct LensState {
    pub db: Db,
}

pub fn build_app(state: Arc<LensState>) -> Router {
    Router::new()
        .route("/", get(index))
        .route("/healthz", get(|| async { Json(json!({"status":"ok"})) }))
        .route("/api/overview", get(overview))
        .route("/api/requests", get(list_requests))
        .route("/api/requests/{id}", get(request_detail))
        .with_state(state)
}

async fn index() -> Response {
    (
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        include_str!("../static/index.html"),
    )
        .into_response()
}

#[derive(Deserialize)]
struct OverviewParams {
    hours: Option<i64>,
}

#[derive(Deserialize)]
struct ListParams {
    hours: Option<i64>,
    limit: Option<i64>,
    offset: Option<i64>,
    model: Option<String>,
    outcome: Option<String>,
    q: Option<String>,
}

async fn overview(
    State(state): State<Arc<LensState>>,
    Query(params): Query<OverviewParams>,
) -> Result<Json<Value>, ApiFailure> {
    let db = state.db.clone();
    let hours = params.hours.unwrap_or(24).clamp(1, 24 * 90);
    run_query(move || db.with(|conn| build_overview(conn, hours))).await
}

async fn list_requests(
    State(state): State<Arc<LensState>>,
    Query(params): Query<ListParams>,
) -> Result<Json<Value>, ApiFailure> {
    let db = state.db.clone();
    run_query(move || db.with(|conn| build_list(conn, &params))).await
}

async fn request_detail(
    State(state): State<Arc<LensState>>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiFailure> {
    let db = state.db.clone();
    let found = run_query(move || db.with(|conn| build_detail(conn, &id))).await?;
    match found.0 {
        Value::Null => Err(ApiFailure::NotFound),
        value => Ok(Json(value)),
    }
}

async fn run_query(
    work: impl FnOnce() -> rusqlite::Result<Value> + Send + 'static,
) -> Result<Json<Value>, ApiFailure> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|error| ApiFailure::Internal(error.to_string()))?
        .map(Json)
        .map_err(|error| ApiFailure::Internal(error.to_string()))
}

enum ApiFailure {
    NotFound,
    Internal(String),
}

impl IntoResponse for ApiFailure {
    fn into_response(self) -> Response {
        match self {
            Self::NotFound => {
                (StatusCode::NOT_FOUND, Json(json!({"error":"not_found"}))).into_response()
            }
            Self::Internal(message) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error":"internal","message":message})),
            )
                .into_response(),
        }
    }
}

fn since_unix(hours: i64) -> i64 {
    chrono::Utc::now().timestamp() - hours * 3600
}

fn build_overview(conn: &Connection, hours: i64) -> rusqlite::Result<Value> {
    let since = since_unix(hours);
    let bucket: i64 = match hours {
        ..=2 => 60,
        3..=6 => 300,
        7..=24 => 900,
        _ => 3600,
    };

    let totals = conn.query_row(
        "SELECT COUNT(*),
                SUM(outcome = 'ok'), SUM(outcome = 'http_error'),
                SUM(outcome = 'transport_error'), SUM(outcome = 'cancelled'), SUM(outcome = 'pending'),
                COALESCE(SUM(input_tokens),0), COALESCE(SUM(output_tokens),0),
                COALESCE(SUM(cached_tokens),0), COALESCE(SUM(reasoning_tokens),0)
         FROM exchanges WHERE ts_unix >= ?1",
        [since],
        |row| {
            Ok(json!({
                "count": row.get::<_, i64>(0)?,
                "ok": row.get::<_, Option<i64>>(1)?.unwrap_or(0),
                "http_error": row.get::<_, Option<i64>>(2)?.unwrap_or(0),
                "transport_error": row.get::<_, Option<i64>>(3)?.unwrap_or(0),
                "cancelled": row.get::<_, Option<i64>>(4)?.unwrap_or(0),
                "pending": row.get::<_, Option<i64>>(5)?.unwrap_or(0),
                "input_tokens": row.get::<_, i64>(6)?,
                "output_tokens": row.get::<_, i64>(7)?,
                "cached_tokens": row.get::<_, i64>(8)?,
                "reasoning_tokens": row.get::<_, i64>(9)?,
            }))
        },
    )?;

    let mut durations: Vec<i64> = conn
        .prepare(
            "SELECT duration_ms FROM exchanges
             WHERE ts_unix >= ?1 AND outcome = 'ok' AND duration_ms IS NOT NULL",
        )?
        .query_map([since], |row| row.get(0))?
        .collect::<Result<_, _>>()?;
    durations.sort_unstable();
    let percentile = |fraction: f64| -> Value {
        if durations.is_empty() {
            return Value::Null;
        }
        let index = ((durations.len() as f64 - 1.0) * fraction).round() as usize;
        json!(durations[index])
    };
    let latency = json!({
        "p50": percentile(0.50),
        "p95": percentile(0.95),
        "p99": percentile(0.99),
        "max": durations.last().copied().map(Value::from).unwrap_or(Value::Null),
    });

    let series = collect_rows(
        conn,
        "SELECT (ts_unix / ?2) * ?2 AS bucket,
                SUM(outcome = 'ok'),
                SUM(outcome IN ('http_error','transport_error')),
                SUM(outcome = 'cancelled'),
                COALESCE(SUM(input_tokens),0), COALESCE(SUM(output_tokens),0)
         FROM exchanges WHERE ts_unix >= ?1 GROUP BY bucket ORDER BY bucket",
        &[SqlValue::from(since), SqlValue::from(bucket)],
        |row| {
            Ok(json!({
                "t": row.get::<_, i64>(0)?,
                "ok": row.get::<_, Option<i64>>(1)?.unwrap_or(0),
                "error": row.get::<_, Option<i64>>(2)?.unwrap_or(0),
                "cancelled": row.get::<_, Option<i64>>(3)?.unwrap_or(0),
                "input_tokens": row.get::<_, i64>(4)?,
                "output_tokens": row.get::<_, i64>(5)?,
            }))
        },
    )?;

    let by_model = collect_rows(
        conn,
        "SELECT COALESCE(model,'(unknown)'), COUNT(*),
                COALESCE(SUM(input_tokens),0), COALESCE(SUM(output_tokens),0),
                CAST(AVG(CASE WHEN outcome='ok' THEN duration_ms END) AS INTEGER),
                SUM(outcome IN ('http_error','transport_error')),
                SUM(outcome = 'cancelled')
         FROM exchanges WHERE ts_unix >= ?1 GROUP BY 1 ORDER BY 2 DESC LIMIT 20",
        &[SqlValue::from(since)],
        |row| {
            Ok(json!({
                "model": row.get::<_, String>(0)?,
                "count": row.get::<_, i64>(1)?,
                "input_tokens": row.get::<_, i64>(2)?,
                "output_tokens": row.get::<_, i64>(3)?,
                "avg_ms": row.get::<_, Option<i64>>(4)?,
                "errors": row.get::<_, Option<i64>>(5)?.unwrap_or(0),
                "cancelled": row.get::<_, Option<i64>>(6)?.unwrap_or(0),
            }))
        },
    )?;

    let by_status = collect_rows(
        conn,
        "SELECT COALESCE(status, 0), COUNT(*) FROM exchanges
         WHERE ts_unix >= ?1 AND outcome IN ('ok','http_error')
         GROUP BY 1 ORDER BY 2 DESC",
        &[SqlValue::from(since)],
        |row| {
            Ok(json!({
                "status": row.get::<_, i64>(0)?,
                "count": row.get::<_, i64>(1)?,
            }))
        },
    )?;

    let by_client = collect_rows(
        conn,
        "SELECT COALESCE(client_ip,'(unknown)'), COUNT(*) FROM exchanges
         WHERE ts_unix >= ?1 GROUP BY 1 ORDER BY 2 DESC LIMIT 10",
        &[SqlValue::from(since)],
        |row| {
            Ok(json!({
                "client_ip": row.get::<_, String>(0)?,
                "count": row.get::<_, i64>(1)?,
            }))
        },
    )?;

    Ok(json!({
        "totals": totals,
        "latency": latency,
        "series": series,
        "by_model": by_model,
        "by_status": by_status,
        "by_client": by_client,
        "bucket_seconds": bucket,
        "hours": hours,
    }))
}

fn build_list(conn: &Connection, params: &ListParams) -> rusqlite::Result<Value> {
    let hours = params.hours.unwrap_or(24).clamp(1, 24 * 90);
    let limit = params.limit.unwrap_or(50).clamp(1, 500);
    let offset = params.offset.unwrap_or(0).max(0);

    let mut clauses = vec!["ts_unix >= ?".to_owned()];
    let mut values: Vec<SqlValue> = vec![SqlValue::from(since_unix(hours))];
    if let Some(model) = params.model.as_deref().filter(|value| !value.is_empty()) {
        clauses.push("model = ?".into());
        values.push(SqlValue::from(model.to_owned()));
    }
    if let Some(outcome) = params.outcome.as_deref().filter(|value| !value.is_empty()) {
        clauses.push("outcome = ?".into());
        values.push(SqlValue::from(outcome.to_owned()));
    }
    if let Some(term) = params.q.as_deref().filter(|value| !value.is_empty()) {
        clauses.push("(request_id LIKE ? OR preview LIKE ? OR req_body LIKE ?)".into());
        let pattern = format!("%{term}%");
        values.push(SqlValue::from(pattern.clone()));
        values.push(SqlValue::from(pattern.clone()));
        values.push(SqlValue::from(pattern));
    }
    let where_clause = clauses.join(" AND ");

    let total: i64 = conn.query_row(
        &format!("SELECT COUNT(*) FROM exchanges WHERE {where_clause}"),
        params_from_iter(values.iter()),
        |row| row.get(0),
    )?;

    values.push(SqlValue::from(limit));
    values.push(SqlValue::from(offset));
    let rows = collect_rows(
        conn,
        &format!(
            "SELECT request_id, ts, model, format, stream, outcome, status, duration_ms,
                    input_tokens, output_tokens, preview, client_ip, route_mode, finish_reason,
                    req_bytes, resp_bytes, cancel_stage, protocol_complete
             FROM exchanges WHERE {where_clause}
             ORDER BY ts_unix DESC, request_id DESC LIMIT ? OFFSET ?"
        ),
        &values,
        |row| {
            Ok(json!({
                "request_id": row.get::<_, String>(0)?,
                "ts": row.get::<_, Option<String>>(1)?,
                "model": row.get::<_, Option<String>>(2)?,
                "format": row.get::<_, Option<String>>(3)?,
                "stream": row.get::<_, Option<i64>>(4)?,
                "outcome": row.get::<_, Option<String>>(5)?,
                "status": row.get::<_, Option<i64>>(6)?,
                "duration_ms": row.get::<_, Option<i64>>(7)?,
                "input_tokens": row.get::<_, Option<i64>>(8)?,
                "output_tokens": row.get::<_, Option<i64>>(9)?,
                "preview": row.get::<_, Option<String>>(10)?,
                "client_ip": row.get::<_, Option<String>>(11)?,
                "route_mode": row.get::<_, Option<String>>(12)?,
                "finish_reason": row.get::<_, Option<String>>(13)?,
                "req_bytes": row.get::<_, Option<i64>>(14)?,
                "resp_bytes": row.get::<_, Option<i64>>(15)?,
                "cancel_stage": row.get::<_, Option<String>>(16)?,
                "protocol_complete": row.get::<_, Option<i64>>(17)?,
            }))
        },
    )?;

    let models = collect_rows(
        conn,
        "SELECT DISTINCT model FROM exchanges WHERE model IS NOT NULL ORDER BY model",
        &[],
        |row| Ok(Value::String(row.get::<_, String>(0)?)),
    )?;

    Ok(json!({"total": total, "rows": rows, "models": models}))
}

fn build_detail(conn: &Connection, id: &str) -> rusqlite::Result<Value> {
    let mut statement = conn.prepare(
        "SELECT request_id, ts, upstream_url, format, model, stream, client_ip, route_mode,
                req_body, req_bytes, req_truncated,
                outcome, status, duration_ms, complete, protocol_complete, cancel_stage, error_message,
                resp_headers, resp_body, resp_bytes, resp_truncated,
                agg_response, finish_reason,
                input_tokens, output_tokens, cached_tokens, reasoning_tokens, preview
         FROM exchanges WHERE request_id = ?1",
    )?;
    let mut rows = statement.query([id])?;
    let Some(row) = rows.next()? else {
        return Ok(Value::Null);
    };
    Ok(json!({
        "request_id": row.get::<_, String>(0)?,
        "ts": row.get::<_, Option<String>>(1)?,
        "upstream_url": row.get::<_, Option<String>>(2)?,
        "format": row.get::<_, Option<String>>(3)?,
        "model": row.get::<_, Option<String>>(4)?,
        "stream": row.get::<_, Option<i64>>(5)?,
        "client_ip": row.get::<_, Option<String>>(6)?,
        "route_mode": row.get::<_, Option<String>>(7)?,
        "req_body": row.get::<_, Option<String>>(8)?,
        "req_bytes": row.get::<_, Option<i64>>(9)?,
        "req_truncated": row.get::<_, Option<i64>>(10)?,
        "outcome": row.get::<_, Option<String>>(11)?,
        "status": row.get::<_, Option<i64>>(12)?,
        "duration_ms": row.get::<_, Option<i64>>(13)?,
        "complete": row.get::<_, Option<i64>>(14)?,
        "protocol_complete": row.get::<_, Option<i64>>(15)?,
        "cancel_stage": row.get::<_, Option<String>>(16)?,
        "error_message": row.get::<_, Option<String>>(17)?,
        "resp_headers": row.get::<_, Option<String>>(18)?,
        "resp_body": row.get::<_, Option<String>>(19)?,
        "resp_bytes": row.get::<_, Option<i64>>(20)?,
        "resp_truncated": row.get::<_, Option<i64>>(21)?,
        "agg_response": row.get::<_, Option<String>>(22)?,
        "finish_reason": row.get::<_, Option<String>>(23)?,
        "input_tokens": row.get::<_, Option<i64>>(24)?,
        "output_tokens": row.get::<_, Option<i64>>(25)?,
        "cached_tokens": row.get::<_, Option<i64>>(26)?,
        "reasoning_tokens": row.get::<_, Option<i64>>(27)?,
        "preview": row.get::<_, Option<String>>(28)?,
    }))
}

fn collect_rows(
    conn: &Connection,
    sql: &str,
    values: &[SqlValue],
    map: impl Fn(&rusqlite::Row<'_>) -> rusqlite::Result<Value>,
) -> rusqlite::Result<Value> {
    let mut statement = conn.prepare(sql)?;
    let rows = statement
        .query_map(params_from_iter(values.iter()), |row| map(row))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Value::Array(rows))
}
