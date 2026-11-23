//! `src/main/db/recap.ts` for `db:game-recap`, and the game card's data for
//! `db:game-card`, with the pieces of `matches.ts`, `live.ts` and
//! `challenges.ts` the two read.
//!
//! T13 ports `getMatchDetail` for `db:match-detail` in parallel; once both
//! land, one copy should serve both.

use std::collections::HashMap;

use jiff::tz::TimeZone;
use rusqlite::{Connection, OptionalExtension};

use super::num::Num;
use super::records::{CareerFilter, CareerRow, career_rows, higher, lower};
use super::stmt;
use crate::commands::recap::{
    GameCardData, GameRecap, RecapCareer, RecapChallenge, RecapChampion, RecapFormat,
    RecapMilestone, RecapPlacement, RecapSession, RecapSessionGame, RecapStreak, StreakKind,
};
use crate::commands::types::{
    ChallengeLevel, GameAugment, GameRecord, MatchDetail, MatchParticipantRecord,
    PlayerStatsRecord, ScoreBadge,
};
use crate::db::js::number_to_string;
use crate::db_row;
use crate::intl::format_integer;
use crate::session::session_day;
use crate::text::ordinal;

/// `ARAM_S_GRADE_CHALLENGE_ID` in `src/shared/challenges.ts`.
const ARAM_S_GRADE_CHALLENGE_ID: i64 = 101301;

fn score_badge(raw: Option<&str>) -> Option<ScoreBadge> {
    match raw? {
        "MVP" => Some(ScoreBadge::Mvp),
        "ACE" => Some(ScoreBadge::Ace),
        _ => None,
    }
}

db_row! {
    struct GameRow {
        game_id: i64,
        queue_id: i64,
        game_mode: String,
        game_creation: i64,
        game_duration: i64,
        is_remake: Option<i64>,
        puuid: Option<String>,
        game_version: Option<String>,
        favorite: Option<i64>,
    }
}

db_row! {
    struct StatsRow {
        game_id: i64,
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
        score: Option<f64>,
        score_raw: Option<f64>,
        score_badge: Option<String>,
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

db_row! {
    struct AugmentRow { game_id: i64, slot: i64, augment_id: i64 }
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

db_row! {
    struct ParticipantAugmentRow { participant_id: i64, augment_id: i64 }
}

fn match_participants(
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
    let augment_rows: Vec<ParticipantAugmentRow> = stmt::all(
        conn,
        "
      SELECT participant_id, augment_id
      FROM match_participant_augments
      WHERE game_id = ?
      ORDER BY participant_id, slot
    ",
        [game_id],
    )?;
    let mut augments: HashMap<i64, Vec<i64>> = HashMap::new();
    for row in augment_rows {
        augments
            .entry(row.participant_id)
            .or_default()
            .push(row.augment_id);
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
            .map(|i| i.unwrap_or(0))
            .to_vec(),
            augments: augments.remove(&r.participant_id).unwrap_or_default(),
        })
        .collect())
}

/// `getMatchDetail`. A game with no `player_stats` row would send no
/// `stats` at all, which `MatchDetail` cannot carry; ingest writes both rows
/// in one transaction, so such a game is reported as an error.
pub fn match_detail(conn: &Connection, game_id: i64) -> rusqlite::Result<Option<MatchDetail>> {
    let Some(g) = stmt::first::<GameRow>(
        conn,
        "
      SELECT game_id, queue_id, game_mode, game_creation, game_duration,
             is_remake, puuid, game_version, favorite
      FROM games WHERE game_id = ?
    ",
        [game_id],
    )?
    else {
        return Ok(None);
    };
    let s = stmt::first::<StatsRow>(
        conn,
        "SELECT * FROM player_stats WHERE game_id = ?",
        [game_id],
    )?
    .ok_or(rusqlite::Error::QueryReturnedNoRows)?;
    let augments = stmt::all::<AugmentRow>(
        conn,
        "SELECT * FROM game_augments WHERE game_id = ? ORDER BY slot",
        [game_id],
    )?
    .into_iter()
    .map(|a| GameAugment {
        game_id: a.game_id,
        slot: a.slot,
        augment_id: a.augment_id,
    })
    .collect();
    Ok(Some(MatchDetail {
        game: GameRecord {
            game_id: g.game_id,
            queue_id: g.queue_id,
            game_mode: g.game_mode,
            game_creation: g.game_creation,
            game_duration: g.game_duration,
            puuid: g.puuid,
            game_version: g.game_version,
            is_remake: g.is_remake,
            favorite: g.favorite,
        },
        stats: PlayerStatsRecord {
            game_id: s.game_id,
            champion_id: s.champion_id,
            win: s.win,
            kills: s.kills,
            deaths: s.deaths,
            assists: s.assists,
            double_kills: s.double_kills,
            triple_kills: s.triple_kills,
            quadra_kills: s.quadra_kills,
            penta_kills: s.penta_kills,
            total_damage_dealt: s.total_damage_dealt,
            total_damage_taken: s.total_damage_taken,
            gold_earned: s.gold_earned,
            total_heal: s.total_heal,
            largest_killing_spree: s.largest_killing_spree,
            score: s.score,
            score_raw: s.score_raw,
            score_badge: score_badge(s.score_badge.as_deref()),
            spell1: s.spell1,
            spell2: s.spell2,
            item0: s.item0,
            item1: s.item1,
            item2: s.item2,
            item3: s.item3,
            item4: s.item4,
            item5: s.item5,
            item6: s.item6,
        },
        augments,
        participants: match_participants(conn, game_id)?,
    }))
}

/// `mapNameForSkin` in `src/shared/maps.ts`.
fn map_name_for_skin(skin: Option<&str>) -> Option<String> {
    let skin = skin.filter(|s| !s.is_empty())?;
    Some(match skin {
        "Default" => "Howling Abyss".into(),
        "Bilgewater" => "Butcher's Bridge".into(),
        "Bloom" => "Koeshin's Crossing".into(),
        other => other.replace('_', " "),
    })
}

/// `getGameMapName`.
pub fn game_map_name(conn: &Connection, game_id: i64) -> rusqlite::Result<Option<String>> {
    let skin: Option<String> = conn
        .prepare_cached("SELECT map_skin FROM match_maps WHERE game_id = ?")?
        .query_row([game_id], |row| row.get(0))
        .optional()?;
    Ok(map_name_for_skin(skin.as_deref()))
}

/// `getGameProfileIcon`: the icon the account wore in that game, else the
/// account's icon as it stands now.
pub fn game_profile_icon(conn: &Connection, game_id: i64) -> rusqlite::Result<Option<i64>> {
    let puuid: Option<String> = conn
        .prepare_cached("SELECT puuid FROM games WHERE game_id = ?")?
        .query_row([game_id], |row| row.get(0))
        .optional()?;
    let Some(puuid) = puuid.filter(|p| !p.is_empty()) else {
        return Ok(None);
    };
    let played: Option<Option<i64>> = conn
        .prepare_cached(
            "SELECT profile_icon FROM match_participants WHERE game_id = ? AND puuid = ?",
        )?
        .query_row(rusqlite::params![game_id, puuid], |row| row.get(0))
        .optional()?;
    if let Some(Some(icon)) = played {
        return Ok(Some(icon));
    }
    let account: Option<Option<i64>> = conn
        .prepare_cached("SELECT profile_icon FROM summoner WHERE puuid = ?")?
        .query_row([puuid], |row| row.get(0))
        .optional()?;
    Ok(account.flatten())
}

/// The `db:game-card` handler: the match, its map, and the icon to draw.
pub fn get_game_card(conn: &Connection, game_id: i64) -> rusqlite::Result<Option<GameCardData>> {
    let Some(detail) = match_detail(conn, game_id)? else {
        return Ok(None);
    };
    Ok(Some(GameCardData {
        detail,
        map_name: game_map_name(conn, game_id)?,
        profile_icon: game_profile_icon(conn, game_id)?,
    }))
}

db_row! {
    struct ChallengeRow {
        challenge_id: i64,
        name: String,
        description: String,
        previous_value: f64,
        current_value: f64,
        previous_level: String,
        current_level: String,
        next_level: Option<String>,
        next_threshold: Option<f64>,
        icon_path: String,
    }
}

fn level(raw: &str) -> rusqlite::Result<ChallengeLevel> {
    serde_json::from_value(serde_json::Value::String(raw.into())).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, e.into())
    })
}

/// `getGameChallenges`: a tier earned comes first, the rest in the order the
/// client listed them.
fn game_challenges(conn: &Connection, game_id: i64) -> rusqlite::Result<Vec<RecapChallenge>> {
    stmt::all::<ChallengeRow>(
        conn,
        "
      SELECT challenge_id, name, description, previous_value, current_value,
             previous_level, current_level, next_level, next_threshold, icon_path
      FROM challenge_game_progress
      WHERE game_id = ?
      ORDER BY (previous_level = current_level), challenge_id
    ",
        [game_id],
    )?
    .into_iter()
    .map(|c| {
        Ok(RecapChallenge {
            id: c.challenge_id,
            name: c.name,
            description: c.description,
            previous_value: c.previous_value,
            current_value: c.current_value,
            previous_level: level(&c.previous_level)?,
            current_level: level(&c.current_level)?,
            next_level: c.next_level.as_deref().map(level).transpose()?,
            next_threshold: c.next_threshold,
            icon_path: c.icon_path,
        })
    })
    .collect()
}

fn is_mvp(r: &CareerRow) -> bool {
    r.score_badge.as_deref() == Some("MVP")
}

/// The biggest listed mark a running total passed on this game.
fn crossed_mark(before: f64, after: f64, marks: &[i64]) -> Option<i64> {
    marks
        .iter()
        .copied()
        .filter(|&m| before < m as f64 && after >= m as f64)
        .max()
}

/// Repeating marks, for totals that keep climbing past any list.
fn crossed_step(before: f64, after: f64, step: i64) -> Option<i64> {
    let mark = (after / step as f64).floor() * step as f64;
    (mark > 0.0 && before < mark).then_some(mark as i64)
}

struct PlacementDef {
    key: &'static str,
    label: &'static str,
    format: RecapFormat,
    good: bool,
    value: fn(&CareerRow) -> Option<f64>,
    /// What the placement is ranked on, where that differs from the value.
    ranked_on: Option<fn(&CareerRow) -> Option<f64>>,
    better: fn(f64, f64) -> bool,
}

const PLACEMENTS: [PlacementDef; 12] = [
    PlacementDef {
        key: "kills",
        label: "Kills",
        format: RecapFormat::Int,
        good: true,
        value: |r| Some(r.kills.0),
        ranked_on: None,
        better: higher,
    },
    PlacementDef {
        key: "kda",
        label: "KDA",
        format: RecapFormat::Kda,
        good: true,
        value: |r| Some((r.kills.0 + r.assists.0) / r.deaths.0.max(1.0)),
        ranked_on: None,
        better: higher,
    },
    PlacementDef {
        key: "score",
        label: "Score",
        format: RecapFormat::Score,
        good: true,
        value: |r| r.score,
        // Shown clamped, ranked raw, so games that both show 10 still order
        ranked_on: Some(|r| r.score_raw.or(r.score)),
        better: higher,
    },
    PlacementDef {
        key: "assists",
        label: "Assists",
        format: RecapFormat::Int,
        good: true,
        value: |r| Some(r.assists.0),
        ranked_on: None,
        better: higher,
    },
    PlacementDef {
        key: "killingSpree",
        label: "Killing spree",
        format: RecapFormat::Int,
        good: true,
        value: |r| Some(r.largest_killing_spree.0),
        ranked_on: None,
        better: higher,
    },
    PlacementDef {
        key: "damage",
        label: "Damage dealt",
        format: RecapFormat::Compact,
        good: true,
        value: |r| Some(r.total_damage_dealt.0),
        ranked_on: None,
        better: higher,
    },
    PlacementDef {
        key: "damageTaken",
        label: "Damage taken",
        format: RecapFormat::Compact,
        good: true,
        value: |r| Some(r.total_damage_taken.0),
        ranked_on: None,
        better: higher,
    },
    PlacementDef {
        key: "healing",
        label: "Healing",
        format: RecapFormat::Compact,
        good: true,
        value: |r| Some(r.total_heal.0),
        ranked_on: None,
        better: higher,
    },
    PlacementDef {
        key: "gold",
        label: "Gold earned",
        format: RecapFormat::Compact,
        good: true,
        value: |r| Some(r.gold_earned.0),
        ranked_on: None,
        better: higher,
    },
    PlacementDef {
        key: "deaths",
        label: "Deaths",
        format: RecapFormat::Int,
        good: false,
        value: |r| Some(r.deaths.0),
        ranked_on: None,
        better: higher,
    },
    PlacementDef {
        key: "fastestWin",
        label: "Fastest win",
        format: RecapFormat::Duration,
        good: true,
        value: |r| (r.win.0 != 0.0).then_some(r.game_duration.0),
        ranked_on: None,
        better: lower,
    },
    PlacementDef {
        key: "longestGame",
        label: "Longest game",
        format: RecapFormat::Duration,
        good: true,
        value: |r| Some(r.game_duration.0),
        ranked_on: None,
        better: higher,
    },
];

/// Deep enough to be worth saying, shallow enough that an ordinary stat
/// isn't listed as though it weren't.
const MAX_PLACEMENT_RANK: i64 = 10;

fn build_placements(rows: &[CareerRow], row: &CareerRow) -> Vec<RecapPlacement> {
    let mut placements = Vec::new();
    for def in &PLACEMENTS {
        let ranked_on = def.ranked_on.unwrap_or(def.value);
        let (Some(value), Some(mark)) = ((def.value)(row), ranked_on(row)) else {
            continue;
        };
        let mut rank = 1;
        let mut total = 0;
        for other in rows {
            let Some(other_mark) = ranked_on(other) else {
                continue;
            };
            total += 1;
            // Strictly better only, so a tie shares the rank
            if other.game_id != row.game_id && (def.better)(other_mark, mark) {
                rank += 1;
            }
        }
        if rank <= MAX_PLACEMENT_RANK {
            placements.push(RecapPlacement {
                key: def.key.into(),
                label: def.label.into(),
                value,
                rank,
                total,
                good: def.good,
                format: def.format,
            });
        }
    }
    placements.sort_by_key(|p| p.rank);
    placements
}

fn build_milestones(rows: &[CareerRow], index: usize, locale: Option<&str>) -> Vec<RecapMilestone> {
    let row = &rows[index];
    let mut milestones = Vec::new();
    let mut add = |key: &str, label: String, detail: &str| {
        milestones.push(RecapMilestone {
            key: key.into(),
            label,
            detail: detail.into(),
        });
    };

    // Every total a double, as JavaScript keeps them
    let [mut wins, mut kills, mut mvps, mut pentas, mut quadras] = [0.0; 5];
    let (mut champ_games, mut champ_wins) = (0.0, 0.0);
    for r in &rows[..=index] {
        wins += r.win.0;
        kills += r.kills.0;
        if is_mvp(r) {
            mvps += 1.0;
        }
        pentas += r.penta_kills.0;
        quadras += r.quadra_kills.0;
        if r.champion_id == row.champion_id {
            champ_games += 1.0;
            champ_wins += r.win.0;
        }
    }

    let games = index as f64 + 1.0;
    let games_mark = crossed_mark(games - 1.0, games, &[10, 25, 50])
        .or_else(|| crossed_step(games - 1.0, games, 100));
    if let Some(mark) = games_mark {
        add(
            "games",
            format!("{} game", ordinal(mark, locale)),
            "Across every tracked account",
        );
    }

    let wins_mark = crossed_mark(wins - row.win.0, wins, &[10, 25, 50])
        .or_else(|| crossed_step(wins - row.win.0, wins, 100));
    if let Some(mark) = wins_mark {
        add(
            "wins",
            format!("{} win", ordinal(mark, locale)),
            "Career wins",
        );
    }

    if let Some(mark) = crossed_step(kills - row.kills.0, kills, 1000) {
        add(
            "kills",
            format!("{} career kills", format_integer(mark, locale)),
            "Every game, every champion",
        );
    }

    if champ_games == 1.0 {
        add(
            "champion-first",
            "First game on this champion".into(),
            "A new name on the list",
        );
    } else if let Some(mark) =
        crossed_mark(champ_games - 1.0, champ_games, &[5, 10, 25, 50, 100, 200])
    {
        add(
            "champion-games",
            format!("{} game on this champion", ordinal(mark, locale)),
            "Career games on this pick",
        );
    }

    if let Some(mark) = crossed_mark(champ_wins - row.win.0, champ_wins, &[5, 10, 25, 50, 100]) {
        add(
            "champion-wins",
            format!("{} win on this champion", ordinal(mark, locale)),
            "Career wins on this pick",
        );
    }

    if row.penta_kills.0 > 0.0 {
        let label = if pentas == row.penta_kills.0 {
            "First pentakill".into()
        } else {
            format!("{} pentakill", ordinal(pentas as i64, locale))
        };
        add("penta", label, "The rarest one");
    } else if row.quadra_kills.0 > 0.0 && quadras == row.quadra_kills.0 {
        add("quadra", "First quadra kill".into(), "So close");
    }

    if is_mvp(row) {
        let mvp_mark = crossed_mark(mvps - 1.0, mvps, &[1, 5, 10, 25, 50])
            .or_else(|| crossed_step(mvps - 1.0, mvps, 50));
        match mvp_mark {
            Some(1) => add("mvp", "First MVP".into(), "Best player on the winning team"),
            Some(mark) => add(
                "mvp",
                format!("{} MVP", ordinal(mark, locale)),
                "Best player on the winning team",
            ),
            None => {}
        }
    }

    milestones
}

/// The streak this game leaves us on, and whether it is the longest of its
/// kind. A single loss is a streak of one.
fn build_streak(rows: &[CareerRow], index: usize) -> RecapStreak {
    let win = rows[index].win;
    let length = rows[..=index]
        .iter()
        .rev()
        .take_while(|r| r.win == win)
        .count() as i64;
    let mut best = 0;
    let mut run = 0;
    for (i, r) in rows.iter().enumerate() {
        run = if i > 0 && r.win == rows[i - 1].win {
            run + 1
        } else {
            1
        };
        if r.win == win && run > best {
            best = run;
        }
    }
    RecapStreak {
        kind: if win.0 != 0.0 {
            StreakKind::Win
        } else {
            StreakKind::Loss
        },
        length,
        best,
        is_record: length >= best && length > 1,
    }
}

/// `getGameRecap`: the match, where its numbers land among every game on
/// record, the day around it, and which marks it moved past. A remake is in
/// no aggregate, so it has no placements, milestones or streak.
pub fn get_game_recap(
    conn: &Connection,
    game_id: Option<i64>,
    locale: Option<&str>,
    tz: &TimeZone,
) -> rusqlite::Result<Option<GameRecap>> {
    let rows = career_rows(conn, &CareerFilter::default())?;
    let Some(id) = game_id.or_else(|| rows.last().map(|r| r.game_id)) else {
        return Ok(None);
    };
    let Some(detail) = match_detail(conn, id)? else {
        return Ok(None);
    };

    let index = rows.iter().position(|r| r.game_id == id);
    let row = index.map(|i| &rows[i]);

    let day = session_day(detail.game.game_creation, tz);
    let session_rows: Vec<&CareerRow> = rows
        .iter()
        .filter(|r| session_day(r.game_creation, tz) == day)
        .collect();
    let mut session = RecapSession {
        day,
        index: session_rows
            .iter()
            .position(|r| r.game_id == id)
            .map_or(-1, |i| i as i64),
        games: session_rows
            .iter()
            .map(|r| RecapSessionGame {
                game_id: r.game_id,
                game_creation: r.game_creation,
                game_duration: r.game_duration,
                champion_id: r.champion_id,
                win: r.win,
                kills: r.kills,
                deaths: r.deaths,
                assists: r.assists,
                score: r.score,
            })
            .collect(),
        wins: 0,
        losses: 0,
        kills: Num::default(),
        deaths: Num::default(),
        assists: Num::default(),
        avg_score: None,
        duration: Num::default(),
    };
    let (mut session_score, mut session_scored) = (0.0, 0);
    for r in &session_rows {
        if r.win.0 != 0.0 {
            session.wins += 1;
        } else {
            session.losses += 1;
        }
        session.kills += r.kills;
        session.deaths += r.deaths;
        session.assists += r.assists;
        session.duration += r.game_duration;
        if let Some(score) = r.score {
            session_score += score;
            session_scored += 1;
        }
    }
    if session_scored > 0 {
        session.avg_score = Some(session_score / session_scored as f64);
    }

    let champion_id = detail.stats.champion_id;
    let champion_rows: Vec<&CareerRow> = rows
        .iter()
        .filter(|r| r.champion_id == champion_id)
        .collect();
    let mut champion = RecapChampion {
        champion_id,
        games: champion_rows.len() as i64,
        wins: Num::default(),
        kills: Num::default(),
        deaths: Num::default(),
        assists: Num::default(),
        avg_score: None,
        previous_best: None,
        first_time: row.is_some_and(|row| {
            champion_rows
                .iter()
                .filter(|r| r.game_creation <= row.game_creation)
                .count()
                == 1
        }),
    };
    let (mut champ_score, mut champ_scored) = (0.0, 0);
    for r in &champion_rows {
        champion.wins += r.win;
        champion.kills += r.kills;
        champion.deaths += r.deaths;
        champion.assists += r.assists;
        if let Some(score) = r.score {
            champ_score += score;
            champ_scored += 1;
            if r.game_id != id && champion.previous_best.is_none_or(|best| score > best) {
                champion.previous_best = Some(score);
            }
        }
    }
    if champ_scored > 0 {
        champion.avg_score = Some(champ_score / champ_scored as f64);
    }

    let mut career = RecapCareer {
        games: rows.len() as i64,
        wins: Num::default(),
        avg_score: None,
        avg_kills: 0.0,
        avg_deaths: 0.0,
        avg_assists: 0.0,
        avg_damage: 0.0,
        avg_taken: 0.0,
        avg_heal: 0.0,
        avg_gold: 0.0,
    };
    let (mut career_score, mut career_scored) = (0.0, 0);
    for r in &rows {
        career.wins += r.win;
        career.avg_kills += r.kills.0;
        career.avg_deaths += r.deaths.0;
        career.avg_assists += r.assists.0;
        career.avg_damage += r.total_damage_dealt.0;
        career.avg_taken += r.total_damage_taken.0;
        career.avg_heal += r.total_heal.0;
        career.avg_gold += r.gold_earned.0;
        if let Some(score) = r.score {
            career_score += score;
            career_scored += 1;
        }
    }
    if !rows.is_empty() {
        let n = rows.len() as f64;
        for avg in [
            &mut career.avg_kills,
            &mut career.avg_deaths,
            &mut career.avg_assists,
            &mut career.avg_damage,
            &mut career.avg_taken,
            &mut career.avg_heal,
            &mut career.avg_gold,
        ] {
            *avg /= n;
        }
    }
    if career_scored > 0 {
        career.avg_score = Some(career_score / career_scored as f64);
    }

    let challenges = game_challenges(conn, id)?;
    let mut milestones = index.map_or_else(Vec::new, |i| build_milestones(&rows, i, locale));
    // The S- challenge counts champions, so it only moves on one a champion
    // has never earned before
    if let Some(s_grade) = challenges
        .iter()
        .find(|c| c.id == ARAM_S_GRADE_CHALLENGE_ID && c.current_value > c.previous_value)
    {
        milestones.push(RecapMilestone {
            key: "challenge-s-grade".into(),
            label: "First S on this champion".into(),
            detail: format!(
                "{}: {} champions",
                s_grade.name,
                number_to_string(s_grade.current_value)
            ),
        });
    }

    Ok(Some(GameRecap {
        map_name: game_map_name(conn, id)?,
        score: detail.stats.score,
        score_badge: detail.stats.score_badge,
        placements: row.map_or_else(Vec::new, |row| build_placements(&rows, row)),
        milestones,
        session,
        streak: index.map(|i| build_streak(&rows, i)),
        champion,
        career,
        challenges,
        detail,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_largest_mark_crossed_wins() {
        assert_eq!(crossed_mark(9.0, 26.0, &[10, 25, 50]), Some(25));
        assert_eq!(crossed_mark(10.0, 11.0, &[10, 25, 50]), None);
        assert_eq!(crossed_step(199.0, 200.0, 100), Some(200));
        assert_eq!(crossed_step(200.0, 201.0, 100), None);
        assert_eq!(crossed_step(0.0, 99.0, 100), None);
    }

    #[test]
    fn unknown_map_skins_read_as_names() {
        assert_eq!(
            map_name_for_skin(Some("Default")).as_deref(),
            Some("Howling Abyss")
        );
        assert_eq!(
            map_name_for_skin(Some("Snow_Down")).as_deref(),
            Some("Snow Down")
        );
        assert_eq!(map_name_for_skin(Some("")), None);
        assert_eq!(map_name_for_skin(None), None);
    }

    struct Game {
        id: i64,
        at: &'static str,
        champion: i64,
        win: i64,
        kills: i64,
        score: Option<f64>,
        remake: i64,
    }

    const fn game(id: i64, at: &'static str, champion: i64, win: i64, kills: i64) -> Game {
        Game {
            id,
            at,
            champion,
            win,
            kills,
            score: Some(5.0),
            remake: 0,
        }
    }

    fn library(games: &[Game]) -> (Connection, TimeZone) {
        let tz = TimeZone::get("America/New_York").unwrap();
        let conn = Connection::open_in_memory().unwrap();
        crate::db::schema::init_database(&conn, 0).unwrap();
        for g in games {
            let wall: jiff::civil::DateTime = g.at.parse().unwrap();
            let ms = wall
                .to_zoned_datetime(tz.clone())
                .unwrap()
                .timestamp()
                .as_millisecond();
            conn.execute(
                "INSERT INTO games (game_id, queue_id, game_mode, game_creation, game_duration, is_remake, puuid)
                 VALUES (?, 2400, 'KIWI', ?, 900 + ?, ?, 'me')",
                rusqlite::params![g.id, ms, g.id, g.remake],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO player_stats (game_id, champion_id, win, kills, deaths, assists, score, score_raw)
                 VALUES (?, ?, ?, ?, 2, 3, ?, ?)",
                rusqlite::params![g.id, g.champion, g.win, g.kills, g.score, g.score],
            )
            .unwrap();
        }
        (conn, tz)
    }

    fn recap(conn: &Connection, tz: &TimeZone, id: Option<i64>) -> GameRecap {
        get_game_recap(conn, id, Some("en-US"), tz)
            .unwrap()
            .unwrap()
    }

    #[test]
    fn the_newest_game_carries_its_session_streak_and_placements() {
        let (conn, tz) = library(&[
            game(1, "2026-11-20T21:00", 10, 1, 4),
            game(2, "2026-11-21T22:00", 10, 1, 9),
            // 1am belongs to the night of the 21st
            game(3, "2026-11-22T01:00", 20, 1, 9),
        ]);
        let newest = recap(&conn, &tz, None);
        assert_eq!(newest.detail.game.game_id, 3);
        assert_eq!(
            newest
                .session
                .games
                .iter()
                .map(|g| g.game_id)
                .collect::<Vec<_>>(),
            [2, 3]
        );
        assert_eq!(newest.session.index, 1);
        let streak = newest.streak.unwrap();
        assert_eq!((streak.length, streak.best, streak.is_record), (3, 3, true));
        // A tie shares the rank rather than falling behind the game it matched
        let kills = newest.placements.iter().find(|p| p.key == "kills").unwrap();
        assert_eq!((kills.rank, kills.total), (1, 3));
        assert!(newest.champion.first_time);
        assert_eq!(newest.champion.previous_best, None);
        assert_eq!(
            newest
                .milestones
                .iter()
                .map(|m| m.key.as_str())
                .collect::<Vec<_>>(),
            ["champion-first"]
        );

        let first = recap(&conn, &tz, Some(1));
        assert_eq!(first.champion.games, 2);
        assert_eq!(first.champion.previous_best, Some(5.0));
        assert_eq!(first.streak.unwrap().length, 1);
        let kills = first.placements.iter().find(|p| p.key == "kills").unwrap();
        assert_eq!(kills.rank, 3);
    }

    #[test]
    fn a_remake_has_a_recap_but_no_placements_milestones_or_streak() {
        let (conn, tz) = library(&[
            game(1, "2026-11-21T21:00", 10, 1, 4),
            Game {
                remake: 1,
                ..game(2, "2026-11-21T22:00", 10, 0, 0)
            },
        ]);
        let r = recap(&conn, &tz, Some(2));
        assert!(r.placements.is_empty() && r.milestones.is_empty() && r.streak.is_none());
        assert_eq!(r.session.index, -1);
        assert_eq!(r.career.games, 1);
        assert!(
            get_game_recap(&conn, Some(99), None, &tz)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn crossing_a_mark_is_a_milestone_written_in_the_locale() {
        let games: Vec<Game> = (1..=10)
            .map(|i| Game {
                at: [
                    "2026-11-01T12:00",
                    "2026-11-02T12:00",
                    "2026-11-03T12:00",
                    "2026-11-04T12:00",
                    "2026-11-05T12:00",
                    "2026-11-06T12:00",
                    "2026-11-07T12:00",
                    "2026-11-08T12:00",
                    "2026-11-09T12:00",
                    "2026-11-10T12:00",
                ][i as usize - 1],
                ..game(i, "", 10, 1, if i == 10 { 1000 } else { 0 })
            })
            .collect();
        let (conn, tz) = library(&games);
        let labels: Vec<String> = get_game_recap(&conn, Some(10), Some("pt-BR"), &tz)
            .unwrap()
            .unwrap()
            .milestones
            .into_iter()
            .map(|m| m.label)
            .collect();
        assert_eq!(
            labels,
            [
                "10th game",
                "10th win",
                "1.000 career kills",
                "10th game on this champion",
                "10th win on this champion"
            ]
        );
    }

    #[test]
    fn a_first_s_grade_is_a_milestone() {
        let (conn, tz) = library(&[game(1, "2026-11-21T21:00", 10, 1, 4)]);
        conn.execute(
            "INSERT INTO challenge_game_progress VALUES
               (1, 101301, 'Same Penta, Different Champ', 'S- on champions', 2, 3, 'GOLD', 'GOLD', 'PLATINUM', 5, '/icon.png'),
               (1, 101101, 'DPS Threat', 'Deal damage', 7, 9, 'SILVER', 'GOLD', 'PLATINUM', 20, '/icon.png')",
            [],
        )
        .unwrap();
        let r = recap(&conn, &tz, Some(1));
        // A tier earned comes first
        assert_eq!(
            r.challenges.iter().map(|c| c.id).collect::<Vec<_>>(),
            [101101, 101301]
        );
        let s = r.milestones.last().unwrap();
        assert_eq!(s.key, "challenge-s-grade");
        assert_eq!(s.detail, "Same Penta, Different Champ: 3 champions");
    }
}
