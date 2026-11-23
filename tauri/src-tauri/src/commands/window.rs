//! The custom title bar's window controls. Ported by T10.

use tauri::Runtime;

use super::{CommandError, CommandResult, Ctx};

pub async fn minimize_window<R: Runtime>(_ctx: Ctx<R>) -> CommandResult<()> {
    Err(CommandError::not_ported())
}

pub async fn toggle_maximize_window<R: Runtime>(_ctx: Ctx<R>) -> CommandResult<()> {
    Err(CommandError::not_ported())
}

pub async fn close_window<R: Runtime>(_ctx: Ctx<R>) -> CommandResult<()> {
    Err(CommandError::not_ported())
}

pub async fn is_window_maximized<R: Runtime>(_ctx: Ctx<R>) -> CommandResult<bool> {
    Err(CommandError::not_ported())
}
