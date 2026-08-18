//! Cost estimation following the the reference methodology:
//! five disjoint token buckets — uncached input, cache reads, cache writes,
//! non-reasoning output, reasoning — each priced in USD per million tokens,
//! model matched by longest case-insensitive substring, Sonnet-class fallback
//! when nothing matches. OpenAI usage folds `cached` into `prompt_tokens` and
//! `reasoning` into `completion_tokens`, so [`estimate_usd`] normalizes the
//! raw counters into disjoint buckets before pricing. Folded reasoning (a
//! table entry with reasoning price 0 while the model emits reasoning tokens)
//! is priced at the model's output rate so the total matches what the vendor
//! actually bills for `completion_tokens`.
//!
//! Price list source: aligned with the reference `model_pricing` migration
//! end-state (published vendor price sheets); gpt-5.5/5.4/5.2 use the
//! current list prices rather than their older rows.

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ModelPrice {
    /// Substring pattern (reference keeps SQL `%` suffixes; they are trimmed).
    pub pattern: String,
    pub display: String,
    /// USD per million tokens.
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    #[serde(default)]
    pub cache_creation: f64,
    #[serde(default)]
    pub reasoning: f64,
}

/// reference fallback when no pattern matches (Claude Sonnet-class rates).
static FALLBACK: ModelPrice = ModelPrice {
    pattern: String::new(),
    display: String::new(),
    input: 3.0,
    output: 15.0,
    cache_read: 0.3,
    cache_creation: 3.75,
    reasoning: 15.0,
};

pub struct PricingTable {
    entries: Vec<ModelPrice>,
}

impl PricingTable {
    /// Defaults mirror the reference `model_pricing` migration end-state (see the
    /// module header for the exact migration lineage).
    pub fn from_env() -> Self {
        let mut entries = default_entries();
        if let Ok(raw) = std::env::var("LENS_PRICING_JSON")
            && !raw.trim().is_empty()
        {
            match serde_json::from_str::<Vec<ModelPrice>>(&raw) {
                // User entries take precedence on pattern-length ties.
                Ok(mut user) => {
                    user.extend(entries);
                    entries = user;
                }
                Err(error) => {
                    tracing::warn!(%error, "invalid LENS_PRICING_JSON ignored; using defaults")
                }
            }
        }
        Self { entries }
    }

    /// Longest-substring match, reference semantics.
    pub fn matched(&self, model: &str) -> Option<&ModelPrice> {
        let lower = model.to_ascii_lowercase();
        let mut best: Option<&ModelPrice> = None;
        let mut best_len = 0;
        for entry in &self.entries {
            let pattern = entry.pattern.trim_end_matches('%').to_ascii_lowercase();
            if !pattern.is_empty() && lower.contains(&pattern) && pattern.len() > best_len {
                best = Some(entry);
                best_len = pattern.len();
            }
        }
        best
    }

    /// Estimated cost in USD from the raw OpenAI-style counters
    /// (`input` includes `cached`; `output` includes `reasoning`).
    /// `cache_creation` is the fifth, disjoint bucket — it is never part of
    /// `input`, so it is not deducted from it. Upstream OpenAI-protocol usage
    /// does not report a cache-write count, so lens currently always passes 0;
    /// the term exists to keep the formula complete against reference's
    /// five-bucket accounting.
    pub fn estimate_usd(
        &self,
        model: &str,
        input: i64,
        output: i64,
        cached: i64,
        reasoning: i64,
        cache_creation: i64,
    ) -> f64 {
        let price = self.matched(model).unwrap_or(&FALLBACK);
        let cached = cached.clamp(0, input.max(0));
        let reasoning = reasoning.clamp(0, output.max(0));
        let cache_creation = cache_creation.max(0);
        let input_uncached = input.max(0) - cached;
        let output_plain = output.max(0) - reasoning;
        let reasoning_rate = if price.reasoning > 0.0 {
            price.reasoning
        } else {
            price.output
        };
        (input_uncached as f64 * price.input
            + cached as f64 * price.cache_read
            + cache_creation as f64 * price.cache_creation
            + output_plain as f64 * price.output
            + reasoning as f64 * reasoning_rate)
            / 1e6
    }

    /// reference cost-breakdown extra: money saved versus paying full input price
    /// for the cached reads, clamped at zero.
    pub fn cache_savings_usd(&self, model: &str, cached: i64) -> f64 {
        let price = self.matched(model).unwrap_or(&FALLBACK);
        (cached.max(0) as f64 * (price.input - price.cache_read) / 1e6).max(0.0)
    }
}

fn entry(
    pattern: &str,
    display: &str,
    input: f64,
    output: f64,
    cache_read: f64,
    cache_creation: f64,
    reasoning: f64,
) -> ModelPrice {
    ModelPrice {
        pattern: pattern.into(),
        display: display.into(),
        input,
        output,
        cache_read,
        cache_creation,
        reasoning,
    }
}

fn default_entries() -> Vec<ModelPrice> {
    vec![
        // Anthropic (cache write = 1.25x input; reasoning shadow-priced at the
        // output rate, reference convention)
        entry(
            "claude-opus-4-5",
            "Claude Opus 4.5",
            5.0,
            25.0,
            0.5,
            6.25,
            25.0,
        ),
        entry(
            "claude-opus-4-6",
            "Claude Opus 4.6",
            5.0,
            25.0,
            0.5,
            6.25,
            25.0,
        ),
        entry(
            "claude-opus-4-7",
            "Claude Opus 4.7",
            5.0,
            25.0,
            0.5,
            6.25,
            25.0,
        ),
        entry(
            "claude-opus-4-8",
            "Claude Opus 4.8",
            5.0,
            25.0,
            0.5,
            6.25,
            25.0,
        ),
        entry(
            "claude-sonnet-4-5",
            "Claude Sonnet 4.5",
            3.0,
            15.0,
            0.3,
            3.75,
            15.0,
        ),
        entry(
            "claude-sonnet-4-6",
            "Claude Sonnet 4.6",
            3.0,
            15.0,
            0.3,
            3.75,
            15.0,
        ),
        entry(
            "claude-haiku-4-5",
            "Claude Haiku 4.5",
            1.0,
            5.0,
            0.1,
            1.25,
            5.0,
        ),
        entry(
            "claude-3-5-sonnet",
            "Claude 3.5 Sonnet",
            3.0,
            15.0,
            0.3,
            3.75,
            15.0,
        ),
        entry(
            "claude-3-5-haiku",
            "Claude 3.5 Haiku",
            0.8,
            4.0,
            0.08,
            1.0,
            4.0,
        ),
        entry(
            "claude-3-opus",
            "Claude 3 Opus",
            15.0,
            75.0,
            1.5,
            18.75,
            75.0,
        ),
        entry(
            "claude-sonnet-4",
            "Claude Sonnet 4",
            3.0,
            15.0,
            0.3,
            3.75,
            15.0,
        ),
        entry(
            "claude-opus-4",
            "Claude Opus 4",
            15.0,
            75.0,
            1.5,
            18.75,
            75.0,
        ),
        entry("claude-haiku-4", "Claude Haiku 4", 1.0, 5.0, 0.1, 1.25, 5.0),
        // OpenAI GPT
        entry("gpt-4o", "GPT-4o", 2.5, 10.0, 0.0, 0.0, 0.0),
        entry("gpt-4o-mini", "GPT-4o Mini", 0.15, 0.6, 0.0, 0.0, 0.0),
        entry("gpt-4-turbo", "GPT-4 Turbo", 10.0, 30.0, 0.0, 0.0, 0.0),
        entry("gpt-4.1", "GPT-4.1", 2.0, 8.0, 0.0, 0.0, 0.0),
        entry("gpt-4.1-mini", "GPT-4.1 Mini", 0.4, 1.6, 0.0, 0.0, 0.0),
        entry("gpt-4.1-nano", "GPT-4.1 Nano", 0.1, 0.4, 0.0, 0.0, 0.0),
        entry("gpt-5.6", "GPT-5.6", 5.0, 30.0, 0.5, 0.0, 30.0),
        entry("gpt-5.5", "GPT-5.5", 5.0, 30.0, 0.5, 0.0, 30.0),
        entry("gpt-5.4", "GPT-5.4", 2.5, 15.0, 0.25, 0.0, 15.0),
        entry("gpt-5.3", "GPT-5.3", 1.75, 14.0, 0.175, 0.0, 14.0),
        entry("gpt-5.2", "GPT-5.2", 1.75, 14.0, 0.175, 0.0, 14.0),
        entry("gpt-5.1", "GPT-5.1", 1.25, 10.0, 0.125, 0.0, 10.0),
        entry("gpt-5-codex", "GPT-5 Codex", 1.25, 10.0, 0.125, 0.0, 10.0),
        entry("gpt-5-mini", "GPT-5 Mini", 0.25, 2.0, 0.025, 0.0, 2.0),
        entry("gpt-5-nano", "GPT-5 Nano", 0.05, 0.4, 0.005, 0.0, 0.4),
        entry("gpt-5", "GPT-5", 1.25, 10.0, 0.125, 0.0, 10.0),
        // OpenAI reasoning family
        entry("o1", "o1", 15.0, 60.0, 0.0, 0.0, 60.0),
        entry("o1-mini", "o1 Mini", 1.1, 4.4, 0.0, 0.0, 4.4),
        entry("o1-pro", "o1 Pro", 150.0, 600.0, 0.0, 0.0, 600.0),
        entry("o3", "o3", 2.0, 8.0, 0.0, 0.0, 8.0),
        entry("o3-mini", "o3 Mini", 1.1, 4.4, 0.0, 0.0, 4.4),
        entry("o4-mini", "o4 Mini", 1.1, 4.4, 0.0, 0.0, 4.4),
        // Google
        entry(
            "gemini-2.5-pro",
            "Gemini 2.5 Pro",
            1.25,
            10.0,
            0.625,
            0.0,
            0.0,
        ),
        entry(
            "gemini-2.5-flash",
            "Gemini 2.5 Flash",
            0.15,
            0.6,
            0.075,
            0.0,
            0.0,
        ),
        entry(
            "gemini-2.0-flash",
            "Gemini 2.0 Flash",
            0.1,
            0.4,
            0.05,
            0.0,
            0.0,
        ),
        entry("gemini-3-pro", "Gemini 3 Pro", 2.0, 12.0, 0.2, 0.0, 0.0),
        entry("gemini-3-flash", "Gemini 3 Flash", 0.5, 3.0, 0.05, 0.0, 0.0),
        // xAI
        entry("grok-3", "Grok 3", 3.0, 15.0, 0.0, 0.0, 0.0),
        // DeepSeek
        entry("deepseek-v3", "DeepSeek V3", 0.27, 1.1, 0.0, 0.0, 0.0),
        entry("deepseek-r1", "DeepSeek R1", 0.55, 2.19, 0.0, 0.0, 2.19),
        // Moonshot
        entry(
            "kimi-k2.7-code-highspeed",
            "Kimi K2.7 Code Highspeed",
            0.95,
            4.0,
            0.19,
            0.0,
            4.0,
        ),
        entry(
            "kimi-k2.7-code",
            "Kimi K2.7 Code",
            0.95,
            4.0,
            0.19,
            0.0,
            4.0,
        ),
        entry(
            "kimi-for-coding",
            "Kimi For Coding",
            0.95,
            4.0,
            0.19,
            0.0,
            4.0,
        ),
        entry("kimi-code", "Kimi Code", 0.95, 4.0, 0.19, 0.0, 4.0),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn table() -> PricingTable {
        PricingTable {
            entries: default_entries(),
        }
    }

    #[test]
    fn longest_substring_match_wins() {
        let table = table();
        assert_eq!(
            table.matched("gpt-4.1-mini-2025").unwrap().display,
            "GPT-4.1 Mini"
        );
        assert_eq!(
            table.matched("deployment-gpt-5.6-2026").unwrap().display,
            "GPT-5.6"
        );
        assert_eq!(table.matched("gpt-5-mini-x").unwrap().display, "GPT-5 Mini");
        assert_eq!(table.matched("o1-pro-high").unwrap().display, "o1 Pro");
        let opus = table.matched("claude-opus-4-5-20260101").unwrap();
        assert_eq!(opus.display, "Claude Opus 4.5");
        assert!((opus.input - 5.0).abs() < 1e-9);
        assert!((opus.output - 25.0).abs() < 1e-9);
        let kimi = table.matched("kimi-k2.7-code-highspeed").unwrap();
        assert_eq!(kimi.display, "Kimi K2.7 Code Highspeed");
        assert!((kimi.input - 0.95).abs() < 1e-9);
        assert!((kimi.output - 4.0).abs() < 1e-9);
        assert!((kimi.cache_read - 0.19).abs() < 1e-9);
        assert!((kimi.reasoning - 4.0).abs() < 1e-9);
        assert!(table.matched("totally-unknown").is_none());
    }

    #[test]
    fn buckets_are_normalized_before_pricing() {
        let table = table();
        // gpt-5.6: in 5.0, out 30.0, cache_read 0.5, reasoning 30.0.
        // 1M prompt (400k cached) + 500k completion (100k reasoning):
        // uncached 600k*5 + cached 400k*0.5 + plain 400k*30 + reasoning 100k*30
        let usd = table.estimate_usd("gpt-5.6-2026", 1_000_000, 500_000, 400_000, 100_000, 0);
        assert!((usd - (0.6 * 5.0 + 0.4 * 0.5 + 0.4 * 30.0 + 0.1 * 30.0)).abs() < 1e-9);
        // Folded-reasoning rule (table reasoning price 0, e.g. gpt-4o) keeps
        // the total equal to completion*output.
        let folded = table.estimate_usd("gpt-4o-2024", 0, 500_000, 0, 100_000, 0);
        let flat = table.estimate_usd("gpt-4o-2024", 0, 500_000, 0, 0, 0);
        assert!((folded - flat).abs() < 1e-9);
    }

    #[test]
    fn cache_creation_is_a_disjoint_fifth_bucket() {
        let table = table();
        // claude-opus-4-5: in 5, out 25, cache_read 0.5, cache_write 6.25,
        // reasoning 25. cache_creation is not deducted from input:
        // uncached 800k*5 + cached 200k*0.5 + write 300k*6.25
        //   + plain 300k*25 + reasoning 100k*25
        let usd = table.estimate_usd(
            "claude-opus-4-5",
            1_000_000,
            400_000,
            200_000,
            100_000,
            300_000,
        );
        let expected = 0.8 * 5.0 + 0.2 * 0.5 + 0.3 * 6.25 + 0.3 * 25.0 + 0.1 * 25.0;
        assert!((usd - expected).abs() < 1e-9);
        // Negative cache-write counts clamp to zero like the other buckets.
        let clamped = table.estimate_usd("claude-opus-4-5", 1_000_000, 0, 0, 0, -5);
        assert!((clamped - 5.0).abs() < 1e-9);
    }

    #[test]
    fn unknown_model_uses_sonnet_class_fallback() {
        let table = table();
        let usd = table.estimate_usd("mystery-model", 1_000_000, 0, 0, 0, 0);
        assert!((usd - 3.0).abs() < 1e-9);
    }

    #[test]
    fn cache_savings_follow_reference_formula() {
        let table = table();
        // claude-sonnet-4: (3.0 - 0.3) per MTok saved on cached reads.
        let saved = table.cache_savings_usd("claude-sonnet-4-20250514", 2_000_000);
        assert!((saved - 5.4).abs() < 1e-9);
    }
}
