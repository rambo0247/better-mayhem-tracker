//! The version, update checks and installs, release notes, and opening URLs
//! and the logs folder. Ported by T09 and T24.

use serde::{Deserialize, Serialize};
use tauri::{Manager, Runtime};
use ts_rs::TS;

use super::{CommandError, CommandResult, Ctx, Domain};
use crate::js_arg::{Js, JsValue};
use crate::paths::Paths;
use crate::security::{self, Effects};
use crate::updater;

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

/// The log is what a bug report needs attached.
pub async fn open_logs_folder<R: Runtime>(ctx: Ctx<R>) -> CommandResult<()> {
    let dir = ctx
        .app
        .state::<Paths>()
        .log_dir()
        .map_err(|e| CommandError::thrown(e.to_string()))?;
    ctx.app.state::<Effects>().open_path(&dir);
    Ok(())
}

pub async fn get_version<R: Runtime>(_ctx: Ctx<R>) -> CommandResult<String> {
    Ok(crate::app_version().to_owned())
}

pub async fn check_for_update<R: Runtime>(ctx: Ctx<R>) -> CommandResult<UpdateInfo> {
    let host = updater::AppHost::of(&ctx.app);
    let updater = ctx.app.state::<updater::State>().updater.clone();
    Ok(updater.check(host.as_ref()).await)
}

/// The Update button's install. Unlike the launch and background installs it
/// does not back out when a match starts during the download, as in Electron.
pub async fn download_update<R: Runtime>(
    ctx: Ctx<R>,
    asset_url: Js<String>,
) -> CommandResult<DownloadUpdateResult> {
    let host = updater::AppHost::of(&ctx.app);
    let updater = ctx.app.state::<updater::State>().updater.clone();
    Ok(updater
        .download_and_install(host, &js_string(&asset_url), false)
        .await)
}

pub async fn get_launch_install<R: Runtime>(ctx: Ctx<R>) -> CommandResult<Option<UpdateInfo>> {
    Ok(ctx.app.state::<updater::State>().updater.launch_install())
}

pub async fn get_update_notes<R: Runtime>(ctx: Ctx<R>) -> CommandResult<Option<UpdateNotes>> {
    let host = updater::AppHost::of(&ctx.app);
    let updater = ctx.app.state::<updater::State>().updater.clone();
    Ok(updater.update_notes(host.as_ref()).await)
}

pub async fn open_url<R: Runtime>(ctx: Ctx<R>, url: Js<String>) -> CommandResult<()> {
    // Electron's `new URL(url)` reads String(url), and only a string can
    // spell a web page
    security::open_external_url(&ctx.app.state::<Effects>(), &js_string(&url));
    Ok(())
}

/// `String(value)` for a string argument the page sent, as Electron's
/// handlers read it through `new URL` and string methods.
fn js_string(value: &Js<String>) -> String {
    match value.value().and_then(JsValue::as_json) {
        Some(serde_json::Value::String(text)) => text.clone(),
        Some(other) => other.to_string(),
        None => "undefined".to_owned(),
    }
}
