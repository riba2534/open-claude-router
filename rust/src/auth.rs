use std::collections::{HashMap, HashSet};

use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode, Uri};
use serde_json::Value;
use url::Url;

use crate::error::ApiError;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum UpstreamFormat {
    ChatCompletions,
    Responses,
}

impl UpstreamFormat {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ChatCompletions => "chat-completions",
            Self::Responses => "responses",
        }
    }
}

#[derive(Clone, Debug)]
pub struct UpstreamConfig {
    pub url: String,
    pub authorization: String,
    pub model: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Endpoint {
    Messages,
    CountTokens,
}

fn invalid(code: &'static str, message: impl Into<String>) -> ApiError {
    ApiError::new(
        StatusCode::BAD_REQUEST,
        "invalid_request_error",
        code,
        message,
    )
}

fn header<'a>(headers: &'a HeaderMap, name: &'static str) -> Option<&'a str> {
    headers.get(name).and_then(|value| value.to_str().ok())
}

fn contains_invalid_header_value(value: &str) -> bool {
    value
        .bytes()
        .any(|byte| byte <= 0x08 || (0x0a..=0x1f).contains(&byte) || byte == 0x7f)
}

fn valid_url(raw: &str) -> bool {
    Url::parse(raw)
        .ok()
        .is_some_and(|url| matches!(url.scheme(), "http" | "https"))
}

pub fn parse_access_tokens(raw: Option<&str>) -> HashSet<String> {
    raw.unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

pub fn check_header_mode_auth(
    headers: &HeaderMap,
    allowed: &HashSet<String>,
) -> Result<(), ApiError> {
    if allowed.is_empty() {
        return Ok(());
    }
    let malformed = || {
        ApiError::new(
            StatusCode::UNAUTHORIZED,
            "authentication_error",
            "unauthorized",
            "missing or malformed Authorization header",
        )
    };
    let raw = header(headers, "authorization").ok_or_else(malformed)?;
    let Some((scheme, value)) = raw.get(..7).zip(raw.get(7..)) else {
        return Err(malformed());
    };
    if !scheme.eq_ignore_ascii_case("bearer ") {
        return Err(malformed());
    }
    if !allowed.contains(value.trim()) {
        return Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            "authentication_error",
            "unauthorized",
            "invalid access token",
        ));
    }
    Ok(())
}

pub fn check_embedded_mode_auth(
    headers: &HeaderMap,
    allowed: &HashSet<String>,
) -> Result<(), ApiError> {
    if allowed.is_empty() {
        return Ok(());
    }
    if header(headers, "x-ocr-token")
        .map(str::trim)
        .is_some_and(|token| allowed.contains(token))
    {
        return Ok(());
    }
    Err(ApiError::new(
        StatusCode::UNAUTHORIZED,
        "authentication_error",
        "unauthorized",
        "missing or invalid X-OCR-Token header (required in embedded-path mode when OCR_ACCESS_TOKENS is enabled)",
    ))
}

/// Self-reported caller identity for the audit log. Never forwarded upstream;
/// bounded so a hostile client cannot bloat log entries.
pub fn parse_client_tag(headers: &HeaderMap) -> Option<String> {
    let tag = header(headers, "x-ocr-client")?.trim();
    if tag.is_empty() {
        return None;
    }
    Some(tag.chars().take(120).collect())
}

pub fn parse_upstream_format(headers: &HeaderMap) -> Result<UpstreamFormat, ApiError> {
    let raw = header(headers, "x-upstream-format")
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    match raw.as_str() {
        "" | "chat-completions" => Ok(UpstreamFormat::ChatCompletions),
        "responses" => Ok(UpstreamFormat::Responses),
        _ => Err(invalid(
            "invalid_upstream_format",
            format!(
                "unknown X-Upstream-Format value: {raw} (expected 'chat-completions' or 'responses')"
            ),
        )),
    }
}

pub fn parse_upstream_config(headers: &HeaderMap) -> Result<UpstreamConfig, ApiError> {
    let url = header(headers, "x-upstream-url")
        .filter(|value| !value.is_empty())
        .ok_or_else(|| invalid("missing_upstream_url", "missing X-Upstream-Url header"))?;
    let authorization = header(headers, "x-upstream-authorization")
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            invalid(
                "missing_upstream_auth",
                "missing X-Upstream-Authorization header",
            )
        })?;
    if contains_invalid_header_value(url) || contains_invalid_header_value(authorization) {
        return Err(invalid(
            "invalid_upstream_header",
            "upstream header value contains CR/LF",
        ));
    }
    if !valid_url(url) {
        return Err(invalid(
            "invalid_upstream_url",
            format!("X-Upstream-Url is not a valid http(s) URL: {url}"),
        ));
    }
    Ok(UpstreamConfig {
        url: url.to_owned(),
        authorization: authorization.to_owned(),
        model: header(headers, "x-upstream-model")
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned),
    })
}

pub fn is_embedded_upstream_path(uri: &Uri) -> bool {
    let path = uri.path();
    path.starts_with("/https://") || path.starts_with("/http://")
}

pub fn parse_embedded_upstream(
    uri: &Uri,
    headers: &HeaderMap,
) -> Result<(UpstreamConfig, Endpoint), ApiError> {
    let raw_path = uri.path();
    if !is_embedded_upstream_path(uri) {
        return Err(invalid(
            "invalid_path",
            format!("expected /http(s):// embedded prefix, got {raw_path}"),
        ));
    }
    const COUNT_SUFFIX: &str = "/v1/messages/count_tokens";
    const MESSAGE_SUFFIX: &str = "/v1/messages";
    let without_leading = &raw_path[1..];
    let (url, endpoint) = if let Some(url) = without_leading.strip_suffix(COUNT_SUFFIX) {
        (url, Endpoint::CountTokens)
    } else if let Some(url) = without_leading.strip_suffix(MESSAGE_SUFFIX) {
        (url, Endpoint::Messages)
    } else {
        return Err(ApiError::new(
            StatusCode::NOT_FOUND,
            "not_found_error",
            "unknown_path",
            format!(
                "unrecognized path: {raw_path} (expected suffix {MESSAGE_SUFFIX} or {COUNT_SUFFIX})"
            ),
        ));
    };
    if !valid_url(url) {
        return Err(invalid(
            "invalid_upstream_url",
            format!("embedded upstream URL is not a valid http(s) URL: {url}"),
        ));
    }
    let raw_auth = header(headers, "authorization").ok_or_else(|| {
        ApiError::new(
            StatusCode::UNAUTHORIZED,
            "authentication_error",
            "missing_upstream_auth",
            "embedded-path mode requires Authorization: Bearer <upstream-auth-value>",
        )
    })?;
    if raw_auth.len() < 7 || !raw_auth[..7].eq_ignore_ascii_case("bearer ") {
        return Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            "authentication_error",
            "missing_upstream_auth",
            "embedded-path mode requires Authorization: Bearer <upstream-auth-value>",
        ));
    }
    let authorization = raw_auth[7..].trim();
    if authorization.is_empty() {
        return Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            "authentication_error",
            "missing_upstream_auth",
            "Authorization Bearer token is empty",
        ));
    }
    if contains_invalid_header_value(authorization) {
        return Err(invalid(
            "invalid_upstream_header",
            "Authorization value contains CR/LF",
        ));
    }
    Ok((
        UpstreamConfig {
            url: url.to_owned(),
            authorization: authorization.to_owned(),
            model: header(headers, "x-upstream-model")
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned),
        },
        endpoint,
    ))
}

pub fn parse_upstream_headers(headers: &HeaderMap) -> Result<HeaderMap, ApiError> {
    let Some(raw) = header(headers, "x-upstream-headers") else {
        return Ok(HeaderMap::new());
    };
    if raw.trim().is_empty() {
        return Err(invalid(
            "invalid_upstream_headers",
            "X-Upstream-Headers must be a non-empty JSON object",
        ));
    }
    let parsed: Value = serde_json::from_str(raw).map_err(|_| {
        invalid(
            "invalid_upstream_headers",
            "X-Upstream-Headers must be a JSON object",
        )
    })?;
    let object = parsed.as_object().ok_or_else(|| {
        invalid(
            "invalid_upstream_headers",
            "X-Upstream-Headers must be a JSON object",
        )
    })?;
    let protected = [
        "accept",
        "authorization",
        "connection",
        "content-length",
        "content-type",
        "expect",
        "host",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "proxy-connection",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
        "x-ocr-token",
    ];
    let mut result = HeaderMap::new();
    for (name, value) in object {
        let normalized = name.to_ascii_lowercase();
        let parsed_name = HeaderName::from_bytes(name.as_bytes()).map_err(|_| {
            invalid(
                "invalid_upstream_header",
                format!("invalid upstream header name: {name}"),
            )
        })?;
        if matches!(
            normalized.as_str(),
            "__proto__" | "constructor" | "prototype"
        ) {
            return Err(invalid(
                "invalid_upstream_header",
                format!("invalid upstream header name: {name}"),
            ));
        }
        if protected.contains(&normalized.as_str()) || normalized.starts_with("x-upstream-") {
            return Err(invalid(
                "protected_upstream_header",
                format!("protected upstream header cannot be overridden: {normalized}"),
            ));
        }
        let raw_value = value.as_str().ok_or_else(|| {
            invalid(
                "invalid_upstream_header",
                format!("invalid value for upstream header: {name}"),
            )
        })?;
        if contains_invalid_header_value(raw_value) {
            return Err(invalid(
                "invalid_upstream_header",
                format!("invalid value for upstream header: {name}"),
            ));
        }
        let parsed_value = HeaderValue::from_str(raw_value).map_err(|_| {
            invalid(
                "invalid_upstream_header",
                format!("invalid value for upstream header: {name}"),
            )
        })?;
        result.insert(parsed_name, parsed_value);
    }
    Ok(result)
}

fn parse_assignments(
    raw: Option<&str>,
    code: &'static str,
    message: &'static str,
) -> Result<HashMap<String, String>, ApiError> {
    let Some(raw) = raw.filter(|raw| !raw.trim().is_empty()) else {
        return Ok(HashMap::new());
    };
    let mut result = HashMap::new();
    for item in raw.split(',') {
        let (from, to) = item
            .split_once('=')
            .map(|(from, to)| (from.trim(), to.trim()))
            .filter(|(from, to)| !from.is_empty() && !to.is_empty())
            .ok_or_else(|| invalid(code, message))?;
        if contains_invalid_header_value(from) || contains_invalid_header_value(to) {
            return Err(invalid(code, message));
        }
        result.insert(from.to_owned(), to.to_owned());
    }
    Ok(result)
}

pub fn parse_model_map(headers: &HeaderMap) -> Result<HashMap<String, String>, ApiError> {
    parse_assignments(
        header(headers, "x-upstream-model-map"),
        "invalid_model_map",
        "X-Upstream-Model-Map contains an invalid mapping (expected format: model-a=upstream-a,model-b=upstream-b)",
    )
}

pub fn parse_effort_map(headers: &HeaderMap) -> Result<HashMap<String, String>, ApiError> {
    let result = parse_assignments(
        header(headers, "x-upstream-effort-map"),
        "invalid_effort_map",
        "X-Upstream-Effort-Map contains an invalid mapping (expected format: max=xhigh,low=minimal; left side must be an Anthropic effort low/medium/high/xhigh/max or *; right side off strips the field)",
    )?;
    if result.keys().any(|key| {
        !matches!(
            key.as_str(),
            "*" | "low" | "medium" | "high" | "xhigh" | "max"
        )
    }) {
        return Err(invalid(
            "invalid_effort_map",
            "X-Upstream-Effort-Map contains an invalid mapping (expected format: max=xhigh,low=minimal; left side must be an Anthropic effort low/medium/high/xhigh/max or *; right side off strips the field)",
        ));
    }
    Ok(result)
}

pub fn parse_effort_levels(headers: &HeaderMap) -> Result<Vec<String>, ApiError> {
    let Some(raw) = header(headers, "x-upstream-effort-levels") else {
        return Ok(Vec::new());
    };
    if raw.trim().is_empty() {
        return Ok(Vec::new());
    }
    let mut levels = Vec::new();
    for raw_level in raw.split(',') {
        let level = raw_level.trim().to_ascii_lowercase();
        if level.is_empty() || contains_invalid_header_value(&level) {
            return Err(invalid(
                "invalid_effort_levels",
                "X-Upstream-Effort-Levels contains an invalid level (expected format: none,low,medium,high,xhigh)",
            ));
        }
        if !levels.contains(&level) {
            levels.push(level);
        }
    }
    Ok(levels)
}

pub fn resolve_upstream_model(
    body_model: Option<&str>,
    override_model: Option<&str>,
    model_map: &HashMap<String, String>,
) -> Option<String> {
    body_model
        .and_then(|model| model_map.get(model).cloned())
        .or_else(|| override_model.map(ToOwned::to_owned))
}

const EFFORT_LADDER: &[&str] = &["minimal", "low", "medium", "high", "xhigh", "max"];

pub fn apply_effort_controls(
    body: &mut Value,
    effort_map: &HashMap<String, String>,
    levels: &[String],
) {
    for path in [&["reasoning_effort"][..], &["reasoning", "effort"][..]] {
        let Some(existing) = value_at_path(body, path)
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
        else {
            continue;
        };
        let mapped = effort_map
            .get(&existing)
            .or_else(|| effort_map.get("*"))
            .cloned();
        if mapped.as_deref() == Some("off") {
            remove_at_path(body, path);
            continue;
        }
        let candidate = mapped.unwrap_or(existing);
        let final_value = clamp_effort(&candidate, levels).unwrap_or(candidate);
        if let Some(slot) = value_at_path_mut(body, path) {
            *slot = Value::String(final_value);
        }
    }
}

fn clamp_effort(effort: &str, levels: &[String]) -> Option<String> {
    if levels.is_empty() || levels.iter().any(|level| level == effort) {
        return None;
    }
    let source_rank = EFFORT_LADDER.iter().position(|level| *level == effort)?;
    levels
        .iter()
        .filter_map(|level| {
            EFFORT_LADDER
                .iter()
                .position(|candidate| candidate == level)
                .map(|rank| (source_rank.abs_diff(rank), rank, level.clone()))
        })
        .min_by_key(|(distance, rank, _)| (*distance, *rank))
        .map(|(_, _, level)| level)
}

fn value_at_path<'a>(mut value: &'a Value, path: &[&str]) -> Option<&'a Value> {
    for key in path {
        value = value.get(*key)?;
    }
    Some(value)
}

fn value_at_path_mut<'a>(mut value: &'a mut Value, path: &[&str]) -> Option<&'a mut Value> {
    for key in path {
        value = value.get_mut(*key)?;
    }
    Some(value)
}

fn remove_at_path(value: &mut Value, path: &[&str]) {
    if let Some((last, parents)) = path.split_last() {
        let mut parent = value;
        for key in parents {
            let Some(next) = parent.get_mut(*key) else {
                return;
            };
            parent = next;
        }
        if let Some(object) = parent.as_object_mut() {
            object.remove(*last);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn effort_clamping_prefers_lower_tie() {
        assert_eq!(
            clamp_effort("xhigh", &["high".into(), "max".into()]),
            Some("high".into())
        );
    }

    #[test]
    fn embedded_path_is_parsed_without_rebuilding_auth() {
        let uri: Uri = "/https://upstream.example.com/v1/chat/completions/v1/messages"
            .parse()
            .unwrap();
        let mut headers = HeaderMap::new();
        headers.insert("authorization", "Bearer Custom abc".parse().unwrap());
        let (upstream, endpoint) = parse_embedded_upstream(&uri, &headers).unwrap();
        assert_eq!(endpoint, Endpoint::Messages);
        assert_eq!(
            upstream.url,
            "https://upstream.example.com/v1/chat/completions"
        );
        assert_eq!(upstream.authorization, "Custom abc");
    }

    #[test]
    fn client_tag_is_trimmed_bounded_and_optional() {
        let mut headers = HeaderMap::new();
        assert_eq!(parse_client_tag(&headers), None);

        headers.insert("x-ocr-client", "  canary-a  ".parse().unwrap());
        assert_eq!(parse_client_tag(&headers), Some("canary-a".into()));

        headers.insert("x-ocr-client", "   ".parse().unwrap());
        assert_eq!(parse_client_tag(&headers), None);

        headers.insert("x-ocr-client", "x".repeat(300).parse().unwrap());
        assert_eq!(parse_client_tag(&headers), Some("x".repeat(120)));

        headers.insert(
            "x-ocr-client",
            HeaderValue::from_bytes(b"caf\xc3\xa9").unwrap(),
        );
        assert_eq!(parse_client_tag(&headers), None);
    }

    #[test]
    fn service_auth_distinguishes_malformed_bearer_from_invalid_token() {
        let allowed = HashSet::from(["valid".to_owned()]);
        for raw in ["Basic valid", "Bearer", "éééé"] {
            let mut headers = HeaderMap::new();
            headers.insert("authorization", raw.parse().unwrap());
            let error = check_header_mode_auth(&headers, &allowed).unwrap_err();
            assert_eq!(error.error_type, "authentication_error");
            assert_eq!(error.message, "missing or malformed Authorization header");
        }

        let mut headers = HeaderMap::new();
        headers.insert("authorization", "Bearer wrong".parse().unwrap());
        let error = check_header_mode_auth(&headers, &allowed).unwrap_err();
        assert_eq!(error.message, "invalid access token");
    }
}
