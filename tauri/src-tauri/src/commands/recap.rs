//! The post-game recap, the game card's data, and the season recap. Ported by
//! T16.

use serde::{Deserialize, Serialize};
use tauri::Runtime;
use ts_rs::TS;

use super::types::{
    AugmentStats, ChallengeLevel, ItemStats, MatchDetail, Multikills, RecordsData, ScoreBadge,
    TeammateStats,
};
use super::{CommandError, CommandResult, Ctx, Domain};
use crate::js_arg::Js;

pub struct Hooks;
impl Domain for Hooks {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum RecapFormat {
    Int,
    Score,
    Compact,
    Duration,
    Kda,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct RecapPlacement {
    pub key: String,
    pub label: String,
    pub value: f64,
    pub rank: i64,
    pub total: i64,
    pub good: bool,
    pub format: RecapFormat,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct RecapMilestone {
    pub key: String,
    pub label: String,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct RecapSessionGame {
    pub game_id: i64,
    pub game_creation: i64,
    pub game_duration: i64,
    pub champion_id: i64,
    pub win: i64,
    pub kills: i64,
    pub deaths: i64,
    pub assists: i64,
    pub score: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RecapSession {
    pub day: i64,
    pub index: i64,
    pub games: Vec<RecapSessionGame>,
    pub wins: i64,
    pub losses: i64,
    pub kills: i64,
    pub deaths: i64,
    pub assists: i64,
    pub avg_score: Option<f64>,
    pub duration: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum StreakKind {
    Win,
    Loss,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RecapStreak {
    pub kind: StreakKind,
    pub length: i64,
    pub best: i64,
    pub is_record: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RecapChampion {
    pub champion_id: i64,
    pub games: i64,
    pub wins: i64,
    pub kills: i64,
    pub deaths: i64,
    pub assists: i64,
    pub avg_score: Option<f64>,
    pub previous_best: Option<f64>,
    pub first_time: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RecapCareer {
    pub games: i64,
    pub wins: i64,
    pub avg_score: Option<f64>,
    pub avg_kills: f64,
    pub avg_deaths: f64,
    pub avg_assists: f64,
    pub avg_damage: f64,
    pub avg_taken: f64,
    pub avg_heal: f64,
    pub avg_gold: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RecapChallenge {
    pub id: i64,
    pub name: String,
    pub description: String,
    pub previous_value: f64,
    pub current_value: f64,
    pub previous_level: ChallengeLevel,
    pub current_level: ChallengeLevel,
    pub next_level: Option<ChallengeLevel>,
    pub next_threshold: Option<f64>,
    pub icon_path: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GameRecap {
    pub detail: MatchDetail,
    pub map_name: Option<String>,
    pub score: Option<f64>,
    pub score_badge: Option<ScoreBadge>,
    pub placements: Vec<RecapPlacement>,
    pub milestones: Vec<RecapMilestone>,
    pub session: RecapSession,
    pub streak: Option<RecapStreak>,
    pub champion: RecapChampion,
    pub career: RecapCareer,
    pub challenges: Vec<RecapChallenge>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GameCardData {
    pub detail: MatchDetail,
    pub map_name: Option<String>,
    pub profile_icon: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct SeasonSummary {
    pub id: String,
    pub name: String,
    pub start: Option<String>,
    pub end: Option<String>,
    pub games: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SeasonChampion {
    #[serde(rename = "champion_id")]
    pub champion_id: i64,
    pub games: i64,
    pub wins: i64,
    pub kills: i64,
    pub deaths: i64,
    pub assists: i64,
    pub avg_score: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SeasonPlayer {
    pub game_name: Option<String>,
    pub tag_line: Option<String>,
    pub profile_icon: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct SeasonDay {
    pub day: i64,
    pub games: i64,
    pub wins: i64,
}

/// `{ days: number; from: number; to: number }`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct DayStreak {
    pub days: i64,
    pub from: i64,
    pub to: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SeasonRecap {
    pub season: SeasonSummary,
    pub seasons: Vec<SeasonSummary>,
    pub player: SeasonPlayer,
    pub accounts: i64,
    pub patch: Option<String>,
    pub first_game: Option<i64>,
    pub last_game: Option<i64>,
    pub games: i64,
    pub wins: i64,
    pub duration: i64,
    pub days: Vec<SeasonDay>,
    pub busiest_day: Option<SeasonDay>,
    pub day_streak: Option<DayStreak>,
    pub peak_hour: Option<i64>,
    pub top_weekday: Option<i64>,
    pub kills: i64,
    pub deaths: i64,
    pub assists: i64,
    pub damage: i64,
    pub damage_taken: i64,
    pub healing: i64,
    pub gold: i64,
    pub multikills: Multikills,
    pub kill_participation: Option<f64>,
    pub damage_share: Option<f64>,
    pub avg_score: Option<f64>,
    pub mvps: i64,
    pub aces: i64,
    pub scored_wins: i64,
    pub scored_losses: i64,
    pub champions: Vec<SeasonChampion>,
    pub unique_champions: i64,
    pub augments: Vec<AugmentStats>,
    pub items: Vec<ItemStats>,
    pub records: RecordsData,
    pub friends: Vec<TeammateStats>,
}

pub async fn get_game_recap<R: Runtime>(
    _ctx: Ctx<R>,
    _game_id: Js<Option<i64>>,
) -> CommandResult<Option<GameRecap>> {
    Err(CommandError::not_ported())
}

pub async fn get_game_card<R: Runtime>(
    _ctx: Ctx<R>,
    _game_id: Js<i64>,
) -> CommandResult<Option<GameCardData>> {
    Err(CommandError::not_ported())
}

pub async fn get_season_recap<R: Runtime>(
    _ctx: Ctx<R>,
    _season_id: Js<Option<String>>,
    _queue: Js<Option<i64>>,
    _account: Js<Option<String>>,
) -> CommandResult<Option<SeasonRecap>> {
    Err(CommandError::not_ported())
}

pub async fn get_seasons<R: Runtime>(_ctx: Ctx<R>) -> CommandResult<Vec<SeasonSummary>> {
    Err(CommandError::not_ported())
}
