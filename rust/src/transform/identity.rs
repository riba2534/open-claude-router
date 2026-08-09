use std::collections::{BTreeSet, HashMap, HashSet};

const OPENAI_IDENTIFIER_LIMIT: usize = 64;
const HASH_HEX_LEN: usize = 16;
const HASH_SEPARATOR_LEN: usize = 1;
const ALIAS_PREFIX_LIMIT: usize = OPENAI_IDENTIFIER_LIMIT - HASH_SEPARATOR_LEN - HASH_HEX_LEN;

#[derive(Clone, Debug, Default)]
pub(crate) struct ChatToolNameMap {
    forward: HashMap<String, String>,
    reverse: HashMap<String, String>,
}

impl ChatToolNameMap {
    pub(crate) fn new(names: impl IntoIterator<Item = String>) -> Self {
        let names = names.into_iter().collect::<BTreeSet<_>>();
        let mut used = names
            .iter()
            .filter(|name| is_chat_function_name(name))
            .cloned()
            .collect::<HashSet<_>>();
        let mut forward = HashMap::new();
        let mut reverse = HashMap::new();

        for name in names.iter().filter(|name| !is_chat_function_name(name)) {
            let prefix = chat_name_prefix(name);
            let alias = unique_alias(name, &prefix, &mut used);
            forward.insert(name.clone(), alias.clone());
            reverse.insert(alias, name.clone());
        }

        Self { forward, reverse }
    }

    pub(crate) fn wire_name<'a>(&'a self, name: &'a str) -> &'a str {
        self.forward.get(name).map(String::as_str).unwrap_or(name)
    }

    pub(crate) fn original_name<'a>(&'a self, name: &'a str) -> &'a str {
        self.reverse.get(name).map(String::as_str).unwrap_or(name)
    }
}

#[derive(Debug, Default)]
pub(crate) struct ResponsesCallIdMap {
    forward: HashMap<String, String>,
}

impl ResponsesCallIdMap {
    pub(crate) fn new(ids: impl IntoIterator<Item = String>) -> Self {
        let ids = ids.into_iter().collect::<BTreeSet<_>>();
        let mut used = ids
            .iter()
            .filter(|id| id.chars().count() <= OPENAI_IDENTIFIER_LIMIT)
            .cloned()
            .collect::<HashSet<_>>();
        let mut forward = HashMap::new();

        for id in ids
            .iter()
            .filter(|id| id.chars().count() > OPENAI_IDENTIFIER_LIMIT)
        {
            let prefix = id.chars().take(ALIAS_PREFIX_LIMIT).collect::<String>();
            let alias = unique_alias(id, &prefix, &mut used);
            forward.insert(id.clone(), alias);
        }

        Self { forward }
    }

    pub(crate) fn wire_id<'a>(&'a self, id: &'a str) -> &'a str {
        self.forward.get(id).map(String::as_str).unwrap_or(id)
    }
}

fn is_chat_function_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= OPENAI_IDENTIFIER_LIMIT
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn chat_name_prefix(name: &str) -> String {
    let prefix = name
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '_' | '-') {
                character
            } else {
                '_'
            }
        })
        .take(ALIAS_PREFIX_LIMIT)
        .collect::<String>();
    if prefix.is_empty() {
        "tool".into()
    } else {
        prefix
    }
}

fn unique_alias(original: &str, prefix: &str, used: &mut HashSet<String>) -> String {
    let base_hash = stable_hash(original, 0);
    // XOR with the probe number is injective for one original. Trying one
    // more candidate than the number of occupied names therefore guarantees
    // that a finite request finds a free alias without an unbounded loop.
    for attempt in 0..=used.len() {
        let probe = u64::try_from(attempt).expect("request name count fits in u64");
        let hash = base_hash ^ probe;
        let candidate = format!("{prefix}_{hash:016x}");
        if used.insert(candidate.clone()) {
            return candidate;
        }
    }
    unreachable!("one of used.len() + 1 distinct aliases must be free")
}

fn stable_hash(value: &str, attempt: u64) -> u64 {
    // FNV-1a is used only to make compact deterministic aliases. Every
    // candidate is checked against all unchanged names and generated aliases,
    // so a hash collision cannot merge two identities within a request.
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in value
        .as_bytes()
        .iter()
        .copied()
        .chain(attempt.to_le_bytes())
    {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chat_names_preserve_legal_short_identities_and_alias_long_collisions() {
        let exact_64 = "s".repeat(64);
        let shared = "x".repeat(64);
        let long_a = format!("{shared}A");
        let long_b = format!("{shared}B");
        let long_128 = "z".repeat(128);
        let names = ChatToolNameMap::new([
            exact_64.clone(),
            long_a.clone(),
            long_b.clone(),
            long_128.clone(),
            "Read".into(),
            "read".into(),
            "_foo".into(),
            "foo".into(),
        ]);

        for unchanged in [&exact_64, "Read", "read", "_foo", "foo"] {
            assert_eq!(names.wire_name(unchanged), unchanged);
        }
        for changed in [&long_a, &long_b, &long_128] {
            let wire = names.wire_name(changed);
            assert_ne!(wire, changed);
            assert!(wire.len() <= 64);
            assert!(is_chat_function_name(wire));
            assert_eq!(names.original_name(wire), changed);
        }
        assert_ne!(names.wire_name(&long_a), names.wire_name(&long_b));
        assert_eq!(
            names.original_name("unknown_wire_name"),
            "unknown_wire_name"
        );
    }

    #[test]
    fn aliases_do_not_overwrite_an_unchanged_name() {
        let long = "a".repeat(65);
        let provisional = format!(
            "{}_{}",
            "a".repeat(ALIAS_PREFIX_LIMIT),
            format_args!("{:016x}", stable_hash(&long, 0))
        );
        let names = ChatToolNameMap::new([long.clone(), provisional.clone()]);

        assert_eq!(names.wire_name(&provisional), provisional);
        assert_ne!(names.wire_name(&long), provisional);
        assert_eq!(names.original_name(names.wire_name(&long)), long);
    }

    #[test]
    fn aliases_are_stable_across_input_order_and_request_instances() {
        let first = "a".repeat(65);
        let second = "b".repeat(128);
        let ordered = ChatToolNameMap::new([first.clone(), second.clone()]);
        let reversed = ChatToolNameMap::new([second.clone(), first.clone()]);
        let independent = ChatToolNameMap::new([first.clone(), second.clone()]);

        for original in [&first, &second] {
            assert_eq!(ordered.wire_name(original), reversed.wire_name(original));
            assert_eq!(ordered.wire_name(original), independent.wire_name(original));
        }
    }

    #[test]
    fn responses_call_ids_preserve_64_and_pair_65_with_one_alias() {
        let exact_64 = "c".repeat(64);
        let long_65 = "d".repeat(65);
        let ids = ResponsesCallIdMap::new([exact_64.clone(), long_65.clone(), long_65.clone()]);

        assert_eq!(ids.wire_id(&exact_64), exact_64);
        assert_ne!(ids.wire_id(&long_65), long_65);
        assert_eq!(ids.wire_id(&long_65).chars().count(), 64);
        assert_eq!(ids.wire_id(&long_65), ids.wire_id(&long_65));
    }
}
