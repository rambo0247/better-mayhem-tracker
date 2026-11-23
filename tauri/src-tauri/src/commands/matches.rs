//! The match list, its filters and sessions, one match's detail, favorites,
//! and the tracked accounts. Ported by T13.

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use tauri::Runtime;
use ts_rs::TS;

use super::types::{MatchDetail, MatchPage, MatchScope};
use super::{CommandError, CommandResult, Ctx, Domain};

pub struct Hooks;
impl Domain for Hooks {}

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

/// Reads leniently where Electron does: see the `Deserialize` impl below.
#[derive(Debug, Clone, Default, PartialEq, Serialize, TS)]
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

/// What a caller may send for [`MatchFilters`]. The page restores filters
/// from localStorage unchecked (viewState.ts:22-33), so a stale `sort`,
/// `sortDir` or `multikills` must read as Electron reads it, not reject.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SentMatchFilters {
    champion_id: Option<i64>,
    patch: Option<String>,
    queue: Option<i64>,
    account: Option<String>,
    season: Option<String>,
    sort: Option<Value>,
    sort_dir: Option<Value>,
    multikills: Option<Value>,
    favorites: Option<bool>,
}

impl<'de> Deserialize<'de> for MatchFilters {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let sent = SentMatchFilters::deserialize(deserializer)?;
        Ok(Self {
            champion_id: sent.champion_id,
            patch: sent.patch,
            queue: sent.queue,
            account: sent.account,
            season: sent.season,
            // Unknown sorts by date, the default (matches.ts:65)
            sort: sent.sort.and_then(|v| serde_json::from_value(v).ok()),
            // Anything but "asc" sorts descending, the default (matches.ts:66)
            sort_dir: sent.sort_dir.and_then(|v| serde_json::from_value(v).ok()),
            // Unknown kinds are dropped (matches.ts:122-124)
            multikills: match sent.multikills {
                Some(Value::Array(items)) => Some(
                    items
                        .into_iter()
                        .filter_map(|item| serde_json::from_value(item).ok())
                        .collect(),
                ),
                _ => None,
            },
            favorites: sent.favorites,
        })
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn filters(json: &str) -> MatchFilters {
        serde_json::from_str(json).expect("filters Electron accepts")
    }

    #[test]
    fn stale_filter_values_fall_back_as_electron_does() {
        let read = filters(
            r#"{ "sort": "rank", "sortDir": "ASC", "multikills": ["pentas", "hexas", 3] }"#,
        );
        assert_eq!(read.sort, None, "an unknown sort is the date default");
        assert_eq!(
            read.sort_dir, None,
            "an unknown direction is the descending default"
        );
        assert_eq!(read.multikills, Some(vec![MultikillType::Pentas]));
        let known = filters(r#"{ "sort": "damageDealt", "sortDir": "asc", "multikills": [] }"#);
        assert_eq!(known.sort, Some(MatchSort::DamageDealt));
        assert_eq!(known.sort_dir, Some(MatchSortDir::Asc));
        assert_eq!(known.multikills, Some(vec![]));
        assert_eq!(filters(r#"{ "multikills": null }"#).multikills, None);
        assert_eq!(filters("{}"), MatchFilters::default());
    }
}
