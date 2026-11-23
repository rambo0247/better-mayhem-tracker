//! Backups, restore, and the startup recovery report. Ported by T17.

use serde::{Deserialize, Serialize};
use tauri::Runtime;
use ts_rs::TS;

use super::{CommandError, CommandResult, Ctx, Domain};

pub struct Hooks;
impl Domain for Hooks {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct BackupInfo {
    pub file: String,
    pub created: i64,
    pub size: i64,
    pub games: Option<i64>,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct CreateBackupResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub backup: Option<BackupInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct RestoreBackupResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub games: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum RecoveryProblem {
    Missing,
    Corrupt,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryReport {
    pub problem: RecoveryProblem,
    pub restored_from: Option<String>,
    pub quarantined: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub detail: Option<String>,
}

pub async fn list_backups<R: Runtime>(_ctx: Ctx<R>) -> CommandResult<Vec<BackupInfo>> {
    Err(CommandError::not_ported())
}

pub async fn create_backup<R: Runtime>(_ctx: Ctx<R>) -> CommandResult<CreateBackupResult> {
    Err(CommandError::not_ported())
}

pub async fn restore_backup<R: Runtime>(
    _ctx: Ctx<R>,
    _file: String,
) -> CommandResult<RestoreBackupResult> {
    Err(CommandError::not_ported())
}

pub async fn get_recovery_report<R: Runtime>(
    _ctx: Ctx<R>,
) -> CommandResult<Option<RecoveryReport>> {
    Err(CommandError::not_ported())
}

pub async fn open_backup_folder<R: Runtime>(_ctx: Ctx<R>) -> CommandResult<()> {
    Err(CommandError::not_ported())
}
