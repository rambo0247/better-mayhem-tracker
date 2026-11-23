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
    assert_eq!(ours[9], node[9], "the same OS byte");
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
