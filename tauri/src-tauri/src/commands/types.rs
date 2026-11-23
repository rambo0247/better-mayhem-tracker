//! Shapes more than one domain module returns. Field names and casing follow
//! `src/shared/api.ts` field by field: rows read straight from SQLite stay
//! snake_case, shapes built in JavaScript are camelCase.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::db::num::Num;
use crate::js_arg::Js;

/// `"MVP" | "ACE"`, as api.ts declares the `score_badge` column. Electron
/// hands the page whatever text the column holds; another value is not one
/// this type can carry, so reading it is an error.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "UPPERCASE")]
pub enum ScoreBadge {
    Mvp,
    Ace,
}

/// The one reader of a `score_badge` column, for every domain that selects it.
/// NULL reads as `None` through `Option<ScoreBadge>`.
impl rusqlite::types::FromSql for ScoreBadge {
    fn column_result(value: rusqlite::types::ValueRef<'_>) -> rusqlite::types::FromSqlResult<Self> {
        match value.as_str()? {
            "MVP" => Ok(Self::Mvp),
            "ACE" => Ok(Self::Ace),
            other => Err(rusqlite::types::FromSqlError::Other(
                format!("score_badge {other:?} is neither MVP nor ACE").into(),
            )),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct GameRecord {
    pub game_id: i64,
    pub queue_id: i64,
    pub game_mode: String,
    pub game_creation: i64,
    pub game_duration: i64,
    // Read from a row, which always carries the column, so a NULL is sent as null
    #[ts(optional)]
    pub puuid: Option<String>,
    #[ts(optional = nullable)]
    pub game_version: Option<String>,
    #[ts(optional)]
    pub is_remake: Option<i64>,
    #[ts(optional)]
    pub favorite: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct PlayerStatsRecord {
    pub game_id: i64,
    pub champion_id: i64,
    pub win: i64,
    pub kills: i64,
    pub deaths: i64,
    pub assists: i64,
    pub double_kills: i64,
    pub triple_kills: i64,
    pub quadra_kills: i64,
    pub penta_kills: i64,
    pub total_damage_dealt: i64,
    pub total_damage_taken: i64,
    pub gold_earned: i64,
    pub total_heal: i64,
    pub largest_killing_spree: i64,
    pub score: Option<f64>,
    pub score_raw: Option<f64>,
    pub score_badge: Option<ScoreBadge>,
    pub spell1: Option<i64>,
    pub spell2: Option<i64>,
    pub item0: Option<i64>,
    pub item1: Option<i64>,
    pub item2: Option<i64>,
    pub item3: Option<i64>,
    pub item4: Option<i64>,
    pub item5: Option<i64>,
    pub item6: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct GameAugment {
    pub game_id: i64,
    pub slot: i64,
    pub augment_id: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MatchParticipantRecord {
    pub participant_id: i64,
    pub puuid: Option<String>,
    pub game_name: Option<String>,
    pub tag_line: Option<String>,
    pub champion_id: i64,
    pub team_id: i64,
    pub win: bool,
    pub kills: i64,
    pub deaths: i64,
    pub assists: i64,
    pub double_kills: i64,
    pub triple_kills: i64,
    pub quadra_kills: i64,
    pub penta_kills: i64,
    pub total_damage_dealt_to_champions: i64,
    pub total_damage_taken: i64,
    pub gold_earned: i64,
    pub total_heal: i64,
    pub largest_killing_spree: i64,
    pub spell1_id: Option<i64>,
    pub spell2_id: Option<i64>,
    pub items: Vec<i64>,
    pub augments: Vec<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct MatchDetail {
    pub game: GameRecord,
    pub stats: PlayerStatsRecord,
    pub augments: Vec<GameAugment>,
    pub participants: Vec<MatchParticipantRecord>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct MatchListItem {
    pub game_id: i64,
    pub queue_id: i64,
    pub game_creation: i64,
    pub game_duration: i64,
    pub is_remake: i64,
    pub favorite: i64,
    // Electron's query selects the games row whole, so the page receives this
    // column too, though api.ts does not declare it
    #[ts(skip)]
    pub puuid: Option<String>,
    pub champion_id: i64,
    pub win: i64,
    pub kills: i64,
    pub deaths: i64,
    pub assists: i64,
    pub double_kills: i64,
    pub triple_kills: i64,
    pub quadra_kills: i64,
    pub penta_kills: i64,
    pub total_damage_dealt: i64,
    pub total_damage_taken: i64,
    pub total_heal: i64,
    pub gold_earned: i64,
    pub item0: Option<i64>,
    pub item1: Option<i64>,
    pub item2: Option<i64>,
    pub item3: Option<i64>,
    pub item4: Option<i64>,
    pub item5: Option<i64>,
    pub score: Option<f64>,
    pub score_badge: Option<ScoreBadge>,
    pub spell1: Option<i64>,
    pub spell2: Option<i64>,
    pub augment_ids: Option<String>,
    pub game_version: Option<String>,
    pub game_max_dmg: i64,
    pub game_max_taken: i64,
    pub game_max_heal: i64,
}

/// `{ matches: MatchListItem[]; total: number }`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct MatchPage {
    pub matches: Vec<MatchListItem>,
    pub total: i64,
}

/// `Pick<MatchFilters, "championId" | "patch" | "queue" | "account" | "season">`,
/// each as the page sent it, as [`super::matches::MatchFilters`]'s are
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MatchScope {
    #[serde(default, skip_serializing_if = "Js::is_undefined")]
    #[ts(optional)]
    pub champion_id: Js<Option<i64>>,
    #[serde(default, skip_serializing_if = "Js::is_undefined")]
    #[ts(optional)]
    pub patch: Js<Option<String>>,
    #[serde(default, skip_serializing_if = "Js::is_undefined")]
    #[ts(optional)]
    pub queue: Js<Option<i64>>,
    #[serde(default, skip_serializing_if = "Js::is_undefined")]
    #[ts(optional)]
    pub account: Js<Option<String>>,
    #[serde(default, skip_serializing_if = "Js::is_undefined")]
    #[ts(optional)]
    pub season: Js<Option<String>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct AugmentStats {
    pub augment_id: i64,
    pub picks: i64,
    pub wins: Num,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct ItemStats {
    pub item_id: i64,
    pub picks: i64,
    pub wins: Num,
}

/// `DashboardData["multikills"]`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct Multikills {
    pub doubles: Num,
    pub triples: Num,
    pub quadras: Num,
    pub pentas: Num,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct RecordMatchRef {
    pub game_id: i64,
    pub game_creation: i64,
    pub game_duration: Num,
    pub queue_id: i64,
    pub champion_id: i64,
    pub win: Num,
    pub kills: Num,
    pub deaths: Num,
    pub assists: Num,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct StatRecord {
    pub value: f64,
    #[serde(rename = "match")]
    pub game: RecordMatchRef,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct StreakRecord {
    pub length: i64,
    pub start: i64,
    pub end: i64,
    #[serde(rename = "match")]
    pub game: RecordMatchRef,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RecordBests {
    pub kills: Option<StatRecord>,
    pub deaths: Option<StatRecord>,
    pub assists: Option<StatRecord>,
    pub kda: Option<StatRecord>,
    pub score: Option<StatRecord>,
    pub killing_spree: Option<StatRecord>,
    pub damage: Option<StatRecord>,
    pub damage_taken: Option<StatRecord>,
    pub healing: Option<StatRecord>,
    pub gold: Option<StatRecord>,
    pub fastest_win: Option<StatRecord>,
    pub longest_game: Option<StatRecord>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RecordsData {
    pub total_games: i64,
    pub bests: RecordBests,
    pub win_streak: Option<StreakRecord>,
    pub loss_streak: Option<StreakRecord>,
}

/// `{ champion_id: number; games: number }`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct TeammateChampionGames {
    pub champion_id: i64,
    pub games: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TeammateStats {
    pub key: String,
    pub name: String,
    pub puuid: Option<String>,
    pub profile_icon: Option<i64>,
    pub games: i64,
    pub wins: i64,
    pub kills: i64,
    pub deaths: i64,
    pub assists: i64,
    pub champions: Vec<TeammateChampionGames>,
    pub last_played: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "UPPERCASE")]
pub enum ChallengeLevel {
    Iron,
    Bronze,
    Silver,
    Gold,
    Platinum,
    Diamond,
    Master,
    Grandmaster,
    Challenger,
    None,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_score_badge_column_reads_as_api_ts_types_it() {
        let conn = rusqlite::Connection::open_in_memory().expect("an in-memory database");
        let read = |sql: &str| conn.query_row(sql, [], |row| row.get::<_, Option<ScoreBadge>>(0));
        assert_eq!(read("SELECT 'MVP'"), Ok(Some(ScoreBadge::Mvp)));
        assert_eq!(read("SELECT 'ACE'"), Ok(Some(ScoreBadge::Ace)));
        assert_eq!(read("SELECT NULL"), Ok(None));
        assert!(
            read("SELECT 'GOAT'").is_err(),
            "a hand-edited badge is not representable"
        );
    }
}
