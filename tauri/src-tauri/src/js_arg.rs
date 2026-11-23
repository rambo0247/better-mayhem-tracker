//! [`Js`], an argument exactly as the page sent it.
//!
//! Electron's handlers hand most arguments straight to better-sqlite3 or to
//! JavaScript operators, which accept what a Rust type would refuse: `"2400"`
//! for a queue, `1` for a boolean, a fraction for an id. A body that must
//! answer as Electron did takes the argument as `Js<T>` and binds its raw
//! value by better-sqlite3's rules (T11's `db::js::bind`). The bindings still
//! type it as `T`, which is what the page means to send.

use std::marker::PhantomData;

use serde::de::{Deserializer, Visitor};
use serde::{Deserialize, Serialize, Serializer};
use serde_json::Value;
use ts_rs::{Config, TS, TypeVisitor};

/// The key of the object api.ts sends in place of a number JSON cannot
/// carry: `{"$bmtNum": "NaN" | "Infinity" | "-Infinity"}`.
pub const NON_FINITE_KEY: &str = "$bmtNum";

/// A value the page sent, as JavaScript held it.
#[derive(Debug, Clone)]
pub enum JsValue {
    Json(Value),
    /// NaN or an infinity. Electron's structured clone hands the handler the
    /// number itself, so `queue != null` holds and better-sqlite3 binds it
    /// (NaN as NULL, an infinity as a REAL); JSON alone would carry `null`,
    /// which reads as absent. api.ts sends it as the [`NON_FINITE_KEY`] object.
    NonFinite(f64),
}

impl JsValue {
    /// The value when JSON can hold it, which is every value but NaN and the
    /// infinities.
    pub fn as_json(&self) -> Option<&Value> {
        match self {
            JsValue::Json(value) => Some(value),
            JsValue::NonFinite(_) => None,
        }
    }

    /// The value when it is a JavaScript number, finite or not.
    pub fn as_f64(&self) -> Option<f64> {
        match self {
            JsValue::Json(value) => value.as_f64(),
            JsValue::NonFinite(number) => Some(*number),
        }
    }

    /// Reads api.ts's sentinel back as the number it stands for.
    fn decode(value: Value) -> Self {
        let number = match &value {
            Value::Object(map) if map.len() == 1 => match map.get(NON_FINITE_KEY) {
                Some(Value::String(text)) => match text.as_str() {
                    "NaN" => Some(f64::NAN),
                    "Infinity" => Some(f64::INFINITY),
                    "-Infinity" => Some(f64::NEG_INFINITY),
                    _ => None,
                },
                _ => None,
            },
            _ => None,
        };
        number.map_or(JsValue::Json(value), JsValue::NonFinite)
    }
}

/// JavaScript has one NaN, whatever its bits.
impl PartialEq for JsValue {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (JsValue::Json(a), JsValue::Json(b)) => a == b,
            (JsValue::NonFinite(a), JsValue::NonFinite(b)) => a == b || (a.is_nan() && b.is_nan()),
            _ => false,
        }
    }
}

impl Serialize for JsValue {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            JsValue::Json(value) => value.serialize(serializer),
            JsValue::NonFinite(number) => {
                let text = if number.is_nan() {
                    "NaN"
                } else if *number > 0.0 {
                    "Infinity"
                } else {
                    "-Infinity"
                };
                serde_json::json!({ NON_FINITE_KEY: text }).serialize(serializer)
            }
        }
    }
}

pub struct Js<T> {
    /// `None` is `undefined`. JSON carries `null` and a skipped argument
    /// alike as `null`, and better-sqlite3 binds both as NULL, so they read
    /// the same here.
    value: Option<JsValue>,
    _type: PhantomData<fn() -> T>,
}

impl<T> Js<T> {
    pub fn new(value: Option<Value>) -> Self {
        Self::sent(value.filter(|v| !v.is_null()).map(JsValue::decode))
    }

    fn sent(value: Option<JsValue>) -> Self {
        Self {
            value,
            _type: PhantomData,
        }
    }

    /// The value as sent, `None` for `undefined` or `null`.
    pub fn value(&self) -> Option<&JsValue> {
        self.value.as_ref()
    }

    pub fn is_undefined(&self) -> bool {
        self.value.is_none()
    }
}

impl<T: serde::de::DeserializeOwned> Js<T> {
    /// The value read as `T`, when it is one: what a body that has no need
    /// of Electron's coercions can use. A non-finite number is no `T`.
    pub fn typed(&self) -> Option<T> {
        match &self.value {
            None => serde_json::from_value(Value::Null).ok(),
            Some(JsValue::Json(value)) => serde_json::from_value(value.clone()).ok(),
            Some(JsValue::NonFinite(_)) => None,
        }
    }
}

impl<T> Default for Js<T> {
    fn default() -> Self {
        Self::new(None)
    }
}

impl<T> Clone for Js<T> {
    fn clone(&self) -> Self {
        Self::sent(self.value.clone())
    }
}

impl<T> PartialEq for Js<T> {
    fn eq(&self, other: &Self) -> bool {
        self.value == other.value
    }
}

impl<T> std::fmt::Debug for Js<T> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match &self.value {
            Some(JsValue::Json(value)) => write!(f, "Js({value})"),
            Some(JsValue::NonFinite(number)) => write!(f, "Js({number})"),
            None => f.write_str("Js(undefined)"),
        }
    }
}

impl<T> From<Value> for Js<T> {
    fn from(value: Value) -> Self {
        Self::new(Some(value))
    }
}

/// Writes the value back as it came, so the wire shape is the page's own.
impl<T> Serialize for Js<T> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.value.serialize(serializer)
    }
}

impl<'de, T> Deserialize<'de> for Js<T> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Raw;
        impl<'de> Visitor<'de> for Raw {
            type Value = Option<Value>;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("any JSON value")
            }
            fn visit_none<E>(self) -> Result<Self::Value, E> {
                Ok(None)
            }
            fn visit_unit<E>(self) -> Result<Self::Value, E> {
                Ok(None)
            }
            fn visit_some<D: Deserializer<'de>>(self, d: D) -> Result<Self::Value, D::Error> {
                Value::deserialize(d).map(Some)
            }
        }
        // Tauri answers a missing argument key through deserialize_option
        deserializer.deserialize_option(Raw).map(Self::new)
    }
}

impl<T: TS> TS for Js<T> {
    type WithoutGenerics = Self;
    type OptionInnerType = T::OptionInnerType;
    const IS_OPTION: bool = T::IS_OPTION;

    fn name(cfg: &Config) -> String {
        T::name(cfg)
    }

    fn inline(cfg: &Config) -> String {
        T::inline(cfg)
    }

    fn visit_dependencies(v: &mut impl TypeVisitor)
    where
        Self: 'static,
    {
        T::visit_dependencies(v);
    }

    fn visit_generics(v: &mut impl TypeVisitor)
    where
        Self: 'static,
    {
        T::visit_generics(v);
        v.visit::<T>();
    }
}

/// Lets `#[ts(optional)]` print a `Js<Option<T>>` field as `x?: T`.
impl<T> ts_rs::IsOption for Js<Option<T>> {
    type Inner = T;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_value_reads_back_as_sent_and_null_as_undefined() {
        let sent: Js<i64> = serde_json::from_str(r#""2400""#).unwrap();
        assert_eq!(sent.value(), Some(&JsValue::Json(Value::from("2400"))));
        assert_eq!(sent.typed(), None);
        assert_eq!(serde_json::to_string(&sent).unwrap(), r#""2400""#);
        let fraction: Js<i64> = serde_json::from_str("5684865505.5").unwrap();
        assert_eq!(
            fraction.value().and_then(JsValue::as_f64),
            Some(5_684_865_505.5)
        );
        let null: Js<i64> = serde_json::from_str("null").unwrap();
        assert!(null.is_undefined());
        let id: Js<i64> = serde_json::from_str("7").unwrap();
        assert_eq!(id.typed(), Some(7));
        let cfg = Config::new().with_large_int("number");
        assert_eq!(<Js<Option<String>>>::name(&cfg), "string | null");
        const { assert!(<Js<Option<String>> as TS>::IS_OPTION) };
    }

    /// The JSON api.test.ts shows `tauriTransport` sending for each value.
    const SENT: [(&str, f64); 3] = [
        (r#"{"$bmtNum":"NaN"}"#, f64::NAN),
        (r#"{"$bmtNum":"Infinity"}"#, f64::INFINITY),
        (r#"{"$bmtNum":"-Infinity"}"#, f64::NEG_INFINITY),
    ];

    #[test]
    fn a_non_finite_number_reads_as_the_number_the_page_held() {
        for (json, number) in SENT {
            let sent: Js<Option<i64>> = serde_json::from_str(json).unwrap();
            assert!(!sent.is_undefined(), "{json} is a value, not undefined");
            assert_eq!(sent.value(), Some(&JsValue::NonFinite(number)));
            assert_eq!(sent.value().and_then(JsValue::as_json), None);
            assert_eq!(sent.typed(), None, "{json} is no integer");
            assert_eq!(serde_json::to_string(&sent).unwrap(), json);
        }
        for other in [
            r#"{"$bmtNum":"nan"}"#,
            r#"{"$bmtNum":"NaN","x":1}"#,
            r#"{"bmtNum":"NaN"}"#,
        ] {
            let sent: Js<Option<i64>> = serde_json::from_str(other).unwrap();
            let value: Value = serde_json::from_str(other).unwrap();
            assert_eq!(
                sent.value(),
                Some(&JsValue::Json(value)),
                "{other} is an object"
            );
        }
    }

    /// better-sqlite3 binds a number with `sqlite3_bind_double`, which stores
    /// NaN as NULL and keeps an infinity, so `queue_id = ?` matches no row,
    /// where an absent queue drops the filter and matches every row.
    #[test]
    fn a_non_finite_number_binds_as_better_sqlite3_binds_it() {
        use rusqlite::types::Value as Sql;
        let db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch(
            "CREATE TABLE games (queue_id INTEGER); INSERT INTO games VALUES (2400), (450);",
        )
        .unwrap();
        for (json, number) in SENT {
            let sent: Js<Option<i64>> = serde_json::from_str(json).unwrap();
            let bound = Sql::Real(sent.value().and_then(JsValue::as_f64).unwrap());
            let (kind, rows): (String, i64) = db
                .query_row(
                    "SELECT typeof(?1), (SELECT count(*) FROM games WHERE queue_id = ?1)",
                    [&bound],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .unwrap();
            assert_eq!(
                kind,
                if number.is_nan() { "null" } else { "real" },
                "{json}"
            );
            assert_eq!(rows, 0, "{json} matches no game");
        }
    }
}
