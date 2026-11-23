//! Friends, groups, and their shared games. Ported by T15.

use serde::{Deserialize, Serialize};
use tauri::Runtime;
use ts_rs::TS;

use super::types::{MatchListItem, ScoreBadge, TeammateStats};
use super::{CommandError, CommandResult, Ctx, Domain};
use crate::js_arg::Js;

pub struct Hooks;
impl Domain for Hooks {}

/// `Pick<TeammateStats, "key" | "name" | "profileIcon">`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TeammateMember {
    pub key: String,
    pub name: String,
    pub profile_icon: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TeammateGroup {
    pub key: String,
    pub members: Vec<TeammateMember>,
    pub games: i64,
    pub wins: i64,
    pub kills: i64,
    pub deaths: i64,
    pub assists: i64,
    pub last_played: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct TeammateLine {
    pub champion_id: i64,
    pub win: i64,
    pub kills: i64,
    pub deaths: i64,
    pub assists: i64,
    pub total_damage_dealt: i64,
    pub total_damage_taken: i64,
    pub total_heal: i64,
    pub score: Option<f64>,
    pub score_badge: Option<ScoreBadge>,
}

/// `interface TeammateMatch extends MatchListItem`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct TeammateMatch {
    #[serde(flatten)]
    pub game: MatchListItem,
    pub friend: TeammateLine,
}

/// `interface TeammateGroupMatch extends MatchListItem`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct TeammateGroupMatch {
    #[serde(flatten)]
    pub game: MatchListItem,
    pub members: Vec<TeammateLine>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct TeammateGroupDetail {
    pub group: TeammateGroup,
    pub matches: Vec<TeammateGroupMatch>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct TeammateChampionStats {
    pub champion_id: i64,
    pub games: i64,
    pub wins: i64,
    pub kills: i64,
    pub deaths: i64,
    pub assists: i64,
}

/// `interface TeammateProfile extends Omit<TeammateStats, "champions">`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TeammateProfile {
    pub key: String,
    pub name: String,
    pub puuid: Option<String>,
    pub profile_icon: Option<i64>,
    pub games: i64,
    pub wins: i64,
    pub kills: i64,
    pub deaths: i64,
    pub assists: i64,
    pub champions: Vec<TeammateChampionStats>,
    pub last_played: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct TeammateDetail {
    pub player: TeammateProfile,
    pub matches: Vec<TeammateMatch>,
}

pub async fn get_teammate_stats<R: Runtime>(
    _ctx: Ctx<R>,
    _season: Js<Option<String>>,
) -> CommandResult<Vec<TeammateStats>> {
    Err(CommandError::not_ported())
}

pub async fn get_teammate_groups<R: Runtime>(
    _ctx: Ctx<R>,
    _season: Js<Option<String>>,
) -> CommandResult<Vec<TeammateGroup>> {
    Err(CommandError::not_ported())
}

pub async fn get_teammate_group_detail<R: Runtime>(
    _ctx: Ctx<R>,
    _key: Js<String>,
) -> CommandResult<Option<TeammateGroupDetail>> {
    Err(CommandError::not_ported())
}

pub async fn get_teammate_detail<R: Runtime>(
    _ctx: Ctx<R>,
    _key: Js<String>,
) -> CommandResult<Option<TeammateDetail>> {
    Err(CommandError::not_ported())
}
