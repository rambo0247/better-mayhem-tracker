//! `src/main/db/connection.ts`: how the file is opened and released.

use std::path::Path;
use std::time::Duration;

use rusqlite::Connection;

/// better-sqlite3's default `timeout` option.
pub const BUSY_TIMEOUT: Duration = Duration::from_millis(5000);

/// better-sqlite3 builds SQLite with `SQLITE_DEFAULT_CACHE_SIZE=-16000`;
/// rusqlite's bundled build keeps SQLite's 2000-page default.
const CACHE_SIZE_KIB: i64 = -16000;

/// Opens `path` with the pragmas `openDatabase` sets.
pub fn open(path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    conn.busy_timeout(BUSY_TIMEOUT)?;
    conn.pragma_update(None, "cache_size", CACHE_SIZE_KIB)?;
    // Query modules build their SQL from filters, so keep more than the 16 a
    // connection caches by default
    conn.set_prepared_statement_cache_capacity(128);
    // The pragma answers with the mode it settled on, which Electron ignores
    conn.pragma_update_and_check(None, "journal_mode", "WAL", |_| Ok(()))?;
    // NORMAL is the standard companion to WAL: commits stop waiting on an
    // fsync. The only exposure is losing the latest commits to an OS crash,
    // and everything here is re-fetchable from the client.
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    Ok(conn)
}

/// Closes the connection, which checkpoints the WAL into the file. A failed
/// close is logged and dropped, as `closeDatabase` does.
pub fn close(conn: Connection) {
    if let Err((_, err)) = conn.close() {
        eprintln!("Failed to close database: {err}");
    }
}
