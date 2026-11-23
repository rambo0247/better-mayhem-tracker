//! The settings the page may read and write, and whether autostart is
//! offered. Ported by T11 and T23.

use tauri::Runtime;

use super::{CommandError, CommandResult, Ctx, Domain};

pub struct Hooks;
impl Domain for Hooks {}

pub async fn get_setting<R: Runtime>(_ctx: Ctx<R>, _key: String) -> CommandResult<Option<String>> {
    Err(CommandError::not_ported())
}

pub async fn is_auto_start_supported<R: Runtime>(_ctx: Ctx<R>) -> CommandResult<bool> {
    Err(CommandError::not_ported())
}

pub async fn set_setting<R: Runtime>(
    _ctx: Ctx<R>,
    _key: String,
    _value: String,
) -> CommandResult<()> {
    Err(CommandError::not_ported())
}
