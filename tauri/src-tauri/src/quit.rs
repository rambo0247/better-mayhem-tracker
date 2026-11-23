//! What a quit runs, in the order T10's shell calls it: the final fetch in
//! `before-quit`, then `stopPolling`, then, after the `Shutting down` line,
//! `will-quit`'s `closeDatabase`.

use futures_util::future::BoxFuture;
use tauri::{AppHandle, Manager, Runtime};

use crate::db::Database;
use crate::lcu::sync::LcuSync;

/// Ends with the error text Electron logs. T10's `shell::FinalFetch`.
pub type FinalFetch = BoxFuture<'static, Result<(), String>>;

/// `None` unless the client is connected, and after the first fetch a launch.
pub fn final_fetch<R: Runtime>(app: &AppHandle<R>) -> Option<FinalFetch> {
    app.try_state::<LcuSync>()?.final_fetch()
}

pub fn stop_polling<R: Runtime>(app: &AppHandle<R>) {
    if let Some(lcu) = app.try_state::<LcuSync>() {
        lcu.stop_polling();
    }
}

/// Checkpoints the WAL, so a quit leaves no `-wal` file.
pub fn will_quit<R: Runtime>(app: &AppHandle<R>) {
    if let Some(database) = app.try_state::<Database>() {
        database.close();
    }
}
