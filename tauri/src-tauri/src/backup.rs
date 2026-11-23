//! `src/main/backup.ts`: snapshots of `matches.db` in the backups folder, the
//! hourly check that keeps one no older than a day, restore, and the startup
//! recovery that brings back a database that is missing or will not open.
//!
//! File names, retention and every message match Electron 1.2.1, so either
//! app lists, prunes and restores the other's snapshots.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use jiff::civil::{Date, DateTime};
use jiff::tz::TimeZone;
use jiff::{Timestamp, ToSpan};
use rusqlite::{Connection, OpenFlags};
use tauri::plugin::TauriPlugin;
use tauri::{Manager, RunEvent, Runtime};

mod uv_errors;

use crate::commands::Clock;
use crate::commands::backup::{BackupInfo, RecoveryProblem, RecoveryReport};
use crate::db::{self, DB_FILE, Database, settings};

/// How stale the newest snapshot may get before the schedule takes another.
pub const MAX_AGE_MS: i64 = 24 * 60 * 60 * 1000;
/// The schedule only checks staleness, so this is a resolution, not a rate.
pub const CHECK_INTERVAL: Duration = Duration::from_secs(60 * 60);

const KEEP_RECENT: usize = 5;
const KEEP_WEEKLY: usize = 4;
const KEEP_MONTHLY: usize = 6;

/// better-sqlite3's default `backup` step.
const PAGES_PER_STEP: i32 = 100;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reason {
    Auto,
    Manual,
    PreImport,
    PreRepair,
    PreRestore,
}

impl Reason {
    pub fn as_str(self) -> &'static str {
        match self {
            Reason::Auto => "auto",
            Reason::Manual => "manual",
            Reason::PreImport => "pre-import",
            Reason::PreRepair => "pre-repair",
            Reason::PreRestore => "pre-restore",
        }
    }
}

/// The backups folder and the startup recovery report, managed beside the
/// [`Database`].
pub struct Backups {
    dir: PathBuf,
    tz: TimeZone,
    report: Option<RecoveryReport>,
    /// Held for the whole of a backup or a restore. Electron queues backups on
    /// one promise so two never prune each other's files; a list waits here
    /// too, so it never shows a file a running prune is about to remove.
    run: Mutex<()>,
    stop: Mutex<Option<mpsc::Sender<()>>>,
}

type Held<'a> = MutexGuard<'a, ()>;

impl Backups {
    pub fn new(dir: PathBuf, tz: TimeZone) -> Self {
        Self {
            dir,
            tz,
            report: None,
            run: Mutex::new(()),
            stop: Mutex::new(None),
        }
    }

    /// `getRecoveryReport`.
    pub fn recovery_report(&self) -> Option<RecoveryReport> {
        self.report.clone()
    }

    /// `getBackupDir`, which makes the folder on every use and throws when it
    /// can't.
    pub fn dir(&self) -> Result<&Path, String> {
        if !self.dir.exists() {
            mkdirp(&self.dir).map_err(|code| node_error(code, "mkdir", &self.dir, None))?;
        }
        Ok(&self.dir)
    }

    fn hold(&self) -> Held<'_> {
        self.run
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// `listBackups`: newest first, each with its game count, or none when the
    /// snapshot cannot be read. A damaged one still belongs in the list.
    pub fn list(&self) -> Result<Vec<BackupInfo>, String> {
        let _held = self.hold();
        let dir = self.dir()?.to_path_buf();
        Ok(self
            .read()
            .into_iter()
            .map(|backup| {
                let games = Connection::open_with_flags(
                    dir.join(&backup.file),
                    OpenFlags::SQLITE_OPEN_READ_ONLY,
                )
                .and_then(|snap| count_games(&snap))
                .ok();
                BackupInfo { games, ..backup }
            })
            .collect())
    }

    /// `createBackup`, queued behind any backup already running.
    pub fn create(&self, db: &Database, reason: Reason, now_ms: i64) -> Result<BackupInfo, String> {
        let held = self.hold();
        self.run_backup(&held, db, reason, now_ms, None)
    }

    /// `backupQuietly`: a failed snapshot is logged and never aborts the work
    /// it was protecting. Skipped when the player turned automatic backups off.
    pub fn backup_quietly(&self, db: &Database, reason: Reason, now_ms: i64) {
        let held = self.hold();
        self.quietly(&held, db, reason, now_ms, None);
    }

    /// `spare` names a backup this snapshot's prune must keep.
    fn quietly(
        &self,
        held: &Held<'_>,
        db: &Database,
        reason: Reason,
        now_ms: i64,
        spare: Option<&str>,
    ) {
        if auto_backup_off(db) {
            return;
        }
        match self.run_backup(held, db, reason, now_ms, spare) {
            Ok(backup) => println!(
                "Backed up {} games to {}",
                backup.games.unwrap_or_default(),
                backup.file
            ),
            Err(err) => eprintln!("Backup ({}) failed: {err}", reason.as_str()),
        }
    }

    fn run_backup(
        &self,
        _held: &Held<'_>,
        db: &Database,
        reason: Reason,
        now_ms: i64,
        spare: Option<&str>,
    ) -> Result<BackupInfo, String> {
        let dir = self.dir()?;
        let (file, created) = first_free(dir, now_ms, &self.tz, |stamp| {
            format!("matches-{stamp}-{}.db", reason.as_str())
        });
        let dest = dir.join(&file);
        // Written under a name the listing ignores, so a crash or a full disk
        // part way through can't leave a truncated file that looks usable
        let partial = suffixed(&dest, ".part");
        let attempt = || -> Result<BackupInfo, String> {
            // Through the live connection, with its lock held: a WAL database's
            // file alone is missing every commit still in the -wal
            let before = db
                .with(|conn| {
                    let before = count_games(conn)?;
                    let mut out = Connection::open(&partial)?;
                    rusqlite::backup::Backup::new(conn, &mut out)?.run_to_completion(
                        PAGES_PER_STEP,
                        Duration::ZERO,
                        None,
                    )?;
                    Ok(before)
                })
                .map_err(|err| err.message)?;
            let games = verify_snapshot(&partial)?;
            if games < before {
                return Err(format!(
                    "snapshot holds {games} games, database had {before}"
                ));
            }
            std::fs::rename(&partial, &dest)
                .map_err(|err| node_fs_error(&err, "rename", &partial, Some(&dest)))?;
            let size = std::fs::metadata(&dest)
                .map_err(|err| node_fs_error(&err, "stat", &dest, None))?
                .len() as i64;
            // Only once the new snapshot is verified on disk: a database that
            // has gone bad must never rotate out the good copies. A stepped
            // name can sort below the files it stepped past, so the prune
            // keeps the one just written by name
            self.prune(&self.read(), &[Some(file.as_str()), spare]);
            Ok(BackupInfo {
                file: file.clone(),
                created,
                size,
                games: Some(games),
                reason: reason.as_str().into(),
            })
        };
        attempt().inspect_err(|_| {
            // A copy that stops part way, as on a full disk, leaves a journal
            for leftover in [
                partial.clone(),
                suffixed(&partial, "-journal"),
                suffixed(&partial, "-wal"),
                suffixed(&partial, "-shm"),
            ] {
                remove_logged(&leftover);
            }
        })
    }

    /// `readBackups`: every file named as a backup, newest first. Names carry
    /// the time, so this never trusts mtimes a copy or sync client rewrites.
    fn read(&self) -> Vec<BackupInfo> {
        let entries = match self.dir().and_then(|dir| {
            std::fs::read_dir(dir).map_err(|err| node_fs_error(&err, "scandir", dir, None))
        }) {
            Ok(entries) => entries,
            Err(err) => {
                eprintln!("Failed to read backup directory: {err}");
                return Vec::new();
            }
        };
        // Node's readdir is sorted by name, which decides ties below
        let mut names: Vec<String> = entries
            .flatten()
            .filter_map(|entry| entry.file_name().into_string().ok())
            .collect();
        names.sort();
        let mut backups: Vec<BackupInfo> = names
            .into_iter()
            .filter_map(|file| {
                let (text, reason) = parse_name(&file)?;
                let created = parse_stamp(text, &self.tz);
                let reason = reason.to_owned();
                let size = std::fs::metadata(self.dir.join(&file)).ok()?.len() as i64;
                Some(BackupInfo {
                    file,
                    created,
                    size,
                    games: None,
                    reason,
                })
            })
            .collect();
        backups.sort_by_key(|b| std::cmp::Reverse(b.created));
        backups
    }

    /// Grandfather-father-son: the newest few, then the newest snapshot of
    /// each of the last few weeks and months. Everything else goes, except
    /// the files `spare` names.
    fn prune(&self, backups: &[BackupInfo], spare: &[Option<&str>]) {
        let victims = prune_victims(backups, &self.tz);
        for file in victims
            .into_iter()
            .filter(|file| !spare.contains(&Some(*file)))
        {
            if let Err(err) = rm_forced(&self.dir.join(file)) {
                eprintln!("Failed to remove old backup: {file} {err}");
            }
        }
    }

    fn is_stale(&self, now_ms: i64) -> bool {
        self.read()
            .first()
            .is_none_or(|newest| now_ms - newest.created > MAX_AGE_MS)
    }

    fn tick(&self, held: &Held<'_>, db: &Database, now_ms: i64) {
        if auto_backup_off(db) {
            return;
        }
        if self.is_stale(now_ms) {
            self.quietly(held, db, Reason::Auto, now_ms, None);
        }
    }

    /// `restoreBackup`: puts a snapshot in place of the live database, after
    /// taking a `pre-restore` snapshot so a mistaken restore can be undone.
    ///
    /// Electron can lose the database twice here, and this does not: the
    /// pre-restore snapshot's prune keeps the file being restored, and a swap
    /// that fails opens the untouched database again.
    pub fn restore(&self, db: &Database, file: &str, now_ms: i64) -> Result<i64, String> {
        let held = self.hold();
        let source = self.resolve(file)?;
        // Checked again now, not trusted from when it was written
        let games = verify_snapshot(&source)?;
        self.quietly(&held, db, Reason::PreRestore, now_ms, Some(file));
        db.close();
        let swapped = swap_in(&source, db.path());
        let reopened = db
            .reopen(now_ms)
            .map_err(|err| db::sqlite_error(&err).message);
        match (swapped, reopened) {
            (Ok(()), reopened) => reopened.map(|()| games),
            (Err(err), Ok(())) => Err(err),
            (Err(err), Err(reopen)) => {
                eprintln!("Failed to reopen the database after a failed restore: {reopen}");
                Err(err)
            }
        }
    }

    /// Only a bare name this module would have written, inside the backups
    /// folder: the name comes from the page.
    fn resolve(&self, file: &str) -> Result<PathBuf, String> {
        if parse_name(file).is_none() {
            return Err("Not a backup file name".into());
        }
        let full = self.dir()?.join(file);
        if !full.exists() {
            return Err("That backup no longer exists".into());
        }
        Ok(full)
    }

    /// Newest first, verifying as it goes: the newest snapshot is worth
    /// nothing if it can't be opened, and the one before it usually can.
    fn newest_usable(&self) -> Result<Option<PathBuf>, String> {
        let dir = self.dir()?.to_path_buf();
        Ok(self.read().into_iter().find_map(|backup| {
            let full = dir.join(&backup.file);
            match verify_snapshot(&full) {
                Ok(_) => Some(full),
                Err(err) => {
                    eprintln!("Skipping unusable backup: {} {err}", backup.file);
                    None
                }
            }
        }))
    }

    fn stop_schedule(&self) {
        let sender = self
            .stop
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        drop(sender);
    }
}

/// `initDatabaseWithRecovery`: opens `matches.db` in `data_dir`, and when the
/// file is gone or damaged, brings back the newest good snapshot from
/// `backup_dir` before anything reads it. A database that can't be opened for
/// any other reason is left as it is, and the error is the app's open error.
pub fn init_database_with_recovery(
    data_dir: &Path,
    backup_dir: PathBuf,
    now_ms: i64,
) -> Result<(Database, Backups), String> {
    open_with_recovery(
        data_dir,
        Backups::new(backup_dir, TimeZone::system()),
        now_ms,
    )
}

/// Why the database found at launch can't be used as it is.
enum OpenFailure {
    /// The file is damaged, or holds a schema the migrations can't bring
    /// forward, or was missing, so a snapshot takes its place.
    Lost(String),
    /// The file may be fine, but this launch can't use it: another process
    /// holds it, it or its folder is read-only, the disk is full or failing.
    Unavailable(String),
}

impl OpenFailure {
    fn of(err: &rusqlite::Error) -> Self {
        use rusqlite::ErrorCode::*;
        let message = db::sqlite_error(err).message;
        // A statement SQLite refused to prepare, such as one naming a column
        // the file lacks, is SQLite's own error too
        let code = match err {
            rusqlite::Error::SqliteFailure(error, _)
            | rusqlite::Error::SqlInputError { error, .. } => Some(error.code),
            _ => None,
        };
        match code {
            Some(
                DatabaseBusy
                | DatabaseLocked
                | ReadOnly
                | DiskFull
                | SystemIoFailure
                | CannotOpen
                | PermissionDenied
                | OutOfMemory
                | OperationInterrupted
                | FileLockingProtocolFailed
                | NoLargeFileSupport,
            ) => Self::Unavailable(message),
            Some(_) => Self::Lost(message),
            // Not SQLite's, such as a value of the wrong type: it says
            // nothing about whether the file is damaged
            None => Self::Unavailable(message),
        }
    }
}

/// Opens the database, then checks a file that was already there. Damage can
/// surface on open, in the statements migrations run, or only in the check.
fn open_checked(data_dir: &Path, missing: bool, now_ms: i64) -> Result<Database, OpenFailure> {
    let database = Database::open(data_dir, now_ms).map_err(|err| {
        // SQLite reads a folder where the file belongs as CANTOPEN, which is
        // otherwise passing. Electron sets the folder aside as damaged
        if data_dir.join(DB_FILE).is_dir() {
            OpenFailure::Lost(db::sqlite_error(&err).message)
        } else {
            OpenFailure::of(&err)
        }
    })?;
    if missing {
        return Ok(database);
    }
    // The SQLite error itself, not `with`'s message, so its code survives
    match database.with(|conn| Ok(first_quick_check_row(conn))) {
        Ok(Ok(Some(row))) if row == "ok" => Ok(database),
        Ok(Ok(row)) => Err(OpenFailure::Lost(
            row.unwrap_or_else(|| "integrity check failed".into()),
        )),
        Ok(Err(err)) => Err(OpenFailure::of(&err)),
        Err(closed) => Err(OpenFailure::Unavailable(closed.message)),
    }
}

fn open_with_recovery(
    data_dir: &Path,
    mut backups: Backups,
    now_ms: i64,
) -> Result<(Database, Backups), String> {
    let missing = !data_dir.join(DB_FILE).exists();
    let detail = match open_checked(data_dir, missing, now_ms) {
        Ok(database) => {
            // Opened cleanly but was not there a moment ago. With snapshots on
            // disk the file was deleted, and starting empty would look like loss
            if !(missing && !backups.read().is_empty()) {
                return Ok((database, backups));
            }
            drop(database);
            None
        }
        Err(OpenFailure::Lost(detail)) => Some(detail),
        // Nothing to lose when the file was not there
        Err(OpenFailure::Unavailable(detail)) if missing => Some(detail),
        Err(OpenFailure::Unavailable(detail)) => {
            // Electron sets the file aside here too, and restores over a
            // database that was only locked, read-only, or on a full disk
            eprintln!("Database failed to open, left as it is: {detail}");
            return Err(detail);
        }
    };
    let problem = match &detail {
        Some(detail) => {
            eprintln!("Database failed to open: {detail}");
            RecoveryProblem::Corrupt
        }
        None => RecoveryProblem::Missing,
    };
    let (database, report) = recover(&backups, data_dir, problem, detail, now_ms)?;
    backups.report = Some(report);
    Ok((database, backups))
}

/// `recover`. The database must already be closed.
fn recover(
    backups: &Backups,
    data_dir: &Path,
    problem: RecoveryProblem,
    detail: Option<String>,
    now_ms: i64,
) -> Result<(Database, RecoveryReport), String> {
    let db_path = data_dir.join(DB_FILE);
    // On the missing path this is the empty database the open just made,
    // still worth setting aside rather than overwriting blind
    let quarantined = if db_path.exists() {
        quarantine(&db_path, now_ms, &backups.tz)
    } else {
        None
    };

    let mut source = backups.newest_usable()?;
    if let Some(from) = &source
        && let Err(err) = swap_in(from, &db_path)
    {
        // Out of disk, or the file vanished between the check and the copy.
        // An empty database the player can use beats a window that never opens
        eprintln!("Failed to restore from backup: {err}");
        source = None;
    }
    let database =
        Database::open(data_dir, now_ms).map_err(|err| db::sqlite_error(&err).message)?;

    let name = |path: &Path| path.file_name().map(|n| n.to_string_lossy().into_owned());
    let report = RecoveryReport {
        problem,
        restored_from: source.as_deref().and_then(name),
        quarantined: quarantined.as_deref().and_then(name),
        detail,
    };
    eprintln!("Database recovery: {report:?}");
    Ok((database, report))
}

/// Sets a damaged database aside as `matches.db.corrupt-<stamp>`.
fn quarantine(db_path: &Path, now_ms: i64, tz: &TimeZone) -> Option<PathBuf> {
    let data_dir = db_path.parent().unwrap_or(Path::new(""));
    let (name, _) = first_free(data_dir, now_ms, tz, |stamp| {
        format!("{DB_FILE}.corrupt-{stamp}")
    });
    let dead = data_dir.join(name);
    let moved = std::fs::rename(db_path, &dead)
        .map_err(|err| node_fs_error(&err, "rename", db_path, Some(&dead)))
        .and_then(|()| rm_forced(&suffixed(db_path, "-wal")))
        .and_then(|()| rm_forced(&suffixed(db_path, "-shm")));
    match moved {
        Ok(()) => Some(dead),
        Err(err) => {
            eprintln!("Failed to set aside the damaged database: {err}");
            None
        }
    }
}

/// Puts a database file in place of the live one, which must be closed. A
/// failed copy leaves the live database and its `-wal` as they were, and
/// takes away the part it copied.
fn swap_in(source: &Path, db_path: &Path) -> Result<(), String> {
    // Copy then rename: a copy that fails half way must not leave a
    // truncated database where the live one was
    let incoming = suffixed(db_path, ".incoming");
    let swapped = std::fs::copy(source, &incoming)
        .map_err(|err| node_fs_error(&err, "copyfile", source, Some(&incoming)))
        // The -wal and -shm describe the database being replaced. Left
        // behind, SQLite would replay them onto the restored file
        .and_then(|_| rm_forced(&suffixed(db_path, "-wal")))
        .and_then(|()| rm_forced(&suffixed(db_path, "-shm")))
        .and_then(|()| {
            std::fs::rename(&incoming, db_path)
                .map_err(|err| node_fs_error(&err, "rename", &incoming, Some(db_path)))
        });
    if swapped.is_err() {
        remove_logged(&incoming);
    }
    swapped
}

/// Opens a finished snapshot and decides whether it can be trusted, returning
/// its game count. It also leaves the file in rollback-journal mode, so each
/// snapshot is one self-contained file that opens read-only.
fn verify_snapshot(file: &Path) -> Result<i64, String> {
    let check = || -> rusqlite::Result<Result<i64, String>> {
        let snap = Connection::open(file)?;
        let result = first_quick_check_row(&snap)?;
        if result.as_deref() != Some("ok") {
            return Ok(Err(format!(
                "integrity check failed: {}",
                result.as_deref().unwrap_or("unknown")
            )));
        }
        let games = count_games(&snap)?;
        snap.pragma_update_and_check(None, "journal_mode", "DELETE", |_| Ok(()))?;
        Ok(Ok(games))
    };
    check().map_err(|err| db::sqlite_error(&err).message)?
}

/// better-sqlite3's `pragma("quick_check")[0]`. It reads every row first, so
/// damage that stops the check part way throws, as SQLite's own error, rather
/// than reporting the rows before it.
fn first_quick_check_row(conn: &Connection) -> rusqlite::Result<Option<String>> {
    let mut stmt = conn.prepare("PRAGMA quick_check")?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows.into_iter().next())
}

fn count_games(conn: &Connection) -> rusqlite::Result<i64> {
    conn.query_row("SELECT COUNT(*) AS n FROM games", [], |row| row.get(0))
}

fn auto_backup_off(db: &Database) -> bool {
    match db.with(|conn| settings::get_setting(conn, "auto_backup")) {
        Ok(value) => value.as_str() == Some("false"),
        Err(err) => {
            eprintln!("Failed to read auto_backup: {}", err.message);
            false
        }
    }
}

/// `FILE_RE`, `^matches-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})-([a-z-]+)\.db$`:
/// the stamp and the reason.
fn parse_name(file: &str) -> Option<(&str, &str)> {
    let rest = file.strip_prefix("matches-")?;
    let stamp = rest.get(..19)?;
    let shape = stamp.bytes().enumerate().all(|(i, b)| match i {
        4 | 7 | 13 | 16 => b == b'-',
        10 => b == b'T',
        _ => b.is_ascii_digit(),
    });
    let reason = rest[19..].strip_prefix('-')?.strip_suffix(".db")?;
    let reason_ok =
        !reason.is_empty() && reason.bytes().all(|b| b.is_ascii_lowercase() || b == b'-');
    (shape && reason_ok).then_some((stamp, reason))
}

/// `stamp`: local time as `YYYY-MM-DDTHH-MM-SS`.
fn stamp(ms: i64, tz: &TimeZone) -> String {
    let (time, year) = local(ms, tz);
    format!("{year}-{}", time.strftime("%m-%dT%H-%M-%S"))
}

/// The name `name` gives the first stamp from `now_ms` on, a second at a
/// time, that nothing in `dir` already has, and that stamp's time. Electron
/// renames over a file taken in the same second, which loses a backup. The
/// stepped name keeps Electron's format, so Electron still lists and prunes
/// it, one second later than the file it would have replaced.
fn first_free(
    dir: &Path,
    now_ms: i64,
    tz: &TimeZone,
    name: impl Fn(&str) -> String,
) -> (String, i64) {
    let mut ms = now_ms;
    loop {
        let candidate = name(&stamp(ms, tz));
        if std::fs::symlink_metadata(dir.join(&candidate)).is_err() {
            return (candidate, ms);
        }
        ms += 1000;
    }
}

const DAY_MS: i64 = 24 * 60 * 60 * 1000;
/// 400 Gregorian years, a whole number of weeks, after which the calendar and
/// a time zone's standing DST rule repeat.
const CYCLE_MS: i64 = 146_097 * DAY_MS;
/// Year 9998. jiff stops at 9999, V8 at ±8.64e15 ms.
const JIFF_SAFE_MS: i64 = 253_339_228_800_000;
const V8_MAX_MS: i64 = 8_640_000_000_000_000;

/// The 400-year cycles that bring `ms` inside the span jiff can convert.
fn cycles_outside_jiff(ms: i64) -> i64 {
    if ms > JIFF_SAFE_MS {
        (ms - JIFF_SAFE_MS).div_euclid(CYCLE_MS) + 1
    } else if ms < -JIFF_SAFE_MS {
        -((-JIFF_SAFE_MS - ms).div_euclid(CYCLE_MS) + 1)
    } else {
        0
    }
}

/// The local time at `ms`, as `new Date(ms)` reads it, and its full year.
/// The time's own year is wrong past jiff's range; the returned year is not.
fn local(ms: i64, tz: &TimeZone) -> (DateTime, i64) {
    let cycles = cycles_outside_jiff(ms);
    let time = Timestamp::from_millisecond(ms - cycles * CYCLE_MS)
        .unwrap_or(Timestamp::UNIX_EPOCH)
        .to_zoned_datetime(tz.clone())
        .datetime();
    (time, i64::from(time.year()) + 400 * cycles)
}

/// Days from 1970-01-01 to the first of `month` in `year`, proleptic
/// Gregorian, for any year.
fn days_to_month(year: i64, month: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let year_of_era = y - era * 400;
    let day_of_year = (153 * ((month + 9) % 12) + 2) / 5;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// `parseStamp`: the local time a stamp names, in epoch ms, or 0 where
/// `new Date` would be invalid. V8 takes days 1 to 31 in any month, rolling
/// past the month's end, and `24:00:00` as the next midnight.
fn parse_stamp(text: &str, tz: &TimeZone) -> i64 {
    let num = |range: std::ops::Range<usize>| text[range].parse::<i64>().unwrap_or(-1);
    let (year, month, day) = (num(0..4), num(5..7), num(8..10));
    let (hour, minute, second) = (num(11..13), num(14..16), num(17..19));
    let valid = (1..=12).contains(&month)
        && (1..=31).contains(&day)
        && (0..=59).contains(&minute)
        && (0..=59).contains(&second)
        && (hour < 24 || (hour == 24 && minute == 0 && second == 0));
    if !valid {
        return 0;
    }
    let wall = (days_to_month(year, month) + day - 1) * DAY_MS
        + ((hour * 60 + minute) * 60 + second) * 1000;
    // Shifted by whole cycles into jiff's span for the offset, then back
    let cycles = cycles_outside_jiff(wall);
    let resolved = Timestamp::from_millisecond(wall - cycles * CYCLE_MS).and_then(|shifted| {
        shifted
            .to_zoned_datetime(TimeZone::UTC)
            .datetime()
            .to_zoned_datetime(tz.clone())
    });
    match resolved {
        Ok(zoned) => {
            let ms = zoned.timestamp().as_millisecond() + cycles * CYCLE_MS;
            if ms.abs() <= V8_MAX_MS { ms } else { 0 }
        }
        Err(_) => 0,
    }
}

/// The files the tiered retention drops, for backups sorted newest first.
fn prune_victims<'a>(backups: &'a [BackupInfo], tz: &TimeZone) -> Vec<&'a str> {
    let mut keep: Vec<&str> = backups
        .iter()
        .take(KEEP_RECENT)
        .map(|b| b.file.as_str())
        .collect();
    let mut bucket = |key: &dyn Fn(Date, i64) -> (i64, i8, i8), limit: usize| {
        let mut seen = Vec::new();
        for backup in backups {
            let (time, year) = local(backup.created, tz);
            let id = key(time.date(), year - i64::from(time.year()));
            if seen.contains(&id) {
                continue;
            }
            seen.push(id);
            if seen.len() > limit {
                break;
            }
            keep.push(&backup.file);
        }
    };
    // Week: the Sunday that starts it
    bucket(
        &|date, shift| {
            let back = i64::from(date.weekday().to_sunday_zero_offset());
            let sunday = date.checked_sub(back.days()).unwrap_or(date);
            (
                i64::from(sunday.year()) + shift,
                sunday.month(),
                sunday.day(),
            )
        },
        KEEP_WEEKLY,
    );
    bucket(
        &|date, shift| (i64::from(date.year()) + shift, date.month(), 0),
        KEEP_MONTHLY,
    );
    backups
        .iter()
        .map(|b| b.file.as_str())
        .filter(|file| !keep.contains(file))
        .collect()
}

fn suffixed(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

/// `fs.rmSync(path, { force: true })` with the errors Node 24 and 26 throw:
/// the `lstat` check in JavaScript, then `std::filesystem::remove` in C++,
/// whose failures read `<CODE>, <What>: <path> '<path>'`.
fn rm_forced(path: &Path) -> Result<(), String> {
    match std::fs::symlink_metadata(path) {
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(err) => return Err(node_fs_error(&err, "lstat", path, None)),
        Ok(meta) if meta.is_dir() => {
            return Err(format!(
                "Path is a directory: rm returned EISDIR (is a directory) {}",
                path.display()
            ));
        }
        Ok(_) => {}
    }
    let err = match std::fs::remove_file(path) {
        Err(err) if err.kind() != io::ErrorKind::NotFound => err,
        _ => return Ok(()),
    };
    let shown = path.display();
    Err(match rm_condition(&err) {
        Some((code, what)) => format!("{code}, {what}: {shown} '{shown}'"),
        None => format!(", Unknown error: {} '{shown}'", os_message(&err)),
    })
}

/// The `std::errc` Node's `RmSync` names, as `(code, text)`.
#[cfg(unix)]
fn rm_condition(err: &io::Error) -> Option<(&'static str, &'static str)> {
    match err.kind() {
        io::ErrorKind::DirectoryNotEmpty => Some(("ENOTEMPTY", "Directory not empty")),
        io::ErrorKind::NotADirectory => Some(("ENOTDIR", "Not a directory")),
        _ => match err.raw_os_error() {
            Some(1) => Some(("EPERM", "Operation not permitted")),
            Some(13) => Some(("EACCES", "Permission denied")),
            _ => None,
        },
    }
}

/// MSVC's STL maps these Win32 errors to `errc::permission_denied` and
/// `errc::directory_not_empty`; Node reports the first as EPERM on Windows.
#[cfg(windows)]
fn rm_condition(err: &io::Error) -> Option<(&'static str, &'static str)> {
    match err.raw_os_error()? {
        5 | 12 | 16 | 19 | 32 | 82 | 998 => Some(("EPERM", "Permission denied")),
        145 => Some(("ENOTEMPTY", "Directory not empty")),
        _ => None,
    }
}

#[cfg(not(any(unix, windows)))]
fn rm_condition(_err: &io::Error) -> Option<(&'static str, &'static str)> {
    None
}

/// The system's text for an OS error, without Rust's ` (os error N)`.
fn os_message(err: &io::Error) -> String {
    let text = err.to_string();
    match err.raw_os_error() {
        Some(code) => text
            .strip_suffix(&format!(" (os error {code})"))
            .unwrap_or(&text)
            .to_owned(),
        None => text,
    }
}

fn remove_logged(path: &Path) {
    if let Err(err) = rm_forced(path) {
        eprintln!("Failed to remove {}: {err}", path.display());
    }
}

/// `fs.mkdirSync(dir, { recursive: true })`, after Node's `MKDirpSync`. A
/// mkdir that fails for any reason but a missing parent or a short list of
/// final ones is followed by a stat, and the stat's error is the one thrown:
/// a dangling link reads ENOENT, and so does a missing folder on a read-only
/// volume. The `Err` is libuv's name.
fn mkdirp(dir: &Path) -> Result<(), &'static str> {
    let mut pending = vec![dir.to_path_buf()];
    while let Some(next) = pending.pop() {
        let err = match std::fs::create_dir(&next) {
            Ok(()) => continue,
            Err(err) => mkdir_code(&err),
        };
        match err {
            "EACCES" | "ENOSPC" | "ENOTDIR" | "EPERM" => return Err(err),
            "ENOENT" => match next.parent() {
                Some(parent) if !parent.as_os_str().is_empty() => {
                    let parent = parent.to_path_buf();
                    pending.push(next);
                    pending.push(parent);
                }
                _ => return Err(err),
            },
            _ => match std::fs::metadata(&next) {
                Ok(meta) if meta.is_dir() => {}
                Ok(_) if err == "EEXIST" && !pending.is_empty() => return Err("ENOTDIR"),
                Ok(_) => return Err("EEXIST"),
                Err(stat) => return Err(uv_name(&stat)),
            },
        }
    }
    Ok(())
}

/// libuv's `fs__mkdir` on Windows reports a bad name as EINVAL.
fn mkdir_code(err: &io::Error) -> &'static str {
    if cfg!(windows) && matches!(err.raw_os_error(), Some(123 | 267)) {
        return "EINVAL";
    }
    uv_name(err)
}

/// libuv's name for an OS error, or `UNKNOWN` as Node prints one it can't
/// name.
fn uv_name(err: &io::Error) -> &'static str {
    err.raw_os_error()
        .and_then(uv_errors::uv_code)
        .unwrap_or("UNKNOWN")
}

/// A failed `fs` call as Node throws it, `<CODE>: <description>, <syscall>
/// '<path>'`, with ` -> '<dest>'` for calls that take two. Settings shows it
/// after `Error: `.
fn node_fs_error(err: &io::Error, syscall: &str, path: &Path, dest: Option<&Path>) -> String {
    node_error(uv_name(err), syscall, path, dest)
}

fn node_error(code: &str, syscall: &str, path: &Path, dest: Option<&Path>) -> String {
    let mut text = format!(
        "{code}: {}, {syscall} '{}'",
        uv_errors::uv_message(code),
        path.display()
    );
    if let Some(dest) = dest {
        text.push_str(&format!(" -> '{}'", dest.display()));
    }
    text
}

/// `startBackupSchedule`, as a plugin so the check starts once the app is
/// built, in the real app and in golden replay alike. The first check holds
/// the backup lock before the app finishes building, so nothing lists the
/// folder until the launch snapshot is in it.
pub fn schedule<R: Runtime>(clock: Clock) -> TauriPlugin<R> {
    tauri::plugin::Builder::new("bmt-backup-schedule")
        .setup(move |app, _api| {
            if app.try_state::<Backups>().is_none() {
                return Ok(());
            }
            let (stop_tx, stop_rx) = mpsc::channel::<()>();
            *app.state::<Backups>()
                .stop
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(stop_tx);
            let (ready_tx, ready_rx) = mpsc::sync_channel::<()>(0);
            let app = app.clone();
            std::thread::Builder::new()
                .name("backup-schedule".into())
                .spawn(move || {
                    let backups = app.state::<Backups>();
                    let database = app.state::<Database>();
                    {
                        let held = backups.hold();
                        // The receiver only goes away if setup has already returned
                        let _ = ready_tx.send(());
                        backups.tick(&held, &database, clock.now_ms());
                    }
                    while let Err(RecvTimeoutError::Timeout) = stop_rx.recv_timeout(CHECK_INTERVAL)
                    {
                        let held = backups.hold();
                        backups.tick(&held, &database, clock.now_ms());
                    }
                })?;
            ready_rx.recv()?;
            Ok(())
        })
        .on_event(|app, event| {
            // stopBackupSchedule
            if let RunEvent::Exit = event
                && let Some(backups) = app.try_state::<Backups>()
            {
                backups.stop_schedule();
            }
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `FIXED_TIME` in `parity/run-electron.ts`, 2026-11-22T21:00:00-05:00.
    const NOW: i64 = 1_795_399_200_000;
    const GOOD: &str = "matches-2026-11-20T10-00-00-auto.db";
    const BAD: &str = "matches-2026-11-21T10-00-00-manual.db";

    fn new_york() -> TimeZone {
        TimeZone::get("America/New_York").expect("the tzdb has New York")
    }

    /// A fresh `<temp>/bmt-backup-<pid>-<name>` holding `data/` and `backups/`.
    fn scratch(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("bmt-backup-{}-{name}", std::process::id()));
        if root.exists() {
            std::fs::remove_dir_all(&root).expect("clear the scratch folder");
        }
        std::fs::create_dir_all(root.join("data")).expect("make data/");
        std::fs::create_dir_all(root.join("backups")).expect("make backups/");
        root
    }

    fn insert_games(db: &Database, count: i64) {
        db.with(|conn| {
            for id in 0..count {
                conn.execute(
                    "INSERT INTO games (game_id, queue_id, game_mode, game_creation, game_duration) VALUES (?, 2400, 'KIWI', ?, 1200)",
                    (id + 1, NOW - id * 60_000),
                )?;
            }
            Ok(())
        })
        .expect("insert games");
    }

    /// A closed database of `games` games, as a file to copy around.
    fn database_file(root: &Path, games: i64) -> PathBuf {
        let dir = root.join("source");
        std::fs::create_dir_all(&dir).expect("make source/");
        let db = Database::open(&dir, NOW).expect("open the source");
        insert_games(&db, games);
        db.close();
        dir.join(DB_FILE)
    }

    fn garbage(path: &Path, text: &str) {
        std::fs::write(path, &text.repeat(8192 / text.len() + 1).as_bytes()[..8192])
            .expect("write garbage");
    }

    fn names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .expect("read a folder")
            .map(|e| {
                e.expect("an entry")
                    .file_name()
                    .into_string()
                    .expect("UTF-8")
            })
            .collect();
        names.sort();
        names
    }

    fn open(root: &Path) -> (Database, Backups) {
        open_with_recovery(
            &root.join("data"),
            Backups::new(root.join("backups"), new_york()),
            NOW,
        )
        .expect("the database opens")
    }

    /// The schedule's first check, as the plugin runs it at launch.
    fn launch_tick(backups: &Backups, db: &Database) {
        let held = backups.hold();
        backups.tick(&held, db, NOW);
    }

    fn report_json(backups: &Backups) -> serde_json::Value {
        serde_json::to_value(backups.recovery_report()).expect("a report serializes")
    }

    /// Electron 1.2.1's listing and prune of the same names, from
    /// `parity/out/t17/electron.json` (scenario `prune`), with the clock frozen
    /// at `NOW` in New York. The listing pins `parseStamp`: February 30th rolls
    /// into March, month 13 reads as 0, and 01:30 on the day clocks fall back
    /// is the earlier one.
    #[test]
    fn prune_keeps_the_set_electron_keeps() {
        let names_and_created: [(&str, i64); 33] = [
            ("matches-2026-11-22T08-00-00-auto.db", 1795352400000),
            ("matches-2026-11-21T10-00-00-auto.db", 1795273200000),
            ("matches-2026-11-21T10-00-00-manual.db", 1795273200000),
            ("matches-2026-11-21T10-00-00-pre-restore.db", 1795273200000),
            ("matches-2026-11-20T10-00-00-auto.db", 1795186800000),
            ("matches-2026-11-19T10-00-00-auto.db", 1795100400000),
            ("matches-2026-11-18T10-00-00-auto.db", 1795014000000),
            ("matches-2026-11-15T10-00-00-auto.db", 1794754800000),
            ("matches-2026-11-14T10-00-00-auto.db", 1794668400000),
            ("matches-2026-11-08T10-00-00-auto.db", 1794150000000),
            ("matches-2026-11-07T10-00-00-auto.db", 1794063600000),
            ("matches-2026-11-01T10-00-00-auto.db", 1793545200000),
            ("matches-2026-11-01T01-30-00-auto.db", 1793511000000),
            ("matches-2026-10-25T10-00-00-manual.db", 1792936800000),
            ("matches-2026-10-18T00-30-00-auto.db", 1792297800000),
            ("matches-2026-10-17T23-00-00-auto.db", 1792292400000),
            ("matches-2026-10-11T10-00-00-auto.db", 1791727200000),
            ("matches-2026-10-04T10-00-00-auto.db", 1791122400000),
            ("matches-2026-09-13T12-00-00-auto.db", 1789315200000),
            ("matches-2026-08-02T08-00-00-auto.db", 1785672000000),
            ("matches-2026-07-15T08-00-00-pre-repair.db", 1784116800000),
            ("matches-2026-06-30T23-00-00-auto.db", 1782874800000),
            ("matches-2026-06-01T10-00-00-auto.db", 1780322400000),
            ("matches-2026-05-31T10-00-00-auto.db", 1780236000000),
            ("matches-2026-04-30T22-00-00-pre-import.db", 1777600800000),
            ("matches-2026-03-08T03-00-00-auto.db", 1772953200000),
            ("matches-2026-03-08T01-59-59-auto.db", 1772953199000),
            ("matches-2026-02-30T10-00-00-auto.db", 1772463600000),
            ("matches-2026-02-15T12-00-00-manual.db", 1771174800000),
            ("matches-2026-01-04T00-00-00-auto.db", 1767502800000),
            ("matches-2026-01-03T23-59-59-auto.db", 1767502799000),
            ("matches-2025-12-28T09-00-00-auto.db", 1766930400000),
            ("matches-2026-13-01T00-00-00-auto.db", 0),
        ];
        let root = scratch("prune");
        std::fs::copy(database_file(&root, 669), root.join("data").join(DB_FILE))
            .expect("place the database");
        // Listed in an order the folder does not keep, so sorting is the code's
        for (name, _) in names_and_created.iter().rev() {
            std::fs::write(root.join("backups").join(name), b"").expect("an empty backup");
        }
        std::fs::write(root.join("backups").join("notes.txt"), b"").expect("a stray file");
        let (db, backups) = open(&root);

        let listed: Vec<(String, i64)> = backups
            .list()
            .expect("a listing")
            .into_iter()
            .map(|b| (b.file, b.created))
            .collect();
        let expected: Vec<(String, i64)> = names_and_created
            .iter()
            .map(|(n, c)| ((*n).to_owned(), *c))
            .collect();
        assert_eq!(listed, expected, "names parse and sort as Electron's do");

        // The newest is 13 hours old, so the launch check takes nothing
        launch_tick(&backups, &db);
        let made = backups
            .create(&db, Reason::Manual, NOW)
            .expect("a manual backup");
        assert_eq!(made.file, "matches-2026-11-22T21-00-00-manual.db");
        assert_eq!((made.created, made.games), (NOW, Some(669)));
        assert_eq!(
            names(&root.join("backups")),
            [
                "matches-2026-06-30T23-00-00-auto.db",
                "matches-2026-07-15T08-00-00-pre-repair.db",
                "matches-2026-08-02T08-00-00-auto.db",
                "matches-2026-09-13T12-00-00-auto.db",
                "matches-2026-10-25T10-00-00-manual.db",
                "matches-2026-11-07T10-00-00-auto.db",
                "matches-2026-11-14T10-00-00-auto.db",
                "matches-2026-11-21T10-00-00-auto.db",
                "matches-2026-11-21T10-00-00-manual.db",
                "matches-2026-11-21T10-00-00-pre-restore.db",
                "matches-2026-11-22T08-00-00-auto.db",
                "matches-2026-11-22T21-00-00-manual.db",
                "notes.txt",
            ],
            "the files Electron kept"
        );
        // Windows can't remove a file that is still open
        drop(db);
        std::fs::remove_dir_all(&root).expect("clean up");
    }

    /// Electron's `corrupt-garbage-backups`: the file is set aside under
    /// Electron's name, the newest backup that verifies comes back, and the
    /// launch check snapshots the restored database.
    #[test]
    fn a_corrupt_database_is_quarantined_and_restored() {
        let root = scratch("corrupt");
        garbage(&root.join("data").join(DB_FILE), "this is not a database ");
        std::fs::copy(database_file(&root, 7), root.join("backups").join(GOOD))
            .expect("a good backup");
        garbage(&root.join("backups").join(BAD), "garbage ");
        let (db, backups) = open(&root);

        assert_eq!(
            report_json(&backups),
            serde_json::json!({
                "problem": "corrupt",
                "restoredFrom": GOOD,
                "quarantined": "matches.db.corrupt-2026-11-22T21-00-00",
                "detail": "file is not a database",
            })
        );
        assert!(
            root.join("data/matches.db.corrupt-2026-11-22T21-00-00")
                .exists()
        );
        launch_tick(&backups, &db);
        let listed: Vec<(String, Option<i64>)> = backups
            .list()
            .expect("a listing")
            .into_iter()
            .map(|b| (b.file, b.games))
            .collect();
        assert_eq!(
            listed,
            [
                ("matches-2026-11-22T21-00-00-auto.db".to_owned(), Some(7)),
                (BAD.to_owned(), None),
                (GOOD.to_owned(), Some(7)),
            ]
        );
        drop(db);
        std::fs::remove_dir_all(&root).expect("clean up");
    }

    #[test]
    fn a_corrupt_database_without_backups_starts_empty() {
        let root = scratch("corrupt-empty");
        garbage(&root.join("data").join(DB_FILE), "this is not a database ");
        let (db, backups) = open(&root);
        assert_eq!(
            report_json(&backups),
            serde_json::json!({
                "problem": "corrupt",
                "restoredFrom": null,
                "quarantined": "matches.db.corrupt-2026-11-22T21-00-00",
                "detail": "file is not a database",
            })
        );
        assert_eq!(db.with(count_games).expect("count"), 0);
        drop(db);
        std::fs::remove_dir_all(&root).expect("clean up");
    }

    /// Electron's `missing-backups`: the empty database the open made is set
    /// aside too, and the report has no `detail` key at all.
    #[test]
    fn a_missing_database_comes_back_from_the_newest_backup() {
        let root = scratch("missing");
        std::fs::copy(database_file(&root, 5), root.join("backups").join(GOOD))
            .expect("a good backup");
        let (db, backups) = open(&root);
        assert_eq!(
            report_json(&backups),
            serde_json::json!({
                "problem": "missing",
                "restoredFrom": GOOD,
                "quarantined": "matches.db.corrupt-2026-11-22T21-00-00",
            })
        );
        assert_eq!(db.with(count_games).expect("count"), 5);
        drop(db);
        std::fs::remove_dir_all(&root).expect("clean up");
    }

    /// Electron's `missing-nobackup`: a first launch, with no report, whose
    /// launch check snapshots the empty database.
    #[test]
    fn a_first_launch_reports_nothing() {
        let root = scratch("first");
        let (db, backups) = open(&root);
        assert_eq!(backups.recovery_report(), None);
        launch_tick(&backups, &db);
        let listed: Vec<(String, Option<i64>)> = backups
            .list()
            .expect("a listing")
            .into_iter()
            .map(|b| (b.file, b.games))
            .collect();
        assert_eq!(
            listed,
            [("matches-2026-11-22T21-00-00-auto.db".to_owned(), Some(0))]
        );
        drop(db);
        std::fs::remove_dir_all(&root).expect("clean up");
    }

    /// Electron's `restore-errors`, message for message.
    #[test]
    fn restore_refuses_as_electron_does() {
        let root = scratch("restore");
        let source = database_file(&root, 4);
        std::fs::copy(&source, root.join("data").join(DB_FILE)).expect("place the database");
        std::fs::copy(&source, root.join("backups").join(GOOD)).expect("a good backup");
        garbage(&root.join("backups").join(BAD), "garbage ");
        let (db, backups) = open(&root);
        let restore = |file: &str| backups.restore(&db, file, NOW);
        assert_eq!(restore(BAD), Err("file is not a database".into()));
        assert_eq!(
            restore("matches-2026-01-01T00-00-00-auto.db"),
            Err("That backup no longer exists".into())
        );
        assert_eq!(
            restore("matches-2026-11-20T10-00-00-AUTO.db"),
            Err("Not a backup file name".into())
        );
        assert_eq!(
            restore("../matches.db"),
            Err("Not a backup file name".into())
        );
        assert_eq!(restore(GOOD), Ok(4));
        assert!(
            root.join("backups/matches-2026-11-22T21-00-00-pre-restore.db")
                .exists(),
            "a restore takes a pre-restore snapshot first"
        );
        assert_eq!(db.with(count_games).expect("the reopened database"), 4);
        drop(db);
        std::fs::remove_dir_all(&root).expect("clean up");
    }

    /// Electron's `auto-off`: no launch snapshot and no pre-restore snapshot,
    /// but a manual backup still runs.
    #[test]
    fn turning_automatic_backups_off_stops_all_but_manual_ones() {
        let root = scratch("auto-off");
        let source = database_file(&root, 2);
        std::fs::copy(&source, root.join("data").join(DB_FILE)).expect("place the database");
        std::fs::copy(&source, root.join("backups").join(GOOD)).expect("a good backup");
        let (db, backups) = open(&root);
        db.with(|conn| settings::set_setting(conn, "auto_backup", "false"))
            .expect("turn it off");
        launch_tick(&backups, &db);
        assert_eq!(backups.restore(&db, GOOD, NOW), Ok(2));
        assert_eq!(names(&root.join("backups")), [GOOD]);
        // The restored copy predates the setting, so turn it off again
        db.with(|conn| settings::set_setting(conn, "auto_backup", "false"))
            .expect("turn it off");
        backups.backup_quietly(&db, Reason::PreImport, NOW);
        assert_eq!(names(&root.join("backups")), [GOOD]);
        backups
            .create(&db, Reason::Manual, NOW)
            .expect("a manual backup");
        assert_eq!(
            names(&root.join("backups")),
            [GOOD, "matches-2026-11-22T21-00-00-manual.db"]
        );
        drop(db);
        std::fs::remove_dir_all(&root).expect("clean up");
    }

    #[test]
    fn a_backup_is_one_self_contained_file() {
        let root = scratch("self-contained");
        let (db, backups) = open(&root);
        insert_games(&db, 3);
        let made = backups.create(&db, Reason::Manual, NOW).expect("a backup");
        assert_eq!(names(&root.join("backups")), [made.file.as_str()]);
        let file = root.join("backups").join(&made.file);
        let bytes = std::fs::read(&file).expect("read the backup");
        // Header bytes 18 and 19 are 1 in rollback-journal mode, 2 in WAL
        assert_eq!((bytes[18], bytes[19]), (1, 1));
        assert_eq!(made.size, bytes.len() as i64);
        let snap = Connection::open_with_flags(&file, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .expect("opens read-only");
        assert_eq!(count_games(&snap).expect("count"), 3);
        drop((snap, db));
        std::fs::remove_dir_all(&root).expect("clean up");
    }
    /// Electron's `restore-pruned`: with six backups, the pre-restore
    /// snapshot's prune would delete the one being restored. Electron then
    /// fails the restore with its database closed. Here the file is spared
    /// and the next oldest goes instead.
    #[test]
    fn a_restore_keeps_the_backup_it_restores() {
        let root = scratch("restore-pruned");
        let source = database_file(&root, 3);
        std::fs::copy(&source, root.join("data").join(DB_FILE)).expect("place the database");
        for hour in 5..=10 {
            let name = format!("matches-2026-11-22T{hour:02}-00-00-auto.db");
            std::fs::copy(&source, root.join("backups").join(name)).expect("a backup");
        }
        let (db, backups) = open(&root);
        assert_eq!(
            backups.restore(&db, "matches-2026-11-22T06-00-00-auto.db", NOW),
            Ok(3)
        );
        assert_eq!(
            names(&root.join("backups")),
            [
                "matches-2026-11-22T06-00-00-auto.db",
                "matches-2026-11-22T07-00-00-auto.db",
                "matches-2026-11-22T08-00-00-auto.db",
                "matches-2026-11-22T09-00-00-auto.db",
                "matches-2026-11-22T10-00-00-auto.db",
                "matches-2026-11-22T21-00-00-pre-restore.db",
            ]
        );
        assert_eq!(db.with(count_games).expect("the restored database"), 3);
        drop(db);
        std::fs::remove_dir_all(&root).expect("clean up");
    }

    /// A swap that fails leaves the database it was replacing open, rather
    /// than closed for the rest of the session as Electron leaves it.
    #[test]
    fn a_failed_swap_opens_the_database_again() {
        let root = scratch("swap-fails");
        let live = database_file(&root, 4);
        std::fs::copy(&live, root.join("data").join(DB_FILE)).expect("place the database");
        std::fs::copy(
            database_file(&scratch_sibling(&root), 9),
            root.join("backups").join(GOOD),
        )
        .expect("a good backup");
        let (db, backups) = open(&root);
        let incoming = root.join("data").join("matches.db.incoming");
        std::fs::create_dir_all(incoming.join("in-the-way")).expect("block the copy");

        let error = backups.restore(&db, GOOD, NOW).expect_err("the copy fails");
        #[cfg(unix)]
        assert_eq!(
            error,
            format!(
                "EISDIR: illegal operation on a directory, copyfile '{}' -> '{}'",
                root.join("backups").join(GOOD).display(),
                incoming.display()
            )
        );
        #[cfg(not(unix))]
        let _ = error;
        assert_eq!(db.with(count_games).expect("still open"), 4);
        backups
            .create(&db, Reason::Manual, NOW + 1000)
            .expect("a backup after the failed restore");
        std::fs::remove_dir_all(&incoming).expect("unblock the copy");
        assert_eq!(backups.restore(&db, GOOD, NOW + 2000), Ok(9));
        assert!(!incoming.exists());
        drop(db);
        std::fs::remove_dir_all(&root).expect("clean up");
        std::fs::remove_dir_all(scratch_sibling(&root)).expect("clean up");
    }

    fn scratch_sibling(root: &Path) -> PathBuf {
        let mut name = root.as_os_str().to_owned();
        name.push("-other");
        PathBuf::from(name)
    }

    /// A launch that can't use a healthy database leaves it exactly as it
    /// was: no quarantine, no restore over it, the error is the open error.
    fn assert_left_alone(root: &Path, expected: &str) {
        let db_file = root.join("data").join(DB_FILE);
        let before = std::fs::read(&db_file).expect("read the database");
        let opened = open_with_recovery(
            &root.join("data"),
            Backups::new(root.join("backups"), new_york()),
            NOW,
        );
        assert_eq!(opened.err().as_deref(), Some(expected));
        assert_eq!(std::fs::read(&db_file).expect("read it again"), before);
        assert!(
            names(&root.join("data"))
                .iter()
                .all(|name| !name.starts_with("matches.db.corrupt-")),
            "nothing was set aside"
        );
        assert_eq!(names(&root.join("backups")), [GOOD]);
    }

    fn healthy_with_a_backup(name: &str) -> PathBuf {
        let root = scratch(name);
        let source = database_file(&root, 669);
        std::fs::copy(&source, root.join("data").join(DB_FILE)).expect("place the database");
        std::fs::copy(&source, root.join("backups").join(GOOD)).expect("a good backup");
        root
    }

    /// Electron's `lock`, which Electron answers by quarantining the file.
    #[test]
    fn a_locked_database_is_left_alone() {
        let root = healthy_with_a_backup("locked");
        let holder = Connection::open(root.join("data").join(DB_FILE)).expect("a second opener");
        holder
            .execute_batch(
                "PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; SELECT count(*) FROM games;",
            )
            .expect("hold the lock");
        assert_left_alone(&root, "database is locked");
        drop(holder);
        std::fs::remove_dir_all(&root).expect("clean up");
    }

    /// Electron's `rofile`, which Electron answers by quarantining the file.
    #[cfg(unix)]
    #[test]
    fn a_read_only_database_is_left_alone() {
        use std::os::unix::fs::PermissionsExt;
        let root = healthy_with_a_backup("read-only");
        let db_file = root.join("data").join(DB_FILE);
        // Stored in rollback-journal mode, so the open has to write the header
        Connection::open(&db_file)
            .and_then(|conn| conn.pragma_update(None, "journal_mode", "DELETE"))
            .expect("leave WAL mode");
        std::fs::set_permissions(&db_file, std::fs::Permissions::from_mode(0o444))
            .expect("make it read-only");
        assert_left_alone(&root, "attempt to write a readonly database");
        std::fs::set_permissions(&db_file, std::fs::Permissions::from_mode(0o644))
            .expect("make it writable");
        std::fs::remove_dir_all(&root).expect("clean up");
    }

    /// `getBackupDir`'s `mkdirSync` throws into the listing, a backup, a
    /// restore, and recovery.
    #[cfg(unix)]
    #[test]
    fn a_backups_folder_that_cannot_be_made_fails_as_node_does() {
        use std::os::unix::fs::PermissionsExt;
        let root = scratch("no-backups-folder");
        let locked = root.join("locked");
        std::fs::create_dir(&locked).expect("make locked/");
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o555)).expect("lock it");
        let dir = locked.join("backups");
        let expected = format!("EACCES: permission denied, mkdir '{}'", dir.display());

        let (db, backups) = open_with_recovery(
            &root.join("data"),
            Backups::new(dir.clone(), new_york()),
            NOW,
        )
        .expect("a first launch");
        assert_eq!(backups.list(), Err(expected.clone()));
        assert_eq!(
            backups.create(&db, Reason::Manual, NOW).map(|b| b.file),
            Err(expected.clone())
        );
        assert_eq!(backups.restore(&db, GOOD, NOW), Err(expected.clone()));
        drop(db);

        garbage(&root.join("data").join(DB_FILE), "this is not a database ");
        let recovered = open_with_recovery(&root.join("data"), Backups::new(dir, new_york()), NOW);
        assert_eq!(recovered.err(), Some(expected));
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755))
            .expect("unlock it");
        std::fs::remove_dir_all(&root).expect("clean up");
    }

    #[test]
    fn file_system_errors_read_as_node_writes_them() {
        let root = scratch("node-errors");
        let (from, to) = (root.join("gone.db"), root.join("matches.db.incoming"));
        let missing = std::fs::copy(&from, &to).expect_err("nothing to copy");
        assert_eq!(
            node_fs_error(&missing, "copyfile", &from, Some(&to)),
            format!(
                "ENOENT: no such file or directory, copyfile '{}' -> '{}'",
                from.display(),
                to.display()
            )
        );
        #[cfg(unix)]
        let full = io::Error::from_raw_os_error(28);
        #[cfg(windows)]
        let full = io::Error::from_raw_os_error(112);
        assert_eq!(
            node_fs_error(&full, "copyfile", &from, Some(&to)),
            format!(
                "ENOSPC: no space left on device, copyfile '{}' -> '{}'",
                from.display(),
                to.display()
            )
        );
        let odd = io::Error::other("no errno");
        assert_eq!(
            node_fs_error(&odd, "stat", &from, None),
            format!("UNKNOWN: unknown error, stat '{}'", from.display())
        );
        std::fs::remove_dir_all(&root).expect("clean up");
    }

    /// A backup as the app writes one, in rollback-journal mode.
    fn backup_of(root: &Path, games: i64, name: &str) -> PathBuf {
        let dest = root.join("backups").join(name);
        let source = database_file(&scratch_sibling(root), games);
        std::fs::copy(&source, &dest).expect("a backup");
        std::fs::remove_dir_all(scratch_sibling(root)).expect("clean up the source");
        Connection::open(&dest)
            .and_then(|conn| conn.pragma_update(None, "journal_mode", "DELETE"))
            .expect("leave WAL mode");
        dest
    }

    fn live_database(root: &Path, games: i64) {
        std::fs::copy(database_file(root, games), root.join("data").join(DB_FILE))
            .expect("place the database");
    }

    fn games_in(file: &Path) -> i64 {
        let conn = Connection::open_with_flags(file, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .expect("opens read-only");
        count_games(&conn).expect("count")
    }

    /// The verifier's `create-collide`. Electron renames the new snapshot over
    /// the one already named for this second and reason.
    #[test]
    fn a_backup_never_replaces_one_with_its_name() {
        let root = scratch("create-collide");
        let taken = backup_of(&root, 2, "matches-2026-11-22T21-00-00-manual.db");
        live_database(&root, 5);
        let (db, backups) = open(&root);
        let made = backups
            .create(&db, Reason::Manual, NOW)
            .expect("a manual backup");
        assert_eq!(
            (made.file.as_str(), made.created, made.games),
            ("matches-2026-11-22T21-00-01-manual.db", NOW + 1000, Some(5))
        );
        assert_eq!(games_in(&taken), 2, "the earlier backup is untouched");
        assert_eq!(
            names(&root.join("backups")),
            [
                "matches-2026-11-22T21-00-00-manual.db",
                "matches-2026-11-22T21-00-01-manual.db"
            ]
        );
        drop(db);
        std::fs::remove_dir_all(&root).expect("clean up");
    }

    /// The verifier's `burst20`: twenty manual backups in one frozen second.
    /// Electron renames each over the last, so its one name always holds the
    /// newest snapshot. Each stepped name here must survive its own prune.
    #[test]
    fn a_burst_of_backups_in_one_second_keeps_each_newest() {
        let root = scratch("burst");
        live_database(&root, 5);
        let (db, backups) = open(&root);
        backups
            .create(&db, Reason::Auto, NOW)
            .expect("the launch backup");
        let mut last = String::new();
        for call in 0..20 {
            db.with(|conn| {
                conn.execute(
                    "INSERT INTO games (game_id, queue_id, game_mode, game_creation, game_duration) VALUES (?, 2400, 'KIWI', ?, 1200)",
                    (1000 + call, NOW),
                )
            })
            .expect("a new game");
            let made = backups
                .create(&db, Reason::Manual, NOW)
                .expect("a manual backup");
            let file = root.join("backups").join(&made.file);
            assert!(file.exists(), "call {call}: {} was pruned", made.file);
            assert_eq!(games_in(&file), 6 + call, "call {call} holds its snapshot");
            last = made.file;
        }
        let listed: Vec<String> = backups
            .list()
            .expect("a listing")
            .into_iter()
            .map(|b| b.file)
            .collect();
        assert!(listed.contains(&last), "{last} is not in {listed:?}");
        drop(db);
        std::fs::remove_dir_all(&root).expect("clean up");
    }

    /// The verifier's `restore-collide`. In Electron the pre-restore snapshot
    /// takes the name of the backup being restored, so the player's pick is
    /// gone and the restore brings back the database it was meant to replace.
    #[test]
    fn a_restore_keeps_the_backup_its_snapshot_would_be_named_as() {
        let root = scratch("restore-collide");
        let picked = backup_of(&root, 2, "matches-2026-11-22T21-00-00-pre-restore.db");
        live_database(&root, 5);
        let (db, backups) = open(&root);
        assert_eq!(
            backups.restore(&db, "matches-2026-11-22T21-00-00-pre-restore.db", NOW),
            Ok(2)
        );
        assert_eq!(db.with(count_games).expect("the restored database"), 2);
        assert_eq!(games_in(&picked), 2, "the picked backup is untouched");
        assert_eq!(
            games_in(&root.join("backups/matches-2026-11-22T21-00-01-pre-restore.db")),
            5,
            "the snapshot of what the restore replaced"
        );
        drop(db);
        std::fs::remove_dir_all(&root).expect("clean up");
    }

    /// When clocks fall back, 01:30 comes twice and names the same second.
    /// The second one steps to 01:30:01, which lists just after the first.
    #[test]
    fn a_backup_in_the_repeated_hour_keeps_the_first_one() {
        const FIRST: i64 = 1_793_511_000_000;
        const SECOND: i64 = FIRST + 60 * 60 * 1000;
        let root = scratch("fold");
        let first = backup_of(&root, 2, "matches-2026-11-01T01-30-00-manual.db");
        live_database(&root, 5);
        let (db, backups) = open(&root);
        let made = backups
            .create(&db, Reason::Manual, SECOND)
            .expect("a manual backup");
        assert_eq!(made.file, "matches-2026-11-01T01-30-01-manual.db");
        assert_eq!(games_in(&first), 2, "the first 01:30 is untouched");
        let listed: Vec<(String, i64, Option<i64>)> = backups
            .list()
            .expect("a listing")
            .into_iter()
            .map(|b| (b.file, b.created, b.games))
            .collect();
        assert_eq!(
            listed,
            [
                (made.file.clone(), FIRST + 1000, Some(5)),
                (
                    "matches-2026-11-01T01-30-00-manual.db".to_owned(),
                    FIRST,
                    Some(2)
                ),
            ],
            "both kept, the new one newest"
        );
        drop(db);
        std::fs::remove_dir_all(&root).expect("clean up");
    }

    /// A damaged file set aside in the same second as an earlier one gets the
    /// next second's name rather than replacing it.
    #[test]
    fn a_quarantine_never_replaces_an_earlier_one() {
        let root = scratch("quarantine-collide");
        let earlier = root.join("data/matches.db.corrupt-2026-11-22T21-00-00");
        std::fs::write(&earlier, b"the first damaged file").expect("an earlier quarantine");
        garbage(&root.join("data").join(DB_FILE), "this is not a database ");
        let (db, backups) = open(&root);
        assert_eq!(
            report_json(&backups)["quarantined"],
            "matches.db.corrupt-2026-11-22T21-00-01"
        );
        assert_eq!(
            std::fs::read(&earlier).expect("read it"),
            b"the first damaged file"
        );
        drop(db);
        std::fs::remove_dir_all(&root).expect("clean up");
    }

    /// The verifier's `damage-nocolumn`: a valid file whose schema the
    /// migrations can't bring forward is set aside and the backup restored,
    /// as Electron does. Electron's detail is `no such column: puuid`. T11's
    /// error mapping still appends the statement, which T11's fix round owns.
    #[test]
    fn a_database_its_migrations_reject_is_set_aside_and_restored() {
        let root = scratch("nocolumn");
        let db_file = root.join("data").join(DB_FILE);
        std::fs::copy(database_file(&root, 4), &db_file).expect("place the database");
        Connection::open(&db_file)
            .and_then(|conn| {
                conn.execute_batch(
                    "DROP INDEX idx_games_puuid; ALTER TABLE games DROP COLUMN puuid;",
                )
            })
            .expect("drop a column");
        backup_of(&root, 3, GOOD);
        let (db, backups) = open(&root);
        let mut report = report_json(&backups);
        let detail = report["detail"].take();
        assert_eq!(
            report,
            serde_json::json!({
                "problem": "corrupt",
                "restoredFrom": GOOD,
                "quarantined": "matches.db.corrupt-2026-11-22T21-00-00",
                "detail": null,
            })
        );
        assert!(
            detail
                .as_str()
                .is_some_and(|d| d.starts_with("no such column: puuid")),
            "{detail}"
        );
        assert_eq!(db.with(count_games).expect("the restored database"), 3);
        assert!(
            root.join("data/matches.db.corrupt-2026-11-22T21-00-00")
                .exists()
        );
        drop(db);
        std::fs::remove_dir_all(&root).expect("clean up");
    }

    /// The verifier's `dbdir`. SQLite can't open a directory, and Electron
    /// sets it aside and restores the newest backup, as for a damaged file.
    #[test]
    fn a_directory_at_the_database_is_set_aside_and_restored() {
        let root = scratch("dbdir");
        std::fs::create_dir(root.join("data").join(DB_FILE)).expect("a folder named matches.db");
        backup_of(&root, 3, GOOD);
        let (db, backups) = open(&root);
        assert_eq!(
            report_json(&backups),
            serde_json::json!({
                "problem": "corrupt",
                "restoredFrom": GOOD,
                "quarantined": "matches.db.corrupt-2026-11-22T21-00-00",
                "detail": "unable to open database file",
            })
        );
        assert_eq!(db.with(count_games).expect("the restored database"), 3);
        assert!(
            root.join("data/matches.db.corrupt-2026-11-22T21-00-00")
                .is_dir()
        );
        drop(db);
        std::fs::remove_dir_all(&root).expect("clean up");
    }

    /// An open that fails with anything but SQLite's own error, such as a
    /// value of the wrong type, says nothing about the file, so the database
    /// is left as it is rather than replaced by an older snapshot.
    #[test]
    fn an_error_sqlite_did_not_raise_leaves_the_database_alone() {
        let not_sqlite = [
            rusqlite::Error::InvalidColumnType(0, "value".into(), rusqlite::types::Type::Blob),
            rusqlite::Error::QueryReturnedNoRows,
            rusqlite::Error::InvalidQuery,
        ];
        for err in &not_sqlite {
            assert!(
                matches!(OpenFailure::of(err), OpenFailure::Unavailable(_)),
                "{err} read as Lost"
            );
        }
        let corrupt = rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CORRUPT),
            None,
        );
        assert!(matches!(OpenFailure::of(&corrupt), OpenFailure::Lost(_)));
        let no_column = Connection::open_in_memory()
            .and_then(|conn| conn.prepare("SELECT puuid FROM sqlite_master").map(drop))
            .expect_err("no such column");
        assert!(matches!(OpenFailure::of(&no_column), OpenFailure::Lost(_)));
    }

    /// Node's recursive mkdir reports the stat after a failed mkdir, so a
    /// backups folder that is a dangling link reads ENOENT, not EEXIST.
    #[cfg(unix)]
    #[test]
    fn a_backups_folder_behind_a_dangling_link_fails_as_node_does() {
        let root = scratch("dangling");
        let dir = root.join("backups-link");
        std::os::unix::fs::symlink(root.join("nowhere"), &dir).expect("a dangling link");
        let (db, backups) = open_with_recovery(
            &root.join("data"),
            Backups::new(dir.clone(), new_york()),
            NOW,
        )
        .expect("a first launch");
        assert_eq!(
            backups.list().map(|_| ()),
            Err(format!(
                "ENOENT: no such file or directory, mkdir '{}'",
                dir.display()
            ))
        );
        drop(db);
        std::fs::remove_dir_all(&root).expect("clean up");
    }

    /// The swap's `-wal` and `-shm` removal fails with `fs.rmSync`'s text,
    /// measured in Node 26.8.1, which Electron 44's Node 24.21.0 shares.
    #[test]
    fn a_wal_that_cannot_be_removed_fails_as_rm_sync_does() {
        let root = scratch("rm-wal");
        let source = database_file(&root, 2);
        let db_file = root.join("data").join(DB_FILE);
        std::fs::copy(&source, &db_file).expect("place the database");
        let wal = suffixed(&db_file, "-wal");
        std::fs::create_dir(&wal).expect("a folder where the -wal goes");
        assert_eq!(
            swap_in(&source, &db_file),
            Err(format!(
                "Path is a directory: rm returned EISDIR (is a directory) {}",
                wal.display()
            ))
        );
        assert!(!suffixed(&db_file, ".incoming").exists());
        std::fs::remove_dir(&wal).expect("clear the folder");

        #[cfg(target_os = "macos")]
        {
            let chflags = |flag: &str| {
                let status = std::process::Command::new("chflags")
                    .arg(flag)
                    .arg(&wal)
                    .status();
                assert!(status.expect("chflags runs").success());
            };
            std::fs::write(&wal, b"").expect("a -wal");
            chflags("uchg");
            let swapped = swap_in(&source, &db_file);
            chflags("nouchg");
            assert_eq!(
                swapped,
                Err(format!(
                    "EPERM, Operation not permitted: {0} '{0}'",
                    wal.display()
                ))
            );
        }
        std::fs::remove_dir_all(&root).expect("clean up");
    }

    /// Every errno Node names has its name and message, not only the few the
    /// backup code has hit.
    #[test]
    fn file_errors_carry_every_name_node_has() {
        let path = Path::new("/x");
        let text = |raw: i32| node_fs_error(&io::Error::from_raw_os_error(raw), "open", path, None);
        #[cfg(target_os = "macos")]
        {
            assert_eq!(
                text(35),
                "EAGAIN: resource temporarily unavailable, open '/x'"
            );
            assert_eq!(text(57), "ENOTCONN: socket is not connected, open '/x'");
            assert_eq!(text(100), "EPROTO: protocol error, open '/x'");
        }
        #[cfg(windows)]
        {
            assert_eq!(
                text(1),
                "EISDIR: illegal operation on a directory, open '/x'"
            );
            assert_eq!(text(1113), "ECHARSET: invalid Unicode character, open '/x'");
            assert_eq!(text(1920), "EACCES: permission denied, open '/x'");
        }
        assert_eq!(text(99_999), "UNKNOWN: unknown error, open '/x'");
    }

    #[cfg(unix)]
    #[test]
    fn removals_fail_as_rm_sync_does() {
        use std::os::unix::fs::PermissionsExt;
        let root = scratch("rm");
        let (file, locked) = (root.join("file"), root.join("locked"));
        std::fs::write(&file, b"x").expect("a file");
        std::fs::create_dir(&locked).expect("make locked/");
        std::fs::write(locked.join("inner"), b"x").expect("a file inside");
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o555)).expect("lock it");
        let inner = locked.join("inner");
        assert_eq!(rm_forced(&root.join("gone")), Ok(()));
        assert_eq!(
            rm_forced(&file.join("x")),
            Err(format!(
                "ENOTDIR: not a directory, lstat '{}'",
                file.join("x").display()
            ))
        );
        assert_eq!(
            rm_forced(&inner),
            Err(format!(
                "EACCES, Permission denied: {0} '{0}'",
                inner.display()
            ))
        );
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755))
            .expect("unlock it");
        std::fs::remove_dir_all(&root).expect("clean up");
    }

    /// Each failing call in `BMT_T17_ERR_OPS` (`[op, a, b?]`, with `{B}`,
    /// `{VOL}` and `{RO}` standing for the folders those variables name) run
    /// through the code that formats its error, written to `BMT_T17_ERR_OUT`
    /// in the shape of the Node probe's output so the two diff line by line.
    #[test]
    #[ignore = "needs prepared folders; run with BMT_T17_ERR_OPS, BMT_T17_ERR_OUT, B, VOL and RO"]
    fn node_error_text_on_real_failures() {
        use serde_json::{Value, json};
        let var = |name: &str| std::env::var(name).expect(name);
        let (b, vol, ro) = (var("B"), var("VOL"), var("RO"));
        let sub = |p: &str| {
            p.replace("{B}", &b)
                .replace("{VOL}", &vol)
                .replace("{RO}", &ro)
        };
        let back = |p: String| {
            p.replace(&b, "{B}")
                .replace(&vol, "{VOL}")
                .replace(&ro, "{RO}")
        };
        let ops: Vec<Vec<Value>> =
            serde_json::from_str(&std::fs::read_to_string(var("BMT_T17_ERR_OPS")).expect("ops"))
                .expect("a list of ops");
        let mut results = Vec::new();
        for op in ops {
            let name = op[0].as_str().expect("an op");
            let a = PathBuf::from(sub(op[1].as_str().expect("a path")));
            let b_path = op
                .get(2)
                .and_then(Value::as_str)
                .map(|p| PathBuf::from(sub(p)));
            let dest = b_path.as_deref();
            let outcome: Result<(), String> = match name {
                "copyfile" => std::fs::copy(&a, dest.expect("a destination"))
                    .map(drop)
                    .map_err(|err| node_fs_error(&err, name, &a, dest)),
                "rename" => std::fs::rename(&a, dest.expect("a destination"))
                    .map_err(|err| node_fs_error(&err, name, &a, dest)),
                "stat" => std::fs::metadata(&a)
                    .map(drop)
                    .map_err(|err| node_fs_error(&err, name, &a, None)),
                "scandir" => std::fs::read_dir(&a)
                    .map(drop)
                    .map_err(|err| node_fs_error(&err, name, &a, None)),
                "mkdir" => mkdirp(&a).map_err(|code| node_error(code, name, &a, None)),
                "rm" => rm_forced(&a),
                other => panic!("unknown op {other}"),
            };
            results.push(json!({
                "op": name,
                "a": op[1],
                "b": op.get(2).cloned().unwrap_or(Value::Null),
                "message": back(outcome.err().unwrap_or_else(|| "ok".into())),
            }));
        }
        std::fs::write(
            var("BMT_T17_ERR_OUT"),
            serde_json::to_string_pretty(&json!({ "results": results })).expect("JSON") + "\n",
        )
        .expect("write the results");
    }

    /// `new Date(iso).getTime()` in Node with `TZ=America/New_York`, for
    /// every edge the verifier tried, the years past jiff's range included.
    #[test]
    fn stamps_parse_as_v8_does() {
        let v8: [(&str, i64); 49] = [
            ("2026-03-08T02-30-00", 1772955000000),
            ("2026-03-08T02-00-00", 1772953200000),
            ("2026-03-08T01-59-59", 1772953199000),
            ("2026-03-08T03-00-00", 1772953200000),
            ("2026-11-01T01-00-00", 1793509200000),
            ("2026-11-01T01-59-59", 1793512799000),
            ("2026-11-01T02-00-00", 1793516400000),
            ("2026-11-01T00-59-59", 1793509199000),
            ("2026-02-29T10-00-00", 1772377200000),
            ("2028-02-29T10-00-00", 1835449200000),
            ("2028-02-30T10-00-00", 1835535600000),
            ("2026-04-31T10-00-00", 1777644000000),
            ("2026-02-31T23-59-59", 1772600399000),
            ("2026-02-32T10-00-00", 0),
            ("2026-00-10T10-00-00", 0),
            ("2026-12-32T10-00-00", 0),
            ("2026-12-00T10-00-00", 0),
            ("2026-12-31T24-00-00", 1798779600000),
            ("2026-03-07T24-00-00", 1772946000000),
            ("2026-02-31T24-00-00", 1772600400000),
            ("2026-11-22T24-00-01", 0),
            ("2026-11-22T24-01-00", 0),
            ("2026-11-22T25-00-00", 0),
            ("2026-11-22T23-60-00", 0),
            ("2026-11-22T23-59-60", 0),
            ("2026-11-22T99-99-99", 0),
            ("0000-01-01T00-00-00", -62167201438000),
            ("0001-01-01T00-00-00", -62135579038000),
            ("1883-11-18T12-03-57", -2717650801000),
            ("1883-11-18T11-59-59", -2717651039000),
            ("1883-11-18T12-00-00", -2717651038000),
            ("1900-01-01T00-00-00", -2208970800000),
            ("1969-12-31T19-00-00", 0),
            ("1970-01-01T00-00-00", 18000000),
            ("9999-12-31T23-59-59", 253402318799000),
            ("2038-01-19T03-14-08", 2147501648000),
            ("2100-03-14T02-30-00", 4108692600000),
            ("2027-01-01T00-00-00", 1798779600000),
            ("2099-06-01T12-00-00", 4084012800000),
            ("2026-11-22T21-00-00", 1795399200000),
            ("2026-11-22T21-00-01", 1795399201000),
            ("2026-11-21T21-00-00", 1795312800000),
            ("2026-11-21T20-59-59", 1795312799000),
            ("0099-12-31T23-59-59", -59011441439000),
            ("0049-12-31T23-59-59", -60589278239000),
            ("1582-10-10T00-00-00", -12219707038000),
            ("0000-02-30T00-00-00", -62162017438000),
            ("9999-12-31T24-00-00", 253402318800000),
            ("9999-12-32T00-00-00", 0),
        ];
        for (text, ms) in v8 {
            assert_eq!(parse_stamp(text, &new_york()), ms, "{text}");
        }
        assert_eq!(local(253_402_318_799_000, &new_york()).1, 9999);
        assert_eq!(local(253_402_318_800_000, &new_york()).1, 10000);
    }

    /// The verifier's scenarios (`spec.json`, run on Electron by
    /// `v-probe.ts`) on copies of the T05 fixture, written in the probe's JSON
    /// so `vdiff.py` compares the two. `BMT_T17_FIXTURE` names the fixture's
    /// `matches.db`; `BMT_T17_OUT` holds `spec.json` and `foreign-for-rust.db`,
    /// a backup Electron took, and gets `rust-runs/` and `rust.json`. The
    /// hostile ones hold the file with `/usr/bin/sqlite3`.
    #[test]
    #[ignore = "needs the T05 fixture; run with BMT_T17_FIXTURE and BMT_T17_OUT"]
    fn electron_scenarios_on_the_fixture() {
        use serde_json::{Value, json};
        use std::process::{Child, Command, Stdio};
        let env = |name: &str| PathBuf::from(std::env::var_os(name).expect(name));
        let (fixture, out) = (env("BMT_T17_FIXTURE"), env("BMT_T17_OUT"));
        let spec: Vec<Value> = serde_json::from_str(
            &std::fs::read_to_string(out.join("spec.json")).expect("spec.json"),
        )
        .expect("a list of scenarios");
        let only: Option<Vec<String>> = std::env::var("BMT_T17_ONLY")
            .ok()
            .map(|s| s.split(',').map(str::to_owned).collect());
        let chmod = |args: &[&str], path: &Path| {
            let status = Command::new("chmod").args(args).arg(path).status();
            assert!(status.expect("chmod runs").success());
        };
        let inspect = |file: &Path| -> Value {
            let tmp = out.join(format!("inspect-{}", std::process::id()));
            std::fs::create_dir_all(&tmp).expect("inspect/");
            let copied = std::fs::copy(file, tmp.join("x.db")).and_then(|_| {
                let wal = suffixed(file, "-wal");
                if wal.exists() {
                    std::fs::copy(&wal, tmp.join("x.db-wal"))?;
                }
                Ok(())
            });
            let result = copied.map_err(|err| err.to_string()).and_then(|()| {
                let c = Connection::open(tmp.join("x.db")).map_err(|err| err.to_string())?;
                let read = || -> rusqlite::Result<Value> {
                    let games = count_games(&c)?;
                    let marker: Option<String> = c
                        .query_row(
                            "SELECT value FROM settings WHERE key = 'v_marker'",
                            [],
                            |r| r.get(0),
                        )
                        .ok();
                    let integrity: String =
                        c.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
                    Ok(json!({ "games": games, "marker": marker, "integrity": integrity }))
                };
                read().map_err(|err| err.to_string())
            });
            std::fs::remove_dir_all(&tmp).expect("clean inspect/");
            result.unwrap_or_else(|error| json!({ "error": error }))
        };
        let holder = |db: &Path, script: &str, ready: &dyn Fn() -> bool| -> Child {
            use std::io::Write;
            let mut child = Command::new("/usr/bin/sqlite3")
                .arg(db)
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .expect("sqlite3 starts");
            let stdin = child.stdin.as_mut().expect("its stdin");
            stdin.write_all(script.as_bytes()).expect("send the script");
            let start = std::time::Instant::now();
            while !ready() {
                assert!(
                    start.elapsed() < Duration::from_secs(10),
                    "holder never ready"
                );
                std::thread::sleep(Duration::from_millis(50));
            }
            child
        };
        let mut results = serde_json::Map::new();
        for sc in spec {
            let name = sc["name"].as_str().expect("a name").to_owned();
            if only.as_ref().is_some_and(|o| !o.contains(&name)) {
                continue;
            }
            let root = out.join("rust-runs").join(&name);
            if root.exists() {
                chmod(&["-R", "u+w"], &root);
                std::fs::remove_dir_all(&root).expect("clear the run");
            }
            std::fs::create_dir_all(root.join("data")).expect("data/");
            std::fs::create_dir_all(root.join("backups")).expect("backups/");
            let db_file = root.join("data").join(DB_FILE);
            std::fs::copy(&fixture, &db_file).expect("copy the fixture");
            if sc["autoBackupOff"].as_bool() == Some(true) {
                let conn = Connection::open(&db_file).expect("open the copy");
                settings::set_setting(&conn, "auto_backup", "false").expect("turn it off");
            }
            for (file, kind) in sc["backups"].as_object().into_iter().flatten() {
                let dest = root.join("backups").join(file);
                match kind.as_str().expect("a kind") {
                    "good" => drop(std::fs::copy(&fixture, &dest).expect("a good backup")),
                    "foreign" => drop(
                        std::fs::copy(out.join("foreign-for-rust.db"), &dest)
                            .expect("the other app's backup"),
                    ),
                    "garbage" => garbage(&dest, "garbage "),
                    "small" => {
                        std::fs::copy(out.join("small.db"), &dest).expect("a small backup");
                    }
                    "dir" => std::fs::create_dir(&dest).expect("a folder"),
                    _ => std::fs::write(&dest, b"").expect("an empty backup"),
                }
            }
            if name.starts_with("prune") {
                std::fs::write(root.join("backups/notes.txt"), b"").expect("a stray file");
            }
            let locked = || {
                let o = Command::new("/usr/bin/sqlite3")
                    .arg(&db_file)
                    .arg("SELECT 1 FROM games LIMIT 1")
                    .output()
                    .expect("sqlite3 runs");
                !o.status.success() && String::from_utf8_lossy(&o.stderr).contains("locked")
            };
            let wal_grown =
                || std::fs::metadata(suffixed(&db_file, "-wal")).is_ok_and(|m| m.len() > 0);
            let before = std::fs::read(&db_file).ok();
            let mut held = None;
            match sc["damage"].as_str().unwrap_or("") {
                "missing" => std::fs::remove_file(&db_file).expect("delete the database"),
                "garbage" => garbage(&db_file, "this is not a database "),
                "pages" => {
                    use std::io::{Seek, SeekFrom, Write};
                    let mut f = std::fs::OpenOptions::new()
                        .write(true)
                        .open(&db_file)
                        .expect("open");
                    f.seek(SeekFrom::Start(4096 * 700)).expect("seek");
                    f.write_all(&[0xa5; 4096 * 4]).expect("damage pages");
                }
                "lock" => {
                    held = Some(holder(
                        &db_file,
                        "PRAGMA locking_mode=EXCLUSIVE;\nBEGIN EXCLUSIVE;\nSELECT count(*) FROM games;\n",
                        &locked,
                    ))
                }
                damage @ ("walheld" | "walorphan") => {
                    let mut child = holder(
                        &db_file,
                        "PRAGMA journal_mode=WAL;\nPRAGMA wal_autocheckpoint=0;\nINSERT OR REPLACE INTO settings (key, value) VALUES ('v_marker', 'in-wal');\n",
                        &wal_grown,
                    );
                    if damage == "walorphan" {
                        child.kill().expect("kill the holder");
                        child.wait().expect("reap the holder");
                    } else {
                        held = Some(child);
                    }
                }
                "half" => {
                    let f = std::fs::OpenOptions::new()
                        .write(true)
                        .open(&db_file)
                        .expect("open");
                    let len = f.metadata().expect("its size").len();
                    f.set_len(len / 2).expect("truncate");
                }
                "header" => {
                    use std::io::{Seek, SeekFrom, Write};
                    let mut f = std::fs::OpenOptions::new()
                        .write(true)
                        .open(&db_file)
                        .expect("open");
                    f.seek(SeekFrom::Start(16)).expect("seek");
                    f.write_all(&[0xff; 8]).expect("damage the header");
                }
                damage @ ("notable" | "nocolumn" | "blobsetting") => {
                    let sql = match damage {
                        "notable" => "DROP TABLE games;",
                        "nocolumn" => {
                            "DROP INDEX idx_games_puuid; ALTER TABLE games DROP COLUMN puuid;"
                        }
                        _ => {
                            "UPDATE settings SET value = CAST(value AS BLOB) WHERE key='augment_slots';"
                        }
                    };
                    let o = Command::new("/usr/bin/sqlite3")
                        .arg(&db_file)
                        .arg(sql)
                        .output()
                        .expect("sqlite3 runs");
                    assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
                }
                "dbdir" => {
                    std::fs::remove_file(&db_file).expect("remove the database");
                    std::fs::create_dir(&db_file).expect("a folder at matches.db");
                }
                "rodir" => chmod(&["555"], &root.join("data")),
                "rofile" => chmod(&["444"], &db_file),
                _ => {}
            }
            let opened = open_with_recovery(
                &root.join("data"),
                Backups::new(root.join("backups"), new_york()),
                NOW,
            );
            let mut entry = serde_json::Map::new();
            match opened {
                Err(error) => {
                    entry.insert("openError".into(), json!(error));
                }
                Ok((db, backups)) => {
                    launch_tick(&backups, &db);
                    let list = |b: &Backups| serde_json::to_value(b.list().expect("a listing"));
                    entry.insert("report".into(), report_json(&backups));
                    entry.insert("listAtStart".into(), list(&backups).expect("JSON"));
                    let mut calls = Vec::new();
                    let restore = |file: &str| match backups.restore(&db, file, NOW) {
                        Ok(games) => json!({ "success": true, "games": games }),
                        Err(error) => json!({ "success": false, "error": error }),
                    };
                    let create = || match backups.create(&db, Reason::Manual, NOW) {
                        Ok(backup) => json!({ "success": true, "backup": backup }),
                        Err(error) => json!({ "success": false, "error": error }),
                    };
                    for call in sc["calls"].as_array().expect("calls") {
                        let method = call[0].as_str().expect("a method");
                        let file = call.get(1).and_then(Value::as_str).unwrap_or("");
                        // The probe's two calls a few milliseconds apart
                        let result = if method == "parallel" || method == "parallelCreateFirst" {
                            let create_first = method == "parallelCreateFirst";
                            let one = |first: bool| {
                                if first == create_first {
                                    create()
                                } else {
                                    restore(file)
                                }
                            };
                            std::thread::scope(|s| {
                                let first = s.spawn(|| one(true));
                                std::thread::sleep(Duration::from_millis(5));
                                let second = s.spawn(|| one(false));
                                json!([
                                    first.join().expect("first"),
                                    second.join().expect("second")
                                ])
                            })
                        } else if method == "restoreBackup" {
                            restore(file)
                        } else {
                            create()
                        };
                        let args = call.as_array().expect("a call")[1..].to_vec();
                        calls.push(json!({ "method": method, "args": args, "result": result }));
                    }
                    entry.insert("calls".into(), json!(calls));
                    entry.insert("listAtEnd".into(), list(&backups).expect("JSON"));
                    entry.insert("dataDir".into(), json!(names(&root.join("data"))));
                    entry.insert("backupsDir".into(), json!(names(&root.join("backups"))));
                }
            }
            if let Some(mut child) = held {
                child.kill().expect("kill the holder");
                child.wait().expect("reap the holder");
            }
            chmod(&["-R", "u+w"], &root);
            let after = std::fs::read(&db_file).ok();
            entry.insert(
                "dbFileUnchanged".into(),
                json!(before.is_some() && before == after),
            );
            let mut post = serde_json::Map::new();
            for f in names(&root.join("data")) {
                if f == DB_FILE || f.starts_with("matches.db.corrupt-") {
                    post.insert(format!("data/{f}"), inspect(&root.join("data").join(&f)));
                }
            }
            for f in names(&root.join("backups")) {
                let path = root.join("backups").join(&f);
                if f.ends_with(".db")
                    && std::fs::metadata(&path).is_ok_and(|m| m.is_file() && m.len() > 0)
                {
                    post.insert(format!("backups/{f}"), inspect(&path));
                }
            }
            entry.insert("post".into(), Value::Object(post));
            entry.insert("dataDirAfter".into(), json!(names(&root.join("data"))));
            results.insert(name, Value::Object(entry));
        }
        std::fs::write(
            out.join("rust.json"),
            serde_json::to_string_pretty(&Value::Object(results)).expect("JSON") + "\n",
        )
        .expect("write rust.json");
    }

    /// The verifier's full disk, on a small volume `BMT_T17_MNT` names, with
    /// the fixture `BMT_T17_FIXTURE` names. A backup that runs out of room
    /// leaves nothing behind, a restore that does fails with Node's text and
    /// keeps the database open, and a launch with 16 KB free leaves the
    /// healthy database untouched. Steps go to `BMT_T17_OUT/rust-full.json`.
    #[test]
    #[ignore = "needs a small volume; run with BMT_T17_MNT, BMT_T17_FIXTURE and BMT_T17_OUT"]
    fn on_a_full_disk() {
        use serde_json::{Value, json};
        use std::io::Write;
        let env = |name: &str| PathBuf::from(std::env::var_os(name).expect(name));
        let (fixture, out) = (env("BMT_T17_FIXTURE"), env("BMT_T17_OUT"));
        let root = env("BMT_T17_MNT").join("rust-full");
        let avail = |dir: &Path| -> u64 {
            let out = std::process::Command::new("df").arg("-k").arg(dir).output();
            let text = String::from_utf8(out.expect("df runs").stdout).expect("UTF-8");
            let line = text.lines().nth(1).expect("a volume line");
            let kib: u64 = line
                .split_whitespace()
                .nth(3)
                .expect("avail")
                .parse()
                .expect("a number");
            kib * 1024
        };
        let fill = |leave: u64| {
            let mut f = std::fs::File::create(root.join("filler")).expect("the filler");
            let chunk = vec![0u8; 64 * 1024];
            loop {
                let left = avail(&root);
                if left <= leave {
                    break;
                }
                let n = ((left - leave) as usize).min(chunk.len());
                if f.write_all(&chunk[..n]).is_err() {
                    break;
                }
                f.sync_all().expect("sync the filler");
            }
        };
        if root.exists() {
            std::fs::remove_dir_all(&root).expect("clear the run");
        }
        std::fs::create_dir_all(root.join("data")).expect("data/");
        std::fs::create_dir_all(root.join("backups")).expect("backups/");
        let db_file = root.join("data").join(DB_FILE);
        std::fs::copy(&fixture, &db_file).expect("copy the fixture");
        std::fs::copy(&fixture, root.join("backups").join(GOOD)).expect("a good backup");
        let mut steps = Vec::new();
        {
            let (db, backups) = open(&root);
            fill(1 << 20);
            steps.push(json!({ "step": "filled", "avail": avail(&root) }));

            let created = backups.create(&db, Reason::Manual, NOW).map(|b| b.file);
            steps.push(json!({ "step": "createBackup", "result": format!("{created:?}"), "backups": names(&root.join("backups")) }));
            assert_eq!(created, Err("database or disk is full".into()));
            assert_eq!(
                names(&root.join("backups")),
                [GOOD],
                "no .part or .part-journal"
            );

            let restored = backups.restore(&db, GOOD, NOW + 1000);
            steps.push(json!({ "step": "restoreBackup", "result": format!("{restored:?}"), "data": names(&root.join("data")) }));
            assert_eq!(
                restored,
                Err(format!(
                    "ENOSPC: no space left on device, copyfile '{}' -> '{}'",
                    root.join("backups").join(GOOD).display(),
                    suffixed(&db_file, ".incoming").display()
                ))
            );
            assert!(!suffixed(&db_file, ".incoming").exists(), "no partial copy");
            assert_eq!(db.with(count_games).expect("still open"), 669);

            std::fs::remove_file(root.join("filler")).expect("free the disk");
            let again = backups.restore(&db, GOOD, NOW + 3000);
            steps.push(json!({ "step": "restoreAfterFree", "result": format!("{again:?}"), "data": names(&root.join("data")), "backups": names(&root.join("backups")) }));
            assert_eq!(again, Ok(669));
            assert!(root.join("backups").join(GOOD).exists());
        }
        for f in names(&root.join("data")) {
            if f != DB_FILE {
                std::fs::remove_file(root.join("data").join(f)).expect("clear data/");
            }
        }
        let before = std::fs::read(&db_file).expect("read the database");
        fill(16 * 1024);
        steps.push(json!({ "step": "filled-for-launch", "avail": avail(&root) }));
        let launched = open_with_recovery(
            &root.join("data"),
            Backups::new(root.join("backups"), new_york()),
            NOW + 4000,
        )
        .map(|_| ());
        let unchanged = std::fs::read(&db_file).expect("read it again") == before;
        steps.push(json!({ "step": "launch", "result": format!("{launched:?}"), "data": names(&root.join("data")), "dbFileUnchanged": unchanged }));
        std::fs::remove_file(root.join("filler")).expect("free the disk");
        std::fs::write(
            out.join("rust-full.json"),
            serde_json::to_string_pretty(&Value::Array(steps)).expect("JSON") + "\n",
        )
        .expect("write rust-full.json");
        assert!(launched.is_err(), "a full disk is an open error");
        assert!(unchanged, "the healthy database is left as it was");
        // SQLite's own -wal and -shm from the open it tried may sit beside it
        assert!(
            names(&root.join("data"))
                .iter()
                .all(|name| name == DB_FILE || name.ends_with("-wal") || name.ends_with("-shm")),
            "nothing set aside or half copied"
        );
    }
}
