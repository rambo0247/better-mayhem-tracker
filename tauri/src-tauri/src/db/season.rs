//! `src/main/db/season.ts` for `db:season-recap` and `db:seasons`, with the
//! friends, items and records read through T14's and T15's module names.

use std::collections::HashMap;

use jiff::tz::TimeZone;
use rusqlite::types::Value as Sql;
use rusqlite::{Connection, params_from_iter};

use super::filters::{SEASONS, Where, find_season, season_bounds};
use super::records::{CareerFilter, career_rows, career_where, compute_records};
use super::stats::{ITEM_SLOTS, excluded_items_sql, item_slot_union};
use super::stmt;
use super::teammates::{MIN_SHARED_GAMES, get_teammate_stats};
use crate::commands::recap::{
    DayStreak, SeasonChampion, SeasonDay, SeasonPlayer, SeasonRecap, SeasonSummary,
};
use crate::commands::types::{AugmentStats, ItemStats, Multikills};
use crate::db_row;
use crate::session::{add_days, local_hour, local_weekday, session_day};

/// `ALL_TIME_ID` in `src/shared/seasons.ts`: every game on record.
pub const ALL_TIME_ID: &str = "all";

const TOP_CHAMPIONS: usize = 6;
const TOP_AUGMENTS: i64 = 6;
// Deep enough that setting the boots aside still leaves a full list
const TOP_ITEMS: i64 = 20;
const TOP_FRIENDS: usize = 5;

/// The conditions joined for a `WHERE` clause.
fn where_sql(w: &Where) -> String {
    w.conditions.join(" AND ")
}

fn params(w: &Where) -> impl rusqlite::Params + '_ {
    params_from_iter(w.params.iter())
}

/// Index of the largest count, the earliest winning a tie; none when every
/// count is zero.
fn busiest(counts: &[i64]) -> Option<i64> {
    let mut best: Option<usize> = None;
    for (i, &count) in counts.iter().enumerate() {
        if count > 0 && best.is_none_or(|b| count > counts[b]) {
            best = Some(i);
        }
    }
    best.map(|b| b as i64)
}

/// Days come in order, so a run carries on through each day that follows
/// straight on from the one before.
fn longest_streak(days: &[SeasonDay], tz: &TimeZone) -> Option<DayStreak> {
    let mut best: Option<DayStreak> = None;
    let mut previous: Option<i64> = None;
    let (mut from, mut length) = (0, 0);
    for &SeasonDay { day, .. } in days {
        if previous.is_some_and(|p| add_days(p, 1, tz) == day) {
            length += 1;
        } else {
            from = day;
            length = 1;
        }
        previous = Some(day);
        if best.as_ref().is_none_or(|b| length > b.days) {
            best = Some(DayStreak {
                days: length,
                from,
                to: day,
            });
        }
    }
    best
}

/// Averaged per game rather than pooled, as the Total Stats page measures a
/// champion's share, so a stomp doesn't count for more than a close one.
fn team_shares(conn: &Connection, w: &Where) -> rusqlite::Result<(Option<f64>, Option<f64>)> {
    conn.prepare_cached(&format!(
        "
      WITH mine AS (
        SELECT mp.game_id, mp.team_id, mp.kills, mp.assists, mp.total_damage_dealt
        FROM games g
        JOIN player_stats ps ON ps.game_id = g.game_id
        JOIN match_participants mp ON mp.game_id = g.game_id AND mp.puuid = g.puuid
        WHERE {}
      ),
      teams AS (
        SELECT mp.game_id, mp.team_id,
               SUM(mp.kills) as team_kills,
               SUM(mp.total_damage_dealt) as team_damage
        FROM mine m
        JOIN match_participants mp ON mp.game_id = m.game_id AND mp.team_id = m.team_id
        GROUP BY mp.game_id, mp.team_id
      )
      SELECT AVG(CASE WHEN t.team_kills > 0
                      THEN (m.kills + m.assists) * 1.0 / t.team_kills END) as killParticipation,
             AVG(CASE WHEN t.team_damage > 0
                      THEN m.total_damage_dealt * 1.0 / t.team_damage END) as damageShare
      FROM mine m
      JOIN teams t ON t.game_id = m.game_id AND t.team_id = m.team_id
    ",
        where_sql(w)
    ))?
    .query_row(params(w), |row| Ok((row.get(0)?, row.get(1)?)))
}

db_row! {
    struct AugmentPick { augment_id: i64, picks: i64, wins: i64 }
}

db_row! {
    struct ItemPick { item_id: i64, picks: i64, wins: i64 }
}

fn top_augments(conn: &Connection, w: &Where) -> rusqlite::Result<Vec<AugmentStats>> {
    let mut p = w.params.clone();
    p.push(Sql::Integer(TOP_AUGMENTS));
    let rows: Vec<AugmentPick> = stmt::all(
        conn,
        &format!(
            "
      SELECT ga.augment_id, COUNT(*) as picks, SUM(ps.win) as wins
      FROM game_augments ga
      JOIN games g ON g.game_id = ga.game_id
      JOIN player_stats ps ON ps.game_id = g.game_id
      WHERE {}
      GROUP BY ga.augment_id
      ORDER BY picks DESC, wins DESC, ga.augment_id
      LIMIT ?
    ",
            where_sql(w)
        ),
        params_from_iter(p),
    )?;
    Ok(rows
        .into_iter()
        .map(|r| AugmentStats {
            augment_id: r.augment_id,
            picks: r.picks,
            wins: r.wins,
        })
        .collect())
}

fn top_items(conn: &Connection, w: &Where) -> rusqlite::Result<Vec<ItemStats>> {
    let sql = where_sql(w);
    let excluded = excluded_items_sql();
    let union = item_slot_union(|i| {
        format!(
            "SELECT ps.item{i} as item_id, ps.win
                FROM player_stats ps JOIN games g ON g.game_id = ps.game_id
                WHERE {sql}
                  AND ps.item{i} > 0 AND ps.item{i} NOT IN ({excluded})"
        )
    });
    let mut p: Vec<Sql> = ITEM_SLOTS
        .iter()
        .flat_map(|_| w.params.iter().cloned())
        .collect();
    p.push(Sql::Integer(TOP_ITEMS));
    let rows: Vec<ItemPick> = stmt::all(
        conn,
        &format!(
            "
      SELECT item_id, COUNT(*) as picks, SUM(win) as wins
      FROM (
        {union}
      )
      GROUP BY item_id
      ORDER BY picks DESC, wins DESC, item_id
      LIMIT ?
    "
        ),
        params_from_iter(p),
    )?;
    Ok(rows
        .into_iter()
        .map(|r| ItemStats {
            item_id: r.item_id,
            picks: r.picks,
            wins: r.wins,
        })
        .collect())
}

db_row! {
    struct OwnerRow { puuid: String }
}

db_row! {
    struct IdentityRow { game_name: Option<String>, tag_line: Option<String>, profile_icon: Option<i64> }
}

/// The account that played the most of these games, named and pictured as
/// its last game in the span recorded it. Falls back on the summoner table,
/// and on the account filter or the most recently synced account when the
/// span has no games.
fn span_player(
    conn: &Connection,
    w: &Where,
    account: Option<&str>,
) -> rusqlite::Result<(SeasonPlayer, i64)> {
    let sql = where_sql(w);
    let owners: Vec<OwnerRow> = stmt::all(
        conn,
        &format!(
            "
      SELECT g.puuid, COUNT(*) as games
      FROM games g
      JOIN player_stats ps ON ps.game_id = g.game_id
      WHERE {sql} AND g.puuid != ''
      GROUP BY g.puuid
      ORDER BY games DESC, MAX(g.game_creation) DESC
    "
        ),
        params(w),
    )?;

    // `owners[0]?.puuid ?? account`, then tested for truthiness
    let puuid = owners
        .first()
        .map(|o| o.puuid.as_str())
        .or(account)
        .filter(|p| !p.is_empty());
    let recorded = match puuid {
        Some(puuid) => {
            let mut p = w.params.clone();
            p.push(Sql::Text(puuid.into()));
            stmt::first::<IdentityRow>(
                conn,
                &format!(
                    "
          SELECT mp.game_name, mp.tag_line, mp.profile_icon
          FROM games g
          JOIN player_stats ps ON ps.game_id = g.game_id
          JOIN match_participants mp ON mp.game_id = g.game_id AND mp.puuid = g.puuid
          WHERE {sql} AND g.puuid = ?
          ORDER BY g.game_creation DESC
          LIMIT 1
        "
                ),
                params_from_iter(p),
            )?
        }
        None => None,
    };
    let synced = match puuid {
        Some(puuid) => stmt::first::<IdentityRow>(
            conn,
            "SELECT game_name, tag_line, profile_icon FROM summoner WHERE puuid = ?",
            [puuid],
        )?,
        None => stmt::first::<IdentityRow>(
            conn,
            "SELECT game_name, tag_line, profile_icon FROM summoner ORDER BY updated_at DESC LIMIT 1",
            [],
        )?,
    };

    let has_name = |r: &IdentityRow| r.game_name.as_deref().is_some_and(|n| !n.is_empty());
    // A tag only means anything beside the name it was recorded with
    let named = match &recorded {
        Some(r) if has_name(r) => Some(r),
        _ => synced.as_ref(),
    };
    let named_ok = named.is_some_and(has_name);
    let player = SeasonPlayer {
        game_name: named.and_then(|n| n.game_name.clone()),
        tag_line: if named_ok {
            named.and_then(|n| n.tag_line.clone())
        } else {
            None
        },
        profile_icon: recorded
            .as_ref()
            .and_then(|r| r.profile_icon)
            .or_else(|| synced.as_ref().and_then(|s| s.profile_icon)),
    };
    Ok((player, owners.len() as i64))
}

db_row! {
    struct PatchRow { game_version: String }
}

fn latest_patch(conn: &Connection, w: &Where) -> rusqlite::Result<Option<String>> {
    Ok(stmt::first::<PatchRow>(
        conn,
        &format!(
            "
      SELECT g.game_version
      FROM games g
      JOIN player_stats ps ON ps.game_id = g.game_id
      WHERE {} AND g.game_version IS NOT NULL AND g.game_version != ''
      ORDER BY g.game_creation DESC
      LIMIT 1
    ",
            where_sql(w)
        ),
        params(w),
    )?
    .map(|r| r.game_version))
}

/// How many games `career_rows` would walk under a filter.
fn count_games(conn: &Connection, filter: &CareerFilter) -> rusqlite::Result<i64> {
    let w = career_where(conn, filter)?;
    conn.prepare_cached(&format!(
        "
      SELECT COUNT(*) as games
      FROM games g
      JOIN player_stats ps ON ps.game_id = g.game_id
      WHERE {}
    ",
        where_sql(&w)
    ))?
    .query_row(params(&w), |row| row.get(0))
}

/// Every season that has begun, oldest first, then the all-time entry, each
/// with how many of the filter's games it holds.
fn summarize(
    conn: &Connection,
    filter: &CareerFilter,
    now_ms: i64,
) -> rusqlite::Result<Vec<SeasonSummary>> {
    let mut seasons = Vec::new();
    for season in &SEASONS {
        let bounds = season_bounds(season);
        // `from <= now`; a date jiff cannot read compares as NaN would, false
        if bounds.from.is_none_or(|from| from > now_ms) {
            continue;
        }
        seasons.push(SeasonSummary {
            id: season.id.into(),
            name: season.name.into(),
            start: Some(season.start.into()),
            end: season.end.map(Into::into),
            games: count_games(
                conn,
                &CareerFilter {
                    from: bounds.from,
                    to: bounds.to,
                    ..filter.clone()
                },
            )?,
        });
    }
    seasons.push(SeasonSummary {
        id: ALL_TIME_ID.into(),
        name: "All time".into(),
        start: None,
        end: None,
        games: count_games(conn, filter)?,
    });
    Ok(seasons)
}

/// `getSeasons`: the picker's list over every account in the visible queues.
pub fn get_seasons(conn: &Connection, now_ms: i64) -> rusqlite::Result<Vec<SeasonSummary>> {
    summarize(conn, &CareerFilter::default(), now_ms)
}

struct ChampionTally {
    champion: SeasonChampion,
    score_sum: f64,
    scored: i64,
}

/// `getSeasonRecap`: one season, or every game for all time, under the
/// Records page's queue and account filters. With no season named it picks
/// the latest one with games. A season named but not on offer is none.
pub fn get_season_recap(
    conn: &Connection,
    season_id: Option<&str>,
    queue: Option<i64>,
    account: Option<&str>,
    now_ms: i64,
    tz: &TimeZone,
) -> rusqlite::Result<Option<SeasonRecap>> {
    let base = CareerFilter {
        queue,
        account: account.map(Into::into),
        ..CareerFilter::default()
    };
    let seasons = summarize(conn, &base, now_ms)?;
    let summary = match season_id {
        None => seasons
            .iter()
            .rev()
            .find(|s| s.id != ALL_TIME_ID && s.games > 0)
            .or(seasons.last()),
        Some(id) => seasons.iter().find(|s| s.id == id),
    };
    let Some(summary) = summary.cloned() else {
        return Ok(None);
    };
    let filter = match find_season(&summary.id) {
        Some(season) => {
            let bounds = season_bounds(season);
            CareerFilter {
                from: bounds.from,
                to: bounds.to,
                ..base
            }
        }
        None => base,
    };
    let rows = career_rows(conn, &filter)?;
    let w = career_where(conn, &filter)?;

    let (mut wins, mut duration, mut kills, mut deaths, mut assists) = (0, 0, 0, 0, 0);
    let (mut damage, mut damage_taken, mut healing, mut gold) = (0, 0, 0, 0);
    let (mut mvps, mut aces, mut scored, mut scored_wins, mut scored_losses) = (0, 0, 0, 0, 0);
    let mut score_sum = 0.0;
    let mut multikills = Multikills {
        doubles: 0,
        triples: 0,
        quadras: 0,
        pentas: 0,
    };
    // In the order first met, which is the order played
    let mut days: Vec<SeasonDay> = Vec::new();
    let mut day_at: HashMap<i64, usize> = HashMap::new();
    let mut hours = [0i64; 24];
    let mut weekdays = [0i64; 7];
    let mut champions: Vec<ChampionTally> = Vec::new();
    let mut champion_at: HashMap<i64, usize> = HashMap::new();

    for r in &rows {
        wins += r.win;
        duration += r.game_duration;
        kills += r.kills;
        deaths += r.deaths;
        assists += r.assists;
        damage += r.total_damage_dealt;
        damage_taken += r.total_damage_taken;
        healing += r.total_heal;
        gold += r.gold_earned;
        if r.score_badge.as_deref() == Some("MVP") {
            mvps += 1;
        }
        if r.score_badge.as_deref() == Some("ACE") {
            aces += 1;
        }
        if let Some(score) = r.score {
            score_sum += score;
            scored += 1;
            if r.win != 0 {
                scored_wins += 1;
            } else {
                scored_losses += 1;
            }
        }
        multikills.doubles += r.double_kills;
        multikills.triples += r.triple_kills;
        multikills.quadras += r.quadra_kills;
        multikills.pentas += r.penta_kills;

        let day = session_day(r.game_creation, tz);
        let i = *day_at.entry(day).or_insert_with(|| {
            days.push(SeasonDay {
                day,
                games: 0,
                wins: 0,
            });
            days.len() - 1
        });
        days[i].games += 1;
        days[i].wins += r.win;
        // The hour on the clock, but the weekday of the session: a 1am game
        // on a Saturday was part of Friday night
        hours[local_hour(r.game_creation, tz)] += 1;
        weekdays[local_weekday(day, tz)] += 1;

        let c = *champion_at.entry(r.champion_id).or_insert_with(|| {
            champions.push(ChampionTally {
                champion: SeasonChampion {
                    champion_id: r.champion_id,
                    games: 0,
                    wins: 0,
                    kills: 0,
                    deaths: 0,
                    assists: 0,
                    avg_score: None,
                },
                score_sum: 0.0,
                scored: 0,
            });
            champions.len() - 1
        });
        let tally = &mut champions[c];
        tally.champion.games += 1;
        tally.champion.wins += r.win;
        tally.champion.kills += r.kills;
        tally.champion.deaths += r.deaths;
        tally.champion.assists += r.assists;
        if let Some(score) = r.score {
            tally.score_sum += score;
            tally.scored += 1;
        }
    }

    let unique_champions = champions.len() as i64;
    let mut champion_list: Vec<SeasonChampion> = champions
        .into_iter()
        .map(|t| SeasonChampion {
            avg_score: (t.scored > 0).then_some(t.score_sum / t.scored as f64),
            ..t.champion
        })
        .collect();
    champion_list.sort_by(|a, b| {
        b.games
            .cmp(&a.games)
            .then(b.wins.cmp(&a.wins))
            .then(a.champion_id.cmp(&b.champion_id))
    });
    champion_list.truncate(TOP_CHAMPIONS);

    let mut busiest_day: Option<&SeasonDay> = None;
    for played in &days {
        if busiest_day.is_none_or(|b| {
            played.games > b.games || (played.games == b.games && played.wins > b.wins)
        }) {
            busiest_day = Some(played);
        }
    }
    let busiest_day = busiest_day.cloned();

    let (player, accounts) = span_player(
        conn,
        &w,
        filter.account.as_deref().filter(|a| !a.is_empty()),
    )?;
    let (kill_participation, damage_share) = if rows.is_empty() {
        (None, None)
    } else {
        team_shares(conn, &w)?
    };
    let mut friends = get_teammate_stats(conn, &filter, MIN_SHARED_GAMES)?;
    friends.truncate(TOP_FRIENDS);

    Ok(Some(SeasonRecap {
        season: summary,
        seasons,
        player,
        accounts,
        patch: latest_patch(conn, &w)?,
        first_game: rows.first().map(|r| r.game_creation),
        last_game: rows.last().map(|r| r.game_creation),
        games: rows.len() as i64,
        wins,
        duration,
        day_streak: longest_streak(&days, tz),
        busiest_day,
        days,
        peak_hour: busiest(&hours),
        top_weekday: busiest(&weekdays),
        kills,
        deaths,
        assists,
        damage,
        damage_taken,
        healing,
        gold,
        multikills,
        kill_participation,
        damage_share,
        avg_score: (scored > 0).then_some(score_sum / scored as f64),
        mvps,
        aces,
        scored_wins,
        scored_losses,
        champions: champion_list,
        unique_champions,
        augments: if rows.is_empty() {
            Vec::new()
        } else {
            top_augments(conn, &w)?
        },
        items: if rows.is_empty() {
            Vec::new()
        } else {
            top_items(conn, &w)?
        },
        records: compute_records(&rows),
        friends,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_earliest_busiest_slot_wins() {
        assert_eq!(busiest(&[0, 3, 1, 3]), Some(1));
        assert_eq!(busiest(&[0, 0]), None);
    }

    fn library(days: &[&str]) -> (Connection, TimeZone) {
        let tz = TimeZone::get("America/New_York").unwrap();
        let conn = Connection::open_in_memory().unwrap();
        crate::db::schema::init_database(&conn, 0).unwrap();
        for (i, at) in days.iter().enumerate() {
            let wall: jiff::civil::DateTime = at.parse().unwrap();
            let ms = wall
                .to_zoned_datetime(tz.clone())
                .unwrap()
                .timestamp()
                .as_millisecond();
            conn.execute(
                "INSERT INTO games (game_id, queue_id, game_mode, game_creation, game_duration, puuid, game_version)
                 VALUES (?, 2400, 'KIWI', ?, 1000, 'me', '16.1')",
                rusqlite::params![i as i64 + 1, ms],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO player_stats (game_id, champion_id, win, kills, deaths, assists, score)
                 VALUES (?, 10, ?, 5, 5, 5, 6.5)",
                rusqlite::params![i as i64 + 1, (i % 2) as i64],
            )
            .unwrap();
        }
        (conn, tz)
    }

    fn ms(at: &str, tz: &TimeZone) -> i64 {
        let wall: jiff::civil::DateTime = at.parse().unwrap();
        wall.to_zoned_datetime(tz.clone())
            .unwrap()
            .timestamp()
            .as_millisecond()
    }

    #[test]
    fn a_season_still_to_come_is_not_offered() {
        let (conn, _) = library(&["2026-06-12T20:00"]);
        let ids = |now| {
            get_seasons(&conn, now)
                .unwrap()
                .into_iter()
                .map(|s| (s.id, s.games))
                .collect::<Vec<_>>()
        };
        // Season bounds are local dates in the system zone, as Electron reads them,
        // so the instants come from the same bounds rather than from a fixed zone
        let set_3 = season_bounds(find_season("set-3").unwrap()).from.unwrap();
        assert_eq!(
            ids(set_3 - 1),
            [
                ("set-0".into(), 0),
                ("set-1".into(), 0),
                ("set-2".into(), 1),
                ("all".into(), 1)
            ]
        );
        assert_eq!(ids(set_3).len(), 5);
    }

    #[test]
    fn with_no_season_named_the_latest_with_games_is_recapped() {
        let (conn, tz) = library(&[
            "2026-06-12T20:00",
            "2026-06-13T01:00",
            "2026-06-13T21:00",
            "2026-06-14T21:00",
            "2026-06-20T21:00",
        ]);
        let now = ms("2026-11-23T12:00", &tz);
        let recap = get_season_recap(&conn, None, None, None, now, &tz)
            .unwrap()
            .unwrap();
        assert_eq!(recap.season.id, "set-2");
        assert_eq!(recap.games, 5);
        // The 1am game was the night of the 12th, so the 12th to the 14th run on
        let streak = recap.day_streak.unwrap();
        assert_eq!(
            (streak.days, streak.from, streak.to),
            (3, ms("2026-06-12T00:00", &tz), ms("2026-06-14T00:00", &tz))
        );
        let busiest_day = recap.busiest_day.unwrap();
        assert_eq!(
            (busiest_day.day, busiest_day.games),
            (ms("2026-06-12T00:00", &tz), 2)
        );
        assert_eq!(recap.peak_hour, Some(21));
        // Friday the 12th, with the 1am game counted to it
        assert_eq!(recap.top_weekday, Some(5));
        assert_eq!(recap.patch.as_deref(), Some("16.1"));

        assert!(
            get_season_recap(&conn, Some("nope"), None, None, now, &tz)
                .unwrap()
                .is_none()
        );
        let empty = get_season_recap(&conn, Some("set-1"), None, None, now, &tz)
            .unwrap()
            .unwrap();
        assert_eq!(empty.games, 0);
        assert!(empty.augments.is_empty() && empty.days.is_empty());
        assert_eq!((empty.kill_participation, empty.avg_score), (None, None));
        assert_eq!(empty.player.game_name, None);
    }
}
