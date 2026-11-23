//! `writeExportTo` in `src/main/db/transfer.ts`: the whole library as one
//! JSON file, format version 3, byte for byte what Electron writes. Games
//! are read a page at a time and written straight to disk, and the database
//! is free between pages, as Electron's event loop is between its awaits.

use std::fs::File;
use std::io::{self, BufWriter, Write};
use std::path::Path;

use rusqlite::types::ValueRef;
use serde_json::{Map, Number, Value};

use crate::db::Database;
use crate::db::js::{self, Cell};
use crate::db::payloads::unpack_raw;

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
        for (_, blob, owner) in rows {
            // A backup stays the untouched payloads, so an import into any
            // version rebuilds whatever that version derives from them
            let Some(mut game) = unpack_raw(blob.as_deref()).filter(|g| js::truthy(Some(g))) else {
                continue;
            };
            set_owner(&mut game, cell_value(owner))?;
            if count > 0 {
                chunk.push(',');
            }
            chunk.push_str(&js::stringify(&game));
            count += 1;
        }
        write(&chunk)?;
    }

    write("]}")?;
    out.flush().map_err(|err| node_error(&err, "write", None))?;
    Ok(count)
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
