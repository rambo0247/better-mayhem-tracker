//! A number as JavaScript holds it. better-sqlite3 hands back an `INTEGER`
//! and a `REAL` as the same kind of number, so a `SUM` over a column that
//! stores a fractional value in an `INTEGER` affinity reads as a fraction in
//! Electron. An `i64` field errors on that value; [`Num`] reads either.

use rusqlite::types::{FromSql, FromSqlError, FromSqlResult, ValueRef};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use ts_rs::TS;

/// Largest integer a double holds exactly, which `Number.isSafeInteger` bounds.
const SAFE_INTEGER: f64 = 9_007_199_254_740_992.0;

/// An `INTEGER` or a `REAL`, as one double. A whole value goes out as an
/// integer, so a column that holds only integers answers as it always did.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Num(pub f64);

/// Prints as the primitive `number`, as a bare `f64` does.
impl TS for Num {
    type WithoutGenerics = Self;
    type OptionInnerType = Self;

    fn name(_: &ts_rs::Config) -> String {
        "number".into()
    }

    fn inline(cfg: &ts_rs::Config) -> String {
        Self::name(cfg)
    }
}

impl From<i64> for Num {
    fn from(n: i64) -> Self {
        Num(n as f64)
    }
}

impl FromSql for Num {
    fn column_result(value: ValueRef<'_>) -> FromSqlResult<Self> {
        match value {
            ValueRef::Integer(n) => Ok(Num(n as f64)),
            ValueRef::Real(x) => Ok(Num(x)),
            _ => Err(FromSqlError::InvalidType),
        }
    }
}

impl Serialize for Num {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let x = self.0;
        if x.fract() == 0.0 && x.abs() < SAFE_INTEGER {
            serializer.serialize_i64(x as i64)
        } else {
            serializer.serialize_f64(x)
        }
    }
}

impl<'de> Deserialize<'de> for Num {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        f64::deserialize(deserializer).map(Num)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_whole_value_serializes_as_an_integer_and_a_fraction_as_a_real() {
        let text = |x: f64| serde_json::to_string(&Num(x)).unwrap();
        assert_eq!(text(1500.0), "1500");
        assert_eq!(text(-0.0), "0");
        assert_eq!(text(711290.25), "711290.25");
        assert_eq!(text(1e300), "1e+300");
        assert_eq!(serde_json::from_str::<Num>("5").unwrap(), Num(5.0));
        assert_eq!(serde_json::from_str::<Num>("0.5").unwrap(), Num(0.5));
    }
}
