//! `src/main/db/scoring.ts`: the owner's score at insert time, and the
//! backfill that recomputes every stored score when the formula or the
//! champion class data changes.

use std::collections::HashMap;

use rusqlite::{Connection, params};

use super::js;
use super::payloads::RawParticipantRow;
use super::settings::{get_setting, set_setting};
use super::stmt::{self, FromRow};
use crate::db_row;
use crate::op_score::{
    ChampionClassMap, PlayerScore, SCORE_FORMULA_VERSION, ScoreInput, compute_match_scores,
};

/// The champion class data scoring reads, and the Data Dragon version it
/// came from: `getChampionClasses()` and `getChampionDataVersion()`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ChampionClasses {
    pub version: String,
    pub classes: ChampionClassMap,
}

impl ChampionClasses {
    /// What Electron holds before any champion data loads.
    pub fn none() -> Self {
        Self {
            version: "none".into(),
            classes: ChampionClassMap::new(),
        }
    }
}

/// `scoreFormulaKey`: stored scores recompute when either half changes.
pub fn score_formula_key(champions: &ChampionClasses) -> String {
    format!("{SCORE_FORMULA_VERSION}@{}", champions.version)
}

/// `checkScoreBackfill`. Call once champion data has loaded; returns whether
/// a backfill ran, so the caller can send `lcu:games-updated`.
pub fn check_score_backfill(
    conn: &Connection,
    champions: &ChampionClasses,
) -> rusqlite::Result<bool> {
    let key = score_formula_key(champions);
    if get_setting(conn, "score_formula_version")?.as_str() == Some(key.as_str()) {
        return Ok(false);
    }
    backfill_scores(conn, &champions.classes)?;
    set_setting(conn, "score_formula_version", &key)?;
    Ok(true)
}

db_row! {
    /// A participant row as scoring reads it. Scoring grades a player
    /// against the other nine, so it always takes a whole game's rows.
    #[derive(Debug, Clone, PartialEq)]
    pub struct ScoreRow {
        pub participant_id: f64,
        pub puuid: Option<String>,
        pub team_id: f64,
        pub champion_id: f64,
        pub win: f64,
        pub kills: f64,
        pub deaths: f64,
        pub assists: f64,
        pub double_kills: f64,
        pub triple_kills: f64,
        pub quadra_kills: f64,
        pub penta_kills: f64,
        pub total_damage_dealt: f64,
        pub total_damage_taken: f64,
        pub gold_earned: f64,
        pub total_heal: f64,
    }
}

pub const SCORE_ROW_COLUMNS: &str = "participant_id, puuid, team_id, champion_id, win,
       kills, deaths, assists, double_kills, triple_kills, quadra_kills, penta_kills,
       total_damage_dealt, total_damage_taken, gold_earned, total_heal";

impl From<&RawParticipantRow> for ScoreRow {
    fn from(r: &RawParticipantRow) -> Self {
        Self {
            participant_id: r.participant_id,
            puuid: r.puuid.clone(),
            team_id: r.team_id,
            champion_id: r.champion_id,
            win: r.win,
            kills: r.kills,
            deaths: r.deaths,
            assists: r.assists,
            double_kills: r.double_kills,
            triple_kills: r.triple_kills,
            quadra_kills: r.quadra_kills,
            penta_kills: r.penta_kills,
            total_damage_dealt: r.total_damage_dealt,
            total_damage_taken: r.total_damage_taken,
            gold_earned: r.gold_earned,
            total_heal: r.total_heal,
        }
    }
}

impl ScoreRow {
    /// `scoreInputsFromRows`, one row.
    pub fn input(&self) -> ScoreInput {
        ScoreInput {
            participant_id: self.participant_id,
            team_id: self.team_id,
            champion_id: self.champion_id,
            kills: self.kills,
            deaths: self.deaths,
            assists: self.assists,
            double_kills: self.double_kills,
            triple_kills: self.triple_kills,
            quadra_kills: self.quadra_kills,
            penta_kills: self.penta_kills,
            total_damage_dealt_to_champions: self.total_damage_dealt,
            total_damage_taken: self.total_damage_taken,
            gold_earned: self.gold_earned,
            total_heal: self.total_heal,
            win: self.win == 1.0,
        }
    }
}

/// A [`ScoreRow`] with the game it belongs to, for whole-library reads.
#[derive(Debug, Clone, PartialEq)]
pub struct GameScoreRow {
    pub game_id: i64,
    pub row: ScoreRow,
}

impl FromRow for GameScoreRow {
    const COLUMNS: &'static [&'static str] = &[
        "game_id",
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
    ];

    fn from_row(row: &rusqlite::Row<'_>, at: &[usize]) -> rusqlite::Result<Self> {
        Ok(Self {
            game_id: row.get(at[0])?,
            row: ScoreRow::from_row(row, &at[1..])?,
        })
    }
}

/// `groupByGame`: flat rows spanning many games back into per-game lists,
/// so a whole-library rescore is one query rather than one per game.
pub fn group_by_game(rows: Vec<GameScoreRow>) -> HashMap<i64, Vec<ScoreRow>> {
    let mut by_game: HashMap<i64, Vec<ScoreRow>> = HashMap::new();
    for GameScoreRow { game_id, row } in rows {
        by_game.entry(game_id).or_default().push(row);
    }
    by_game
}

/// The owner's line, matched when the game has no owner puuid to look up.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct OwnerFallback {
    pub champion_id: f64,
    pub kills: f64,
    pub deaths: f64,
    pub assists: f64,
}

/// `computeOwnerScore`: the owner by puuid, else by champion and KDA. An
/// empty puuid is falsy, so it looks nothing up.
pub fn compute_owner_score(
    participants: &[ScoreRow],
    owner_puuid: Option<&str>,
    fallback: Option<OwnerFallback>,
    classes: &ChampionClassMap,
) -> Option<PlayerScore> {
    if participants.is_empty() {
        return None;
    }
    let by_puuid = owner_puuid.filter(|p| !p.is_empty()).and_then(|puuid| {
        participants
            .iter()
            .find(|p| p.puuid.as_deref() == Some(puuid))
    });
    let owner = by_puuid.or_else(|| {
        let f = fallback?;
        participants.iter().find(|p| {
            p.champion_id == f.champion_id
                && p.kills == f.kills
                && p.deaths == f.deaths
                && p.assists == f.assists
        })
    })?;
    let inputs: Vec<ScoreInput> = participants.iter().map(ScoreRow::input).collect();
    compute_match_scores(&inputs, Some(classes))
        .get(owner.participant_id)
        .copied()
}

db_row! {
    struct BackfillGame {
        game_id: i64,
        puuid: String,
        is_remake: i64,
        champion_id: f64,
        kills: f64,
        deaths: f64,
        assists: f64,
    }
}

/// `backfillScores`: every stored score recomputed from its participant rows,
/// in one transaction.
fn backfill_scores(conn: &Connection, classes: &ChampionClassMap) -> rusqlite::Result<()> {
    let games: Vec<BackfillGame> = stmt::all(
        conn,
        "
      SELECT g.game_id, g.puuid, g.is_remake,
             ps.champion_id, ps.kills, ps.deaths, ps.assists
      FROM games g
      JOIN player_stats ps ON g.game_id = ps.game_id
    ",
        [],
    )?;

    let participants = group_by_game(stmt::all(
        conn,
        &format!("SELECT game_id, {SCORE_ROW_COLUMNS} FROM match_participants"),
        [],
    )?);

    let mut update = conn.prepare_cached(
        "UPDATE player_stats SET score = ?, score_raw = ?, score_badge = ? WHERE game_id = ?",
    )?;
    js::transaction(conn, || {
        for game in &games {
            if game.is_remake != 0 {
                update.execute(params![
                    None::<f64>,
                    None::<f64>,
                    None::<&str>,
                    game.game_id
                ])?;
                continue;
            }
            let result = compute_owner_score(
                participants
                    .get(&game.game_id)
                    .map_or(&[][..], Vec::as_slice),
                Some(game.puuid.as_str()),
                Some(OwnerFallback {
                    champion_id: game.champion_id,
                    kills: game.kills,
                    deaths: game.deaths,
                    assists: game.assists,
                }),
                classes,
            );
            update.execute(params![
                result.map(|s| s.score),
                result.map(|s| s.raw),
                result.and_then(|s| s.badge).map(|b| b.as_str()),
                game.game_id,
            ])?;
        }
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_game_row_reads_the_score_columns_after_its_game_id() {
        assert_eq!(GameScoreRow::COLUMNS[1..], *ScoreRow::COLUMNS);
        let listed: Vec<&str> = SCORE_ROW_COLUMNS.split(',').map(str::trim).collect();
        assert_eq!(listed, ScoreRow::COLUMNS);
    }

    fn row(participant_id: f64, puuid: &str, champion_id: f64, kills: f64) -> ScoreRow {
        ScoreRow {
            participant_id,
            puuid: Some(puuid.into()),
            team_id: 100.0,
            champion_id,
            win: 1.0,
            kills,
            deaths: 2.0,
            assists: 5.0,
            double_kills: 0.0,
            triple_kills: 0.0,
            quadra_kills: 0.0,
            penta_kills: 0.0,
            total_damage_dealt: 10_000.0 + kills * 1_000.0,
            total_damage_taken: 15_000.0,
            gold_earned: 9_000.0,
            total_heal: 2_000.0,
        }
    }

    #[test]
    fn an_empty_owner_puuid_falls_back_to_champion_and_kda() {
        let rows = [row(1.0, "", 1.0, 3.0), row(2.0, "x", 2.0, 9.0)];
        let fallback = OwnerFallback {
            champion_id: 2.0,
            kills: 9.0,
            deaths: 2.0,
            assists: 5.0,
        };
        let classes = ChampionClassMap::new();
        let by_fallback = compute_owner_score(&rows, None, Some(fallback), &classes);
        let empty = compute_owner_score(&rows, Some(""), Some(fallback), &classes);
        let first = compute_owner_score(&rows, Some(""), None, &classes);
        assert!(by_fallback.is_some());
        assert_eq!(empty, by_fallback);
        assert_eq!(first, None);
    }
}
