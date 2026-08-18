use std::{collections::HashMap, convert::Infallible, sync::Arc, time::Duration};

use axum::{
    Json, Router,
    extract::{Path, Query, Request, State},
    http::{StatusCode, header},
    middleware::{self, Next},
    response::{
        IntoResponse, Response,
        sse::{Event, KeepAlive, Sse},
    },
    routing::get,
};
use rusqlite::{Connection, params_from_iter, types::Value as SqlValue};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio_stream::wrappers::ReceiverStream;

use crate::{db::Db, pricing::PricingTable};

pub struct LensState {
    pub db: Db,
    pub pricing: PricingTable,
    pub access_token: Option<String>,
}

pub fn build_app(state: Arc<LensState>) -> Router {
    let api = Router::new()
        .route("/api/overview", get(overview))
        .route("/api/requests", get(list_requests))
        .route("/api/requests/{id}", get(request_detail))
        .route("/api/sessions", get(list_sessions))
        .route("/api/stream", get(stream))
        .layer(middleware::from_fn_with_state(state.clone(), require_token))
        .with_state(state.clone());
    Router::new()
        .route("/", get(index))
        .route("/healthz", get(|| async { Json(json!({"status":"ok"})) }))
        .merge(api)
        .with_state(state)
}

/// The static shell is public; every data endpoint requires the token when
/// LENS_ACCESS_TOKEN is configured. EventSource cannot set headers, so the
/// token is also accepted as a `token` query parameter.
async fn require_token(
    State(state): State<Arc<LensState>>,
    request: Request,
    next: Next,
) -> Response {
    let Some(expected) = state.access_token.as_deref() else {
        return next.run(request).await;
    };
    let from_header = request
        .headers()
        .get("x-lens-token")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let from_query = request.uri().query().and_then(|query| {
        query
            .split('&')
            .find_map(|pair| pair.strip_prefix("token=").map(str::to_owned))
    });
    if from_header.as_deref() == Some(expected) || from_query.as_deref() == Some(expected) {
        next.run(request).await
    } else {
        (
            StatusCode::UNAUTHORIZED,
            Json(json!({"error":"unauthorized","message":"missing or invalid access token"})),
        )
            .into_response()
    }
}

async fn index() -> Response {
    (
        [
            (header::CONTENT_TYPE, "text/html; charset=utf-8"),
            // The SPA is a single inlined file that changes on every deploy;
            // force revalidation so browsers never show a stale dashboard.
            (header::CACHE_CONTROL, "no-cache"),
        ],
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
    session: Option<String>,
    q: Option<String>,
}

async fn overview(
    State(state): State<Arc<LensState>>,
    Query(params): Query<OverviewParams>,
) -> Result<Json<Value>, ApiFailure> {
    let hours = params.hours.unwrap_or(24).clamp(1, 24 * 90);
    run_query(state.clone(), move |conn, pricing| {
        build_overview(conn, pricing, hours)
    })
    .await
}

async fn list_requests(
    State(state): State<Arc<LensState>>,
    Query(params): Query<ListParams>,
) -> Result<Json<Value>, ApiFailure> {
    run_query(state.clone(), move |conn, pricing| {
        build_list(conn, pricing, &params)
    })
    .await
}

async fn list_sessions(
    State(state): State<Arc<LensState>>,
    Query(params): Query<OverviewParams>,
) -> Result<Json<Value>, ApiFailure> {
    let hours = params.hours.unwrap_or(24).clamp(1, 24 * 90);
    run_query(state.clone(), move |conn, pricing| {
        build_sessions(conn, pricing, hours)
    })
    .await
}

async fn request_detail(
    State(state): State<Arc<LensState>>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiFailure> {
    let found = run_query(state.clone(), move |conn, pricing| {
        build_detail(conn, pricing, &id)
    })
    .await?;
    match found.0 {
        Value::Null => Err(ApiFailure::NotFound),
        value => Ok(Json(value)),
    }
}

/// Server-sent events: emits a summary row whenever an exchange is inserted or
/// reaches a terminal state, by polling the updated_at column. Each connection
/// keeps its own cursor and change cache.
async fn stream(State(state): State<Arc<LensState>>) -> impl IntoResponse {
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Event, Infallible>>(64);
    tokio::spawn(async move {
        let mut cursor = chrono::Utc::now().timestamp();
        let mut seen: HashMap<String, String> = HashMap::new();
        loop {
            tokio::time::sleep(Duration::from_millis(1500)).await;
            let since = cursor - 1;
            let rows = state.db.with(|conn| {
                collect_rows(
                    conn,
                    &format!(
                        "SELECT {SUMMARY_COLUMNS}, updated_at FROM exchanges
                         WHERE updated_at >= ? ORDER BY updated_at ASC LIMIT 200"
                    ),
                    &[SqlValue::from(since)],
                    |row| summary_row(row, &state.pricing),
                )
            });
            let Ok(Value::Array(rows)) = rows else {
                continue;
            };
            for row in rows {
                if let Some(updated) = row.get("updated_at").and_then(Value::as_i64)
                    && updated > cursor
                {
                    cursor = updated;
                }
                let id = row
                    .get("request_id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
                let fingerprint = row.to_string();
                if seen.get(&id) == Some(&fingerprint) {
                    continue;
                }
                seen.insert(id, fingerprint);
                if seen.len() > 1000 {
                    seen.clear();
                }
                let event = Event::default().json_data(&row).unwrap_or_default();
                if tx.send(Ok(event)).await.is_err() {
                    return;
                }
            }
        }
    });
    Sse::new(ReceiverStream::new(rx)).keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
}

async fn run_query(
    state: Arc<LensState>,
    work: impl FnOnce(&Connection, &PricingTable) -> rusqlite::Result<Value> + Send + 'static,
) -> Result<Json<Value>, ApiFailure> {
    tokio::task::spawn_blocking(move || {
        let pricing = &state.pricing;
        state.db.with(|conn| work(conn, pricing))
    })
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

fn cost_for(
    pricing: &PricingTable,
    model: Option<&str>,
    input: Option<i64>,
    output: Option<i64>,
    cached: Option<i64>,
    reasoning: Option<i64>,
) -> Option<f64> {
    if input.is_none() && output.is_none() {
        return None;
    }
    Some(pricing.estimate_usd(
        model.unwrap_or_default(),
        input.unwrap_or(0),
        output.unwrap_or(0),
        cached.unwrap_or(0),
        reasoning.unwrap_or(0),
    ))
}

const SUMMARY_COLUMNS: &str = "request_id, ts, model, format, stream, outcome, status, duration_ms,
    input_tokens, output_tokens, cached_tokens, reasoning_tokens, preview, client_ip, route_mode,
    finish_reason, req_bytes, resp_bytes, cancel_stage, protocol_complete, session_key, client_tag";

fn summary_row(row: &rusqlite::Row<'_>, pricing: &PricingTable) -> rusqlite::Result<Value> {
    let model = row.get::<_, Option<String>>(2)?;
    let input = row.get::<_, Option<i64>>(8)?;
    let output = row.get::<_, Option<i64>>(9)?;
    let cached = row.get::<_, Option<i64>>(10)?;
    let reasoning = row.get::<_, Option<i64>>(11)?;
    let cost = cost_for(pricing, model.as_deref(), input, output, cached, reasoning);
    let mut value = json!({
        "request_id": row.get::<_, String>(0)?,
        "ts": row.get::<_, Option<String>>(1)?,
        "model": model,
        "format": row.get::<_, Option<String>>(3)?,
        "stream": row.get::<_, Option<i64>>(4)?,
        "outcome": row.get::<_, Option<String>>(5)?,
        "status": row.get::<_, Option<i64>>(6)?,
        "duration_ms": row.get::<_, Option<i64>>(7)?,
        "input_tokens": input,
        "output_tokens": output,
        "preview": row.get::<_, Option<String>>(12)?,
        "client_ip": row.get::<_, Option<String>>(13)?,
        "route_mode": row.get::<_, Option<String>>(14)?,
        "finish_reason": row.get::<_, Option<String>>(15)?,
        "req_bytes": row.get::<_, Option<i64>>(16)?,
        "resp_bytes": row.get::<_, Option<i64>>(17)?,
        "cancel_stage": row.get::<_, Option<String>>(18)?,
        "protocol_complete": row.get::<_, Option<i64>>(19)?,
        "session_key": row.get::<_, Option<String>>(20)?,
        "client_tag": row.get::<_, Option<String>>(21)?,
        "cost_usd": cost,
    });
    // The stream query appends updated_at after the summary columns.
    if let Ok(updated) = row.get::<_, Option<i64>>(22) {
        value["updated_at"] = json!(updated);
    }
    Ok(value)
}

fn build_overview(
    conn: &Connection,
    pricing: &PricingTable,
    hours: i64,
) -> rusqlite::Result<Value> {
    let since = since_unix(hours);
    let bucket: i64 = match hours {
        ..=2 => 60,
        3..=6 => 300,
        7..=24 => 900,
        _ => 3600,
    };

    let mut totals = conn.query_row(
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

    let mut total_cost = 0.0;
    let mut total_savings = 0.0;
    let by_model = {
        let mut statement = conn.prepare(
            "SELECT COALESCE(model,'(unknown)'), COUNT(*),
                    COALESCE(SUM(input_tokens),0), COALESCE(SUM(output_tokens),0),
                    COALESCE(SUM(cached_tokens),0), COALESCE(SUM(reasoning_tokens),0),
                    CAST(AVG(CASE WHEN outcome='ok' THEN duration_ms END) AS INTEGER),
                    SUM(outcome IN ('http_error','transport_error')),
                    SUM(outcome = 'cancelled')
             FROM exchanges WHERE ts_unix >= ?1 GROUP BY 1 ORDER BY 2 DESC LIMIT 20",
        )?;
        let rows = statement
            .query_map([since], |row| {
                let model: String = row.get(0)?;
                let input: i64 = row.get(2)?;
                let output: i64 = row.get(3)?;
                let cached: i64 = row.get(4)?;
                let reasoning: i64 = row.get(5)?;
                let cost = pricing.estimate_usd(&model, input, output, cached, reasoning);
                let savings = pricing.cache_savings_usd(&model, cached);
                Ok(json!({
                    "model": model,
                    "count": row.get::<_, i64>(1)?,
                    "input_tokens": input,
                    "output_tokens": output,
                    "avg_ms": row.get::<_, Option<i64>>(6)?,
                    "errors": row.get::<_, Option<i64>>(7)?.unwrap_or(0),
                    "cancelled": row.get::<_, Option<i64>>(8)?.unwrap_or(0),
                    "cost_usd": cost,
                    "cache_savings_usd": savings,
                }))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        for row in &rows {
            total_cost += row.get("cost_usd").and_then(Value::as_f64).unwrap_or(0.0);
            total_savings += row
                .get("cache_savings_usd")
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
        }
        Value::Array(rows)
    };
    totals["cost_usd"] = json!(total_cost);
    totals["cache_savings_usd"] = json!(total_savings);

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
        "SELECT COALESCE(NULLIF(client_tag,''), client_ip, '(unknown)') AS client, COUNT(*) FROM exchanges
         WHERE ts_unix >= ?1 GROUP BY 1 ORDER BY 2 DESC LIMIT 10",
        &[SqlValue::from(since)],
        |row| {
            Ok(json!({
                "client": row.get::<_, String>(0)?,
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

fn build_list(
    conn: &Connection,
    pricing: &PricingTable,
    params: &ListParams,
) -> rusqlite::Result<Value> {
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
    if let Some(session) = params.session.as_deref().filter(|value| !value.is_empty()) {
        clauses.push("session_key = ?".into());
        values.push(SqlValue::from(session.to_owned()));
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
            "SELECT {SUMMARY_COLUMNS} FROM exchanges WHERE {where_clause}
             ORDER BY ts_unix DESC, request_id DESC LIMIT ? OFFSET ?"
        ),
        &values,
        |row| summary_row(row, pricing),
    )?;

    let models = collect_rows(
        conn,
        "SELECT DISTINCT model FROM exchanges WHERE model IS NOT NULL ORDER BY model",
        &[],
        |row| Ok(Value::String(row.get::<_, String>(0)?)),
    )?;

    Ok(json!({"total": total, "rows": rows, "models": models}))
}

fn build_sessions(
    conn: &Connection,
    pricing: &PricingTable,
    hours: i64,
) -> rusqlite::Result<Value> {
    let since = since_unix(hours);
    // Sessions can mix models (main model plus background helpers), so cost is
    // priced per (session, model) split and then summed, reference-style.
    let mut costs: HashMap<String, f64> = HashMap::new();
    {
        let mut statement = conn.prepare(
            "SELECT session_key, COALESCE(model,''),
                    COALESCE(SUM(input_tokens),0), COALESCE(SUM(output_tokens),0),
                    COALESCE(SUM(cached_tokens),0), COALESCE(SUM(reasoning_tokens),0)
             FROM exchanges WHERE ts_unix >= ?1 AND session_key IS NOT NULL
             GROUP BY session_key, model",
        )?;
        let rows = statement.query_map([since], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, i64>(5)?,
            ))
        })?;
        for row in rows {
            let (key, model, input, output, cached, reasoning) = row?;
            *costs.entry(key).or_default() +=
                pricing.estimate_usd(&model, input, output, cached, reasoning);
        }
    }

    let mut statement = conn.prepare(
        "SELECT session_key, MIN(ts_unix), MAX(ts_unix), MIN(ts), MAX(ts), COUNT(*),
                SUM(outcome = 'ok'), SUM(outcome IN ('http_error','transport_error')), SUM(outcome = 'cancelled'),
                COALESCE(SUM(input_tokens),0), COALESCE(SUM(output_tokens),0),
                COALESCE(SUM(duration_ms),0),
                MAX(session_hint), MAX(client_ip), GROUP_CONCAT(DISTINCT model), MAX(client_tag)
         FROM exchanges WHERE ts_unix >= ?1 AND session_key IS NOT NULL
         GROUP BY session_key ORDER BY MAX(ts_unix) DESC LIMIT 200",
    )?;
    let rows = statement
        .query_map([since], |row| {
            let key: String = row.get(0)?;
            let cost = costs.get(&key).copied();
            Ok(json!({
                "session_key": key,
                "first_unix": row.get::<_, i64>(1)?,
                "last_unix": row.get::<_, i64>(2)?,
                "first_ts": row.get::<_, Option<String>>(3)?,
                "last_ts": row.get::<_, Option<String>>(4)?,
                "count": row.get::<_, i64>(5)?,
                "ok": row.get::<_, Option<i64>>(6)?.unwrap_or(0),
                "errors": row.get::<_, Option<i64>>(7)?.unwrap_or(0),
                "cancelled": row.get::<_, Option<i64>>(8)?.unwrap_or(0),
                "input_tokens": row.get::<_, i64>(9)?,
                "output_tokens": row.get::<_, i64>(10)?,
                "model_ms": row.get::<_, i64>(11)?,
                "hint": row.get::<_, Option<String>>(12)?,
                "client_ip": row.get::<_, Option<String>>(13)?,
                "models": row.get::<_, Option<String>>(14)?,
                "client_tag": row.get::<_, Option<String>>(15)?,
                "cost_usd": cost,
            }))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(json!({"sessions": rows}))
}

fn build_detail(conn: &Connection, pricing: &PricingTable, id: &str) -> rusqlite::Result<Value> {
    let mut statement = conn.prepare(
        "SELECT request_id, ts, upstream_url, format, model, stream, client_ip, route_mode,
                req_body, req_bytes, req_truncated,
                outcome, status, duration_ms, complete, protocol_complete, cancel_stage, error_message,
                resp_headers, resp_body, resp_bytes, resp_truncated,
                agg_response, finish_reason,
                input_tokens, output_tokens, cached_tokens, reasoning_tokens, preview,
                session_key, session_hint, client_req_body, anthropic_response, client_tag
         FROM exchanges WHERE request_id = ?1",
    )?;
    let mut rows = statement.query([id])?;
    let Some(row) = rows.next()? else {
        return Ok(Value::Null);
    };
    let model = row.get::<_, Option<String>>(4)?;
    let input = row.get::<_, Option<i64>>(24)?;
    let output = row.get::<_, Option<i64>>(25)?;
    let cached = row.get::<_, Option<i64>>(26)?;
    let reasoning = row.get::<_, Option<i64>>(27)?;
    let cost = cost_for(pricing, model.as_deref(), input, output, cached, reasoning);
    Ok(json!({
        "request_id": row.get::<_, String>(0)?,
        "ts": row.get::<_, Option<String>>(1)?,
        "upstream_url": row.get::<_, Option<String>>(2)?,
        "format": row.get::<_, Option<String>>(3)?,
        "model": model,
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
        "input_tokens": input,
        "output_tokens": output,
        "cached_tokens": cached,
        "reasoning_tokens": reasoning,
        "preview": row.get::<_, Option<String>>(28)?,
        "session_key": row.get::<_, Option<String>>(29)?,
        "session_hint": row.get::<_, Option<String>>(30)?,
        "client_req_body": row.get::<_, Option<String>>(31)?,
        "anthropic_response": row.get::<_, Option<String>>(32)?,
        "client_tag": row.get::<_, Option<String>>(33)?,
        "cost_usd": cost,
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
