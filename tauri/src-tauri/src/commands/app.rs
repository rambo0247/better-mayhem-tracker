//! The version, update checks and installs, release notes, and opening URLs
//! and the logs folder. Ported by T09 and T24.

use serde::{Deserialize, Serialize};
use tauri::Runtime;
use ts_rs::TS;

use super::{CommandError, CommandResult, Ctx, Domain};

pub struct Hooks;
impl Domain for Hooks {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseNote {
    pub version: String,
    pub published_at: String,
    pub body: String,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct UpdateNotes {
    pub from: String,
    pub to: String,
    pub url: String,
    pub releases: Vec<ReleaseNote>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub has_update: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub latest: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub current: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub asset_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub asset_size: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub releases: Option<Vec<ReleaseNote>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub more_versions: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error: Option<String>,
}

/// `{ success: boolean; error?: string }`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct DownloadUpdateResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error: Option<String>,
}

pub async fn open_logs_folder<R: Runtime>(_ctx: Ctx<R>) -> CommandResult<()> {
    Err(CommandError::not_ported())
}

pub async fn get_version<R: Runtime>(_ctx: Ctx<R>) -> CommandResult<String> {
    Err(CommandError::not_ported())
}

pub async fn check_for_update<R: Runtime>(_ctx: Ctx<R>) -> CommandResult<UpdateInfo> {
    Err(CommandError::not_ported())
}

pub async fn download_update<R: Runtime>(
    _ctx: Ctx<R>,
    _asset_url: String,
) -> CommandResult<DownloadUpdateResult> {
    Err(CommandError::not_ported())
}

pub async fn get_launch_install<R: Runtime>(_ctx: Ctx<R>) -> CommandResult<Option<UpdateInfo>> {
    Err(CommandError::not_ported())
}

pub async fn get_update_notes<R: Runtime>(_ctx: Ctx<R>) -> CommandResult<Option<UpdateNotes>> {
    Err(CommandError::not_ported())
}

pub async fn open_url<R: Runtime>(_ctx: Ctx<R>, _url: String) -> CommandResult<()> {
    Err(CommandError::not_ported())
}
