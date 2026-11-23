//! `src/main/db/stats.ts`: champion, augment and item stats, the dashboard
//! header, the all-players stats and Trends. Every aggregate stays in SQL
//! where Electron computes it there; only the per-game averages of the
//! champion detail are rounded here, with `Math.round`.

use std::collections::HashMap;

use rusqlite::types::Value as Sql;
use rusqlite::{Connection, params_from_iter};

use super::filters::{Where, apply_queue_filter, apply_season_filter};
use super::num::Num;
use super::stmt::{self, FromRow};
use crate::commands::stats::{
    AugmentChampionPicks, AugmentStatsDetailed, AugmentStatsDetailedResult, ChampionStats,
    DashboardData, GlobalChampionDetail, GlobalChampionRow, GlobalStats, RecentFormGame,
    TrendsData, TrendsDay, TrendsHour, TrendsPatch, TrendsWeekday,
};
use crate::commands::types::{AugmentStats, ItemStats, MatchScope, Multikills};
use crate::db_row;
use crate::op_score::js_round;

/// `FromRow` for a type declared elsewhere, one column per field. A field
/// reads the column it is named for, or the one after `=`.
macro_rules! from_row {
    (@col $field:ident) => { stringify!($field) };
    (@col $field:ident $col:literal) => { $col };
    ($ty:ty { $($field:ident $(= $col:literal)?),* $(,)? }) => {
        impl FromRow for $ty {
            const COLUMNS: &'static [&'static str] = &[$(from_row!(@col $field $($col)?)),*];

            #[allow(unused_assignments)]
            fn from_row(row: &rusqlite::Row<'_>, at: &[usize]) -> rusqlite::Result<Self> {
                let mut i = 0;
                Ok(Self { $($field: { let v = row.get(at[i])?; i += 1; v }),* })
            }
        }
    };
}

from_row!(ChampionStats {
    champion_id,
    games,
    wins,
    kills,
    deaths,
    assists,
    avg_kills,
    avg_deaths,
    avg_assists,
    avg_damage,
    avg_gold,
    avg_score,
    mvps,
    aces,
    double_kills,
    triple_kills,
    quadra_kills,
    penta_kills,
});
from_row!(AugmentStats {
    augment_id,
    picks,
    wins
});
from_row!(ItemStats {
    item_id,
    picks,
    wins
});
from_row!(AugmentChampionPicks {
    champion_id,
    picks,
    wins
});
from_row!(RecentFormGame { win, game_id });
from_row!(GlobalChampionRow {
    champion_id,
    games,
    wins,
    kills,
    deaths,
    assists,
    avg_damage = "avgDamage",
});
from_row!(TrendsDay {
    day,
    games,
    wins,
    kills,
    deaths,
    assists,
    score_sum,
    scored_games,
});
from_row!(TrendsPatch {
    patch,
    games,
    wins,
    avg_score,
    first_played,
});
from_row!(TrendsHour { hour, games, wins });
from_row!(TrendsWeekday {
    weekday,
    games,
    wins
});

/// Poro-Snax (base and upgraded) is handed out for free, so it skews item
/// stats.
const EXCLUDED_ITEM_IDS: [i64; 2] = [2052, 220013];

/// `EXCLUDED_ITEMS_SQL`.
pub fn excluded_items_sql() -> String {
    EXCLUDED_ITEM_IDS.map(|id| id.to_string()).join(", ")
}

/// item0..item6 on both player_stats and match_participants; slot 6 is the
/// trinket.
pub const ITEM_SLOTS: [usize; 7] = [0, 1, 2, 3, 4, 5, 6];

/// `itemSlotUnion`: the seven item slots are columns, and every item stat
/// wants them as rows. `row` builds one slot's SELECT; the caller's params
/// repeat once per slot.
pub fn item_slot_union(row: impl Fn(usize) -> String) -> String {
    ITEM_SLOTS.map(row).join("\n        UNION ALL\n        ")
}

/// `if (patch)`: an empty string filters nothing.
fn given(text: Option<&str>) -> Option<&str> {
    text.filter(|t| !t.is_empty())
}

fn not_remade() -> Where {
    Where {
        conditions: vec!["g.is_remake = 0".into()],
        params: Vec::new(),
    }
}

fn push_patch(w: &mut Where, patch: Option<&str>, alias: &str) {
    if let Some(patch) = given(patch) {
        w.conditions.push(format!("{alias}.game_version = ?"));
        w.params.push(Sql::Text(patch.into()));
    }
}

fn joined(w: &Where) -> String {
    w.conditions.join(" AND ")
}

/// `getChampionStatsAll`.
pub fn get_champion_stats_all(
    conn: &Connection,
    patch: Option<&str>,
    queue: Option<i64>,
    season: Option<&str>,
) -> rusqlite::Result<Vec<ChampionStats>> {
    let mut w = not_remade();
    push_patch(&mut w, patch, "g");
    apply_queue_filter(conn, &mut w, queue, "g")?;
    apply_season_filter(&mut w, season, "g");
    let sql = format!(
        "
    SELECT
      ps.champion_id,
      COUNT(*) as games,
      SUM(ps.win) as wins,
      SUM(ps.kills) as kills,
      SUM(ps.deaths) as deaths,
      SUM(ps.assists) as assists,
      ROUND(AVG(ps.kills), 1) as avg_kills,
      ROUND(AVG(ps.deaths), 1) as avg_deaths,
      ROUND(AVG(ps.assists), 1) as avg_assists,
      ROUND(AVG(ps.total_damage_dealt)) as avg_damage,
      ROUND(AVG(ps.gold_earned)) as avg_gold,
      ROUND(AVG(ps.score), 1) as avg_score,
      SUM(CASE WHEN ps.score_badge = 'MVP' THEN 1 ELSE 0 END) as mvps,
      SUM(CASE WHEN ps.score_badge = 'ACE' THEN 1 ELSE 0 END) as aces,
      SUM(ps.double_kills) as double_kills,
      SUM(ps.triple_kills) as triple_kills,
      SUM(ps.quadra_kills) as quadra_kills,
      SUM(ps.penta_kills) as penta_kills
    FROM player_stats ps
    JOIN games g ON ps.game_id = g.game_id
    WHERE {}
    GROUP BY ps.champion_id
    ORDER BY games DESC
  ",
        joined(&w)
    );
    stmt::all(conn, &sql, params_from_iter(&w.params))
}

/// `getAugmentStatsAll`. Electron tests `championId !== undefined`; a
/// command argument cannot tell `null` from absent, and the renderer only
/// ever passes a number.
pub fn get_augment_stats_all(
    conn: &Connection,
    champion_id: Option<i64>,
    patch: Option<&str>,
    queue: Option<i64>,
    season: Option<&str>,
) -> rusqlite::Result<Vec<AugmentStats>> {
    let mut w = not_remade();
    if let Some(id) = champion_id {
        w.conditions.push("ps.champion_id = ?".into());
        w.params.push(Sql::Integer(id));
    }
    push_patch(&mut w, patch, "g");
    apply_queue_filter(conn, &mut w, queue, "g")?;
    apply_season_filter(&mut w, season, "g");
    let sql = format!(
        "
    SELECT ga.augment_id, COUNT(*) as picks, SUM(ps.win) as wins
    FROM game_augments ga
    JOIN player_stats ps ON ga.game_id = ps.game_id
    JOIN games g ON ga.game_id = g.game_id
    WHERE {}
    GROUP BY ga.augment_id
    ORDER BY picks DESC
  ",
        joined(&w)
    );
    stmt::all(conn, &sql, params_from_iter(&w.params))
}

db_row! {
    #[allow(non_snake_case)]
    struct DashboardTotals {
        totalGames: Option<i64>,
        totalDuration: Option<Num>,
        wins: Option<Num>,
        totalKills: Option<Num>,
        totalDeaths: Option<Num>,
        totalAssists: Option<Num>,
        doubles: Option<Num>,
        triples: Option<Num>,
        quadras: Option<Num>,
        pentas: Option<Num>,
        avgScore: Option<f64>,
        mvps: Option<Num>,
        aces: Option<Num>,
        scoredWins: Option<Num>,
        scoredLosses: Option<Num>,
        accounts: Option<i64>,
    }
}

/// `getDashboardData`.
pub fn get_dashboard_data(
    conn: &Connection,
    filters: Option<&MatchScope>,
) -> rusqlite::Result<DashboardData> {
    let f = filters.cloned().unwrap_or_default();
    let mut w = not_remade();
    if let Some(id) = f.champion_id {
        w.conditions.push("ps.champion_id = ?".into());
        w.params.push(Sql::Integer(id));
    }
    if let Some(account) = given(f.account.as_deref()) {
        w.conditions.push("g.puuid = ?".into());
        w.params.push(Sql::Text(account.into()));
    }
    push_patch(&mut w, f.patch.as_deref(), "g");
    apply_queue_filter(conn, &mut w, f.queue, "g")?;
    apply_season_filter(&mut w, f.season.as_deref(), "g");
    let where_sql = format!("WHERE {}", joined(&w));

    let totals: DashboardTotals = stmt::first(
        conn,
        &format!(
            "
    SELECT COUNT(*) as totalGames,
           SUM(g.game_duration) as totalDuration,
           SUM(ps.win) as wins,
           SUM(ps.kills) as totalKills,
           SUM(ps.deaths) as totalDeaths,
           SUM(ps.assists) as totalAssists,
           SUM(ps.double_kills) as doubles,
           SUM(ps.triple_kills) as triples,
           SUM(ps.quadra_kills) as quadras,
           SUM(ps.penta_kills) as pentas,
           AVG(ps.score) as avgScore,
           SUM(CASE WHEN ps.score_badge = 'MVP' THEN 1 ELSE 0 END) as mvps,
           SUM(CASE WHEN ps.score_badge = 'ACE' THEN 1 ELSE 0 END) as aces,
           SUM(CASE WHEN ps.score IS NOT NULL AND ps.win = 1 THEN 1 ELSE 0 END) as scoredWins,
           SUM(CASE WHEN ps.score IS NOT NULL AND ps.win = 0 THEN 1 ELSE 0 END) as scoredLosses,
           COUNT(DISTINCT NULLIF(g.puuid, '')) as accounts
    FROM player_stats ps
    JOIN games g ON ps.game_id = g.game_id
    {where_sql}
  "
        ),
        params_from_iter(&w.params),
    )?
    .ok_or(rusqlite::Error::QueryReturnedNoRows)?;

    let recent_form = stmt::all(
        conn,
        &format!(
            "
    SELECT ps.win, g.game_id
    FROM games g
    JOIN player_stats ps ON g.game_id = ps.game_id
    {where_sql}
    ORDER BY g.game_creation DESC
    LIMIT 10
  "
        ),
        params_from_iter(&w.params),
    )?;

    let n = |v: Option<Num>| v.unwrap_or_default();
    Ok(DashboardData {
        total_games: totals.totalGames.unwrap_or(0),
        total_duration: n(totals.totalDuration),
        wins: n(totals.wins),
        total_kills: n(totals.totalKills),
        total_deaths: n(totals.totalDeaths),
        total_assists: n(totals.totalAssists),
        avg_score: totals.avgScore,
        mvps: n(totals.mvps),
        aces: n(totals.aces),
        scored_wins: n(totals.scoredWins),
        scored_losses: n(totals.scoredLosses),
        accounts: totals.accounts.unwrap_or(0),
        recent_form,
        multikills: Multikills {
            doubles: n(totals.doubles),
            triples: n(totals.triples),
            quadras: n(totals.quadras),
            pentas: n(totals.pentas),
        },
    })
}

db_row! {
    struct AugmentChampionRow {
        augment_id: i64,
        champion_id: i64,
        picks: i64,
        wins: Num,
    }
}

db_row! {
    #[allow(non_snake_case)]
    struct TotalGames { totalGames: i64 }
}

/// `getAugmentStatsWithChampions`.
pub fn get_augment_stats_with_champions(
    conn: &Connection,
    patch: Option<&str>,
    queue: Option<i64>,
    season: Option<&str>,
) -> rusqlite::Result<AugmentStatsDetailedResult> {
    let mut w = not_remade();
    push_patch(&mut w, patch, "g");
    apply_queue_filter(conn, &mut w, queue, "g")?;
    apply_season_filter(&mut w, season, "g");
    let where_sql = joined(&w);

    let augments: Vec<AugmentStats> = stmt::all(
        conn,
        &format!(
            "
    SELECT ga.augment_id, COUNT(*) as picks, SUM(ps.win) as wins
    FROM game_augments ga
    JOIN player_stats ps ON ga.game_id = ps.game_id
    JOIN games g ON ga.game_id = g.game_id
    WHERE {where_sql}
    GROUP BY ga.augment_id
    ORDER BY picks DESC
  "
        ),
        params_from_iter(&w.params),
    )?;

    let breakdown: Vec<AugmentChampionRow> = stmt::all(
        conn,
        &format!(
            "
    SELECT ga.augment_id, ps.champion_id, COUNT(*) as picks, SUM(ps.win) as wins
    FROM game_augments ga
    JOIN player_stats ps ON ga.game_id = ps.game_id
    JOIN games g ON ga.game_id = g.game_id
    WHERE {where_sql}
    GROUP BY ga.augment_id, ps.champion_id
    ORDER BY picks DESC
  "
        ),
        params_from_iter(&w.params),
    )?;
    let mut by_augment: HashMap<i64, Vec<AugmentChampionPicks>> = HashMap::new();
    for row in breakdown {
        by_augment
            .entry(row.augment_id)
            .or_default()
            .push(AugmentChampionPicks {
                champion_id: row.champion_id,
                picks: row.picks,
                wins: row.wins,
            });
    }

    let TotalGames { totalGames } = stmt::first(
        conn,
        &format!(
            "
    SELECT COUNT(*) as totalGames
    FROM player_stats ps
    JOIN games g ON ps.game_id = g.game_id
    WHERE {where_sql}
  "
        ),
        params_from_iter(&w.params),
    )?
    .ok_or(rusqlite::Error::QueryReturnedNoRows)?;

    Ok(AugmentStatsDetailedResult {
        total_games: totalGames,
        augments: augments
            .into_iter()
            .map(|a| AugmentStatsDetailed {
                champions: by_augment.remove(&a.augment_id).unwrap_or_default(),
                augment_id: a.augment_id,
                picks: a.picks,
                wins: a.wins,
            })
            .collect(),
    })
}

/// `getChampionItemStats`.
pub fn get_champion_item_stats(
    conn: &Connection,
    champion_id: i64,
    patch: Option<&str>,
    queue: Option<i64>,
    season: Option<&str>,
) -> rusqlite::Result<Vec<ItemStats>> {
    let mut extra = Where::default();
    push_patch(&mut extra, patch, "g");
    apply_queue_filter(conn, &mut extra, queue, "g")?;
    apply_season_filter(&mut extra, season, "g");
    let extra_sql = if extra.conditions.is_empty() {
        String::new()
    } else {
        format!(" AND {}", joined(&extra))
    };
    let excluded = excluded_items_sql();
    let union = item_slot_union(|i| {
        format!(
            "SELECT ps.item{i} as item_id, ps.win
                FROM player_stats ps JOIN games g ON ps.game_id = g.game_id
                WHERE ps.champion_id = ? AND g.is_remake = 0{extra_sql}
                  AND ps.item{i} > 0 AND ps.item{i} NOT IN ({excluded})"
        )
    });
    let params = ITEM_SLOTS.iter().flat_map(|_| {
        std::iter::once(Sql::Integer(champion_id)).chain(extra.params.iter().cloned())
    });
    stmt::all(
        conn,
        &format!(
            "
    SELECT item_id, COUNT(*) as picks, SUM(win) as wins
    FROM (
        {union}
    )
    GROUP BY item_id
    ORDER BY picks DESC
  "
        ),
        params_from_iter(params),
    )
}

/// `participantFilter`: is_remake, queue_id and game_version are carried on
/// the participant rows themselves, so nothing has to join back to games.
fn participant_filter(
    conn: &Connection,
    patch: Option<&str>,
    queue: Option<i64>,
    alias: &str,
) -> rusqlite::Result<Where> {
    let mut w = Where {
        conditions: vec![format!("{alias}.is_remake = 0")],
        params: Vec::new(),
    };
    push_patch(&mut w, patch, alias);
    apply_queue_filter(conn, &mut w, queue, alias)?;
    Ok(w)
}

db_row! {
    struct Count { count: i64 }
}

fn participant_slots(conn: &Connection, mp: &Where) -> rusqlite::Result<i64> {
    let slots: Count = stmt::first(
        conn,
        &format!(
            "
      SELECT COUNT(*) as count
      FROM match_participants mp
      WHERE {} AND mp.champion_id > 0
    ",
            joined(mp)
        ),
        params_from_iter(&mp.params),
    )?
    .ok_or(rusqlite::Error::QueryReturnedNoRows)?;
    Ok(slots.count)
}

/// `getGlobalStats`.
pub fn get_global_stats(
    conn: &Connection,
    patch: Option<&str>,
    queue: Option<i64>,
) -> rusqlite::Result<GlobalStats> {
    let mp = participant_filter(conn, patch, queue, "mp")?;
    let mpa = participant_filter(conn, patch, queue, "mpa")?;
    let mp_sql = joined(&mp);

    let champions = stmt::all(
        conn,
        &format!(
            "
      SELECT mp.champion_id, COUNT(*) as games, SUM(mp.win) as wins,
             SUM(mp.kills) as kills, SUM(mp.deaths) as deaths, SUM(mp.assists) as assists,
             CAST(ROUND(AVG(mp.total_damage_dealt)) AS INTEGER) as avgDamage
      FROM match_participants mp
      WHERE {mp_sql} AND mp.champion_id > 0
      GROUP BY mp.champion_id
      ORDER BY games DESC
    "
        ),
        params_from_iter(&mp.params),
    )?;

    let augments = stmt::all(
        conn,
        &format!(
            "
      SELECT mpa.augment_id, COUNT(*) as picks, SUM(mpa.win) as wins
      FROM match_participant_augments mpa
      WHERE {}
      GROUP BY mpa.augment_id
      ORDER BY picks DESC
    ",
            joined(&mpa)
        ),
        params_from_iter(&mpa.params),
    )?;

    let excluded = excluded_items_sql();
    let union = item_slot_union(|i| {
        format!(
            "SELECT mp.item{i} as item_id, mp.win as win
                FROM match_participants mp
                WHERE {mp_sql}
                  AND mp.item{i} > 0 AND mp.item{i} NOT IN ({excluded})"
        )
    });
    let items = stmt::all(
        conn,
        &format!(
            "
      SELECT item_id, COUNT(*) as picks, SUM(win) as wins
      FROM (
        {union}
      )
      GROUP BY item_id
      ORDER BY picks DESC
    "
        ),
        params_from_iter(ITEM_SLOTS.iter().flat_map(|_| mp.params.iter())),
    )?;

    Ok(GlobalStats {
        champions,
        augments,
        items,
        total_participant_slots: participant_slots(conn, &mp)?,
    })
}

db_row! {
    #[allow(non_snake_case)]
    struct ChampionTotals {
        games: i64,
        wins: Option<Num>,
        kills: Option<Num>,
        deaths: Option<Num>,
        assists: Option<Num>,
        damage: Option<f64>,
        damageTaken: Option<f64>,
        gold: Option<f64>,
        heal: Option<f64>,
        doubleKills: Option<Num>,
        tripleKills: Option<Num>,
        quadraKills: Option<Num>,
        pentaKills: Option<Num>,
        damageShare: Option<f64>,
        killParticipation: Option<f64>,
    }
}

/// `getGlobalChampionDetail`: one champion across every stored game,
/// counting all ten players in each game.
pub fn get_global_champion_detail(
    conn: &Connection,
    champion_id: i64,
    patch: Option<&str>,
    queue: Option<i64>,
) -> rusqlite::Result<GlobalChampionDetail> {
    let mp = participant_filter(conn, patch, queue, "mp")?;
    let mpa = participant_filter(conn, patch, queue, "mpa")?;
    let mp_sql = joined(&mp);
    let champion = Sql::Integer(champion_id);

    let totals: ChampionTotals = stmt::first(
        conn,
        &format!(
            "
      WITH teams AS (
        SELECT mp.game_id, mp.team_id,
               SUM(mp.total_damage_dealt) as team_damage,
               SUM(mp.kills) as team_kills
        FROM match_participants mp
        WHERE {mp_sql}
        GROUP BY mp.game_id, mp.team_id
      )
      SELECT COUNT(*) as games,
             SUM(mp.win) as wins,
             SUM(mp.kills) as kills,
             SUM(mp.deaths) as deaths,
             SUM(mp.assists) as assists,
             SUM(mp.total_damage_dealt) as damage,
             SUM(mp.total_damage_taken) as damageTaken,
             SUM(mp.gold_earned) as gold,
             SUM(mp.total_heal) as heal,
             SUM(mp.double_kills) as doubleKills,
             SUM(mp.triple_kills) as tripleKills,
             SUM(mp.quadra_kills) as quadraKills,
             SUM(mp.penta_kills) as pentaKills,
             AVG(CASE WHEN t.team_damage > 0
                      THEN mp.total_damage_dealt * 1.0 / t.team_damage END) as damageShare,
             AVG(CASE WHEN t.team_kills > 0
                      THEN (mp.kills + mp.assists) * 1.0 / t.team_kills END) as killParticipation
      FROM match_participants mp
      JOIN teams t ON t.game_id = mp.game_id AND t.team_id = mp.team_id
      WHERE {mp_sql} AND mp.champion_id = ?
    "
        ),
        params_from_iter(
            mp.params
                .iter()
                .chain(&mp.params)
                .chain(std::iter::once(&champion)),
        ),
    )?
    .ok_or(rusqlite::Error::QueryReturnedNoRows)?;

    let total_participant_slots = participant_slots(conn, &mp)?;

    let excluded = excluded_items_sql();
    let union = item_slot_union(|i| {
        format!(
            "SELECT mp.item{i} as item_id, mp.win as win
                FROM match_participants mp
                WHERE {mp_sql} AND mp.champion_id = ?
                  AND mp.item{i} > 0 AND mp.item{i} NOT IN ({excluded})"
        )
    });
    let items = stmt::all(
        conn,
        &format!(
            "
      SELECT item_id, COUNT(*) as picks, SUM(win) as wins
      FROM (
        {union}
      )
      GROUP BY item_id
      ORDER BY picks DESC
    "
        ),
        params_from_iter(
            ITEM_SLOTS
                .iter()
                .flat_map(|_| mp.params.iter().chain(std::iter::once(&champion))),
        ),
    )?;

    let augments = stmt::all(
        conn,
        &format!(
            "
      SELECT mpa.augment_id, COUNT(*) as picks, SUM(mpa.win) as wins
      FROM match_participant_augments mpa
      WHERE {} AND mpa.champion_id = ?
      GROUP BY mpa.augment_id
      ORDER BY picks DESC
    ",
            joined(&mpa)
        ),
        params_from_iter(mpa.params.iter().chain(std::iter::once(&champion))),
    )?;

    let games = totals.games;
    // `games > 0 ? Math.round((total ?? 0) / games) : 0`, on JavaScript numbers
    let avg = |total: Option<f64>| {
        if games > 0 {
            js_round(total.unwrap_or(0.0) / games as f64)
        } else {
            0.0
        }
    };
    let n = |v: Option<Num>| v.unwrap_or_default();

    Ok(GlobalChampionDetail {
        champion_id,
        games,
        wins: n(totals.wins),
        kills: n(totals.kills),
        deaths: n(totals.deaths),
        assists: n(totals.assists),
        avg_damage: avg(totals.damage),
        avg_damage_taken: avg(totals.damageTaken),
        avg_gold: avg(totals.gold),
        avg_heal: avg(totals.heal),
        damage_share: totals.damageShare.unwrap_or(0.0),
        kill_participation: totals.killParticipation.unwrap_or(0.0),
        double_kills: n(totals.doubleKills),
        triple_kills: n(totals.tripleKills),
        quadra_kills: n(totals.quadraKills),
        penta_kills: n(totals.pentaKills),
        total_participant_slots,
        items,
        augments,
    })
}

/// `getTrendsData`: everything the Trends page draws, in one round trip,
/// all in local time.
pub fn get_trends_data(conn: &Connection, queue: Option<i64>) -> rusqlite::Result<TrendsData> {
    let mut w = not_remade();
    apply_queue_filter(conn, &mut w, queue, "g")?;
    let where_sql = format!("WHERE {}", joined(&w));
    let from_sql = "FROM games g JOIN player_stats ps ON g.game_id = ps.game_id";
    let params = || params_from_iter(&w.params);

    let daily = stmt::all(
        conn,
        &format!(
            "
      SELECT date(g.game_creation / 1000, 'unixepoch', 'localtime') as day,
             COUNT(*) as games,
             SUM(ps.win) as wins,
             SUM(ps.kills) as kills,
             SUM(ps.deaths) as deaths,
             SUM(ps.assists) as assists,
             SUM(ps.score) as score_sum,
             COUNT(ps.score) as scored_games
      {from_sql}
      {where_sql}
      GROUP BY day
      ORDER BY day
    "
        ),
        params(),
    )?;

    let patches = stmt::all(
        conn,
        &format!(
            "
      SELECT g.game_version as patch,
             COUNT(*) as games,
             SUM(ps.win) as wins,
             AVG(ps.score) as avg_score,
             MIN(g.game_creation) as first_played
      {from_sql}
      {where_sql} AND g.game_version IS NOT NULL AND g.game_version != ''
      GROUP BY g.game_version
      ORDER BY first_played
    "
        ),
        params(),
    )?;

    let hours = stmt::all(
        conn,
        &format!(
            "
      SELECT CAST(strftime('%H', g.game_creation / 1000, 'unixepoch', 'localtime') AS INTEGER) as hour,
             COUNT(*) as games,
             SUM(ps.win) as wins
      {from_sql}
      {where_sql}
      GROUP BY hour
      ORDER BY hour
    "
        ),
        params(),
    )?;

    let weekdays = stmt::all(
        conn,
        &format!(
            "
      SELECT CAST(strftime('%w', g.game_creation / 1000, 'unixepoch', 'localtime') AS INTEGER) as weekday,
             COUNT(*) as games,
             SUM(ps.win) as wins
      {from_sql}
      {where_sql}
      GROUP BY weekday
      ORDER BY weekday
    "
        ),
        params(),
    )?;

    Ok(TrendsData {
        daily,
        patches,
        hours,
        weekdays,
    })
}

/// Replays every T05 golden for the nine stats and records channels against
/// these queries on a copy of the fixture, comparing each number by its f64
/// bits. `golden.rs` compares through `serde_json`, whose default float
/// parse may land one ulp off, so it cannot tell two neighbouring doubles
/// apart; this harness parses numbers with the correctly rounded `str::parse`.
///
/// `BMT_GOLDEN_DIR` and `BMT_GOLDEN_DATA` name the goldens and the fixture,
/// as for `golden.rs`, and the goldens were recorded under
/// `TZ=America/New_York`. Without them the test reports a skip.
#[cfg(test)]
mod golden_tests {
    use std::collections::BTreeMap;
    use std::path::{Path, PathBuf};

    use serde_json::Value;

    use super::*;
    use crate::db::records::get_records;
    use crate::db::settings::{is_renderer_setting, set_setting};
    use crate::db::{DB_FILE, Database};

    const CHANNELS: [&str; 9] = [
        "db:champion-stats",
        "db:augment-stats",
        "db:augment-stats-detailed",
        "db:dashboard",
        "db:champion-item-stats",
        "db:global-stats",
        "db:global-champion-detail",
        "db:trends",
        "db:records",
    ];
    /// A write group may set a setting before its stats calls.
    const SET_SETTING: &str = "settings:set";

    /// JSON with every number as its exact f64 bits and keys sorted.
    #[derive(Debug, PartialEq)]
    enum Exact {
        Null,
        Bool(bool),
        Num(u64),
        Str(String),
        Arr(Vec<Exact>),
        Obj(BTreeMap<String, Exact>),
    }

    struct Parser<'a> {
        s: &'a [u8],
        i: usize,
    }

    impl Parser<'_> {
        fn ws(&mut self) {
            while self.s.get(self.i).is_some_and(u8::is_ascii_whitespace) {
                self.i += 1;
            }
        }

        fn eat(&mut self, c: u8) {
            self.ws();
            assert_eq!(
                self.s[self.i], c,
                "JSON: expected {} at {}",
                c as char, self.i
            );
            self.i += 1;
        }

        fn string(&mut self) -> String {
            self.eat(b'"');
            let mut out = String::new();
            loop {
                let c = self.s[self.i];
                self.i += 1;
                match c {
                    b'"' => return out,
                    b'\\' => {
                        let e = self.s[self.i];
                        self.i += 1;
                        match e {
                            b'u' => {
                                let hex = std::str::from_utf8(&self.s[self.i..self.i + 4]).unwrap();
                                self.i += 4;
                                let unit = u16::from_str_radix(hex, 16).unwrap();
                                out.push(char::from_u32(unit.into()).unwrap_or('\u{fffd}'));
                            }
                            b'n' => out.push('\n'),
                            b't' => out.push('\t'),
                            b'r' => out.push('\r'),
                            b'b' => out.push('\u{8}'),
                            b'f' => out.push('\u{c}'),
                            other => out.push(other as char),
                        }
                    }
                    _ => {
                        let start = self.i - 1;
                        let mut end = self.i;
                        while !matches!(self.s[end], b'"' | b'\\') {
                            end += 1;
                        }
                        out.push_str(std::str::from_utf8(&self.s[start..end]).unwrap());
                        self.i = end;
                    }
                }
            }
        }

        fn value(&mut self) -> Exact {
            self.ws();
            match self.s[self.i] {
                b'{' => {
                    self.i += 1;
                    let mut map = BTreeMap::new();
                    self.ws();
                    if self.s[self.i] == b'}' {
                        self.i += 1;
                        return Exact::Obj(map);
                    }
                    loop {
                        let key = self.string();
                        self.eat(b':');
                        map.insert(key, self.value());
                        self.ws();
                        self.i += 1;
                        if self.s[self.i - 1] == b'}' {
                            return Exact::Obj(map);
                        }
                    }
                }
                b'[' => {
                    self.i += 1;
                    let mut items = Vec::new();
                    self.ws();
                    if self.s[self.i] == b']' {
                        self.i += 1;
                        return Exact::Arr(items);
                    }
                    loop {
                        items.push(self.value());
                        self.ws();
                        self.i += 1;
                        if self.s[self.i - 1] == b']' {
                            return Exact::Arr(items);
                        }
                    }
                }
                b'"' => Exact::Str(self.string()),
                b't' => {
                    self.i += 4;
                    Exact::Bool(true)
                }
                b'f' => {
                    self.i += 5;
                    Exact::Bool(false)
                }
                b'n' => {
                    self.i += 4;
                    Exact::Null
                }
                _ => {
                    let start = self.i;
                    while self.s.get(self.i).is_some_and(|c| {
                        matches!(c, b'-' | b'+' | b'.' | b'e' | b'E' | b'0'..=b'9')
                    }) {
                        self.i += 1;
                    }
                    let text = std::str::from_utf8(&self.s[start..self.i]).unwrap();
                    let n: f64 = text
                        .parse()
                        .unwrap_or_else(|_| panic!("JSON number {text}"));
                    Exact::Num(n.to_bits())
                }
            }
        }
    }

    fn exact(text: &str) -> Exact {
        Parser {
            s: text.as_bytes(),
            i: 0,
        }
        .value()
    }

    struct Case {
        channel: String,
        case: String,
        group: String,
        seq: i64,
        args: Vec<Value>,
        /// The golden file's `outcome.result`, as text.
        result: String,
    }

    fn read_cases(dir: &Path) -> Vec<Case> {
        let mut out = Vec::new();
        for channel in CHANNELS.iter().chain([&SET_SETTING]) {
            let folder = dir.join("ipc").join(channel.replace(':', "."));
            let files = match std::fs::read_dir(&folder) {
                Ok(files) => files,
                Err(_) if channel == &SET_SETTING => continue,
                Err(e) => panic!("no goldens for {channel} in {}: {e}", folder.display()),
            };
            let mut found = 0;
            for file in files.map(|file| file.unwrap()) {
                found += 1;
                let text = std::fs::read_to_string(file.path()).unwrap();
                let golden: Value = serde_json::from_str(&text).unwrap();
                let channel = golden["channel"].as_str().unwrap();
                let result = if channel == SET_SETTING {
                    "null".into()
                } else {
                    assert_eq!(
                        golden["outcome"]["kind"],
                        "value",
                        "{}",
                        file.path().display()
                    );
                    // The result's own text, so its numbers are parsed only once, exactly
                    let start = text.find("\"result\":").unwrap() + "\"result\":".len();
                    let mut p = Parser {
                        s: text.as_bytes(),
                        i: start,
                    };
                    p.value();
                    text[start..p.i].to_owned()
                };
                out.push(Case {
                    channel: golden["channel"].as_str().unwrap().into(),
                    case: golden["case"].as_str().unwrap().into(),
                    group: golden["group"].as_str().unwrap().into(),
                    seq: golden["seq"].as_i64().unwrap(),
                    args: golden["args"].as_array().unwrap().clone(),
                    result,
                });
            }
            assert!(
                found > 0 || channel == &SET_SETTING,
                "{} holds no goldens",
                folder.display()
            );
        }
        out.sort_by(|a, b| (&a.group, a.seq).cmp(&(&b.group, b.seq)));
        out
    }

    fn text(args: &[Value], i: usize) -> Option<String> {
        args.get(i).and_then(Value::as_str).map(str::to_owned)
    }

    fn int(args: &[Value], i: usize) -> Option<i64> {
        args.get(i).and_then(Value::as_i64)
    }

    fn run(conn: &Connection, case: &Case) -> rusqlite::Result<Value> {
        let a = &case.args;
        fn json(v: impl serde::Serialize) -> Value {
            serde_json::to_value(v).unwrap()
        }
        Ok(match case.channel.as_str() {
            "db:champion-stats" => json(get_champion_stats_all(
                conn,
                text(a, 0).as_deref(),
                int(a, 1),
                text(a, 2).as_deref(),
            )?),
            "db:augment-stats" => json(get_augment_stats_all(
                conn,
                int(a, 0),
                text(a, 1).as_deref(),
                int(a, 2),
                text(a, 3).as_deref(),
            )?),
            "db:augment-stats-detailed" => json(get_augment_stats_with_champions(
                conn,
                text(a, 0).as_deref(),
                int(a, 1),
                text(a, 2).as_deref(),
            )?),
            "db:dashboard" => {
                let scope: Option<MatchScope> = a
                    .first()
                    .filter(|v| !v.is_null())
                    .map(|v| serde_json::from_value(v.clone()).unwrap());
                json(get_dashboard_data(conn, scope.as_ref())?)
            }
            "db:champion-item-stats" => json(get_champion_item_stats(
                conn,
                int(a, 0).unwrap(),
                text(a, 1).as_deref(),
                int(a, 2),
                text(a, 3).as_deref(),
            )?),
            "db:global-stats" => json(get_global_stats(conn, text(a, 0).as_deref(), int(a, 1))?),
            "db:global-champion-detail" => json(get_global_champion_detail(
                conn,
                int(a, 0).unwrap(),
                text(a, 1).as_deref(),
                int(a, 2),
            )?),
            "db:trends" => json(get_trends_data(conn, int(a, 0))?),
            "db:records" => json(get_records(conn, int(a, 0), text(a, 1))?),
            SET_SETTING => {
                let key = text(a, 0).unwrap();
                if is_renderer_setting(&key) {
                    set_setting(conn, &key, &text(a, 1).unwrap())?;
                }
                Value::Null
            }
            other => panic!("no runner for {other}"),
        })
    }

    fn fresh_copy(data: &Path, scratch: &Path, group: &str) -> PathBuf {
        let dir = scratch.join(group);
        std::fs::create_dir_all(&dir).unwrap();
        for name in [DB_FILE, "matches.db-wal"] {
            let from = data.join("data").join(name);
            if from.exists() {
                std::fs::copy(&from, dir.join(name)).unwrap();
            }
        }
        dir
    }

    #[test]
    #[should_panic(expected = "no goldens for db:champion-stats")]
    fn a_missing_channel_folder_fails_the_replay() {
        let dir = std::env::temp_dir().join(format!("bmt-t14-empty-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("ipc")).unwrap();
        read_cases(&dir);
    }

    #[test]
    #[should_panic(expected = "holds no goldens")]
    fn an_empty_channel_folder_fails_the_replay() {
        let dir = std::env::temp_dir().join(format!("bmt-t14-hollow-{}", std::process::id()));
        for channel in CHANNELS {
            std::fs::create_dir_all(dir.join("ipc").join(channel.replace(':', "."))).unwrap();
        }
        read_cases(&dir);
    }

    #[test]
    fn the_comparison_tells_neighbouring_doubles_apart() {
        let next = f64::from_bits(0.1f64.to_bits() + 1);
        assert_eq!(next.to_string(), "0.10000000000000002");
        assert_ne!(exact("[0.1]"), exact("[0.10000000000000002]"));
        assert_eq!(
            exact(r#"{"b": 3, "a": ["x\"y", null, 1e3]}"#),
            exact(r#"{"a":["x\"y",null,1000.0],"b":3.0}"#)
        );
    }

    fn method_channel(method: &str) -> &'static str {
        match method {
            "getChampionStats" => "db:champion-stats",
            "getAugmentStats" => "db:augment-stats",
            "getAugmentStatsDetailed" => "db:augment-stats-detailed",
            "getDashboard" => "db:dashboard",
            "getChampionItemStats" => "db:champion-item-stats",
            "getGlobalStats" => "db:global-stats",
            "getGlobalChampionDetail" => "db:global-champion-detail",
            "getTrends" => "db:trends",
            "getRecords" => "db:records",
            other => panic!("{other} is not a stats method"),
        }
    }

    /// Every call `parity/t14/record-hostile.ts` made against a fixture copy
    /// whose `INTEGER` columns hold fractions, replayed on the same copy and
    /// compared by bits. Needs `BMT_T14_HOSTILE` and `BMT_GOLDEN_DATA`, and
    /// `TZ` as the recording ran.
    #[test]
    fn hostile_fixture_matches_electron_to_the_bit() {
        let (Some(hostile), Some(data)) = (
            std::env::var_os("BMT_T14_HOSTILE").map(PathBuf::from),
            std::env::var_os("BMT_GOLDEN_DATA").map(PathBuf::from),
        ) else {
            eprintln!(
                "skipped: set BMT_T14_HOSTILE and BMT_GOLDEN_DATA to replay the hostile calls"
            );
            return;
        };
        let recording: Value =
            serde_json::from_str(&std::fs::read_to_string(hostile).unwrap()).unwrap();
        let scratch = std::env::temp_dir().join(format!("bmt-t14-hostile-{}", std::process::id()));
        let dir = fresh_copy(&data, &scratch, "hostile");
        Connection::open(dir.join(DB_FILE))
            .unwrap()
            .execute_batch(recording["sql"].as_str().unwrap())
            .unwrap();
        let db = Database::open(&dir, 0).unwrap();
        let mut failures = Vec::new();
        let cases = recording["cases"].as_array().unwrap();
        for (i, recorded) in cases.iter().enumerate() {
            let method = recorded["method"].as_str().unwrap();
            let case = Case {
                channel: method_channel(method).into(),
                case: format!("{method} {i}"),
                group: "hostile".into(),
                seq: i as i64,
                args: recorded["args"].as_array().unwrap().clone(),
                result: String::new(),
            };
            let want = recorded["result"]
                .as_str()
                .unwrap()
                .strip_prefix("ok:")
                .unwrap_or_else(|| panic!("Electron failed {method}: {}", recorded["result"]));
            let got = db.with(|conn| run(conn, &case)).unwrap();
            if exact(&serde_json::to_string(&got).unwrap()) != exact(want) {
                failures.push(format!("{method} {}", recorded["args"]));
            }
        }
        db.close();
        std::fs::remove_dir_all(&scratch).ok();
        eprintln!(
            "{} hostile calls checked to the bit, {} differ",
            cases.len(),
            failures.len()
        );
        assert!(failures.is_empty(), "differ: {failures:#?}");
    }

    #[test]
    fn every_stats_golden_matches_to_the_bit() {
        let (Some(dir), Some(data)) = (
            std::env::var_os("BMT_GOLDEN_DIR").map(PathBuf::from),
            std::env::var_os("BMT_GOLDEN_DATA").map(PathBuf::from),
        ) else {
            eprintln!(
                "skipped: set BMT_GOLDEN_DIR and BMT_GOLDEN_DATA to replay the stats goldens"
            );
            return;
        };
        let mut cases = read_cases(&dir);
        // A `state` case answers a page state seeded with its own games, not the fixture
        let states = cases.iter().filter(|c| c.group == "state").count();
        cases.retain(|c| c.group != "state");
        eprintln!("{states} state goldens left to the state replay");
        assert!(!cases.is_empty(), "no stats goldens in {}", dir.display());
        let scratch = std::env::temp_dir().join(format!("bmt-t14-golden-{}", std::process::id()));
        let mut groups: BTreeMap<&str, Vec<&Case>> = BTreeMap::new();
        for case in &cases {
            groups.entry(&case.group).or_default().push(case);
        }
        let mut failures = Vec::new();
        let mut checked = 0;
        for (group, cases) in groups {
            let db = Database::open(&fresh_copy(&data, &scratch, group), 0).unwrap();
            for case in cases {
                let got = db.with(|conn| run(conn, case)).unwrap();
                if case.channel == SET_SETTING {
                    continue;
                }
                checked += 1;
                let got_text = serde_json::to_string(&got).unwrap();
                if exact(&got_text) != exact(&case.result) {
                    failures.push(format!("{} {} {}", case.channel, group, case.case));
                }
            }
            db.close();
        }
        std::fs::remove_dir_all(&scratch).ok();
        eprintln!(
            "{checked} stats goldens checked to the bit, {} differ",
            failures.len()
        );
        assert!(failures.is_empty(), "differ: {failures:#?}");
    }
}

#[cfg(test)]
mod fraction_tests {
    use super::*;
    use crate::db::records::{CareerFilter, career_rows, compute_records};
    use crate::db::schema::init_database;

    /// Two games whose `INTEGER` columns hold fractions: SQLite keeps a value
    /// that is not whole as a REAL whatever the column's affinity, and sums
    /// it as one.
    fn fractional_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        init_database(&conn, 0).unwrap();
        conn.execute_batch(
            "
            INSERT INTO games (game_id, queue_id, game_mode, game_creation, game_duration, is_remake, puuid, game_version)
            VALUES (1, 2400, 'KIWI', 1767000000000, 1500.25, 0, 'p1', '16.1.1'),
                   (2, 2400, 'KIWI', 1767100000000, 1000, 0, 'p1', '16.1.1');
            INSERT INTO player_stats (game_id, champion_id, win, kills, deaths, assists, double_kills, score)
            VALUES (1, 10, 1, 3.5, 2, 4, 1.5, 7.5),
                   (2, 10, 0.5, 2, 0, 5.25, 0, 5.0);
            ",
        )
        .unwrap();
        conn
    }

    fn json(v: impl serde::Serialize) -> String {
        serde_json::to_string(&v).unwrap()
    }

    #[test]
    fn the_dashboard_sums_fractions_as_javascript_does() {
        let conn = fractional_db();
        let data = get_dashboard_data(&conn, None).unwrap();
        assert_eq!(data.total_duration, Num(2500.25));
        assert_eq!(data.total_kills, Num(5.5));
        assert_eq!(data.wins, Num(1.5));
        assert_eq!(data.multikills.doubles, Num(1.5));
        assert_eq!(data.total_games, 2);
        let text = json(&data);
        assert!(text.contains(r#""totalDuration":2500.25"#), "{text}");
        assert!(text.contains(r#""totalDeaths":2,"#), "{text}");
    }

    #[test]
    fn champion_stats_and_trends_keep_fractions() {
        let conn = fractional_db();
        let champions = get_champion_stats_all(&conn, None, None, None).unwrap();
        assert_eq!(champions[0].kills, Num(5.5));
        assert_eq!(champions[0].assists, Num(9.25));
        let trends = get_trends_data(&conn, None).unwrap();
        assert_eq!(
            trends.daily.iter().map(|d| d.wins).collect::<Vec<_>>(),
            [Num(1.0), Num(0.5)]
        );
        assert_eq!(trends.patches[0].wins, Num(1.5));
    }

    #[test]
    fn records_read_fractions_and_rank_them() {
        let conn = fractional_db();
        let rows = career_rows(&conn, &CareerFilter::default()).unwrap();
        assert_eq!(rows[0].game_duration, Num(1500.25));
        let records = compute_records(&rows);
        let kills = records.bests.kills.unwrap();
        assert_eq!((kills.value, kills.game.game_id), (3.5, 1));
        assert_eq!(kills.game.kills, Num(3.5));
        assert_eq!(records.bests.longest_game.unwrap().value, 1500.25);
        let win_streak = records.win_streak.unwrap();
        assert_eq!((win_streak.length, win_streak.game.game_id), (1, 1));
        assert!(
            json(&get_dashboard_data(&conn, None).unwrap().recent_form).contains(r#""win":0.5"#)
        );
    }
}
