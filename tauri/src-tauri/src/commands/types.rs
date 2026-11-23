//! Shapes more than one domain module returns. Field names and casing follow
//! `src/shared/api.ts` field by field: rows read straight from SQLite stay
//! snake_case, shapes built in JavaScript are camelCase.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "UPPERCASE")]
pub enum ScoreBadge {
    Mvp,
    Ace,
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

/// `Pick<MatchFilters, "championId" | "patch" | "queue" | "account" | "season">`
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MatchScope {
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub champion_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub patch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub queue: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub account: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub season: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct AugmentStats {
    pub augment_id: i64,
    pub picks: i64,
    pub wins: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct ItemStats {
    pub item_id: i64,
    pub picks: i64,
    pub wins: i64,
}

/// `DashboardData["multikills"]`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct Multikills {
    pub doubles: i64,
    pub triples: i64,
    pub quadras: i64,
    pub pentas: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct RecordMatchRef {
    pub game_id: i64,
    pub game_creation: i64,
    pub game_duration: i64,
    pub queue_id: i64,
    pub champion_id: i64,
    pub win: i64,
    pub kills: i64,
    pub deaths: i64,
    pub assists: i64,
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
