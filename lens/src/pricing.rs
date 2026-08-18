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
    /// Defaults mirror reference's `000002_seed_pricing` seed, extended with the
    /// gpt-5.6 tier (same rates as its gpt-5.x siblings, reasoning priced at
    /// the output rate because the vendor folds reasoning into output).
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
    pub fn estimate_usd(
        &self,
        model: &str,
        input: i64,
        output: i64,
        cached: i64,
        reasoning: i64,
    ) -> f64 {
        let price = self.matched(model).unwrap_or(&FALLBACK);
        let cached = cached.clamp(0, input.max(0));
        let reasoning = reasoning.clamp(0, output.max(0));
        let input_uncached = input.max(0) - cached;
        let output_plain = output.max(0) - reasoning;
        let reasoning_rate = if price.reasoning > 0.0 {
            price.reasoning
        } else {
            price.output
        };
        (input_uncached as f64 * price.input
            + cached as f64 * price.cache_read
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
        // Anthropic (cache write = 1.25x input, reference fallback convention)
        entry(
            "claude-3-5-sonnet",
            "Claude 3.5 Sonnet",
            3.0,
            15.0,
            0.3,
            3.75,
            0.0,
        ),
        entry(
            "claude-3-5-haiku",
            "Claude 3.5 Haiku",
            0.8,
            4.0,
            0.08,
            1.0,
            0.0,
        ),
        entry(
            "claude-3-opus",
            "Claude 3 Opus",
            15.0,
            75.0,
            1.5,
            18.75,
            0.0,
        ),
        entry(
            "claude-sonnet-4",
            "Claude Sonnet 4",
            3.0,
            15.0,
            0.3,
            3.75,
            0.0,
        ),
        entry(
            "claude-opus-4",
            "Claude Opus 4",
            15.0,
            75.0,
            1.5,
            18.75,
            0.0,
        ),
        entry("claude-haiku-4", "Claude Haiku 4", 1.0, 5.0, 0.1, 1.25, 0.0),
        // OpenAI GPT
        entry("gpt-4o", "GPT-4o", 2.5, 10.0, 0.0, 0.0, 0.0),
        entry("gpt-4o-mini", "GPT-4o Mini", 0.15, 0.6, 0.0, 0.0, 0.0),
        entry("gpt-4-turbo", "GPT-4 Turbo", 10.0, 30.0, 0.0, 0.0, 0.0),
        entry("gpt-4.1", "GPT-4.1", 2.0, 8.0, 0.0, 0.0, 0.0),
        entry("gpt-4.1-mini", "GPT-4.1 Mini", 0.4, 1.6, 0.0, 0.0, 0.0),
        entry("gpt-4.1-nano", "GPT-4.1 Nano", 0.1, 0.4, 0.0, 0.0, 0.0),
        entry("gpt-5.6", "GPT-5.6", 2.0, 8.0, 0.0, 0.0, 8.0),
        entry("gpt-5.5", "GPT-5.5", 2.0, 8.0, 0.0, 0.0, 8.0),
        entry("gpt-5.4", "GPT-5.4", 2.0, 8.0, 0.0, 0.0, 8.0),
        entry("gpt-5.2", "GPT-5.2", 2.0, 8.0, 0.0, 0.0, 8.0),
        // OpenAI reasoning family
        entry("o1-mini", "o1 Mini", 1.1, 4.4, 0.0, 0.0, 4.4),
        entry("o1-pro", "o1 Pro", 150.0, 600.0, 0.0, 0.0, 600.0),
        entry("o1", "o1", 15.0, 60.0, 0.0, 0.0, 60.0),
        entry("o3-mini", "o3 Mini", 1.1, 4.4, 0.0, 0.0, 4.4),
        entry("o3", "o3", 2.0, 8.0, 0.0, 0.0, 8.0),
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
        // xAI
        entry("grok-3", "Grok 3", 3.0, 15.0, 0.0, 0.0, 0.0),
        // DeepSeek
        entry("deepseek-v3", "DeepSeek V3", 0.27, 1.1, 0.0, 0.0, 0.0),
        entry("deepseek-r1", "DeepSeek R1", 0.55, 2.19, 0.0, 0.0, 2.19),
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
        assert_eq!(table.matched("o1-pro-high").unwrap().display, "o1 Pro");
        assert!(table.matched("totally-unknown").is_none());
    }

    #[test]
    fn buckets_are_normalized_before_pricing() {
        let table = table();
        // gpt-5.6: in 2.0, out 8.0, cache_read 0, reasoning folded at output rate.
        // 1M prompt (400k cached) + 500k completion (100k reasoning):
        // uncached 600k*2 + cached 400k*0 + plain 400k*8 + reasoning 100k*8
        let usd = table.estimate_usd("gpt-5.6-2026", 1_000_000, 500_000, 400_000, 100_000);
        assert!((usd - (0.6 * 2.0 + 0.4 * 8.0 + 0.1 * 8.0)).abs() < 1e-9);
        // Folded-reasoning rule keeps the total equal to completion*output.
        let folded = table.estimate_usd("gpt-5.6-2026", 0, 500_000, 0, 100_000);
        let flat = table.estimate_usd("gpt-5.6-2026", 0, 500_000, 0, 0);
        assert!((folded - flat).abs() < 1e-9);
    }

    #[test]
    fn unknown_model_uses_sonnet_class_fallback() {
        let table = table();
        let usd = table.estimate_usd("mystery-model", 1_000_000, 0, 0, 0);
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
