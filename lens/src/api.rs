use std::{
    collections::HashMap,
    convert::Infallible,
    sync::Arc,
    time::{Duration, Instant},
};

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
use percent_encoding::percent_decode_str;
use rusqlite::{Connection, params_from_iter, types::Value as SqlValue};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio_stream::wrappers::ReceiverStream;

use crate::{
    db::Db,
    pricing::{PricingTable, TokenUsage},
};

pub struct LensState {
    pub db: Db,
    pub pricing: PricingTable,
    pub access_token: Option<String>,
    pub overview_cache: tokio::sync::Mutex<HashMap<OverviewCacheKey, CachedOverview>>,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct OverviewCacheKey {
    hours: i64,
    client: Option<String>,
}

pub struct CachedOverview {
    expires_at: Instant,
    value: Value,
}

const OVERVIEW_CACHE_TTL: Duration = Duration::from_secs(2);

pub fn build_app(state: Arc<LensState>) -> Router {
    let api = Router::new()
        .route("/api/overview", get(overview))
        .route("/api/requests", get(list_requests))
        .route("/api/requests/{id}", get(request_detail))
        .route("/api/sessions", get(list_sessions))
        .route("/api/clients", get(list_clients))
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
        query.split('&').find_map(|pair| {
            // The dashboard sends encodeURIComponent(token), so the raw value
            // must be percent-decoded before comparison or any token with
            // reserved characters would never match.
            pair.strip_prefix("token=")
                .map(|value| percent_decode_str(value).decode_utf8_lossy().into_owned())
        })
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
    client: Option<String>,
}

/// 展示与筛选用的统一调用方标识：自报 tag 优先，缺省回退来源 IP。
const CLIENT_EXPR: &str = "COALESCE(NULLIF(client_tag,''), client_ip, '(unknown)')";

fn client_filter(client: Option<&str>) -> (String, Vec<SqlValue>) {
    match client.filter(|value| !value.is_empty()) {
        Some(value) => (
            format!(" AND {CLIENT_EXPR} = ?"),
            vec![SqlValue::from(value.to_owned())],
        ),
        None => (String::new(), Vec::new()),
    }
}

/// Builds a bound SQL CASE expression that classifies each exchange into its
/// model's short/long context tier. Exact model values come from the database;
/// the pricing table still owns substring matching and threshold selection.
fn context_tier_case(
    conn: &Connection,
    pricing: &PricingTable,
    filter_suffix: &str,
    filter_values: &[SqlValue],
) -> rusqlite::Result<(String, Vec<SqlValue>)> {
    let mut statement = conn.prepare(&format!(
        "SELECT DISTINCT COALESCE(model,'(unknown)')
         FROM exchanges WHERE ts_unix >= ?{filter_suffix}"
    ))?;
    let models = statement
        .query_map(params_from_iter(filter_values.iter()), |row| {
            row.get::<_, String>(0)
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let mut arms = Vec::new();
    let mut values = Vec::new();
    for model in models {
        let Some(threshold) = pricing.long_context_threshold(&model) else {
            continue;
        };
        arms.push(
            "WHEN ? THEN CASE WHEN COALESCE(input_tokens,0) > ? THEN 1 ELSE 0 END".to_owned(),
        );
        values.push(SqlValue::from(model));
        values.push(SqlValue::from(threshold));
    }
    if arms.is_empty() {
        Ok(("0".to_owned(), values))
    } else {
        Ok((
            format!(
                "CASE COALESCE(model,'(unknown)') {} ELSE 0 END",
                arms.join(" ")
            ),
            values,
        ))
    }
}

#[derive(Deserialize)]
struct ListParams {
    hours: Option<i64>,
    limit: Option<i64>,
    offset: Option<i64>,
    model: Option<String>,
    outcome: Option<String>,
    session: Option<String>,
    client: Option<String>,
    q: Option<String>,
}

async fn overview(
    State(state): State<Arc<LensState>>,
    Query(params): Query<OverviewParams>,
) -> Result<Json<Value>, ApiFailure> {
    let hours = params.hours.unwrap_or(24).clamp(1, 24 * 90);
    let client = params.client.filter(|value| !value.is_empty());
    let key = OverviewCacheKey {
        hours,
        client: client.clone(),
    };
    // Holding this async mutex across the blocking query intentionally makes
    // concurrent cache misses single-flight instead of queueing duplicate full
    // database scans on Lens's shared SQLite connection.
    let mut cache = state.overview_cache.lock().await;
    let now = Instant::now();
    if let Some(cached) = cache.get(&key)
        && cached.expires_at > now
    {
        return Ok(Json(cached.value.clone()));
    }
    cache.retain(|_, cached| cached.expires_at > now);
    let result = run_query(state.clone(), move |conn, pricing| {
        build_overview(conn, pricing, hours, client.as_deref())
    })
    .await?;
    cache.insert(
        key,
        CachedOverview {
            expires_at: Instant::now() + OVERVIEW_CACHE_TTL,
            value: result.0.clone(),
        },
    );
    Ok(result)
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
        build_sessions(conn, pricing, hours, params.client.as_deref())
    })
    .await
}

async fn list_clients(
    State(state): State<Arc<LensState>>,
    Query(params): Query<OverviewParams>,
) -> Result<Json<Value>, ApiFailure> {
    let hours = params.hours.unwrap_or(24).clamp(1, 24 * 90);
    run_query(state.clone(), move |conn, _| {
        let clients = collect_rows(
            conn,
            &format!("SELECT DISTINCT {CLIENT_EXPR} FROM exchanges WHERE ts_unix >= ? ORDER BY 1"),
            &[SqlValue::from(since_unix(hours))],
            |row| Ok(Value::String(row.get::<_, String>(0)?)),
        )?;
        Ok(json!({"clients": clients}))
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
            // Exit as soon as the client disconnects instead of polling until
            // the next row makes a send fail.
            tokio::select! {
                _ = tx.closed() => return,
                _ = tokio::time::sleep(Duration::from_millis(1500)) => {}
            }
            let since = cursor - 1;
            // rusqlite queries are synchronous; keep them off the async workers.
            let query_state = state.clone();
            let rows = tokio::task::spawn_blocking(move || {
                query_state.db.with(|conn| {
                    collect_rows(
                        conn,
                        &format!(
                            "SELECT {SUMMARY_COLUMNS}, updated_at FROM exchanges
                             WHERE updated_at >= ? ORDER BY updated_at ASC LIMIT 200"
                        ),
                        &[SqlValue::from(since)],
                        |row| summary_row(row, &query_state.pricing),
                    )
                })
            })
            .await;
            let Ok(Ok(Value::Array(rows))) = rows else {
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
    cache_write: Option<i64>,
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
        cache_write.unwrap_or(0),
    ))
}

const SUMMARY_COLUMNS: &str = "request_id, ts, model, format, stream, outcome, status, duration_ms,
    input_tokens, output_tokens, cached_tokens, reasoning_tokens, preview, client_ip, route_mode,
    finish_reason, req_bytes, resp_bytes, cancel_stage, protocol_complete, session_key, client_tag,
    cache_write_tokens";

fn summary_row(row: &rusqlite::Row<'_>, pricing: &PricingTable) -> rusqlite::Result<Value> {
    let model = row.get::<_, Option<String>>(2)?;
    let input = row.get::<_, Option<i64>>(8)?;
    let output = row.get::<_, Option<i64>>(9)?;
    let cached = row.get::<_, Option<i64>>(10)?;
    let reasoning = row.get::<_, Option<i64>>(11)?;
    let cache_write = row.get::<_, Option<i64>>(22)?;
    let cost = cost_for(
        pricing,
        model.as_deref(),
        input,
        output,
        cached,
        cache_write,
        reasoning,
    );
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
        "cached_tokens": cached,
        "cache_write_tokens": cache_write,
        "reasoning_tokens": reasoning,
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
    if let Ok(updated) = row.get::<_, Option<i64>>(23) {
        value["updated_at"] = json!(updated);
    }
    Ok(value)
}

const ONE_PASS_OVERVIEW_THRESHOLD: i64 = 100_000;

#[derive(Clone, Copy, Default)]
struct UsageTotals {
    input: i64,
    output: i64,
    cached: i64,
    cache_write: i64,
    reasoning: i64,
}

impl UsageTotals {
    fn add(&mut self, usage: TokenUsage) {
        self.input += usage.input;
        self.output += usage.output;
        self.cached += usage.cached;
        self.cache_write += usage.cache_creation;
        self.reasoning += usage.reasoning;
    }

    fn as_pricing_usage(self) -> TokenUsage {
        TokenUsage {
            input: self.input,
            output: self.output,
            cached: self.cached,
            reasoning: self.reasoning,
            cache_creation: self.cache_write,
        }
    }
}

#[derive(Default)]
struct OverviewModelTotals {
    count: i64,
    input: i64,
    output: i64,
    cached: i64,
    cache_write: i64,
    reasoning: i64,
    duration_sum: i64,
    duration_count: i64,
    errors: i64,
    cancelled: i64,
    long_threshold: Option<i64>,
    pricing_tiers: [UsageTotals; 2],
}

#[derive(Default)]
struct OverviewSeriesTotals {
    ok: i64,
    error: i64,
    cancelled: i64,
    input: i64,
    output: i64,
}

#[derive(Default)]
struct OverviewTotals {
    count: i64,
    ok: i64,
    http_error: i64,
    transport_error: i64,
    cancelled: i64,
    pending: i64,
    input: i64,
    output: i64,
    cached: i64,
    cache_write: i64,
    reasoning: i64,
}

fn build_overview(
    conn: &Connection,
    pricing: &PricingTable,
    hours: i64,
    client: Option<&str>,
) -> rusqlite::Result<Value> {
    let since = since_unix(hours);
    let (cf, cf_values) = client_filter(client);
    let mut values = vec![SqlValue::from(since)];
    values.extend(cf_values);
    let count = conn.query_row(
        &format!("SELECT COUNT(*) FROM exchanges WHERE ts_unix >= ?{cf}"),
        params_from_iter(values.iter()),
        |row| row.get::<_, i64>(0),
    )?;
    // Client filtering currently has no dedicated expression index, so every
    // multi-query aggregate would rescan the whole time window. One pass wins
    // even when the matching client itself has relatively few rows.
    if client.is_some() || count >= ONE_PASS_OVERVIEW_THRESHOLD {
        build_overview_one_pass(conn, pricing, hours, client)
    } else {
        build_overview_multi_query(conn, pricing, hours, client)
    }
}

fn build_overview_one_pass(
    conn: &Connection,
    pricing: &PricingTable,
    hours: i64,
    client: Option<&str>,
) -> rusqlite::Result<Value> {
    let since = since_unix(hours);
    let (cf, cf_values) = client_filter(client);
    let bucket: i64 = match hours {
        ..=2 => 60,
        3..=6 => 300,
        7..=24 => 900,
        _ => 3600,
    };
    let mut values = vec![SqlValue::from(since)];
    values.extend(cf_values);

    let mut totals = OverviewTotals::default();
    let mut durations = Vec::new();
    let mut series_by_bucket: HashMap<i64, OverviewSeriesTotals> = HashMap::new();
    let mut models: HashMap<String, OverviewModelTotals> = HashMap::new();
    let mut status_counts: HashMap<i64, i64> = HashMap::new();
    let mut client_counts: HashMap<String, i64> = HashMap::new();

    let mut statement = conn.prepare(&format!(
        "SELECT ts_unix, COALESCE(model,'(unknown)'),
                COALESCE(input_tokens,0), COALESCE(output_tokens,0),
                COALESCE(cached_tokens,0), COALESCE(cache_write_tokens,0),
                COALESCE(reasoning_tokens,0), COALESCE(outcome,''),
                status, duration_ms, {CLIENT_EXPR}
         FROM exchanges WHERE ts_unix >= ?{cf}"
    ))?;
    let mut rows = statement.query(params_from_iter(values.iter()))?;
    while let Some(row) = rows.next()? {
        let ts_unix = row.get::<_, i64>(0)?;
        let model = row.get_ref(1)?.as_str().unwrap_or("(unknown)");
        let input = row.get::<_, i64>(2)?;
        let output = row.get::<_, i64>(3)?;
        let cached = row.get::<_, i64>(4)?;
        let cache_write = row.get::<_, i64>(5)?;
        let reasoning = row.get::<_, i64>(6)?;
        let outcome = row.get_ref(7)?.as_str().unwrap_or("");
        let status = row.get::<_, Option<i64>>(8)?;
        let duration = row.get::<_, Option<i64>>(9)?;
        let client_name = row.get_ref(10)?.as_str().unwrap_or("(unknown)");

        totals.count += 1;
        totals.input += input;
        totals.output += output;
        totals.cached += cached;
        totals.cache_write += cache_write;
        totals.reasoning += reasoning;
        match outcome {
            "ok" => totals.ok += 1,
            "http_error" => totals.http_error += 1,
            "transport_error" => totals.transport_error += 1,
            "cancelled" => totals.cancelled += 1,
            "pending" => totals.pending += 1,
            _ => {}
        }

        let series = series_by_bucket
            .entry((ts_unix / bucket) * bucket)
            .or_default();
        series.input += input;
        series.output += output;
        match outcome {
            "ok" => series.ok += 1,
            "http_error" | "transport_error" => series.error += 1,
            "cancelled" => series.cancelled += 1,
            _ => {}
        }

        if !models.contains_key(model) {
            models.insert(
                model.to_owned(),
                OverviewModelTotals {
                    long_threshold: pricing.long_context_threshold(model),
                    ..Default::default()
                },
            );
        }
        let model_totals = models.get_mut(model).expect("model inserted above");
        model_totals.count += 1;
        model_totals.input += input;
        model_totals.output += output;
        model_totals.cached += cached;
        model_totals.cache_write += cache_write;
        model_totals.reasoning += reasoning;
        if matches!(outcome, "http_error" | "transport_error") {
            model_totals.errors += 1;
        }
        if outcome == "cancelled" {
            model_totals.cancelled += 1;
        }
        if outcome == "ok"
            && let Some(duration) = duration
        {
            durations.push(duration);
            model_totals.duration_sum += duration;
            model_totals.duration_count += 1;
        }
        let normalized = TokenUsage {
            input: input.max(0),
            output: output.max(0),
            cached: cached.clamp(0, input.max(0)),
            reasoning: reasoning.clamp(0, output.max(0)),
            cache_creation: cache_write.max(0),
        };
        let tier = usize::from(
            model_totals
                .long_threshold
                .is_some_and(|threshold| normalized.input > threshold),
        );
        model_totals.pricing_tiers[tier].add(normalized);

        if matches!(outcome, "ok" | "http_error") {
            *status_counts.entry(status.unwrap_or(0)).or_default() += 1;
        }
        if let Some(count) = client_counts.get_mut(client_name) {
            *count += 1;
        } else {
            client_counts.insert(client_name.to_owned(), 1);
        }
    }

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

    let mut series = series_by_bucket.into_iter().collect::<Vec<_>>();
    series.sort_unstable_by_key(|(bucket, _)| *bucket);
    let series = Value::Array(
        series
            .into_iter()
            .map(|(bucket, values)| {
                json!({
                    "t": bucket,
                    "ok": values.ok,
                    "error": values.error,
                    "cancelled": values.cancelled,
                    "input_tokens": values.input,
                    "output_tokens": values.output,
                })
            })
            .collect(),
    );

    let mut total_cost = 0.0;
    let mut total_savings = 0.0;
    let mut by_model = Vec::with_capacity(models.len());
    for (model, values) in models {
        let mut cost = 0.0;
        let mut savings = 0.0;
        for (tier, usage) in values.pricing_tiers.into_iter().enumerate() {
            cost += pricing.estimate_usd_for_context(&model, usage.as_pricing_usage(), tier == 1);
            savings += pricing.cache_savings_usd_for_context(&model, usage.cached, tier == 1);
        }
        total_cost += cost;
        total_savings += savings;
        let avg_ms =
            (values.duration_count > 0).then_some(values.duration_sum / values.duration_count);
        by_model.push(json!({
            "model": model,
            "count": values.count,
            "input_tokens": values.input,
            "output_tokens": values.output,
            "cached_tokens": values.cached,
            "cache_write_tokens": values.cache_write,
            "reasoning_tokens": values.reasoning,
            "avg_ms": avg_ms,
            "errors": values.errors,
            "cancelled": values.cancelled,
            "cost_usd": cost,
            "cache_savings_usd": savings,
        }));
    }
    by_model.sort_by(|left, right| {
        right["count"]
            .as_i64()
            .cmp(&left["count"].as_i64())
            .then_with(|| left["model"].as_str().cmp(&right["model"].as_str()))
    });
    by_model.truncate(20);

    let mut by_status = status_counts.into_iter().collect::<Vec<_>>();
    by_status
        .sort_unstable_by(|left, right| right.1.cmp(&left.1).then_with(|| left.0.cmp(&right.0)));
    let by_status = Value::Array(
        by_status
            .into_iter()
            .map(|(status, count)| json!({"status": status, "count": count}))
            .collect(),
    );

    let mut by_client = client_counts.into_iter().collect::<Vec<_>>();
    by_client
        .sort_unstable_by(|left, right| right.1.cmp(&left.1).then_with(|| left.0.cmp(&right.0)));
    by_client.truncate(10);
    let by_client = Value::Array(
        by_client
            .into_iter()
            .map(|(client, count)| json!({"client": client, "count": count}))
            .collect(),
    );

    Ok(json!({
        "totals": {
            "count": totals.count,
            "ok": totals.ok,
            "http_error": totals.http_error,
            "transport_error": totals.transport_error,
            "cancelled": totals.cancelled,
            "pending": totals.pending,
            "input_tokens": totals.input,
            "output_tokens": totals.output,
            "cached_tokens": totals.cached,
            "cache_write_tokens": totals.cache_write,
            "reasoning_tokens": totals.reasoning,
            "cost_usd": total_cost,
            "cache_savings_usd": total_savings,
        },
        "latency": latency,
        "series": series,
        "by_model": by_model,
        "by_status": by_status,
        "by_client": by_client,
        "bucket_seconds": bucket,
        "hours": hours,
    }))
}

fn build_overview_multi_query(
    conn: &Connection,
    pricing: &PricingTable,
    hours: i64,
    client: Option<&str>,
) -> rusqlite::Result<Value> {
    let since = since_unix(hours);
    let (cf, cf_values) = client_filter(client);
    let bucket: i64 = match hours {
        ..=2 => 60,
        3..=6 => 300,
        7..=24 => 900,
        _ => 3600,
    };

    let mut base_values: Vec<SqlValue> = vec![SqlValue::from(since)];
    base_values.extend(cf_values.iter().cloned());
    let mut totals = conn.query_row(
        &format!(
            "SELECT COUNT(*),
                SUM(outcome = 'ok'), SUM(outcome = 'http_error'),
                SUM(outcome = 'transport_error'), SUM(outcome = 'cancelled'), SUM(outcome = 'pending'),
                COALESCE(SUM(input_tokens),0), COALESCE(SUM(output_tokens),0),
                COALESCE(SUM(cached_tokens),0), COALESCE(SUM(cache_write_tokens),0),
                COALESCE(SUM(reasoning_tokens),0)
         FROM exchanges WHERE ts_unix >= ?{cf}"
        ),
        params_from_iter(base_values.iter()),
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
                "cache_write_tokens": row.get::<_, i64>(9)?,
                "reasoning_tokens": row.get::<_, i64>(10)?,
            }))
        },
    )?;

    let mut durations: Vec<i64> = conn
        .prepare(&format!(
            "SELECT duration_ms FROM exchanges
             WHERE ts_unix >= ? AND outcome = 'ok' AND duration_ms IS NOT NULL{cf}"
        ))?
        .query_map(params_from_iter(base_values.iter()), |row| row.get(0))?
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

    let mut series_values: Vec<SqlValue> = vec![SqlValue::from(since), SqlValue::from(bucket)];
    series_values.extend(cf_values.iter().cloned());
    let series = collect_rows(
        conn,
        &format!(
            "SELECT (ts_unix / ?2) * ?2 AS bucket,
                SUM(outcome = 'ok'),
                SUM(outcome IN ('http_error','transport_error')),
                SUM(outcome = 'cancelled'),
                COALESCE(SUM(input_tokens),0), COALESCE(SUM(output_tokens),0)
         FROM exchanges WHERE ts_unix >= ?1{cf} GROUP BY bucket ORDER BY bucket"
        ),
        &series_values,
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

    // Partition by each model's per-request context tier in SQL, then price the
    // small set of aggregate buckets in Rust. This preserves exact tiering
    // without moving every exchange across the SQLite boundary.
    let mut cost_by_model: HashMap<String, (f64, f64)> = HashMap::new();
    {
        let (tier_case, tier_values) = context_tier_case(conn, pricing, &cf, &base_values)?;
        let mut cost_values = tier_values;
        cost_values.extend(base_values.iter().cloned());
        let mut statement = conn.prepare(&format!(
            "SELECT COALESCE(model,'(unknown)'), {tier_case} AS long_context,
                    COALESCE(SUM(input_tokens),0), COALESCE(SUM(output_tokens),0),
                    COALESCE(SUM(cached_tokens),0), COALESCE(SUM(cache_write_tokens),0),
                    COALESCE(SUM(reasoning_tokens),0)
             FROM exchanges WHERE ts_unix >= ?{cf} GROUP BY 1, 2"
        ))?;
        let rows = statement.query_map(params_from_iter(cost_values.iter()), |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)? != 0,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, i64>(6)?,
            ))
        })?;
        for row in rows {
            let (model, long_context, input, output, cached, cache_write, reasoning) = row?;
            let estimate = cost_by_model.entry(model.clone()).or_default();
            estimate.0 += pricing.estimate_usd_for_context(
                &model,
                TokenUsage {
                    input,
                    output,
                    cached,
                    reasoning,
                    cache_creation: cache_write,
                },
                long_context,
            );
            estimate.1 += pricing.cache_savings_usd_for_context(&model, cached, long_context);
        }
    }
    let total_cost = cost_by_model
        .values()
        .map(|estimate| estimate.0)
        .sum::<f64>();
    let total_savings = cost_by_model
        .values()
        .map(|estimate| estimate.1)
        .sum::<f64>();
    let by_model = {
        let mut statement = conn.prepare(&format!(
            "SELECT COALESCE(model,'(unknown)'), COUNT(*),
                    COALESCE(SUM(input_tokens),0), COALESCE(SUM(output_tokens),0),
                    COALESCE(SUM(cached_tokens),0), COALESCE(SUM(cache_write_tokens),0),
                    COALESCE(SUM(reasoning_tokens),0),
                    CAST(AVG(CASE WHEN outcome='ok' THEN duration_ms END) AS INTEGER),
                    SUM(outcome IN ('http_error','transport_error')),
                    SUM(outcome = 'cancelled')
             FROM exchanges WHERE ts_unix >= ?{cf} GROUP BY 1 ORDER BY 2 DESC LIMIT 20"
        ))?;
        let rows = statement
            .query_map(params_from_iter(base_values.iter()), |row| {
                let model: String = row.get(0)?;
                let input: i64 = row.get(2)?;
                let output: i64 = row.get(3)?;
                let cached: i64 = row.get(4)?;
                let cache_write: i64 = row.get(5)?;
                let reasoning: i64 = row.get(6)?;
                let (cost, savings) = cost_by_model.get(&model).copied().unwrap_or_default();
                Ok(json!({
                    "model": model,
                    "count": row.get::<_, i64>(1)?,
                    "input_tokens": input,
                    "output_tokens": output,
                    "cached_tokens": cached,
                    "cache_write_tokens": cache_write,
                    "reasoning_tokens": reasoning,
                    "avg_ms": row.get::<_, Option<i64>>(7)?,
                    "errors": row.get::<_, Option<i64>>(8)?.unwrap_or(0),
                    "cancelled": row.get::<_, Option<i64>>(9)?.unwrap_or(0),
                    "cost_usd": cost,
                    "cache_savings_usd": savings,
                }))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Value::Array(rows)
    };
    totals["cost_usd"] = json!(total_cost);
    totals["cache_savings_usd"] = json!(total_savings);

    let by_status = collect_rows(
        conn,
        &format!(
            "SELECT COALESCE(status, 0), COUNT(*) FROM exchanges
         WHERE ts_unix >= ? AND outcome IN ('ok','http_error'){cf}
         GROUP BY 1 ORDER BY 2 DESC"
        ),
        &base_values,
        |row| {
            Ok(json!({
                "status": row.get::<_, i64>(0)?,
                "count": row.get::<_, i64>(1)?,
            }))
        },
    )?;

    let by_client = collect_rows(
        conn,
        &format!(
            "SELECT {CLIENT_EXPR} AS client, COUNT(*) FROM exchanges
         WHERE ts_unix >= ?{cf} GROUP BY 1 ORDER BY 2 DESC LIMIT 10"
        ),
        &base_values,
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
    if let Some(client) = params.client.as_deref().filter(|value| !value.is_empty()) {
        clauses.push(format!("{CLIENT_EXPR} = ?"));
        values.push(SqlValue::from(client.to_owned()));
    }
    if let Some(term) = params.q.as_deref().filter(|value| !value.is_empty()) {
        clauses.push(
            "(request_id LIKE ? OR preview LIKE ? OR request_id IN
                (SELECT request_id FROM exchange_bodies WHERE req_body LIKE ?))"
                .into(),
        );
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
    client: Option<&str>,
) -> rusqlite::Result<Value> {
    let since = since_unix(hours);
    let (cf, cf_values) = client_filter(client);
    let mut base_values: Vec<SqlValue> = vec![SqlValue::from(since)];
    base_values.extend(cf_values.iter().cloned());
    let mut statement = conn.prepare(&format!(
        "SELECT session_key, MIN(ts_unix), MAX(ts_unix), MIN(ts), MAX(ts), COUNT(*),
                SUM(outcome = 'ok'), SUM(outcome IN ('http_error','transport_error')), SUM(outcome = 'cancelled'),
                COALESCE(SUM(input_tokens),0), COALESCE(SUM(output_tokens),0),
                COALESCE(SUM(duration_ms),0),
                MAX(session_hint), MAX(client_ip), GROUP_CONCAT(DISTINCT model), MAX(client_tag)
         FROM exchanges WHERE ts_unix >= ?1 AND session_key IS NOT NULL{cf}
         GROUP BY session_key ORDER BY MAX(ts_unix) DESC LIMIT 200"
    ))?;
    let mut rows = statement
        .query_map(params_from_iter(base_values.iter()), |row| {
            let key: String = row.get(0)?;
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
                "cost_usd": Value::Null,
            }))
        })?
        .collect::<Result<Vec<_>, _>>()?;

    // Only the 200 sessions returned above need a cost. Pricing their member
    // exchanges directly is exact and lets the session index avoid aggregating
    // every historical session in the selected window.
    if !rows.is_empty() {
        let keys = rows
            .iter()
            .filter_map(|row| row["session_key"].as_str().map(str::to_owned))
            .collect::<Vec<_>>();
        let placeholders = std::iter::repeat_n("?", keys.len())
            .collect::<Vec<_>>()
            .join(",");
        let mut cost_values = base_values.clone();
        cost_values.extend(keys.iter().cloned().map(SqlValue::from));
        let mut costs: HashMap<String, f64> = HashMap::new();
        let mut statement = conn.prepare(&format!(
            "SELECT session_key, COALESCE(model,''),
                    COALESCE(input_tokens,0), COALESCE(output_tokens,0),
                    COALESCE(cached_tokens,0), COALESCE(cache_write_tokens,0),
                    COALESCE(reasoning_tokens,0)
             FROM exchanges WHERE ts_unix >= ?{cf}
               AND session_key IN ({placeholders})"
        ))?;
        let mut cost_rows = statement.query(params_from_iter(cost_values.iter()))?;
        while let Some(row) = cost_rows.next()? {
            let key = row.get::<_, String>(0)?;
            let model = row.get::<_, String>(1)?;
            *costs.entry(key).or_default() += pricing.estimate_usd(
                &model,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, i64>(6)?,
                row.get::<_, i64>(5)?,
            );
        }
        for row in &mut rows {
            if let Some(key) = row["session_key"].as_str()
                && let Some(cost) = costs.get(key)
            {
                row["cost_usd"] = json!(cost);
            }
        }
    }
    Ok(json!({"sessions": rows}))
}

fn build_detail(conn: &Connection, pricing: &PricingTable, id: &str) -> rusqlite::Result<Value> {
    let mut statement = conn.prepare(
        // The only query that needs bodies, so it is the only one that joins
        // them back in; every list and aggregate stays on the metadata table.
        "SELECT e.request_id, e.ts, e.upstream_url, e.format, e.model, e.stream, e.client_ip, e.route_mode,
                b.req_body, e.req_bytes, e.req_truncated,
                e.outcome, e.status, e.duration_ms, e.complete, e.protocol_complete, e.cancel_stage, e.error_message,
                b.resp_headers, b.resp_body, e.resp_bytes, e.resp_truncated,
                b.agg_response, e.finish_reason,
                e.input_tokens, e.output_tokens, e.cached_tokens, e.reasoning_tokens, e.preview,
                e.session_key, e.session_hint, b.client_req_body, b.anthropic_response, e.client_tag,
                e.cache_write_tokens
         FROM exchanges e LEFT JOIN exchange_bodies b ON b.request_id = e.request_id
         WHERE e.request_id = ?1",
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
    let cache_write = row.get::<_, Option<i64>>(34)?;
    let cost = cost_for(
        pricing,
        model.as_deref(),
        input,
        output,
        cached,
        cache_write,
        reasoning,
    );
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
        "cache_write_tokens": cache_write,
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

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;

    #[test]
    fn overview_prices_long_context_per_request_before_aggregation() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE exchanges (
                request_id TEXT PRIMARY KEY,
                ts TEXT,
                ts_unix INTEGER,
                model TEXT,
                outcome TEXT,
                status INTEGER,
                duration_ms INTEGER,
                input_tokens INTEGER,
                output_tokens INTEGER,
                cached_tokens INTEGER,
                cache_write_tokens INTEGER,
                reasoning_tokens INTEGER,
                client_tag TEXT,
                client_ip TEXT,
                session_key TEXT,
                session_hint TEXT
            );",
        )
        .unwrap();
        let now = chrono::Utc::now().timestamp();
        for (id, input, output, cached, cache_write) in [
            ("short-1", 200_000, 10_000, 50_000, 0),
            ("short-2", 200_000, 0, 0, 0),
            ("long", 300_000, 20_000, 100_000, 10_000),
        ] {
            conn.execute(
                "INSERT INTO exchanges (
                    request_id, ts, ts_unix, model, outcome, status, duration_ms,
                    input_tokens, output_tokens, cached_tokens, cache_write_tokens,
                    reasoning_tokens, client_tag, session_key, session_hint
                 ) VALUES (?1, datetime(?2, 'unixepoch'), ?2, 'openai/gpt-5.6-luna',
                           'ok', 200, 1, ?3, ?4, ?5, ?6, 0, 'test', 'session-1', 'hint')",
                params![id, now, input, output, cached, cache_write],
            )
            .unwrap();
        }

        let overview = build_overview(&conn, &PricingTable::default(), 24, None).unwrap();
        let total_cost = overview["totals"]["cost_usd"].as_f64().unwrap();
        let model_cost = overview["by_model"][0]["cost_usd"].as_f64().unwrap();
        let savings = overview["totals"]["cache_savings_usd"].as_f64().unwrap();

        assert_eq!(overview["totals"]["count"], 3);
        assert_eq!(overview["totals"]["cache_write_tokens"], 10_000);
        assert!((total_cost - 0.208).abs() < 1e-9);
        assert!((model_cost - 0.208).abs() < 1e-9);
        assert!((savings - 0.045).abs() < 1e-9);

        let one_pass = build_overview_one_pass(&conn, &PricingTable::default(), 24, None).unwrap();
        assert_eq!(one_pass["totals"]["count"], overview["totals"]["count"]);
        assert_eq!(
            one_pass["totals"]["input_tokens"],
            overview["totals"]["input_tokens"]
        );
        assert_eq!(one_pass["series"], overview["series"]);
        assert_eq!(one_pass["by_model"], overview["by_model"]);
        assert_eq!(one_pass["by_status"], overview["by_status"]);
        assert_eq!(one_pass["by_client"], overview["by_client"]);

        let sessions = build_sessions(&conn, &PricingTable::default(), 24, None).unwrap();
        assert_eq!(sessions["sessions"].as_array().unwrap().len(), 1);
        assert_eq!(sessions["sessions"][0]["session_key"], "session-1");
        assert!((sessions["sessions"][0]["cost_usd"].as_f64().unwrap() - 0.208).abs() < 1e-9);
    }
}
