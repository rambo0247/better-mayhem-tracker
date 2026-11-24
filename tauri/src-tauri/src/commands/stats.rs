//! Champion, augment and item stats, the dashboard, global stats, trends and
//! records.

use serde::{Deserialize, Serialize};
use tauri::Runtime;
use ts_rs::TS;

use super::types::{AugmentStats, ItemStats, MatchScope, Multikills, RecordsData};
use super::{CommandResult, Ctx, Domain, whole};
use crate::db::num::Num;
use crate::db::{self, records, stats};
use crate::js_arg::Js;

pub struct Hooks;
impl Domain for Hooks {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct ChampionStats {
    pub champion_id: i64,
    pub games: i64,
    pub wins: Num,
    pub kills: Num,
    pub deaths: Num,
    pub assists: Num,
    pub avg_kills: f64,
    pub avg_deaths: f64,
    pub avg_assists: f64,
    pub avg_damage: f64,
    pub avg_gold: f64,
    pub avg_score: Option<f64>,
    pub mvps: Num,
    pub aces: Num,
    pub double_kills: Num,
    pub triple_kills: Num,
    pub quadra_kills: Num,
    pub penta_kills: Num,
}

/// `{ champion_id: number; picks: number; wins: number }`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct AugmentChampionPicks {
    pub champion_id: i64,
    pub picks: i64,
    pub wins: Num,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct AugmentStatsDetailed {
    pub augment_id: i64,
    pub picks: i64,
    pub wins: Num,
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
    pub win: Num,
    pub game_id: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DashboardData {
    pub total_games: i64,
    pub total_duration: Num,
    pub wins: Num,
    pub total_kills: Num,
    pub total_deaths: Num,
    pub total_assists: Num,
    pub avg_score: Option<f64>,
    pub mvps: Num,
    pub aces: Num,
    pub scored_wins: Num,
    pub scored_losses: Num,
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
    pub wins: Num,
    pub kills: Num,
    pub deaths: Num,
    pub assists: Num,
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
    pub wins: Num,
    pub kills: Num,
    pub deaths: Num,
    pub assists: Num,
    pub avg_damage: f64,
    pub avg_damage_taken: f64,
    pub avg_gold: f64,
    pub avg_heal: f64,
    pub damage_share: f64,
    pub kill_participation: f64,
    pub double_kills: Num,
    pub triple_kills: Num,
    pub quadra_kills: Num,
    pub penta_kills: Num,
    pub total_participant_slots: i64,
    pub items: Vec<ItemStats>,
    pub augments: Vec<AugmentStats>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct TrendsDay {
    pub day: String,
    pub games: i64,
    pub wins: Num,
    pub kills: Num,
    pub deaths: Num,
    pub assists: Num,
    pub score_sum: Option<f64>,
    pub scored_games: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct TrendsPatch {
    pub patch: String,
    pub games: i64,
    pub wins: Num,
    pub avg_score: Option<f64>,
    pub first_played: Num,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct TrendsHour {
    pub hour: i64,
    pub games: i64,
    pub wins: Num,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct TrendsWeekday {
    pub weekday: i64,
    pub games: i64,
    pub wins: Num,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct TrendsData {
    pub daily: Vec<TrendsDay>,
    pub patches: Vec<TrendsPatch>,
    pub hours: Vec<TrendsHour>,
    pub weekdays: Vec<TrendsWeekday>,
}

pub async fn get_champion_stats<R: Runtime>(
    ctx: Ctx<R>,
    patch: Js<Option<String>>,
    queue: Js<Option<i64>>,
    season: Js<Option<String>>,
) -> CommandResult<Vec<ChampionStats>> {
    let patch = patch.typed().flatten();
    let queue = queue.typed().flatten();
    let season = season.typed().flatten();
    db::run(&ctx, move |conn| {
        stats::get_champion_stats_all(conn, patch.as_deref(), queue, season.as_deref())
    })
    .await
}

pub async fn get_augment_stats<R: Runtime>(
    ctx: Ctx<R>,
    champion_id: Js<Option<i64>>,
    patch: Js<Option<String>>,
    queue: Js<Option<i64>>,
    season: Js<Option<String>>,
) -> CommandResult<Vec<AugmentStats>> {
    let champion_id = champion_id.typed().flatten();
    let patch = patch.typed().flatten();
    let queue = queue.typed().flatten();
    let season = season.typed().flatten();
    db::run(&ctx, move |conn| {
        stats::get_augment_stats_all(
            conn,
            champion_id,
            patch.as_deref(),
            queue,
            season.as_deref(),
        )
    })
    .await
}

pub async fn get_augment_stats_detailed<R: Runtime>(
    ctx: Ctx<R>,
    patch: Js<Option<String>>,
    queue: Js<Option<i64>>,
    season: Js<Option<String>>,
) -> CommandResult<AugmentStatsDetailedResult> {
    let patch = patch.typed().flatten();
    let queue = queue.typed().flatten();
    let season = season.typed().flatten();
    db::run(&ctx, move |conn| {
        stats::get_augment_stats_with_champions(conn, patch.as_deref(), queue, season.as_deref())
    })
    .await
}

pub async fn get_dashboard<R: Runtime>(
    ctx: Ctx<R>,
    filters: Option<MatchScope>,
) -> CommandResult<DashboardData> {
    db::run(&ctx, move |conn| {
        stats::get_dashboard_data(conn, filters.as_ref())
    })
    .await
}

pub async fn get_champion_item_stats<R: Runtime>(
    ctx: Ctx<R>,
    champion_id: Js<i64>,
    patch: Js<Option<String>>,
    queue: Js<Option<i64>>,
    season: Js<Option<String>>,
) -> CommandResult<Vec<ItemStats>> {
    let champion_id = whole(&champion_id)?;
    let patch = patch.typed().flatten();
    let queue = queue.typed().flatten();
    let season = season.typed().flatten();
    db::run(&ctx, move |conn| {
        stats::get_champion_item_stats(
            conn,
            champion_id,
            patch.as_deref(),
            queue,
            season.as_deref(),
        )
    })
    .await
}

pub async fn get_global_stats<R: Runtime>(
    ctx: Ctx<R>,
    patch: Js<Option<String>>,
    queue: Js<Option<i64>>,
) -> CommandResult<GlobalStats> {
    let patch = patch.typed().flatten();
    let queue = queue.typed().flatten();
    db::run(&ctx, move |conn| {
        stats::get_global_stats(conn, patch.as_deref(), queue)
    })
    .await
}

pub async fn get_global_champion_detail<R: Runtime>(
    ctx: Ctx<R>,
    champion_id: Js<i64>,
    patch: Js<Option<String>>,
    queue: Js<Option<i64>>,
) -> CommandResult<GlobalChampionDetail> {
    let champion_id = whole(&champion_id)?;
    let patch = patch.typed().flatten();
    let queue = queue.typed().flatten();
    db::run(&ctx, move |conn| {
        stats::get_global_champion_detail(conn, champion_id, patch.as_deref(), queue)
    })
    .await
}

pub async fn get_trends<R: Runtime>(
    ctx: Ctx<R>,
    queue: Js<Option<i64>>,
) -> CommandResult<TrendsData> {
    let queue = queue.typed().flatten();
    db::run(&ctx, move |conn| stats::get_trends_data(conn, queue)).await
}

pub async fn get_records<R: Runtime>(
    ctx: Ctx<R>,
    queue: Js<Option<i64>>,
    account: Js<Option<String>>,
) -> CommandResult<RecordsData> {
    let queue = queue.typed().flatten();
    let account = account.typed().flatten();
    db::run(&ctx, move |conn| records::get_records(conn, queue, account)).await
}
