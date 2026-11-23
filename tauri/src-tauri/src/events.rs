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
        #[cfg(feature = "parity-driver")]
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
    use std::sync::{Arc, Mutex};

    use tauri::test::{mock_builder, mock_context, noop_assets};
    use tauri::{Listener, WebviewWindowBuilder};

    use super::*;
    use crate::commands::lcu::BackfillResult;

    #[test]
    fn eleven_unique_events() {
        let specs = event_specs();
        assert_eq!(specs.len(), 11);
        let names: std::collections::HashSet<_> = specs.iter().map(|s| s.name).collect();
        assert_eq!(names.len(), 11);
    }

    #[test]
    fn the_main_window_hears_every_emitter_under_its_electron_name() {
        let app = mock_builder()
            .build(mock_context(noop_assets()))
            .expect("build the mock app");
        let main = WebviewWindowBuilder::new(&app, WINDOW_LABEL, Default::default())
            .build()
            .expect("build the main window");
        let card = WebviewWindowBuilder::new(&app, "card", Default::default())
            .build()
            .expect("build the card window");
        let heard = Arc::new(Mutex::new(Vec::<(String, String)>::new()));
        let card_heard = Arc::new(Mutex::new(0));
        for spec in event_specs() {
            let heard = heard.clone();
            main.listen(spec.name, move |event| {
                let name = spec.name.to_owned();
                heard
                    .lock()
                    .unwrap()
                    .push((name, event.payload().to_owned()));
            });
            let card_heard = card_heard.clone();
            card.listen(spec.name, move |_| *card_heard.lock().unwrap() += 1);
        }

        let handle = app.handle();
        status_changed(handle, &LcuStatus::Connected);
        games_updated(handle);
        backfill_progress(
            handle,
            &BackfillProgress {
                current: 1,
                total: 2,
                added: 0,
            },
        );
        backfill_done(
            handle,
            &BackfillOutcome::Done(BackfillResult {
                added: 1,
                scanned: 2,
                checked: 3,
                total_games: 4,
                limit: None,
                cancelled: false,
            }),
        );
        live_changed(
            handle,
            &LiveGameSnapshot {
                in_game: false,
                starting: false,
                game_id: None,
                queue_id: None,
                map_id: None,
                map_name: None,
                map_skin: None,
                game_time: crate::js_arg::JsNumber(0.0),
                players: Vec::new(),
                events: Vec::new(),
            },
        );
        challenges_changed(
            handle,
            &ChallengesResult {
                data: None,
                pending: true,
            },
        );
        update_progress(handle, &50);
        update_installing(handle, &UpdateInfo::default());
        update_install_failed(handle, &"checksum".to_owned());
        maximized_changed(handle, &true);
        import_progress(
            handle,
            &ImportProgress {
                current: 1,
                total: 3,
                imported: 1,
            },
        );

        let heard = heard.lock().unwrap().clone();
        let names: Vec<&str> = heard.iter().map(|(name, _)| name.as_str()).collect();
        let expected: Vec<&str> = event_specs().iter().map(|s| s.name).collect();
        assert_eq!(
            names, expected,
            "each event reaches the main window once, in order"
        );
        let payload = |name: &str| heard.iter().find(|(n, _)| n == name).unwrap().1.clone();
        assert_eq!(payload("lcu:status-changed"), "\"connected\"");
        assert_eq!(payload("lcu:games-updated"), "null");
        assert_eq!(payload("update:progress"), "50");
        assert_eq!(payload("update:installing"), r#"{"hasUpdate":false}"#);
        assert_eq!(
            payload("lcu:backfill-done"),
            r#"{"added":1,"scanned":2,"checked":3,"totalGames":4,"limit":null,"cancelled":false}"#
        );
        assert_eq!(
            *card_heard.lock().unwrap(),
            0,
            "the card window hears no event"
        );
    }
}
