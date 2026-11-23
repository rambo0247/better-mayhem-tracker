//! `src/main/import.ts`: a backup file read the way the export writes it, a
//! chunk at a time, so an import never holds the whole file. Chunks are
//! 64 KiB of the file, as Node's read stream hands them over, because when
//! a batch commits, and so every progress event, follows the chunk edges.

use std::collections::HashMap;
use std::fs::File;
use std::io::Read;
use std::path::Path;

use serde_json::Value;

use crate::commands::data::ImportProgress;
use crate::db::js::{self, number_to_string};
use crate::db::{Database, ingest, summoner};
use crate::op_score::ChampionClassMap;
use crate::transfer::node_error;

/// Games per transaction. One commit per game would be most of what an
/// import spends its time on; one for the whole file would hold the
/// database for as long as the import runs.
const IMPORT_BATCH: usize = 50;

/// How many new games to take in before telling the window, so a long
/// import fills the app in as it goes, the same way a backfill does.
const GAMES_UPDATED_BATCH: i64 = 100;

const READ_CHUNK_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ImportError {
    /// A `SyntaxError`: the file, or a piece of it, is not JSON.
    Syntax,
    /// Any other throw, by its message.
    Thrown(String),
}

/// What the import tells the window as it goes.
#[derive(Debug, Clone, PartialEq)]
pub enum ImportEvent {
    Progress(ImportProgress),
    GamesUpdated,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Reading {
    None,
    Key,
    Value,
    Game,
    Rest,
}

trait Sink {
    /// A top-level member, by its key when the key is a string.
    fn value(&mut self, key: Option<&str>, text: &str);
    fn game(&mut self, text: &str);
}

/// `BackupScanner`: splits a JSON object read a chunk at a time into its
/// top-level values, except the members of the "games" array, which it hands
/// over one game at a time. Only strings, brackets and separators are
/// tracked; each piece it hands over is left to the JSON parser, which is
/// what actually validates it. Every byte it acts on is ASCII, which never
/// occurs inside a UTF-8 sequence, so it walks bytes.
struct Scanner {
    depth: i64,
    in_string: bool,
    escaped: bool,
    finished: bool,
    reading: Reading,
    /// Text collected from earlier chunks, joined once the piece is complete
    pieces: String,
    /// `JSON.parse` of the member's key, when that is a string
    key: Option<String>,
    in_games: bool,
    saw_games: bool,
}

impl Scanner {
    fn new() -> Self {
        Self {
            depth: 0,
            in_string: false,
            escaped: false,
            finished: false,
            reading: Reading::None,
            pieces: String::new(),
            key: Some(String::new()),
            in_games: false,
            saw_games: false,
        }
    }

    fn take(&mut self, chunk: &str, from: usize, to: usize) -> String {
        let mut text = std::mem::take(&mut self.pieces);
        text.push_str(&chunk[from..to]);
        text
    }

    fn push(&mut self, chunk: &str, sink: &mut impl Sink) -> Result<(), ImportError> {
        let bytes = chunk.as_bytes();
        let mut from = 0;
        let mut i = 0;
        while i < bytes.len() {
            let c = bytes[i];
            if self.in_string {
                if self.escaped {
                    self.escaped = false;
                } else if c == b'\\' {
                    self.escaped = true;
                } else if c == b'"' {
                    self.in_string = false;
                }
                i += 1;
                continue;
            }
            match c {
                b'"' => self.in_string = true,
                b'{' | b'[' => {
                    if self.depth == 0 {
                        if c != b'{' || self.finished {
                            return Err(ImportError::Syntax);
                        }
                        self.reading = Reading::Key;
                        from = i + 1;
                    } else if self.depth == 1
                        && c == b'['
                        && self.reading == Reading::Value
                        && self.key.as_deref() == Some("games")
                        && js_trim(&self.take(chunk, from, i)).is_empty()
                    {
                        self.in_games = true;
                        self.saw_games = true;
                        self.reading = Reading::Game;
                        from = i + 1;
                    }
                    self.depth += 1;
                }
                b'}' | b']' => {
                    self.depth -= 1;
                    if self.depth < 0 {
                        return Err(ImportError::Syntax);
                    }
                    if self.depth == 1 && self.in_games && c == b']' {
                        let text = self.take(chunk, from, i);
                        emit_game(&text, sink);
                        self.in_games = false;
                        self.reading = Reading::Rest;
                        from = i + 1;
                    } else if self.depth == 0 {
                        if c != b'}' {
                            return Err(ImportError::Syntax);
                        }
                        let text = self.take(chunk, from, i);
                        self.end_member(&text, sink)?;
                        self.reading = Reading::None;
                        self.finished = true;
                    }
                }
                b',' if self.depth == 1 => {
                    let text = self.take(chunk, from, i);
                    self.end_member(&text, sink)?;
                    self.reading = Reading::Key;
                    from = i + 1;
                }
                b',' if self.depth == 2 && self.in_games => {
                    let text = self.take(chunk, from, i);
                    emit_game(&text, sink);
                    from = i + 1;
                }
                b':' if self.depth == 1 && self.reading == Reading::Key => {
                    let text = self.take(chunk, from, i);
                    self.key = match parse(js_trim(&text))? {
                        Value::String(key) => Some(key),
                        _ => None,
                    };
                    self.reading = Reading::Value;
                    from = i + 1;
                }
                _ if self.depth == 0 => {
                    // Text outside the object may only be whitespace, as /\s/ reads it
                    let ch = chunk[i..].chars().next().unwrap_or(' ');
                    if !is_js_space(ch) {
                        return Err(ImportError::Syntax);
                    }
                    i += ch.len_utf8();
                    continue;
                }
                _ => {}
            }
            i += 1;
        }
        if self.reading != Reading::None {
            self.pieces.push_str(&chunk[from..]);
        }
        Ok(())
    }

    fn finish(&self) -> Result<(), ImportError> {
        if !self.finished || self.in_string {
            return Err(ImportError::Syntax);
        }
        Ok(())
    }

    fn end_member(&self, text: &str, sink: &mut impl Sink) -> Result<(), ImportError> {
        let value = js_trim(text);
        if self.reading == Reading::Value {
            sink.value(self.key.as_deref(), value);
        } else if !value.is_empty() {
            // A key with no value, or anything after the games array but whitespace
            return Err(ImportError::Syntax);
        }
        Ok(())
    }
}

fn emit_game(text: &str, sink: &mut impl Sink) {
    let game = js_trim(text);
    if !game.is_empty() {
        sink.game(game);
    }
}

/// JavaScript's WhiteSpace and LineTerminator, what `trim()` and `/\s/` match.
fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_space)
}

fn parse(text: &str) -> Result<Value, ImportError> {
    serde_json::from_str(text).map_err(|_| ImportError::Syntax)
}

/// The file as Node's UTF-8 read stream hands it over: 64 KiB reads, each
/// decoded with an invalid sequence as U+FFFD, and a sequence cut by the end
/// of a read carried into the next one.
struct Chunks {
    file: File,
    carry: Vec<u8>,
    buf: Vec<u8>,
}

impl Chunks {
    fn open(path: &Path) -> Result<Self, ImportError> {
        let file = File::open(path).map_err(|err| thrown_io(&err, "open", Some(path)))?;
        Ok(Self {
            file,
            carry: Vec::new(),
            buf: vec![0; READ_CHUNK_BYTES],
        })
    }

    fn next(&mut self) -> Result<Option<String>, ImportError> {
        let mut filled = 0;
        while filled < READ_CHUNK_BYTES {
            match self.file.read(&mut self.buf[filled..]) {
                Ok(0) => break,
                Ok(n) => filled += n,
                Err(err) if err.kind() == std::io::ErrorKind::Interrupted => {}
                Err(err) => return Err(thrown_io(&err, "read", None)),
            }
        }
        if filled == 0 {
            if self.carry.is_empty() {
                return Ok(None);
            }
            self.carry.clear();
            return Ok(Some("\u{fffd}".into()));
        }
        let mut bytes = std::mem::take(&mut self.carry);
        bytes.extend_from_slice(&self.buf[..filled]);
        let mut out = String::with_capacity(bytes.len());
        let mut rest = &bytes[..];
        loop {
            match std::str::from_utf8(rest) {
                Ok(text) => {
                    out.push_str(text);
                    break;
                }
                Err(err) => {
                    let (valid, after) = rest.split_at(err.valid_up_to());
                    out.push_str(std::str::from_utf8(valid).unwrap_or_default());
                    match err.error_len() {
                        Some(len) => {
                            out.push('\u{fffd}');
                            rest = &after[len..];
                        }
                        None => {
                            self.carry = after.to_vec();
                            break;
                        }
                    }
                }
            }
        }
        Ok(Some(out))
    }
}

fn thrown_io(err: &std::io::Error, syscall: &str, path: Option<&Path>) -> ImportError {
    ImportError::Thrown(node_error(err, syscall, path))
}

/// The first pass: the small values, and how many games there are.
#[derive(Default)]
struct Header {
    values: HashMap<String, String>,
    total: i64,
}

impl Sink for Header {
    fn value(&mut self, key: Option<&str>, text: &str) {
        if let Some(key) = key {
            self.values.insert(key.to_owned(), text.to_owned());
        }
    }

    fn game(&mut self, _text: &str) {
        self.total += 1;
    }
}

/// The second pass: each game parsed and paired with its owner.
struct Games {
    v3: bool,
    fallback_owner: Value,
    current: i64,
    unreadable: i64,
    batch: Vec<(Value, Value)>,
}

impl Sink for Games {
    fn value(&mut self, _key: Option<&str>, _text: &str) {}

    fn game(&mut self, text: &str) {
        self.current += 1;
        let Ok(game) = serde_json::from_str::<Value>(text) else {
            self.unreadable += 1;
            return;
        };
        let owner = if self.v3 {
            js::or(&[
                js::opt_prop(Some(&game), "_ownerPuuid"),
                Some(&self.fallback_owner),
            ])
        } else {
            Some(&self.fallback_owner)
        };
        if js::truthy(owner) {
            let owner = owner.cloned().unwrap_or(Value::Null);
            self.batch.push((game, owner));
        }
    }
}

/// Where an import writes, and what it reads besides the file.
pub struct ImportTarget<'a> {
    pub db: &'a Database,
    pub classes: &'a ChampionClassMap,
    pub now_ms: &'a dyn Fn() -> i64,
}

/// `importBackupFile`: imports every game in a backup file that isn't stored
/// yet, and returns how many that was. Two passes. The first reads only the
/// small values and counts the games, so a file that turns out not to be a
/// backup has changed nothing, and progress has a total to count toward.
/// `snapshot` runs once the file has passed that check and before anything
/// is written. The second pass hands the games over a batch at a time.
pub fn import_backup_file(
    file: &Path,
    target: &ImportTarget<'_>,
    snapshot: impl FnOnce(),
    emit: &mut dyn FnMut(ImportEvent),
) -> Result<i64, ImportError> {
    let mut header = Header::default();
    let mut scanner = Scanner::new();
    let mut chunks = Chunks::open(file)?;
    while let Some(chunk) = chunks.next()? {
        scanner.push(&chunk, &mut header)?;
    }
    scanner.finish()?;
    if !scanner.saw_games {
        return Err(ImportError::Thrown(
            "That file isn't a Better Mayhem Tracker backup".into(),
        ));
    }

    let read = |key: &str| header.values.get(key).map(|text| parse(text)).transpose();
    // Version 3 names each game's owner and every account; version 2 has one
    // account, which owns every game
    let v3 = to_number(read("version")?.as_ref()) >= 3.0;
    let summoners: Vec<Value> = if v3 {
        match read("summoners")? {
            None | Some(Value::Null) => Vec::new(),
            Some(Value::Array(items)) => items,
            Some(_) => {
                return Err(ImportError::Thrown(
                    "summoners.filter is not a function".into(),
                ));
            }
        }
    } else {
        read("summoner")?.into_iter().collect()
    };
    let accounts: Vec<Value> = summoners
        .into_iter()
        .filter(|s| js::string(js::opt_prop(Some(s), "puuid")).is_some_and(|p| !p.is_empty()))
        .collect();
    let fallback_owner = accounts
        .first()
        .and_then(|s| js::opt_prop(Some(s), "puuid"))
        .cloned()
        .unwrap_or(Value::Null);
    let total = header.total;
    drop(header);

    // Snapshot first: an import writes into every table, and this is the
    // last moment the database is known to be in the state the user chose
    snapshot();
    let thrown = |err: crate::commands::CommandError| ImportError::Thrown(err.message);
    target
        .db
        .with(|conn| {
            let tx = conn.unchecked_transaction()?;
            for account in &accounts {
                summoner::upsert_summoner(conn, account, (target.now_ms)())?;
            }
            tx.commit()
        })
        .map_err(thrown)?;

    emit(ImportEvent::Progress(ImportProgress {
        current: 0,
        total,
        imported: 0,
    }));
    let mut imported = 0i64;
    let mut announced = 0i64;
    let mut games = Games {
        v3,
        fallback_owner,
        current: 0,
        unreadable: 0,
        batch: Vec::new(),
    };
    let mut flush = |games: &mut Games| -> Result<(), ImportError> {
        let batch = std::mem::take(&mut games.batch);
        imported += import_games(target, &batch).map_err(thrown)?;
        emit(ImportEvent::Progress(ImportProgress {
            current: games.current,
            total,
            imported,
        }));
        if imported - announced >= GAMES_UPDATED_BATCH {
            announced = imported;
            emit(ImportEvent::GamesUpdated);
        }
        Ok(())
    };

    let mut scanner = Scanner::new();
    let mut chunks = Chunks::open(file)?;
    while let Some(chunk) = chunks.next()? {
        scanner.push(&chunk, &mut games)?;
        if games.batch.len() >= IMPORT_BATCH {
            flush(&mut games)?;
        }
    }
    scanner.finish()?;
    flush(&mut games)?;
    drop(flush);

    if imported > announced {
        emit(ImportEvent::GamesUpdated);
    }
    if games.unreadable > 0 {
        eprintln!(
            "Import skipped {} games that would not parse",
            games.unreadable
        );
    }
    println!(
        "Imported {imported} of {total} games from {}",
        file.display()
    );
    Ok(imported)
}

/// `importGames`: one batch in one transaction, returning how many were new.
/// A game whose owner is not a string never matches a player, but its
/// participants are still read, and can still throw.
fn import_games(
    target: &ImportTarget<'_>,
    batch: &[(Value, Value)],
) -> crate::commands::CommandResult<i64> {
    target.db.with(|conn| {
        let tx = conn.unchecked_transaction()?;
        let mut imported = 0;
        for (game, owner) in batch {
            let new = match owner.as_str() {
                Some(puuid) => ingest::insert_game_full(conn, game, puuid, target.classes)?,
                None => {
                    crate::db::payloads::participant_rows_from_raw(Some(game))
                        .map_err(js::thrown)?;
                    false
                }
            };
            if new {
                imported += 1;
            }
        }
        tx.commit()?;
        Ok(imported)
    })
}

/// `Number(value)` for a parsed JSON value; `None` is `undefined`.
fn to_number(v: Option<&Value>) -> f64 {
    match v {
        None | Some(Value::Object(_)) => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => string_to_number(s),
        Some(array @ Value::Array(_)) => string_to_number(&to_js_string(array)),
    }
}

/// `String(value)`, which joins an array with commas.
fn to_js_string(v: &Value) -> String {
    match v {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => number_to_string(n.as_f64().unwrap_or(f64::NAN)),
        Value::String(s) => s.clone(),
        Value::Array(items) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                other => to_js_string(other),
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// ECMA-262 StringToNumber.
fn string_to_number(s: &str) -> f64 {
    let t = js_trim(s);
    if t.is_empty() {
        return 0.0;
    }
    match t {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    let radix = match t.get(..2) {
        Some("0x" | "0X") => 16,
        Some("0o" | "0O") => 8,
        Some("0b" | "0B") => 2,
        _ => 10,
    };
    if radix != 10 {
        let digits = &t[2..];
        if digits.is_empty() || !digits.chars().all(|c| c.is_digit(radix)) {
            return f64::NAN;
        }
        return u128::from_str_radix(digits, radix).map_or_else(
            |_| {
                digits.chars().fold(0.0, |acc, c| {
                    acc * f64::from(radix) + f64::from(c.to_digit(radix).unwrap_or(0))
                })
            },
            |n| n as f64,
        );
    }
    let body = t.strip_prefix(['+', '-']).unwrap_or(t);
    let (mantissa, exponent) = match body.find(['e', 'E']) {
        Some(at) => (&body[..at], Some(&body[at + 1..])),
        None => (body, None),
    };
    let (int, frac) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    let digits = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
    let exponent_ok = exponent.is_none_or(|e| {
        let e = e.strip_prefix(['+', '-']).unwrap_or(e);
        !e.is_empty() && digits(e)
    });
    if (int.is_empty() && frac.is_empty()) || !digits(int) || !digits(frac) || !exponent_ok {
        return f64::NAN;
    }
    t.parse().unwrap_or(f64::NAN)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[derive(Default)]
    struct Collect {
        values: Vec<(Option<String>, String)>,
        games: Vec<String>,
    }

    impl Sink for Collect {
        fn value(&mut self, key: Option<&str>, text: &str) {
            self.values.push((key.map(str::to_owned), text.to_owned()));
        }
        fn game(&mut self, text: &str) {
            self.games.push(text.to_owned());
        }
    }

    fn scan_in(text: &str, chunk: usize) -> Result<Collect, ImportError> {
        let mut scanner = Scanner::new();
        let mut sink = Collect::default();
        let mut at = 0;
        while at < text.len() {
            let mut end = (at + chunk).min(text.len());
            while !text.is_char_boundary(end) {
                end += 1;
            }
            scanner.push(&text[at..end], &mut sink)?;
            at = end;
        }
        scanner.finish()?;
        Ok(sink)
    }

    #[test]
    fn games_come_out_one_at_a_time_whatever_the_chunks() {
        let text = "\u{feff} { \"version\" : 3, \"summoners\": [{\"puuid\":\"a,]}\"}],\n \"games\" : [ {\"a\":[1,{\"b\":\"]\\\"\"}]} , [2] ,\"x\" ] , \"tail\": null }\u{a0}\n";
        for chunk in 1..text.len() + 1 {
            let got = scan_in(text, chunk).unwrap();
            assert_eq!(
                got.games,
                [r#"{"a":[1,{"b":"]\""}]}"#, "[2]", r#""x""#],
                "chunk {chunk}"
            );
            assert_eq!(
                got.values,
                [
                    (Some("version".into()), "3".into()),
                    (Some("summoners".into()), r#"[{"puuid":"a,]}"}]"#.into()),
                    (Some("tail".into()), "null".into()),
                ],
                "chunk {chunk}"
            );
        }
    }

    #[test]
    fn what_the_scanner_refuses() {
        for text in [
            "this is not json",
            "[]",
            "{} {}",
            "{\"games\":[]",
            "{\"a\":1}}",
            "{\"a\"}",
            "{\"games\":[] x}",
            "{\"a\":\"unterminated}",
            "{bad:1}",
            "",
        ] {
            assert_eq!(
                scan_in(text, 4).err(),
                Some(ImportError::Syntax),
                "{text:?}"
            );
        }
        // A trailing comma and a key that is not a string both pass the scanner
        let got = scan_in("{\"games\":[1,],5:[2],}", 3).unwrap();
        assert_eq!(got.games, ["1"]);
        assert_eq!(got.values, [(None, "[2]".into())]);
    }

    #[test]
    fn versions_read_as_number_reads_them() {
        let cases = [
            (json!(3), 3.0),
            (json!("3"), 3.0),
            (json!(" 0x3 "), 3.0),
            (json!([3]), 3.0),
            (json!([]), 0.0),
            (json!(true), 1.0),
            (json!(null), 0.0),
            (json!("1e1"), 10.0),
            (json!(".5"), 0.5),
        ];
        for (v, want) in cases {
            assert_eq!(to_number(Some(&v)), want, "{v}");
        }
        for v in [
            json!("3a"),
            json!({}),
            json!([1, 2]),
            json!("inf"),
            json!("0x"),
        ] {
            assert!(to_number(Some(&v)).is_nan(), "{v}");
        }
        assert!(to_number(None).is_nan());
    }

    #[test]
    fn a_cut_utf8_sequence_waits_for_the_next_read() {
        let dir = std::env::temp_dir().join(format!("bmt-chunks-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("a.json");
        let mut bytes = vec![b' '; READ_CHUNK_BYTES - 1];
        bytes.extend("é".as_bytes());
        bytes.extend([0xff, b'x']);
        std::fs::write(&file, &bytes).unwrap();
        let mut chunks = Chunks::open(&file).unwrap();
        let first = chunks.next().unwrap().unwrap();
        assert_eq!(first.len(), READ_CHUNK_BYTES - 1);
        assert_eq!(chunks.next().unwrap().unwrap(), "é\u{fffd}x");
        assert_eq!(chunks.next().unwrap(), None);
        std::fs::remove_dir_all(dir).ok();
    }

    /// The T05 export imported into a fresh database exports back to the
    /// same bytes: every game lands with its owner, in order, and the account
    /// row comes back whole. `BMT_GOLDEN_DIR` names the goldens; without them
    /// there is nothing to import.
    #[test]
    fn the_golden_export_round_trips_through_an_import() {
        let Some(golden) = std::env::var_os("BMT_GOLDEN_DIR") else {
            return;
        };
        let record: Value = serde_json::from_str(
            &std::fs::read_to_string(Path::new(&golden).join("ipc/data.export/export.json"))
                .unwrap(),
        )
        .unwrap();
        let text = record["files"][0]["text"].as_str().unwrap();
        let dir = std::env::temp_dir().join(format!("bmt-import-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("in.json");
        std::fs::write(&file, text).unwrap();
        let db = Database::open(&dir, 0).unwrap();
        // The account row's updated_at in the fixture
        let now = || 1_795_401_717_315;
        let mut events = Vec::new();
        let mut snapshots = 0;
        let imported = import_backup_file(
            &file,
            &ImportTarget {
                db: &db,
                classes: &ChampionClassMap::new(),
                now_ms: &now,
            },
            || snapshots += 1,
            &mut |e| events.push(e),
        );
        assert_eq!(imported, Ok(669));
        assert_eq!(snapshots, 1);
        assert_eq!(
            events.first(),
            Some(&ImportEvent::Progress(ImportProgress {
                current: 0,
                total: 669,
                imported: 0
            }))
        );
        assert_eq!(
            events
                .iter()
                .filter(|e| **e == ImportEvent::GamesUpdated)
                .count(),
            7
        );
        let out = dir.join("out.json");
        assert_eq!(crate::transfer::write_export_to(&db, &out), Ok(669));
        let back = std::fs::read(&out).unwrap();
        db.close();
        std::fs::remove_dir_all(&dir).ok();
        assert!(
            back == text.as_bytes(),
            "the export after an import differs"
        );
    }
}
