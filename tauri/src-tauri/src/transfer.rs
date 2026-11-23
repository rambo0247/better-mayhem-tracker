//! `writeExportTo` in `src/main/db/transfer.ts`: the whole library as one
//! JSON file, format version 3, byte for byte what Electron writes. Games
//! are read a page at a time and written straight to disk, and the database
//! is free between pages, as Electron's event loop is between its awaits.

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
/// row, or `None` where `unpackRaw` gives nothing truthy. The text is
/// rewritten in one pass into the form `JSON.stringify` prints, which is
/// what it already is when Electron stored it, so no tree is built. A shape
/// that pass leaves to JavaScript's object rules (a repeated key, a key
/// that is an array index) or a top level that is not an object or array
/// goes through the parsed tree instead.
fn exported_game(blob: Option<&[u8]>, owner: Value) -> Result<Option<String>, String> {
    let mut bytes = Vec::new();
    let Some(blob) = blob else {
        return Ok(None);
    };
    if MultiGzDecoder::new(blob).read_to_end(&mut bytes).is_err() {
        return Ok(None);
    }
    let text = String::from_utf8_lossy(&bytes);
    match Canonical::rewrite(&text, &owner) {
        Ok(out) => return Ok(Some(out)),
        Err(Rewrite::Invalid) => return Ok(None),
        Err(Rewrite::Tree) => {}
    }
    let Some(mut game) = serde_json::from_str::<Value>(&text)
        .ok()
        .filter(|g| js::truthy(Some(g)))
    else {
        return Ok(None);
    };
    set_owner(&mut game, owner)?;
    Ok(Some(js::stringify(&game)))
}

enum Rewrite {
    /// Not JSON, so `unpackRaw` answers null.
    Invalid,
    /// JSON whose canonical form needs JavaScript's object model.
    Tree,
}

/// Deeper than this goes through the tree, and so meets serde_json's own limit.
const MAX_DEPTH: usize = 100;

/// ECMA-404 JSON rewritten as `JSON.stringify(JSON.parse(text))` prints it.
struct Canonical<'a> {
    text: &'a str,
    s: &'a [u8],
    i: usize,
    out: String,
}

impl<'a> Canonical<'a> {
    fn rewrite(text: &'a str, owner: &Value) -> Result<String, Rewrite> {
        let mut c = Canonical {
            text,
            s: text.as_bytes(),
            i: 0,
            out: String::with_capacity(text.len() + 64),
        };
        c.ws();
        match c.peek() {
            Some(b'{') => c.object(0, Some(owner))?,
            Some(b'[') => c.array(0)?,
            Some(_) => {
                // A primitive is falsy or throws on the assignment; the tree
                // path tells which, and says it as V8 does
                c.value(0)?;
                c.ws();
                return if c.i == c.s.len() {
                    Err(Rewrite::Tree)
                } else {
                    Err(Rewrite::Invalid)
                };
            }
            None => return Err(Rewrite::Invalid),
        }
        c.ws();
        if c.i != c.s.len() {
            return Err(Rewrite::Invalid);
        }
        Ok(c.out)
    }

    fn peek(&self) -> Option<u8> {
        self.s.get(self.i).copied()
    }

    fn ws(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.i += 1;
        }
    }

    fn eat(&mut self, b: u8) -> Result<(), Rewrite> {
        if self.peek() == Some(b) {
            self.i += 1;
            Ok(())
        } else {
            Err(Rewrite::Invalid)
        }
    }

    fn value(&mut self, depth: usize) -> Result<(), Rewrite> {
        if depth > MAX_DEPTH {
            return Err(Rewrite::Tree);
        }
        match self.peek() {
            Some(b'{') => self.object(depth, None),
            Some(b'[') => self.array(depth),
            Some(b'"') => self.string(),
            Some(b't') => self.literal("true"),
            Some(b'f') => self.literal("false"),
            Some(b'n') => self.literal("null"),
            Some(b'-' | b'0'..=b'9') => self.number(),
            _ => Err(Rewrite::Invalid),
        }
    }

    fn literal(&mut self, word: &str) -> Result<(), Rewrite> {
        if self.s[self.i..].starts_with(word.as_bytes()) {
            self.i += word.len();
            self.out.push_str(word);
            Ok(())
        } else {
            Err(Rewrite::Invalid)
        }
    }

    fn array(&mut self, depth: usize) -> Result<(), Rewrite> {
        self.eat(b'[')?;
        self.out.push('[');
        self.ws();
        if self.peek() == Some(b']') {
            self.i += 1;
            self.out.push(']');
            return Ok(());
        }
        loop {
            self.ws();
            self.value(depth + 1)?;
            self.ws();
            match self.peek() {
                Some(b',') => {
                    self.i += 1;
                    self.out.push(',');
                }
                Some(b']') => {
                    self.i += 1;
                    self.out.push(']');
                    return Ok(());
                }
                _ => return Err(Rewrite::Invalid),
            }
        }
    }

    /// `owner` is set for the top-level object, which takes `_ownerPuuid`
    /// where its key already is, or last.
    fn object(&mut self, depth: usize, owner: Option<&Value>) -> Result<(), Rewrite> {
        self.eat(b'{')?;
        self.out.push('{');
        // Each key by a hash of its canonical text, which is one-to-one with
        // the decoded key. Equal hashes send the payload to the tree, which
        // is right for a true repeat and only slower for a collision
        let mut keys: Vec<u64> = Vec::new();
        let mut owner_written = false;
        self.ws();
        if self.peek() == Some(b'}') {
            self.i += 1;
        } else {
            loop {
                self.ws();
                if self.peek() != Some(b'"') {
                    return Err(Rewrite::Invalid);
                }
                if !keys.is_empty() {
                    self.out.push(',');
                }
                let start = self.out.len();
                self.string()?;
                let key = &self.out[start + 1..self.out.len() - 1];
                let hash = fnv1a(key.as_bytes());
                if is_array_index(key) || keys.contains(&hash) {
                    return Err(Rewrite::Tree);
                }
                let is_owner = key == "_ownerPuuid";
                self.ws();
                self.eat(b':')?;
                self.out.push(':');
                self.ws();
                if let Some(owner) = owner.filter(|_| is_owner) {
                    let at = self.out.len();
                    self.value(depth + 1)?;
                    self.out.truncate(at);
                    self.out.push_str(&js::stringify(owner));
                    owner_written = true;
                } else {
                    self.value(depth + 1)?;
                }
                keys.push(hash);
                self.ws();
                match self.peek() {
                    Some(b',') => self.i += 1,
                    Some(b'}') => {
                        self.i += 1;
                        break;
                    }
                    _ => return Err(Rewrite::Invalid),
                }
            }
        }
        if let Some(owner) = owner.filter(|_| !owner_written) {
            if !keys.is_empty() {
                self.out.push(',');
            }
            self.out.push_str("\"_ownerPuuid\":");
            self.out.push_str(&js::stringify(owner));
        }
        self.out.push('}');
        Ok(())
    }

    /// A string, written as `JSON.stringify` escapes it: `"`, `\\` and
    /// control characters escaped, a lone surrogate as `\\udxxx`, everything
    /// else as itself.
    fn string(&mut self) -> Result<(), Rewrite> {
        self.eat(b'"')?;
        self.out.push('"');
        loop {
            let run = self.s[self.i..]
                .iter()
                .position(|&b| b == b'"' || b == b'\\' || b < 0x20)
                .ok_or(Rewrite::Invalid)?;
            // The run stops only at ASCII, so it ends on a character boundary
            self.out.push_str(&self.text[self.i..self.i + run]);
            self.i += run;
            match self.s[self.i] {
                b'"' => {
                    self.i += 1;
                    self.out.push('"');
                    return Ok(());
                }
                b'\\' => {
                    self.i += 1;
                    let escape = self.peek().ok_or(Rewrite::Invalid)?;
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
                        _ => return Err(Rewrite::Invalid),
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
                            self.out.push_str(&one[1..one.len() - 1]);
                        }
                        None => {
                            // A lone surrogate: well-formed JSON.stringify escapes it
                            self.out.push_str(&format!("\\u{unit:04x}"));
                        }
                    }
                }
                _ => return Err(Rewrite::Invalid),
            }
        }
    }

    fn hex4(&mut self) -> Result<u32, Rewrite> {
        let digits = self.s.get(self.i..self.i + 4).ok_or(Rewrite::Invalid)?;
        let text = std::str::from_utf8(digits).map_err(|_| Rewrite::Invalid)?;
        if !text.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(Rewrite::Invalid);
        }
        self.i += 4;
        u32::from_str_radix(text, 16).map_err(|_| Rewrite::Invalid)
    }

    fn number(&mut self) -> Result<(), Rewrite> {
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
            return Err(Rewrite::Invalid);
        }
        let mut plain = true;
        if self.peek() == Some(b'.') {
            self.i += 1;
            plain = false;
            if digits(self) == 0 {
                return Err(Rewrite::Invalid);
            }
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.i += 1;
            plain = false;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.i += 1;
            }
            if digits(self) == 0 {
                return Err(Rewrite::Invalid);
            }
        }
        let literal = &self.text[start..self.i];
        // An integer of up to 15 digits is exact in a double and prints as written
        if plain && int <= 15 && literal != "-0" {
            self.out.push_str(literal);
        } else {
            let n: f64 = literal.parse().map_err(|_| Rewrite::Invalid)?;
            self.out.push_str(&js::number_to_string(n));
        }
        Ok(())
    }
}

fn fnv1a(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325, |hash, &b| {
        (hash ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3)
    })
}

/// A key JavaScript orders before the others: a canonical array index.
fn is_array_index(key: &str) -> bool {
    !key.is_empty()
        && key.bytes().all(|b| b.is_ascii_digit())
        && (key == "0" || !key.starts_with('0'))
        && key.parse::<u64>().is_ok_and(|n| n < u64::from(u32::MAX))
}

/// `game._ownerPuuid = row.puuid` in strict mode. An array takes the
/// property and `JSON.stringify` drops it; any other primitive throws.
fn set_owner(game: &mut Value, owner: Value) -> Result<(), String> {
    let (kind, shown) = match game {
        Value::Object(map) => {
            map.insert("_ownerPuuid".into(), owner);
            return Ok(());
        }
        Value::Array(_) => return Ok(()),
        Value::Number(n) => (
            "number",
            js::number_to_string(n.as_f64().unwrap_or(f64::NAN)),
        ),
        Value::String(s) => ("string", s.clone()),
        Value::Bool(b) => ("boolean", b.to_string()),
        Value::Null => return Ok(()),
    };
    Err(format!(
        "Cannot create property '_ownerPuuid' on {kind} '{shown}'"
    ))
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
        std::fs::copy(
            Path::new(&data).join("data/matches.db"),
            dir.join("matches.db"),
        )
        .unwrap();
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

    #[test]
    fn the_owner_goes_where_assignment_puts_it() {
        let mut game = json!({ "gameId": 1, "_ownerPuuid": "old", "z": 0 });
        set_owner(&mut game, json!("me")).unwrap();
        assert_eq!(
            js::stringify(&game),
            r#"{"gameId":1,"_ownerPuuid":"me","z":0}"#
        );
        let mut list = json!([1, 2]);
        set_owner(&mut list, json!("me")).unwrap();
        assert_eq!(js::stringify(&list), "[1,2]");
        assert_eq!(
            set_owner(&mut json!(1.5e300), json!("me")).unwrap_err(),
            "Cannot create property '_ownerPuuid' on number '1.5e+300'"
        );
        assert_eq!(
            set_owner(&mut json!("ab"), json!("me")).unwrap_err(),
            "Cannot create property '_ownerPuuid' on string 'ab'"
        );
        assert_eq!(
            set_owner(&mut json!(true), json!("me")).unwrap_err(),
            "Cannot create property '_ownerPuuid' on boolean 'true'"
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
