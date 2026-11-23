//! Scores every fixture game in Rust and compares each value with Electron's
//! as raw f64 bits, then re-ingests every stored payload and compares the
//! rows it writes with the rows Electron wrote.
//!
//! `BMT_GOLDEN_DATA` names the fixture's data folder, the one holding
//! `matches.db`, as for `golden.rs`; its `player_stats` scores are Electron's, so they are
//! the reference. `BMT_SCORE_GOLDEN` names the JSON `parity/score-golden.ts`
//! wrote, every player's TypeScript score. `BMT_ELECTRON_BACKFILL` lists
//! folders, each holding `before.db`, the `after.db` Electron's score
//! backfill made of it, and the `champion-cache.json` it ran with. Every
//! database is copied to a temp folder before it opens. Without
//! `BMT_GOLDEN_DATA` only the backfill folders run.

// clippy.toml keeps wall-clock reads out of command bodies; this test times its own runs
#![allow(clippy::disallowed_methods)]

use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Instant;

use bmt_lib::db::ingest::insert_game_full;
use bmt_lib::db::payloads::unpack_raw;
use bmt_lib::db::scoring::{
    ChampionClasses, OwnerFallback, SCORE_ROW_COLUMNS, ScoreRow, check_score_backfill,
    compute_owner_score, group_by_game,
};
use bmt_lib::db::{connection, schema, stmt};
use bmt_lib::db_row;
use bmt_lib::op_score::{ChampionClassMap, ScoreInput, compute_match_scores};
use rusqlite::types::ValueRef;
use rusqlite::{Connection, params};
use serde_json::Value;

/// A column as SQLite stores it, so a REAL and an INTEGER of the same value
/// differ, and a REAL compares by its bits.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Stored {
    Null,
    Integer(i64),
    Real(u64),
    Text(String),
    Blob(Vec<u8>),
}

impl Stored {
    fn read(v: ValueRef<'_>) -> Self {
        match v {
            ValueRef::Null => Stored::Null,
            ValueRef::Integer(i) => Stored::Integer(i),
            ValueRef::Real(f) => Stored::Real(f.to_bits()),
            ValueRef::Text(t) => Stored::Text(String::from_utf8_lossy(t).into_owned()),
            ValueRef::Blob(b) => Stored::Blob(b.to_vec()),
        }
    }
}

fn rows(conn: &Connection, sql: &str, game_id: i64) -> Vec<Vec<(String, Stored)>> {
    let mut stmt = conn.prepare(sql).unwrap();
    let names: Vec<String> = stmt.column_names().map(str::to_owned).collect();
    stmt.query_map([game_id], |row| {
        Ok(names
            .iter()
            .enumerate()
            .map(|(i, name)| (name.clone(), Stored::read(row.get_ref(i).unwrap())))
            .collect())
    })
    .unwrap()
    .collect::<rusqlite::Result<_>>()
    .unwrap()
}

fn champion_classes(file: &Path) -> ChampionClasses {
    let cache: Value = serde_json::from_str(&std::fs::read_to_string(file).unwrap()).unwrap();
    let mut classes = ChampionClassMap::new();
    for (id, champ) in cache["champions"].as_object().unwrap() {
        if let Some(class) = champ["class"].as_str().filter(|c| !c.is_empty()) {
            classes.insert(id.parse().unwrap(), class.to_owned());
        }
    }
    ChampionClasses {
        version: cache["version"].as_str().unwrap().to_owned(),
        classes,
    }
}

/// A fresh copy of `db` in its own temp folder, opened as the app opens it.
fn open_copy(db: &Path, tag: &str) -> (PathBuf, Connection) {
    let dir = std::env::temp_dir().join(format!("bmt-score-golden-{tag}-{}", std::process::id()));
    std::fs::remove_dir_all(&dir).ok();
    std::fs::create_dir_all(&dir).unwrap();
    let copy = dir.join("matches.db");
    std::fs::copy(db, &copy).unwrap();
    let conn = connection::open(&copy).unwrap();
    schema::init_database(&conn, 0).unwrap();
    (dir, conn)
}

db_row! {
    struct OwnerGame {
        game_id: i64,
        puuid: String,
        is_remake: i64,
        champion_id: f64,
        kills: f64,
        deaths: f64,
        assists: f64,
        score: Option<f64>,
        score_raw: Option<f64>,
        score_badge: Option<String>,
    }
}

const OWNER_GAMES: &str =
    "SELECT g.game_id, g.puuid, g.is_remake, ps.champion_id, ps.kills, ps.deaths, ps.assists,
        ps.score, ps.score_raw, ps.score_badge
 FROM games g JOIN player_stats ps ON g.game_id = ps.game_id ORDER BY g.game_id";

const SCORE_COLUMNS: &str = "SELECT game_id, score, score_raw, score_badge FROM player_stats WHERE game_id >= ? ORDER BY game_id";

fn bits(v: Option<f64>) -> Option<u64> {
    v.map(f64::to_bits)
}

/// Every stored owner score against the one Rust computes from the same rows.
fn stored_scores(conn: &Connection, champions: &ChampionClasses, failures: &mut Vec<String>) {
    let games: Vec<OwnerGame> = stmt::all(conn, OWNER_GAMES, []).unwrap();
    let participants = group_by_game(
        stmt::all(
            conn,
            &format!("SELECT game_id, {SCORE_ROW_COLUMNS} FROM match_participants"),
            [],
        )
        .unwrap(),
    );
    let mut matched = 0;
    for game in &games {
        let ours = if game.is_remake != 0 {
            None
        } else {
            compute_owner_score(
                participants
                    .get(&game.game_id)
                    .map_or(&[][..], Vec::as_slice),
                Some(game.puuid.as_str()).filter(|p| !p.is_empty()),
                Some(OwnerFallback {
                    champion_id: game.champion_id,
                    kills: game.kills,
                    deaths: game.deaths,
                    assists: game.assists,
                }),
                &champions.classes,
            )
        };
        let same = bits(ours.map(|s| s.score)) == bits(game.score)
            && bits(ours.map(|s| s.raw)) == bits(game.score_raw)
            && ours.and_then(|s| s.badge).map(|b| b.as_str()) == game.score_badge.as_deref();
        if same {
            matched += 1;
        } else {
            failures.push(format!(
                "game {}: Electron stored score={:?} raw={:?} badge={:?}, Rust computed {:?}",
                game.game_id, game.score, game.score_raw, game.score_badge, ours
            ));
        }
    }
    println!("{matched}/{} games match", games.len());
}

fn golden_input(p: &Value) -> ScoreInput {
    let n = |key: &str| p[key].as_f64().unwrap();
    ScoreInput {
        participant_id: n("participant_id"),
        team_id: n("team_id"),
        champion_id: n("champion_id"),
        kills: n("kills"),
        deaths: n("deaths"),
        assists: n("assists"),
        double_kills: n("double_kills"),
        triple_kills: n("triple_kills"),
        quadra_kills: n("quadra_kills"),
        penta_kills: n("penta_kills"),
        total_damage_dealt_to_champions: n("total_damage_dealt"),
        total_damage_taken: n("total_damage_taken"),
        gold_earned: n("gold_earned"),
        total_heal: n("total_heal"),
        win: n("win") == 1.0,
    }
}

/// Every player in the TypeScript golden, scored by Rust from the golden's
/// own inputs.
fn score_golden(file: &Path, champions: &ChampionClasses, failures: &mut Vec<String>) {
    let golden: Value = serde_json::from_str(&std::fs::read_to_string(file).unwrap()).unwrap();
    let (mut players, mut matched) = (0, 0);
    for game in golden["games"].as_array().unwrap() {
        let list = game["players"].as_array().unwrap();
        let inputs: Vec<ScoreInput> = list.iter().map(golden_input).collect();
        let scores = compute_match_scores(&inputs, Some(&champions.classes));
        for (p, input) in list.iter().zip(&inputs) {
            players += 1;
            let ours = scores.get(input.participant_id).unwrap();
            let raw_bits = u64::from_str_radix(p["rawBits"].as_str().unwrap(), 16).unwrap();
            let same = ours.raw.to_bits() == raw_bits
                && ours.score.to_bits() == p["score"].as_f64().unwrap().to_bits()
                && ours.badge.map(|b| b.as_str()) == p["badge"].as_str();
            if same {
                matched += 1;
            } else {
                failures.push(format!(
                    "game {} participant {}: TypeScript raw bits {raw_bits:016x} score {} badge {}, Rust {ours:?}",
                    game["game_id"], p["participant_id"], p["score"], p["badge"]
                ));
            }
        }
    }
    println!(
        "{matched}/{players} players match the TypeScript golden ({})",
        golden["runtime"].as_str().unwrap_or("unknown runtime")
    );
}

fn score_rows(conn: &Connection) -> Vec<Vec<(String, Stored)>> {
    rows(conn, SCORE_COLUMNS, i64::MIN)
}

/// Clears every score on `conn`, runs the backfill, and compares the result
/// with `want`.
fn backfill(
    conn: &Connection,
    champions: &ChampionClasses,
    want: &[Vec<(String, Stored)>],
    label: &str,
    failures: &mut Vec<String>,
) {
    conn.execute_batch(
        "UPDATE player_stats SET score = NULL, score_raw = NULL, score_badge = NULL;
         DELETE FROM settings WHERE key = 'score_formula_version';",
    )
    .unwrap();
    assert!(
        check_score_backfill(conn, champions).unwrap(),
        "{label}: backfill ran"
    );
    assert!(
        !check_score_backfill(conn, champions).unwrap(),
        "{label}: second check is a no-op"
    );
    let got = score_rows(conn);
    let matched = got.iter().zip(want).filter(|(a, b)| a == b).count();
    for (a, b) in got.iter().zip(want) {
        if a != b {
            failures.push(format!("{label}: Electron {b:?}, Rust {a:?}"));
        }
    }
    if got.len() != want.len() {
        failures.push(format!(
            "{label}: {} rows, Electron has {}",
            got.len(),
            want.len()
        ));
    }
    println!(
        "{label}: {matched}/{} backfilled scores equal Electron's",
        want.len()
    );
}

const GAME_TABLES: [(&str, &str); 5] = [
    ("games", "SELECT * FROM games WHERE game_id = ?"),
    (
        "player_stats",
        "SELECT * FROM player_stats WHERE game_id = ?",
    ),
    (
        "match_participants",
        "SELECT * FROM match_participants WHERE game_id = ? ORDER BY participant_id",
    ),
    (
        "match_participant_augments",
        "SELECT * FROM match_participant_augments WHERE game_id = ? ORDER BY participant_id, slot",
    ),
    (
        "game_augments",
        "SELECT * FROM game_augments WHERE game_id = ? ORDER BY slot",
    ),
];

/// Deletes each game and ingests its stored payload again, then compares
/// every row with the row Electron wrote. Favorites are a later toggle, so a
/// fresh insert leaves them 0. `raw_gz` is counted apart: the fixture's
/// blobs are Bun's gzip, which zlib-rs reproduces, while Electron's own
/// deflate differs (T11 waiver W1).
fn reingest(conn: &Connection, champions: &ChampionClasses, failures: &mut Vec<String>) {
    let games: Vec<(i64, String, Vec<u8>)> = conn
        .prepare("SELECT game_id, puuid, raw_gz FROM games ORDER BY game_id")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    let (mut matched, mut same_blob) = (0, 0);
    for (game_id, puuid, blob) in &games {
        let before: Vec<_> = GAME_TABLES
            .iter()
            .map(|(_, sql)| rows(conn, sql, *game_id))
            .collect();
        for table in GAME_TABLES.iter().rev().map(|(t, _)| t) {
            conn.execute(&format!("DELETE FROM {table} WHERE game_id = ?"), [game_id])
                .unwrap();
        }
        let payload = unpack_raw(Some(blob)).unwrap();
        assert!(
            insert_game_full(conn, &payload, puuid, &champions.classes).unwrap(),
            "game {game_id} inserts"
        );
        let after: Vec<_> = GAME_TABLES
            .iter()
            .map(|(_, sql)| rows(conn, sql, *game_id))
            .collect();
        let mut differs = Vec::new();
        for ((table, _), (want, got)) in GAME_TABLES.iter().zip(before.iter().zip(&after)) {
            if want.len() != got.len() {
                differs.push(format!(
                    "{table}: {} rows, Electron has {}",
                    got.len(),
                    want.len()
                ));
                continue;
            }
            for (w, g) in want.iter().zip(got) {
                for ((name, wv), (_, gv)) in w.iter().zip(g) {
                    let favorite = *table == "games" && name == "favorite";
                    if name == "raw_gz" {
                        if wv == gv {
                            same_blob += 1;
                        }
                    } else if wv != gv && !(favorite && *gv == Stored::Integer(0)) {
                        differs.push(format!("{table}.{name}: Electron {wv:?}, Rust {gv:?}"));
                    }
                }
            }
        }
        if differs.is_empty() {
            matched += 1;
        } else {
            failures.push(format!(
                "game {game_id} re-ingested: {}",
                differs.join("; ")
            ));
        }
        // The favorite flag is the user's, not the payload's; put it back
        conn.execute(
            "UPDATE games SET favorite = ? WHERE game_id = ?",
            params![
                match &before[0][0]
                    .iter()
                    .find(|(n, _)| n == "favorite")
                    .unwrap()
                    .1
                {
                    Stored::Integer(f) => *f,
                    _ => 0,
                },
                game_id
            ],
        )
        .unwrap();
    }
    println!(
        "{matched}/{} re-ingested games write Electron's rows, {same_blob} with raw_gz byte-identical to the fixture's Bun gzip",
        games.len()
    );
}

/// The time to score every game, as `parity/score-golden.ts --bench` times
/// the TypeScript.
fn bench(conn: &Connection, champions: &ChampionClasses, runs: usize) {
    let games: Vec<OwnerGame> = stmt::all(conn, OWNER_GAMES, []).unwrap();
    let participants = group_by_game(
        stmt::all(
            conn,
            &format!("SELECT game_id, {SCORE_ROW_COLUMNS} FROM match_participants"),
            [],
        )
        .unwrap(),
    );
    let inputs: Vec<Vec<ScoreInput>> = games
        .iter()
        .filter(|g| g.is_remake == 0)
        .filter_map(|g| participants.get(&g.game_id))
        .map(|rows| rows.iter().map(ScoreRow::input).collect())
        .collect();
    for run in 0..runs {
        let start = Instant::now();
        let scored: usize = inputs
            .iter()
            .map(|lobby| compute_match_scores(lobby, Some(&champions.classes)).len())
            .sum();
        println!(
            "rust run={run} games={} players={scored} ms={:.3}",
            games.len(),
            start.elapsed().as_secs_f64() * 1e3
        );
    }
}

fn main() -> ExitCode {
    let mut failures = Vec::new();
    let mut ran = false;

    if let Some(data) = std::env::var_os("BMT_GOLDEN_DATA").map(PathBuf::from) {
        ran = true;
        let champions = champion_classes(&data.join("champion-cache.json"));
        let (dir, conn) = open_copy(&data.join("matches.db"), "fixture");
        stored_scores(&conn, &champions, &mut failures);
        if let Some(golden) = std::env::var_os("BMT_SCORE_GOLDEN") {
            score_golden(Path::new(&golden), &champions, &mut failures);
        }
        let electron = score_rows(&conn);
        backfill(&conn, &champions, &electron, "fixture", &mut failures);
        reingest(&conn, &champions, &mut failures);
        if let Some(runs) = std::env::var("BMT_SCORE_BENCH")
            .ok()
            .and_then(|r| r.parse().ok())
        {
            bench(&conn, &champions, runs);
        }
        drop(conn);
        std::fs::remove_dir_all(dir).ok();
    }

    if let Some(list) = std::env::var_os("BMT_ELECTRON_BACKFILL") {
        for (n, folder) in std::env::split_paths(&list).enumerate() {
            ran = true;
            let champions = champion_classes(&folder.join("champion-cache.json"));
            let (after_dir, after) = open_copy(&folder.join("after.db"), &format!("after-{n}"));
            let want = score_rows(&after);
            drop(after);
            let (dir, conn) = open_copy(&folder.join("before.db"), &format!("before-{n}"));
            let label = folder.file_name().unwrap().to_string_lossy().into_owned();
            backfill(&conn, &champions, &want, &label, &mut failures);
            drop(conn);
            std::fs::remove_dir_all(dir).ok();
            std::fs::remove_dir_all(after_dir).ok();
        }
    }

    if !ran {
        println!("no fixture; set BMT_GOLDEN_DATA or BMT_ELECTRON_BACKFILL to compare scores");
    }
    for failure in &failures {
        println!("MISMATCH {failure}");
    }
    if failures.is_empty() {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}
