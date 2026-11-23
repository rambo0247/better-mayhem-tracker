//! The League client's status and the history backfill. Ported by T19 and
//! T20.

use serde::{Deserialize, Serialize};
use tauri::Runtime;
use ts_rs::TS;

use super::{CommandError, CommandResult, Ctx};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum LcuStatus {
    Disconnected,
    Connecting,
    Connected,
    Ingame,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct BackfillProgress {
    pub current: i64,
    pub total: i64,
    pub added: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "lowercase", rename_all_fields = "camelCase")]
pub enum BackfillLimit {
    Service { history_start: i64 },
    Paging,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BackfillResult {
    pub added: i64,
    pub scanned: i64,
    pub checked: i64,
    pub total_games: i64,
    pub limit: Option<BackfillLimit>,
    pub cancelled: bool,
}

/// `BackfillResult | { error: string }`, the backfill's answer and the
/// `lcu:backfill-done` payload
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(untagged)]
pub enum BackfillOutcome {
    Done(BackfillResult),
    Failed { error: String },
}

pub async fn backfill_history<R: Runtime>(_ctx: Ctx<R>) -> CommandResult<BackfillOutcome> {
    Err(CommandError::not_ported())
}

pub async fn cancel_backfill<R: Runtime>(_ctx: Ctx<R>) -> CommandResult<()> {
    Err(CommandError::not_ported())
}

pub async fn is_backfill_running<R: Runtime>(_ctx: Ctx<R>) -> CommandResult<bool> {
    Err(CommandError::not_ported())
}

pub async fn get_lcu_status<R: Runtime>(_ctx: Ctx<R>) -> CommandResult<LcuStatus> {
    Err(CommandError::not_ported())
}
