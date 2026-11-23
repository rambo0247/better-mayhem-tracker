//! `src/main/db/connection.ts`: how the file is opened and released.

use std::path::Path;
use std::time::Duration;

use rusqlite::Connection;
use rusqlite::config::DbConfig;

use super::js;

/// better-sqlite3's default `timeout` option.
pub const BUSY_TIMEOUT: Duration = Duration::from_millis(5000);

/// Opens `path` with the pragmas `openDatabase` sets. A missing folder is
/// the `TypeError` better-sqlite3 throws before SQLite sees the path.
pub fn open(path: &Path) -> rusqlite::Result<Connection> {
    if path.parent().is_some_and(|dir| !dir.exists()) {
        return Err(js::thrown(js::JsError::type_error(
            "Cannot open database because the directory does not exist",
        )));
    }
    let conn = Connection::open(path)?;
    conn.busy_timeout(BUSY_TIMEOUT)?;
    // better-sqlite3 turns defensive mode on for every connection it opens
    conn.set_db_config(DbConfig::SQLITE_DBCONFIG_DEFENSIVE, true)?;
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
