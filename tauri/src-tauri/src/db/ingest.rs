//! `src/main/db/ingest.ts`: storing a game the client handed over, and the
//! ids already decided on, stored or deliberately skipped.

use std::collections::HashSet;

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;

use super::js::{self, TypeError};
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

/// `x < n` for a payload field, which coerces the field to a number first:
/// `undefined` is `NaN` and never less, `null` is 0.
fn coerced(v: Option<&Value>) -> f64 {
    match v {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) if s.trim().is_empty() => 0.0,
        Some(Value::String(s)) => s
            .trim()
            .parse::<f64>()
            .ok()
            .filter(|n| n.is_finite())
            .unwrap_or(f64::NAN),
        Some(_) => f64::NAN,
    }
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
/// their score, and the owner's augments, in one transaction. False when
/// the owner is not in the game or the game is already stored.
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

    // writeParticipants keys its rows by an integer id. The INSERT below
    // already refuses anything else in an INTEGER PRIMARY KEY.
    let game_id_value = get("gameId")?;
    let game_id = js::number(game_id_value)
        .filter(|n| n.fract() == 0.0)
        .map(|n| n as i64)
        .ok_or_else(|| js::thrown(TypeError("gameId is not an integer".into())))?;

    let tx = conn.unchecked_transaction()?;
    let changes = conn.prepare_cached(INSERT_GAME)?.execute(params![
        js::bind(game_id_value)?,
        js::bind(get("queueId")?)?,
        js::bind(get("gameMode")?)?,
        js::bind(get("gameCreation")?)?,
        js::bind(get("gameDuration")?)?,
        is_remake,
        puuid,
        game_version,
        pack_raw(game_data),
    ])?;
    if changes == 0 {
        // A duplicate: the transaction commits with nothing written
        tx.commit()?;
        return Ok(false);
    }

    write_participants(
        conn,
        game_id,
        &GameDenorm {
            is_remake,
            queue_id: js::number(get("queueId")?).map(|n| n as i64),
            game_version: game_version.clone(),
        },
        &rows,
    )?;

    let [item0, item1, item2, item3, item4, item5, item6] = owner.items;
    conn.prepare_cached(INSERT_STATS)?.execute(params![
        js::bind(game_id_value)?,
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
        augment.execute(params![
            js::bind(game_id_value)?,
            aug.slot as i64,
            aug.augment_id
        ])?;
    }
    drop(augment);
    tx.commit()?;
    Ok(true)
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
    }
}
