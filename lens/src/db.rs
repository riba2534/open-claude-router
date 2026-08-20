use std::{
    path::Path,
    sync::{Arc, Mutex},
};

use rusqlite::Connection;

/// Single shared connection guarded by a mutex. Lens traffic is one ingester
/// thread plus a handful of dashboard readers, so contention is negligible and
/// this keeps WAL setup in one place.
#[derive(Clone)]
pub struct Db(Arc<Mutex<Connection>>);

impl Db {
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let conn = Connection::open(path)?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             CREATE TABLE IF NOT EXISTS exchanges (
               request_id        TEXT PRIMARY KEY,
               ts                TEXT,
               ts_unix           INTEGER,
               upstream_url      TEXT,
               format            TEXT,
               model             TEXT,
               stream            INTEGER,
               client_ip         TEXT,
               route_mode        TEXT,
               req_bytes         INTEGER,
               req_truncated     INTEGER,
               outcome           TEXT DEFAULT 'pending',
               status            INTEGER,
               duration_ms       INTEGER,
               complete          INTEGER,
               protocol_complete INTEGER,
               cancel_stage      TEXT,
               error_message     TEXT,
               resp_bytes        INTEGER,
               resp_truncated    INTEGER,
               finish_reason     TEXT,
               input_tokens      INTEGER,
               output_tokens     INTEGER,
               cached_tokens     INTEGER,
               cache_write_tokens INTEGER,
               reasoning_tokens  INTEGER,
               preview           TEXT,
               session_key       TEXT,
               session_hint      TEXT,
               updated_at        INTEGER,
               client_tag        TEXT
             );
             CREATE INDEX IF NOT EXISTS idx_exchanges_ts ON exchanges(ts_unix);
             -- Bodies live apart from the metadata they belong to: dashboard
             -- lists and aggregates scan `exchanges` only, and a row there is
             -- a few hundred bytes instead of a few hundred kilobytes. Only the
             -- detail view joins this table back in.
             CREATE TABLE IF NOT EXISTS exchange_bodies (
               request_id         TEXT PRIMARY KEY,
               req_body           TEXT,
               resp_headers       TEXT,
               resp_body          TEXT,
               agg_response       TEXT,
               client_req_body    TEXT,
               anthropic_response TEXT
             );
             CREATE TABLE IF NOT EXISTS ingest_state (
               file   TEXT PRIMARY KEY,
               offset INTEGER NOT NULL
             );",
        )?;
        migrate(&conn)?;
        conn.execute_batch(
            // (session_key, ts_unix) covers the session list: it groups by key
            // and takes MAX(ts_unix) per group, which the composite index can
            // answer without touching the table. The older single-column index
            // is a prefix of this one, so it has nothing left to offer.
            "DROP INDEX IF EXISTS idx_exchanges_session;
             CREATE INDEX IF NOT EXISTS idx_exchanges_session_ts ON exchanges(session_key, ts_unix);
             CREATE INDEX IF NOT EXISTS idx_exchanges_updated ON exchanges(updated_at);",
        )?;
        Ok(Self(Arc::new(Mutex::new(conn))))
    }

    pub fn with<T>(
        &self,
        work: impl FnOnce(&Connection) -> rusqlite::Result<T>,
    ) -> rusqlite::Result<T> {
        let guard = self.0.lock().expect("lens db mutex poisoned");
        work(&guard)
    }
}

/// Columns of `exchanges` in the current layout, i.e. metadata only.
const EXCHANGE_COLUMNS: &str = "request_id, ts, ts_unix, upstream_url, format, model, stream,
    client_ip, route_mode, req_bytes, req_truncated, outcome, status, duration_ms, complete,
    protocol_complete, cancel_stage, error_message, resp_bytes, resp_truncated, finish_reason,
    input_tokens, output_tokens, cached_tokens, cache_write_tokens, reasoning_tokens, preview,
    session_key, session_hint, updated_at, client_tag";

/// Body columns that used to live in `exchanges` and now form `exchange_bodies`.
const BODY_COLUMNS: [&str; 6] = [
    "req_body",
    "resp_headers",
    "resp_body",
    "agg_response",
    "client_req_body",
    "anthropic_response",
];

/// Brings databases written by older lens builds up to the current layout.
/// SQLite has no ADD COLUMN IF NOT EXISTS, so consult pragma table_info first.
fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    let columns = |conn: &Connection| -> rusqlite::Result<Vec<String>> {
        let mut statement = conn.prepare("PRAGMA table_info(exchanges)")?;
        let names = statement
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(names)
    };

    // Step 1: metadata columns added by later releases, for databases that
    // predate them. Body columns are deliberately not in this list — adding one
    // back would make step 2 think an already-migrated database still needs
    // migrating, and it would then fail on the columns that are really gone.
    let existing = columns(conn)?;
    for (name, definition) in [
        ("session_key", "session_key TEXT"),
        ("session_hint", "session_hint TEXT"),
        ("updated_at", "updated_at INTEGER"),
        ("client_tag", "client_tag TEXT"),
        ("cache_write_tokens", "cache_write_tokens INTEGER"),
    ] {
        if !existing.iter().any(|column| column == name) {
            conn.execute(
                &format!("ALTER TABLE exchanges ADD COLUMN {definition}"),
                [],
            )?;
        }
    }

    // Step 2: move bodies out of `exchanges`. Rebuilding the table once is far
    // cheaper than six ALTER TABLE DROP COLUMN passes, each of which rewrites
    // every row of what can be a multi-gigabyte table.
    let existing = columns(conn)?;
    let present: Vec<&str> = BODY_COLUMNS
        .iter()
        .copied()
        .filter(|name| existing.iter().any(|column| column == name))
        .collect();
    if present.is_empty() {
        return Ok(());
    }

    let rows: i64 = conn.query_row("SELECT COUNT(*) FROM exchanges", [], |row| row.get(0))?;
    tracing::info!(
        rows,
        "migrating lens database: moving bodies to their own table"
    );
    let started = std::time::Instant::now();

    // Older databases may lack some body columns entirely, so copy only the
    // ones this database actually has; the rest stay NULL.
    let body_targets = present.join(", ");
    conn.execute_batch(&format!(
        "BEGIN IMMEDIATE;
         INSERT OR REPLACE INTO exchange_bodies (request_id, {body_targets})
           SELECT request_id, {body_targets} FROM exchanges;
         CREATE TABLE exchanges_migrated AS SELECT {EXCHANGE_COLUMNS} FROM exchanges;
         DROP TABLE exchanges;
         ALTER TABLE exchanges_migrated RENAME TO exchanges;
         CREATE UNIQUE INDEX idx_exchanges_request_id ON exchanges(request_id);
         CREATE INDEX idx_exchanges_ts ON exchanges(ts_unix);
         COMMIT;"
    ))?;
    // CREATE TABLE AS drops the PRIMARY KEY, so the unique index above stands
    // in for it; ON CONFLICT(request_id) upserts still resolve against it.
    conn.execute_batch("VACUUM")?;
    tracing::info!(
        rows,
        elapsed_ms = started.elapsed().as_millis() as u64,
        "lens database migration complete"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Schema as shipped before bodies moved into their own table.
    const LEGACY_SCHEMA: &str = "CREATE TABLE exchanges (
           request_id TEXT PRIMARY KEY, ts TEXT, ts_unix INTEGER, upstream_url TEXT,
           format TEXT, model TEXT, stream INTEGER, client_ip TEXT, route_mode TEXT,
           req_body TEXT, req_bytes INTEGER, req_truncated INTEGER, outcome TEXT,
           status INTEGER, duration_ms INTEGER, complete INTEGER, protocol_complete INTEGER,
           cancel_stage TEXT, error_message TEXT, resp_headers TEXT, resp_body TEXT,
           resp_bytes INTEGER, resp_truncated INTEGER, agg_response TEXT, finish_reason TEXT,
           input_tokens INTEGER, output_tokens INTEGER, cached_tokens INTEGER,
           reasoning_tokens INTEGER, preview TEXT);";

    fn temp_path(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("lens-db-test-{name}-{}.db", uuid::Uuid::new_v4()))
    }

    #[test]
    fn legacy_database_keeps_its_data_when_bodies_move_out() {
        let path = temp_path("legacy");
        let seed = Connection::open(&path).unwrap();
        seed.execute_batch(LEGACY_SCHEMA).unwrap();
        seed.execute(
            "INSERT INTO exchanges (request_id, ts_unix, model, input_tokens, req_body, resp_body, agg_response, preview)
             VALUES ('req-1', 100, 'gpt-5.6', 42, '{\"a\":1}', 'raw sse', '{\"agg\":true}', 'hello')",
            [],
        )
        .unwrap();
        drop(seed);

        let db = Db::open(&path).unwrap();
        db.with(|conn| {
            // Metadata survives, and the columns that moved are gone from it.
            let (model, tokens, preview): (String, i64, String) = conn
                .query_row(
                    "SELECT model, input_tokens, preview FROM exchanges WHERE request_id = 'req-1'",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .unwrap();
            assert_eq!((model.as_str(), tokens, preview.as_str()), ("gpt-5.6", 42, "hello"));
            let names: Vec<String> = conn
                .prepare("PRAGMA table_info(exchanges)")
                .unwrap()
                .query_map([], |row| row.get::<_, String>(1))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap();
            for moved in BODY_COLUMNS {
                assert!(!names.iter().any(|name| name == moved), "{moved} still on exchanges");
            }
            assert!(
                names.iter().any(|name| name == "cache_write_tokens"),
                "new usage columns must be added before the legacy table is rebuilt"
            );
            // Bodies moved across intact.
            let (req, resp, agg): (String, String, String) = conn
                .query_row(
                    "SELECT req_body, resp_body, agg_response FROM exchange_bodies WHERE request_id = 'req-1'",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .unwrap();
            assert_eq!((req.as_str(), resp.as_str(), agg.as_str()), ("{\"a\":1}", "raw sse", "{\"agg\":true}"));
            // Upserts still resolve against request_id after the rebuild.
            conn.execute(
                "INSERT INTO exchanges (request_id, model) VALUES ('req-1', 'other')
                 ON CONFLICT(request_id) DO UPDATE SET model = excluded.model",
                [],
            )
            .unwrap();
            let count: i64 = conn
                .query_row("SELECT COUNT(*) FROM exchanges", [], |row| row.get(0))
                .unwrap();
            assert_eq!(count, 1, "conflict target must still be unique");
            Ok::<_, rusqlite::Error>(())
        })
        .unwrap();
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn opening_an_already_migrated_database_is_a_no_op() {
        let path = temp_path("idempotent");
        let db = Db::open(&path).unwrap();
        db.with(|conn| {
            conn.execute(
                "INSERT INTO exchanges (request_id, ts_unix, model) VALUES ('req-1', 1, 'm')",
                [],
            )?;
            conn.execute(
                "INSERT INTO exchange_bodies (request_id, req_body) VALUES ('req-1', 'body')",
                [],
            )
        })
        .unwrap();
        drop(db);

        // Reopening must not try to migrate again — that used to fail on the
        // columns that no longer exist.
        let db = Db::open(&path).unwrap();
        db.with(|conn| {
            let body: String = conn.query_row(
                "SELECT req_body FROM exchange_bodies WHERE request_id = 'req-1'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(body, "body");
            Ok::<_, rusqlite::Error>(())
        })
        .unwrap();
        let _ = std::fs::remove_file(&path);
    }
}
