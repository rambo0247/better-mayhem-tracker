//! The match list, its filters and sessions, one match's detail, favorites,
//! and the tracked accounts. Ported by T13.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::Runtime;
use ts_rs::TS;

use super::types::{MatchDetail, MatchPage, MatchScope};
use super::{CommandError, CommandResult, Ctx, Domain};
use crate::js_arg::{Js, JsValue};

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

/// Every field as the page sent it: the page restores filters from
/// localStorage unchecked (viewState.ts:22-33), and Electron binds or tests
/// each one as it came. The methods read `sort`, `sortDir` and `multikills`
/// with Electron's fallbacks.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
pub struct MatchFilters {
    #[serde(skip_serializing_if = "Js::is_undefined")]
    #[ts(optional)]
    pub champion_id: Js<Option<i64>>,
    #[serde(skip_serializing_if = "Js::is_undefined")]
    #[ts(optional)]
    pub patch: Js<Option<String>>,
    #[serde(skip_serializing_if = "Js::is_undefined")]
    #[ts(optional)]
    pub queue: Js<Option<i64>>,
    #[serde(skip_serializing_if = "Js::is_undefined")]
    #[ts(optional)]
    pub account: Js<Option<String>>,
    #[serde(skip_serializing_if = "Js::is_undefined")]
    #[ts(optional)]
    pub season: Js<Option<String>>,
    #[serde(skip_serializing_if = "Js::is_undefined")]
    #[ts(optional)]
    pub sort: Js<Option<MatchSort>>,
    #[serde(skip_serializing_if = "Js::is_undefined")]
    #[ts(optional)]
    pub sort_dir: Js<Option<MatchSortDir>>,
    #[serde(skip_serializing_if = "Js::is_undefined")]
    #[ts(optional)]
    pub multikills: Js<Option<Vec<MultikillType>>>,
    #[serde(skip_serializing_if = "Js::is_undefined")]
    #[ts(optional)]
    pub favorites: Js<Option<bool>>,
}

impl MatchFilters {
    /// An unknown or missing sort is by date (matches.ts:65).
    pub fn sort_key(&self) -> MatchSort {
        self.sort.typed().flatten().unwrap_or(MatchSort::Date)
    }

    /// Anything but exactly `"asc"` sorts descending (matches.ts:66).
    pub fn sort_direction(&self) -> MatchSortDir {
        self.sort_dir
            .typed()
            .flatten()
            .unwrap_or(MatchSortDir::Desc)
    }

    /// The known kinds asked for; unknown ones are dropped (matches.ts:122-124).
    /// A non-empty string has a length but no `map`, so Electron throws.
    pub fn multikill_kinds(&self) -> CommandResult<Vec<MultikillType>> {
        match self.multikills.value().and_then(JsValue::as_json) {
            Some(Value::Array(items)) => Ok(items
                .iter()
                .filter_map(|item| serde_json::from_value(item.clone()).ok())
                .collect()),
            Some(Value::String(text)) if !text.is_empty() => Err(CommandError::named(
                "TypeError",
                "filters.multikills.map is not a function",
            )),
            _ => Ok(Vec::new()),
        }
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
    _limit: Js<i64>,
    _offset: Js<i64>,
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
    _game_id: Js<i64>,
) -> CommandResult<Option<MatchDetail>> {
    Err(CommandError::not_ported())
}

pub async fn toggle_favorite<R: Runtime>(_ctx: Ctx<R>, _game_id: Js<i64>) -> CommandResult<bool> {
    Err(CommandError::not_ported())
}

pub async fn get_champion_match_history<R: Runtime>(
    _ctx: Ctx<R>,
    _champion_id: Js<i64>,
    _limit: Js<i64>,
    _offset: Js<i64>,
    _patch: Js<Option<String>>,
    _queue: Js<Option<i64>>,
    _season: Js<Option<String>>,
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
        assert_eq!(
            read.sort_key(),
            MatchSort::Date,
            "an unknown sort is by date"
        );
        assert_eq!(
            read.sort_direction(),
            MatchSortDir::Desc,
            "only \"asc\" ascends"
        );
        assert_eq!(read.multikill_kinds(), Ok(vec![MultikillType::Pentas]));
        let known = filters(r#"{ "sort": "damageDealt", "sortDir": "asc", "multikills": [] }"#);
        assert_eq!(known.sort_key(), MatchSort::DamageDealt);
        assert_eq!(known.sort_direction(), MatchSortDir::Asc);
        assert_eq!(known.multikill_kinds(), Ok(vec![]));
        assert_eq!(
            filters(r#"{ "multikills": 3 }"#).multikill_kinds(),
            Ok(vec![])
        );
        assert_eq!(
            filters(r#"{ "multikills": "pentas" }"#)
                .multikill_kinds()
                .map_err(|e| e.name),
            Err("TypeError".to_owned())
        );
        assert_eq!(filters("{}"), MatchFilters::default());
        assert_eq!(filters("{}").sort_key(), MatchSort::Date);
    }

    #[test]
    fn sql_bound_filters_arrive_as_the_page_sent_them() {
        let read =
            filters(r#"{ "championId": "2", "queue": "2400", "favorites": 1, "patch": 16 }"#);
        let sent = |js: Option<&JsValue>| js.and_then(JsValue::as_json).cloned();
        assert_eq!(sent(read.champion_id.value()), Some(Value::from("2")));
        assert_eq!(sent(read.queue.value()), Some(Value::from("2400")));
        assert_eq!(sent(read.favorites.value()), Some(Value::from(1)));
        assert_eq!(sent(read.patch.value()), Some(Value::from(16)));
        assert!(read.season.is_undefined());
        let written = serde_json::to_value(&read).unwrap();
        assert_eq!(
            written,
            serde_json::json!({ "championId": "2", "queue": "2400", "favorites": 1, "patch": 16 })
        );
    }
}
