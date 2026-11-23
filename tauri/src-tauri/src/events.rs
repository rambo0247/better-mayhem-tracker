//! The push half of the IPC contract: one emitter per event the main process
//! sends the page, under its Electron name. Every event goes to the main
//! window alone, as Electron's `sendToRenderer(mainWindow, ...)` does, so the
//! card window never hears one.

use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime};

use crate::WINDOW_LABEL;
use crate::commands::TypeSpec;
use crate::commands::app::UpdateInfo;
use crate::commands::data::ImportProgress;
use crate::commands::lcu::{BackfillOutcome, BackfillProgress, LcuStatus};
use crate::commands::live::{ChallengesResult, LiveGameSnapshot};

#[derive(Clone, Copy)]
pub struct EventSpec {
    pub name: &'static str,
    pub payload: TypeSpec,
}

fn emit<R: Runtime, T: Serialize + Clone>(app: &AppHandle<R>, name: &str, payload: T) {
    // Electron drops an event whose window has gone; so does a missing label here
    if let Err(error) = app.emit_to(WINDOW_LABEL, name, payload) {
        eprintln!("emit {name} failed: {error}");
    }
}

macro_rules! events {
    ($( $emitter:ident $name:literal $( ($payload:ty) )? ; )*) => {
        $( events!(@emitter $emitter $name $( $payload )?); )*

        /// Every event, in the order of `RendererEvents` in `api.ts`.
        pub fn event_specs() -> Vec<EventSpec> {
            vec![$( EventSpec { name: $name, payload: TypeSpec::of::<events!(@ty $( $payload )?)>() } ),*]
        }

        /// Emits an event by name from its JSON payload, through the same
        /// typed emitter the app uses. Parity lanes drive each event with it.
        pub fn emit_by_name<R: Runtime>(
            app: &AppHandle<R>,
            name: &str,
            payload: serde_json::Value,
        ) -> Result<(), String> {
            match name {
                $( $name => {
                    let payload: events!(@ty $( $payload )?) =
                        serde_json::from_value(payload).map_err(|e| format!("{name}: {e}"))?;
                    events!(@call $emitter app payload $( $payload )?);
                    Ok(())
                } )*
                _ => Err(format!("no event named {name}")),
            }
        }
    };
    (@emitter $emitter:ident $name:literal) => {
        pub fn $emitter<R: Runtime>(app: &AppHandle<R>) {
            emit(app, $name, ());
        }
    };
    (@emitter $emitter:ident $name:literal $payload:ty) => {
        pub fn $emitter<R: Runtime>(app: &AppHandle<R>, payload: &$payload) {
            emit(app, $name, payload);
        }
    };
    (@ty) => { () };
    (@ty $payload:ty) => { $payload };
    (@call $emitter:ident $app:ident $value:ident) => {{
        let () = $value;
        $emitter($app)
    }};
    (@call $emitter:ident $app:ident $value:ident $payload:ty) => {
        $emitter($app, &$value)
    };
}

events! {
    status_changed "lcu:status-changed" (LcuStatus);
    games_updated "lcu:games-updated";
    backfill_progress "lcu:backfill-progress" (BackfillProgress);
    backfill_done "lcu:backfill-done" (BackfillOutcome);
    live_changed "live:changed" (LiveGameSnapshot);
    challenges_changed "challenges:changed" (ChallengesResult);
    update_progress "update:progress" (i64);
    update_installing "update:installing" (UpdateInfo);
    update_install_failed "update:install-failed" (String);
    maximized_changed "window:maximized-changed" (bool);
    import_progress "data:import-progress" (ImportProgress);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn eleven_unique_events() {
        let specs = event_specs();
        assert_eq!(specs.len(), 11);
        let names: std::collections::HashSet<_> = specs.iter().map(|s| s.name).collect();
        assert_eq!(names.len(), 11);
    }
}
