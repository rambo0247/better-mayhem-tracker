//! Champion, augment and item stats, the dashboard, global stats, trends and
//! records. Ported by T14.

use serde::{Deserialize, Serialize};
use tauri::Runtime;
use ts_rs::TS;

use super::types::{AugmentStats, ItemStats, MatchScope, Multikills, RecordsData};
use super::{CommandError, CommandResult, Ctx};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct ChampionStats {
    pub champion_id: i64,
    pub games: i64,
    pub wins: i64,
    pub kills: i64,
    pub deaths: i64,
    pub assists: i64,
    pub avg_kills: f64,
    pub avg_deaths: f64,
    pub avg_assists: f64,
    pub avg_damage: f64,
    pub avg_gold: f64,
    pub avg_score: Option<f64>,
    pub mvps: i64,
    pub aces: i64,
    pub double_kills: i64,
    pub triple_kills: i64,
    pub quadra_kills: i64,
    pub penta_kills: i64,
}

/// `{ champion_id: number; picks: number; wins: number }`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct AugmentChampionPicks {
    pub champion_id: i64,
    pub picks: i64,
    pub wins: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct AugmentStatsDetailed {
    pub augment_id: i64,
    pub picks: i64,
    pub wins: i64,
    pub champions: Vec<AugmentChampionPicks>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AugmentStatsDetailedResult {
    pub total_games: i64,
    pub augments: Vec<AugmentStatsDetailed>,
}

/// `{ win: number; game_id: number }`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct RecentFormGame {
    pub win: i64,
    pub game_id: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DashboardData {
    pub total_games: i64,
    pub total_duration: i64,
    pub wins: i64,
    pub total_kills: i64,
    pub total_deaths: i64,
    pub total_assists: i64,
    pub avg_score: Option<f64>,
    pub mvps: i64,
    pub aces: i64,
    pub scored_wins: i64,
    pub scored_losses: i64,
    pub accounts: i64,
    pub recent_form: Vec<RecentFormGame>,
    pub multikills: Multikills,
}

/// One row of `GlobalStats.champions`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GlobalChampionRow {
    #[serde(rename = "champion_id")]
    pub champion_id: i64,
    pub games: i64,
    pub wins: i64,
    pub kills: i64,
    pub deaths: i64,
    pub assists: i64,
    pub avg_damage: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GlobalStats {
    pub champions: Vec<GlobalChampionRow>,
    pub augments: Vec<AugmentStats>,
    pub items: Vec<ItemStats>,
    pub total_participant_slots: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GlobalChampionDetail {
    #[serde(rename = "champion_id")]
    pub champion_id: i64,
    pub games: i64,
    pub wins: i64,
    pub kills: i64,
    pub deaths: i64,
    pub assists: i64,
    pub avg_damage: f64,
    pub avg_damage_taken: f64,
    pub avg_gold: f64,
    pub avg_heal: f64,
    pub damage_share: f64,
    pub kill_participation: f64,
    pub double_kills: i64,
    pub triple_kills: i64,
    pub quadra_kills: i64,
    pub penta_kills: i64,
    pub total_participant_slots: i64,
    pub items: Vec<ItemStats>,
    pub augments: Vec<AugmentStats>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct TrendsDay {
    pub day: String,
    pub games: i64,
    pub wins: i64,
    pub kills: i64,
    pub deaths: i64,
    pub assists: i64,
    pub score_sum: Option<f64>,
    pub scored_games: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct TrendsPatch {
    pub patch: String,
    pub games: i64,
    pub wins: i64,
    pub avg_score: Option<f64>,
    pub first_played: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct TrendsHour {
    pub hour: i64,
    pub games: i64,
    pub wins: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct TrendsWeekday {
    pub weekday: i64,
    pub games: i64,
    pub wins: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct TrendsData {
    pub daily: Vec<TrendsDay>,
    pub patches: Vec<TrendsPatch>,
    pub hours: Vec<TrendsHour>,
    pub weekdays: Vec<TrendsWeekday>,
}

pub async fn get_champion_stats<R: Runtime>(
    _ctx: Ctx<R>,
    _patch: Option<String>,
    _queue: Option<i64>,
    _season: Option<String>,
) -> CommandResult<Vec<ChampionStats>> {
    Err(CommandError::not_ported())
}

pub async fn get_augment_stats<R: Runtime>(
    _ctx: Ctx<R>,
    _champion_id: Option<i64>,
    _patch: Option<String>,
    _queue: Option<i64>,
    _season: Option<String>,
) -> CommandResult<Vec<AugmentStats>> {
    Err(CommandError::not_ported())
}

pub async fn get_augment_stats_detailed<R: Runtime>(
    _ctx: Ctx<R>,
    _patch: Option<String>,
    _queue: Option<i64>,
    _season: Option<String>,
) -> CommandResult<AugmentStatsDetailedResult> {
    Err(CommandError::not_ported())
}

pub async fn get_dashboard<R: Runtime>(
    _ctx: Ctx<R>,
    _filters: Option<MatchScope>,
) -> CommandResult<DashboardData> {
    Err(CommandError::not_ported())
}

pub async fn get_champion_item_stats<R: Runtime>(
    _ctx: Ctx<R>,
    _champion_id: i64,
    _patch: Option<String>,
    _queue: Option<i64>,
    _season: Option<String>,
) -> CommandResult<Vec<ItemStats>> {
    Err(CommandError::not_ported())
}

pub async fn get_global_stats<R: Runtime>(
    _ctx: Ctx<R>,
    _patch: Option<String>,
    _queue: Option<i64>,
) -> CommandResult<GlobalStats> {
    Err(CommandError::not_ported())
}

pub async fn get_global_champion_detail<R: Runtime>(
    _ctx: Ctx<R>,
    _champion_id: i64,
    _patch: Option<String>,
    _queue: Option<i64>,
) -> CommandResult<GlobalChampionDetail> {
    Err(CommandError::not_ported())
}

pub async fn get_trends<R: Runtime>(
    _ctx: Ctx<R>,
    _queue: Option<i64>,
) -> CommandResult<TrendsData> {
    Err(CommandError::not_ported())
}

pub async fn get_records<R: Runtime>(
    _ctx: Ctx<R>,
    _queue: Option<i64>,
    _account: Option<String>,
) -> CommandResult<RecordsData> {
    Err(CommandError::not_ported())
}
