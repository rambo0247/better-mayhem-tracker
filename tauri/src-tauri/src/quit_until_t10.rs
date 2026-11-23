//! The quit until T10's shell is in the base. T10 owns every quit path and
//! calls [`crate::quit`] itself, so the restack deletes this file and its
//! `mod` line whole.

use std::time::Duration;

use tauri::{AppHandle, RunEvent, Runtime};

use crate::quit::{self, FinalFetch};

/// Electron's `FINAL_FETCH_TIMEOUT_MS`.
const FINAL_FETCH_TIMEOUT: Duration = Duration::from_millis(5_000);

pub fn on_run_event<R: Runtime>(app: &AppHandle<R>, event: RunEvent) {
    match event {
        RunEvent::ExitRequested { code, api, .. } => {
            let Some(fetch) = fetch_for(code, || quit::final_fetch(app)) else {
                return;
            };
            api.prevent_exit();
            crate::log("Fetching games before quit...");
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let fetched = tokio::time::timeout(FINAL_FETCH_TIMEOUT, fetch)
                    .await
                    .unwrap_or_else(|_| Err("timed out".into()));
                if let Err(err) = fetched {
                    crate::log(format!("Final fetch on quit failed: Error: {err}"));
                }
                app.exit(0);
            });
        }
        RunEvent::Exit => {
            quit::stop_polling(app);
            crate::log("Shutting down");
            quit::will_quit(app);
        }
        _ => {}
    }
}

/// The last window closing asks with no code. `app.exit()` carries one and
/// skips the fetch, as Electron's `app.exit` skips `before-quit`.
fn fetch_for(code: Option<i32>, start: impl FnOnce() -> Option<FinalFetch>) -> Option<FinalFetch> {
    code.is_none().then(start).flatten()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_exit_skips_the_final_fetch() {
        assert!(fetch_for(Some(0), || panic!("app.exit() started a fetch")).is_none());
        assert!(fetch_for(None, || Some(Box::pin(async { Ok(()) }))).is_some());
        assert!(fetch_for(None, || None).is_none());
    }
}
