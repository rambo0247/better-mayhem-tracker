//! `src/main/db/ingest.ts`: storing a game the client handed over, and the
//! ids already decided on, stored or deliberately skipped.

use std::collections::HashSet;

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;

use super::js;
use super::payloads::{
    GameDenorm, RawParticipantRow, detect_remake, pack_raw, parse_patch, participant_rows_from_raw,
    write_participants,
};
use super::scoring::{OwnerFallback, ScoreRow, compute_owner_score};
use crate::op_score::{ChampionClassMap, PlayerScore};

pub fn game_exists(conn: &Connection, game_id: i64) -> rusqlite::Result<bool> {
    conn.prepare_cached("SELECT 1 FROM games WHERE game_id = ?")?
        .query_row([game_id], |_| Ok(()))
        .optional()
        .map(|row| row.is_some())
}

/// Every game id stored or skipped. One query beats a lookup per id when a
/// backfill checks hundreds.
pub fn get_known_game_ids(conn: &Connection) -> rusqlite::Result<HashSet<i64>> {
    conn.prepare_cached("SELECT game_id FROM games UNION SELECT game_id FROM ignored_games")?
        .query_map([], |row| row.get(0))?
        .collect()
}

/// The single-id form, for the recent-games sync, which looks at twenty ids
/// a minute.
pub fn is_game_known(conn: &Connection, game_id: i64) -> rusqlite::Result<bool> {
    conn.prepare_cached(
        "SELECT 1 FROM games WHERE game_id = ? UNION ALL SELECT 1 FROM ignored_games WHERE game_id = ? LIMIT 1",
    )?
    .query_row([game_id, game_id], |_| Ok(()))
    .optional()
    .map(|row| row.is_some())
}

pub fn mark_ignored_game(conn: &Connection, game_id: i64) -> rusqlite::Result<()> {
    conn.prepare_cached("INSERT OR IGNORE INTO ignored_games (game_id) VALUES (?)")?
        .execute([game_id])?;
    Ok(())
}

/// `x < n` for a payload field, which coerces the field with `ToNumber`
/// first: `undefined` is `NaN` and never less, `null` is 0, an array is its
/// `join(",")`, and any other object is `NaN`.
fn coerced(v: Option<&Value>) -> f64 {
    match v {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => string_to_number(s),
        Some(Value::Array(items)) => string_to_number(&join(items)),
        Some(Value::Object(_)) => f64::NAN,
    }
}

/// `Array.prototype.join(",")`, with `null` as the empty string.
fn join(items: &[Value]) -> String {
    let text = |v: &Value| match v {
        Value::Null => String::new(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => js::number_to_string(n.as_f64().unwrap_or(f64::NAN)),
        Value::String(s) => s.clone(),
        Value::Array(inner) => join(inner),
        Value::Object(_) => "[object Object]".into(),
    };
    items.iter().map(text).collect::<Vec<_>>().join(",")
}

/// `StringToNumber`, ECMA-262 7.1.4.1.1: JavaScript's whitespace trimmed,
/// `0x`, `0o` and `0b` integers unsigned, and a signed decimal or
/// `Infinity`. Rust's `f64` parser rounds a decimal the same way, but also
/// takes `inf` and `nan`, which JavaScript reads as `NaN`.
fn string_to_number(s: &str) -> f64 {
    let is_js_space = |c: char| {
        matches!(
            c,
            '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
                ..='\u{200a}'
                    | '\u{2028}'
                    | '\u{2029}'
                    | '\u{202f}'
                    | '\u{205f}'
                    | '\u{3000}'
                    | '\u{feff}'
        )
    };
    let s = s.trim_matches(is_js_space);
    if s.is_empty() {
        return 0.0;
    }
    let radix = match s.get(..2) {
        Some("0x" | "0X") => 16,
        Some("0o" | "0O") => 8,
        Some("0b" | "0B") => 2,
        _ => 10,
    };
    if radix != 10 {
        let digits = &s[2..];
        if digits.is_empty() || !digits.chars().all(|c| c.is_digit(radix)) {
            return f64::NAN;
        }
        // Exact up to 128 bits, then rounded once, as JavaScript rounds
        return u128::from_str_radix(digits, radix).map_or_else(
            |_| {
                digits.chars().fold(0.0, |n, c| {
                    n * f64::from(radix) + f64::from(c.to_digit(radix).unwrap_or(0))
                })
            },
            |n| n as f64,
        );
    }
    let (sign, unsigned) = match s.as_bytes()[0] {
        b'-' => (-1.0, &s[1..]),
        b'+' => (1.0, &s[1..]),
        _ => (1.0, s),
    };
    if unsigned == "Infinity" {
        return sign * f64::INFINITY;
    }
    let decimal = unsigned.starts_with(|c: char| c.is_ascii_digit() || c == '.')
        && unsigned
            .chars()
            .all(|c| c.is_ascii_digit() || matches!(c, '.' | 'e' | 'E' | '+' | '-'));
    if !decimal {
        return f64::NAN;
    }
    unsigned.parse::<f64>().map_or(f64::NAN, |n| sign * n)
}

const INSERT_GAME: &str = "
    INSERT OR IGNORE INTO games (game_id, queue_id, game_mode, game_creation, game_duration, is_remake, puuid, game_version, raw_gz)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ";

const INSERT_STATS: &str = "
    INSERT OR IGNORE INTO player_stats (
      game_id, champion_id, win, kills, deaths, assists,
      double_kills, triple_kills, quadra_kills, penta_kills,
      total_damage_dealt, total_damage_taken, gold_earned, total_heal,
      largest_killing_spree, spell1, spell2,
      item0, item1, item2, item3, item4, item5, item6,
      score, score_raw, score_badge
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ";

const INSERT_AUGMENT: &str = "
    INSERT OR IGNORE INTO game_augments (game_id, slot, augment_id) VALUES (?, ?, ?)
  ";

/// `insertGameFull`: the game, its participants, the owner's stats with
/// their score, and the owner's augments, all or nothing through
/// [`js::transaction`]. False when the owner is not in the game or the game
/// is already stored.
pub fn insert_game_full(
    conn: &Connection,
    game_data: &Value,
    puuid: &str,
    classes: &ChampionClassMap,
) -> rusqlite::Result<bool> {
    let game = Some(game_data);
    let get = |key: &str| js::prop(game, key).map_err(js::thrown);
    let rows = participant_rows_from_raw(game).map_err(js::thrown)?;
    let Some(owner) = find_owner_row(&rows, puuid) else {
        return Ok(false);
    };

    let is_remake = detect_remake(
        coerced(get("gameDuration")?),
        rows.iter().map(|r| r.early_surrender),
    );

    let owner_score: Option<PlayerScore> = if is_remake {
        None
    } else {
        let score_rows: Vec<ScoreRow> = rows.iter().map(ScoreRow::from).collect();
        compute_owner_score(
            &score_rows,
            Some(puuid),
            Some(OwnerFallback {
                champion_id: owner.champion_id,
                kills: owner.kills,
                deaths: owner.deaths,
                assists: owner.assists,
            }),
            classes,
        )
    };
    let is_remake = i64::from(is_remake);
    let game_version = parse_patch(get("gameVersion")?);

    js::transaction(conn, || {
        // Bound as JavaScript binds them, so SQLite's INTEGER affinity decides
        // what a string or fractional id becomes, or which error it raises.
        let game_id = js::bind(get("gameId")?)?;
        let queue_id = js::bind(get("queueId")?)?;
        let changes = conn.prepare_cached(INSERT_GAME)?.execute(params![
            game_id,
            queue_id,
            js::bind(get("gameMode")?)?,
            js::bind(get("gameCreation")?)?,
            js::bind(get("gameDuration")?)?,
            is_remake,
            puuid,
            game_version,
            pack_raw(game_data),
        ])?;
        if changes == 0 {
            return Ok(false);
        }

        write_participants(
            conn,
            &game_id,
            &GameDenorm {
                is_remake,
                queue_id,
                game_version: game_version.clone(),
            },
            &rows,
        )?;

        let [item0, item1, item2, item3, item4, item5, item6] = owner.items;
        conn.prepare_cached(INSERT_STATS)?.execute(params![
            game_id,
            owner.champion_id,
            owner.win,
            owner.kills,
            owner.deaths,
            owner.assists,
            owner.double_kills,
            owner.triple_kills,
            owner.quadra_kills,
            owner.penta_kills,
            owner.total_damage_dealt,
            owner.total_damage_taken,
            owner.gold_earned,
            owner.total_heal,
            owner.largest_killing_spree,
            owner.spell1,
            owner.spell2,
            item0,
            item1,
            item2,
            item3,
            item4,
            item5,
            item6,
            owner_score.map(|s| s.score),
            owner_score.map(|s| s.raw),
            owner_score.and_then(|s| s.badge).map(|b| b.as_str()),
        ])?;

        let mut augment = conn.prepare_cached(INSERT_AUGMENT)?;
        for aug in &owner.augments {
            augment.execute(params![game_id, aug.slot as i64, aug.augment_id])?;
        }
        drop(augment);
        Ok(true)
    })
}

/// The owner among the participant rows. `participantRowsFromRaw` already
/// folded `participantIdentities` into each row's puuid, so one lookup
/// covers both payload shapes.
fn find_owner_row<'a>(rows: &'a [RawParticipantRow], puuid: &str) -> Option<&'a RawParticipantRow> {
    if puuid.is_empty() {
        return None;
    }
    rows.iter().find(|r| r.puuid.as_deref() == Some(puuid))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::scoring::{ChampionClasses, check_score_backfill};
    use crate::db::{connection, payloads::unpack_raw, schema};
    use serde_json::json;

    fn fresh_db(name: &str) -> (std::path::PathBuf, Connection) {
        let dir = std::env::temp_dir().join(format!("bmt-ingest-{name}-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        let conn = connection::open(&dir.join("matches.db")).unwrap();
        schema::init_database(&conn, 0).unwrap();
        (dir, conn)
    }

    fn payload(game_id: i64, duration: i64) -> Value {
        let player = |id: i64, team: i64, win: bool, kills: i64| {
            json!({ "participantId": id, "championId": 10 + id, "teamId": team,
                "spell1Id": 4, "spell2Id": 32,
                "stats": { "win": win, "kills": kills, "deaths": 3, "assists": 7,
                    "doubleKills": 1, "totalDamageDealtToChampions": 15000 + id * 1000,
                    "totalDamageTaken": 20000, "goldEarned": 9000, "totalHeal": 4000,
                    "largestKillingSpree": 2, "item0": 1001, "item6": 3340,
                    "playerAugment1": 77, "playerAugment2": 0 } })
        };
        let identity = |puuid: &str| json!({ "player": { "puuid": puuid, "gameName": puuid, "tagLine": "NA1" } });
        json!({
            "gameId": game_id, "queueId": 2400, "gameMode": "KIWI", "gameCreation": 1_700_000_000_000_i64,
            "gameDuration": duration, "gameVersion": "16.23.712.3456",
            "participants": [player(1, 100, true, 9), player(2, 100, true, 4), player(3, 200, false, 6)],
            "participantIdentities": [identity("me"), identity("ally"), identity("foe")],
        })
    }

    fn count(conn: &Connection, sql: &str) -> i64 {
        conn.query_row(sql, [], |row| row.get(0)).unwrap()
    }

    #[test]
    fn a_game_lands_whole_with_the_owner_scored() {
        let (dir, conn) = fresh_db("whole");
        let game = payload(42, 1200);
        assert!(insert_game_full(&conn, &game, "me", &ChampionClassMap::new()).unwrap());

        let rows = participant_rows_from_raw(Some(&game)).unwrap();
        let score_rows: Vec<ScoreRow> = rows.iter().map(ScoreRow::from).collect();
        let want =
            compute_owner_score(&score_rows, Some("me"), None, &ChampionClassMap::new()).unwrap();
        let (score, raw, badge): (f64, f64, String) = conn
            .query_row(
                "SELECT score, score_raw, score_badge FROM player_stats WHERE game_id = 42",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(
            (score.to_bits(), raw.to_bits()),
            (want.score.to_bits(), want.raw.to_bits())
        );
        assert_eq!(Some(badge.as_str()), want.badge.map(|b| b.as_str()));

        assert_eq!(
            count(
                &conn,
                "SELECT count(*) FROM match_participants WHERE game_id = 42"
            ),
            3
        );
        assert_eq!(
            count(
                &conn,
                "SELECT count(*) FROM match_participant_augments WHERE game_id = 42"
            ),
            3
        );
        assert_eq!(
            count(
                &conn,
                "SELECT augment_id FROM game_augments WHERE game_id = 42 AND slot = 1"
            ),
            77
        );
        assert_eq!(
            count(&conn, "SELECT is_remake FROM games WHERE game_id = 42"),
            0
        );
        let (version, blob): (String, Vec<u8>) = conn
            .query_row(
                "SELECT game_version, raw_gz FROM games WHERE game_id = 42",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(version, "16.23");
        assert_eq!(unpack_raw(Some(&blob)), Some(game.clone()));

        assert!(game_exists(&conn, 42).unwrap());
        assert!(is_game_known(&conn, 42).unwrap());
        drop(conn);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn a_second_insert_and_a_missing_owner_write_nothing() {
        let (dir, conn) = fresh_db("noop");
        let game = payload(7, 1200);
        assert!(insert_game_full(&conn, &game, "me", &ChampionClassMap::new()).unwrap());
        let before = count(&conn, "SELECT total_changes()");
        assert!(!insert_game_full(&conn, &game, "me", &ChampionClassMap::new()).unwrap());
        assert_eq!(count(&conn, "SELECT total_changes()"), before);
        assert!(
            !insert_game_full(
                &conn,
                &payload(8, 1200),
                "stranger",
                &ChampionClassMap::new()
            )
            .unwrap()
        );
        assert!(!insert_game_full(&conn, &payload(9, 1200), "", &ChampionClassMap::new()).unwrap());
        assert!(!game_exists(&conn, 8).unwrap());
        drop(conn);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn a_remake_stores_no_score() {
        let (dir, conn) = fresh_db("remake");
        assert!(insert_game_full(&conn, &payload(5, 200), "me", &ChampionClassMap::new()).unwrap());
        assert_eq!(
            count(&conn, "SELECT is_remake FROM games WHERE game_id = 5"),
            1
        );
        assert_eq!(
            count(
                &conn,
                "SELECT is_remake FROM match_participants WHERE game_id = 5 LIMIT 1"
            ),
            1
        );
        assert_eq!(
            count(
                &conn,
                "SELECT count(*) FROM player_stats WHERE game_id = 5 AND score IS NULL AND score_raw IS NULL AND score_badge IS NULL"
            ),
            1
        );
        drop(conn);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn ignored_ids_count_as_known() {
        let (dir, conn) = fresh_db("ignored");
        mark_ignored_game(&conn, 11).unwrap();
        mark_ignored_game(&conn, 11).unwrap();
        assert!(
            insert_game_full(&conn, &payload(12, 1200), "me", &ChampionClassMap::new()).unwrap()
        );
        assert!(is_game_known(&conn, 11).unwrap());
        assert!(!game_exists(&conn, 11).unwrap());
        assert!(!is_game_known(&conn, 13).unwrap());
        assert_eq!(get_known_game_ids(&conn).unwrap(), HashSet::from([11, 12]));
        drop(conn);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn durations_coerce_as_relational_operators_do() {
        assert!(coerced(None).is_nan());
        assert_eq!(coerced(Some(&Value::Null)), 0.0);
        assert_eq!(coerced(Some(&json!(" 250 "))), 250.0);
        assert_eq!(coerced(Some(&json!(""))), 0.0);
        assert!(coerced(Some(&json!("abc"))).is_nan());
        assert_eq!(coerced(Some(&json!(true))), 1.0);
        assert_eq!(coerced(Some(&json!("0x10"))), 16.0);
        assert_eq!(coerced(Some(&json!("0b101"))), 5.0);
        assert!(coerced(Some(&json!("-0x10"))).is_nan());
        assert!(coerced(Some(&json!("0x+1"))).is_nan());
        assert_eq!(coerced(Some(&json!("-Infinity"))), f64::NEG_INFINITY);
        assert_eq!(coerced(Some(&json!("+Infinity"))), f64::INFINITY);
        assert!(coerced(Some(&json!("inf"))).is_nan());
        assert!(coerced(Some(&json!("NaN"))).is_nan());
        assert_eq!(coerced(Some(&json!("\u{feff}.5e3\u{3000}"))), 500.0);
        assert!(coerced(Some(&json!("\u{85}5"))).is_nan());
        assert!(coerced(Some(&json!("-+1"))).is_nan());
        assert_eq!(coerced(Some(&json!("-0"))).to_bits(), (-0.0f64).to_bits());
        assert_eq!(coerced(Some(&json!([]))), 0.0);
        assert_eq!(coerced(Some(&json!([" 250 "]))), 250.0);
        assert!(coerced(Some(&json!([1, 2]))).is_nan());
        assert!(coerced(Some(&json!({}))).is_nan());
        assert!(detect_remake(
            coerced(Some(&json!("-Infinity"))),
            std::iter::empty()
        ));
    }

    fn tables(conn: &Connection) -> [i64; 5] {
        [
            "games",
            "player_stats",
            "match_participants",
            "match_participant_augments",
            "game_augments",
        ]
        .map(|t| count(conn, &format!("SELECT count(*) FROM {t}")))
    }

    fn with_game_id(id: Option<Value>) -> Value {
        let mut game = payload(0, 1200);
        match id {
            Some(id) => game["gameId"] = id,
            None => {
                game.as_object_mut().unwrap().remove("gameId");
            }
        }
        game
    }

    /// Each outcome is trunk Electron's for the same gameId, recorded by the
    /// T12 verifier in electron-report.json: what `err.message` says, which
    /// the import dialog shows, and the integer the row is stored under.
    #[test]
    fn game_ids_bind_as_javascript_binds_them() {
        let mismatch = Err("datatype mismatch");
        let not_null = Err("NOT NULL constraint failed: match_participants.game_id");
        let cases: [(&str, Option<Value>, Result<i64, &str>); 10] = [
            ("1.5", Some(json!(1.5)), mismatch),
            ("str123", Some(json!("123")), Ok(123)),
            ("str123.0", Some(json!("123.0")), Ok(123)),
            ("null", Some(Value::Null), not_null),
            ("absent", None, not_null),
            (
                "true",
                Some(json!(true)),
                Err("SQLite3 can only bind numbers, strings, bigints, buffers, and null"),
            ),
            ("abc", Some(json!("abc")), mismatch),
            ("1e20", Some(json!(1e20)), mismatch),
            ("neg0", Some(json!(-0.0)), Ok(0)),
            ("spaced", Some(json!(" 77 ")), Ok(77)),
        ];
        let (dir, conn) = fresh_db("gameid");
        insert_game_full(&conn, &payload(1, 1200), "me", &ChampionClassMap::new()).unwrap();
        let whole = tables(&conn);
        drop(conn);
        std::fs::remove_dir_all(dir).ok();

        for (label, id, want) in cases {
            let (dir, conn) = fresh_db(&format!("gameid-{label}"));
            let got = insert_game_full(&conn, &with_game_id(id), "me", &ChampionClassMap::new())
                .map_err(|e| e.to_string());
            match want {
                Ok(stored) => {
                    assert_eq!(got, Ok(true), "{label}");
                    assert_eq!(tables(&conn), whole, "{label}");
                    for t in [
                        "games",
                        "player_stats",
                        "match_participants",
                        "game_augments",
                    ] {
                        let ids: Vec<(i64, String)> = conn
                            .prepare(&format!(
                                "SELECT DISTINCT game_id, typeof(game_id) FROM {t}"
                            ))
                            .unwrap()
                            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
                            .unwrap()
                            .collect::<rusqlite::Result<_>>()
                            .unwrap();
                        assert_eq!(ids, [(stored, "integer".to_owned())], "{label} {t}");
                    }
                }
                Err(message) => {
                    assert_eq!(got, Err(message.to_owned()), "{label}");
                    assert_eq!(tables(&conn), [0; 5], "{label}");
                }
            }
            drop(conn);
            std::fs::remove_dir_all(dir).ok();
        }
    }

    /// JavaScript binds `gameData.queueId` as it is to the game and to every
    /// participant row, so INTEGER affinity keeps a fraction or a word.
    #[test]
    fn queue_ids_reach_participant_rows_as_bound() {
        for (label, queue, want) in [
            ("real", json!(2400.5), "2400.5"),
            ("text", json!("abc"), "'abc'"),
            ("numeric-text", json!("2400"), "2400"),
        ] {
            let (dir, conn) = fresh_db(&format!("queue-{label}"));
            let mut game = payload(3, 1200);
            game["queueId"] = queue;
            assert!(insert_game_full(&conn, &game, "me", &ChampionClassMap::new()).unwrap());
            for t in ["games", "match_participants", "match_participant_augments"] {
                let stored: Vec<String> = conn
                    .prepare(&format!("SELECT DISTINCT quote(queue_id) FROM {t}"))
                    .unwrap()
                    .query_map([], |r| r.get(0))
                    .unwrap()
                    .collect::<rusqlite::Result<_>>()
                    .unwrap();
                assert_eq!(stored, [want], "{label} {t}");
            }
            drop(conn);
            std::fs::remove_dir_all(dir).ok();
        }
    }

    #[test]
    fn a_throw_in_autocommit_rolls_the_game_back() {
        let (dir, conn) = fresh_db("autocommit-throw");
        let err = insert_game_full(
            &conn,
            &with_game_id(Some(Value::Null)),
            "me",
            &ChampionClassMap::new(),
        )
        .unwrap_err();
        assert!(err.to_string().starts_with("NOT NULL"), "{err}");
        assert!(conn.is_autocommit());
        assert_eq!(tables(&conn), [0; 5]);
        drop(conn);
        std::fs::remove_dir_all(dir).ok();
    }

    /// `importGames` runs each batch's inserts inside one `db.transaction`,
    /// so each insert is a savepoint. A null id writes its games row (an
    /// INTEGER PRIMARY KEY takes the next rowid) before its participants
    /// fail, and the savepoint takes that row back out.
    #[test]
    fn a_caught_throw_inside_a_transaction_leaves_no_rows_for_that_game() {
        let (dir, conn) = fresh_db("nested-throw");
        let classes = ChampionClassMap::new();
        conn.execute_batch("BEGIN").unwrap();
        assert!(insert_game_full(&conn, &payload(1, 1200), "me", &classes).unwrap());
        let one = tables(&conn);
        let err =
            insert_game_full(&conn, &with_game_id(Some(Value::Null)), "me", &classes).unwrap_err();
        assert_eq!(
            err.to_string(),
            "NOT NULL constraint failed: match_participants.game_id"
        );
        assert!(!conn.is_autocommit(), "the outer transaction stays open");
        assert_eq!(tables(&conn), one);
        assert!(insert_game_full(&conn, &payload(3, 1200), "me", &classes).unwrap());
        conn.execute_batch("COMMIT").unwrap();

        let ids: Vec<i64> = conn
            .prepare("SELECT game_id FROM games ORDER BY game_id")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(ids, [1, 3]);
        assert_eq!(tables(&conn), one.map(|n| n * 2));
        drop(conn);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn the_score_backfill_nests_inside_an_open_transaction() {
        let (dir, conn) = fresh_db("nested-backfill");
        insert_game_full(&conn, &payload(1, 1200), "me", &ChampionClassMap::new()).unwrap();
        let score = |conn: &Connection| -> f64 {
            conn.query_row("SELECT score_raw FROM player_stats", [], |r| r.get(0))
                .unwrap()
        };
        let before = score(&conn);
        let tank = ChampionClasses {
            version: "16.23.1".into(),
            classes: [(11, "Tank".to_owned())].into(),
        };
        conn.execute_batch("BEGIN").unwrap();
        assert!(check_score_backfill(&conn, &tank).unwrap());
        assert_ne!(score(&conn).to_bits(), before.to_bits());
        conn.execute_batch("ROLLBACK").unwrap();
        assert_eq!(score(&conn).to_bits(), before.to_bits());
        drop(conn);
        std::fs::remove_dir_all(dir).ok();
    }

    /// Electron's order: `champion-cache.json` hydrates before any insert,
    /// and `checkScoreBackfill` runs once champion data is ready. An insert
    /// with empty classes is corrected only by a backfill that runs after it.
    /// One that comes after the backfill keeps its empty-class score until
    /// the data version changes.
    #[test]
    fn inserts_must_take_live_classes_once_the_backfill_has_run() {
        let tank = ChampionClasses {
            version: "16.23.1".into(),
            classes: [(11, "Tank".to_owned())].into(),
        };
        let none = ChampionClasses::none();
        let run = |name: &str, steps: &[(&str, &ChampionClasses)]| -> (f64, Vec<bool>) {
            let (dir, conn) = fresh_db(name);
            let mut backfills = Vec::new();
            for (step, classes) in steps {
                match *step {
                    "insert" => {
                        insert_game_full(&conn, &payload(1, 1200), "me", &classes.classes).unwrap();
                    }
                    _ => backfills.push(check_score_backfill(&conn, classes).unwrap()),
                }
            }
            let raw = conn
                .query_row("SELECT score_raw FROM player_stats", [], |r| r.get(0))
                .unwrap();
            drop(conn);
            std::fs::remove_dir_all(dir).ok();
            (raw, backfills)
        };
        let (electron, _) = run("order-electron", &[("insert", &tank), ("backfill", &tank)]);
        let (early, early_backfills) =
            run("order-early", &[("insert", &none), ("backfill", &tank)]);
        let (late, late_backfills) = run(
            "order-late",
            &[("backfill", &tank), ("insert", &none), ("backfill", &tank)],
        );
        assert_eq!(early.to_bits(), electron.to_bits());
        assert_eq!(early_backfills, [true]);
        assert_ne!(late.to_bits(), electron.to_bits());
        assert_eq!(late_backfills, [true, false]);
    }

    /// Lane 10: an import batch of 50 games inside one transaction, killed
    /// with SIGKILL as the 26th game goes in. After reopen none of the 50
    /// are stored, as with Electron's `importGames`. Without the outer
    /// transaction each insert commits alone, so 25 survive.
    #[cfg(unix)]
    #[test]
    fn a_kill_midway_through_an_import_batch_leaves_none_of_it() {
        if let Some(dir) = std::env::var_os("BMT_INGEST_KILL_CHILD") {
            let dir = std::path::PathBuf::from(dir);
            let conn = connection::open(&dir.join("matches.db")).unwrap();
            let batch = std::env::var_os("BMT_INGEST_KILL_BATCH").is_some();
            if batch {
                conn.execute_batch("BEGIN").unwrap();
            }
            for i in 0..50 {
                if i == 25 {
                    std::process::Command::new("kill")
                        .args(["-9", &std::process::id().to_string()])
                        .status()
                        .unwrap();
                    std::thread::sleep(std::time::Duration::from_secs(10));
                }
                insert_game_full(
                    &conn,
                    &payload(100 + i, 1200),
                    "me",
                    &ChampionClassMap::new(),
                )
                .unwrap();
            }
            unreachable!("the kill landed");
        }

        let test = format!(
            "{}::a_kill_midway_through_an_import_batch_leaves_none_of_it",
            module_path!().split_once("::").unwrap().1
        );
        for (batch, survivors) in [(true, 0), (false, 25)] {
            let (dir, conn) = fresh_db(&format!("kill-{batch}"));
            drop(conn);
            let mut child = std::process::Command::new(std::env::current_exe().unwrap());
            child
                .args(["--exact", &test, "--nocapture", "--test-threads=1"])
                .env("BMT_INGEST_KILL_CHILD", &dir)
                .stdout(std::process::Stdio::null());
            if batch {
                child.env("BMT_INGEST_KILL_BATCH", "1");
            }
            let status = child.status().unwrap();
            use std::os::unix::process::ExitStatusExt;
            assert_eq!(status.signal(), Some(9), "batch={batch} {status}");

            let conn = connection::open(&dir.join("matches.db")).unwrap();
            assert_eq!(
                count(&conn, "SELECT count(*) FROM games"),
                survivors,
                "batch={batch}"
            );
            assert_eq!(
                count(&conn, "SELECT count(*) FROM match_participants"),
                survivors * 3,
                "batch={batch}"
            );
            drop(conn);
            std::fs::remove_dir_all(dir).ok();
        }
    }
}
