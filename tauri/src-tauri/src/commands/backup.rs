//! Backups, restore, and the startup recovery report. Ported by T17.

use serde::{Deserialize, Serialize};
use tauri::{Manager, Runtime};
use ts_rs::TS;

use super::{CommandError, CommandResult, Ctx, Domain};
use crate::backup::{Backups, Reason};
use crate::js_arg::Js;
use crate::{db, events};

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

/// The backups state, which exists whenever the database does.
fn backups<R: Runtime>(ctx: &Ctx<R>) -> CommandResult<tauri::State<'_, Backups>> {
    db::of(ctx)?;
    ctx.app
        .try_state::<Backups>()
        .ok_or_else(|| CommandError::thrown("The database connection is not open"))
}

pub async fn list_backups<R: Runtime>(ctx: Ctx<R>) -> CommandResult<Vec<BackupInfo>> {
    backups(&ctx)?.list().map_err(CommandError::thrown)
}

pub async fn create_backup<R: Runtime>(ctx: Ctx<R>) -> CommandResult<CreateBackupResult> {
    let outcome = backups(&ctx)?.create(&*db::of(&ctx)?, Reason::Manual, ctx.now_ms()?);
    Ok(match outcome {
        Ok(backup) => CreateBackupResult {
            success: true,
            backup: Some(backup),
            error: None,
        },
        Err(error) => CreateBackupResult {
            success: false,
            backup: None,
            error: Some(error),
        },
    })
}

pub async fn restore_backup<R: Runtime>(
    ctx: Ctx<R>,
    file: Js<String>,
) -> CommandResult<RestoreBackupResult> {
    // FILE_RE.test(file) reads String(file), which no other value makes a
    // backup's name, so it answers "Not a backup file name" as an empty one does
    let file = file.typed().unwrap_or_default();
    let outcome = backups(&ctx)?.restore(&*db::of(&ctx)?, &file, ctx.now_ms()?);
    Ok(match outcome {
        Ok(games) => {
            // Everything on screen was read from the database just replaced
            events::games_updated(&ctx.app);
            RestoreBackupResult {
                success: true,
                games: Some(games),
                error: None,
            }
        }
        Err(error) => RestoreBackupResult {
            success: false,
            games: None,
            error: Some(error),
        },
    })
}

pub async fn get_recovery_report<R: Runtime>(ctx: Ctx<R>) -> CommandResult<Option<RecoveryReport>> {
    Ok(backups(&ctx)?.recovery_report())
}

/// Needs T09's `Effects` seam, so golden replay records the call instead of
/// opening Finder. The root's rebase onto T09 lands it.
pub async fn open_backup_folder<R: Runtime>(_ctx: Ctx<R>) -> CommandResult<()> {
    Err(CommandError::not_ported())
}
