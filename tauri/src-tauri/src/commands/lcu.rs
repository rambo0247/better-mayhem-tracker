//! The League client's status and the history backfill. Ported by T19 and
//! T20.

use serde::{Deserialize, Serialize};
use tauri::{Manager, Runtime, State};
use ts_rs::TS;

use super::{CommandError, CommandResult, Ctx, Domain};
use crate::lcu::sync::LcuSync;

pub struct Hooks;
impl Domain for Hooks {}

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
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
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

fn lcu<R: Runtime>(ctx: &Ctx<R>) -> CommandResult<State<'_, LcuSync>> {
    ctx.app
        .try_state::<LcuSync>()
        .ok_or_else(|| CommandError::thrown("The League client sync is not running"))
}

/// Asked for by hand, so it checks everything Riot still has rather than
/// stopping at the newest page it recognises.
pub async fn backfill_history<R: Runtime>(ctx: Ctx<R>) -> CommandResult<BackfillOutcome> {
    Ok(lcu(&ctx)?.backfill_from_settings().await)
}

pub async fn cancel_backfill<R: Runtime>(ctx: Ctx<R>) -> CommandResult<()> {
    lcu(&ctx)?.sync.cancel_backfill();
    Ok(())
}

pub async fn is_backfill_running<R: Runtime>(ctx: Ctx<R>) -> CommandResult<bool> {
    Ok(lcu(&ctx)?.sync.is_backfill_running())
}

pub async fn get_lcu_status<R: Runtime>(ctx: Ctx<R>) -> CommandResult<LcuStatus> {
    Ok(lcu(&ctx)?.lcu.status().into())
}
