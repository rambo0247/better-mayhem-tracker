//! The career walk from `src/main/db/records.ts`: one row per counted game,
//! oldest first, and the records one pass over those rows finds. The recap
//! and the season recap both read the library this way.
//!
//! T14 ports `records.ts` for `db:records` in parallel; once both land, one
//! copy of this module should serve both.

use rusqlite::Connection;
use rusqlite::types::Value as Sql;

use super::filters::{Where, apply_queue_filter};
use super::stmt;
use crate::commands::types::{RecordBests, RecordMatchRef, RecordsData, StatRecord, StreakRecord};
use crate::db_row;

db_row! {
    #[derive(Debug, Clone, PartialEq)]
    pub struct CareerRow {
        pub game_id: i64,
        pub game_creation: i64,
        pub game_duration: i64,
        pub queue_id: i64,
        pub champion_id: i64,
        pub win: i64,
        pub kills: i64,
        pub deaths: i64,
        pub assists: i64,
        pub total_damage_dealt: i64,
        pub total_damage_taken: i64,
        pub gold_earned: i64,
        pub total_heal: i64,
        pub largest_killing_spree: i64,
        pub score: Option<f64>,
        pub score_raw: Option<f64>,
        pub score_badge: Option<String>,
        pub double_kills: i64,
        pub triple_kills: i64,
        pub quadra_kills: i64,
        pub penta_kills: i64,
    }
}

impl CareerRow {
    pub fn is_mvp(&self) -> bool {
        self.score_badge.as_deref() == Some("MVP")
    }

    pub fn is_ace(&self) -> bool {
        self.score_badge.as_deref() == Some("ACE")
    }

    /// Deathless games rank by kills plus assists rather than dividing by zero.
    pub fn kda(&self) -> f64 {
        (self.kills + self.assists) as f64 / self.deaths.max(1) as f64
    }
}

/// `CareerFilter`. Nothing set is every game on every account in the
/// visible queues.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CareerFilter {
    pub queue: Option<i64>,
    /// The account that owns the game. Empty counts as none, as `if
    /// (filter.account)` reads it.
    pub account: Option<String>,
    /// `game_creation` bounds, from inclusive and to exclusive.
    pub from: Option<i64>,
    pub to: Option<i64>,
}

impl CareerFilter {
    pub fn account(&self) -> Option<&str> {
        self.account.as_deref().filter(|a| !a.is_empty())
    }
}

/// `careerWhere`, over `games g` joined to `player_stats`.
pub fn career_where(conn: &Connection, filter: &CareerFilter) -> rusqlite::Result<Where> {
    let mut w = Where {
        conditions: vec!["g.is_remake = 0".into()],
        params: Vec::new(),
    };
    apply_queue_filter(conn, &mut w, filter.queue, "g")?;
    if let Some(account) = filter.account() {
        w.conditions.push("g.puuid = ?".into());
        w.params.push(Sql::Text(account.into()));
    }
    if let Some(from) = filter.from {
        w.conditions.push("g.game_creation >= ?".into());
        w.params.push(Sql::Integer(from));
    }
    if let Some(to) = filter.to {
        w.conditions.push("g.game_creation < ?".into());
        w.params.push(Sql::Integer(to));
    }
    Ok(w)
}

/// The conditions joined for a `WHERE` clause.
pub fn where_sql(w: &Where) -> String {
    w.conditions.join(" AND ")
}

pub fn career_rows(conn: &Connection, filter: &CareerFilter) -> rusqlite::Result<Vec<CareerRow>> {
    let w = career_where(conn, filter)?;
    stmt::all(
        conn,
        &format!(
            "
      SELECT g.game_id, g.game_creation, g.game_duration, g.queue_id,
             ps.champion_id, ps.win, ps.kills, ps.deaths, ps.assists,
             ps.total_damage_dealt, ps.total_damage_taken,
             ps.gold_earned, ps.total_heal, ps.largest_killing_spree,
             ps.score, ps.score_raw, ps.score_badge,
             ps.double_kills, ps.triple_kills, ps.quadra_kills, ps.penta_kills
      FROM games g
      JOIN player_stats ps ON g.game_id = ps.game_id
      WHERE {}
      ORDER BY g.game_creation ASC
    ",
            where_sql(&w)
        ),
        rusqlite::params_from_iter(&w.params),
    )
}

pub fn higher(a: f64, b: f64) -> bool {
    a > b
}

pub fn lower(a: f64, b: f64) -> bool {
    a < b
}

fn match_of(r: &CareerRow) -> RecordMatchRef {
    RecordMatchRef {
        game_id: r.game_id,
        game_creation: r.game_creation,
        game_duration: r.game_duration,
        queue_id: r.queue_id,
        champion_id: r.champion_id,
        win: r.win,
        kills: r.kills,
        deaths: r.deaths,
        assists: r.assists,
    }
}

/// `computeRecords`: best single-game marks and longest streaks from one
/// chronological pass. On ties the earliest game keeps the record.
pub fn compute_records(rows: &[CareerRow]) -> RecordsData {
    let mut bests = RecordBests {
        kills: None,
        deaths: None,
        assists: None,
        kda: None,
        score: None,
        killing_spree: None,
        damage: None,
        damage_taken: None,
        healing: None,
        gold: None,
        fastest_win: None,
        longest_game: None,
    };
    let track = |best: &mut Option<StatRecord>,
                 value: Option<f64>,
                 row: &CareerRow,
                 better: fn(f64, f64) -> bool| {
        let Some(value) = value else { return };
        if best.as_ref().is_none_or(|b| better(value, b.value)) {
            *best = Some(StatRecord {
                value,
                game: match_of(row),
            });
        }
    };

    let mut win_streak: Option<StreakRecord> = None;
    let mut loss_streak: Option<StreakRecord> = None;
    let mut run: Option<(i64, i64, i64)> = None;

    for r in rows {
        track(&mut bests.kills, Some(r.kills as f64), r, higher);
        track(&mut bests.deaths, Some(r.deaths as f64), r, higher);
        track(&mut bests.assists, Some(r.assists as f64), r, higher);
        track(&mut bests.kda, Some(r.kda()), r, higher);
        // Unclamped, or every great game would tie at 10
        track(&mut bests.score, r.score_raw.or(r.score), r, higher);
        track(
            &mut bests.killing_spree,
            Some(r.largest_killing_spree as f64),
            r,
            higher,
        );
        track(
            &mut bests.damage,
            Some(r.total_damage_dealt as f64),
            r,
            higher,
        );
        track(
            &mut bests.damage_taken,
            Some(r.total_damage_taken as f64),
            r,
            higher,
        );
        track(&mut bests.healing, Some(r.total_heal as f64), r, higher);
        track(&mut bests.gold, Some(r.gold_earned as f64), r, higher);
        if r.win != 0 {
            track(
                &mut bests.fastest_win,
                Some(r.game_duration as f64),
                r,
                lower,
            );
        }
        track(
            &mut bests.longest_game,
            Some(r.game_duration as f64),
            r,
            higher,
        );

        let (win, length, start) = match run {
            Some((win, length, start)) if win == r.win => (win, length + 1, start),
            _ => (r.win, 1, r.game_creation),
        };
        run = Some((win, length, start));
        let record = StreakRecord {
            length,
            start,
            end: r.game_creation,
            game: match_of(r),
        };
        let slot = if r.win != 0 {
            &mut win_streak
        } else {
            &mut loss_streak
        };
        if slot.as_ref().is_none_or(|s| length > s.length) {
            *slot = Some(record);
        }
    }

    RecordsData {
        total_games: rows.len() as i64,
        bests,
        win_streak,
        loss_streak,
    }
}
