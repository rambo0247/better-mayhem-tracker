//! `writeExportTo` in `src/main/db/transfer.ts`: the whole library as one
//! JSON file, format version 3, byte for byte what Electron writes. Games
//! are read a page at a time and written straight to disk, and the database
//! is free between pages, as Electron's event loop is between its awaits.

use std::collections::HashMap;
use std::fs::File;
use std::io::{self, BufWriter, Read, Write};
use std::path::Path;

use rusqlite::types::ValueRef;
use serde_json::{Map, Number, Value};

use crate::db::Database;
use crate::db::js::{self, Cell};
use flate2::read::MultiGzDecoder;

const EXPORT_PAGE_SIZE: i64 = 200;

/// The games written, or the message of what Electron would have thrown.
pub fn write_export_to(db: &Database, file: &Path) -> Result<i64, String> {
    let out = File::create(file).map_err(|err| node_error(&err, "open", Some(file)))?;
    let mut out = BufWriter::with_capacity(64 * 1024, out);
    let mut write = |chunk: &str| {
        out.write_all(chunk.as_bytes())
            .map_err(|err| node_error(&err, "write", None))
    };

    let summoners = db
        .with(|conn| {
            let mut stmt = conn.prepare("SELECT * FROM summoner")?;
            let names: Vec<String> = stmt.column_names().map(String::from).collect();
            stmt.query_map([], |row| {
                let mut object = Map::new();
                for (i, name) in names.iter().enumerate() {
                    object.insert(name.clone(), row_value(row.get_ref(i)?));
                }
                Ok(Value::Object(object))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()
        })
        .map_err(|err| err.message)?;
    write(&format!(
        "{{\"version\":3,\"summoners\":{},\"games\":[",
        js::stringify(&Value::Array(summoners))
    ))?;

    let mut count = 0i64;
    let mut last_id = 0i64;
    loop {
        let rows = db
            .with(|conn| {
                conn.prepare_cached(
                    "
      SELECT game_id, raw_gz, puuid
      FROM games
      WHERE raw_gz IS NOT NULL AND game_id > ?
      ORDER BY game_id
      LIMIT ?
    ",
                )?
                .query_map(rusqlite::params![last_id, EXPORT_PAGE_SIZE], |row| {
                    let blob = match row.get_ref(1)? {
                        ValueRef::Blob(b) | ValueRef::Text(b) => Some(b.to_vec()),
                        _ => None,
                    };
                    Ok((row.get::<_, i64>(0)?, blob, row.get::<_, Cell>(2)?))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()
            })
            .map_err(|err| err.message)?;
        let Some((last, _, _)) = rows.last() else {
            break;
        };
        last_id = *last;

        let mut chunk = String::new();
        for game in exported_page(rows) {
            // A backup stays the untouched payloads, so an import into any
            // version rebuilds whatever that version derives from them
            let Some(game) = game? else {
                continue;
            };
            if count > 0 {
                chunk.push(',');
            }
            chunk.push_str(&game);
            count += 1;
        }
        write(&chunk)?;
    }

    write("]}")?;
    out.flush().map_err(|err| node_error(&err, "write", None))?;
    Ok(count)
}

/// One page's games, rewritten on every core. Each row's text depends only
/// on that row, so the order, and the first error in it, are as one thread
/// would leave them.
fn exported_page(rows: Vec<(i64, Option<Vec<u8>>, Cell)>) -> Vec<Result<Option<String>, String>> {
    let threads = std::thread::available_parallelism().map_or(1, |n| n.get());
    let per = rows.len().div_ceil(threads).max(1);
    std::thread::scope(|scope| {
        let workers: Vec<_> = rows
            .chunks(per)
            .map(|part| {
                scope.spawn(move || {
                    part.iter()
                        .map(|(_, blob, owner)| {
                            exported_game(blob.as_deref(), cell_value(owner.clone()))
                        })
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        workers
            .into_iter()
            .flat_map(|worker| worker.join().expect("a page worker panicked"))
            .collect()
    })
}

/// `JSON.stringify(Object.assign(unpackRaw(blob), { _ownerPuuid }))` for one
/// row, or `None` where `unpackRaw` gives nothing truthy.
fn exported_game(blob: Option<&[u8]>, owner: Value) -> Result<Option<String>, String> {
    let mut bytes = Vec::new();
    let Some(blob) = blob else {
        return Ok(None);
    };
    if MultiGzDecoder::new(blob).read_to_end(&mut bytes).is_err() {
        return Ok(None);
    }
    let text = String::from_utf8_lossy(&bytes);
    let mut out = Stringified::new(Some(&owner));
    if parse_json(&text, &mut out).is_err() {
        return Ok(None);
    }
    match out.top {
        None => Ok(Some(out.text)),
        Some(scalar) if !scalar.truthy() => Ok(None),
        // `game._ownerPuuid = owner` in strict mode
        Some(scalar) => Err(format!(
            "Cannot create property '_ownerPuuid' on {} '{}'",
            scalar.kind(),
            scalar.shown()
        )),
    }
}

/// A JSON value that is not an object or an array.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Scalar {
    Null,
    Bool(bool),
    /// The literal as written, and the double JSON.parse reads it as.
    Number(String, f64),
    /// Decoded, each lone surrogate as U+FFFD.
    String(String),
}

impl Scalar {
    fn truthy(&self) -> bool {
        match self {
            Scalar::Null => false,
            Scalar::Bool(b) => *b,
            Scalar::Number(_, n) => *n != 0.0 && !n.is_nan(),
            Scalar::String(s) => !s.is_empty(),
        }
    }

    fn kind(&self) -> &'static str {
        match self {
            Scalar::Null => "null",
            Scalar::Bool(_) => "boolean",
            Scalar::Number(..) => "number",
            Scalar::String(_) => "string",
        }
    }

    fn shown(&self) -> String {
        match self {
            Scalar::Null => "null".into(),
            Scalar::Bool(b) => b.to_string(),
            Scalar::Number(_, n) => js::number_to_string(*n),
            Scalar::String(s) => s.clone(),
        }
    }

    /// As serde_json would hold it, except that a number too large for a
    /// double is null, as JSON.stringify prints Infinity.
    fn value(self) -> Value {
        match self {
            Scalar::Null => Value::Null,
            Scalar::Bool(b) => Value::Bool(b),
            Scalar::Number(literal, n) => {
                let plain = !literal.contains(['.', 'e', 'E']) && literal != "-0";
                let integer = plain
                    .then(|| {
                        literal
                            .parse::<u64>()
                            .map(Number::from)
                            .or_else(|_| literal.parse::<i64>().map(Number::from))
                            .ok()
                    })
                    .flatten();
                integer
                    .or_else(|| Number::from_f64(n))
                    .map_or(Value::Null, Value::Number)
            }
            Scalar::String(s) => Value::String(s),
        }
    }
}

/// What `JSON.parse` reads, in order. `key` and `scalar` carry the text
/// `JSON.stringify` prints for them.
pub(crate) trait JsonEvents {
    fn open(&mut self, object: bool);
    fn key(&mut self, printed: &str, decoded: &str);
    fn scalar(&mut self, printed: &str, scalar: Scalar);
    fn close(&mut self);
}

/// `JSON.parse(text)` as ECMA-404 and V8 read it, as events. It keeps no
/// stack frame per level, so any depth parses, as in V8.
pub(crate) fn parse_json(text: &str, events: &mut impl JsonEvents) -> Result<(), ()> {
    let mut p = Lexer {
        text,
        s: text.as_bytes(),
        i: 0,
        printed: String::new(),
        decoded: String::new(),
    };
    // true for an object
    let mut open: Vec<bool> = Vec::new();
    p.ws();
    loop {
        match p.peek() {
            Some(b'{') => {
                p.i += 1;
                events.open(true);
                p.ws();
                if p.peek() == Some(b'}') {
                    p.i += 1;
                    events.close();
                } else {
                    open.push(true);
                    p.member(events)?;
                    continue;
                }
            }
            Some(b'[') => {
                p.i += 1;
                events.open(false);
                p.ws();
                if p.peek() == Some(b']') {
                    p.i += 1;
                    events.close();
                } else {
                    open.push(false);
                    continue;
                }
            }
            _ => {
                let scalar = p.scalar()?;
                events.scalar(&p.printed, scalar);
            }
        }
        loop {
            p.ws();
            let Some(&object) = open.last() else {
                return if p.i == p.s.len() { Ok(()) } else { Err(()) };
            };
            let end = if object { b'}' } else { b']' };
            match p.peek() {
                Some(b',') => {
                    p.i += 1;
                    if object {
                        p.member(events)?;
                    } else {
                        p.ws();
                    }
                    break;
                }
                Some(b) if b == end => {
                    p.i += 1;
                    open.pop();
                    events.close();
                }
                _ => return Err(()),
            }
        }
    }
}

struct Lexer<'a> {
    text: &'a str,
    s: &'a [u8],
    i: usize,
    /// The last string or scalar as `JSON.stringify` prints it.
    printed: String,
    /// The last string decoded.
    decoded: String,
}

impl Lexer<'_> {
    fn peek(&self) -> Option<u8> {
        self.s.get(self.i).copied()
    }

    fn ws(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.i += 1;
        }
    }

    fn eat(&mut self, b: u8) -> Result<(), ()> {
        if self.peek() == Some(b) {
            self.i += 1;
            Ok(())
        } else {
            Err(())
        }
    }

    /// A key and its colon, then the space before its value.
    fn member(&mut self, events: &mut impl JsonEvents) -> Result<(), ()> {
        self.ws();
        self.string()?;
        events.key(&self.printed, &self.decoded);
        self.ws();
        self.eat(b':')?;
        self.ws();
        Ok(())
    }

    fn scalar(&mut self) -> Result<Scalar, ()> {
        self.printed.clear();
        let word = |p: &mut Self, word: &str, scalar: Scalar| {
            if p.s[p.i..].starts_with(word.as_bytes()) {
                p.i += word.len();
                p.printed.push_str(word);
                Ok(scalar)
            } else {
                Err(())
            }
        };
        match self.peek() {
            Some(b'"') => {
                self.string()?;
                Ok(Scalar::String(self.decoded.clone()))
            }
            Some(b't') => word(self, "true", Scalar::Bool(true)),
            Some(b'f') => word(self, "false", Scalar::Bool(false)),
            Some(b'n') => word(self, "null", Scalar::Null),
            Some(b'-' | b'0'..=b'9') => self.number(),
            _ => Err(()),
        }
    }

    /// A string, printed as `JSON.stringify` escapes it: `"`, `\\` and
    /// control characters escaped, a lone surrogate as `\\udxxx`, everything
    /// else as itself.
    fn string(&mut self) -> Result<(), ()> {
        self.printed.clear();
        self.decoded.clear();
        self.eat(b'"')?;
        self.printed.push('"');
        loop {
            let run = self.s[self.i..]
                .iter()
                .position(|&b| b == b'"' || b == b'\\' || b < 0x20)
                .ok_or(())?;
            // The run stops only at ASCII, so it ends on a character boundary
            let plain = &self.text[self.i..self.i + run];
            self.printed.push_str(plain);
            self.decoded.push_str(plain);
            self.i += run;
            match self.s[self.i] {
                b'"' => {
                    self.i += 1;
                    self.printed.push('"');
                    return Ok(());
                }
                b'\\' => {
                    self.i += 1;
                    let escape = self.peek().ok_or(())?;
                    self.i += 1;
                    let unit = match escape {
                        b'"' => u32::from(b'"'),
                        b'\\' => u32::from(b'\\'),
                        b'/' => u32::from(b'/'),
                        b'b' => 0x8,
                        b'f' => 0xc,
                        b'n' => 0xa,
                        b'r' => 0xd,
                        b't' => 0x9,
                        b'u' => self.hex4()?,
                        _ => return Err(()),
                    };
                    let decoded = if (0xd800..0xdc00).contains(&unit)
                        && self.s[self.i..].starts_with(b"\\u")
                    {
                        let save = self.i;
                        self.i += 2;
                        let low = self.hex4()?;
                        if (0xdc00..0xe000).contains(&low) {
                            char::from_u32(0x10000 + ((unit - 0xd800) << 10) + (low - 0xdc00))
                        } else {
                            self.i = save;
                            None
                        }
                    } else {
                        char::from_u32(unit)
                    };
                    match decoded {
                        Some(c) => {
                            let mut buf = [0u8; 4];
                            let one =
                                js::stringify(&Value::String(c.encode_utf8(&mut buf).to_owned()));
                            self.printed.push_str(&one[1..one.len() - 1]);
                            self.decoded.push(c);
                        }
                        None => {
                            // A lone surrogate: well-formed JSON.stringify
                            // escapes it, and better-sqlite3 binds it as U+FFFD
                            self.printed.push_str(&format!("\\u{unit:04x}"));
                            self.decoded.push('\u{fffd}');
                        }
                    }
                }
                _ => return Err(()),
            }
        }
    }

    fn hex4(&mut self) -> Result<u32, ()> {
        let digits = self.s.get(self.i..self.i + 4).ok_or(())?;
        if !digits.iter().all(u8::is_ascii_hexdigit) {
            return Err(());
        }
        let text = std::str::from_utf8(digits).map_err(|_| ())?;
        self.i += 4;
        u32::from_str_radix(text, 16).map_err(|_| ())
    }

    fn number(&mut self) -> Result<Scalar, ()> {
        let start = self.i;
        let digits = |c: &mut Self| {
            let from = c.i;
            while matches!(c.peek(), Some(b'0'..=b'9')) {
                c.i += 1;
            }
            c.i - from
        };
        if self.peek() == Some(b'-') {
            self.i += 1;
        }
        let int_start = self.i;
        let int = digits(self);
        if int == 0 || (int > 1 && self.s[int_start] == b'0') {
            return Err(());
        }
        let mut plain = true;
        if self.peek() == Some(b'.') {
            self.i += 1;
            plain = false;
            if digits(self) == 0 {
                return Err(());
            }
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.i += 1;
            plain = false;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.i += 1;
            }
            if digits(self) == 0 {
                return Err(());
            }
        }
        let literal = &self.text[start..self.i];
        let n: f64 = literal.parse().map_err(|_| ())?;
        // An integer of up to 15 digits is exact in a double and prints as written
        if plain && int <= 15 && literal != "-0" {
            self.printed.push_str(literal);
        } else {
            self.printed.push_str(&js::number_to_string(n));
        }
        Ok(Scalar::Number(literal.to_owned(), n))
    }
}

/// `JSON.stringify(JSON.parse(text))`, with `owner` assigned to a top-level
/// object's `_ownerPuuid`. Text is written as it parses; an object with a
/// repeated key or an array-index key is laid out again when it closes,
/// with index keys first in ascending order, as `js::stringify` orders them,
/// and a repeated key at its first place with its last value.
pub(crate) struct Stringified<'a> {
    pub(crate) text: String,
    /// A top level that is not an object or an array.
    top: Option<Scalar>,
    owner: Option<&'a Value>,
    open: Vec<Open>,
}

enum Open {
    Array {
        empty: bool,
    },
    Object {
        start: usize,
        members: Vec<Member>,
        relayout: bool,
        owner: bool,
    },
}

struct Member {
    key: std::ops::Range<usize>,
    value: std::ops::Range<usize>,
    index: Option<u32>,
    hash: u64,
}

impl<'a> Stringified<'a> {
    pub(crate) fn new(owner: Option<&'a Value>) -> Self {
        Self {
            text: String::new(),
            top: None,
            owner,
            open: Vec::new(),
        }
    }

    fn before_value(&mut self) {
        if let Some(Open::Array { empty }) = self.open.last_mut() {
            if !*empty {
                self.text.push(',');
            }
            *empty = false;
        }
    }

    fn after_value(&mut self) {
        let end = self.text.len();
        if let Some(Open::Object { members, owner, .. }) = self.open.last_mut()
            && let Some(member) = members.last_mut()
        {
            member.value.end = end;
            let key = &self.text[member.key.clone()];
            if *owner && key == "\"_ownerPuuid\"" {
                self.text.truncate(member.value.start);
                self.text
                    .push_str(&js::stringify(self.owner.unwrap_or(&Value::Null)));
                member.value.end = self.text.len();
            }
        }
    }

    fn close_object(
        &mut self,
        start: usize,
        mut members: Vec<Member>,
        relayout: bool,
        owner: bool,
    ) {
        if owner
            && !members
                .iter()
                .any(|m| &self.text[m.key.clone()] == "\"_ownerPuuid\"")
        {
            if !members.is_empty() {
                self.text.push(',');
            }
            let key = self.text.len();
            self.text.push_str("\"_ownerPuuid\"");
            let colon = self.text.len();
            self.text.push(':');
            self.text
                .push_str(&js::stringify(self.owner.unwrap_or(&Value::Null)));
            members.push(Member {
                key: key..colon,
                value: colon + 1..self.text.len(),
                index: None,
                hash: 0,
            });
        }
        if !relayout {
            self.text.push('}');
            return;
        }
        let text = &self.text;
        let mut slots: Vec<&Member> = Vec::with_capacity(members.len());
        let mut seen: HashMap<&str, usize> = HashMap::with_capacity(members.len());
        let mut values: Vec<std::ops::Range<usize>> = Vec::with_capacity(members.len());
        for member in &members {
            match seen.entry(&text[member.key.clone()]) {
                std::collections::hash_map::Entry::Occupied(slot) => {
                    values[*slot.get()] = member.value.clone();
                }
                std::collections::hash_map::Entry::Vacant(slot) => {
                    slot.insert(slots.len());
                    slots.push(member);
                    values.push(member.value.clone());
                }
            }
        }
        let mut order: Vec<usize> = (0..slots.len()).collect();
        // Stable, so named keys keep their first places after the index keys
        order.sort_by_key(|&i| slots[i].index.map_or((1, 0), |n| (0, n)));
        let mut laid = String::with_capacity(text.len() - start + 1);
        laid.push('{');
        for (n, &i) in order.iter().enumerate() {
            if n > 0 {
                laid.push(',');
            }
            laid.push_str(&text[slots[i].key.clone()]);
            laid.push(':');
            laid.push_str(&text[values[i].clone()]);
        }
        laid.push('}');
        self.text.truncate(start);
        self.text.push_str(&laid);
    }
}

impl JsonEvents for Stringified<'_> {
    fn open(&mut self, object: bool) {
        self.before_value();
        if object {
            let owner = self.open.is_empty() && self.owner.is_some();
            self.open.push(Open::Object {
                start: self.text.len(),
                members: Vec::new(),
                relayout: false,
                owner,
            });
            self.text.push('{');
        } else {
            self.open.push(Open::Array { empty: true });
            self.text.push('[');
        }
    }

    fn key(&mut self, printed: &str, decoded: &str) {
        let Some(Open::Object {
            members, relayout, ..
        }) = self.open.last_mut()
        else {
            return;
        };
        if !members.is_empty() {
            self.text.push(',');
        }
        let key = self.text.len();
        self.text.push_str(printed);
        let colon = self.text.len();
        self.text.push(':');
        let index = js::array_index(decoded);
        // A printed key is one-to-one with the key it decodes to
        let hash = fnv1a(printed.as_bytes());
        let repeated = members
            .iter()
            .any(|m| m.hash == hash && self.text[m.key.clone()] == *printed);
        *relayout |= index.is_some() || repeated;
        members.push(Member {
            key: key..colon,
            value: colon + 1..colon + 1,
            index,
            hash,
        });
    }

    fn scalar(&mut self, printed: &str, scalar: Scalar) {
        if self.open.is_empty() {
            self.top = Some(scalar);
        }
        self.before_value();
        self.text.push_str(printed);
        self.after_value();
    }

    fn close(&mut self) {
        match self.open.pop() {
            Some(Open::Array { .. }) => self.text.push(']'),
            Some(Open::Object {
                start,
                members,
                relayout,
                owner,
            }) => self.close_object(start, members, relayout, owner),
            None => {}
        }
        self.after_value();
    }
}

fn fnv1a(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325, |hash, &b| {
        (hash ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3)
    })
}

/// The tree `JSON.parse` builds, as serde_json holds one: a lone surrogate
/// as U+FFFD and a number past a double's range as null. A value nested
/// deeper than [`TREE_DEPTH`] is null; no field this app reads is that deep.
#[derive(Default)]
pub(crate) struct Tree {
    pub(crate) root: Option<Value>,
    open: Vec<(Value, Option<String>)>,
    /// Levels open below the depth the tree keeps.
    skipped: usize,
}

pub(crate) const TREE_DEPTH: usize = 512;

impl Tree {
    fn insert(&mut self, value: Value) {
        match self.open.last_mut() {
            None => self.root = Some(value),
            Some((Value::Object(map), key)) => {
                map.insert(key.take().unwrap_or_default(), value);
            }
            Some((Value::Array(items), _)) => items.push(value),
            Some(_) => {}
        }
    }
}

impl JsonEvents for Tree {
    fn open(&mut self, object: bool) {
        if self.skipped > 0 || self.open.len() >= TREE_DEPTH {
            self.skipped += 1;
            return;
        }
        let container = if object {
            Value::Object(Map::new())
        } else {
            Value::Array(Vec::new())
        };
        self.open.push((container, None));
    }

    fn key(&mut self, _printed: &str, decoded: &str) {
        if self.skipped == 0
            && let Some((_, key)) = self.open.last_mut()
        {
            *key = Some(decoded.to_owned());
        }
    }

    fn scalar(&mut self, _printed: &str, scalar: Scalar) {
        if self.skipped == 0 {
            self.insert(scalar.value());
        }
    }

    fn close(&mut self) {
        if self.skipped > 0 {
            self.skipped -= 1;
            if self.skipped == 0 {
                self.insert(Value::Null);
            }
            return;
        }
        if let Some((container, _)) = self.open.pop() {
            self.insert(container);
        }
    }
}

impl<A: JsonEvents, B: JsonEvents> JsonEvents for (A, B) {
    fn open(&mut self, object: bool) {
        self.0.open(object);
        self.1.open(object);
    }

    fn key(&mut self, printed: &str, decoded: &str) {
        self.0.key(printed, decoded);
        self.1.key(printed, decoded);
    }

    fn scalar(&mut self, printed: &str, scalar: Scalar) {
        self.0.scalar(printed, scalar.clone());
        self.1.scalar(printed, scalar);
    }

    fn close(&mut self) {
        self.0.close();
        self.1.close();
    }
}

/// A column as better-sqlite3 hands it to `JSON.stringify`.
fn row_value(v: ValueRef<'_>) -> Value {
    cell_value(Cell::read(v))
}

fn cell_value(cell: Cell) -> Value {
    match cell {
        Cell::Null => Value::Null,
        Cell::Number(n) => Number::from_f64(n).map_or(Value::Null, Value::Number),
        Cell::Text(s) => Value::String(s),
        // Buffer.prototype.toJSON
        Cell::Blob(bytes) => serde_json::json!({ "type": "Buffer", "data": bytes }),
    }
}

/// A Node `fs` error's message: `ENOENT: no such file or directory, open '<path>'`.
pub fn node_error(err: &io::Error, syscall: &str, path: Option<&Path>) -> String {
    use io::ErrorKind::*;
    let (code, text) = match err.kind() {
        NotFound => ("ENOENT", "no such file or directory"),
        PermissionDenied if cfg!(windows) => ("EPERM", "operation not permitted"),
        PermissionDenied => ("EACCES", "permission denied"),
        IsADirectory => ("EISDIR", "illegal operation on a directory"),
        NotADirectory => ("ENOTDIR", "not a directory"),
        AlreadyExists => ("EEXIST", "file already exists"),
        StorageFull => ("ENOSPC", "no space left on device"),
        ReadOnlyFilesystem => ("EROFS", "read-only file system"),
        InvalidFilename => ("ENAMETOOLONG", "name too long"),
        ResourceBusy => ("EBUSY", "resource busy or locked"),
        _ => ("UNKNOWN", "unknown error"),
    };
    match path {
        Some(path) => format!("{code}: {text}, {syscall} '{}'", path.display()),
        None => format!("{code}: {text}, {syscall}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// `BMT_GOLDEN_DIR` and `BMT_GOLDEN_DATA` name T05's goldens and the
    /// fixture they were recorded on, as for golden replay. Without them the
    /// test has nothing to compare and passes.
    #[test]
    fn the_fixture_exports_byte_for_byte_as_electron_wrote_it() {
        let (Some(golden), Some(data)) = (
            std::env::var_os("BMT_GOLDEN_DIR"),
            std::env::var_os("BMT_GOLDEN_DATA"),
        ) else {
            eprintln!("no goldens: set BMT_GOLDEN_DIR and BMT_GOLDEN_DATA");
            return;
        };
        let record: Value = serde_json::from_str(
            &std::fs::read_to_string(Path::new(&golden).join("ipc/data.export/export.json"))
                .unwrap(),
        )
        .unwrap();
        let want = record["files"][0]["text"].as_str().unwrap();

        let dir = std::env::temp_dir().join(format!("bmt-export-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::copy(Path::new(&data).join("matches.db"), dir.join("matches.db")).unwrap();
        let db = Database::open(&dir, 0).unwrap();
        let out = dir.join("export.json");
        assert_eq!(write_export_to(&db, &out), Ok(669));
        let got = std::fs::read(&out).unwrap();
        db.close();
        std::fs::remove_dir_all(&dir).ok();
        assert_eq!(got.len(), want.len());
        assert!(got == want.as_bytes(), "the export differs from Electron's");
    }

    #[test]
    fn payloads_print_as_json_stringify_prints_them() {
        // Outputs from Node: JSON.stringify(Object.assign(JSON.parse(t), { _ownerPuuid: "me" }))
        let cases = [
            (r##"{}"##, r##"{"_ownerPuuid":"me"}"##),
            (
                r##" {"a" : 1 , "b":[ ]}
"##,
                r##"{"a":1,"b":[],"_ownerPuuid":"me"}"##,
            ),
            (
                r##"{"_ownerPuuid":"old","z":1}"##,
                r##"{"_ownerPuuid":"me","z":1}"##,
            ),
            (
                r##"{"n":[1.0,1e2,1E400,-0,0.1,123456789012345678,-5e-7,1.5e21,0e0]}"##,
                r##"{"n":[1,100,null,0,0.1,123456789012345680,-5e-7,1.5e+21,0],"_ownerPuuid":"me"}"##,
            ),
            (
                r##"{"s":"\u00e9\/\"\\\b\f\n\r\t\u0001\u001f\u2028"}"##,
                r##"{"s":"é/\"\\\b\f\n\r\t\u0001\u001f ","_ownerPuuid":"me"}"##,
            ),
            (
                r##"{"s":"\ud83d\ude00 \ud800 \udc00x \ud800\u0041"}"##,
                r##"{"s":"😀 \ud800 \udc00x \ud800A","_ownerPuuid":"me"}"##,
            ),
            (
                r##"{"5":1,"a":2}"##,
                r##"{"5":1,"a":2,"_ownerPuuid":"me"}"##,
            ),
            (r##"{"a":1,"a":2}"##, r##"{"a":2,"_ownerPuuid":"me"}"##),
            (r##"[1,{"x":2}]"##, r##"[1,{"x":2}]"##),
            (
                r##"{"a":{"b":{"c":[true,false,null]}}}"##,
                r##"{"a":{"b":{"c":[true,false,null]}},"_ownerPuuid":"me"}"##,
            ),
            (r##"{"é":"ü"}"##, r##"{"é":"ü","_ownerPuuid":"me"}"##),
        ];
        for (text, want) in cases {
            let got = exported_game(
                Some(&crate::db::payloads::gzip(text.as_bytes())),
                json!("me"),
            );
            assert_eq!(got, Ok(Some(want.to_owned())), "{text}");
        }
        for bad in [
            r#"{"a":01}"#,
            r#"{"a":1,}"#,
            "{\"a\":\"\t\"}",
            r#"{"a":.5}"#,
            r#"{"a":1.}"#,
            "{'a':1}",
            r#"{"a":"\x"}"#,
            r#"{"a":1} x"#,
            r#"{"a":-}"#,
            r#"{"a":tru}"#,
            "null",
            "0",
            "\"\"",
            "false",
        ] {
            let got = exported_game(
                Some(&crate::db::payloads::gzip(bad.as_bytes())),
                json!("me"),
            );
            assert_eq!(got, Ok(None), "{bad}");
        }
        assert_eq!(exported_game(Some(b"not gzip"), json!("me")), Ok(None));
        assert_eq!(
            exported_game(Some(&crate::db::payloads::gzip(b"7")), json!("me")),
            Err("Cannot create property '_ownerPuuid' on number '7'".into())
        );
    }

    /// Payloads Electron reads with JSON.parse and serde_json can't: a lone
    /// surrogate beside an index key, and nesting past 128. Outputs from
    /// Node 26: JSON.stringify(Object.assign(JSON.parse(t), { _ownerPuuid: "me" })).
    #[test]
    fn payloads_past_serde_json_print_as_json_stringify_prints_them() {
        let deep = |n: usize| format!("{}{}", "[".repeat(n), "]".repeat(n));
        let cases = [
            (
                r#"{"b":"\ud800","1":"a"}"#.to_owned(),
                r#"{"1":"a","b":"\ud800","_ownerPuuid":"me"}"#.to_owned(),
            ),
            (
                r#"{"a":1,"2":{"x":"\ud800"}}"#.to_owned(),
                r#"{"2":{"x":"\ud800"},"a":1,"_ownerPuuid":"me"}"#.to_owned(),
            ),
            (
                r#"{"b":1,"10":"ten","2":"two","0":"zero","01":"lead","4294967295":"big","4294967294":"max","-1":"neg","1.5":"f"}"#.to_owned(),
                r#"{"0":"zero","2":"two","10":"ten","4294967294":"max","b":1,"01":"lead","4294967295":"big","-1":"neg","1.5":"f","_ownerPuuid":"me"}"#.to_owned(),
            ),
            (
                r#"{"a":1,"b":2,"a":3,"_ownerPuuid":"x","_ownerPuuid":"y"}"#.to_owned(),
                r#"{"a":3,"b":2,"_ownerPuuid":"me"}"#.to_owned(),
            ),
            (
                r#"{"3":1,"3":2,"x":{"9":1,"a":2,"9":3}}"#.to_owned(),
                r#"{"3":2,"x":{"9":3,"a":2},"_ownerPuuid":"me"}"#.to_owned(),
            ),
            (
                r#"[{"2":1,"a":"\ud800"}]"#.to_owned(),
                r#"[{"2":1,"a":"\ud800"}]"#.to_owned(),
            ),
            (
                format!(r#"{{"deep":{}}}"#, deep(130)),
                format!(r#"{{"deep":{},"_ownerPuuid":"me"}}"#, deep(130)),
            ),
            (
                format!(r#"{{"deep":{}}}"#, deep(100_000)),
                format!(r#"{{"deep":{},"_ownerPuuid":"me"}}"#, deep(100_000)),
            ),
        ];
        for (text, want) in cases {
            let got = exported_game(
                Some(&crate::db::payloads::gzip(text.as_bytes())),
                json!("me"),
            );
            assert_eq!(got, Ok(Some(want)), "{}", &text[..text.len().min(80)]);
        }
    }

    #[test]
    fn the_owner_goes_where_assignment_puts_it() {
        let export = |text: &str| {
            exported_game(
                Some(&crate::db::payloads::gzip(text.as_bytes())),
                json!("me"),
            )
        };
        assert_eq!(
            export(r#"{"gameId":1,"_ownerPuuid":"old","z":0}"#),
            Ok(Some(r#"{"gameId":1,"_ownerPuuid":"me","z":0}"#.into()))
        );
        assert_eq!(export("[1,2]"), Ok(Some("[1,2]".into())));
        assert_eq!(
            export("1.5e300"),
            Err("Cannot create property '_ownerPuuid' on number '1.5e+300'".into())
        );
        assert_eq!(
            export(r#""ab""#),
            Err("Cannot create property '_ownerPuuid' on string 'ab'".into())
        );
        assert_eq!(
            export("true"),
            Err("Cannot create property '_ownerPuuid' on boolean 'true'".into())
        );
    }

    #[test]
    fn columns_stringify_as_better_sqlite3_hands_them_over() {
        assert_eq!(
            js::stringify(&cell_value(Cell::Blob(vec![1, 255]))),
            r#"{"type":"Buffer","data":[1,255]}"#
        );
        assert_eq!(js::stringify(&cell_value(Cell::Number(5.0))), "5");
        assert_eq!(
            js::stringify(&cell_value(Cell::Number(f64::INFINITY))),
            "null"
        );
    }

    #[test]
    fn fs_errors_read_as_node_writes_them() {
        let err = File::open("/no/such/file").unwrap_err();
        assert_eq!(
            node_error(&err, "open", Some(Path::new("/no/such/file"))),
            "ENOENT: no such file or directory, open '/no/such/file'"
        );
    }
}
