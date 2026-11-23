//! Friends, groups, and their shared games. Ported by T15.

use serde::{Deserialize, Serialize};
use tauri::Runtime;
use ts_rs::TS;

use super::types::{MatchListItem, ScoreBadge, TeammateStats};
use super::{CommandResult, Ctx, Domain};
use crate::db::filters::season_window;
use crate::db::teammates::{self, CareerFilter};
use crate::db::{self, Database};
use crate::js_arg::Js;
use crate::op_score::ChampionClassMap;

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

/// The Friends page sets its own minimum, so every teammate comes back.
pub async fn get_teammate_stats<R: Runtime>(
    ctx: Ctx<R>,
    season: Js<Option<String>>,
) -> CommandResult<Vec<TeammateStats>> {
    let season = season.typed().flatten();
    let filter = season_filter(season.as_deref());
    db::of(&ctx)?.with(|conn| teammates::get_teammate_stats(conn, &filter, 1))
}

pub async fn get_teammate_groups<R: Runtime>(
    ctx: Ctx<R>,
    season: Js<Option<String>>,
) -> CommandResult<Vec<TeammateGroup>> {
    let season = season.typed().flatten();
    let filter = season_filter(season.as_deref());
    db::of(&ctx)?.with(|conn| teammates::get_teammate_groups(conn, &filter))
}

pub async fn get_teammate_group_detail<R: Runtime>(
    ctx: Ctx<R>,
    key: Js<String>,
) -> CommandResult<Option<TeammateGroupDetail>> {
    // Electron compares the key with ===, so only a string can match
    let Some(key) = key.typed() else {
        return Ok(None);
    };
    let db = db::of(&ctx)?;
    let classes = champion_classes(&db);
    db.with(|conn| teammates::get_teammate_group_detail(conn, &key, &classes))
}

pub async fn get_teammate_detail<R: Runtime>(
    ctx: Ctx<R>,
    key: Js<String>,
) -> CommandResult<Option<TeammateDetail>> {
    // Electron compares the key with ===, so only a string can match
    let Some(key) = key.typed() else {
        return Ok(None);
    };
    let db = db::of(&ctx)?;
    let classes = champion_classes(&db);
    db.with(|conn| teammates::get_teammate_detail(conn, &key, &classes))
}

/// `seasonWindow(season)` as a career filter.
fn season_filter(season: Option<&str>) -> CareerFilter {
    let window = season_window(season);
    CareerFilter {
        from: window.from,
        to: window.to,
        ..CareerFilter::default()
    }
}

/// Teammate scores need champion classes, read from the cache beside the
/// database until Data Dragon is ported.
fn champion_classes(db: &Database) -> ChampionClassMap {
    db.path()
        .parent()
        .map(teammates::cached_champion_classes)
        .unwrap_or_default()
}
