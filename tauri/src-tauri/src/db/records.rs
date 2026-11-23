//! `src/main/db/records.ts`: the whole-career walk the Records page and the
//! recaps read, and the trophy case computed from it.

use rusqlite::types::Value as Sql;
use rusqlite::{Connection, params_from_iter};

use super::filters::{Where, apply_queue_filter};
use super::num::Num;
use super::stmt;
use crate::commands::types::{RecordBests, RecordMatchRef, RecordsData, StatRecord, StreakRecord};
use crate::db_row;

db_row! {
    /// One counted game, oldest first. A streak and a milestone are only
    /// meaningful in the order the games were played.
    #[derive(Debug, Clone, PartialEq)]
    pub struct CareerRow {
        pub game_id: i64,
        pub game_creation: i64,
        pub game_duration: Num,
        pub queue_id: i64,
        pub champion_id: i64,
        pub win: Num,
        pub kills: Num,
        pub deaths: Num,
        pub assists: Num,
        pub total_damage_dealt: Num,
        pub total_damage_taken: Num,
        pub gold_earned: Num,
        pub total_heal: Num,
        pub largest_killing_spree: Num,
        pub score: Option<f64>,
        pub score_raw: Option<f64>,
        pub score_badge: Option<String>,
        pub double_kills: Num,
        pub triple_kills: Num,
        pub quadra_kills: Num,
        pub penta_kills: Num,
    }
}

/// Which games a career walk counts. None at all is every game on every
/// account in the visible queues.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CareerFilter {
    pub queue: Option<i64>,
    /// The account that owns the game; an empty one filters nothing.
    pub account: Option<String>,
    /// `game_creation` bounds, from inclusive and to exclusive.
    pub from: Option<i64>,
    pub to: Option<i64>,
}

/// `careerWhere`: the WHERE over `games g` joined to `player_stats`, so a
/// query totalling in SQL counts exactly the games [`career_rows`] walks.
pub fn career_where(conn: &Connection, filter: &CareerFilter) -> rusqlite::Result<Where> {
    let mut w = Where {
        conditions: vec!["g.is_remake = 0".into()],
        params: Vec::new(),
    };
    apply_queue_filter(conn, &mut w, filter.queue, "g")?;
    if let Some(account) = filter.account.as_deref().filter(|a| !a.is_empty()) {
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

/// `careerRows`.
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
            w.conditions.join(" AND ")
        ),
        params_from_iter(&w.params),
    )
}

/// `getRecords`.
pub fn get_records(
    conn: &Connection,
    queue: Option<i64>,
    account: Option<String>,
) -> rusqlite::Result<RecordsData> {
    let filter = CareerFilter {
        queue,
        account,
        ..CareerFilter::default()
    };
    Ok(compute_records(&career_rows(conn, &filter)?))
}

pub fn higher(a: f64, b: f64) -> bool {
    a > b
}

pub fn lower(a: f64, b: f64) -> bool {
    a < b
}

/// Just enough of the game to render a record's context and open its match.
pub fn match_of(r: &CareerRow) -> RecordMatchRef {
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
/// chronological pass. On ties the earliest game keeps the record, so a
/// mark has to be strictly beaten to change hands.
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
    fn track(
        best: &mut Option<StatRecord>,
        value: Option<f64>,
        row: &CareerRow,
        better: fn(f64, f64) -> bool,
    ) {
        let Some(value) = value else { return };
        if best.as_ref().is_none_or(|b| better(value, b.value)) {
            *best = Some(StatRecord {
                value,
                game: match_of(row),
            });
        }
    }

    let mut win_streak: Option<StreakRecord> = None;
    let mut loss_streak: Option<StreakRecord> = None;
    // (win, length, start) of the run the current game extends
    let mut run: Option<(f64, i64, i64)> = None;

    for r in rows {
        let n = |v: Num| Some(v.0);
        track(&mut bests.kills, n(r.kills), r, higher);
        track(&mut bests.deaths, n(r.deaths), r, higher);
        track(&mut bests.assists, n(r.assists), r, higher);
        // Deathless games rank by kills+assists rather than dividing by zero
        let kda = (r.kills.0 + r.assists.0) / r.deaths.0.max(1.0);
        track(&mut bests.kda, Some(kda), r, higher);
        // Unclamped: every great game shows as 10 once clamped
        track(&mut bests.score, r.score_raw.or(r.score), r, higher);
        track(
            &mut bests.killing_spree,
            n(r.largest_killing_spree),
            r,
            higher,
        );
        track(&mut bests.damage, n(r.total_damage_dealt), r, higher);
        track(&mut bests.damage_taken, n(r.total_damage_taken), r, higher);
        track(&mut bests.healing, n(r.total_heal), r, higher);
        track(&mut bests.gold, n(r.gold_earned), r, higher);
        if r.win.0 != 0.0 {
            track(&mut bests.fastest_win, n(r.game_duration), r, lower);
        }
        track(&mut bests.longest_game, n(r.game_duration), r, higher);

        let (_, length, start) = match run {
            Some((win, length, start)) if win == r.win.0 => (win, length + 1, start),
            _ => (r.win.0, 1, r.game_creation),
        };
        run = Some((r.win.0, length, start));
        let record = StreakRecord {
            length,
            start,
            end: r.game_creation,
            game: match_of(r),
        };
        let streak = if r.win.0 != 0.0 {
            &mut win_streak
        } else {
            &mut loss_streak
        };
        if streak.as_ref().is_none_or(|s| length > s.length) {
            *streak = Some(record);
        }
    }

    RecordsData {
        total_games: rows.len() as i64,
        bests,
        win_streak,
        loss_streak,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn game(game_id: i64, win: i64, kills: i64, deaths: i64, assists: i64) -> CareerRow {
        CareerRow {
            game_id,
            game_creation: game_id * 1000,
            game_duration: Num::from(900 + game_id),
            queue_id: 2400,
            champion_id: 1,
            win: win.into(),
            kills: kills.into(),
            deaths: deaths.into(),
            assists: assists.into(),
            total_damage_dealt: Num::default(),
            total_damage_taken: Num::default(),
            gold_earned: Num::default(),
            total_heal: Num::default(),
            largest_killing_spree: Num::default(),
            score: None,
            score_raw: None,
            score_badge: None,
            double_kills: Num::default(),
            triple_kills: Num::default(),
            quadra_kills: Num::default(),
            penta_kills: Num::default(),
        }
    }

    #[test]
    fn a_tie_leaves_the_record_with_the_earliest_game() {
        let records = compute_records(&[game(1, 1, 10, 2, 0), game(2, 0, 10, 5, 0)]);
        assert_eq!(records.bests.kills.unwrap().game.game_id, 1);
        assert_eq!(records.bests.deaths.unwrap().game.game_id, 2);
    }

    #[test]
    fn a_deathless_game_ranks_kda_by_kills_and_assists() {
        let records = compute_records(&[game(1, 1, 3, 2, 3), game(2, 1, 2, 0, 2)]);
        let kda = records.bests.kda.unwrap();
        assert_eq!((kda.value, kda.game.game_id), (4.0, 2));
    }

    #[test]
    fn the_unclamped_score_wins_over_the_clamped_one() {
        let mut clamped = game(1, 1, 0, 0, 0);
        clamped.score = Some(10.0);
        let mut raw = game(2, 1, 0, 0, 0);
        raw.score = Some(10.0);
        raw.score_raw = Some(11.5);
        let records = compute_records(&[clamped, raw, game(3, 1, 0, 0, 0)]);
        let score = records.bests.score.unwrap();
        assert_eq!((score.value, score.game.game_id), (11.5, 2));
    }

    #[test]
    fn only_wins_count_for_the_fastest_win() {
        let records = compute_records(&[game(1, 0, 0, 0, 0), game(5, 1, 0, 0, 0)]);
        assert_eq!(records.bests.fastest_win.unwrap().value, 905.0);
        assert_eq!(records.bests.longest_game.unwrap().game.game_id, 5);
    }

    #[test]
    fn streaks_keep_the_first_longest_run() {
        let wins = [1, 1, 0, 0, 0, 1, 1];
        let rows: Vec<_> = (0..7)
            .map(|i| game(i + 1, wins[i as usize], 0, 0, 0))
            .collect();
        let records = compute_records(&rows);
        let win = records.win_streak.unwrap();
        assert_eq!((win.length, win.start, win.end), (2, 1000, 2000));
        let loss = records.loss_streak.unwrap();
        assert_eq!((loss.length, loss.start, loss.end), (3, 3000, 5000));
        assert_eq!(records.total_games, 7);
    }

    #[test]
    fn no_games_hold_no_records() {
        let records = compute_records(&[]);
        assert_eq!(records.total_games, 0);
        assert!(records.bests.kills.is_none() && records.win_streak.is_none());
    }
}
