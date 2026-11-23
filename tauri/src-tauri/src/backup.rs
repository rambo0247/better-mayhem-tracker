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

    /// `getBackupDir`, which makes the folder on every use.
    pub fn dir(&self) -> &Path {
        if let Err(err) = std::fs::create_dir_all(&self.dir) {
            eprintln!("Failed to create backup directory: {err}");
        }
        &self.dir
    }

    fn hold(&self) -> Held<'_> {
        self.run
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// `listBackups`: newest first, each with its game count, or none when the
    /// snapshot cannot be read. A damaged one still belongs in the list.
    pub fn list(&self) -> Vec<BackupInfo> {
        let _held = self.hold();
        let dir = self.dir().to_path_buf();
        self.read()
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
            .collect()
    }

    /// `createBackup`, queued behind any backup already running.
    pub fn create(&self, db: &Database, reason: Reason, now_ms: i64) -> Result<BackupInfo, String> {
        let held = self.hold();
        self.run_backup(&held, db, reason, now_ms)
    }

    /// `backupQuietly`: a failed snapshot is logged and never aborts the work
    /// it was protecting. Skipped when the player turned automatic backups off.
    pub fn backup_quietly(&self, db: &Database, reason: Reason, now_ms: i64) {
        let held = self.hold();
        self.quietly(&held, db, reason, now_ms);
    }

    fn quietly(&self, held: &Held<'_>, db: &Database, reason: Reason, now_ms: i64) {
        if auto_backup_off(db) {
            return;
        }
        match self.run_backup(held, db, reason, now_ms) {
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
    ) -> Result<BackupInfo, String> {
        let file = format!("matches-{}-{}.db", stamp(now_ms, &self.tz), reason.as_str());
        let dest = self.dir().join(&file);
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
            std::fs::rename(&partial, &dest).map_err(|err| err.to_string())?;
            let size = std::fs::metadata(&dest)
                .map_err(|err| err.to_string())?
                .len() as i64;
            // Only once the new snapshot is verified on disk: a database that
            // has gone bad must never rotate out the good copies
            self.prune(&self.read());
            Ok(BackupInfo {
                file: file.clone(),
                created: now_ms,
                size,
                games: Some(games),
                reason: reason.as_str().into(),
            })
        };
        attempt().inspect_err(|_| {
            for leftover in [
                partial.clone(),
                suffixed(&partial, "-wal"),
                suffixed(&partial, "-shm"),
            ] {
                remove_if_present(&leftover);
            }
        })
    }

    /// `readBackups`: every file named as a backup, newest first. Names carry
    /// the time, so this never trusts mtimes a copy or sync client rewrites.
    fn read(&self) -> Vec<BackupInfo> {
        let dir = self.dir();
        let entries = match std::fs::read_dir(dir) {
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
                let size = std::fs::metadata(dir.join(&file)).ok()?.len() as i64;
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
    /// each of the last few weeks and months. Everything else goes.
    fn prune(&self, backups: &[BackupInfo]) {
        let dir = self.dir();
        for file in prune_victims(backups, &self.tz) {
            if let Err(err) = remove_file_forced(&dir.join(file)) {
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
            self.quietly(held, db, Reason::Auto, now_ms);
        }
    }

    /// `restoreBackup`: puts a snapshot in place of the live database, after
    /// taking a `pre-restore` snapshot so a mistaken restore can be undone.
    pub fn restore(&self, db: &Database, file: &str, now_ms: i64) -> Result<i64, String> {
        let held = self.hold();
        let source = self.resolve(file)?;
        // Checked again now, not trusted from when it was written
        let games = verify_snapshot(&source)?;
        self.quietly(&held, db, Reason::PreRestore, now_ms);
        db.close();
        swap_in(&source, db.path()).map_err(|err| err.to_string())?;
        db.reopen(now_ms)
            .map_err(|err| db::sqlite_error(&err).message)?;
        Ok(games)
    }

    /// Only a bare name this module would have written, inside the backups
    /// folder: the name comes from the page.
    fn resolve(&self, file: &str) -> Result<PathBuf, String> {
        if parse_name(file).is_none() {
            return Err("Not a backup file name".into());
        }
        let full = self.dir().join(file);
        if !full.exists() {
            return Err("That backup no longer exists".into());
        }
        Ok(full)
    }

    /// Newest first, verifying as it goes: the newest snapshot is worth
    /// nothing if it can't be opened, and the one before it usually can.
    fn newest_usable(&self) -> Option<PathBuf> {
        let dir = self.dir().to_path_buf();
        self.read().into_iter().find_map(|backup| {
            let full = dir.join(&backup.file);
            match verify_snapshot(&full) {
                Ok(_) => Some(full),
                Err(err) => {
                    eprintln!("Skipping unusable backup: {} {err}", backup.file);
                    None
                }
            }
        })
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
/// file is gone or will not open, brings back the newest good snapshot from
/// `backup_dir` before anything reads it.
pub fn init_database_with_recovery(
    data_dir: &Path,
    backup_dir: PathBuf,
    now_ms: i64,
) -> rusqlite::Result<(Database, Backups)> {
    open_with_recovery(
        data_dir,
        Backups::new(backup_dir, TimeZone::system()),
        now_ms,
    )
}

fn open_with_recovery(
    data_dir: &Path,
    mut backups: Backups,
    now_ms: i64,
) -> rusqlite::Result<(Database, Backups)> {
    let db_path = data_dir.join(DB_FILE);
    let missing = !db_path.exists();

    // Damage can surface on open or in the statements migrations run, so the
    // check and the open share one failure path
    let opened = Database::open(data_dir, now_ms)
        .map_err(|err| db::sqlite_error(&err).message)
        .and_then(|database| {
            if !missing {
                quick_check(&database)?;
            }
            Ok(database)
        });
    let database = match opened {
        Ok(database) => database,
        Err(detail) => {
            eprintln!("Database failed to open: {detail}");
            let (database, report) = recover(
                &backups,
                data_dir,
                RecoveryProblem::Corrupt,
                Some(detail),
                now_ms,
            )?;
            backups.report = Some(report);
            return Ok((database, backups));
        }
    };

    // Opened cleanly but was not there a moment ago. With snapshots on disk
    // that means the file was deleted, and starting empty would look like loss
    if missing && !backups.read().is_empty() {
        drop(database);
        let (database, report) =
            recover(&backups, data_dir, RecoveryProblem::Missing, None, now_ms)?;
        backups.report = Some(report);
        return Ok((database, backups));
    }
    Ok((database, backups))
}

fn quick_check(database: &Database) -> Result<(), String> {
    let result = database
        .with(first_quick_check_row)
        .map_err(|err| err.message)?;
    match result.as_deref() {
        Some("ok") => Ok(()),
        Some(problem) => Err(problem.to_owned()),
        None => Err("integrity check failed".into()),
    }
}

/// `recover`. The database must already be closed.
fn recover(
    backups: &Backups,
    data_dir: &Path,
    problem: RecoveryProblem,
    detail: Option<String>,
    now_ms: i64,
) -> rusqlite::Result<(Database, RecoveryReport)> {
    let db_path = data_dir.join(DB_FILE);
    // On the missing path this is the empty database the open just made,
    // still worth setting aside rather than overwriting blind
    let quarantined = if db_path.exists() {
        quarantine(&db_path, &stamp(now_ms, &backups.tz))
    } else {
        None
    };

    let mut source = backups.newest_usable();
    if let Some(from) = &source
        && let Err(err) = swap_in(from, &db_path)
    {
        // Out of disk, or the file vanished between the check and the copy.
        // An empty database the player can use beats a window that never opens
        eprintln!("Failed to restore from backup: {err}");
        source = None;
    }
    let database = Database::open(data_dir, now_ms)?;

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
fn quarantine(db_path: &Path, stamp: &str) -> Option<PathBuf> {
    let dead = suffixed(db_path, &format!(".corrupt-{stamp}"));
    let moved = std::fs::rename(db_path, &dead)
        .and_then(|()| remove_file_forced(&suffixed(db_path, "-wal")))
        .and_then(|()| remove_file_forced(&suffixed(db_path, "-shm")));
    match moved {
        Ok(()) => Some(dead),
        Err(err) => {
            eprintln!("Failed to set aside the damaged database: {err}");
            None
        }
    }
}

/// Puts a database file in place of the live one, which must be closed.
fn swap_in(source: &Path, db_path: &Path) -> io::Result<()> {
    // The -wal and -shm describe the database being replaced. Left behind,
    // SQLite would replay them onto the restored file and corrupt it
    remove_file_forced(&suffixed(db_path, "-wal"))?;
    remove_file_forced(&suffixed(db_path, "-shm"))?;
    // Copy then rename: a copy that fails half way must not leave a
    // truncated database where the live one was
    let incoming = suffixed(db_path, ".incoming");
    std::fs::copy(source, &incoming)?;
    std::fs::rename(&incoming, db_path)
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
        Ok(value) => value.as_deref() == Some("false"),
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
    local(ms, tz).strftime("%Y-%m-%dT%H-%M-%S").to_string()
}

fn local(ms: i64, tz: &TimeZone) -> DateTime {
    Timestamp::from_millisecond(ms)
        .unwrap_or(Timestamp::UNIX_EPOCH)
        .to_zoned_datetime(tz.clone())
        .datetime()
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
    let resolved = Date::new(year as i16, month as i8, 1)
        .and_then(|first| first.checked_add((day - 1 + hour / 24).days()))
        .and_then(|date| {
            date.at((hour % 24) as i8, minute as i8, second as i8, 0)
                .to_zoned_datetime(tz.clone())
        });
    resolved.map_or(0, |zoned| zoned.timestamp().as_millisecond())
}

/// The files the tiered retention drops, for backups sorted newest first.
fn prune_victims<'a>(backups: &'a [BackupInfo], tz: &TimeZone) -> Vec<&'a str> {
    let mut keep: Vec<&str> = backups
        .iter()
        .take(KEEP_RECENT)
        .map(|b| b.file.as_str())
        .collect();
    let mut bucket = |key: &dyn Fn(Date) -> (i16, i8, i8), limit: usize| {
        let mut seen = Vec::new();
        for backup in backups {
            let id = key(local(backup.created, tz).date());
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
        &|date| {
            let back = i64::from(date.weekday().to_sunday_zero_offset());
            let sunday = date.checked_sub(back.days()).unwrap_or(date);
            (sunday.year(), sunday.month(), sunday.day())
        },
        KEEP_WEEKLY,
    );
    bucket(&|date| (date.year(), date.month(), 0), KEEP_MONTHLY);
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

/// `fs.rmSync(path, { force: true })`: a file already gone is not an error.
fn remove_file_forced(path: &Path) -> io::Result<()> {
    match std::fs::remove_file(path) {
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

fn remove_if_present(path: &Path) {
    if let Err(err) = remove_file_forced(path) {
        eprintln!("Failed to remove {}: {err}", path.display());
    }
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
        drop(db);
        std::fs::remove_dir_all(&root).expect("clean up");
    }
    /// The Electron probe's scenarios (`parity/out/t17/t17-probe.ts`) run on
    /// a copy of the T05 fixture, written as the same JSON so the two diff
    /// directly. `BMT_T17_FIXTURE` names the fixture's `matches.db`,
    /// `BMT_T17_OUT` the folder the runs and `rust.json` go in, with
    /// `foreign-for-rust.db`, a backup Electron took, for `cross-restore`.
    #[test]
    #[ignore = "needs the T05 fixture; run with BMT_T17_FIXTURE and BMT_T17_OUT"]
    fn electron_scenarios_on_the_fixture() {
        use serde_json::{Value, json};
        let fixture = PathBuf::from(std::env::var_os("BMT_T17_FIXTURE").expect("BMT_T17_FIXTURE"));
        let out = PathBuf::from(std::env::var_os("BMT_T17_OUT").expect("BMT_T17_OUT"));
        let prune: Vec<String> = serde_json::from_str(
            &std::fs::read_to_string(out.join("t17-prune-names.json")).expect("the prune names"),
        )
        .expect("a list of names");
        let good = |n: &str| (n.to_owned(), "good");
        let bad = |n: &str| (n.to_owned(), "garbage");
        let restore = |f: &str| ("restoreBackup", Some(f.to_owned()));
        type Scenario = (
            &'static str,
            &'static str,
            Vec<(String, &'static str)>,
            bool,
            Vec<(&'static str, Option<String>)>,
        );
        let scenarios: Vec<Scenario> = vec![
            (
                "prune",
                "",
                prune.iter().map(|n| (n.clone(), "empty")).collect(),
                false,
                vec![("createBackup", None)],
            ),
            (
                "corrupt-garbage-backups",
                "garbage",
                vec![good(GOOD), bad(BAD)],
                false,
                vec![],
            ),
            ("corrupt-garbage-nobackup", "garbage", vec![], false, vec![]),
            ("corrupt-pages-nobackup", "pages", vec![], false, vec![]),
            (
                "missing-backups",
                "missing",
                vec![good(GOOD)],
                false,
                vec![],
            ),
            ("missing-nobackup", "missing", vec![], false, vec![]),
            (
                "restore-errors",
                "",
                vec![bad(BAD), good(GOOD)],
                false,
                vec![
                    restore(BAD),
                    restore("matches-2026-01-01T00-00-00-auto.db"),
                    restore("matches-2026-11-20T10-00-00-AUTO.db"),
                    restore(GOOD),
                ],
            ),
            (
                "cross-restore",
                "",
                vec![(BAD.to_owned(), "foreign")],
                false,
                vec![restore(BAD)],
            ),
            (
                "auto-off",
                "",
                vec![good(GOOD)],
                true,
                vec![restore(GOOD), ("createBackup", None)],
            ),
        ];
        let mut results = serde_json::Map::new();
        for (name, damage, files, auto_off, calls) in scenarios {
            let root = out.join("rust-runs").join(name);
            if root.exists() {
                std::fs::remove_dir_all(&root).expect("clear the run");
            }
            std::fs::create_dir_all(root.join("data")).expect("data/");
            std::fs::create_dir_all(root.join("backups")).expect("backups/");
            let db_file = root.join("data").join(DB_FILE);
            std::fs::copy(&fixture, &db_file).expect("copy the fixture");
            if auto_off {
                let conn = Connection::open(&db_file).expect("open the copy");
                settings::set_setting(&conn, "auto_backup", "false").expect("turn it off");
            }
            for (file, kind) in &files {
                let dest = root.join("backups").join(file);
                match *kind {
                    "good" => drop(std::fs::copy(&fixture, &dest).expect("a good backup")),
                    "garbage" => garbage(&dest, "garbage "),
                    "foreign" => drop(
                        std::fs::copy(out.join("foreign-for-rust.db"), &dest)
                            .expect("the other app's backup"),
                    ),
                    _ => std::fs::write(&dest, b"").expect("an empty backup"),
                }
            }
            if name == "prune" {
                std::fs::write(root.join("backups/notes.txt"), b"").expect("a stray file");
            }
            match damage {
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
                _ => {}
            }
            let (db, backups) = open(&root);
            launch_tick(&backups, &db);
            let list = |b: &Backups| serde_json::to_value(b.list()).expect("a list");
            let list_at_start = list(&backups);
            let mut made = Vec::new();
            for (method, file) in calls {
                let result = match (method, &file) {
                    ("restoreBackup", Some(file)) => match backups.restore(&db, file, NOW) {
                        Ok(games) => json!({ "success": true, "games": games }),
                        Err(error) => json!({ "success": false, "error": error }),
                    },
                    _ => match backups.create(&db, Reason::Manual, NOW) {
                        Ok(backup) => json!({ "success": true, "backup": backup }),
                        Err(error) => json!({ "success": false, "error": error }),
                    },
                };
                let args: Vec<String> = file.into_iter().collect();
                made.push(json!({ "method": method, "args": args, "result": result }));
            }
            let entry = json!({
                "report": report_json(&backups),
                "listAtStart": list_at_start,
                "calls": made,
                "listAtEnd": list(&backups),
                "dataDir": names(&root.join("data")),
                "backupsDir": names(&root.join("backups")),
            });
            drop(db);
            results.insert(name.into(), entry);
        }
        std::fs::write(
            out.join("rust.json"),
            serde_json::to_string_pretty(&Value::Object(results)).expect("JSON") + "\n",
        )
        .expect("write rust.json");
    }
}
