//! Export, import and the puuid repair. Ported by T18.

use serde::{Deserialize, Serialize};
use tauri::Runtime;
use ts_rs::TS;

use super::{CommandError, CommandResult, Ctx, Domain};

pub struct Hooks;
impl Domain for Hooks {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct ImportProgress {
    pub current: i64,
    pub total: i64,
    pub imported: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct ExportDataResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub games: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct ImportDataResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub imported: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RepairResult {
    pub repaired_games: i64,
    pub discovered_accounts: i64,
    pub rebuilt_games: i64,
}

pub async fn export_data<R: Runtime>(_ctx: Ctx<R>) -> CommandResult<ExportDataResult> {
    Err(CommandError::not_ported())
}

pub async fn import_data<R: Runtime>(_ctx: Ctx<R>) -> CommandResult<ImportDataResult> {
    Err(CommandError::not_ported())
}

pub async fn repair_puuids<R: Runtime>(_ctx: Ctx<R>) -> CommandResult<RepairResult> {
    Err(CommandError::not_ported())
}
