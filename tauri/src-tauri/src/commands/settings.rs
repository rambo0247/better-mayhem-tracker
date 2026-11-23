//! The settings the page may read and write, and whether autostart is
//! offered. Ported by T11 and T23.

use tauri::Runtime;

use rusqlite::params;

use super::{CommandError, CommandResult, Ctx, Domain};
use crate::autostart::{self, LoginItems};
use crate::db::js::Cell;
use crate::db::{self, js, settings};
use crate::js_arg::{Js, JsValue};

pub struct Hooks;
impl Domain for Hooks {}

/// `RENDERER_SETTINGS.has(key)`: a Set holds strings only, so any other value
/// is not a renderer setting.
fn renderer_key(key: &Js<String>) -> Option<&str> {
    match key.value().and_then(JsValue::as_json) {
        Some(serde_json::Value::String(key)) if settings::is_renderer_setting(key) => Some(key),
        _ => None,
    }
}

/// The stored value as Electron hands it to the page, a blob or a number
/// included, which the page's own comparisons then reject.
pub async fn get_setting<R: Runtime>(ctx: Ctx<R>, key: Js<String>) -> CommandResult<Cell> {
    let Some(key) = renderer_key(&key) else {
        return Ok(Cell::Null);
    };
    db::of(&ctx)?.with(|conn| settings::get_setting(conn, key))
}

pub async fn is_auto_start_supported<R: Runtime>(_ctx: Ctx<R>) -> CommandResult<bool> {
    Ok(autostart::is_supported())
}

pub async fn set_setting<R: Runtime>(
    ctx: Ctx<R>,
    key: Js<String>,
    value: Js<String>,
) -> CommandResult<()> {
    let Some(key) = renderer_key(&key) else {
        eprintln!("Refused to write non-renderer setting: {}", js_text(&key));
        return Ok(());
    };
    // better-sqlite3 binds the value as the page sent it
    db::of(&ctx)?.with(|conn| {
        conn.prepare_cached("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")?
            .execute(params![key, js::bind_js(value.value())?])?;
        // The one setting with a home outside the database: the login item
        // is rewritten to match, on `value === "true"`
        if key == "auto_start" {
            let enabled = matches!(
                value.value().and_then(JsValue::as_json),
                Some(serde_json::Value::String(text)) if text == "true"
            );
            let target = autostart::registered_target();
            autostart::apply(conn, &LoginItems::System, target.as_deref(), enabled)?;
        }
        Ok(())
    })
}

/// How `console.warn` prints the refused key.
fn js_text(key: &Js<String>) -> String {
    match key.value() {
        None => "undefined".to_owned(),
        Some(JsValue::NonFinite(n)) => js::number_to_string(*n),
        Some(JsValue::Json(serde_json::Value::String(text))) => text.clone(),
        Some(JsValue::Json(other)) => other.to_string(),
    }
}
