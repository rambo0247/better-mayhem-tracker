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

pub struct Js<T> {
    /// `None` is `undefined`. JSON carries `null`, `NaN` and a skipped
    /// argument alike as `null`, and better-sqlite3 binds all three as NULL,
    /// so they read the same here.
    value: Option<Value>,
    _type: PhantomData<fn() -> T>,
}

impl<T> Js<T> {
    pub fn new(value: Option<Value>) -> Self {
        Self {
            value: value.filter(|v| !v.is_null()),
            _type: PhantomData,
        }
    }

    /// The value as sent, `None` for `undefined` or `null`.
    pub fn value(&self) -> Option<&Value> {
        self.value.as_ref()
    }

    pub fn is_undefined(&self) -> bool {
        self.value.is_none()
    }
}

impl<T: serde::de::DeserializeOwned> Js<T> {
    /// The value read as `T`, when it is one: what a body that has no need
    /// of Electron's coercions can use.
    pub fn typed(&self) -> Option<T> {
        serde_json::from_value(self.value.clone().unwrap_or(Value::Null)).ok()
    }
}

impl<T> Default for Js<T> {
    fn default() -> Self {
        Self::new(None)
    }
}

impl<T> Clone for Js<T> {
    fn clone(&self) -> Self {
        Self::new(self.value.clone())
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
            Some(value) => write!(f, "Js({value})"),
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
        assert_eq!(sent.value(), Some(&Value::from("2400")));
        assert_eq!(sent.typed(), None);
        assert_eq!(serde_json::to_string(&sent).unwrap(), r#""2400""#);
        let fraction: Js<i64> = serde_json::from_str("5684865505.5").unwrap();
        assert_eq!(fraction.value(), Some(&Value::from(5_684_865_505.5)));
        let null: Js<i64> = serde_json::from_str("null").unwrap();
        assert!(null.is_undefined());
        let id: Js<i64> = serde_json::from_str("7").unwrap();
        assert_eq!(id.typed(), Some(7));
        let cfg = Config::new().with_large_int("number");
        assert_eq!(<Js<Option<String>>>::name(&cfg), "string | null");
        const { assert!(<Js<Option<String>> as TS>::IS_OPTION) };
    }
}
