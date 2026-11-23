//! Carries the page's remembered filters and the seen recap badge over from
//! Electron. Electron keeps `localStorage` in Chromium's LevelDB under
//! `<root>/Local Storage/leveldb`; the Tauri webview starts with an empty one,
//! so an updated player would lose both.
//!
//! The store is never opened where it lies. Opening a LevelDB writes a `LOCK`
//! and a `LOG` file, and a recovery can rewrite the manifest, so the import
//! copies the folder to a scratch one and reads that. The import is
//! idempotent in three ways: a marker file records that it ran, the page
//! script it produces only fills keys the webview does not hold, and a
//! `sessionStorage` flag stops a reload from refilling a key the page has
//! since removed.
//!
//! A key in the store is `_` + origin + `\0` + an encoding byte + the name,
//! and a value is an encoding byte + the text. Encoding `0` is UTF-16LE and
//! `1` is latin1, which Chromium picks per string.

use std::collections::BTreeMap;
use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use rusty_leveldb::{DB, LdbIterator, Options};
use serde::Serialize;

use crate::paths::Paths;

/// The marker's file name, inside the data folder.
pub const MARKER: &str = "local_storage_imported.json";

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
    /// LevelDB refused it or an entry made no sense. A retry would fail the
    /// same way.
    Unreadable(String),
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            StoreError::Copy(error) => write!(f, "could not copy the store: {error}"),
            StoreError::Unreadable(reason) => write!(f, "could not read the store: {reason}"),
        }
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
    /// The store could not be read. The app starts without its old filters.
    Skipped(String),
    /// Nothing was decided, and the next start tries again.
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

/// Runs the import for this start: reads Electron's store once, ever, and
/// records that it did.
pub fn import(paths: &Paths, now_ms: i64) -> Outcome {
    let marker = match paths.data_dir() {
        Ok(dir) => dir.join(MARKER),
        Err(error) => return Outcome::Failed(format!("no data folder: {error}")),
    };
    if marker.exists() {
        return Outcome::AlreadyImported;
    }
    let store = paths.root().join("Local Storage").join("leveldb");
    let outcome = if store.is_dir() {
        match read_copy(&store) {
            Ok((pairs, ignored)) => Outcome::Imported { pairs, ignored },
            Err(StoreError::Unreadable(reason)) => Outcome::Skipped(reason),
            Err(error @ StoreError::Copy(_)) => return Outcome::Failed(error.to_string()),
        }
    } else {
        Outcome::NoStore
    };
    match record(&marker, &outcome, now_ms) {
        Ok(()) => outcome,
        Err(error) => Outcome::Failed(format!("could not write {}: {error}", marker.display())),
    }
}

#[derive(Serialize)]
struct Record<'a> {
    at: i64,
    outcome: &'a str,
    carried: usize,
    reason: Option<&'a str>,
}

fn record(marker: &Path, outcome: &Outcome, now_ms: i64) -> io::Result<()> {
    let (name, carried, reason) = match outcome {
        Outcome::Imported { pairs, .. } => ("imported", pairs.len(), None),
        Outcome::NoStore => ("no-store", 0, None),
        Outcome::Skipped(reason) => ("skipped", 0, Some(reason.as_str())),
        Outcome::AlreadyImported | Outcome::Failed(_) => return Ok(()),
    };
    let body = serde_json::to_vec_pretty(&Record {
        at: now_ms,
        outcome: name,
        carried,
        reason,
    })
    .map_err(io::Error::other)?;
    let partial = marker.with_extension("json.part");
    fs::write(&partial, body)?;
    fs::rename(partial, marker)
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
    let unreadable =
        |what: &str, error: &dyn fmt::Display| StoreError::Unreadable(format!("{what}: {error}"));
    let options = Options {
        create_if_missing: false,
        ..Options::default()
    };
    let mut db = DB::open(dir, options).map_err(|e| unreadable("open", &e))?;
    let mut iter = db.new_iter().map_err(|e| unreadable("iterate", &e))?;
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
/// JavaScript expression, so no value can end the script early.
fn fill_script(pairs: &BTreeMap<String, String>) -> String {
    let pairs = serde_json::to_string(pairs).unwrap_or_else(|_| "{}".into());
    format!(
        "(() => {{ try {{ \
         if (sessionStorage.getItem({flag:?})) return; \
         sessionStorage.setItem({flag:?}, '1'); \
         for (const [key, value] of Object.entries({pairs})) \
         if (localStorage.getItem(key) === null) localStorage.setItem(key, value); \
         }} catch {{}} }})();",
        flag = DONE_FLAG,
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
    fn new() -> io::Result<Self> {
        use std::time::{SystemTime, UNIX_EPOCH};
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos());
        let dir =
            std::env::temp_dir().join(format!("bmt-local-storage-{}-{nanos}", std::process::id()));
        fs::create_dir_all(&dir)?;
        Ok(Self(dir))
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

    #[test]
    fn imports_once_and_records_it() {
        let root = root_with_store();
        let paths = Paths::at(&root.0);
        let first = import(&paths, 1_000);
        let Outcome::Imported { pairs, .. } = &first else {
            panic!("expected an import, got {first:?}");
        };
        assert_eq!(pairs, &expected());
        assert!(first.script().is_some());

        let marker = paths.data_dir().unwrap().join(MARKER);
        let record: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&marker).unwrap()).unwrap();
        assert_eq!(record["outcome"], "imported");
        assert_eq!(record["carried"], pairs.len());
        assert_eq!(record["at"], 1_000);

        let second = import(&paths, 2_000);
        assert!(matches!(second, Outcome::AlreadyImported), "{second:?}");
        assert!(second.script().is_none());
    }

    #[test]
    fn an_empty_or_missing_store_imports_nothing_and_is_not_retried() {
        let root = Scratch::new().unwrap();
        let paths = Paths::at(&root.0);
        let first = import(&paths, 1);
        assert!(matches!(first, Outcome::NoStore), "{first:?}");
        assert!(first.script().is_none());
        assert!(matches!(import(&paths, 2), Outcome::AlreadyImported));

        let empty = Scratch::new().unwrap();
        fs::create_dir_all(empty.0.join("Local Storage").join("leveldb")).unwrap();
        let outcome = import(&Paths::at(&empty.0), 1);
        assert!(matches!(outcome, Outcome::Skipped(_)), "{outcome:?}");
        assert!(outcome.script().is_none());
    }

    #[test]
    fn a_corrupt_store_is_skipped_once() {
        let root = root_with_store();
        let store = root.0.join("Local Storage").join("leveldb");
        for name in file_names(&store) {
            fs::write(store.join(name), b"not a leveldb file").unwrap();
        }
        let paths = Paths::at(&root.0);
        let first = import(&paths, 1);
        assert!(matches!(first, Outcome::Skipped(_)), "{first:?}");
        assert!(first.summary().contains("skipped"));
        assert!(matches!(import(&paths, 2), Outcome::AlreadyImported));
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
    }
}
