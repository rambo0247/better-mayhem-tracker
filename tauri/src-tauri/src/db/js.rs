//! The JavaScript semantics the database code leans on: property reads that
//! throw on `null`, `||` and `??` over parsed JSON, `JSON.stringify`, and how
//! better-sqlite3 binds and returns values and runs transactions. `None` is
//! `undefined`.

use std::borrow::Cow;

use rusqlite::Connection;
use rusqlite::types::{Value as Sql, ValueRef};
use serde_json::Value;

/// The `TypeError` reading a property of `null` or `undefined` throws.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TypeError(pub String);

impl std::fmt::Display for TypeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for TypeError {}

/// A JavaScript throw, carried out through a rusqlite call chain.
pub fn thrown(err: TypeError) -> rusqlite::Error {
    rusqlite::Error::ToSqlConversionFailure(Box::new(err))
}

/// `v.key`. Only objects carry the keys this code reads, so any other value
/// answers `undefined`.
pub fn prop<'a>(v: Option<&'a Value>, key: &str) -> Result<Option<&'a Value>, TypeError> {
    match v {
        None | Some(Value::Null) => Err(TypeError(format!(
            "Cannot read properties of {} (reading '{key}')",
            if v.is_none() { "undefined" } else { "null" }
        ))),
        Some(Value::Object(map)) => Ok(map.get(key)),
        Some(_) => Ok(None),
    }
}

/// `v?.key`.
pub fn opt_prop<'a>(v: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    prop(v, key).ok().flatten()
}

/// `v[i]` for an array, `v["i"]` for an object.
pub fn index(v: Option<&Value>, i: usize) -> Option<&Value> {
    match v? {
        Value::Array(items) => items.get(i),
        Value::Object(map) => map.get(&i.to_string()),
        _ => None,
    }
}

pub fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(_) | Value::Object(_)) => true,
    }
}

/// `a || b || ...`: the first truthy operand, else the last one.
pub fn or<'a>(operands: &[Option<&'a Value>]) -> Option<&'a Value> {
    operands
        .iter()
        .copied()
        .find(|v| truthy(*v))
        .unwrap_or_else(|| operands.last().copied().flatten())
}

/// `a ?? b ?? ...`: the first operand that is neither `null` nor `undefined`.
pub fn nullish<'a>(operands: &[Option<&'a Value>]) -> Option<&'a Value> {
    operands
        .iter()
        .copied()
        .find(|v| !matches!(v, None | Some(Value::Null)))
        .flatten()
}

/// The value when it is a JavaScript number.
pub fn number(v: Option<&Value>) -> Option<f64> {
    v.and_then(Value::as_f64)
}

/// The value when it is a string.
pub fn string(v: Option<&Value>) -> Option<&str> {
    v.and_then(Value::as_str)
}

/// How better-sqlite3 binds a JavaScript value: every number as a double,
/// which an `INTEGER` column stores as an integer when it is whole, and
/// `undefined` as `NULL`. Anything else is the `TypeError` it throws.
pub fn bind(v: Option<&Value>) -> rusqlite::Result<Sql> {
    match v {
        None | Some(Value::Null) => Ok(Sql::Null),
        Some(Value::Number(n)) => Ok(Sql::Real(n.as_f64().unwrap_or(f64::NAN))),
        Some(Value::String(s)) => Ok(Sql::Text(s.clone())),
        Some(_) => Err(thrown(TypeError(
            "SQLite3 can only bind numbers, strings, bigints, buffers, and null".into(),
        ))),
    }
}

/// better-sqlite3's `db.transaction(f)()`: `BEGIN` and `COMMIT` in
/// autocommit, a savepoint inside an open transaction. An import holds 50
/// inserts in one transaction, and a throw in one insert undoes only that
/// insert. The error propagates either way.
pub fn transaction<T>(
    conn: &Connection,
    f: impl FnOnce() -> rusqlite::Result<T>,
) -> rusqlite::Result<T> {
    let (begin, commit, undo) = if conn.is_autocommit() {
        ("BEGIN", "COMMIT", "ROLLBACK")
    } else {
        (
            "SAVEPOINT `\t_bs3.`",
            "RELEASE `\t_bs3.`",
            "ROLLBACK TO `\t_bs3.`",
        )
    };
    conn.execute_batch(begin)?;
    let result = f().and_then(|value| conn.execute_batch(commit).map(|()| value));
    if result.is_err() && !conn.is_autocommit() {
        conn.execute_batch(undo)?;
        if undo != "ROLLBACK" {
            conn.execute_batch(commit)?;
        }
    }
    result
}

/// A column as better-sqlite3 hands it to JavaScript, reduced to what `===`
/// compares: integers and reals are both numbers.
#[derive(Debug, Clone, PartialEq)]
pub enum Cell {
    Null,
    Number(f64),
    Text(String),
    Blob(Vec<u8>),
}

impl Cell {
    pub fn read(v: ValueRef<'_>) -> Self {
        match v {
            ValueRef::Null => Cell::Null,
            ValueRef::Integer(i) => Cell::Number(i as f64),
            ValueRef::Real(f) => Cell::Number(f),
            ValueRef::Text(t) => Cell::Text(String::from_utf8_lossy(t).into_owned()),
            ValueRef::Blob(b) => Cell::Blob(b.to_vec()),
        }
    }

    /// `cell === value` against a JSON value. Two buffers are never `===`.
    pub fn strict_eq(&self, v: Option<&Value>) -> bool {
        match (self, v) {
            (Cell::Null, Some(Value::Null)) => true,
            (Cell::Number(a), Some(Value::Number(b))) => b.as_f64() == Some(*a),
            (Cell::Text(a), Some(Value::String(b))) => a == b,
            _ => false,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Cell::Text(s) => Some(s),
            _ => None,
        }
    }

    /// Back to a bindable value: a number binds as a double, as it would
    /// from JavaScript.
    pub fn to_sql(&self) -> Sql {
        match self {
            Cell::Null => Sql::Null,
            Cell::Number(f) => Sql::Real(*f),
            Cell::Text(s) => Sql::Text(s.clone()),
            Cell::Blob(b) => Sql::Blob(b.clone()),
        }
    }
}

impl rusqlite::types::FromSql for Cell {
    fn column_result(value: ValueRef<'_>) -> rusqlite::types::FromSqlResult<Self> {
        Ok(Cell::read(value))
    }
}

/// `===` between two columns.
pub fn cells_eq(a: &Cell, b: &Cell) -> bool {
    match (a, b) {
        (Cell::Null, Cell::Null) => true,
        (Cell::Number(x), Cell::Number(y)) => x == y,
        (Cell::Text(x), Cell::Text(y)) => x == y,
        _ => false,
    }
}

/// `JSON.parse(text)`, or `None` where it throws. A string in the result
/// holds each lone surrogate as U+FFFD: JSON.parse keeps it, but
/// better-sqlite3 binds it as U+FFFD (measured in trunk Electron), so every
/// cell written from the value matches. A stringify of the value prints
/// U+FFFD where JSON.stringify would print the `\udXXX` escape.
pub fn parse(text: &str) -> Option<Value> {
    serde_json::from_str(&lone_surrogates_replaced(text)).ok()
}

/// `text` with every `\uXXXX` escape of a lone surrogate turned into
/// `\ufffd`. serde_json refuses lone surrogates, and a `\u` escape is the
/// only way a UTF-8 text can carry one.
fn lone_surrogates_replaced(text: &str) -> Cow<'_, str> {
    let bytes = text.as_bytes();
    let unit_at = |i: usize| -> Option<u16> {
        let hex = bytes.get(i..i + 6)?;
        if hex[0] != b'\\' || hex[1] != b'u' {
            return None;
        }
        u16::from_str_radix(std::str::from_utf8(&hex[2..]).ok()?, 16).ok()
    };
    let mut out: Option<String> = None;
    let (mut i, mut copied) = (0, 0);
    while let Some(at) = bytes[i..].iter().position(|&b| b == b'\\') {
        i += at;
        let Some(unit) = unit_at(i) else {
            // Any other escape is two bytes, which also steps over `\\`
            i = (i + 2).min(bytes.len());
            continue;
        };
        let paired = (0xd800..0xdc00).contains(&unit)
            && unit_at(i + 6).is_some_and(|low| (0xdc00..0xe000).contains(&low));
        if paired {
            i += 12;
        } else if (0xd800..0xe000).contains(&unit) {
            let out = out.get_or_insert_with(|| String::with_capacity(text.len()));
            out.push_str(&text[copied..i]);
            out.push_str("\\ufffd");
            i += 6;
            copied = i;
        } else {
            i += 6;
        }
    }
    match out {
        Some(mut out) => {
            out.push_str(&text[copied..]);
            Cow::Owned(out)
        }
        None => Cow::Borrowed(text),
    }
}

/// `JSON.stringify(value)`: keys in the order JavaScript enumerates them,
/// which needs serde_json's `preserve_order` for the insertion order, and
/// numbers as JavaScript prints them.
pub fn stringify(value: &Value) -> String {
    let mut out = String::new();
    write_json(&mut out, value);
    out
}

fn write_json(out: &mut String, value: &Value) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => out.push_str(&number_to_string(n.as_f64().unwrap_or(f64::NAN))),
        Value::String(s) => write_string(out, s),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_json(out, item);
            }
            out.push(']');
        }
        Value::Object(map) => {
            out.push('{');
            if map.keys().any(|key| array_index(key).is_some()) {
                let mut indexed: Vec<(u32, &String, &Value)> = map
                    .iter()
                    .filter_map(|(key, item)| array_index(key).map(|i| (i, key, item)))
                    .collect();
                indexed.sort_unstable_by_key(|(i, _, _)| *i);
                let named = map.iter().filter(|(key, _)| array_index(key).is_none());
                let indexed = indexed.into_iter().map(|(_, key, item)| (key, item));
                write_entries(out, indexed.chain(named));
            } else {
                write_entries(out, map.iter());
            }
            out.push('}');
        }
    }
}

fn write_entries<'a>(out: &mut String, entries: impl Iterator<Item = (&'a String, &'a Value)>) {
    for (i, (key, item)) in entries.enumerate() {
        if i > 0 {
            out.push(',');
        }
        write_string(out, key);
        out.push(':');
        write_json(out, item);
    }
}

/// The key as an array index: the canonical decimal form of an integer below
/// 2^32 - 1. An object's own keys enumerate those first, in ascending order,
/// then the rest in insertion order (ECMA-262 OrdinaryOwnPropertyKeys).
fn array_index(key: &str) -> Option<u32> {
    if !key.starts_with(|c: char| c.is_ascii_digit()) {
        return None;
    }
    let canonical = key == "0" || (!key.starts_with('0') && !key.is_empty());
    if !canonical || key.len() > 10 || !key.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    key.parse::<u32>().ok().filter(|&i| i != u32::MAX)
}

fn write_string(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

/// `Number.prototype.toString()`, ECMA-262 6.1.6.1.20, through ryu-js,
/// which also makes the spec's even choice between two equally near shortest
/// digit strings. `JSON.stringify` writes a non-finite number as `null`.
pub fn number_to_string(x: f64) -> String {
    if !x.is_finite() {
        return "null".into();
    }
    ryu_js::Buffer::new().format_finite(x).to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn numbers_print_as_javascript_prints_them() {
        let cases = [
            (0.0, "0"),
            (-0.0, "0"),
            (5.0, "5"),
            (-12.5, "-12.5"),
            (0.1 + 0.2, "0.30000000000000004"),
            (1e21, "1e+21"),
            (123456789012345680000.0, "123456789012345680000"),
            (0.000001, "0.000001"),
            (0.0000001, "1e-7"),
            (1.5e-7, "1.5e-7"),
            (2.5e25, "2.5e+25"),
            (7_000_000_123.0, "7000000123"),
            (f64::NAN, "null"),
        ];
        for (x, want) in cases {
            assert_eq!(number_to_string(x), want, "{x:e}");
        }
    }

    /// Node's `String(x)` where two shortest digit strings are equally near
    /// and ECMAScript takes the even one (the T11 Node fuzz).
    #[test]
    fn number_ties_round_half_even_as_node_does() {
        let cases = [
            (0x423ed40051587400, "132405809496.45312"),
            (0x3f619a0000000000, "0.0021486282348632812"),
            (0x3f912a8000000000, "0.016763687133789062"),
            (0x3fc08e2000000000, "0.12933731079101562"),
        ];
        for (bits, node) in cases {
            assert_eq!(number_to_string(f64::from_bits(bits)), node, "{bits:x}");
        }
    }

    #[test]
    fn stringify_keeps_key_order_and_escapes_as_javascript() {
        let v: Value =
            serde_json::from_str(r#"{"z":1,"a":[1.0,"é\u0001\n\"/"],"m":null}"#).unwrap();
        assert_eq!(stringify(&v), r#"{"z":1,"a":[1,"é\u0001\n\"/"],"m":null}"#);
    }

    /// Node's `JSON.stringify(JSON.parse(text))` for each text: array-index
    /// keys first in ascending order, then the rest in insertion order.
    #[test]
    fn stringify_puts_array_index_keys_first_as_node_does() {
        let cases = [
            (
                r#"{"b":1,"2":0,"1":0,"-1":0,"01":0,"4294967295":0,"4294967294":0,"1.5":0}"#,
                r#"{"1":0,"2":0,"4294967294":0,"b":1,"-1":0,"01":0,"4294967295":0,"1.5":0}"#,
            ),
            (
                r#"{"0":1,"10":2,"9":3,"x":4,"00":5,"4294967294":6,"4294967295":7,"a":{"3":1,"z":2,"1":3}}"#,
                r#"{"0":1,"9":3,"10":2,"4294967294":6,"x":4,"00":5,"4294967295":7,"a":{"1":3,"3":1,"z":2}}"#,
            ),
            (r#"{"a":1,"b":2,"a":3}"#, r#"{"a":3,"b":2}"#),
            (r#"{"__proto__":1,"5":2}"#, r#"{"5":2,"__proto__":1}"#),
            (r#"[{"2":1,"1":2}]"#, r#"[{"1":2,"2":1}]"#),
        ];
        for (text, node) in cases {
            let v: Value = serde_json::from_str(text).unwrap();
            assert_eq!(stringify(&v), node, "{text}");
        }
    }

    /// What trunk Electron's better-sqlite3 stores for each string
    /// JSON.parse reads from the text: every lone surrogate as U+FFFD, a
    /// pair as its character (electron-sqlite.json in the fixtures).
    #[test]
    fn lone_surrogates_parse_as_better_sqlite3_binds_them() {
        let cases = [
            (r#""A\ud83d""#, "A\u{fffd}"),
            (r#""\udc00NA""#, "\u{fffd}NA"),
            (r#""\ud83d\ud83d""#, "\u{fffd}\u{fffd}"),
            (r#""B\ud83d\nC""#, "B\u{fffd}\nC"),
            (r#""\ud83d\u0041""#, "\u{fffd}A"),
            (r#""\uD83D\uDE00 ok""#, "\u{1f600} ok"),
            (r#""\ud83d\ud83d\ude00""#, "\u{fffd}\u{1f600}"),
            (r#""\ude00\ud83d""#, "\u{fffd}\u{fffd}"),
            (r#""x\udbff\udfff\udc00""#, "x\u{10ffff}\u{fffd}"),
            (r#""\\ud800""#, "\\ud800"),
        ];
        for (text, stored) in cases {
            assert_eq!(parse(text), Some(Value::String(stored.into())), "{text}");
        }
        assert_eq!(parse(r#"{"\ud800":1}"#), Some(json!({ "\u{fffd}": 1 })));
        assert_eq!(parse(r#"["\"#), None);
        assert_eq!(parse("[1,]"), None);
    }

    #[test]
    fn or_and_nullish_follow_javascript() {
        let zero = json!(0);
        let empty = json!("");
        let name = json!("Ahri");
        assert_eq!(or(&[Some(&zero), Some(&empty), Some(&name)]), Some(&name));
        assert_eq!(or(&[Some(&zero), Some(&empty)]), Some(&empty));
        assert_eq!(
            nullish(&[None, Some(&Value::Null), Some(&zero)]),
            Some(&zero)
        );
        assert_eq!(nullish(&[None, Some(&Value::Null)]), None);
    }

    #[test]
    fn reading_a_property_of_null_throws() {
        assert!(prop(Some(&Value::Null), "stats").is_err());
        assert!(prop(None, "stats").is_err());
        assert_eq!(prop(Some(&json!(5)), "stats"), Ok(None));
        assert_eq!(opt_prop(Some(&Value::Null), "player"), None);
    }
}
