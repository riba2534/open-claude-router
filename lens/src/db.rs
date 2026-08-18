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
               req_body          TEXT,
               req_bytes         INTEGER,
               req_truncated     INTEGER,
               outcome           TEXT DEFAULT 'pending',
               status            INTEGER,
               duration_ms       INTEGER,
               complete          INTEGER,
               protocol_complete INTEGER,
               cancel_stage      TEXT,
               error_message     TEXT,
               resp_headers      TEXT,
               resp_body         TEXT,
               resp_bytes        INTEGER,
               resp_truncated    INTEGER,
               agg_response      TEXT,
               finish_reason     TEXT,
               input_tokens      INTEGER,
               output_tokens     INTEGER,
               cached_tokens     INTEGER,
               reasoning_tokens  INTEGER,
               preview           TEXT
             );
             CREATE INDEX IF NOT EXISTS idx_exchanges_ts ON exchanges(ts_unix);
             CREATE TABLE IF NOT EXISTS ingest_state (
               file   TEXT PRIMARY KEY,
               offset INTEGER NOT NULL
             );",
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
