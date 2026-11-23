//! The custom title bar's window controls, on the window that asked, as
//! Electron's `senderWindow(event)`.

use tauri::Runtime;

use super::{CommandError, CommandResult, Ctx, Domain};

pub struct Hooks;
impl Domain for Hooks {}

fn failed(error: tauri::Error) -> CommandError {
    CommandError::thrown(error.to_string())
}

pub async fn minimize_window<R: Runtime>(ctx: Ctx<R>) -> CommandResult<()> {
    ctx.window.minimize().map_err(failed)
}

pub async fn toggle_maximize_window<R: Runtime>(ctx: Ctx<R>) -> CommandResult<()> {
    if ctx.window.is_maximized().map_err(failed)? {
        ctx.window.unmaximize().map_err(failed)
    } else {
        ctx.window.maximize().map_err(failed)
    }
}

/// Goes through the close handler in `shell.rs`, so the setting decides
/// between the tray and quitting.
pub async fn close_window<R: Runtime>(ctx: Ctx<R>) -> CommandResult<()> {
    ctx.window.close().map_err(failed)
}

pub async fn is_window_maximized<R: Runtime>(ctx: Ctx<R>) -> CommandResult<bool> {
    ctx.window.is_maximized().map_err(failed)
}
