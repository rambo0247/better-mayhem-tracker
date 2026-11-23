//! Champion, augment, item and summoner spell game data. Ported by T22.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use tauri::{Manager, Runtime};
use ts_rs::TS;

use super::{CommandError, CommandResult, Ctx, Domain};
use crate::assets;
use crate::dragon::Dragon;
use crate::js_arg::Js;

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

fn dragon<R: Runtime>(ctx: &Ctx<R>) -> Option<Dragon> {
    ctx.app
        .try_state::<Dragon>()
        .map(|dragon| dragon.inner().clone())
}

/// A patch the renderer names. Anything but a string reads as none.
fn patch(patch: &Js<Option<String>>) -> Option<String> {
    patch.typed().flatten()
}

/// Waits for the startup load, then answers what it left: Data Dragon's
/// table, or the disk copy when Data Dragon did not answer.
pub async fn get_champion_data<R: Runtime>(ctx: Ctx<R>) -> CommandResult<ChampionData> {
    let dragon =
        dragon(&ctx).ok_or_else(|| CommandError::thrown("The game data folders are not open"))?;
    let champions = dragon.champion_data().await;
    Ok(champions
        .entries()
        .filter_map(|(id, champion)| {
            let entry = ChampionEntry {
                name: champion.name.clone(),
                key: champion.key.clone(),
                class: champion
                    .class
                    .as_ref()
                    .and_then(|class| class.as_str())
                    .map(str::to_owned),
            };
            Some((id.parse().ok()?, entry))
        })
        .collect())
}

pub async fn get_augment_data<R: Runtime>(
    ctx: Ctx<R>,
    patch: Js<Option<String>>,
) -> CommandResult<AugmentData> {
    let Some(dragon) = dragon(&ctx) else {
        return Ok(AugmentData::new());
    };
    let Ok(augments) = dragon.augments(self::patch(&patch).as_deref()).await else {
        return Ok(AugmentData::new());
    };
    Ok(augments
        .iter()
        .map(|(id, a)| {
            let entry = AugmentEntry {
                name: a.name.clone(),
                desc: a.desc.clone(),
                icon_path: a.icon_path.clone(),
                rarity: a.rarity.clone(),
                branch: a.branch.clone(),
            };
            (*id, entry)
        })
        .collect())
}

/// An id that is not a whole number names no augment on any branch.
pub async fn resolve_augment_icon<R: Runtime>(
    ctx: Ctx<R>,
    id: Js<i64>,
    patch: Js<Option<String>>,
) -> CommandResult<Option<String>> {
    let (Some(dragon), Some(id)) = (dragon(&ctx), id.typed()) else {
        return Ok(None);
    };
    let url = dragon
        .resolve_augment_icon(id, self::patch(&patch).as_deref())
        .await
        .unwrap_or(None);
    Ok(url.map(assets::for_webview))
}

pub async fn get_item_data<R: Runtime>(
    ctx: Ctx<R>,
    patch: Js<Option<String>>,
) -> CommandResult<ItemData> {
    let Some(dragon) = dragon(&ctx) else {
        return Ok(ItemData::new());
    };
    let Ok(items) = dragon.items(self::patch(&patch).as_deref()).await else {
        return Ok(ItemData::new());
    };
    Ok(items
        .iter()
        .map(|(id, item)| {
            let entry = ItemEntry {
                name: item.name.clone(),
                description: item.description.clone(),
                icon_path: item.icon_path.clone(),
                branch: item.branch.clone(),
                boots: item.boots,
            };
            (*id, entry)
        })
        .collect())
}

pub async fn get_summoner_spell_data<R: Runtime>(ctx: Ctx<R>) -> CommandResult<SummonerSpellData> {
    let Some(dragon) = dragon(&ctx) else {
        return Ok(SummonerSpellData::new());
    };
    let Ok(spells) = dragon.summoner_spells().await else {
        return Ok(SummonerSpellData::new());
    };
    Ok(spells
        .iter()
        .map(|(id, spell)| {
            let entry = SummonerSpellEntry {
                name: spell.name.clone(),
                icon_path: spell.icon_path.clone(),
            };
            (*id, entry)
        })
        .collect())
}
