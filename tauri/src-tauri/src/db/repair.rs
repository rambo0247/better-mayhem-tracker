//! `src/main/db/repair.ts`: settles which accounts are ours and which games
//! each played, then rebuilds everything derived from the participant rows.
//! Every map and set iterates in insertion order, as JavaScript's do, since
//! that order decides which account a game goes to and the order rows are
//! written in.

use indexmap::{IndexMap, IndexSet};
use rusqlite::types::ValueRef;
use rusqlite::{Connection, params};

use super::js::{Cell, number_to_string};
use super::payloads::{AUGMENT_SLOTS, detect_remake, rebuild_participants_from_payloads};
use super::scoring::{
    ChampionClasses, OwnerFallback, SCORE_ROW_COLUMNS, ScoreRow, score_formula_key,
};
use super::settings::set_setting;
use super::stmt::{self, FromRow};
use crate::commands::data::RepairResult;
use crate::db_row;

/// A text column as JavaScript holds it.
fn text(v: ValueRef<'_>) -> Option<String> {
    match v {
        ValueRef::Null => None,
        ValueRef::Integer(i) => Some(number_to_string(i as f64)),
        ValueRef::Real(f) => Some(number_to_string(f)),
        ValueRef::Text(t) | ValueRef::Blob(t) => Some(String::from_utf8_lossy(t).into_owned()),
    }
}

/// `x < n` coerces a column to a number; `null` is 0.
fn coerced(cell: &Cell) -> f64 {
    match cell {
        Cell::Null => 0.0,
        Cell::Number(n) => *n,
        Cell::Text(s) if s.trim().is_empty() => 0.0,
        Cell::Text(s) => s.trim().parse().unwrap_or(f64::NAN),
        Cell::Blob(_) => f64::NAN,
    }
}

db_row! {
    struct DerivedGame {
        game_id: i64,
        puuid: Option<String>,
        game_duration: Cell,
        champion_id: Option<f64>,
        kills: Option<f64>,
        deaths: Option<f64>,
        assists: Option<f64>,
    }
}

/// A participant row with what player_stats copies from it.
struct Participant {
    game_id: i64,
    score: ScoreRow,
    early_surrender: f64,
    largest_killing_spree: f64,
    spells: [Option<f64>; 2],
    items: [Option<f64>; 7],
}

impl FromRow for Participant {
    const COLUMNS: &'static [&'static str] = &[
        "participant_id",
        "puuid",
        "team_id",
        "champion_id",
        "win",
        "kills",
        "deaths",
        "assists",
        "double_kills",
        "triple_kills",
        "quadra_kills",
        "penta_kills",
        "total_damage_dealt",
        "total_damage_taken",
        "gold_earned",
        "total_heal",
        "game_id",
        "early_surrender",
        "largest_killing_spree",
        "spell1",
        "spell2",
        "item0",
        "item1",
        "item2",
        "item3",
        "item4",
        "item5",
        "item6",
    ];

    fn from_row(row: &rusqlite::Row<'_>, at: &[usize]) -> rusqlite::Result<Self> {
        let (score, rest) = at.split_at(ScoreRow::COLUMNS.len());
        let get = |i: usize| row.get::<_, Option<f64>>(rest[i]);
        Ok(Self {
            score: ScoreRow::from_row(row, score)?,
            game_id: row.get(rest[0])?,
            early_surrender: row.get(rest[1])?,
            largest_killing_spree: row.get(rest[2])?,
            spells: [get(3)?, get(4)?],
            items: [
                get(5)?,
                get(6)?,
                get(7)?,
                get(8)?,
                get(9)?,
                get(10)?,
                get(11)?,
            ],
        })
    }
}

db_row! {
    struct GameAugment {
        game_id: i64,
        participant_id: f64,
        slot: f64,
        augment_id: f64,
    }
}

/// `groupByGame`, keeping the order games first appear in.
fn group_by_game<T>(rows: Vec<T>, game_of: impl Fn(&T) -> i64) -> IndexMap<i64, Vec<T>> {
    let mut by_game: IndexMap<i64, Vec<T>> = IndexMap::new();
    for row in rows {
        by_game.entry(game_of(&row)).or_default().push(row);
    }
    by_game
}

const UPSERT_STATS: &str = "
    INSERT OR REPLACE INTO player_stats (
      game_id, champion_id, win, kills, deaths, assists,
      double_kills, triple_kills, quadra_kills, penta_kills,
      total_damage_dealt, total_damage_taken, gold_earned, total_heal,
      largest_killing_spree, spell1, spell2,
      item0, item1, item2, item3, item4, item5, item6,
      score, score_raw, score_badge
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ";

/// `rebuildDerivedStats`: player_stats, augments, the remake flag and the
/// score for each game's current owner, under the current formula.
fn rebuild_derived_stats(conn: &Connection, champions: &ChampionClasses) -> rusqlite::Result<i64> {
    let games: Vec<DerivedGame> = stmt::all(
        conn,
        "
      SELECT g.game_id, g.puuid, g.game_duration,
             ps.champion_id, ps.kills, ps.deaths, ps.assists
      FROM games g
      LEFT JOIN player_stats ps ON g.game_id = ps.game_id
    ",
        [],
    )?;
    let participants = group_by_game(
        stmt::all::<Participant>(
            conn,
            &format!(
                "
        SELECT game_id, {SCORE_ROW_COLUMNS}, early_surrender, largest_killing_spree,
               spell1, spell2, item0, item1, item2, item3, item4, item5, item6
        FROM match_participants
      "
            ),
            [],
        )?,
        |p| p.game_id,
    );
    let augments = group_by_game(
        stmt::all::<GameAugment>(
            conn,
            "SELECT game_id, participant_id, slot, augment_id FROM match_participant_augments",
            [],
        )?,
        |a| a.game_id,
    );

    let tx = conn.unchecked_transaction()?;
    let mut upsert_stats = conn.prepare(UPSERT_STATS)?;
    let mut update_remake = conn.prepare("UPDATE games SET is_remake = ? WHERE game_id = ?")?;
    let mut delete_augments = conn.prepare("DELETE FROM game_augments WHERE game_id = ?")?;
    let mut insert_augment = conn.prepare(
        "INSERT OR IGNORE INTO game_augments (game_id, slot, augment_id) VALUES (?, ?, ?)",
    )?;

    let mut rebuilt = 0;
    for game in &games {
        let Some(rows) = participants
            .get(&game.game_id)
            .filter(|rows| !rows.is_empty())
        else {
            continue;
        };
        let owner_puuid = game.puuid.as_deref().filter(|p| !p.is_empty());
        let mut owner = owner_puuid.and_then(|puuid| {
            rows.iter()
                .find(|p| p.score.puuid.as_deref() == Some(puuid))
        });
        // Owner puuid unknown (old imports): fall back to matching the stored
        // stats row, same as the puuid backfill migration
        if owner.is_none() && game.champion_id.is_some() {
            owner = rows.iter().find(|p| {
                Some(p.score.champion_id) == game.champion_id
                    && Some(p.score.kills) == game.kills
                    && Some(p.score.deaths) == game.deaths
                    && Some(p.score.assists) == game.assists
            });
        }
        let Some(owner) = owner else {
            continue;
        };

        // Writing is_remake fires trg_games_denorm_participants, which
        // carries the new value down to the participant rows
        let is_remake = detect_remake(
            coerced(&game.game_duration),
            rows.iter().map(|p| p.early_surrender),
        );
        update_remake.execute(params![i64::from(is_remake), game.game_id])?;

        let owner_score = if is_remake {
            None
        } else {
            let score_rows: Vec<ScoreRow> = rows.iter().map(|p| p.score.clone()).collect();
            super::scoring::compute_owner_score(
                &score_rows,
                owner_puuid,
                Some(OwnerFallback {
                    champion_id: owner.score.champion_id,
                    kills: owner.score.kills,
                    deaths: owner.score.deaths,
                    assists: owner.score.assists,
                }),
                &champions.classes,
            )
        };

        let s = &owner.score;
        let [spell1, spell2] = owner.spells;
        let [item0, item1, item2, item3, item4, item5, item6] = owner.items;
        upsert_stats.execute(params![
            game.game_id,
            s.champion_id,
            s.win,
            s.kills,
            s.deaths,
            s.assists,
            s.double_kills,
            s.triple_kills,
            s.quadra_kills,
            s.penta_kills,
            s.total_damage_dealt,
            s.total_damage_taken,
            s.gold_earned,
            s.total_heal,
            owner.largest_killing_spree,
            spell1,
            spell2,
            item0,
            item1,
            item2,
            item3,
            item4,
            item5,
            item6,
            owner_score.map(|o| o.score),
            owner_score.map(|o| o.raw),
            owner_score.and_then(|o| o.badge).map(|b| b.as_str()),
        ])?;

        delete_augments.execute([game.game_id])?;
        for aug in augments.get(&game.game_id).into_iter().flatten() {
            if aug.participant_id == s.participant_id {
                insert_augment.execute(params![game.game_id, aug.slot, aug.augment_id])?;
            }
        }
        rebuilt += 1;
    }
    drop((upsert_stats, update_remake, delete_augments, insert_augment));
    tx.commit()?;

    // Stamp the startup-backfill keys: the rebuild just did their work
    set_setting(conn, "score_formula_version", &score_formula_key(champions))?;
    set_setting(conn, "augment_slots", &AUGMENT_SLOTS.to_string())?;
    Ok(rebuilt)
}

/// `repairPuuids`.
pub fn repair_puuids(
    conn: &Connection,
    champions: &ChampionClasses,
    now_ms: impl Fn() -> i64,
) -> rusqlite::Result<RepairResult> {
    // Step 0: re-derive the participant rows from the stored payloads, since
    // everything below reads them
    let normalized = rebuild_participants_from_payloads(conn)?;
    if normalized.unusable > 0 {
        eprintln!(
            "Repair: {} stored payloads could not be read",
            normalized.unusable
        );
    }

    // Step 1: participant puuids per game. Bots and unresolved players were
    // already filtered to NULL on the way into match_participants
    struct Seen {
        game_id: i64,
        puuid: String,
        game_name: Option<String>,
        tag_line: Option<String>,
        game_creation: f64,
    }
    let rows: Vec<Seen> = conn
        .prepare(
            "
      SELECT mp.game_id, mp.puuid, mp.game_name, mp.tag_line, g.game_creation
      FROM match_participants mp
      JOIN games g ON g.game_id = mp.game_id
      WHERE mp.puuid IS NOT NULL
    ",
        )?
        .query_map([], |row| {
            Ok(Seen {
                game_id: row.get(0)?,
                puuid: text(row.get_ref(1)?).unwrap_or_default(),
                game_name: text(row.get_ref(2)?),
                tag_line: text(row.get_ref(3)?),
                game_creation: coerced(&row.get::<_, Cell>(4)?),
            })
        })?
        .collect::<rusqlite::Result<_>>()?;

    let mut puuid_to_games: IndexMap<&str, IndexSet<i64>> = IndexMap::new();
    let mut game_to_puuids: IndexMap<i64, IndexSet<&str>> = IndexMap::new();
    for row in &rows {
        puuid_to_games
            .entry(&row.puuid)
            .or_default()
            .insert(row.game_id);
        game_to_puuids
            .entry(row.game_id)
            .or_default()
            .insert(&row.puuid);
    }

    // Step 2: most games first, a stable sort as Array.prototype.sort is
    let mut sorted: Vec<(&str, &IndexSet<i64>)> =
        puuid_to_games.iter().map(|(p, g)| (*p, g)).collect();
    sorted.sort_by_key(|entry| std::cmp::Reverse(entry.1.len()));

    // Step 3: the accounts the client reported are ours outright. The rest
    // are taken greedily, most games first, if they never share a game with
    // an account already settled: friends always appear beside one of ours,
    // alt accounts never beside each other
    let reported: Vec<Option<String>> = conn
        .prepare(
            "SELECT puuid FROM summoner WHERE summoner_id IS NOT NULL OR account_id IS NOT NULL",
        )?
        .query_map([], |row| Ok(text(row.get_ref(0)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let mut user_puuids: IndexSet<&str> = reported
        .iter()
        .flatten()
        .filter_map(|p| puuid_to_games.get_key_value(p.as_str()).map(|(k, _)| *k))
        .collect();
    for (puuid, game_ids) in sorted {
        if user_puuids.contains(puuid) {
            continue;
        }
        let co_occurs = game_ids.iter().any(|game_id| {
            let in_game = &game_to_puuids[game_id];
            user_puuids.iter().any(|user| in_game.contains(user))
        });
        if !co_occurs {
            user_puuids.insert(puuid);
        }
    }

    // Step 4: a recorded owner that is ours and among the game's players
    // stands; any other game takes the first of our accounts found in it
    let owners: std::collections::HashMap<i64, Option<String>> = conn
        .prepare("SELECT game_id, puuid FROM games")?
        .query_map([], |row| Ok((row.get(0)?, text(row.get_ref(1)?))))?
        .collect::<rusqlite::Result<_>>()?;
    let mut repaired_games = 0;
    {
        let tx = conn.unchecked_transaction()?;
        let mut update = conn.prepare("UPDATE games SET puuid = ? WHERE game_id = ?")?;
        for (game_id, in_game) in &game_to_puuids {
            let owner = owners
                .get(game_id)
                .and_then(|o| o.as_deref())
                .filter(|o| !o.is_empty());
            if owner.is_some_and(|o| user_puuids.contains(o) && in_game.contains(o)) {
                continue;
            }
            if let Some(puuid) = in_game.iter().find(|p| user_puuids.contains(**p)) {
                update.execute(params![puuid, game_id])?;
                repaired_games += 1;
            }
        }
        drop(update);
        tx.commit()?;
    }

    // Step 5: each discovered account under its most recent name
    let mut latest: std::collections::HashMap<&str, (&str, Option<&str>, f64)> =
        std::collections::HashMap::new();
    for row in &rows {
        let Some(name) = row.game_name.as_deref().filter(|n| !n.is_empty()) else {
            continue;
        };
        if !user_puuids.contains(row.puuid.as_str()) {
            continue;
        }
        let newer = latest
            .get(row.puuid.as_str())
            .is_none_or(|(_, _, at)| row.game_creation > *at);
        if newer {
            latest.insert(
                &row.puuid,
                (name, row.tag_line.as_deref(), row.game_creation),
            );
        }
    }
    {
        let tx = conn.unchecked_transaction()?;
        let mut upsert = conn.prepare(
            "
    INSERT OR IGNORE INTO summoner (puuid, game_name, tag_line, summoner_id, account_id, updated_at)
    VALUES (?, ?, ?, NULL, NULL, ?)
  ",
        )?;
        for puuid in &user_puuids {
            let found = latest.get(puuid);
            upsert.execute(params![
                puuid,
                found.map(|(name, _, _)| *name),
                found.and_then(|(_, tag, _)| *tag),
                now_ms(),
            ])?;
        }
        drop(upsert);
        tx.commit()?;
    }

    // Step 6: stats, augments, remake flags and scores, now that ownership
    // is settled
    let rebuilt_games = rebuild_derived_stats(conn, champions)?;

    Ok(RepairResult {
        repaired_games,
        discovered_accounts: user_puuids.len() as i64,
        rebuilt_games,
    })
}
