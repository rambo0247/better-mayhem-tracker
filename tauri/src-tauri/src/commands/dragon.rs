//! Champion, augment, item and summoner spell game data. Ported by T22.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use tauri::Runtime;
use ts_rs::TS;

use super::{CommandError, CommandResult, Ctx, Domain};

pub struct Hooks;
impl Domain for Hooks {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct ChampionEntry {
    pub name: String,
    pub key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub class: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AugmentEntry {
    pub name: String,
    pub desc: String,
    pub icon_path: String,
    pub rarity: String,
    pub branch: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ItemEntry {
    pub name: String,
    pub description: String,
    pub icon_path: String,
    pub branch: String,
    pub boots: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SummonerSpellEntry {
    pub name: String,
    pub icon_path: String,
}

/// Keyed by id. JSON writes the keys as strings, as JavaScript does.
pub type ChampionData = BTreeMap<i64, ChampionEntry>;
pub type AugmentData = BTreeMap<i64, AugmentEntry>;
pub type ItemData = BTreeMap<i64, ItemEntry>;
pub type SummonerSpellData = BTreeMap<i64, SummonerSpellEntry>;

pub async fn get_champion_data<R: Runtime>(_ctx: Ctx<R>) -> CommandResult<ChampionData> {
    Err(CommandError::not_ported())
}

pub async fn get_augment_data<R: Runtime>(
    _ctx: Ctx<R>,
    _patch: Option<String>,
) -> CommandResult<AugmentData> {
    Err(CommandError::not_ported())
}

pub async fn resolve_augment_icon<R: Runtime>(
    _ctx: Ctx<R>,
    _id: i64,
    _patch: Option<String>,
) -> CommandResult<Option<String>> {
    Err(CommandError::not_ported())
}

pub async fn get_item_data<R: Runtime>(
    _ctx: Ctx<R>,
    _patch: Option<String>,
) -> CommandResult<ItemData> {
    Err(CommandError::not_ported())
}

pub async fn get_summoner_spell_data<R: Runtime>(_ctx: Ctx<R>) -> CommandResult<SummonerSpellData> {
    Err(CommandError::not_ported())
}
