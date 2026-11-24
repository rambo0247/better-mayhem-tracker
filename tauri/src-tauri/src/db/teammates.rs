//! `src/main/db/teammates.ts`: the people we play with, alone and as groups,
//! and the games we shared with them.
//!
//! Every list comes back in the order Electron builds it: rows newest first,
//! players and groups in the order a JavaScript `Map` first saw them, then a
//! stable sort. [`JsMap`] keeps that insertion order.

use std::cmp::Reverse;
use std::collections::HashMap;
use std::hash::Hash;

use rusqlite::Connection;
use rusqlite::types::Value as Sql;

use super::filters::{Where, apply_queue_filter};
use super::scoring::{GameScoreRow, ScoreRow, group_by_game};
use super::stmt::{self, FromRow};
use super::summoner::{display_name, get_all_puuids};
use crate::commands::teammates::{
    TeammateChampionStats, TeammateDetail, TeammateGroup, TeammateGroupDetail, TeammateGroupMatch,
    TeammateLine, TeammateMatch, TeammateMember, TeammateProfile,
};
use crate::commands::types::{MatchListItem, ScoreBadge, TeammateChampionGames, TeammateStats};
use crate::db_row;
use crate::intl::locale_compare;
use crate::op_score::{self, ChampionClassMap, compute_match_scores};

/// `MIN_SHARED_GAMES` in `src/shared/teammates.ts`.
pub const MIN_SHARED_GAMES: i64 = 2;

/// `MIN_GROUP_MEMBER_GAMES` in `src/shared/teammates.ts`.
pub const MIN_GROUP_MEMBER_GAMES: i64 = 3;

/// `CareerFilter` in `src/main/db/records.ts`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CareerFilter {
    pub queue: Option<i64>,
    pub account: Option<String>,
    pub from: Option<i64>,
    pub to: Option<i64>,
}

/// A JavaScript `Map`: iteration follows first insertion, `set` on a present
/// key keeps its slot, and `delete` frees it.
struct JsMap<K, V> {
    slots: Vec<Option<(K, V)>>,
    at: HashMap<K, usize>,
}

impl<K: Eq + Hash + Clone, V> JsMap<K, V> {
    fn new() -> Self {
        Self {
            slots: Vec::new(),
            at: HashMap::new(),
        }
    }

    fn contains(&self, key: &K) -> bool {
        self.at.contains_key(key)
    }

    fn get(&self, key: &K) -> Option<&V> {
        self.at
            .get(key)
            .and_then(|&i| self.slots[i].as_ref().map(|(_, v)| v))
    }

    fn get_mut(&mut self, key: &K) -> Option<&mut V> {
        let i = *self.at.get(key)?;
        self.slots[i].as_mut().map(|(_, v)| v)
    }

    fn set(&mut self, key: K, value: V) {
        match self.at.get(&key) {
            Some(&i) => self.slots[i] = Some((key, value)),
            None => {
                self.at.insert(key.clone(), self.slots.len());
                self.slots.push(Some((key, value)));
            }
        }
    }

    fn delete(&mut self, key: &K) -> Option<V> {
        let i = self.at.remove(key)?;
        self.slots[i].take().map(|(_, v)| v)
    }

    fn keys(&self) -> impl Iterator<Item = &K> {
        self.slots.iter().flatten().map(|(k, _)| k)
    }

    fn into_entries(self) -> impl Iterator<Item = (K, V)> {
        self.slots.into_iter().flatten()
    }
}

/// The id the Friends list keys a teammate on: puuid when we know it, so
/// name changes don't split a player in two.
fn teammate_key(puuid: Option<&str>, name: &str) -> String {
    puuid.filter(|p| !p.is_empty()).unwrap_or(name).to_owned()
}

fn teammate_name(game_name: Option<&str>, tag_line: Option<&str>, participant_id: i64) -> String {
    display_name(game_name, tag_line).unwrap_or_else(|| format!("Player {participant_id}"))
}

db_row! {
    #[derive(Debug, Clone, PartialEq)]
    struct TeammateRow {
        game_id: i64,
        game_creation: i64,
        participant_id: i64,
        team_id: i64,
        puuid: Option<String>,
        game_name: Option<String>,
        tag_line: Option<String>,
        profile_icon: Option<i64>,
        champion_id: i64,
        win: i64,
        kills: i64,
        deaths: i64,
        assists: i64,
    }
}

impl TeammateRow {
    fn name(&self) -> String {
        teammate_name(
            self.game_name.as_deref(),
            self.tag_line.as_deref(),
            self.participant_id,
        )
    }

    fn key(&self, name: &str) -> String {
        teammate_key(self.puuid.as_deref(), name)
    }
}

fn marks(n: usize) -> String {
    vec!["?"; n].join(", ")
}

/// Every participant who shared a team with one of our accounts, one row per
/// player per game, newest first. Narrowed to one account, the team is the
/// side it played on, and the account itself is never a teammate.
fn teammate_rows(
    conn: &Connection,
    puuids: &[String],
    filter: &CareerFilter,
) -> rusqlite::Result<Vec<TeammateRow>> {
    let account = filter.account.as_deref().filter(|a| !a.is_empty());
    let team_owners: Vec<&str> = match account {
        Some(a) => vec![a],
        None => puuids.iter().map(String::as_str).collect(),
    };
    let mut ours: Vec<&str> = puuids.iter().map(String::as_str).collect();
    ours.extend(account);

    let mut w = Where {
        conditions: vec![
            "o.is_remake = 0".into(),
            format!(
                "(o.puuid IS NULL OR o.puuid NOT IN ({}))",
                marks(ours.len())
            ),
        ],
        params: ours.iter().map(|p| Sql::Text((*p).into())).collect(),
    };
    apply_queue_filter(conn, &mut w, filter.queue, "o")?;
    if let Some(a) = account {
        w.conditions.push("g.puuid = ?".into());
        w.params.push(Sql::Text(a.into()));
    }
    if let Some(from) = filter.from {
        w.conditions.push("g.game_creation >= ?".into());
        w.params.push(Sql::Integer(from));
    }
    if let Some(to) = filter.to {
        w.conditions.push("g.game_creation < ?".into());
        w.params.push(Sql::Integer(to));
    }

    let sql = format!(
        "
      WITH our_teams AS (
        SELECT DISTINCT game_id, team_id FROM match_participants
        WHERE puuid IN ({})
      )
      SELECT o.game_id, g.game_creation, o.participant_id, o.team_id, o.puuid, o.game_name,
             o.tag_line, o.profile_icon, o.champion_id, o.win, o.kills, o.deaths, o.assists
      FROM our_teams t
      JOIN match_participants o ON o.game_id = t.game_id AND o.team_id = t.team_id
      JOIN games g ON g.game_id = o.game_id
      WHERE {}
      ORDER BY g.game_creation DESC
    ",
        marks(team_owners.len()),
        w.conditions.join(" AND ")
    );
    let params: Vec<Sql> = team_owners
        .iter()
        .map(|p| Sql::Text((*p).into()))
        .chain(w.params)
        .collect();
    stmt::all(conn, &sql, rusqlite::params_from_iter(params))
}

struct PlayerTotals {
    name: String,
    puuid: Option<String>,
    profile_icon: Option<i64>,
    games: i64,
    wins: i64,
    kills: i64,
    deaths: i64,
    assists: i64,
    champions: JsMap<i64, i64>,
    last_played: i64,
}

/// `getTeammateStats`: narrowed by the same filter as the career queries, so
/// a season recap's friends come from the games the rest of the recap
/// counts. Players we've shared fewer than `min_games` games with are left
/// out.
pub fn get_teammate_stats(
    conn: &Connection,
    filter: &CareerFilter,
    min_games: i64,
) -> rusqlite::Result<Vec<TeammateStats>> {
    let puuids = get_all_puuids(conn)?;
    if puuids.is_empty() {
        return Ok(Vec::new());
    }

    let mut players: JsMap<String, PlayerTotals> = JsMap::new();
    for row in teammate_rows(conn, &puuids, filter)? {
        let name = row.name();
        let key = row.key(&name);

        // A player first seen without a puuid moves under it once a row
        // carries one
        if let Some(puuid) = row.puuid.as_ref().filter(|p| !p.is_empty())
            && !players.contains(puuid)
            && players
                .get(&name)
                .is_some_and(|old| old.puuid.as_ref().is_none_or(String::is_empty))
            && let Some(mut old) = players.delete(&name)
        {
            old.puuid = Some(puuid.clone());
            players.set(puuid.clone(), old);
        }

        if !players.contains(&key) {
            players.set(
                key.clone(),
                PlayerTotals {
                    name: name.clone(),
                    puuid: row.puuid.clone(),
                    profile_icon: None,
                    games: 0,
                    wins: 0,
                    kills: 0,
                    deaths: 0,
                    assists: 0,
                    champions: JsMap::new(),
                    last_played: 0,
                },
            );
        }

        let entry = players.get_mut(&key).expect("set above");
        if row.game_creation > entry.last_played {
            entry.name = name;
            if row.profile_icon.is_some() {
                entry.profile_icon = row.profile_icon;
            }
        }
        entry.games += 1;
        if row.win != 0 {
            entry.wins += 1;
        }
        entry.kills += row.kills;
        entry.deaths += row.deaths;
        entry.assists += row.assists;
        entry.last_played = entry.last_played.max(row.game_creation);
        let played = entry.champions.get(&row.champion_id).copied().unwrap_or(0);
        entry.champions.set(row.champion_id, played + 1);
    }

    let mut out: Vec<TeammateStats> = players
        .into_entries()
        .filter(|(_, p)| p.games >= min_games)
        .map(|(key, p)| {
            let mut champions: Vec<(i64, i64)> = p.champions.into_entries().collect();
            // Champion id breaks ties so the same five come back every time
            champions.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
            TeammateStats {
                key,
                name: p.name,
                puuid: p.puuid,
                profile_icon: p.profile_icon,
                games: p.games,
                wins: p.wins,
                kills: p.kills,
                deaths: p.deaths,
                assists: p.assists,
                champions: champions
                    .into_iter()
                    .take(5)
                    .map(|(champion_id, games)| TeammateChampionGames { champion_id, games })
                    .collect(),
                last_played: p.last_played,
            }
        })
        .collect();
    out.sort_by_key(|p| Reverse(p.games));
    Ok(out)
}

#[derive(Debug, Clone)]
struct GroupCandidate {
    key: String,
    name: String,
    profile_icon: Option<i64>,
    games: i64,
}

/// One game as a group played it: the friends on our side, most-played
/// first. `key` is the group the game belongs to.
struct GroupSide {
    key: String,
    roster: Vec<(usize, TeammateRow)>,
}

/// The people we play with, a game at a time: whoever on our team counts as
/// a friend makes up that game's group, so a trio's game goes to the trio
/// and not to the pairs inside it. Who counts is settled over every game, so
/// `filter` only picks which games are returned.
fn group_sides(
    conn: &Connection,
    puuids: &[String],
    filter: &CareerFilter,
) -> rusqlite::Result<(Vec<GroupCandidate>, Vec<GroupSide>)> {
    // Rows are newest-first, so the first hit carries the current name and icon
    let mut players: Vec<GroupCandidate> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    let every_game = teammate_rows(conn, puuids, &CareerFilter::default())?;
    for row in &every_game {
        let name = row.name();
        let key = row.key(&name);
        match index.get(&key) {
            Some(&i) => {
                let player = &mut players[i];
                player.games += 1;
                player.profile_icon = player.profile_icon.or(row.profile_icon);
            }
            None => {
                index.insert(key.clone(), players.len());
                players.push(GroupCandidate {
                    key,
                    name,
                    profile_icon: row.profile_icon,
                    games: 1,
                });
            }
        }
    }

    // Keyed by side rather than game: two of our accounts can meet on
    // opposite teams, and those are two rosters
    let mut sides: JsMap<(i64, i64), Vec<(usize, TeammateRow)>> = JsMap::new();
    let filtered = if *filter == CareerFilter::default() {
        every_game
    } else {
        teammate_rows(conn, puuids, filter)?
    };
    for row in filtered {
        let name = row.name();
        let Some(&i) = index.get(&row.key(&name)) else {
            continue;
        };
        if players[i].games < MIN_GROUP_MEMBER_GAMES {
            continue;
        }
        let id = (row.game_id, row.team_id);
        match sides.get_mut(&id) {
            Some(roster) => roster.push((i, row)),
            None => sides.set(id, vec![(i, row)]),
        }
    }

    let sides = sides
        .into_entries()
        .map(|(_, mut roster)| {
            // The key breaks ties so a roster reads the same from every game
            roster.sort_by(|(a, _), (b, _)| {
                let (a, b) = (&players[*a], &players[*b]);
                b.games
                    .cmp(&a.games)
                    .then_with(|| locale_compare(&a.key, &b.key))
            });
            let key = roster
                .iter()
                .map(|(i, _)| players[*i].key.as_str())
                .collect::<Vec<_>>()
                .join(",");
            GroupSide { key, roster }
        })
        .collect();
    Ok((players, sides))
}

db_row! {
    struct OurLine {
        game_id: i64,
        kills: Option<i64>,
        deaths: Option<i64>,
        assists: Option<i64>,
    }
}

fn tally_groups(
    conn: &Connection,
    players: &[GroupCandidate],
    sides: &[GroupSide],
) -> rusqlite::Result<Vec<TeammateGroup>> {
    let our_lines: Vec<OurLine> = stmt::all(
        conn,
        "SELECT game_id, kills, deaths, assists FROM player_stats",
        [],
    )?;
    let ours: HashMap<i64, OurLine> = our_lines.into_iter().map(|l| (l.game_id, l)).collect();

    let mut groups: JsMap<String, TeammateGroup> = JsMap::new();
    for side in sides {
        if !groups.contains(&side.key) {
            groups.set(
                side.key.clone(),
                TeammateGroup {
                    key: side.key.clone(),
                    members: side
                        .roster
                        .iter()
                        .map(|(i, _)| TeammateMember {
                            key: players[*i].key.clone(),
                            name: players[*i].name.clone(),
                            profile_icon: players[*i].profile_icon,
                        })
                        .collect(),
                    games: 0,
                    wins: 0,
                    kills: 0,
                    deaths: 0,
                    assists: 0,
                    last_played: 0,
                },
            );
        }
        let group = groups.get_mut(&side.key).expect("set above");
        let (_, row) = &side.roster[0];
        group.games += 1;
        if row.win != 0 {
            group.wins += 1;
        }
        let our = ours.get(&row.game_id);
        group.kills += our.and_then(|l| l.kills).unwrap_or(0);
        group.deaths += our.and_then(|l| l.deaths).unwrap_or(0);
        group.assists += our.and_then(|l| l.assists).unwrap_or(0);
        for (_, member) in &side.roster {
            group.kills += member.kills;
            group.deaths += member.deaths;
            group.assists += member.assists;
        }
        group.last_played = group.last_played.max(row.game_creation);
    }
    Ok(groups.into_entries().map(|(_, g)| g).collect())
}

/// `getTeammateGroups`.
pub fn get_teammate_groups(
    conn: &Connection,
    filter: &CareerFilter,
) -> rusqlite::Result<Vec<TeammateGroup>> {
    let puuids = get_all_puuids(conn)?;
    if puuids.is_empty() {
        return Ok(Vec::new());
    }
    let (players, sides) = group_sides(conn, &puuids, filter)?;
    let mut groups = tally_groups(conn, &players, &sides)?;
    groups.sort_by_key(|g| Reverse(g.games));
    Ok(groups)
}

/// `MATCH_ROW_SQL` and `GAME_MAX_STATS_SQL` in `src/main/db/matches.ts`.
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

/// A match list row, read by column name.
struct MatchRow(MatchListItem);

impl FromRow for MatchRow {
    const COLUMNS: &'static [&'static str] = &[
        "game_id",
        "queue_id",
        "game_creation",
        "game_duration",
        "is_remake",
        "favorite",
        "puuid",
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
        "total_heal",
        "gold_earned",
        "item0",
        "item1",
        "item2",
        "item3",
        "item4",
        "item5",
        "score",
        "score_badge",
        "spell1",
        "spell2",
        "augment_ids",
        "game_version",
        "game_max_dmg",
        "game_max_taken",
        "game_max_heal",
    ];

    fn from_row(row: &rusqlite::Row<'_>, at: &[usize]) -> rusqlite::Result<Self> {
        let badge: Option<String> = row.get(at[27])?;
        Ok(Self(MatchListItem {
            game_id: row.get(at[0])?,
            queue_id: row.get(at[1])?,
            game_creation: row.get(at[2])?,
            game_duration: row.get(at[3])?,
            is_remake: row.get(at[4])?,
            favorite: row.get(at[5])?,
            puuid: row.get(at[6])?,
            champion_id: row.get(at[7])?,
            win: row.get(at[8])?,
            kills: row.get(at[9])?,
            deaths: row.get(at[10])?,
            assists: row.get(at[11])?,
            double_kills: row.get(at[12])?,
            triple_kills: row.get(at[13])?,
            quadra_kills: row.get(at[14])?,
            penta_kills: row.get(at[15])?,
            total_damage_dealt: row.get(at[16])?,
            total_damage_taken: row.get(at[17])?,
            total_heal: row.get(at[18])?,
            gold_earned: row.get(at[19])?,
            item0: row.get(at[20])?,
            item1: row.get(at[21])?,
            item2: row.get(at[22])?,
            item3: row.get(at[23])?,
            item4: row.get(at[24])?,
            item5: row.get(at[25])?,
            score: row.get(at[26])?,
            score_badge: badge.as_deref().and_then(badge_named),
            spell1: row.get(at[28])?,
            spell2: row.get(at[29])?,
            augment_ids: row.get(at[30])?,
            game_version: row.get(at[31])?,
            game_max_dmg: row.get(at[32])?,
            game_max_taken: row.get(at[33])?,
            game_max_heal: row.get(at[34])?,
        }))
    }
}

fn badge_named(text: &str) -> Option<ScoreBadge> {
    match text {
        "MVP" => Some(ScoreBadge::Mvp),
        "ACE" => Some(ScoreBadge::Ace),
        _ => None,
    }
}

fn badge_of(badge: op_score::ScoreBadge) -> ScoreBadge {
    match badge {
        op_score::ScoreBadge::Mvp => ScoreBadge::Mvp,
        op_score::ScoreBadge::Ace => ScoreBadge::Ace,
    }
}

/// Our rows for a set of shared games, and every player's line in each.
type SharedGames = (Vec<MatchListItem>, HashMap<i64, Vec<ScoreRow>>);

/// Our own row for each of these games, as the match list shows it, plus
/// all ten players of each, which a teammate's score is computed from.
fn shared_game_rows(conn: &Connection, game_ids: &[i64]) -> rusqlite::Result<SharedGames> {
    let ids = marks(game_ids.len());
    let our_matches: Vec<MatchRow> = stmt::all(
        conn,
        &format!(
            "
      SELECT {MATCH_ROW_SQL}
      FROM games g
      JOIN player_stats ps ON g.game_id = ps.game_id
      WHERE g.game_id IN ({ids})
      ORDER BY g.game_creation DESC
    "
        ),
        rusqlite::params_from_iter(game_ids),
    )?;
    let score_rows: Vec<GameScoreRow> = stmt::all(
        conn,
        &format!(
            "SELECT game_id, {} FROM match_participants WHERE game_id IN ({ids})",
            super::scoring::SCORE_ROW_COLUMNS
        ),
        rusqlite::params_from_iter(game_ids),
    )?;
    Ok((
        our_matches.into_iter().map(|m| m.0).collect(),
        group_by_game(score_rows),
    ))
}

/// These teammates' lines in one game. A teammate's score is computed rather
/// than looked up, since `player_stats` only ever scores our own row.
fn teammate_lines(
    game_rows: &[ScoreRow],
    teammates: &[&TeammateRow],
    classes: &ChampionClassMap,
) -> Vec<TeammateLine> {
    let inputs: Vec<_> = game_rows.iter().map(ScoreRow::input).collect();
    let scores = compute_match_scores(&inputs, Some(classes));
    teammates
        .iter()
        .map(|row| {
            let id = row.participant_id as f64;
            let stats = game_rows.iter().find(|p| p.participant_id == id);
            let score = scores.get(id);
            TeammateLine {
                champion_id: row.champion_id,
                win: row.win,
                kills: row.kills,
                deaths: row.deaths,
                assists: row.assists,
                total_damage_dealt: stats.map_or(0, |s| s.total_damage_dealt as i64),
                total_damage_taken: stats.map_or(0, |s| s.total_damage_taken as i64),
                total_heal: stats.map_or(0, |s| s.total_heal as i64),
                score: score.map(|s| s.score),
                score_badge: score.and_then(|s| s.badge).map(badge_of),
            }
        })
        .collect()
}

/// `getTeammateGroupDetail`: every game one group played, with each
/// member's line in it.
pub fn get_teammate_group_detail(
    conn: &Connection,
    key: &str,
    classes: &ChampionClassMap,
) -> rusqlite::Result<Option<TeammateGroupDetail>> {
    let puuids = get_all_puuids(conn)?;
    if puuids.is_empty() {
        return Ok(None);
    }

    let (players, sides) = group_sides(conn, &puuids, &CareerFilter::default())?;
    let sides: Vec<GroupSide> = sides.into_iter().filter(|s| s.key == key).collect();
    let Some(group) = tally_groups(conn, &players, &sides)?.into_iter().next() else {
        return Ok(None);
    };

    let mut by_game: JsMap<i64, &GroupSide> = JsMap::new();
    for side in &sides {
        by_game.set(side.roster[0].1.game_id, side);
    }
    let ids: Vec<i64> = by_game.keys().copied().collect();
    let (our_matches, score_rows) = shared_game_rows(conn, &ids)?;

    let matches = our_matches
        .into_iter()
        .map(|game| {
            let side = by_game.get(&game.game_id).expect("queried by these ids");
            let rows: Vec<&TeammateRow> = side.roster.iter().map(|(_, row)| row).collect();
            let members = teammate_lines(
                score_rows.get(&game.game_id).map_or(&[][..], Vec::as_slice),
                &rows,
                classes,
            );
            TeammateGroupMatch { game, members }
        })
        .collect();
    Ok(Some(TeammateGroupDetail { group, matches }))
}

#[derive(Default)]
struct ChampionTotals {
    games: i64,
    wins: i64,
    kills: i64,
    deaths: i64,
    assists: i64,
}

/// `getTeammateDetail`: every game we played alongside one teammate, our
/// stored stats for the row plus the teammate's own line in that game.
pub fn get_teammate_detail(
    conn: &Connection,
    key: &str,
    classes: &ChampionClassMap,
) -> rusqlite::Result<Option<TeammateDetail>> {
    let puuids = get_all_puuids(conn)?;
    if puuids.is_empty() {
        return Ok(None);
    }

    // Older games can be missing puuids; once we know who we're looking at,
    // match those on name too, the same merge the Friends list does
    let mut theirs: Vec<TeammateRow> = Vec::new();
    let mut name: Option<String> = None;
    for row in teammate_rows(conn, &puuids, &CareerFilter::default())? {
        let row_name = row.name();
        if row.key(&row_name) == key {
            name.get_or_insert(row_name);
            theirs.push(row);
        } else if row.puuid.is_none() && name.as_deref() == Some(row_name.as_str()) {
            theirs.push(row);
        }
    }
    let Some(first) = theirs.first() else {
        return Ok(None);
    };

    let mut by_game: JsMap<i64, &TeammateRow> = JsMap::new();
    for row in &theirs {
        by_game.set(row.game_id, row);
    }
    let ids: Vec<i64> = by_game.keys().copied().collect();
    let (our_matches, score_rows) = shared_game_rows(conn, &ids)?;

    let mut player = TeammateProfile {
        key: key.to_owned(),
        name: name.unwrap_or_else(|| key.to_owned()),
        puuid: first.puuid.clone(),
        profile_icon: first.profile_icon,
        games: 0,
        wins: 0,
        kills: 0,
        deaths: 0,
        assists: 0,
        champions: Vec::new(),
        last_played: first.game_creation,
    };
    let mut champions: JsMap<i64, ChampionTotals> = JsMap::new();
    let mut matches = Vec::new();

    for game in our_matches {
        let Some(&friend) = by_game.get(&game.game_id) else {
            continue;
        };
        if player.profile_icon.is_none() {
            player.profile_icon = friend.profile_icon;
        }

        let won = i64::from(friend.win != 0);
        player.games += 1;
        player.wins += won;
        player.kills += friend.kills;
        player.deaths += friend.deaths;
        player.assists += friend.assists;

        if !champions.contains(&friend.champion_id) {
            champions.set(friend.champion_id, ChampionTotals::default());
        }
        let champ = champions.get_mut(&friend.champion_id).expect("set above");
        champ.games += 1;
        champ.wins += won;
        champ.kills += friend.kills;
        champ.deaths += friend.deaths;
        champ.assists += friend.assists;

        let line = teammate_lines(
            score_rows.get(&game.game_id).map_or(&[][..], Vec::as_slice),
            &[friend],
            classes,
        )
        .remove(0);
        matches.push(TeammateMatch { game, friend: line });
    }

    if player.games == 0 {
        return Ok(None);
    }
    player.champions = champions
        .into_entries()
        .map(|(champion_id, t)| TeammateChampionStats {
            champion_id,
            games: t.games,
            wins: t.wins,
            kills: t.kills,
            deaths: t.deaths,
            assists: t.assists,
        })
        .collect();
    player.champions.sort_by_key(|c| Reverse(c.games));
    Ok(Some(TeammateDetail { player, matches }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema;

    const ME: &str = "me-puuid";

    fn library() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        schema::init_database(&conn, 0).unwrap();
        conn.execute(
            "INSERT INTO summoner (puuid, game_name, tag_line, updated_at) VALUES (?, 'Me', 'NA1', 0)",
            [ME],
        )
        .unwrap();
        conn
    }

    /// One game we won on team 100, with `mates` beside us as
    /// (puuid, game name, tag line).
    fn game(conn: &Connection, id: i64, mates: &[(Option<&str>, &str, &str)]) {
        conn.execute(
            "INSERT INTO games (game_id, queue_id, game_mode, game_creation, game_duration, puuid)
             VALUES (?, 2400, 'KIWI', ?, 900, ?)",
            rusqlite::params![id, id * 1000, ME],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO player_stats (game_id, champion_id, win, kills, deaths, assists)
             VALUES (?, 1, 1, 5, 2, 7)",
            [id],
        )
        .unwrap();
        let mut players = vec![(Some(ME), "Me", "NA1")];
        players.extend_from_slice(mates);
        for (i, (puuid, name, tag)) in players.iter().enumerate() {
            conn.execute(
                "INSERT INTO match_participants (game_id, participant_id, puuid, game_name, tag_line,
                   team_id, champion_id, win, kills, deaths, assists, queue_id)
                 VALUES (?, ?, ?, ?, ?, 100, ?, 1, 3, 4, 5, 2400)",
                rusqlite::params![id, i as i64 + 1, puuid, name, tag, 10 + i as i64],
            )
            .unwrap();
        }
    }

    #[test]
    fn a_key_with_a_hash_in_the_tag_line_round_trips() {
        let conn = library();
        game(&conn, 1, &[(None, "Foo", "B#R")]);
        game(&conn, 2, &[(None, "Foo", "B#R")]);
        let stats = get_teammate_stats(&conn, &CareerFilter::default(), 1).unwrap();
        assert_eq!(stats.len(), 1);
        assert_eq!(stats[0].key, "Foo#B#R");
        let detail = get_teammate_detail(&conn, &stats[0].key, &ChampionClassMap::new())
            .unwrap()
            .expect("the friend from the list");
        assert_eq!(detail.player.name, "Foo#B#R");
        assert_eq!(detail.player.games, 2);
        assert_eq!(detail.matches.len(), 2);
    }

    #[test]
    fn a_player_seen_by_name_first_moves_under_their_puuid() {
        let conn = library();
        game(&conn, 1, &[(Some("p-1"), "Old", "EUW")]);
        game(&conn, 2, &[(None, "Old", "EUW")]);
        let stats = get_teammate_stats(&conn, &CareerFilter::default(), 1).unwrap();
        let keys: Vec<(&str, i64)> = stats.iter().map(|s| (s.key.as_str(), s.games)).collect();
        assert_eq!(keys, [("p-1", 2)]);
        assert_eq!(stats[0].puuid.as_deref(), Some("p-1"));
    }

    #[test]
    fn a_name_only_row_older_than_the_puuid_stays_apart_in_the_list() {
        let conn = library();
        game(&conn, 1, &[(None, "Old", "EUW")]);
        game(&conn, 2, &[(Some("p-1"), "Old", "EUW")]);
        let stats = get_teammate_stats(&conn, &CareerFilter::default(), 1).unwrap();
        let keys: Vec<&str> = stats.iter().map(|s| s.key.as_str()).collect();
        assert_eq!(keys, ["p-1", "Old#EUW"]);
        // The detail matches the older row on name once it knows who it is
        let detail = get_teammate_detail(&conn, "p-1", &ChampionClassMap::new())
            .unwrap()
            .unwrap();
        assert_eq!(detail.player.games, 2);
    }

    #[test]
    fn groups_take_friends_with_three_games_and_order_them_by_locale() {
        let conn = library();
        let trio = [(Some("b-x"), "Bee", "1"), (Some("A-y"), "Ay", "1")];
        for id in 1..=3 {
            game(&conn, id, &trio);
        }
        game(
            &conn,
            4,
            &[(Some("b-x"), "Bee", "1"), (Some("once"), "Once", "1")],
        );
        let groups = get_teammate_groups(&conn, &CareerFilter::default()).unwrap();
        let keys: Vec<(&str, i64)> = groups.iter().map(|g| (g.key.as_str(), g.games)).collect();
        // "b-x" has four games, so it leads; "once" never counts as a friend
        assert_eq!(keys, [("b-x,A-y", 3), ("b-x", 1)]);
        let detail = get_teammate_group_detail(&conn, "b-x,A-y", &ChampionClassMap::new())
            .unwrap()
            .unwrap();
        assert_eq!(detail.matches.len(), 3);
        assert_eq!(detail.matches[0].members.len(), 2);
        assert_eq!(detail.group.kills, 3 * (5 + 3 + 3));
        assert!(
            get_teammate_group_detail(&conn, "A-y,b-x", &ChampionClassMap::new())
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn a_season_filter_picks_games_but_not_who_counts() {
        let conn = library();
        for id in 1..=3 {
            game(&conn, id, &[(Some("f"), "F", "1")]);
        }
        let late = CareerFilter {
            from: Some(3000),
            ..CareerFilter::default()
        };
        let groups = get_teammate_groups(&conn, &late).unwrap();
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].games, 1);
        assert!(
            get_teammate_stats(&conn, &late, MIN_SHARED_GAMES)
                .unwrap()
                .is_empty()
        );
    }
}
