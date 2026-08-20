//! Cost estimation over five disjoint token buckets —
//! uncached input, cache reads, cache writes,
//! non-reasoning output, reasoning — each priced in USD per million tokens,
//! model matched by longest case-insensitive substring, Sonnet-class fallback
//! when nothing matches. OpenAI usage folds `cached` into `prompt_tokens` and
//! `reasoning` into `completion_tokens`, so [`estimate_usd`] normalizes the
//! raw counters into disjoint buckets before pricing. Folded reasoning (a
//! table entry with reasoning price 0 while the model emits reasoning tokens)
//! is priced at the model's output rate so the total matches what the vendor
//! actually bills for `completion_tokens`.
//!
//! Price list source: each vendor's published list price at the time of
//! writing. Prices change; `LENS_PRICING_JSON` overrides or extends the
//! table without a rebuild, and costs are computed at query time so an
//! updated table reprices history automatically.

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LongContextPricing {
    /// Apply the multipliers only when a single request exceeds this input count.
    pub threshold: i64,
    pub input_multiplier: f64,
    pub output_multiplier: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ModelPrice {
    /// Substring pattern; a trailing SQL-style `%` is accepted and trimmed.
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
    #[serde(default)]
    pub long_context: Option<LongContextPricing>,
}

#[derive(Clone, Copy, Debug)]
pub struct TokenUsage {
    pub input: i64,
    pub output: i64,
    pub cached: i64,
    pub reasoning: i64,
    pub cache_creation: i64,
}

/// Fallback when no pattern matches (Claude Sonnet-class rates).
static FALLBACK: ModelPrice = ModelPrice {
    pattern: String::new(),
    display: String::new(),
    input: 3.0,
    output: 15.0,
    cache_read: 0.3,
    cache_creation: 3.75,
    reasoning: 15.0,
    long_context: None,
};

pub struct PricingTable {
    entries: Vec<ModelPrice>,
}

impl Default for PricingTable {
    fn default() -> Self {
        Self {
            entries: default_entries(),
        }
    }
}

impl PricingTable {
    /// Defaults come from the built-in table (see the module header for how
    /// the prices are sourced and overridden).
    pub fn from_env() -> Self {
        let mut entries = Self::default().entries;
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

    /// Longest-substring match: the most specific pattern wins.
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

    pub fn long_context_threshold(&self, model: &str) -> Option<i64> {
        self.matched(model)
            .and_then(|price| price.long_context.as_ref())
            .map(|tier| tier.threshold.max(0))
    }

    /// Estimated cost for one request in USD from the raw OpenAI-style counters
    /// (`input` includes `cached`; `output` includes `reasoning`).
    /// `cache_creation` is the fifth, disjoint bucket — it is never part of
    /// `input`, so it is not deducted from it. Older exchanges and upstreams
    /// that omit `cache_write_tokens` pass 0 for that bucket.
    pub fn estimate_usd(
        &self,
        model: &str,
        input: i64,
        output: i64,
        cached: i64,
        reasoning: i64,
        cache_creation: i64,
    ) -> f64 {
        let long_context = self
            .long_context_threshold(model)
            .is_some_and(|threshold| input.max(0) > threshold);
        self.estimate_usd_for_context(
            model,
            TokenUsage {
                input,
                output,
                cached,
                reasoning,
                cache_creation,
            },
            long_context,
        )
    }

    /// Prices token totals already partitioned into one context tier. This is
    /// used by aggregate queries so the sum of many short requests does not
    /// accidentally cross the per-request long-context threshold.
    pub fn estimate_usd_for_context(
        &self,
        model: &str,
        usage: TokenUsage,
        long_context: bool,
    ) -> f64 {
        let price = self.matched(model).unwrap_or(&FALLBACK);
        let cached = usage.cached.clamp(0, usage.input.max(0));
        let reasoning = usage.reasoning.clamp(0, usage.output.max(0));
        let cache_creation = usage.cache_creation.max(0);
        let input_uncached = usage.input.max(0) - cached;
        let output_plain = usage.output.max(0) - reasoning;
        let (input_multiplier, output_multiplier) = long_context
            .then_some(())
            .and(price.long_context.as_ref())
            .map(|tier| {
                (
                    tier.input_multiplier.max(0.0),
                    tier.output_multiplier.max(0.0),
                )
            })
            .unwrap_or((1.0, 1.0));
        let reasoning_rate = if price.reasoning > 0.0 {
            price.reasoning
        } else {
            price.output
        };
        ((input_uncached as f64 * price.input
            + cached as f64 * price.cache_read
            + cache_creation as f64 * price.cache_creation)
            * input_multiplier
            + (output_plain as f64 * price.output + reasoning as f64 * reasoning_rate)
                * output_multiplier)
            / 1e6
    }

    /// Cost-breakdown extra: money saved versus paying full input price for
    /// cached reads in a token bucket already partitioned by context tier.
    pub fn cache_savings_usd_for_context(
        &self,
        model: &str,
        cached: i64,
        long_context: bool,
    ) -> f64 {
        let price = self.matched(model).unwrap_or(&FALLBACK);
        let input_multiplier = long_context
            .then_some(())
            .and(price.long_context.as_ref())
            .map(|tier| tier.input_multiplier.max(0.0))
            .unwrap_or(1.0);
        (cached.max(0) as f64 * (price.input - price.cache_read) * input_multiplier / 1e6).max(0.0)
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
        long_context: None,
    }
}

fn long_context_entry(
    pattern: &str,
    display: &str,
    input: f64,
    output: f64,
    cache_read: f64,
    cache_creation: f64,
    reasoning: f64,
) -> ModelPrice {
    let mut price = entry(
        pattern,
        display,
        input,
        output,
        cache_read,
        cache_creation,
        reasoning,
    );
    price.long_context = Some(LongContextPricing {
        threshold: 272_000,
        input_multiplier: 2.0,
        output_multiplier: 1.5,
    });
    price
}

fn default_entries() -> Vec<ModelPrice> {
    vec![
        // Anthropic (cache write = 1.25x input; reasoning shadow-priced at the
        // output rate)
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
        long_context_entry("gpt-5.6-luna", "GPT-5.6 Luna", 0.2, 1.2, 0.02, 0.25, 1.2),
        long_context_entry("gpt-5.6-terra", "GPT-5.6 Terra", 2.0, 12.0, 0.2, 2.5, 12.0),
        long_context_entry("gpt-5.6-sol", "GPT-5.6 Sol", 5.0, 30.0, 0.5, 6.25, 30.0),
        long_context_entry("gpt-5.6", "GPT-5.6 Sol", 5.0, 30.0, 0.5, 6.25, 30.0),
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
            "GPT-5.6 Sol"
        );
        assert_eq!(
            table.matched("openai/gpt-5.6-luna").unwrap().display,
            "GPT-5.6 Luna"
        );
        assert_eq!(
            table.matched("openai/gpt-5.6-terra").unwrap().display,
            "GPT-5.6 Terra"
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
        // gpt-5.5: in 5.0, out 30.0, cache_read 0.5, reasoning 30.0.
        // 1M prompt (400k cached) + 500k completion (100k reasoning):
        // uncached 600k*5 + cached 400k*0.5 + plain 400k*30 + reasoning 100k*30
        let usd = table.estimate_usd("gpt-5.5-2026", 1_000_000, 500_000, 400_000, 100_000, 0);
        assert!((usd - (0.6 * 5.0 + 0.4 * 0.5 + 0.4 * 30.0 + 0.1 * 30.0)).abs() < 1e-9);
        // Folded-reasoning rule (table reasoning price 0, e.g. gpt-4o) keeps
        // the total equal to completion*output.
        let folded = table.estimate_usd("gpt-4o-2024", 0, 500_000, 0, 100_000, 0);
        let flat = table.estimate_usd("gpt-4o-2024", 0, 500_000, 0, 0, 0);
        assert!((folded - flat).abs() < 1e-9);
    }

    #[test]
    fn gpt_5_6_long_context_rates_apply_to_each_request() {
        let table = table();
        let at_threshold = table.estimate_usd("gpt-5.6-luna", 272_000, 100_000, 72_000, 0, 0);
        let expected_short =
            ((272_000 - 72_000) as f64 * 0.2 + 72_000.0 * 0.02 + 100_000.0 * 1.2) / 1e6;
        assert!((at_threshold - expected_short).abs() < 1e-9);

        let long = table.estimate_usd("gpt-5.6-luna", 300_000, 100_000, 100_000, 25_000, 10_000);
        let expected_long =
            (((300_000 - 100_000) as f64 * 0.2 + 100_000.0 * 0.02 + 10_000.0 * 0.25) * 2.0
                + 100_000.0 * 1.2 * 1.5)
                / 1e6;
        assert!((long - expected_long).abs() < 1e-9);
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
    fn cache_savings_use_the_input_minus_cache_read_delta() {
        let table = table();
        // claude-sonnet-4: (3.0 - 0.3) per MTok saved on cached reads.
        let saved =
            table.cache_savings_usd_for_context("claude-sonnet-4-20250514", 2_000_000, false);
        assert!((saved - 5.4).abs() < 1e-9);

        let luna_long = table.cache_savings_usd_for_context("gpt-5.6-luna", 100_000, true);
        assert!((luna_long - 0.036).abs() < 1e-9);
    }
}
