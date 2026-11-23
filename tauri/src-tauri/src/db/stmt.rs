//! Typed rows read by column index. A row type names its columns once; each
//! query resolves those names to indexes once per statement and then reads
//! every row by index, because reading by name per row tripled query time in
//! the spike.
//!
//! ```ignore
//! db_row! {
//!     pub struct GameRow { game_id: i64, puuid: String }
//! }
//! let games: Vec<GameRow> = stmt::all(conn, "SELECT * FROM games", [])?;
//! ```

use rusqlite::{Connection, Params, Row, Statement};

/// A struct read from a result row. [`db_row!`] writes the impl.
pub trait FromRow: Sized {
    /// The result columns the struct reads, by name.
    const COLUMNS: &'static [&'static str];

    /// Reads one row, where `at[i]` is the index of `COLUMNS[i]`.
    fn from_row(row: &Row<'_>, at: &[usize]) -> rusqlite::Result<Self>;
}

/// Each of `T::COLUMNS` as its index in `stmt`'s result.
pub fn resolve<T: FromRow>(stmt: &Statement<'_>) -> rusqlite::Result<Vec<usize>> {
    T::COLUMNS
        .iter()
        .map(|name| stmt.column_index(name))
        .collect()
}

/// Every row `sql` returns, through the connection's statement cache.
pub fn all<T: FromRow>(
    conn: &Connection,
    sql: &str,
    params: impl Params,
) -> rusqlite::Result<Vec<T>> {
    let mut stmt = conn.prepare_cached(sql)?;
    let at = resolve::<T>(&stmt)?;
    stmt.query_map(params, |row| T::from_row(row, &at))?
        .collect()
}

/// The first row `sql` returns, if any: better-sqlite3's `.get()`.
pub fn first<T: FromRow>(
    conn: &Connection,
    sql: &str,
    params: impl Params,
) -> rusqlite::Result<Option<T>> {
    let mut stmt = conn.prepare_cached(sql)?;
    let at = resolve::<T>(&stmt)?;
    let mut rows = stmt.query(params)?;
    rows.next()?.map(|row| T::from_row(row, &at)).transpose()
}

/// Declares a struct and its [`FromRow`] impl, one column per field, named
/// as the field is.
#[macro_export]
macro_rules! db_row {
    ($(#[$meta:meta])* $vis:vis struct $name:ident { $($fvis:vis $field:ident : $ty:ty),* $(,)? }) => {
        $(#[$meta])*
        $vis struct $name { $($fvis $field: $ty),* }

        impl $crate::db::stmt::FromRow for $name {
            const COLUMNS: &'static [&'static str] = &[$(stringify!($field)),*];

            #[allow(unused_assignments)]
            fn from_row(row: &rusqlite::Row<'_>, at: &[usize]) -> rusqlite::Result<Self> {
                let mut i = 0;
                Ok(Self { $($field: { let v = row.get(at[i])?; i += 1; v }),* })
            }
        }
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    db_row! {
        #[derive(Debug, PartialEq)]
        struct Pair { b: String, a: i64 }
    }

    #[test]
    fn rows_read_by_name_whatever_the_column_order() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE t (a INTEGER, z TEXT, b TEXT); INSERT INTO t VALUES (1, 'q', 'x'), (2, 'r', 'y');")
            .unwrap();
        let rows: Vec<Pair> = all(&conn, "SELECT * FROM t ORDER BY a", []).unwrap();
        assert_eq!(
            rows,
            [
                Pair {
                    b: "x".into(),
                    a: 1
                },
                Pair {
                    b: "y".into(),
                    a: 2
                }
            ]
        );
        let one: Option<Pair> = first(&conn, "SELECT b, a FROM t WHERE a = ?", [2]).unwrap();
        assert_eq!(
            one,
            Some(Pair {
                b: "y".into(),
                a: 2
            })
        );
        let none: Option<Pair> = first(&conn, "SELECT b, a FROM t WHERE a = ?", [9]).unwrap();
        assert_eq!(none, None);
        assert!(all::<Pair>(&conn, "SELECT a FROM t", []).is_err());
    }
}
