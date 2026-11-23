//! The Rust database core against what Electron 1.2.1 writes: the schema a
//! fresh database gets, an already-current database left alone, every
//! migration from a pre-versioning database, and the payload blobs.
//!
//! The fixture-wide checks read the anonymized fixture from `BMT_FIXTURE_DB`,
//! defaulting to `parity/snapshots/fixture/data/matches.db`, always through a
//! copy. Without it they print why and stop. With `BMT_COMPAT_OUT` set, the
//! databases these tests build are left there for the Electron lanes.

use std::collections::BTreeSet;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use bmt_lib::db::{Database, migrations, payloads};
use rusqlite::Connection;
use rusqlite::types::Value as Sql;
use serde_json::{Value, json};

const NOW_MS: i64 = 1_795_399_200_000;

fn scratch(name: &str) -> PathBuf {
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let dir = std::env::temp_dir().join(format!(
        "bmt-db-compat-{}-{}-{name}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::remove_dir_all(&dir).ok();
    std::fs::create_dir_all(&dir).expect("create a scratch folder");
    dir
}

fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// A private copy of the fixture database, or `None` when there is none.
fn fixture_copy(dir: &Path) -> Option<PathBuf> {
    let source = std::env::var_os("BMT_FIXTURE_DB")
        .map(PathBuf::from)
        .unwrap_or_else(|| manifest_dir().join("../../parity/snapshots/fixture/data/matches.db"));
    if !source.exists() {
        println!("no fixture at {}; set BMT_FIXTURE_DB", source.display());
        return None;
    }
    let copy = dir.join("fixture.db");
    std::fs::copy(&source, &copy).expect("copy the fixture");
    Some(copy)
}

/// Leaves a built database where the Electron lanes pick it up.
fn keep(name: &str, data_dir: &Path) {
    let Some(out) = std::env::var_os("BMT_COMPAT_OUT").map(PathBuf::from) else {
        return;
    };
    let target = out.join(name).join("data");
    std::fs::create_dir_all(&target).expect("create the lane folder");
    std::fs::copy(data_dir.join("matches.db"), target.join("matches.db")).expect("keep a database");
}

fn bytes(path: &Path) -> Vec<u8> {
    std::fs::read(path).expect("read a database file")
}

/// Leaves `path` in WAL mode, as every database Electron has opened is.
fn as_electron_left_it(path: &Path) {
    let conn = Connection::open(path).unwrap();
    conn.pragma_update_and_check(None, "journal_mode", "WAL", |_| Ok(()))
        .unwrap();
}

fn sql_rows(conn: &Connection, sql: &str) -> Vec<Vec<Sql>> {
    let mut stmt = conn.prepare(sql).expect("prepare");
    let n = stmt.column_count();
    stmt.query_map([], |row| (0..n).map(|i| row.get::<_, Sql>(i)).collect())
        .expect("query")
        .collect::<rusqlite::Result<_>>()
        .expect("read rows")
}

fn schema(conn: &Connection) -> Vec<(String, String, String, Option<String>)> {
    let mut stmt = conn
        .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name")
        .unwrap();
    stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}

/// Each table's columns as `(name, type, notnull, default, pk)`, whatever
/// order they were added in.
fn columns(conn: &Connection) -> Vec<(String, BTreeSet<String>)> {
    let tables: Vec<String> = conn
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    tables
        .into_iter()
        .map(|table| {
            let cols = sql_rows(conn, &format!("PRAGMA table_info({table})"))
                .into_iter()
                .map(|c| format!("{:?}", &c[1..]))
                .collect();
            (table, cols)
        })
        .collect()
}

fn fresh(dir: &Path) -> Database {
    Database::open(dir, NOW_MS).expect("open a fresh database")
}

#[test]
fn a_fresh_database_has_electrons_schema_and_pragmas() {
    let dir = scratch("fresh");
    let db = fresh(&dir);
    db.with(|conn| {
        let golden: Value = serde_json::from_str(
            &std::fs::read_to_string(manifest_dir().join("tests/fixtures/electron-schema.json"))
                .expect("the Electron schema golden"),
        )
        .expect("the golden is JSON");
        let ours: Vec<Value> = schema(conn)
            .into_iter()
            .map(|(t, n, tbl, sql)| json!([t, n, tbl, sql]))
            .collect();
        assert_eq!(
            Value::Array(ours),
            golden["sqlite_master"],
            "sqlite_master text"
        );
        assert_eq!(
            migrations::user_version(conn)?,
            golden["user_version"].as_i64().unwrap()
        );
        let pragma = |name: &str| -> rusqlite::Result<Sql> {
            conn.pragma_query_value(None, name, |r| r.get(0))
        };
        assert_eq!(pragma("journal_mode")?, Sql::Text("wal".into()));
        assert_eq!(pragma("synchronous")?, Sql::Integer(1));
        assert_eq!(pragma("foreign_keys")?, Sql::Integer(1));
        assert_eq!(pragma("busy_timeout")?, Sql::Integer(5000));
        assert_eq!(pragma("cache_size")?, Sql::Integer(-16000));
        Ok(())
    })
    .unwrap();
    db.close();
    assert!(!dir.join("matches.db-wal").exists(), "close leaves no -wal");
    keep("fresh", &dir);
}

#[test]
fn opening_a_current_database_leaves_the_file_byte_identical() {
    let dir = scratch("reopen");
    fresh(&dir).close();
    let before = bytes(&dir.join("matches.db"));
    let db = fresh(&dir);
    db.close();
    assert!(
        bytes(&dir.join("matches.db")) == before,
        "a fresh database reopened"
    );

    let Some(fixture) = fixture_copy(&dir) else {
        return;
    };
    let data = dir.join("fixture-data");
    std::fs::create_dir_all(&data).unwrap();
    std::fs::rename(&fixture, data.join("matches.db")).unwrap();
    // fixture.ts writes in rollback mode; a player's file is always WAL
    as_electron_left_it(&data.join("matches.db"));
    let before = bytes(&data.join("matches.db"));
    let db = fresh(&data);
    db.close();
    assert!(
        bytes(&data.join("matches.db")) == before,
        "the fixture reopened"
    );
    assert!(!data.join("matches.db-wal").exists());
    keep("fixture-opened", &data);
}

#[test]
fn closing_twice_and_using_a_closed_database_fail_as_electron_does() {
    let dir = scratch("closed");
    let db = fresh(&dir);
    db.close();
    db.close();
    let err = db.with(|_| Ok(())).unwrap_err();
    assert_eq!(
        (err.name.as_str(), err.message.as_str()),
        ("TypeError", "The database connection is not open")
    );
    db.reopen(NOW_MS).unwrap();
    assert!(db.with(|_| Ok(())).is_ok());
    let err = db
        .with(|conn| conn.execute_batch("SELECT * FROM nowhere"))
        .unwrap_err();
    assert_eq!(
        (err.name.as_str(), err.message.as_str()),
        ("SqliteError", "no such table: nowhere")
    );
}

/// The tables as a database from before `user_version` existed had them:
/// the payload still in `raw_json`, and none of the columns V1 to V4 add.
const V0_DDL: &str = "
    CREATE TABLE games (
      game_id       INTEGER PRIMARY KEY,
      queue_id      INTEGER NOT NULL,
      game_mode     TEXT NOT NULL,
      game_creation INTEGER NOT NULL,
      game_duration INTEGER NOT NULL,
      raw_json      TEXT
    );
    CREATE TABLE player_stats (
      game_id              INTEGER PRIMARY KEY REFERENCES games(game_id),
      champion_id          INTEGER NOT NULL,
      win                  INTEGER NOT NULL,
      kills                INTEGER NOT NULL DEFAULT 0,
      deaths               INTEGER NOT NULL DEFAULT 0,
      assists              INTEGER NOT NULL DEFAULT 0,
      double_kills         INTEGER NOT NULL DEFAULT 0,
      triple_kills         INTEGER NOT NULL DEFAULT 0,
      quadra_kills         INTEGER NOT NULL DEFAULT 0,
      penta_kills          INTEGER NOT NULL DEFAULT 0,
      total_damage_dealt   INTEGER NOT NULL DEFAULT 0,
      total_damage_taken   INTEGER NOT NULL DEFAULT 0,
      gold_earned          INTEGER NOT NULL DEFAULT 0,
      total_heal           INTEGER NOT NULL DEFAULT 0,
      largest_killing_spree INTEGER NOT NULL DEFAULT 0,
      item0 INTEGER, item1 INTEGER, item2 INTEGER,
      item3 INTEGER, item4 INTEGER, item5 INTEGER, item6 INTEGER
    );
    CREATE TABLE game_augments (
      game_id    INTEGER NOT NULL REFERENCES games(game_id),
      slot       INTEGER NOT NULL,
      augment_id INTEGER NOT NULL,
      PRIMARY KEY (game_id, slot)
    );
    CREATE TABLE summoner (
      puuid        TEXT PRIMARY KEY,
      game_name    TEXT,
      tag_line     TEXT,
      summoner_id  INTEGER,
      account_id   INTEGER,
      updated_at   INTEGER NOT NULL
    );
    CREATE TABLE settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE ignored_games (
      game_id INTEGER PRIMARY KEY
    );
";

const PLAYER_STATS_V0: &str = "game_id, champion_id, win, kills, deaths, assists, double_kills, \
    triple_kills, quadra_kills, penta_kills, total_damage_dealt, total_damage_taken, gold_earned, \
    total_heal, largest_killing_spree, item0, item1, item2, item3, item4, item5, item6";

fn gunzip(blob: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    flate2::read::MultiGzDecoder::new(blob)
        .read_to_end(&mut out)
        .expect("a fixture blob gunzips");
    out
}

/// A pre-versioning copy of `fixture`: the same games, their payloads as
/// text, our own augments in the four slots the first versions captured.
fn v0_from_fixture(fixture: &Path, target: &Path) {
    let conn = Connection::open(target).unwrap();
    conn.execute_batch(V0_DDL).unwrap();
    conn.execute("ATTACH DATABASE ? AS f", [fixture.to_str().unwrap()])
        .unwrap();
    conn.execute_batch(&format!(
        "
        INSERT INTO games SELECT game_id, queue_id, game_mode, game_creation, game_duration, NULL FROM f.games;
        INSERT INTO player_stats SELECT {PLAYER_STATS_V0} FROM f.player_stats;
        INSERT INTO game_augments SELECT game_id, slot, augment_id FROM f.game_augments WHERE slot <= 4;
        INSERT INTO summoner SELECT puuid, game_name, tag_line, summoner_id, account_id, updated_at FROM f.summoner;
        INSERT INTO settings SELECT key, value FROM f.settings WHERE key NOT IN ('augment_slots', 'hidden_queues');
        INSERT INTO ignored_games SELECT game_id FROM f.ignored_games;
        "
    ))
    .unwrap();
    let blobs: Vec<(i64, Vec<u8>)> = conn
        .prepare("SELECT game_id, raw_gz FROM f.games WHERE raw_gz IS NOT NULL")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    let tx = conn.unchecked_transaction().unwrap();
    for (game_id, blob) in blobs {
        let text = String::from_utf8(gunzip(&blob)).expect("payloads are UTF-8");
        tx.execute(
            "UPDATE games SET raw_json = ? WHERE game_id = ?",
            rusqlite::params![text, game_id],
        )
        .unwrap();
    }
    tx.commit().unwrap();
    conn.execute_batch("DETACH DATABASE f").unwrap();
}

/// Rows of `table` in both databases, `cols` only.
fn same_rows(conn: &Connection, table: &str, cols: &str, order: &str) {
    let ours = sql_rows(
        conn,
        &format!("SELECT {cols} FROM main.{table} ORDER BY {order}"),
    );
    let theirs = sql_rows(
        conn,
        &format!("SELECT {cols} FROM f.{table} ORDER BY {order}"),
    );
    assert_eq!(ours.len(), theirs.len(), "{table}: row count");
    for (a, b) in ours.iter().zip(&theirs) {
        assert_eq!(a, b, "{table}: first differing row");
    }
}

#[test]
fn a_pre_versioning_fixture_upgrades_to_the_fixture_itself() {
    let dir = scratch("v0");
    let Some(fixture) = fixture_copy(&dir) else {
        return;
    };
    let data = dir.join("data");
    std::fs::create_dir_all(&data).unwrap();
    v0_from_fixture(&fixture, &data.join("matches.db"));
    keep("v0-source", &data);

    let db = Database::open(&data, NOW_MS).expect("migrate the V0 copy");
    let fresh_dir = scratch("v0-fresh");
    let reference = fresh(&fresh_dir);
    let fresh_columns = reference.with(|c| Ok(columns(c))).unwrap();
    let fresh_schema = reference.with(|c| Ok(schema(c))).unwrap();

    db.with(|conn| {
        assert_eq!(migrations::user_version(conn)?, 4);
        assert_eq!(columns(conn), fresh_columns, "every table has the V4 columns");
        let objects = |s: &[(String, String, String, Option<String>)]| {
            s.iter()
                .filter(|o| o.0 != "table")
                .cloned()
                .collect::<Vec<_>>()
        };
        assert_eq!(objects(&schema(conn)), objects(&fresh_schema), "indexes and trigger");
        let ok: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
        assert_eq!(ok, "ok");

        conn.execute("ATTACH DATABASE ? AS f", [fixture.to_str().unwrap()])?;
        // raw_json is gone, and raw_gz equals the fixture byte for byte: the
        // fixture was gzipped by Bun, whose deflate zlib-rs reproduces
        same_rows(
            conn,
            "games",
            "game_id, queue_id, game_mode, game_creation, game_duration, is_remake, puuid, game_version, raw_gz",
            "game_id",
        );
        same_rows(conn, "match_participants", "*", "game_id, participant_id");
        same_rows(conn, "match_participant_augments", "*", "game_id, participant_id, slot");
        same_rows(conn, "game_augments", "*", "game_id, slot");
        same_rows(
            conn,
            "player_stats",
            &format!("{PLAYER_STATS_V0}, spell1, spell2"),
            "game_id",
        );
        same_rows(conn, "summoner", "puuid, game_name, tag_line", "puuid");
        let unscored: i64 = conn.query_row(
            "SELECT COUNT(*) FROM main.player_stats WHERE score IS NOT NULL OR score_raw IS NOT NULL",
            [],
            |r| r.get(0),
        )?;
        assert_eq!(unscored, 0, "scores wait for the score backfill");
        conn.execute_batch("DETACH DATABASE f")
    })
    .unwrap();
    db.close();
    keep("v0-migrated", &data);
}

fn lcu_game(game_id: i64, surrendered: bool) -> Value {
    let participant = |id: i64, champion: i64, team: i64, kills: i64| {
        json!({
            "participantId": id, "championId": champion, "teamId": team,
            "spell1Id": 4, "spell2Id": 32,
            "stats": {
                "win": team == 100, "kills": kills, "deaths": 2, "assists": 9,
                "item0": 3089, "playerAugment1": 101, "playerAugment5": 105,
                "gameEndedInEarlySurrender": surrendered,
            }
        })
    };
    json!({
        "gameId": game_id,
        "gameVersion": "16.23.701.1234",
        "participants": [participant(1, 103, 100, 7), participant(2, 22, 200, 3)],
        "participantIdentities": [
            { "player": { "puuid": "owner-puuid", "gameName": "Owner", "tagLine": "NA1" } },
            { "player": { "puuid": "0000-0000", "summonerName": "Bot" } },
        ],
    })
}

#[test]
fn a_hand_made_pre_versioning_database_upgrades() {
    let dir = scratch("v0-hand");
    let path = dir.join("matches.db");
    {
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(V0_DDL).unwrap();
        for (game_id, duration, surrendered) in [(1, 1200, false), (2, 450, true), (3, 200, false)]
        {
            let raw = lcu_game(game_id, surrendered);
            conn.execute(
                "INSERT INTO games VALUES (?, 2400, 'KIWI', ?, ?, ?)",
                rusqlite::params![
                    game_id,
                    1_790_000_000_000i64 + game_id,
                    duration,
                    raw.to_string()
                ],
            )
            .unwrap();
            conn.execute(
                &format!("INSERT INTO player_stats ({PLAYER_STATS_V0}) VALUES (?, 103, 1, 7, 2, 9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3089, NULL, NULL, NULL, NULL, NULL, NULL)"),
                [game_id],
            )
            .unwrap();
            conn.execute("INSERT INTO game_augments VALUES (?, 1, 101)", [game_id])
                .unwrap();
        }
        conn.execute(
            "INSERT INTO settings VALUES ('hide_classic_games', 'true')",
            [],
        )
        .unwrap();
    }

    let db = Database::open(&dir, NOW_MS).unwrap();
    db.with(|conn| {
        assert_eq!(migrations::user_version(conn)?, 4);
        let games = sql_rows(conn, "SELECT game_id, is_remake, puuid, game_version FROM games ORDER BY game_id");
        let row = |id: i64, remake: i64| {
            vec![Sql::Integer(id), Sql::Integer(remake), Sql::Text("owner-puuid".into()), Sql::Text("16.23".into())]
        };
        assert_eq!(games, vec![row(1, 0), row(2, 1), row(3, 1)]);
        assert_eq!(
            sql_rows(conn, "SELECT puuid, game_name, tag_line, updated_at FROM summoner"),
            vec![vec![Sql::Text("owner-puuid".into()), Sql::Text("Owner".into()), Sql::Text("NA1".into()), Sql::Integer(NOW_MS)]]
        );
        assert_eq!(
            sql_rows(conn, "SELECT puuid, game_name, team_id, spell1, item0, is_remake, queue_id FROM match_participants WHERE game_id = 2 ORDER BY participant_id"),
            vec![
                vec![Sql::Text("owner-puuid".into()), Sql::Text("Owner".into()), Sql::Integer(100), Sql::Integer(4), Sql::Integer(3089), Sql::Integer(1), Sql::Integer(2400)],
                vec![Sql::Null, Sql::Text("Bot".into()), Sql::Integer(200), Sql::Integer(4), Sql::Integer(3089), Sql::Integer(1), Sql::Integer(2400)],
            ]
        );
        assert_eq!(
            sql_rows(conn, "SELECT slot, augment_id FROM game_augments WHERE game_id = 1 ORDER BY slot"),
            vec![vec![Sql::Integer(1), Sql::Integer(101)], vec![Sql::Integer(5), Sql::Integer(105)]],
            "slot 5 widened from everyone's augments"
        );
        assert_eq!(
            sql_rows(conn, "SELECT spell1, spell2 FROM player_stats WHERE game_id = 1"),
            vec![vec![Sql::Integer(4), Sql::Integer(32)]]
        );
        assert_eq!(
            sql_rows(conn, "SELECT key, value FROM settings WHERE key IN ('hidden_queues', 'augment_slots') ORDER BY key"),
            vec![
                vec![Sql::Text("augment_slots".into()), Sql::Text("6".into())],
                vec![Sql::Text("hidden_queues".into()), Sql::Text("2450".into())],
            ]
        );
        let raw: Vec<u8> = conn.query_row("SELECT raw_gz FROM games WHERE game_id = 1", [], |r| r.get(0))?;
        assert_eq!(gunzip(&raw), lcu_game(1, false).to_string().into_bytes(), "the text is compressed as stored");
        assert!(conn.prepare("SELECT raw_json FROM games").is_err(), "raw_json is dropped");
        Ok(())
    })
    .unwrap();
}

#[test]
fn every_fixture_payload_repacks_to_its_own_bytes() {
    let dir = scratch("payloads");
    let Some(fixture) = fixture_copy(&dir) else {
        return;
    };
    let conn = Connection::open(&fixture).unwrap();
    let blobs: Vec<Vec<u8>> = conn
        .prepare("SELECT raw_gz FROM games WHERE raw_gz IS NOT NULL ORDER BY game_id")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert!(!blobs.is_empty());
    for blob in &blobs {
        let raw = payloads::unpack_raw(Some(blob)).expect("a fixture payload unpacks");
        let text = gunzip(blob);
        assert_eq!(
            bmt_lib::db::js::stringify(&raw).as_bytes(),
            text,
            "JSON.stringify text"
        );
        assert_eq!(&payloads::pack_raw(&raw), blob, "gzip bytes");
    }
    println!("{} payloads repack byte for byte", blobs.len());
}

#[test]
fn node_gzip_and_ours_hold_the_same_text() {
    let golden: Value = serde_json::from_str(
        &std::fs::read_to_string(manifest_dir().join("tests/fixtures/node-gzip.json"))
            .expect("the Node gzip golden"),
    )
    .unwrap();
    let text = golden["text"].as_str().unwrap();
    let node: Vec<u8> = golden["gzip"]
        .as_array()
        .unwrap()
        .iter()
        .map(|b| b.as_u64().unwrap() as u8)
        .collect();
    let raw: Value = serde_json::from_str(text).unwrap();
    let ours = payloads::pack_raw(&raw);
    assert_eq!(gunzip(&ours), gunzip(&node), "the same JSON text");
    assert_eq!(ours[..4], node[..4], "the same gzip header flags");
    // The fixture was gzipped on macOS. Chromium's zlib, which Node and
    // Electron build, writes its OS_CODE: 10 under WIN32, 19 under
    // __APPLE__, 3 elsewhere (third_party/zlib/zutil.h)
    assert_eq!(node[9], 19, "the fixture's macOS OS byte");
    let platform = if cfg!(windows) {
        10
    } else if cfg!(target_os = "macos") {
        19
    } else {
        3
    };
    assert_eq!(
        ours[9], platform,
        "the OS byte Electron writes on this platform"
    );
    assert_eq!(
        payloads::unpack_raw(Some(&node)),
        Some(raw),
        "Rust reads what Node wrote"
    );
}

/// The perf probe for T11's open-and-migrate metric, warm cache:
/// `cargo test --release --test db_compat -- --ignored --nocapture`.
#[test]
#[ignore]
fn open_timing_on_the_fixture() {
    let dir = scratch("timing");
    let Some(fixture) = fixture_copy(&dir) else {
        return;
    };
    let data = dir.join("data");
    std::fs::create_dir_all(&data).unwrap();
    let mut current = Vec::new();
    let mut from_v0 = Vec::new();
    for _ in 0..20 {
        std::fs::copy(&fixture, data.join("matches.db")).unwrap();
        as_electron_left_it(&data.join("matches.db"));
        let started = std::time::Instant::now();
        Database::open(&data, NOW_MS).unwrap().close();
        current.push(started.elapsed().as_secs_f64() * 1000.0);

        std::fs::remove_file(data.join("matches.db")).unwrap();
        v0_from_fixture(&fixture, &data.join("matches.db"));
        let started = std::time::Instant::now();
        Database::open(&data, NOW_MS).unwrap().close();
        from_v0.push(started.elapsed().as_secs_f64() * 1000.0);
        std::fs::remove_file(data.join("matches.db")).unwrap();
    }
    let median = |v: &mut Vec<f64>| {
        v.sort_by(f64::total_cmp);
        (v[9] + v[10]) / 2.0
    };
    println!(
        "open+close, 20 runs: current database median {:.2} ms (min {:.2}, max {:.2}); from V0 median {:.1} ms",
        median(&mut current),
        current[0],
        current[19],
        median(&mut from_v0)
    );
}

#[test]
fn a_write_waits_out_another_process_holding_the_lock() {
    let dir = scratch("busy");
    let db = fresh(&dir);
    let holder = Connection::open(dir.join("matches.db")).unwrap();
    holder
        .execute_batch("BEGIN IMMEDIATE; INSERT INTO settings VALUES ('held', '1');")
        .unwrap();
    let release = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(1500));
        holder.execute_batch("COMMIT").unwrap();
    });
    let started = std::time::Instant::now();
    db.with(|conn| bmt_lib::db::settings::set_setting(conn, "hide_remakes", "true"))
        .expect("the write waits for the lock and lands");
    let waited = started.elapsed();
    release.join().unwrap();
    assert!(
        waited >= std::time::Duration::from_millis(1400),
        "waited {waited:?}"
    );
    let value = db
        .with(|conn| bmt_lib::db::settings::get_setting(conn, "hide_remakes"))
        .unwrap();
    assert_eq!(value.as_deref(), Some("true"));
}

/// An Electron outcome from `probe-errors.ts` (`electron-errors.json`).
fn electron_error(case: &str) -> (String, String) {
    let path = manifest_dir().join("tests/fixtures/electron-errors.json");
    let all: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let outcome = &all["cases"][case];
    assert_eq!(outcome["kind"], "error", "{case}");
    (
        outcome["name"].as_str().unwrap().to_owned(),
        outcome["message"].as_str().unwrap().to_owned(),
    )
}

fn surfaced<T>(result: rusqlite::Result<T>) -> (String, String) {
    let Err(err) = result else {
        panic!("expected an error");
    };
    let err = bmt_lib::db::sqlite_error(&err);
    (err.name, err.message)
}

/// Each failure surfaces with the name and message better-sqlite3 gives it
/// in trunk Electron: `sqlite3_errmsg` alone, without the path or SQL
/// rusqlite adds, and a JavaScript throw under its own name.
#[test]
fn errors_surface_as_better_sqlite3_throws_them() {
    let dir = scratch("errors");
    let mem = || {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE t (a INTEGER PRIMARY KEY, b TEXT NOT NULL, c INTEGER UNIQUE);
             INSERT INTO t VALUES (1, 'x', 1);",
        )
        .unwrap();
        conn
    };
    let run = |sql: &str| surfaced(mem().prepare(sql).and_then(|mut s| s.raw_execute()));
    let cases: Vec<(&str, (String, String))> = vec![
        (
            "cantopen_missing_dir",
            surfaced(Database::open(&dir.join("no-such-dir"), NOW_MS)),
        ),
        (
            "cantopen_directory",
            surfaced(bmt_lib::db::connection::open(&dir)),
        ),
        ("no_such_table", run("SELECT * FROM nowhere")),
        ("syntax", run("SELEC 1")),
        ("unique", run("INSERT INTO t VALUES (2, 'y', 1)")),
        ("primary_key", run("INSERT INTO t VALUES (1, 'y', 2)")),
        ("not_null", run("INSERT INTO t (a, c) VALUES (3, 3)")),
        ("mismatch", run("INSERT INTO t VALUES (1.5, 'y', 4)")),
        (
            "exec_no_such_table",
            surfaced(mem().execute_batch("SELECT * FROM nowhere")),
        ),
        ("busy", {
            let file = dir.join("busy.db");
            let a = Connection::open(&file).unwrap();
            a.execute_batch("CREATE TABLE IF NOT EXISTS x (v); BEGIN IMMEDIATE")
                .unwrap();
            let b = Connection::open(&file).unwrap();
            b.busy_timeout(std::time::Duration::ZERO).unwrap();
            surfaced(b.execute("INSERT INTO x VALUES (1)", []))
        }),
        ("not_a_database", {
            let garbage = dir.join("garbage");
            std::fs::create_dir_all(&garbage).unwrap();
            std::fs::write(garbage.join("matches.db"), [7u8; 4096]).unwrap();
            surfaced(Database::open(&garbage, NOW_MS))
        }),
        ("closed", {
            let db = fresh(&scratch("errors-closed"));
            db.close();
            let err = db.with(|_| Ok(())).unwrap_err();
            (err.name, err.message)
        }),
    ];
    for (case, ours) in cases {
        assert_eq!(ours, electron_error(case), "{case}");
    }

    // upsertSummoner(null) throws reading `summoner.puuid`
    let db = fresh(&scratch("errors-type"));
    let err = db
        .with(|conn| bmt_lib::db::summoner::upsert_summoner(conn, &Value::Null, NOW_MS))
        .unwrap_err();
    assert_eq!(
        (err.name.as_str(), err.message.as_str()),
        (
            "TypeError",
            "Cannot read properties of null (reading 'puuid')"
        )
    );
}

/// `js::transaction` against better-sqlite3's wrapper in trunk Electron: a
/// function that ends the transaction itself fails with SQLite's message
/// for the savepoint better-sqlite3 names, an inner throw undoes only the
/// inner writes, and a panic leaves no transaction open.
#[test]
fn transactions_nest_and_fail_as_better_sqlite3s_do() {
    use bmt_lib::db::js::transaction;
    let mem = || {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE t (a INTEGER PRIMARY KEY); INSERT INTO t VALUES (1)")
            .unwrap();
        conn
    };
    let conn = mem();
    let inner_commits = transaction(&conn, || {
        transaction(&conn, || conn.execute_batch("COMMIT"))
    });
    assert_eq!(
        surfaced(inner_commits),
        electron_error("tx_inner_commits_outer")
    );
    let conn = mem();
    let rolls_back = transaction(&conn, || conn.execute_batch("ROLLBACK"));
    assert_eq!(surfaced(rolls_back), electron_error("tx_rolls_back_itself"));
    let conn = mem();
    let inner_rolls_back = transaction(&conn, || {
        transaction(&conn, || conn.execute_batch("ROLLBACK"))
    });
    assert_eq!(
        surfaced(inner_rolls_back),
        electron_error("tx_inner_rolls_back_outer")
    );

    let conn = mem();
    transaction(&conn, || {
        conn.execute("INSERT INTO t VALUES (10)", [])?;
        let inner = transaction(&conn, || {
            conn.execute("INSERT INTO t VALUES (11)", [])?;
            Err::<(), _>(rusqlite::Error::InvalidQuery)
        });
        assert!(inner.is_err());
        Ok(())
    })
    .unwrap();
    let kept: Vec<i64> = conn
        .prepare("SELECT a FROM t ORDER BY a")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    let path = manifest_dir().join("tests/fixtures/electron-errors.json");
    let all: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    assert_eq!(
        json!(kept),
        all["cases"]["tx_inner_throw_keeps_outer"]["value"]
    );

    for nested in [false, true] {
        let conn = mem();
        if nested {
            conn.execute_batch("BEGIN").unwrap();
        }
        let unwound = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            transaction(&conn, || -> rusqlite::Result<()> {
                conn.execute("INSERT INTO t VALUES (20)", [])?;
                panic!("a panic inside the transaction");
            })
        }));
        assert!(unwound.is_err());
        assert_eq!(
            conn.is_autocommit(),
            !nested,
            "nested {nested}: only the caller's transaction is open"
        );
        let rows: i64 = conn
            .query_row("SELECT count(*) FROM t", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 1, "nested {nested}: the panicked insert is undone");
        if nested {
            conn.execute_batch("COMMIT").unwrap();
        }
        transaction(&conn, || conn.execute_batch("INSERT INTO t VALUES (30)")).unwrap();
        assert!(
            conn.is_autocommit(),
            "nested {nested}: the next transaction commits for real"
        );
    }
}

/// One argument as a test writes it: JSON, `undefined`, or a value Rust
/// holds (a Buffer, a BigInt, a NaN).
enum A {
    J(Value),
    U,
    S(Sql),
}

/// The arguments `probe-binder.ts` passed for each case, as Rust writes
/// them. `None` for the cases no Rust value can stand for.
fn binder_args(case: &str) -> Option<Vec<A>> {
    use A::{J, S, U};
    let base = || {
        vec![
            J(json!(5)),
            J(json!(2400)),
            J(json!("KIWI")),
            J(json!(1_790_000_000_000i64)),
            J(json!(1500)),
            J(json!(0)),
            J(json!("p")),
            J(json!("16.23")),
            S(Sql::Blob(b"x".to_vec())),
        ]
    };
    let at = |changes: Vec<(usize, A)>| {
        let mut args = base();
        for (position, arg) in changes {
            args[position - 1] = arg;
        }
        Some(args)
    };
    let blob = |b: &[u8]| S(Sql::Blob(b.to_vec()));
    match case {
        "ingest_ok" => at(vec![]),
        "object_empty" => at(vec![(1, J(json!({})))]),
        "object_with_keys" => at(vec![(1, J(json!({ "a": 1 })))]),
        "object_last" => at(vec![(9, J(json!({})))]),
        "two_objects" => at(vec![(1, J(json!({}))), (3, J(json!({})))]),
        "object_then_boolean" => at(vec![(1, J(json!({}))), (3, J(json!(true)))]),
        "boolean_then_object" => at(vec![(1, J(json!(true))), (3, J(json!({})))]),
        "array_of_one" => at(vec![(1, J(json!([5])))]),
        "array_of_two" => at(vec![(1, J(json!([5, 6])))]),
        "array_empty" => at(vec![(1, J(json!([])))]),
        "array_nested" => at(vec![(1, J(json!([[5]])))]),
        "array_holding_object" => at(vec![(1, J(json!([{}])))]),
        "array_holding_boolean" => at(vec![(1, J(json!([true])))]),
        "array_holding_null" => at(vec![(1, J(json!([null])))]),
        "boolean_true" => at(vec![(1, J(json!(true)))]),
        "boolean_false" => at(vec![(2, J(json!(false)))]),
        "undefined_nullable" => at(vec![(8, U)]),
        "undefined_not_null" => at(vec![(2, U)]),
        "null_id" => at(vec![(1, J(Value::Null))]),
        "fractional_id" => at(vec![(1, J(json!(1.5)))]),
        "string_id" => at(vec![(1, J(json!("77")))]),
        "buffer" | "uint8array" => at(vec![(9, blob(&[1, 2]))]),
        "bigint" => at(vec![(1, S(Sql::Integer(5)))]),
        "bigint_creation" => at(vec![(4, S(Sql::Integer(1_790_000_000_000)))]),
        "nan_not_null" => at(vec![(4, S(Sql::Real(f64::NAN)))]),
        "nan_nullable" => at(vec![(8, S(Sql::Real(f64::NAN)))]),
        "infinity" => at(vec![
            (4, S(Sql::Real(f64::INFINITY))),
            (5, S(Sql::Real(f64::NEG_INFINITY))),
        ]),
        "negative_zero" => at(vec![(4, S(Sql::Real(-0.0)))]),
        "too_many" => {
            let mut args = base();
            args.push(J(json!(1)));
            Some(args)
        }
        "too_few" => {
            let mut args = base();
            args.pop();
            Some(args)
        }
        "no_arguments" | "named_none" => Some(vec![]),
        "anon_numbers" => Some(vec![J(json!(5)), J(json!(5.5))]),
        "anon_bigint" => Some(vec![S(Sql::Integer(5)), S(Sql::Integer(-1))]),
        "anon_nan_infinity" => Some(vec![S(Sql::Real(f64::NAN)), S(Sql::Real(f64::INFINITY))]),
        "anon_negative_zero" => Some(vec![S(Sql::Real(-0.0)), J(json!(1e300))]),
        "anon_blobs" => Some(vec![blob(&[0, 255]), blob(&[7])]),
        "anon_strings" => Some(vec![J(json!("")), J(json!("é😀"))]),
        "named_ok" => Some(vec![J(json!({ "a": 1, "b": "x" }))]),
        "named_missing" => Some(vec![J(json!({ "a": 1 }))]),
        "named_extra_keys" => Some(vec![J(json!({ "a": 1, "b": 2, "c": 3 }))]),
        "named_positional" => Some(vec![J(json!(1)), J(json!(2))]),
        "named_two_objects" => Some(vec![J(json!({ "a": 1 })), J(json!({ "b": 2 }))]),
        "named_object_value" => Some(vec![J(json!({ "a": {}, "b": 1 }))]),
        "named_array_value" => Some(vec![J(json!({ "a": [1], "b": 1 }))]),
        "named_boolean_value" => Some(vec![J(json!({ "a": true, "b": 1 }))]),
        "named_in_array" => Some(vec![J(json!([{ "a": 1, "b": 2 }]))]),
        "named_null_prototype" => Some(vec![J(json!({ "a": 1, "b": 2 }))]),
        "mixed_ok" => Some(vec![J(json!(1)), J(json!({ "a": 2 }))]),
        "mixed_object_first" => Some(vec![J(json!({ "a": 2 })), J(json!(1))]),
        "mixed_only_object" => Some(vec![J(json!({ "a": 2 }))]),
        "mixed_only_positional" => Some(vec![J(json!(1))]),
        "mixed_array" => Some(vec![J(json!([1])), J(json!({ "a": 2 }))]),
        "named_first_ok" => Some(vec![J(json!({ "a": 1 })), J(json!(2))]),
        "named_first_positional" => Some(vec![J(json!(2)), J(json!({ "a": 1 }))]),
        _ => None,
    }
}

/// Every argument shape `probe-binder.ts` ran through better-sqlite3 in
/// trunk Electron binds through `js::run` to the same rows, or fails with
/// the same error name and message (`electron-binder.json`).
#[test]
fn arguments_bind_as_better_sqlite3_binds_them() {
    use bmt_lib::db::js::{self, Arg};
    let path = manifest_dir().join("tests/fixtures/electron-binder.json");
    let probe: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let mut not_representable = Vec::new();
    for case in probe["cases"].as_array().unwrap() {
        let id = case["id"].as_str().unwrap();
        let Some(args) = binder_args(id) else {
            not_representable.push(id);
            continue;
        };
        let args: Vec<Arg> = args
            .iter()
            .map(|a| match a {
                A::J(v) => Arg::Js(Some(v)),
                A::U => Arg::Js(None),
                A::S(v) => Arg::Sql(v.clone()),
            })
            .collect();
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(probe["games"].as_str().unwrap())
            .unwrap();
        conn.execute_batch("CREATE TABLE r (a, b)").unwrap();
        let stmt_id = case["stmt"].as_str().unwrap();
        let sql = probe["sql"][stmt_id].as_str().unwrap();
        let result = js::run(&mut conn.prepare(sql).unwrap(), &args);
        let electron = &case["outcome"];
        match result {
            Ok(changes) => {
                assert_eq!(
                    electron["kind"], "ok",
                    "{id}: ours ran, Electron's threw {electron}"
                );
                assert_eq!(json!(changes), electron["changes"], "{id}");
                let table = if stmt_id == "ingest" { "games" } else { "r" };
                let cols: Vec<String> = conn
                    .prepare(&format!("SELECT name FROM pragma_table_info('{table}')"))
                    .unwrap()
                    .query_map([], |r| r.get(0))
                    .unwrap()
                    .collect::<rusqlite::Result<_>>()
                    .unwrap();
                let parts: Vec<String> = cols
                    .iter()
                    .map(|c| format!("typeof({c}), quote({c})"))
                    .collect();
                let rows: Vec<Value> = conn
                    .prepare(&format!(
                        "SELECT {} FROM {table} ORDER BY rowid",
                        parts.join(", ")
                    ))
                    .unwrap()
                    .query_map([], |r| {
                        Ok(Value::Array(
                            (0..cols.len() * 2)
                                .map(|i| match r.get_ref(i).unwrap() {
                                    rusqlite::types::ValueRef::Text(t) => {
                                        json!(String::from_utf8_lossy(t))
                                    }
                                    other => {
                                        panic!("{id}: typeof and quote are text, got {other:?}")
                                    }
                                })
                                .collect(),
                        ))
                    })
                    .unwrap()
                    .collect::<rusqlite::Result<_>>()
                    .unwrap();
                assert_eq!(json!(rows), electron["rows"], "{id}");
            }
            Err(err) => {
                let err = bmt_lib::db::sqlite_error(&err);
                assert_eq!(
                    (json!(err.name), json!(err.message)),
                    (electron["name"].clone(), electron["message"].clone()),
                    "{id}"
                );
            }
        }
    }
    assert_eq!(
        not_representable,
        [
            "date",
            "arraybuffer",
            "string_object",
            "bigint_too_big",
            "named_undefined_value",
            "named_date"
        ],
        "a JavaScript Date, ArrayBuffer, String object, oversized BigInt or undefined property has no Rust value"
    );
}

/// One `games` row and its `player_stats` line for a pre-versioning
/// database. The line is what the V1 backfill matches the owner by.
fn insert_v0_game(conn: &Connection, game_id: i64, raw_json: &[u8]) {
    conn.execute(
        "INSERT INTO games VALUES (?, 2400, 'KIWI', ?, 1500, CAST(? AS TEXT))",
        rusqlite::params![game_id, 1_790_000_000_000i64 + game_id, raw_json],
    )
    .unwrap();
    conn.execute(
        &format!("INSERT INTO player_stats ({PLAYER_STATS_V0}) VALUES (?, 103, 1, 7, 2, 9, 0, 0, 0, 0, 0, 0, 0, 0, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL)"),
        [game_id],
    )
    .unwrap();
}

/// Builds a pre-versioning database from `games`, leaves it for the Electron
/// lane under `<name>-source`, migrates it in Rust, and leaves the result
/// under `<name>-rust`.
fn migrate_v0(name: &str, games: &[(i64, Vec<u8>)]) -> (PathBuf, Database) {
    let dir = scratch(name);
    {
        let conn = Connection::open(dir.join("matches.db")).unwrap();
        conn.execute_batch(V0_DDL).unwrap();
        for (game_id, raw) in games {
            insert_v0_game(&conn, *game_id, raw);
        }
    }
    keep(&format!("{name}-source"), &dir);
    let db = Database::open(&dir, NOW_MS).unwrap();
    db.close();
    keep(&format!("{name}-rust"), &dir);
    db.reopen(NOW_MS).unwrap();
    (dir, db)
}

/// A cell as `capture-cells.py` writes it: TEXT and BLOB as hex, REAL as
/// its f64 bits, `raw_gz` as its gunzipped text.
fn typed_cell(column: &str, value: rusqlite::types::ValueRef<'_>) -> Value {
    use rusqlite::types::ValueRef;
    let hex = |b: &[u8]| b.iter().map(|x| format!("{x:02x}")).collect::<String>();
    match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => json!({ "int": i.to_string() }),
        ValueRef::Real(f) => json!({ "real": format!("{:016x}", f.to_bits()) }),
        ValueRef::Text(t) => json!({ "text": hex(t) }),
        ValueRef::Blob(b) if column == "raw_gz" => json!({ "gunzipped": hex(&gunzip(b)) }),
        ValueRef::Blob(b) => json!({ "blob": hex(b) }),
    }
}

/// Every query of an Electron capture, run on `conn`, cell for cell.
fn same_cells_as_electron(conn: &Connection, fixture: &str) {
    let path = manifest_dir().join("tests/fixtures").join(fixture);
    let electron: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(
        migrations::user_version(conn).unwrap(),
        electron["user_version"].as_i64().unwrap()
    );
    for query in electron["queries"].as_array().unwrap() {
        let sql = query["sql"].as_str().unwrap();
        let mut stmt = conn.prepare(sql).unwrap();
        let names: Vec<String> = stmt.column_names().map(str::to_owned).collect();
        let ours: Vec<Value> = stmt
            .query_map([], |row| {
                Ok(Value::Array(
                    (0..names.len())
                        .map(|i| typed_cell(&names[i], row.get_ref(i).unwrap()))
                        .collect(),
                ))
            })
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        let theirs = query["rows"].as_array().unwrap();
        for (i, (a, b)) in ours.iter().zip(theirs).enumerate() {
            let differ: Vec<String> = names
                .iter()
                .enumerate()
                .filter(|(c, _)| a[*c] != b[*c])
                .map(|(c, name)| format!("{name}: ours {} electron {}", a[c], b[c]))
                .collect();
            assert!(
                differ.is_empty(),
                "{sql}\n  row {i}: {}",
                differ.join("\n    ")
            );
        }
        assert_eq!(ours.len(), theirs.len(), "{sql}: row count");
    }
}

/// Payloads that reach the JavaScript edges a migration crosses: names that
/// are present but empty, lone surrogates, floats a fast parser misrounds,
/// and invalid UTF-8 in the stored text. The cells must equal what trunk
/// Electron 1.2.1 wrote migrating the same file
/// (`electron-hostile-v0.json`, from `capture-cells.py`).
#[test]
fn hostile_payloads_migrate_to_the_cells_electron_writes() {
    let mut invalid_utf8 = br#"{"gameId":15,"gameVersion":"16.23.1.2","participants":[{"participantId":1,"championId":103,"teamId":100,"stats":{"win":true,"kills":7,"deaths":2,"assists":9}}],"participantIdentities":[{"player":{"puuid":"owner-15","gameName":"C"#.to_vec();
    invalid_utf8.extend_from_slice(b"\xed\xa0\xbdD\",\"tagLine\":\"E\xf0\x9f\x98F\"}}]}");
    let games = [
        (11, br#"{"gameId":11,"gameVersion":"16.23.1.2","participants":[{"participantId":1,"championId":103,"teamId":100,"spell1Id":4,"spell2Id":32,"puuid":"owner-11","riotIdGameName":"","riotIdTagline":"","win":true,"kills":7,"deaths":2,"assists":9},{"participantId":2,"championId":22,"teamId":200,"spell1Id":4,"spell2Id":32,"puuid":"other-11","riotIdGameName":"Other","riotIdTagline":"","win":false,"kills":1,"deaths":5,"assists":2}]}"#.to_vec()),
        (12, br#"{"gameId":12,"gameVersion":"16.23.1.2","participants":[{"participantId":1,"championId":103,"teamId":100,"stats":{"win":true,"kills":7,"deaths":2,"assists":9,"playerAugment1":101}},{"participantId":2,"championId":22,"teamId":200,"stats":{"win":false,"kills":1,"deaths":5,"assists":2}},{"participantId":3,"championId":23,"teamId":200,"stats":{"win":false}},{"participantId":4,"championId":24,"teamId":200,"stats":{"win":false}},{"participantId":5,"championId":25,"teamId":200,"stats":{"win":false}}],"participantIdentities":[{"player":{"puuid":"owner-12\ud800","gameName":"A\ud83d","tagLine":"\udc00NA"}},{"player":{"puuid":"p2-12","summonerName":"B\ud83d\nC","tagLine":"\ud83d\ud83d"}},{"player":{"puuid":"p3-12","gameName":"\ud83d\u0041","tagLine":"\uD83D\uDE00 ok"}},{"player":{"puuid":"p4-12","gameName":"\ud83d\ud83d\ude00","tagLine":"\ude00\ud83d"}},{"player":{"puuid":"p5-12","gameName":"x\udbff\udfff\udc00","tagLine":"\\ud800"}}],"extra":{"\ud800":1,"\ud801":2}}"#.to_vec()),
        (13, br#"{"gameId":13,"gameVersion":"16.23.1.2","extra":{"b":1,"2":0,"1":0},"participants":[{"participantId":1,"championId":103,"teamId":100,"stats":{"win":true,"kills":7,"deaths":2,"assists":9,"totalHeal":0.45454545454545453,"goldEarned":9.241516992974401e+110,"totalDamageTaken":1.0063725663392093e+82,"largestKillingSpree":-3.8017925100238707e+197,"totalDamageDealtToChampions":9.24151699297440102308e+110}}],"participantIdentities":[{"player":{"puuid":"owner-13","gameName":"Owner","tagLine":"NA1"}}]}"#.to_vec()),
        (14, br#"{"gameId":14,"gameVersion":"16.23.1.2","participants":[{"participantId":1,"championId":103,"teamId":100,"summonerName":"","stats":{"win":true,"kills":7,"deaths":2,"assists":9}}],"participantIdentities":[{"player":{"puuid":"owner-14","gameName":"","summonerName":"","tagLine":""}}]}"#.to_vec()),
        (15, invalid_utf8),
    ];
    let (_dir, db) = migrate_v0("hostile-v0", &games);
    db.with(|conn| {
        same_cells_as_electron(conn, "electron-hostile-v0.json");
        Ok(())
    })
    .unwrap();
}

/// Owner puuids that aren't strings reach better-sqlite3's binder in the V1
/// backfill: an array spreads into the statement's parameters, an object
/// binds as named parameters, a boolean throws, a number binds as a double.
/// The backfill's catch keeps what ran before a throw. The cells must equal
/// Electron's (`electron-binder-v0.json`).
#[test]
fn owners_that_are_not_strings_bind_as_better_sqlite3_binds_them() {
    let game = |id: i64, player: &str| {
        format!(
            r#"{{"gameId":{id},"gameVersion":"16.23.1.2","participants":[{{"participantId":1,"championId":103,"teamId":100,"stats":{{"win":true,"kills":7,"deaths":2,"assists":9}}}}],"participantIdentities":[{{"player":{player}}}]}}"#
        )
        .into_bytes()
    };
    let games = [
        (
            16,
            game(
                16,
                r#"{"puuid":["arr-16"],"gameName":"N16","tagLine":"T16"}"#,
            ),
        ),
        (
            17,
            game(17, r#"{"puuid":{"a":1},"gameName":"N17","tagLine":"T17"}"#),
        ),
        (
            19,
            game(19, r#"{"puuid":true,"gameName":"N19","tagLine":"T19"}"#),
        ),
        (
            21,
            game(21, r#"{"puuid":12345,"gameName":"N21","tagLine":"T21"}"#),
        ),
        (
            23,
            game(23, r#"{"puuid":[],"gameName":"N23","tagLine":"T23"}"#),
        ),
        (
            24,
            game(
                24,
                r#"{"puuid":["a-24","b-24"],"gameName":"N24","tagLine":"T24"}"#,
            ),
        ),
    ];
    let (_dir, db) = migrate_v0("binder-v0", &games);
    db.with(|conn| {
        same_cells_as_electron(conn, "electron-binder-v0.json");
        Ok(())
    })
    .unwrap();
}

/// Number formatting and `JSON.stringify(JSON.parse(text))` against Node's
/// answers, which `docs/tauri-port/units/T11/js-fuzz.mjs` writes into the
/// folder `BMT_JS_FUZZ` names. A text goes in through `unpack_raw`, the path
/// every stored payload takes.
#[test]
#[ignore]
fn js_semantics_match_node() {
    let dir = PathBuf::from(std::env::var_os("BMT_JS_FUZZ").expect("set BMT_JS_FUZZ"));
    let numbers = std::fs::read_to_string(dir.join("numbers.txt")).unwrap();
    let mut number_misses = BTreeSet::new();
    let mut count = 0;
    for line in numbers.lines() {
        let (hex, node) = line.split_once(' ').unwrap();
        let x = f64::from_bits(u64::from_str_radix(hex, 16).unwrap());
        count += 1;
        let ours = bmt_lib::db::js::number_to_string(x);
        if ours != node {
            number_misses.insert(format!("{hex}: node {node}, ours {ours}"));
        }
    }
    println!(
        "numbers: {} distinct of {count} differ",
        number_misses.len()
    );
    for miss in number_misses.iter().take(20) {
        println!("  {miss}");
    }

    let cases: Vec<Value> =
        serde_json::from_str(&std::fs::read_to_string(dir.join("json.json")).unwrap()).unwrap();
    let mut json_misses = BTreeSet::new();
    let mut lossy = 0;
    for case in &cases {
        let text = case["text"].as_str().unwrap();
        let (want, bound) = (
            case["want"].as_str().unwrap(),
            case["wantBound"].as_str().unwrap(),
        );
        let ours = match payloads::unpack_raw(Some(&payloads::gzip(text.as_bytes()))) {
            Some(v) => bmt_lib::db::js::stringify(&v),
            None if want.starts_with("THROW ") => want.to_owned(),
            None => "unparsed".to_owned(),
        };
        if want != bound {
            lossy += 1;
        }
        if ours != bound {
            json_misses.insert(format!("{text}\n    node  {bound}\n    ours  {ours}"));
        }
    }
    println!(
        "json: {} distinct of {} differ from Node with lone surrogates as U+FFFD; {lossy} hold a lone surrogate",
        json_misses.len(),
        cases.len()
    );
    for miss in json_misses.iter().take(10) {
        println!("  {}", miss.chars().take(400).collect::<String>());
    }
    assert!(number_misses.is_empty() && json_misses.is_empty());
}
