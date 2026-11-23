//! Carries the page's remembered filters and the seen recap badge over from
//! Electron. Electron keeps `localStorage` in Chromium's LevelDB under
//! `<root>/Local Storage/leveldb`; the Tauri webview starts with an empty one,
//! so an updated player would lose both.
//!
//! The store is never opened where it lies. Opening a LevelDB writes a `LOCK`
//! and a `LOG` file, and a recovery can rewrite the manifest, so the import
//! copies the folder to a scratch one and reads that.
//!
//! The marker that says the import is done is written only once the values are
//! safe. A store with nothing to carry, no store, and a corrupt store are
//! final at once. A store with pairs is final when the page's fill script
//! reports that every key is set (see [`FILLED_EVENT`]), so a crash before
//! then leaves no marker and the next start tries again. Trying again is
//! harmless: the script only fills keys the webview does not hold, and a
//! `sessionStorage` flag stops a reload from refilling a key the page has
//! since removed. Only a store LevelDB calls corrupt is skipped for good. Any
//! other failure (a full disk, a lock that would not take) leaves no marker.
//!
//! A key in the store is `_` + origin + `\0` + an encoding byte + the name,
//! and a value is an encoding byte + the text. Encoding `0` is UTF-16LE and
//! `1` is latin1, which Chromium picks per string.

use std::collections::BTreeMap;
use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use rusty_leveldb::{DB, LdbIterator, Options, Status, StatusCode};
use serde::Serialize;

use crate::paths::Paths;

/// The marker's file name, inside the data folder.
pub const MARKER: &str = "local_storage_imported.json";

/// What the fill script reports through `page_event` after it has set every
/// key. `lib.rs` hands it to [`Confirmation::confirm`].
pub const FILLED_EVENT: &str = "local-storage-filled";

/// Electron's `loadFile` pages have the origin `file://`.
const KEY_PREFIX: &[u8] = b"_file://\0";
const SEEN_BADGE_KEY: &str = "recap-badge-seen";
const VIEW_PREFIX: &str = "view:";
/// What the page script sets once it has run, so a reload cannot refill a key.
const DONE_FLAG: &str = "bmt-local-storage-imported";

/// The pairs worth carrying: the recap badge and every remembered filter.
pub fn is_carried(key: &str) -> bool {
    key == SEEN_BADGE_KEY || key.starts_with(VIEW_PREFIX)
}

/// Why a store could not be read.
#[derive(Debug)]
pub enum StoreError {
    /// The copy failed. The store may be fine, so the import is tried again.
    Copy(io::Error),
    /// LevelDB could not open or walk the copy for a reason that says nothing
    /// about the store: a full disk, a lock that would not take, a missing
    /// file. The import is tried again.
    Transient(String),
    /// LevelDB calls the store corrupt. A retry would fail the same way.
    Corrupt(String),
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            StoreError::Copy(error) => write!(f, "could not copy the store: {error}"),
            StoreError::Transient(reason) => write!(f, "could not read the store: {reason}"),
            StoreError::Corrupt(reason) => write!(f, "the store is corrupt: {reason}"),
        }
    }
}

/// Only `Corruption` says the store itself is bad.
fn classify(what: &str, status: &Status) -> StoreError {
    let reason = format!("{what}: {status}");
    match status.code {
        StatusCode::Corruption => StoreError::Corrupt(reason),
        _ => StoreError::Transient(reason),
    }
}

/// What a start did about the import.
#[derive(Debug)]
pub enum Outcome {
    /// An earlier start did it.
    AlreadyImported,
    /// Electron left no store.
    NoStore,
    /// `pairs` are what the page script fills in, `ignored` the store's other
    /// entries.
    Imported {
        pairs: BTreeMap<String, String>,
        ignored: usize,
    },
    /// The store is corrupt. The app starts without its old filters, for good.
    Skipped(String),
    /// Nothing was decided and no marker was written, so the next start tries
    /// again.
    Failed(String),
}

impl Outcome {
    /// The log line for this start.
    pub fn summary(&self) -> String {
        match self {
            Outcome::AlreadyImported => "local storage import: done on an earlier start".into(),
            Outcome::NoStore => "local storage import: Electron left no store".into(),
            Outcome::Imported { pairs, ignored } => format!(
                "local storage import: carried {} keys, ignored {ignored} others",
                pairs.len()
            ),
            Outcome::Skipped(reason) => format!("local storage import: skipped, {reason}"),
            Outcome::Failed(reason) => {
                format!("local storage import: failed, will retry next start, {reason}")
            }
        }
    }

    /// The script that puts the pairs in the webview's `localStorage` before
    /// any page script reads it. `None` when there is nothing to carry.
    pub fn script(&self) -> Option<String> {
        match self {
            Outcome::Imported { pairs, .. } if !pairs.is_empty() => Some(fill_script(pairs)),
            _ => None,
        }
    }
}

/// Runs the import for this start. Reads Electron's store, and records that it
/// is done unless pairs are still waiting for the page to confirm them.
pub fn import(paths: &Paths, now_ms: i64) -> Outcome {
    match marker::exists(paths) {
        Ok(true) => return Outcome::AlreadyImported,
        Ok(false) => {}
        Err(error) => return Outcome::Failed(format!("no data folder: {error}")),
    }
    let store = paths.root().join("Local Storage").join("leveldb");
    let outcome = if store.join("CURRENT").is_file() {
        match read_copy(&store) {
            Ok((pairs, ignored)) => Outcome::Imported { pairs, ignored },
            Err(StoreError::Corrupt(reason)) => Outcome::Skipped(reason),
            Err(error) => return Outcome::Failed(error.to_string()),
        }
    } else {
        Outcome::NoStore
    };
    if outcome.script().is_some() {
        return outcome;
    }
    match marker::write(paths, &Record::of(&outcome, now_ms)) {
        Ok(()) => outcome,
        Err(error) => Outcome::Failed(format!("could not record the import: {error}")),
    }
}

/// What the page has yet to confirm. The page's fill script reports in once
/// every key is set, and only then is the import recorded.
#[derive(Default)]
pub struct Confirmation(Mutex<Option<usize>>);

impl Confirmation {
    /// Waits on `outcome` if it has pairs for the page to fill.
    pub fn expect(&self, outcome: &Outcome) {
        if let (Outcome::Imported { pairs, .. }, Ok(mut pending)) = (outcome, self.0.lock()) {
            *pending = Some(pairs.len());
        }
    }

    /// The page says the keys are set. Records the import and returns the
    /// number of keys it carried, or `None` when nothing was waiting (a
    /// reload, or a second report).
    pub fn confirm(&self, paths: &Paths, now_ms: i64) -> io::Result<Option<usize>> {
        let Some(carried) = self
            .0
            .lock()
            .map_err(|e| io::Error::other(e.to_string()))?
            .take()
        else {
            return Ok(None);
        };
        let record = Record {
            at: now_ms,
            outcome: "imported",
            carried,
            reason: None,
        };
        marker::write(paths, &record).inspect_err(|_| {
            if let Ok(mut pending) = self.0.lock() {
                *pending = Some(carried);
            }
        })?;
        Ok(Some(carried))
    }
}

/// Where "the import is done" lives. T11's `local_storage_imported` setting
/// replaces this module's two functions and nothing else.
mod marker {
    use super::*;

    pub fn exists(paths: &Paths) -> io::Result<bool> {
        Ok(paths.data_dir()?.join(MARKER).exists())
    }

    pub fn write(paths: &Paths, record: &Record) -> io::Result<()> {
        let marker = paths.data_dir()?.join(MARKER);
        let body = serde_json::to_vec_pretty(record).map_err(io::Error::other)?;
        let partial = marker.with_extension("json.part");
        fs::write(&partial, body)?;
        fs::rename(partial, marker)
    }
}

#[derive(Serialize)]
struct Record<'a> {
    at: i64,
    outcome: &'a str,
    carried: usize,
    reason: Option<&'a str>,
}

impl<'a> Record<'a> {
    fn of(outcome: &'a Outcome, at: i64) -> Self {
        let (name, carried, reason) = match outcome {
            Outcome::Imported { pairs, .. } => ("imported", pairs.len(), None),
            Outcome::NoStore => ("no-store", 0, None),
            Outcome::Skipped(reason) => ("skipped", 0, Some(reason.as_str())),
            Outcome::AlreadyImported | Outcome::Failed(_) => ("none", 0, None),
        };
        Self {
            at,
            outcome: name,
            carried,
            reason,
        }
    }
}

/// Copies `store`, reads the copy, and removes it. Returns the carried pairs
/// and how many other entries the store held.
pub fn read_copy(store: &Path) -> Result<(BTreeMap<String, String>, usize), StoreError> {
    let scratch = Scratch::new().map_err(StoreError::Copy)?;
    copy_store(store, &scratch.0).map_err(StoreError::Copy)?;
    read_store(&scratch.0)
}

/// Opens `dir` and reads it. `dir` must be a copy, because opening writes to
/// it.
fn read_store(dir: &Path) -> Result<(BTreeMap<String, String>, usize), StoreError> {
    let options = Options {
        create_if_missing: false,
        ..Options::default()
    };
    let mut db = DB::open(dir, options).map_err(|e| classify("open", &e))?;
    let mut iter = db.new_iter().map_err(|e| classify("iterate", &e))?;
    let mut pairs = BTreeMap::new();
    let mut ignored = 0;
    while let Some((key, value)) = iter.next() {
        let Some(name) = key.strip_prefix(KEY_PREFIX).and_then(decode) else {
            ignored += 1;
            continue;
        };
        if !is_carried(&name) {
            ignored += 1;
            continue;
        }
        // A value that is not text, as a lone surrogate, cannot be sent to the
        // page, so it is left behind with the keys that are not carried
        match decode(&value) {
            Some(text) => {
                pairs.insert(name, text);
            }
            None => ignored += 1,
        }
    }
    Ok((pairs, ignored))
}

/// A string as Chromium stores it: `0` + UTF-16LE, or `1` + latin1.
fn decode(bytes: &[u8]) -> Option<String> {
    let (&tag, rest) = bytes.split_first()?;
    match tag {
        0 => {
            if rest.len() % 2 != 0 {
                return None;
            }
            let units: Vec<u16> = rest
                .as_chunks::<2>()
                .0
                .iter()
                .map(|pair| u16::from_le_bytes(*pair))
                .collect();
            String::from_utf16(&units).ok()
        }
        1 => Some(rest.iter().map(|&byte| char::from(byte)).collect()),
        _ => None,
    }
}

/// The page script. The pairs travel as a JSON object literal, which is a
/// JavaScript expression, so no value can end the script early. It reports
/// through `page_event` only after every key is set, and sets the
/// `sessionStorage` flag then too, so a reload that follows a failed fill
/// tries again.
fn fill_script(pairs: &BTreeMap<String, String>) -> String {
    let pairs = serde_json::to_string(pairs).unwrap_or_else(|_| "{}".into());
    format!(
        "(() => {{ try {{ \
         if (sessionStorage.getItem({flag:?})) return; \
         for (const [key, value] of Object.entries({pairs})) \
         if (localStorage.getItem(key) === null) localStorage.setItem(key, value); \
         sessionStorage.setItem({flag:?}, '1'); \
         window.__TAURI_INTERNALS__.invoke('page_event', {{ name: {event:?} }}); \
         }} catch {{}} }})();",
        flag = DONE_FLAG,
        event = FILLED_EVENT,
    )
}

/// Everything in the folder but its lock, which a running Electron holds. A
/// store has no subfolders.
fn copy_store(from: &Path, to: &Path) -> io::Result<()> {
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        if entry.file_type()?.is_file() && entry.file_name() != "LOCK" {
            fs::copy(entry.path(), to.join(entry.file_name()))?;
        }
    }
    Ok(())
}

/// A folder in the temp directory, removed when dropped.
struct Scratch(PathBuf);

impl Scratch {
    /// Named by pid, a counter, and the clock. `create_dir` fails on a name
    /// that exists, so two scratch folders never share one.
    fn new() -> io::Result<Self> {
        use std::time::{SystemTime, UNIX_EPOCH};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        loop {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_or(0, |d| d.as_nanos());
            let serial = COUNTER.fetch_add(1, Ordering::Relaxed);
            let dir = std::env::temp_dir().join(format!(
                "bmt-local-storage-{}-{serial}-{nanos}",
                std::process::id()
            ));
            match fs::create_dir(&dir) {
                Ok(()) => return Ok(Self(dir)),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error),
            }
        }
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).ok();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Made by trunk Electron through `parity/run-electron.ts`:
    /// `tests/fixtures/local-storage/generate.ts`.
    fn fixture() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/local-storage")
    }

    fn expected() -> BTreeMap<String, String> {
        let text = fs::read_to_string(fixture().join("expected.json")).expect("expected.json");
        serde_json::from_str(&text).expect("expected pairs")
    }

    /// A data root holding a copy of the fixture store, so no test opens the
    /// fixture itself.
    fn root_with_store() -> Scratch {
        let root = Scratch::new().expect("scratch root");
        let store = root.0.join("Local Storage").join("leveldb");
        fs::create_dir_all(&store).unwrap();
        copy_store(&fixture().join("leveldb"), &store).unwrap();
        root
    }

    fn file_names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn decodes_both_encodings_and_refuses_the_rest() {
        assert_eq!(decode(&[1, b'a', 0xeb]), Some("a\u{eb}".into()));
        assert_eq!(decode(&[0, b'a', 0, 0xe5, 0x65]), Some("a\u{65e5}".into()));
        assert_eq!(decode(&[1]), Some(String::new()));
        assert_eq!(decode(&[2, b'a']), None);
        assert_eq!(decode(&[0, b'a']), None, "odd UTF-16 length");
        assert_eq!(decode(&[0, 0x00, 0xd8]), None, "lone surrogate");
        assert_eq!(decode(&[]), None);
    }

    #[test]
    fn reads_every_carried_pair_from_a_store_electron_wrote() {
        let (pairs, ignored) = read_copy(&fixture().join("leveldb")).expect("readable");
        let expected = expected();
        assert_eq!(pairs, expected);
        assert_eq!(expected["view:matches.account"], "\"Ünïcödé 日本語#EUW\"");
        assert_eq!(expected["view:matches.champion"], "\"Zoë\"");
        assert_eq!(expected["recap-badge-seen"], "2026-s4");
        assert!(!pairs.contains_key("unrelated-key"));
        assert!(!pairs.contains_key("view:matches.removed"));
        assert!(
            ignored >= 1,
            "the unrelated key and the bookkeeping are counted"
        );
    }

    #[test]
    fn leaves_the_store_it_reads_as_it_was() {
        let root = root_with_store();
        let store = root.0.join("Local Storage").join("leveldb");
        let bytes = |dir: &Path| -> Vec<(String, Vec<u8>)> {
            file_names(dir)
                .into_iter()
                .map(|name| {
                    let content = fs::read(dir.join(&name)).unwrap();
                    (name, content)
                })
                .collect()
        };
        let before = bytes(&store);
        read_copy(&store).expect("readable");
        assert_eq!(bytes(&store), before, "no lock, log, or rewritten file");
    }

    fn marker_of(paths: &Paths) -> Option<serde_json::Value> {
        let text = fs::read_to_string(paths.data_dir().unwrap().join(MARKER)).ok()?;
        Some(serde_json::from_str(&text).unwrap())
    }

    #[test]
    fn imports_once_and_records_it_when_the_page_confirms() {
        let root = root_with_store();
        let paths = Paths::at(&root.0);
        let first = import(&paths, 1_000);
        let Outcome::Imported { pairs, .. } = &first else {
            panic!("expected an import, got {first:?}");
        };
        assert_eq!(pairs, &expected());
        assert!(first.script().is_some());
        assert!(
            marker_of(&paths).is_none(),
            "nothing is final before the page confirms"
        );

        let confirmation = Confirmation::default();
        confirmation.expect(&first);
        assert_eq!(
            confirmation.confirm(&paths, 1_500).unwrap(),
            Some(pairs.len())
        );
        let record = marker_of(&paths).expect("recorded");
        assert_eq!(record["outcome"], "imported");
        assert_eq!(record["carried"], pairs.len());
        assert_eq!(record["at"], 1_500);
        assert_eq!(
            confirmation.confirm(&paths, 1_600).unwrap(),
            None,
            "a second report"
        );
        assert_eq!(marker_of(&paths).unwrap()["at"], 1_500);

        let second = import(&paths, 2_000);
        assert!(matches!(second, Outcome::AlreadyImported), "{second:?}");
        assert!(second.script().is_none());
    }

    #[test]
    fn a_crash_before_the_page_confirms_leaves_no_marker_and_the_next_start_retries() {
        let root = root_with_store();
        let paths = Paths::at(&root.0);
        // The stub page never confirms, as a page that died before WebKit
        // persisted the keys.
        let lost = Confirmation::default();
        let first = import(&paths, 1);
        lost.expect(&first);
        assert!(marker_of(&paths).is_none());

        let retry = import(&paths, 2);
        let (Outcome::Imported { pairs: before, .. }, Outcome::Imported { pairs: after, .. }) =
            (&first, &retry)
        else {
            panic!("expected two imports, got {first:?} and {retry:?}");
        };
        assert_eq!(before, after, "the retry carries the same keys");
        assert!(retry.script().is_some());

        let confirmation = Confirmation::default();
        confirmation.expect(&retry);
        confirmation.confirm(&paths, 3).unwrap();
        assert!(matches!(import(&paths, 4), Outcome::AlreadyImported));
    }

    #[test]
    fn a_failed_marker_write_keeps_the_confirmation_pending() {
        let root = root_with_store();
        let paths = Paths::at(&root.0);
        let outcome = import(&paths, 1);
        let confirmation = Confirmation::default();
        confirmation.expect(&outcome);
        let data = paths.data_dir().unwrap();
        fs::create_dir(data.join(MARKER)).unwrap();
        fs::write(data.join(MARKER).join("blocker"), b"").unwrap();
        assert!(confirmation.confirm(&paths, 2).is_err());
        fs::remove_dir_all(data.join(MARKER)).unwrap();
        assert_eq!(
            confirmation.confirm(&paths, 3).unwrap(),
            Some(expected().len())
        );
    }

    #[test]
    fn a_store_with_nothing_to_carry_is_final_at_once() {
        let root = Scratch::new().unwrap();
        let paths = Paths::at(&root.0);
        let first = import(&paths, 1);
        assert!(matches!(first, Outcome::NoStore), "{first:?}");
        assert!(first.script().is_none());
        assert_eq!(marker_of(&paths).unwrap()["outcome"], "no-store");
        assert!(matches!(import(&paths, 2), Outcome::AlreadyImported));

        let empty = Scratch::new().unwrap();
        fs::create_dir_all(empty.0.join("Local Storage").join("leveldb")).unwrap();
        let paths = Paths::at(&empty.0);
        let outcome = import(&paths, 1);
        assert!(matches!(outcome, Outcome::NoStore), "{outcome:?}");
        assert_eq!(marker_of(&paths).unwrap()["outcome"], "no-store");
    }

    fn damaged_root(damage: impl Fn(&Path)) -> Scratch {
        let root = root_with_store();
        damage(&root.0.join("Local Storage").join("leveldb"));
        root
    }

    #[test]
    fn a_corrupt_store_is_skipped_once_and_for_good() {
        let flipped = damaged_root(|store| {
            let manifest = store.join("MANIFEST-000001");
            let mut bytes = fs::read(&manifest).unwrap();
            for byte in bytes.iter_mut().skip(8).step_by(3) {
                *byte ^= 0xff;
            }
            fs::write(manifest, bytes).unwrap();
        });
        let truncated = damaged_root(|store| {
            let manifest = store.join("MANIFEST-000001");
            let bytes = fs::read(&manifest).unwrap();
            fs::write(manifest, &bytes[..bytes.len() / 2]).unwrap();
        });
        for root in [&flipped, &truncated] {
            let paths = Paths::at(&root.0);
            let first = import(&paths, 1);
            assert!(matches!(first, Outcome::Skipped(_)), "{first:?}");
            assert!(first.summary().contains("skipped"));
            assert!(first.script().is_none());
            assert_eq!(marker_of(&paths).unwrap()["outcome"], "skipped");
            assert!(matches!(import(&paths, 2), Outcome::AlreadyImported));
        }
    }

    #[test]
    fn only_corruption_is_permanent() {
        let status = |code| Status {
            code,
            err: "x".into(),
        };
        assert!(matches!(
            classify("open", &status(StatusCode::Corruption)),
            StoreError::Corrupt(_)
        ));
        for code in [
            StatusCode::IOError,
            StatusCode::LockError,
            StatusCode::NotFound,
            StatusCode::PermissionDenied,
            StatusCode::InvalidArgument,
            StatusCode::Unknown,
        ] {
            assert!(
                matches!(
                    classify("open", &status(code.clone())),
                    StoreError::Transient(_)
                ),
                "{code:?}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_failed_copy_leaves_no_marker_and_the_next_start_imports() {
        use std::os::unix::fs::PermissionsExt;
        let root = root_with_store();
        let paths = Paths::at(&root.0);
        let log = root
            .0
            .join("Local Storage")
            .join("leveldb")
            .join("000003.log");
        fs::set_permissions(&log, fs::Permissions::from_mode(0o000)).unwrap();
        if fs::File::open(&log).is_ok() {
            return;
        }
        let first = import(&paths, 1);
        assert!(matches!(first, Outcome::Failed(_)), "{first:?}");
        assert!(first.summary().contains("will retry"));
        assert!(marker_of(&paths).is_none());

        fs::set_permissions(&log, fs::Permissions::from_mode(0o644)).unwrap();
        let second = import(&paths, 2);
        assert!(matches!(second, Outcome::Imported { .. }), "{second:?}");
    }

    #[test]
    fn a_store_that_will_not_open_for_a_reason_other_than_corruption_is_retried() {
        let root = damaged_root(|store| {
            fs::write(store.join("CURRENT"), b"MANIFEST-000099\n").unwrap();
        });
        let paths = Paths::at(&root.0);
        let first = import(&paths, 1);
        assert!(matches!(first, Outcome::Failed(_)), "{first:?}");
        assert!(marker_of(&paths).is_none());
        assert!(matches!(import(&paths, 2), Outcome::Failed(_)));
    }

    #[test]
    fn scratch_folders_never_collide_across_threads() {
        let names: Vec<PathBuf> = (0..8)
            .map(|_| {
                std::thread::spawn(|| {
                    (0..200)
                        .map(|_| Scratch::new().unwrap())
                        .collect::<Vec<_>>()
                })
            })
            .collect::<Vec<_>>()
            .into_iter()
            .flat_map(|handle| handle.join().unwrap())
            .map(|scratch| scratch.0.clone())
            .collect();
        let unique: std::collections::BTreeSet<_> = names.iter().collect();
        assert_eq!(unique.len(), names.len());
    }

    #[test]
    fn damaged_stores_error_instead_of_panicking() {
        let source = fixture().join("leveldb");
        let files: Vec<String> = file_names(&source);
        for name in &files {
            let original = fs::read(source.join(name)).unwrap();
            let mut damaged = vec![original[..original.len() / 2].to_vec(), Vec::new()];
            for at in (0..original.len()).step_by(7) {
                let mut flipped = original.clone();
                flipped[at] ^= 0xff;
                damaged.push(flipped);
            }
            for bytes in damaged {
                let scratch = Scratch::new().unwrap();
                copy_store(&source, &scratch.0).unwrap();
                fs::write(scratch.0.join(name), &bytes).unwrap();
                // Ok or Err are both fine here. A panic aborts a release build.
                let _ = read_store(&scratch.0);
            }
        }
    }

    #[test]
    fn the_script_fills_only_missing_keys_and_carries_values_verbatim() {
        let mut pairs = BTreeMap::new();
        pairs.insert(
            "view:matches.account".to_string(),
            "\"</script>\u{2028}'\\\"\"".to_string(),
        );
        let script = fill_script(&pairs);
        assert!(script.contains("localStorage.getItem(key) === null"));
        assert!(script.contains(&serde_json::to_string(&pairs).unwrap()));
        assert!(script.contains("sessionStorage.getItem"));
        let set_flag = script.find("sessionStorage.setItem").unwrap();
        let fill = script.find("localStorage.setItem").unwrap();
        let confirm = script.find(FILLED_EVENT).unwrap();
        assert!(
            fill < set_flag && set_flag < confirm,
            "report only after every key is set"
        );
    }
}
