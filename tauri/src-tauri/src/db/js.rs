//! The JavaScript semantics the database code leans on: property reads that
//! throw on `null`, `||` and `??` over parsed JSON, `JSON.stringify`, and how
//! better-sqlite3 binds and returns values. `None` is `undefined`.

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

/// `JSON.stringify(value)`: keys in the order `JSON.parse` met them, which
/// needs serde_json's `preserve_order`, and numbers as JavaScript prints them.
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
            for (i, (key, item)) in map.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_string(out, key);
                out.push(':');
                write_json(out, item);
            }
            out.push('}');
        }
    }
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

/// `Number.prototype.toString()`, ECMA-262 6.1.6.1.20, from the shortest
/// digits that round-trip, which Rust's `{:e}` prints. `JSON.stringify`
/// writes a non-finite number as `null`.
pub fn number_to_string(x: f64) -> String {
    if !x.is_finite() {
        return "null".into();
    }
    if x == 0.0 {
        return "0".into();
    }
    let sci = format!("{:e}", x.abs());
    let (mantissa, exp) = sci.split_once('e').unwrap_or((&sci, "0"));
    let digits: String = mantissa.chars().filter(char::is_ascii_digit).collect();
    let k = digits.len() as i32;
    let n = exp.parse::<i32>().unwrap_or(0) + 1;
    let sign = if x < 0.0 { "-" } else { "" };
    let body = if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let e = n - 1;
        let e = if e < 0 {
            format!("-{}", -e)
        } else {
            format!("+{e}")
        };
        if k == 1 {
            format!("{digits}e{e}")
        } else {
            format!("{}.{}e{e}", &digits[..1], &digits[1..])
        }
    };
    format!("{sign}{body}")
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

    #[test]
    fn stringify_keeps_key_order_and_escapes_as_javascript() {
        let v: Value =
            serde_json::from_str(r#"{"z":1,"a":[1.0,"é\u0001\n\"/"],"m":null}"#).unwrap();
        assert_eq!(stringify(&v), r#"{"z":1,"a":[1,"é\u0001\n\"/"],"m":null}"#);
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
