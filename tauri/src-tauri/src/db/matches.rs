//! `src/main/db/matches.ts`: the match list, its sessions and filter options,
//! one game's scoreboard, and favorites. The SQL is Electron's text, so
//! SQLite plans, orders, and sums the same rows the same way.

use std::collections::HashMap;

use rusqlite::types::{FromSql, FromSqlError, FromSqlResult, Value as Sql, ValueRef};
use rusqlite::{Connection, OptionalExtension, params_from_iter};

use super::filters::{SEASONS, Where, apply_queue_filter, apply_season_filter, hide_remakes};
use super::settings::{SESSION_GROUPING_SETTING, get_setting};
use super::stmt::{self, FromRow};
use super::summoner::{display_name, identity_from_game};
use crate::commands::matches::{
    MatchFilterOptions, MatchFilters, MatchSession, MatchSort, MatchSortDir, MultikillType,
    TrackedAccount,
};
use crate::commands::types::{
    GameAugment, GameRecord, MatchDetail, MatchListItem, MatchPage, MatchParticipantRecord,
    MatchScope, PlayerStatsRecord, ScoreBadge,
};
use crate::db_row;

/// [`FromRow`] for a struct declared elsewhere, one column per named field.
macro_rules! from_row {
    ($name:ty { $($field:ident),* $(,)? }) => {
        impl FromRow for $name {
            const COLUMNS: &'static [&'static str] = &[$(stringify!($field)),*];

            #[allow(unused_assignments)]
            fn from_row(row: &rusqlite::Row<'_>, at: &[usize]) -> rusqlite::Result<Self> {
                let mut i = 0;
                Ok(Self { $($field: { let v = row.get(at[i])?; i += 1; v }),* })
            }
        }
    };
}

impl FromSql for ScoreBadge {
    fn column_result(value: ValueRef<'_>) -> FromSqlResult<Self> {
        match value.as_str()? {
            "MVP" => Ok(ScoreBadge::Mvp),
            "ACE" => Ok(ScoreBadge::Ace),
            _ => Err(FromSqlError::InvalidType),
        }
    }
}

from_row!(MatchListItem {
    game_id,
    queue_id,
    game_creation,
    game_duration,
    is_remake,
    favorite,
    puuid,
    champion_id,
    win,
    kills,
    deaths,
    assists,
    double_kills,
    triple_kills,
    quadra_kills,
    penta_kills,
    total_damage_dealt,
    total_damage_taken,
    total_heal,
    gold_earned,
    item0,
    item1,
    item2,
    item3,
    item4,
    item5,
    score,
    score_badge,
    spell1,
    spell2,
    augment_ids,
    game_version,
    game_max_dmg,
    game_max_taken,
    game_max_heal,
});

from_row!(MatchSession {
    key,
    games,
    wins,
    losses,
    kills,
    deaths,
    assists,
    score_sum,
    scored_games
});

from_row!(GameRecord {
    game_id,
    queue_id,
    game_mode,
    game_creation,
    game_duration,
    puuid,
    game_version,
    is_remake,
    favorite,
});

from_row!(PlayerStatsRecord {
    game_id,
    champion_id,
    win,
    kills,
    deaths,
    assists,
    double_kills,
    triple_kills,
    quadra_kills,
    penta_kills,
    total_damage_dealt,
    total_damage_taken,
    gold_earned,
    total_heal,
    largest_killing_spree,
    score,
    score_raw,
    score_badge,
    spell1,
    spell2,
    item0,
    item1,
    item2,
    item3,
    item4,
    item5,
    item6,
});

from_row!(GameAugment {
    game_id,
    slot,
    augment_id
});

/// `GAME_MAX_STATS_SQL` and `MATCH_ROW_SQL`, whitespace and all.
const MATCH_ROW_SQL: &str = "
      g.game_id, g.queue_id, g.game_creation, g.game_duration, g.is_remake, g.favorite,
      g.puuid, g.game_version,
      ps.champion_id, ps.win, ps.kills, ps.deaths, ps.assists,
      ps.double_kills, ps.triple_kills, ps.quadra_kills, ps.penta_kills,
      ps.total_damage_dealt, ps.total_damage_taken, ps.total_heal, ps.gold_earned,
      ps.score, ps.score_badge, ps.spell1, ps.spell2,
      ps.item0, ps.item1, ps.item2, ps.item3, ps.item4, ps.item5,
      (SELECT GROUP_CONCAT(ga.augment_id) FROM game_augments ga
        WHERE ga.game_id = g.game_id ORDER BY ga.slot) as augment_ids,

           MAX(IFNULL((SELECT MAX(mp.total_damage_dealt) FROM match_participants mp
                        WHERE mp.game_id = g.game_id), 0), 1) as game_max_dmg,
           MAX(IFNULL((SELECT MAX(mp.total_damage_taken) FROM match_participants mp
                        WHERE mp.game_id = g.game_id), 0), 1) as game_max_taken,
           MAX(IFNULL((SELECT MAX(mp.total_heal) FROM match_participants mp
                        WHERE mp.game_id = g.game_id), 0), 1) as game_max_heal";

/// `MATCH_SORT_COLUMNS`.
fn sort_column(sort: MatchSort) -> &'static str {
    match sort {
        MatchSort::Date => "g.game_creation",
        MatchSort::Kda => "(ps.kills + ps.assists) * 1.0 / MAX(ps.deaths, 1)",
        MatchSort::Kills => "ps.kills",
        MatchSort::Duration => "g.game_duration",
        // The unclamped score, so the 10s at the top and every 0.1-rounding
        // tie below them keep their real order
        MatchSort::Score => "ps.score_raw",
        MatchSort::DamageDealt => "ps.total_damage_dealt",
        MatchSort::DamageTaken => "ps.total_damage_taken",
        MatchSort::Healing => "ps.total_heal",
    }
}

/// `matchOrderBy`.
fn match_order_by(sort: Option<MatchSort>, dir: Option<MatchSortDir>) -> String {
    let sort = sort.unwrap_or(MatchSort::Date);
    let dir = if dir == Some(MatchSortDir::Asc) {
        "ASC"
    } else {
        "DESC"
    };
    let mut parts = Vec::new();
    // Games without a score belong at the bottom whichever way the list sorts
    if sort == MatchSort::Score {
        parts.push("ps.score_raw IS NULL".to_owned());
    }
    parts.push(format!("{} {dir}", sort_column(sort)));
    if sort != MatchSort::Date {
        parts.push("g.game_creation DESC".to_owned());
    }
    parts.join(", ")
}

fn multikill_column(kind: MultikillType) -> &'static str {
    match kind {
        MultikillType::Doubles => "ps.double_kills",
        MultikillType::Triples => "ps.triple_kills",
        MultikillType::Quadras => "ps.quadra_kills",
        MultikillType::Pentas => "ps.penta_kills",
    }
}

/// JavaScript's truthiness for an optional string filter.
fn given(text: &Option<String>) -> Option<&str> {
    text.as_deref().filter(|s| !s.is_empty())
}

fn where_sql(w: &Where) -> String {
    if w.conditions.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", w.conditions.join(" AND "))
    }
}

/// `matchListWhere`: everything that decides which games are in the list,
/// shared with the session totals so a summary can't drift from the list.
fn match_list_where(conn: &Connection, filters: &MatchFilters) -> rusqlite::Result<Where> {
    let mut w = Where::default();
    if hide_remakes(conn)? {
        w.conditions.push("g.is_remake = 0".into());
    }
    if filters.favorites == Some(true) {
        w.conditions.push("g.favorite = 1".into());
    }
    if let Some(account) = given(&filters.account) {
        w.conditions.push("g.puuid = ?".into());
        w.params.push(Sql::Text(account.to_owned()));
    }
    if let Some(champion) = filters.champion_id {
        w.conditions.push("ps.champion_id = ?".into());
        w.params.push(Sql::Integer(champion));
    }
    if let Some(patch) = given(&filters.patch) {
        w.conditions.push("g.game_version = ?".into());
        w.params.push(Sql::Text(patch.to_owned()));
    }
    apply_queue_filter(conn, &mut w, filters.queue, "g")?;
    apply_season_filter(&mut w, filters.season.as_deref(), "g");
    let kinds = filters.multikills.as_deref().unwrap_or_default();
    if !kinds.is_empty() {
        let any = kinds
            .iter()
            .map(|&k| format!("{} > 0", multikill_column(k)))
            .collect::<Vec<_>>()
            .join(" OR ");
        w.conditions.push(format!("({any})"));
    }
    Ok(w)
}

/// `SessionGrouping` in `src/shared/session.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionGrouping {
    Day,
    Week,
    Patch,
    None,
}

impl SessionGrouping {
    /// `parseSessionGrouping`: anything unrecognised is the default, a day.
    pub fn parse(raw: Option<&str>) -> Self {
        match raw {
            Some("week") => Self::Week,
            Some("patch") => Self::Patch,
            Some("none") => Self::None,
            _ => Self::Day,
        }
    }
}

/// `LOCAL_SESSION_DATE`, with `DAY_START_HOUR` written in.
const LOCAL_SESSION_DATE: &str = "g.game_creation / 1000, 'unixepoch', 'localtime', '-5 hours'";

/// `sessionKeySql`. A week opens on `week_start` (0 is Sunday): 'weekday N'
/// moves on to the day that closes the week, and '-6 days' walks back to the
/// one that opens it.
fn session_key_sql(grouping: SessionGrouping, week_start: u8) -> Option<String> {
    match grouping {
        SessionGrouping::Day => Some(format!("date({LOCAL_SESSION_DATE})")),
        SessionGrouping::Week => {
            let closing_day = (week_start + 6) % 7;
            Some(format!(
                "date({LOCAL_SESSION_DATE}, 'weekday {closing_day}', '-6 days')"
            ))
        }
        SessionGrouping::Patch => Some("COALESCE(g.game_version, '')".into()),
        SessionGrouping::None => None,
    }
}

/// `getMatchSessions`: one row per session of play over every game the
/// filters match, however far the list has been scrolled. Remakes count as
/// games and nothing else.
pub fn get_match_sessions(
    conn: &Connection,
    filters: &MatchFilters,
    week_start: u8,
) -> rusqlite::Result<Vec<MatchSession>> {
    let grouping = SessionGrouping::parse(get_setting(conn, SESSION_GROUPING_SETTING)?.as_deref());
    let Some(key) = session_key_sql(grouping, week_start) else {
        return Ok(Vec::new());
    };
    let w = match_list_where(conn, filters)?;
    let sql = format!(
        "
      SELECT {key} AS key,
             COUNT(*) AS games,
             SUM(CASE WHEN g.is_remake = 0 AND ps.win = 1 THEN 1 ELSE 0 END) AS wins,
             SUM(CASE WHEN g.is_remake = 0 AND ps.win = 0 THEN 1 ELSE 0 END) AS losses,
             SUM(CASE WHEN g.is_remake = 0 THEN ps.kills ELSE 0 END) AS kills,
             SUM(CASE WHEN g.is_remake = 0 THEN ps.deaths ELSE 0 END) AS deaths,
             SUM(CASE WHEN g.is_remake = 0 THEN ps.assists ELSE 0 END) AS assists,
             SUM(CASE WHEN g.is_remake = 0 THEN ps.score END) AS score_sum,
             COUNT(CASE WHEN g.is_remake = 0 THEN ps.score END) AS scored_games
      FROM games g
      JOIN player_stats ps ON g.game_id = ps.game_id
      {}
      GROUP BY key
      ORDER BY MAX(g.game_creation) DESC
    ",
        where_sql(&w)
    );
    stmt::all(conn, &sql, params_from_iter(&w.params))
}

/// The count and one page of rows over `w`, as both match lists read them.
fn match_page(
    conn: &Connection,
    w: &Where,
    order_by: &str,
    limit: i64,
    offset: i64,
) -> rusqlite::Result<MatchPage> {
    let where_sql = where_sql(w);
    let total = conn
        .prepare_cached(&format!(
            "
    SELECT COUNT(*) as count
    FROM games g
    JOIN player_stats ps ON g.game_id = ps.game_id
    {where_sql}
  "
        ))?
        .query_row(params_from_iter(&w.params), |row| row.get(0))?;
    let page = w
        .params
        .iter()
        .cloned()
        .chain([Sql::Integer(limit), Sql::Integer(offset)]);
    let matches = stmt::all(
        conn,
        &format!(
            "
    SELECT {MATCH_ROW_SQL}
    FROM games g
    JOIN player_stats ps ON g.game_id = ps.game_id
    {where_sql}
    ORDER BY {order_by}
    LIMIT ? OFFSET ?
  "
        ),
        params_from_iter(page),
    )?;
    Ok(MatchPage { matches, total })
}

/// `getMatchHistory`.
pub fn get_match_history(
    conn: &Connection,
    limit: i64,
    offset: i64,
    filters: &MatchFilters,
) -> rusqlite::Result<MatchPage> {
    let w = match_list_where(conn, filters)?;
    let order_by = match_order_by(filters.sort, filters.sort_dir);
    match_page(conn, &w, &order_by, limit, offset)
}

/// `getChampionMatchHistory`: one champion's games, newest first.
pub fn get_champion_match_history(
    conn: &Connection,
    champion_id: i64,
    limit: i64,
    offset: i64,
    patch: Option<&str>,
    queue: Option<i64>,
    season: Option<&str>,
) -> rusqlite::Result<MatchPage> {
    let mut w = Where {
        conditions: vec!["ps.champion_id = ?".into()],
        params: vec![Sql::Integer(champion_id)],
    };
    if let Some(patch) = patch.filter(|p| !p.is_empty()) {
        w.conditions.push("g.game_version = ?".into());
        w.params.push(Sql::Text(patch.to_owned()));
    }
    apply_queue_filter(conn, &mut w, queue, "g")?;
    apply_season_filter(&mut w, season, "g");
    match_page(conn, &w, "g.game_creation DESC", limit, offset)
}

/// `Number(text)` for a patch component: blank is 0, anything that isn't a
/// decimal number is NaN. Rust also reads `inf` and `nan`, which `Number`
/// does not.
fn patch_part(text: Option<&str>) -> f64 {
    let Some(text) = text else { return f64::NAN };
    let t = text.trim();
    let word = t.trim_start_matches(['+', '-']);
    if t.is_empty() {
        0.0
    } else if word.starts_with(|c: char| c.is_ascii_alphabetic()) && word != "Infinity" {
        f64::NAN
    } else {
        t.parse().unwrap_or(f64::NAN)
    }
}

/// The patch dropdown's order, newest first: `bMajor - aMajor || bMinor -
/// aMinor`, where a NaN difference falls through to the minor and a NaN
/// result reads as equal, as `Array.prototype.sort` treats it.
fn sort_patches(patches: &mut [String]) {
    let key = |p: &str| {
        let mut parts = p.split('.');
        (patch_part(parts.next()), patch_part(parts.next()))
    };
    patches.sort_by(|a, b| {
        let ((a_major, a_minor), (b_major, b_minor)) = (key(a), key(b));
        let major = b_major - a_major;
        let diff = if major != 0.0 && !major.is_nan() {
            major
        } else {
            b_minor - a_minor
        };
        diff.partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal)
    });
}

fn strings(conn: &Connection, sql: &str, w: &Where) -> rusqlite::Result<Vec<String>> {
    conn.prepare_cached(sql)?
        .query_map(params_from_iter(&w.params), |row| row.get(0))?
        .collect()
}

fn ids(conn: &Connection, sql: &str, w: &Where) -> rusqlite::Result<Vec<i64>> {
    conn.prepare_cached(sql)?
        .query_map(params_from_iter(&w.params), |row| row.get(0))?
        .collect()
}

db_row! {
    struct AccountRow {
        puuid: String,
        game_name: Option<String>,
        tag_line: Option<String>,
        profile_icon: Option<i64>,
    }
}

/// `getMatchFilterOptions`. Each list is narrowed by the other filters, so a
/// dropdown never hides its own selection.
pub fn get_match_filter_options(
    conn: &Connection,
    scope: &MatchScope,
) -> rusqlite::Result<MatchFilterOptions> {
    let account = given(&scope.account);
    let patch = given(&scope.patch);
    let apply_account = |w: &mut Where| {
        if let Some(account) = account {
            w.conditions.push("g.puuid = ?".into());
            w.params.push(Sql::Text(account.to_owned()));
        }
    };
    let apply_champion = |w: &mut Where| {
        if let Some(champion) = scope.champion_id {
            w.conditions.push("ps.champion_id = ?".into());
            w.params.push(Sql::Integer(champion));
        }
    };
    let apply_patch = |w: &mut Where| {
        if let Some(patch) = patch {
            w.conditions.push("g.game_version = ?".into());
            w.params.push(Sql::Text(patch.to_owned()));
        }
    };
    let start = |first: &str| Where {
        conditions: vec![first.to_owned()],
        params: Vec::new(),
    };

    let mut patch_where = start("g.game_version IS NOT NULL AND g.game_version != ''");
    apply_champion(&mut patch_where);
    apply_queue_filter(conn, &mut patch_where, scope.queue, "g")?;
    apply_season_filter(&mut patch_where, scope.season.as_deref(), "g");
    apply_account(&mut patch_where);
    let mut patches = strings(
        conn,
        &format!(
            "
    SELECT DISTINCT g.game_version
    FROM games g
    JOIN player_stats ps ON g.game_id = ps.game_id
    WHERE {}
  ",
            patch_where.conditions.join(" AND ")
        ),
        &patch_where,
    )?;
    sort_patches(&mut patches);

    let mut champ_where = start("1 = 1");
    apply_patch(&mut champ_where);
    apply_queue_filter(conn, &mut champ_where, scope.queue, "g")?;
    apply_season_filter(&mut champ_where, scope.season.as_deref(), "g");
    apply_account(&mut champ_where);
    let champions = ids(
        conn,
        &format!(
            "
    SELECT DISTINCT ps.champion_id
    FROM player_stats ps
    JOIN games g ON ps.game_id = g.game_id
    WHERE {}
    ORDER BY ps.champion_id
  ",
            champ_where.conditions.join(" AND ")
        ),
        &champ_where,
    )?;

    let mut queue_where = start("1 = 1");
    apply_champion(&mut queue_where);
    apply_patch(&mut queue_where);
    apply_queue_filter(conn, &mut queue_where, None, "g")?;
    apply_season_filter(&mut queue_where, scope.season.as_deref(), "g");
    apply_account(&mut queue_where);
    let queues = ids(
        conn,
        &format!(
            "
    SELECT DISTINCT g.queue_id
    FROM games g
    JOIN player_stats ps ON g.game_id = ps.game_id
    WHERE {}
    ORDER BY g.queue_id
  ",
            queue_where.conditions.join(" AND ")
        ),
        &queue_where,
    )?;

    // Sets with a game under the other filters, newest first like the
    // patches. One still to come has none yet.
    let mut season_where = start("1 = 1");
    apply_champion(&mut season_where);
    apply_patch(&mut season_where);
    apply_queue_filter(conn, &mut season_where, scope.queue, "g")?;
    apply_account(&mut season_where);
    let mut seasons = Vec::new();
    for season in &SEASONS {
        let mut w = season_where.clone();
        apply_season_filter(&mut w, Some(season.id), "g");
        let found: i64 = conn
            .prepare_cached(&format!(
                "
      SELECT EXISTS (
        SELECT 1
        FROM games g
        JOIN player_stats ps ON g.game_id = ps.game_id
        WHERE {}
      ) as found
    ",
                w.conditions.join(" AND ")
            ))?
            .query_row(params_from_iter(&w.params), |row| row.get(0))?;
        if found == 1 {
            seasons.push(season.id.to_owned());
        }
    }
    seasons.reverse();

    // The tracked accounts ignore the other filters, so the dropdown doesn't
    // reshuffle as the list narrows. A game whose owner was never resolved
    // carries an empty puuid and isn't an account.
    let account_rows: Vec<AccountRow> = stmt::all(
        conn,
        "
    SELECT g.puuid, s.game_name, s.tag_line, s.profile_icon
    FROM games g
    LEFT JOIN summoner s ON s.puuid = g.puuid
    WHERE g.puuid != ''
    GROUP BY g.puuid
    ORDER BY MAX(g.game_creation) DESC
  ",
        [],
    )?;
    let mut accounts = Vec::with_capacity(account_rows.len());
    for row in account_rows {
        let mut name = display_name(row.game_name.as_deref(), row.tag_line.as_deref());
        let mut profile_icon = row.profile_icon;
        // An imported database may have no summoner row for an account: fall
        // back to what its most recent game recorded, as getProfile does
        if name.is_none() || profile_icon.is_none() {
            let latest: Option<i64> = conn
                .prepare_cached(
                    "SELECT game_id FROM games WHERE puuid = ? ORDER BY game_creation DESC LIMIT 1",
                )?
                .query_row([&row.puuid], |r| r.get(0))
                .optional()?;
            if let Some(game_id) = latest {
                let from_game = identity_from_game(conn, game_id, &row.puuid)?;
                name = name.or(from_game.name);
                profile_icon = profile_icon.or(from_game.profile_icon);
            }
        }
        accounts.push(TrackedAccount {
            puuid: row.puuid,
            name,
            profile_icon,
        });
    }

    // The favorites toggle ignores the other filters too, so it stays put
    // rather than blinking out when the selection holds no favorites
    let has: i64 = conn
        .prepare_cached(
            "
    SELECT EXISTS (
      SELECT 1
      FROM games g
      JOIN player_stats ps ON g.game_id = ps.game_id
      WHERE g.favorite = 1
    ) as has
  ",
        )?
        .query_row([], |row| row.get(0))?;

    Ok(MatchFilterOptions {
        patches,
        champions,
        queues,
        seasons,
        accounts,
        has_favorites: has != 0,
    })
}

db_row! {
    struct ParticipantRow {
        participant_id: i64,
        puuid: Option<String>,
        game_name: Option<String>,
        tag_line: Option<String>,
        team_id: i64,
        champion_id: i64,
        win: i64,
        kills: i64,
        deaths: i64,
        assists: i64,
        double_kills: i64,
        triple_kills: i64,
        quadra_kills: i64,
        penta_kills: i64,
        total_damage_dealt: i64,
        total_damage_taken: i64,
        gold_earned: i64,
        total_heal: i64,
        largest_killing_spree: i64,
        spell1: Option<i64>,
        spell2: Option<i64>,
        item0: Option<i64>,
        item1: Option<i64>,
        item2: Option<i64>,
        item3: Option<i64>,
        item4: Option<i64>,
        item5: Option<i64>,
        item6: Option<i64>,
    }
}

/// `getMatchParticipants`: the ten-player scoreboard, in the shape the page
/// draws.
fn get_match_participants(
    conn: &Connection,
    game_id: i64,
) -> rusqlite::Result<Vec<MatchParticipantRecord>> {
    let rows: Vec<ParticipantRow> = stmt::all(
        conn,
        "
      SELECT participant_id, puuid, game_name, tag_line, team_id, champion_id, win,
             kills, deaths, assists, double_kills, triple_kills, quadra_kills, penta_kills,
             total_damage_dealt, total_damage_taken, gold_earned, total_heal,
             largest_killing_spree, spell1, spell2,
             item0, item1, item2, item3, item4, item5, item6
      FROM match_participants
      WHERE game_id = ?
      ORDER BY participant_id
    ",
        [game_id],
    )?;
    let mut augments: HashMap<i64, Vec<i64>> = HashMap::new();
    let mut picks = conn.prepare_cached(
        "
      SELECT participant_id, augment_id
      FROM match_participant_augments
      WHERE game_id = ?
      ORDER BY participant_id, slot
    ",
    )?;
    let mut picked = picks.query([game_id])?;
    while let Some(row) = picked.next()? {
        augments.entry(row.get(0)?).or_default().push(row.get(1)?);
    }

    Ok(rows
        .into_iter()
        .map(|r| MatchParticipantRecord {
            participant_id: r.participant_id,
            puuid: r.puuid,
            game_name: r.game_name,
            tag_line: r.tag_line,
            champion_id: r.champion_id,
            team_id: r.team_id,
            win: r.win == 1,
            kills: r.kills,
            deaths: r.deaths,
            assists: r.assists,
            double_kills: r.double_kills,
            triple_kills: r.triple_kills,
            quadra_kills: r.quadra_kills,
            penta_kills: r.penta_kills,
            total_damage_dealt_to_champions: r.total_damage_dealt,
            total_damage_taken: r.total_damage_taken,
            gold_earned: r.gold_earned,
            total_heal: r.total_heal,
            largest_killing_spree: r.largest_killing_spree,
            spell1_id: r.spell1,
            spell2_id: r.spell2,
            items: [
                r.item0, r.item1, r.item2, r.item3, r.item4, r.item5, r.item6,
            ]
            .map(|item| item.unwrap_or(0))
            .to_vec(),
            augments: augments.remove(&r.participant_id).unwrap_or_default(),
        })
        .collect())
}

/// `getMatchDetail`. The columns are listed so the stored payload stays out
/// of a message that only needs the game's metadata.
pub fn get_match_detail(conn: &Connection, game_id: i64) -> rusqlite::Result<Option<MatchDetail>> {
    let game: Option<GameRecord> = stmt::first(
        conn,
        "
      SELECT game_id, queue_id, game_mode, game_creation, game_duration,
             is_remake, puuid, game_version, favorite
      FROM games WHERE game_id = ?
    ",
        [game_id],
    )?;
    let Some(game) = game else { return Ok(None) };
    let stats: Option<PlayerStatsRecord> = stmt::first(
        conn,
        "SELECT * FROM player_stats WHERE game_id = ?",
        [game_id],
    )?;
    // Ingest writes a game and its stats row together, so a game without one
    // is a corrupt file; JavaScript would hand the page `stats: undefined`
    let stats = stats.ok_or(rusqlite::Error::QueryReturnedNoRows)?;
    let augments = stmt::all(
        conn,
        "SELECT * FROM game_augments WHERE game_id = ? ORDER BY slot",
        [game_id],
    )?;
    Ok(Some(MatchDetail {
        game,
        stats,
        augments,
        participants: get_match_participants(conn, game_id)?,
    }))
}

/// `toggleFavorite`: the game's favorite flag after the flip, false for a
/// game that doesn't exist.
pub fn toggle_favorite(conn: &Connection, game_id: i64) -> rusqlite::Result<bool> {
    conn.prepare_cached("UPDATE games SET favorite = 1 - favorite WHERE game_id = ?")?
        .execute([game_id])?;
    let favorite: Option<i64> = conn
        .prepare_cached("SELECT favorite FROM games WHERE game_id = ?")?
        .query_row([game_id], |row| row.get(0))
        .optional()?;
    Ok(favorite.is_some_and(|f| f != 0))
}
