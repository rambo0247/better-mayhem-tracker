//! The one connection to `matches.db`, `src/main/db/`. Every query module
//! works through [`Database::with`]. The file stays at `user_version` 4 with
//! Electron 1.2.1's DDL, byte for byte, so a player who rolls back to 1.2.1
//! opens what this build wrote.

pub mod connection;
pub mod filters;
pub mod ingest;
pub mod js;
pub mod matches;
pub mod migrations;
pub mod num;
pub mod payloads;
pub mod records;
pub mod schema;
pub mod scoring;
pub mod settings;
pub mod stats;
pub mod stmt;
pub mod summoner;
pub mod teammates;
pub mod week;
mod week_data;

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use rusqlite::Connection;
use tauri::{Manager, Runtime};

use crate::commands::{CommandError, CommandResult, Ctx};

pub const DB_FILE: &str = "matches.db";

/// The open database, or none once [`Database::close`] has run. Backup
/// restore closes it, swaps the file, and opens it again.
pub struct Database {
    path: PathBuf,
    conn: Mutex<Option<Connection>>,
}

impl Database {
    /// `initDatabase`: opens `matches.db` in `data_dir` and brings it up to
    /// the current schema. `now_ms` stamps the summoner rows a V1 upgrade
    /// recovers, where Electron reads `Date.now()`.
    pub fn open(data_dir: &Path, now_ms: i64) -> rusqlite::Result<Self> {
        let db = Self {
            path: data_dir.join(DB_FILE),
            conn: Mutex::new(None),
        };
        db.reopen(now_ms)?;
        Ok(db)
    }

    /// `getDbPath`.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Opens the file again after [`Database::close`], migrating as at
    /// launch. A connection already open is closed first.
    pub fn reopen(&self, now_ms: i64) -> rusqlite::Result<()> {
        let mut slot = self.lock();
        if let Some(old) = slot.take() {
            connection::close(old);
        }
        let conn = connection::open(&self.path)?;
        schema::init_database(&conn, now_ms)?;
        *slot = Some(conn);
        Ok(())
    }

    /// `closeDatabase`: checkpoints the WAL and releases the file, so a quit
    /// leaves no `-wal` or `-shm` beside it. Safe from any thread and any
    /// number of times: a call already running finishes first, and a second
    /// close does nothing. Only a call from inside [`Database::with`] on the
    /// same thread would wait on itself. The shell's exit paths call it, the
    /// SIGTERM and SIGINT handler included (T10), as Electron's `will-quit`
    /// does before it exits 0.
    pub fn close(&self) {
        if let Some(conn) = self.lock().take() {
            connection::close(conn);
        }
    }

    /// Runs `f` on the connection. Calls queue on one lock, as Electron's
    /// single-threaded main process ran them one at a time.
    pub fn with<T>(&self, f: impl FnOnce(&Connection) -> rusqlite::Result<T>) -> CommandResult<T> {
        let slot = self.lock();
        let conn = slot.as_ref().ok_or_else(not_open)?;
        f(conn).map_err(|err| sqlite_error(&err))
    }

    fn lock(&self) -> MutexGuard<'_, Option<Connection>> {
        // A panic inside `with` leaves the connection usable, so carry on
        self.conn
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// The managed [`Database`], as a command body reads it.
pub fn of<R: Runtime>(ctx: &Ctx<R>) -> CommandResult<tauri::State<'_, Database>> {
    ctx.app.try_state::<Database>().ok_or_else(not_open)
}

/// better-sqlite3's error for a closed connection.
fn not_open() -> CommandError {
    CommandError {
        name: "TypeError".into(),
        message: "The database connection is not open".into(),
        code: None,
    }
}

/// A failed call as Electron surfaces it. A JavaScript throw keeps its own
/// name, a `TypeError` or `RangeError`. A SQLite failure is better-sqlite3's
/// `SqliteError` carrying `sqlite3_errmsg` alone: rusqlite appends the path
/// to an open failure and the SQL to a prepare failure, and better-sqlite3
/// shows neither.
pub fn sqlite_error(err: &rusqlite::Error) -> CommandError {
    if let Some(thrown) = js::caught(err) {
        return CommandError {
            name: thrown.name.into(),
            message: thrown.message.clone(),
            code: None,
        };
    }
    let message = match err {
        rusqlite::Error::SqliteFailure(code, _) if code.code == rusqlite::ErrorCode::CannotOpen => {
            errstr(code.extended_code)
        }
        rusqlite::Error::SqliteFailure(_, Some(message)) => message.clone(),
        rusqlite::Error::SqliteFailure(code, None) => errstr(code.extended_code),
        rusqlite::Error::SqlInputError { msg, .. } => msg.clone(),
        other => other.to_string(),
    };
    CommandError {
        name: "SqliteError".into(),
        message,
        code: None,
    }
}

/// `sqlite3_errstr`: the message SQLite gives a result code when the
/// connection has no more specific one, as after a failed open.
fn errstr(code: std::ffi::c_int) -> String {
    // SAFETY: sqlite3_errstr returns a static, NUL-terminated string for any code
    unsafe { std::ffi::CStr::from_ptr(rusqlite::ffi::sqlite3_errstr(code)) }
        .to_string_lossy()
        .into_owned()
}
