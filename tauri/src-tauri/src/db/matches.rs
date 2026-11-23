//! `src/main/db/matches.ts`: the match list, its sessions and filter options,
//! one game's scoreboard, and favorites. The SQL is Electron's text, so
//! SQLite plans, orders, and sums the same rows the same way.

use std::collections::HashMap;

use rusqlite::types::{Value as Sql, ValueRef};
use rusqlite::{Connection, OptionalExtension, params_from_iter};

use super::filters::{
    DAY_START_HOUR, SEASONS, Where, apply_queue_filter, apply_season_filter, hide_remakes,
};
use super::settings::{SESSION_GROUPING_SETTING, get_setting};
use super::js;
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
    ($name:ty { $($field:ident $(= $read:ident)?),* $(,)? }) => {
        impl FromRow for $name {
            const COLUMNS: &'static [&'static str] = &[$(stringify!($field)),*];

            #[allow(unused_assignments)]
            fn from_row(row: &rusqlite::Row<'_>, at: &[usize]) -> rusqlite::Result<Self> {
                let mut i = 0;
                Ok(Self { $($field: { let v = from_row!(@get row, at[i] $(, $read)?); i += 1; v }),* })
            }
        }
    };
    (@get $row:ident, $at:expr) => { $row.get($at)? };
    (@get $row:ident, $at:expr, $read:ident) => { $read($row, $at)? };
}

/// `score_badge` is `ScoreBadge | null` in the contract, so text other than
/// MVP or ACE reads as no badge instead of failing the whole query. Electron
/// passes the text through, and the renderer only compares it with the two
/// names.
fn badge(row: &rusqlite::Row<'_>, at: usize) -> rusqlite::Result<Option<ScoreBadge>> {
    Ok(match row.get_ref(at)? {
        ValueRef::Text(b"MVP") => Some(ScoreBadge::Mvp),
        ValueRef::Text(b"ACE") => Some(ScoreBadge::Ace),
        _ => None,
    })
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
    score_badge = badge,
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
    score_badge = badge,
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
    if js::truthy_js(filters.favorites.value()) {
        w.conditions.push("g.favorite = 1".into());
    }
    if let Some(account) = given(&filters.account.typed().flatten()) {
        w.conditions.push("g.puuid = ?".into());
        w.params.push(Sql::Text(account.to_owned()));
    }
    if let Some(champion) = filters.champion_id.typed().flatten() {
        w.conditions.push("ps.champion_id = ?".into());
        w.params.push(Sql::Integer(champion));
    }
    if let Some(patch) = given(&filters.patch.typed().flatten()) {
        w.conditions.push("g.game_version = ?".into());
        w.params.push(Sql::Text(patch.to_owned()));
    }
    apply_queue_filter(conn, &mut w, filters.queue.typed().flatten(), "g")?;
    apply_season_filter(&mut w, filters.season.typed().flatten().as_deref(), "g");
    let kinds = filters
        .multikill_kinds()
        .map_err(|err| js::thrown(js::JsError::type_error(err.message)))?;
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
fn local_session_date() -> String {
    format!("g.game_creation / 1000, 'unixepoch', 'localtime', '-{DAY_START_HOUR} hours'")
}

/// `sessionKeySql`. A week opens on `week_start` (0 is Sunday): 'weekday N'
/// moves on to the day that closes the week, and '-6 days' walks back to the
/// one that opens it.
fn session_key_sql(grouping: SessionGrouping, week_start: u8) -> Option<String> {
    match grouping {
        SessionGrouping::Day => Some(format!("date({})", local_session_date())),
        SessionGrouping::Week => {
            let closing_day = (week_start + 6) % 7;
            Some(format!(
                "date({}, 'weekday {closing_day}', '-6 days')",
                local_session_date()
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
    let grouping = SessionGrouping::parse(get_setting(conn, SESSION_GROUPING_SETTING)?.as_str());
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
    let order_by = match_order_by(Some(filters.sort_key()), Some(filters.sort_direction()));
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

/// `Number` of a patch component, where a missing one is `undefined`: NaN.
fn patch_part(text: Option<&str>) -> f64 {
    text.map_or(f64::NAN, js::string_to_number)
}

/// The patch dropdown's comparator, `bMajor - aMajor || bMinor - aMinor`.
/// A NaN difference falls through to the minor, and a NaN result reads as 0,
/// as `Array.prototype.sort` treats it.
fn compare_patches(a: &str, b: &str) -> f64 {
    let key = |p: &str| {
        let mut parts = p.split('.');
        (patch_part(parts.next()), patch_part(parts.next()))
    };
    let ((a_major, a_minor), (b_major, b_minor)) = (key(a), key(b));
    let major = b_major - a_major;
    let diff = if major != 0.0 && !major.is_nan() {
        major
    } else {
        b_minor - a_minor
    };
    if diff.is_nan() { 0.0 } else { diff }
}

/// V8's `Array.prototype.sort` on an array shorter than 64: one run found
/// from the front, then a binary insertion for the rest. A comparator that
/// is not a total order, as this one is over an unparseable patch, orders
/// differently under any other stable sort, so the steps are V8's own.
fn sort_patches(patches: &mut [String]) {
    let compare = |a: &String, b: &String| compare_patches(a, b);
    let n = patches.len();
    if n < 2 {
        return;
    }
    let mut run = 2;
    let descending = compare(&patches[1], &patches[0]) < 0.0;
    while run < n {
        let order = compare(&patches[run], &patches[run - 1]);
        if if descending {
            order >= 0.0
        } else {
            order < 0.0
        } {
            break;
        }
        run += 1;
    }
    if descending {
        patches[..run].reverse();
    }
    for start in run..n {
        let (mut left, mut right) = (0, start);
        while left < right {
            let mid = left + ((right - left) >> 1);
            if compare(&patches[start], &patches[mid]) < 0.0 {
                right = mid;
            } else {
                left = mid + 1;
            }
        }
        patches[left..=start].rotate_right(1);
    }
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
    let account = scope.account.typed().flatten();
    let account = given(&account);
    let patch = scope.patch.typed().flatten();
    let patch = given(&patch);
    let apply_account = |w: &mut Where| {
        if let Some(account) = account {
            w.conditions.push("g.puuid = ?".into());
            w.params.push(Sql::Text(account.to_owned()));
        }
    };
    let apply_champion = |w: &mut Where| {
        if let Some(champion) = scope.champion_id.typed().flatten() {
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
    apply_queue_filter(conn, &mut patch_where, scope.queue.typed().flatten(), "g")?;
    apply_season_filter(&mut patch_where, scope.season.typed().flatten().as_deref(), "g");
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
    apply_queue_filter(conn, &mut champ_where, scope.queue.typed().flatten(), "g")?;
    apply_season_filter(&mut champ_where, scope.season.typed().flatten().as_deref(), "g");
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
    apply_season_filter(&mut queue_where, scope.season.typed().flatten().as_deref(), "g");
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
    apply_queue_filter(conn, &mut season_where, scope.queue.typed().flatten(), "g")?;
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

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use serde_json::Value;

    use super::*;
    use crate::db::schema::init_database;
    use crate::db::settings::set_setting;
    use crate::db::summoner::{get_all_puuids, get_profile};
    use crate::db::week::first_day_of_week;
    use crate::db::{Database, filters};

    /// `{ "$f64": hex }`, as record-matrix.ts writes a fractional number.
    fn exact_float(v: &Value) -> Option<u64> {
        let hex = v.as_object()?.get("$f64")?.as_str()?;
        u64::from_str_radix(hex, 16).ok()
    }

    /// `a === b` over what IPC carried: keys unordered, numbers by their f64
    /// bits, everything else exactly.
    fn same(a: &Value, b: &Value) -> bool {
        if let (Some(bits), Value::Number(n)) = (exact_float(a), b) {
            return n.as_f64().map(f64::to_bits) == Some(bits);
        }
        match (a, b) {
            (Value::Number(x), Value::Number(y)) => {
                x.as_f64().map(f64::to_bits) == y.as_f64().map(f64::to_bits)
            }
            (Value::Array(x), Value::Array(y)) => {
                x.len() == y.len() && x.iter().zip(y).all(|(x, y)| same(x, y))
            }
            (Value::Object(x), Value::Object(y)) => {
                x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| same(v, w)))
            }
            _ => a == b,
        }
    }

    /// Where two values first differ, as a path, with both sides there.
    fn first_diff(a: &Value, b: &Value, at: String) -> Option<String> {
        match (a, b) {
            (Value::Array(x), Value::Array(y)) if x.len() == y.len() => x
                .iter()
                .zip(y)
                .enumerate()
                .find_map(|(i, (x, y))| first_diff(x, y, format!("{at}[{i}]"))),
            (Value::Object(x), Value::Object(y)) if x.len() == y.len() => {
                x.iter().find_map(|(k, v)| match y.get(k) {
                    Some(w) => first_diff(v, w, format!("{at}.{k}")),
                    None => Some(format!("{at}.{k}: missing on one side")),
                })
            }
            _ if same(a, b) => None,
            _ if exact_float(a).is_some() => Some(format!(
                "{at}: electron {} rust {b}",
                f64::from_bits(exact_float(a).unwrap_or_default())
            )),
            _ => Some(format!("{at}: electron {a} rust {b}")),
        }
    }

    fn arg<T: serde::de::DeserializeOwned + Default>(args: &[Value], i: usize) -> T {
        match args.get(i) {
            None | Some(Value::Null) => T::default(),
            Some(v) => serde_json::from_value(v.clone()).expect("an argument the command takes"),
        }
    }

    fn opt<T: serde::de::DeserializeOwned>(args: &[Value], i: usize) -> Option<T> {
        args.get(i)
            .filter(|v| !v.is_null())
            .map(|v| serde_json::from_value(v.clone()).expect("an argument the command takes"))
    }

    fn json<T: serde::Serialize>(result: rusqlite::Result<T>) -> Value {
        serde_json::to_value(result.expect("the query runs")).unwrap()
    }

    /// One `window.api` call, answered by the Rust query as the command
    /// would answer it.
    fn answer(conn: &Connection, method: &str, args: &[Value], week_start: u8) -> Value {
        let int = |i: usize| args[i].as_i64().expect("an integer argument");
        match method {
            "getMatchHistory" => json(get_match_history(conn, int(0), int(1), &arg(args, 2))),
            "getMatchSessions" => json(get_match_sessions(conn, &arg(args, 0), week_start)),
            "getMatchFilterOptions" => json(get_match_filter_options(conn, &arg(args, 0))),
            "getStoredQueues" => json(filters::get_stored_queues(conn)),
            "getMatchDetail" => json(get_match_detail(conn, int(0))),
            "toggleFavorite" => json(toggle_favorite(conn, int(0))),
            "getChampionMatchHistory" => json(get_champion_match_history(
                conn,
                int(0),
                int(1),
                int(2),
                opt::<String>(args, 3).as_deref(),
                opt(args, 4),
                opt::<String>(args, 5).as_deref(),
            )),
            "getAllSummonerPuuids" => json(get_all_puuids(conn)),
            "getProfile" => json(get_profile(conn)),
            other => panic!("no query for {other}"),
        }
    }

    fn copy_dir(from: &Path, to: &Path) {
        std::fs::create_dir_all(to).unwrap();
        for entry in std::fs::read_dir(from).unwrap().flatten() {
            let target = to.join(entry.file_name());
            if entry.file_type().unwrap().is_dir() {
                copy_dir(&entry.path(), &target);
            } else {
                std::fs::copy(entry.path(), target).unwrap();
            }
        }
    }

    /// A fresh copy of the fixture's `data/` folder, after `sql`.
    fn fixture_copy(fixture: &Path, name: &str, sql: &str) -> (PathBuf, Database) {
        let dir = std::env::temp_dir().join(format!("bmt-t13-{name}-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        copy_dir(fixture, &dir);
        if !sql.is_empty() {
            Connection::open(dir.join("matches.db"))
                .unwrap()
                .execute_batch(sql)
                .unwrap();
        }
        let db = Database::open(&dir, 0).unwrap();
        (dir, db)
    }

    fn env_path(key: &str) -> Option<PathBuf> {
        std::env::var_os(key).map(PathBuf::from)
    }

    /// Every case `parity/t13/record-matrix.ts` recorded from
    /// trunk Electron, replayed against the same fixture. Needs
    /// `BMT_T13_MATRIX` and `BMT_GOLDEN_DATA`, and `TZ` as the recording ran.
    #[test]
    fn electron_matrix() {
        let (Some(matrix), Some(fixture)) =
            (env_path("BMT_T13_MATRIX"), env_path("BMT_GOLDEN_DATA"))
        else {
            eprintln!("electron_matrix: set BMT_T13_MATRIX and BMT_GOLDEN_DATA to run it");
            return;
        };
        let matrix: Value =
            serde_json::from_str(&std::fs::read_to_string(matrix).unwrap()).unwrap();
        let locale = matrix["locale"].as_str();
        let week_start = first_day_of_week(locale);
        assert_eq!(
            Some(u64::from(week_start)),
            matrix["weekStart"].as_u64(),
            "week start for {locale:?}"
        );

        let cross = matrix["week"]["cross"].as_object().unwrap();
        let wrong: Vec<_> = cross
            .iter()
            .filter(|(tag, day)| Some(u64::from(first_day_of_week(Some(tag)))) != day.as_u64())
            .map(|(tag, day)| format!("{tag}={day}"))
            .collect();
        println!(
            "week: {} of {} tags open where Electron opens them",
            cross.len() - wrong.len(),
            cross.len()
        );
        assert!(wrong.is_empty(), "weeks that open elsewhere: {wrong:?}");

        let mut tally: std::collections::BTreeMap<String, (usize, usize)> = Default::default();
        let mut failures = Vec::new();
        for (variant, sql) in matrix["variants"].as_object().unwrap() {
            let (dir, db) = fixture_copy(&fixture, variant, sql.as_str().unwrap());
            let mut applied: HashMap<String, String> = HashMap::new();
            for case in matrix["cases"].as_array().unwrap() {
                if case["variant"] != *variant {
                    continue;
                }
                let method = case["method"].as_str().unwrap();
                let args = case["args"].as_array().unwrap();
                let got = db
                    .with(|conn| {
                        for (key, value) in case["settings"].as_object().unwrap() {
                            let value = value.as_str().unwrap();
                            if applied.get(key).map(String::as_str) != Some(value) {
                                set_setting(conn, key, value)?;
                                applied.insert(key.clone(), value.to_owned());
                            }
                        }
                        Ok(answer(conn, method, args, week_start))
                    })
                    .unwrap();
                let entry = tally.entry(format!("{variant} {method}")).or_default();
                entry.0 += 1;
                if same(&case["result"], &got) {
                    entry.1 += 1;
                } else if failures.len() < 20 {
                    failures.push(format!(
                        "{variant} {method} {} settings {}: {}",
                        case["args"],
                        case["settings"],
                        first_diff(&case["result"], &got, String::new()).unwrap_or_default()
                    ));
                }
            }
            db.close();
            std::fs::remove_dir_all(dir).ok();
        }
        for (what, (cases, matched)) in &tally {
            println!("{what}: {matched}/{cases} match");
        }
        assert!(failures.is_empty(), "{}", failures.join("\n"));
    }

    /// The patch dropdown over the odd `game_version` text that
    /// `parity/t13/patch-probe.ts` gave trunk Electron's fixture copy. Needs
    /// `BMT_T13_PATCH_PROBE` and `BMT_GOLDEN_DATA`.
    #[test]
    fn patch_probe() {
        let (Some(probe), Some(fixture)) =
            (env_path("BMT_T13_PATCH_PROBE"), env_path("BMT_GOLDEN_DATA"))
        else {
            eprintln!("patch_probe: set BMT_T13_PATCH_PROBE and BMT_GOLDEN_DATA to run it");
            return;
        };
        let probe: Value = serde_json::from_str(&std::fs::read_to_string(probe).unwrap()).unwrap();
        let texts = |key: &str| -> Vec<String> {
            probe[key]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_str().unwrap().to_owned())
                .collect()
        };
        let sql: String = texts("versions")
            .iter()
            .enumerate()
            .map(|(i, version)| {
                format!(
                    "UPDATE games SET game_version = '{}' WHERE game_id = (SELECT game_id FROM games ORDER BY game_creation DESC LIMIT 1 OFFSET {i});",
                    version.replace('\'', "''")
                )
            })
            .collect();
        let (dir, db) = fixture_copy(&fixture, "patch-probe", &sql);
        let options = db
            .with(|conn| get_match_filter_options(conn, &MatchScope::default()))
            .unwrap();
        db.close();
        std::fs::remove_dir_all(dir).ok();
        assert_eq!(options.patches, texts("patches"));
    }

    /// The T05 goldens for these channels' read cases, run straight against
    /// the query: each row count, and the first and last row. Needs
    /// `BMT_GOLDEN_DIR` and `BMT_GOLDEN_DATA`.
    #[test]
    fn fixture_goldens() {
        let (Some(goldens), Some(fixture)) =
            (env_path("BMT_GOLDEN_DIR"), env_path("BMT_GOLDEN_DATA"))
        else {
            eprintln!("fixture_goldens: set BMT_GOLDEN_DIR and BMT_GOLDEN_DATA to run it");
            return;
        };
        let channels = [
            ("db.match-history", "getMatchHistory"),
            ("db.match-sessions", "getMatchSessions"),
            ("db.match-filters", "getMatchFilterOptions"),
            ("db.stored-queues", "getStoredQueues"),
            ("db.match-detail", "getMatchDetail"),
            ("db.champion-match-history", "getChampionMatchHistory"),
            ("db.all-summoner-puuids", "getAllSummonerPuuids"),
            ("db.profile", "getProfile"),
        ];
        let (dir, db) = fixture_copy(&fixture, "goldens", "");
        let mut checked = 0;
        for (folder, method) in channels {
            for file in std::fs::read_dir(goldens.join("ipc").join(folder))
                .unwrap()
                .flatten()
            {
                let golden: Value =
                    serde_json::from_str(&std::fs::read_to_string(file.path()).unwrap()).unwrap();
                if golden["group"] != "read" {
                    continue;
                }
                let args = golden["args"].as_array().unwrap();
                let want = &golden["outcome"]["result"];
                let got = db.with(|conn| Ok(answer(conn, method, args, 0))).unwrap();
                let rows = |v: &Value| {
                    v.get("matches")
                        .or(Some(v))
                        .and_then(Value::as_array)
                        .cloned()
                };
                let what = format!("{folder} {}", golden["case"]);
                match (rows(want), rows(&got)) {
                    (Some(want_rows), Some(got_rows)) => {
                        assert_eq!(want_rows.len(), got_rows.len(), "{what}: row count");
                        assert!(
                            same(
                                &want_rows.first().cloned().into(),
                                &got_rows.first().cloned().into()
                            ),
                            "{what}: first row"
                        );
                        assert!(
                            same(
                                &want_rows.last().cloned().into(),
                                &got_rows.last().cloned().into()
                            ),
                            "{what}: last row"
                        );
                        assert_eq!(
                            want.get("total"),
                            got.get("total").filter(|_| want.get("total").is_some()),
                            "{what}: total"
                        );
                    }
                    _ => assert!(same(want, &got), "{what}: {got}"),
                }
                checked += 1;
            }
        }
        db.close();
        std::fs::remove_dir_all(dir).ok();
        println!("fixture_goldens: {checked} read cases match");
        assert!(checked > 0);
    }

    /// The schema with three games: an unscored remake, a penta, and a
    /// favorite, for the rules the fixture alone doesn't pin.
    fn small_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        init_database(&conn, 0).unwrap();
        conn.execute_batch(
            "
            INSERT INTO games (game_id, queue_id, game_mode, game_creation, game_duration, is_remake, puuid, game_version, favorite)
            VALUES (1, 2400, 'KIWI', 1767000000000, 1200, 0, 'p1', '16.1.1', 0),
                   (2, 2400, 'KIWI', 1768000000000, 200, 1, 'p1', '16.10.2', 1),
                   (3, 2450, 'KIWI', 1769000000000, 1500, 0, 'p2', '16.2.1', 0);
            INSERT INTO player_stats (game_id, champion_id, win, kills, deaths, assists, penta_kills, score, score_raw, score_badge)
            VALUES (1, 10, 1, 10, 2, 5, 1, 9.5, 9.53, 'MVP'),
                   (2, 20, 0, 0, 0, 0, 0, NULL, NULL, NULL),
                   (3, 10, 0, 3, 6, 9, 0, 4.0, 4.01, 'ACE');
            ",
        )
        .unwrap();
        conn
    }

    fn game_ids(page: &MatchPage) -> Vec<i64> {
        page.matches.iter().map(|m| m.game_id).collect()
    }

    #[test]
    fn unscored_games_sort_last_either_way() {
        let conn = small_db();
        for dir in [MatchSortDir::Asc, MatchSortDir::Desc] {
            let filters = MatchFilters {
                sort: serde_json::json!(MatchSort::Score).into(),
                sort_dir: serde_json::json!(dir).into(),
                ..Default::default()
            };
            let page = get_match_history(&conn, 10, 0, &filters).unwrap();
            assert_eq!(game_ids(&page).last(), Some(&2), "{dir:?}");
            assert_eq!(page.total, 3);
        }
    }

    #[test]
    fn filters_narrow_the_list_and_paging_keeps_the_total() {
        let conn = small_db();
        let pentas = MatchFilters {
            multikills: serde_json::json!([MultikillType::Pentas]).into(),
            ..Default::default()
        };
        assert_eq!(
            game_ids(&get_match_history(&conn, 10, 0, &pentas).unwrap()),
            [1]
        );
        let page = get_match_history(&conn, 1, 1, &MatchFilters::default()).unwrap();
        assert_eq!((game_ids(&page), page.total), (vec![2], 3));
        set_setting(&conn, "hide_remakes", "true").unwrap();
        assert_eq!(
            get_match_history(&conn, 10, 0, &MatchFilters::default())
                .unwrap()
                .total,
            2
        );
        set_setting(&conn, "hidden_queues", "2450").unwrap();
        assert_eq!(
            game_ids(&get_match_history(&conn, 10, 0, &MatchFilters::default()).unwrap()),
            [1]
        );
    }

    #[test]
    fn sessions_count_remakes_as_games_only() {
        let conn = small_db();
        set_setting(&conn, SESSION_GROUPING_SETTING, "patch").unwrap();
        let sessions = get_match_sessions(&conn, &MatchFilters::default(), 0).unwrap();
        let remake = sessions.iter().find(|s| s.key == "16.10.2").unwrap();
        assert_eq!(
            (remake.games, remake.wins, remake.losses, remake.score_sum),
            (1, 0, 0, None)
        );
        set_setting(&conn, SESSION_GROUPING_SETTING, "none").unwrap();
        assert!(
            get_match_sessions(&conn, &MatchFilters::default(), 0)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn patches_sort_newest_first_by_number() {
        let conn = small_db();
        let options = get_match_filter_options(&conn, &MatchScope::default()).unwrap();
        assert_eq!(options.patches, ["16.10.2", "16.2.1", "16.1.1"]);
        assert_eq!(options.champions, [10, 20]);
        assert!(options.has_favorites);
        let names: Vec<_> = options.accounts.iter().map(|a| a.puuid.as_str()).collect();
        assert_eq!(names, ["p2", "p1"]);
    }

    fn sorted_patches(input: &[&str]) -> Vec<String> {
        let mut patches: Vec<String> = input.iter().map(|p| p.to_string()).collect();
        sort_patches(&mut patches);
        patches
    }

    /// Expected orders are what `Array.prototype.sort` returns for the same
    /// input in Node, with the dropdown's comparator.
    #[test]
    fn patches_with_numeric_text_sort_as_javascript_sorts_them() {
        assert_eq!(sorted_patches(&["15.9", "0x10.1"]), ["0x10.1", "15.9"]);
        assert_eq!(
            sorted_patches(&["16.1", "16.2", "0x10.1", "16.10"]),
            ["16.10", "16.2", "16.1", "0x10.1"]
        );
        assert_eq!(
            sorted_patches(&["16.3", "16.10", "0b11.5", "0o20.1", "1e1.2", "16.2"]),
            ["16.10", "16.3", "16.2", "0o20.1", "1e1.2", "0b11.5"]
        );
        assert_eq!(
            sorted_patches(&[
                "16.1",
                "16.23",
                "Infinity.1",
                "16.10",
                "\u{a0}16.3",
                "16.0x2",
                "16.1e1"
            ]),
            [
                "Infinity.1",
                "16.23",
                "16.10",
                "16.1e1",
                "\u{a0}16.3",
                "16.0x2",
                "16.1"
            ]
        );
    }

    #[test]
    fn patches_that_are_not_numbers_keep_the_order_javascript_gives_them() {
        let input = [
            "abc",
            "0x10.1",
            "16.10",
            " 16.3",
            "16.1e1",
            "Infinity.1",
            "16.2",
            "x.y",
            "15.9",
            "16",
            "16.0x2",
            ".5",
            "1_6.1",
            " 16.4",
            "-0x1.2",
            "16.-1",
        ];
        assert_eq!(
            sorted_patches(&input),
            [
                "abc",
                "Infinity.1",
                "16.10",
                "16.1e1",
                " 16.4",
                " 16.3",
                "16.2",
                "-0x1.2",
                "0x10.1",
                "x.y",
                "16",
                "16.0x2",
                "16.-1",
                "15.9",
                ".5",
                "1_6.1",
            ]
        );
    }

    #[test]
    fn session_dates_cut_the_day_at_the_day_start_hour() {
        assert_eq!(
            local_session_date(),
            "g.game_creation / 1000, 'unixepoch', 'localtime', '-5 hours'"
        );
        assert_eq!(DAY_START_HOUR, 5);
    }

    #[test]
    fn a_score_badge_other_than_mvp_or_ace_reads_as_none() {
        let conn = small_db();
        conn.execute(
            "UPDATE player_stats SET score_badge = 'GOLD' WHERE game_id = 1",
            [],
        )
        .unwrap();
        conn.execute(
            "UPDATE player_stats SET score_badge = 7 WHERE game_id = 3",
            [],
        )
        .unwrap();
        let page = get_match_history(&conn, 10, 0, &MatchFilters::default()).unwrap();
        let badges: Vec<_> = page
            .matches
            .iter()
            .map(|m| (m.game_id, m.score_badge))
            .collect();
        assert_eq!(badges, [(3, None), (2, None), (1, None)]);
        let detail = get_match_detail(&conn, 1).unwrap().unwrap();
        assert_eq!(detail.stats.score_badge, None);
    }

    #[test]
    fn a_favorite_flips_and_a_missing_game_reads_false() {
        let conn = small_db();
        assert!(toggle_favorite(&conn, 1).unwrap());
        assert!(!toggle_favorite(&conn, 1).unwrap());
        assert!(!toggle_favorite(&conn, 99).unwrap());
        assert!(get_match_detail(&conn, 99).unwrap().is_none());
        let detail = get_match_detail(&conn, 1).unwrap().unwrap();
        assert_eq!(detail.stats.score_badge, Some(ScoreBadge::Mvp));
    }
}
