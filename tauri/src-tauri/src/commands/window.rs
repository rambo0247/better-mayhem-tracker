//! The custom title bar's window controls, on the window that asked, as
//! Electron's `senderWindow(event)`.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{Builder, Manager, Runtime, Window};

use super::{CommandError, CommandResult, Ctx, Domain};
use crate::Host;
use crate::security::Effects;

/// The main window's maximize state.
struct Maximize {
    /// What the page was last told, so each change is told once.
    told: AtomicBool,
    /// Golden replay's window, whose mock runtime neither maximizes nor
    /// resizes. It holds the state here and resizes as the OS does.
    replay: Option<AtomicBool>,
}

pub struct Hooks;
impl Domain for Hooks {
    fn register<R: Runtime>(builder: Builder<R>, host: &Host) -> Builder<R> {
        builder.manage(Maximize {
            told: AtomicBool::new(false),
            replay: matches!(host.effects, Effects::Recorded(_)).then(AtomicBool::default),
        })
    }
}

fn failed(error: tauri::Error) -> CommandError {
    CommandError::thrown(error.to_string())
}

fn is_maximized<R: Runtime>(window: &Window<R>) -> tauri::Result<bool> {
    match &window.state::<Maximize>().replay {
        Some(replay) => Ok(replay.load(Ordering::SeqCst)),
        None => window.is_maximized(),
    }
}

/// Electron's `maximize` and `unmaximize` events. Tauri has neither, so a
/// change is read off each resize of the main window.
pub fn resized<R: Runtime>(window: &Window<R>) {
    let maximized = is_maximized(window).unwrap_or(false);
    if window
        .state::<Maximize>()
        .told
        .swap(maximized, Ordering::SeqCst)
        != maximized
    {
        crate::events::maximized_changed(window.app_handle(), &maximized);
    }
}

pub async fn minimize_window<R: Runtime>(ctx: Ctx<R>) -> CommandResult<()> {
    ctx.window.minimize().map_err(failed)
}

pub async fn toggle_maximize_window<R: Runtime>(ctx: Ctx<R>) -> CommandResult<()> {
    let window = ctx.window.as_ref().window();
    let maximize = !is_maximized(&window).map_err(failed)?;
    match &window.state::<Maximize>().replay {
        Some(replay) => {
            replay.store(maximize, Ordering::SeqCst);
            resized(&window);
            Ok(())
        }
        None if maximize => window.maximize().map_err(failed),
        None => window.unmaximize().map_err(failed),
    }
}

/// Goes through the close handler in `shell.rs`, so the setting decides
/// between the tray and quitting.
pub async fn close_window<R: Runtime>(ctx: Ctx<R>) -> CommandResult<()> {
    ctx.window.close().map_err(failed)
}

pub async fn is_window_maximized<R: Runtime>(ctx: Ctx<R>) -> CommandResult<bool> {
    is_maximized(&ctx.window.as_ref().window()).map_err(failed)
}
