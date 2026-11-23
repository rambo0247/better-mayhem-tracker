//! The match list, its filters and sessions, one match's detail, favorites,
//! and the tracked accounts. Ported by T13.

use serde::{Deserialize, Serialize};
use tauri::Runtime;
use ts_rs::TS;

use super::types::{MatchDetail, MatchPage, MatchScope};
use super::{CommandError, CommandResult, Ctx};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum MatchSort {
    Date,
    Kda,
    Kills,
    Duration,
    Score,
    DamageDealt,
    DamageTaken,
    Healing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum MatchSortDir {
    Asc,
    Desc,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum MultikillType {
    Doubles,
    Triples,
    Quadras,
    Pentas,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MatchFilters {
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
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub sort: Option<MatchSort>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub sort_dir: Option<MatchSortDir>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub multikills: Option<Vec<MultikillType>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub favorites: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct MatchSession {
    pub key: String,
    pub games: i64,
    pub wins: i64,
    pub losses: i64,
    pub kills: i64,
    pub deaths: i64,
    pub assists: i64,
    pub score_sum: Option<f64>,
    pub scored_games: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TrackedAccount {
    pub puuid: String,
    pub name: Option<String>,
    pub profile_icon: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MatchFilterOptions {
    pub patches: Vec<String>,
    pub champions: Vec<i64>,
    pub queues: Vec<i64>,
    pub seasons: Vec<String>,
    pub accounts: Vec<TrackedAccount>,
    pub has_favorites: bool,
}

/// `{ name: string | null; profileIcon: number | null }`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub name: Option<String>,
    pub profile_icon: Option<i64>,
}

pub async fn get_match_history<R: Runtime>(
    _ctx: Ctx<R>,
    _limit: i64,
    _offset: i64,
    _filters: Option<MatchFilters>,
) -> CommandResult<MatchPage> {
    Err(CommandError::not_ported())
}

pub async fn get_match_sessions<R: Runtime>(
    _ctx: Ctx<R>,
    _filters: Option<MatchFilters>,
) -> CommandResult<Vec<MatchSession>> {
    Err(CommandError::not_ported())
}

pub async fn get_match_filter_options<R: Runtime>(
    _ctx: Ctx<R>,
    _filters: Option<MatchScope>,
) -> CommandResult<MatchFilterOptions> {
    Err(CommandError::not_ported())
}

pub async fn get_stored_queues<R: Runtime>(_ctx: Ctx<R>) -> CommandResult<Vec<i64>> {
    Err(CommandError::not_ported())
}

pub async fn get_match_detail<R: Runtime>(
    _ctx: Ctx<R>,
    _game_id: i64,
) -> CommandResult<Option<MatchDetail>> {
    Err(CommandError::not_ported())
}

pub async fn toggle_favorite<R: Runtime>(_ctx: Ctx<R>, _game_id: i64) -> CommandResult<bool> {
    Err(CommandError::not_ported())
}

pub async fn get_champion_match_history<R: Runtime>(
    _ctx: Ctx<R>,
    _champion_id: i64,
    _limit: i64,
    _offset: i64,
    _patch: Option<String>,
    _queue: Option<i64>,
    _season: Option<String>,
) -> CommandResult<MatchPage> {
    Err(CommandError::not_ported())
}

pub async fn get_all_summoner_puuids<R: Runtime>(_ctx: Ctx<R>) -> CommandResult<Vec<String>> {
    Err(CommandError::not_ported())
}

pub async fn get_profile<R: Runtime>(_ctx: Ctx<R>) -> CommandResult<Profile> {
    Err(CommandError::not_ported())
}
