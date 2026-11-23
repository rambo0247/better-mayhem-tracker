//! Export, import and the puuid repair. Ported by T18.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use tauri::{Manager, Runtime};
use ts_rs::TS;

use super::{CommandResult, Ctx, Domain};
use crate::backup::{Backups, Reason};
use crate::db::scoring::ChampionClasses;
use crate::db::{self, Database, repair};
use crate::dialogs::{Dialogs, OpenDialog, SaveDialog, json_filter};
use crate::dragon::Dragon;
use crate::events;
use crate::import::{self, ImportError, ImportEvent, ImportTarget};
use crate::transfer;

pub struct Hooks;
impl Domain for Hooks {
    /// What T05's `ipc-cases.ts` answered each data dialog with, and the
    /// files its `prepare` wrote first, under the case's data folder.
    #[cfg(feature = "parity-driver")]
    fn before_golden_case<R: Runtime>(app: &tauri::AppHandle<R>, case: &super::GoldenCase<'_>) {
        use crate::dialogs::Answers;
        if !case.channel.starts_with("data:") {
            return;
        }
        let run = |name: &str| Some(case.root.join(name));
        let write = |name: &str, text: &str| {
            std::fs::write(case.root.join(name), text).expect("prepare a file");
        };
        let answers = match (case.channel, case.case) {
            ("data:export", "export") => Answers {
                save: run("export.json"),
                open: None,
            },
            ("data:import", "same-file") => Answers {
                save: None,
                open: run("export.json"),
            },
            ("data:import", "not-json") => {
                write("not-json.json", "this is not json");
                Answers {
                    save: None,
                    open: run("not-json.json"),
                }
            }
            ("data:import", "wrong-shape") => {
                write("wrong-shape.json", r#"{"hello":"world"}"#);
                Answers {
                    save: None,
                    open: run("wrong-shape.json"),
                }
            }
            _ => Answers::default(),
        };
        if app.try_state::<Dialogs>().is_none() {
            app.manage(Dialogs::scripted());
        }
        app.state::<Dialogs>().answer(answers);
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct ImportProgress {
    pub current: i64,
    pub total: i64,
    pub imported: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct ExportDataResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub games: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct ImportDataResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub imported: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RepairResult {
    pub repaired_games: i64,
    pub discovered_accounts: i64,
    pub rebuilt_games: i64,
}

/// A `Ctx` that blocking work can own.
fn owned<R: Runtime>(ctx: &Ctx<R>) -> Ctx<R> {
    Ctx {
        app: ctx.app.clone(),
        window: ctx.window.clone(),
    }
}

/// The dialogs this app shows: the OS's unless the app manages a scripted
/// [`Dialogs`], as golden replay and parity lanes do.
fn dialogs<R: Runtime>(ctx: &Ctx<R>) -> &Dialogs {
    static SYSTEM: Dialogs = Dialogs::System;
    ctx.app
        .try_state::<Dialogs>()
        .map_or(&SYSTEM, |state| state.inner())
}

/// `snapshotBeforeWrite` for imports and repairs: a backup that is logged
/// when it fails and never stops the work.
fn backup_quietly<R: Runtime>(ctx: &Ctx<R>, db: &Database, reason: Reason) {
    if let (Some(backups), Ok(now_ms)) = (ctx.app.try_state::<Backups>(), ctx.now_ms()) {
        backups.backup_quietly(db, reason, now_ms);
    }
}

/// `getChampionClasses()` and `getChampionDataVersion()`: what Data Dragon's
/// loaded state holds right now, the disk copy until a fetch replaces it.
fn champion_classes<R: Runtime>(app: &tauri::AppHandle<R>) -> ChampionClasses {
    app.try_state::<Dragon>()
        .map_or_else(ChampionClasses::none, |dragon| dragon.champion_classes())
}

/// `new Date().toISOString().slice(0, 10)`.
fn utc_date(now_ms: i64) -> String {
    jiff::Timestamp::from_millisecond(now_ms)
        .map(|t| t.strftime("%Y-%m-%d").to_string())
        .unwrap_or_default()
}

pub async fn export_data<R: Runtime>(ctx: Ctx<R>) -> CommandResult<ExportDataResult> {
    let options = SaveDialog {
        title: "Export Better Mayhem Tracker Data".into(),
        default_path: format!("better-mayhem-backup-{}.json", utc_date(ctx.now_ms()?)),
        filters: json_filter(),
    };
    let Some(path) = dialogs(&ctx).save(&ctx.window, options).await else {
        return Ok(ExportDataResult {
            success: false,
            path: None,
            games: None,
            error: None,
        });
    };
    let written = {
        let (owned, path) = (owned(&ctx), path.clone());
        ctx.blocking(move || {
            Ok(db::of(&owned)
                .map_err(|err| err.message)
                .and_then(|db| transfer::write_export_to(&db, &path)))
        })
        .await?
    };
    Ok(match written {
        Ok(games) => ExportDataResult {
            success: true,
            path: Some(path.to_string_lossy().into_owned()),
            games: Some(games),
            error: None,
        },
        Err(message) => {
            // A partial file would still look like a backup, so don't leave one
            let _ = std::fs::remove_file(&path);
            ExportDataResult {
                success: false,
                path: None,
                games: None,
                error: Some(format!("Export failed: {message}")),
            }
        }
    })
}

/// `importing` in `import.ts`: one import at a time.
static IMPORTING: AtomicBool = AtomicBool::new(false);

/// The one import running, cleared when it ends however it ends, a panic
/// included, as `importing`'s `finally` clears it.
struct Importing(());

impl Importing {
    fn start() -> Option<Self> {
        (!IMPORTING.swap(true, Ordering::SeqCst)).then_some(Self(()))
    }
}

impl Drop for Importing {
    fn drop(&mut self) {
        IMPORTING.store(false, Ordering::SeqCst);
    }
}

/// Runs `work` as the one import, off the async workers.
async fn exclusively<R: Runtime>(
    ctx: &Ctx<R>,
    work: impl FnOnce() -> Result<i64, ImportError> + Send + 'static,
) -> CommandResult<Result<i64, ImportError>> {
    let Some(importing) = Importing::start() else {
        return Ok(Err(ImportError::Thrown(
            "An import is already running".into(),
        )));
    };
    ctx.blocking(move || {
        let _importing = importing;
        Ok(work())
    })
    .await
}

pub async fn import_data<R: Runtime>(ctx: Ctx<R>) -> CommandResult<ImportDataResult> {
    let options = OpenDialog {
        title: "Import Better Mayhem Tracker Data".into(),
        filters: json_filter(),
        properties: vec!["openFile".into()],
    };
    let Some(path) = dialogs(&ctx).open(&ctx.window, options).await else {
        return Ok(ImportDataResult {
            success: false,
            imported: None,
            error: None,
        });
    };
    // Anything can be chosen in that dialog, so unreadable files, malformed
    // JSON and well-formed JSON that isn't a backup all come back as messages
    let outcome = {
        let owned = owned(&ctx);
        exclusively(&ctx, move || import_file(&owned, &path)).await?
    };
    Ok(match outcome {
        Ok(imported) => ImportDataResult {
            success: true,
            imported: Some(imported),
            error: None,
        },
        Err(err) => ImportDataResult {
            success: false,
            imported: None,
            error: Some(format!(
                "Import failed: {}",
                match err {
                    ImportError::Syntax => "it isn't valid JSON".into(),
                    ImportError::Thrown(message) => message,
                }
            )),
        },
    })
}

fn import_file<R: Runtime>(ctx: &Ctx<R>, path: &Path) -> Result<i64, ImportError> {
    let db = db::of(ctx).map_err(|err| ImportError::Thrown(err.message))?;
    let champions = champion_classes(&ctx.app);
    let clock = *ctx.app.state::<super::Clock>();
    let now_ms = move || clock.now_ms();
    let target = ImportTarget {
        db: &db,
        classes: &champions.classes,
        now_ms: &now_ms,
    };
    import::import_backup_file(
        path,
        &target,
        || backup_quietly(ctx, &db, Reason::PreImport),
        &mut |event| match event {
            ImportEvent::Progress(progress) => events::import_progress(&ctx.app, &progress),
            ImportEvent::GamesUpdated => events::games_updated(&ctx.app),
        },
    )
}

pub async fn repair_puuids<R: Runtime>(ctx: Ctx<R>) -> CommandResult<RepairResult> {
    // Repair rescoring needs champion classes; wait so a repair triggered
    // right after launch doesn't score with default weights
    if let Some(dragon) = ctx.app.try_state::<Dragon>() {
        dragon.wait_for_champion_data().await;
    }
    let owned = owned(&ctx);
    ctx.blocking(move || {
        let ctx = owned;
        let db = db::of(&ctx)?;
        let champions = champion_classes(&ctx.app);
        // A repair reassigns game ownership and rewrites every derived stat,
        // so there is no undo for it short of the snapshot taken here
        backup_quietly(&ctx, &db, Reason::PreRepair);
        let clock = *ctx.app.state::<super::Clock>();
        db.with(|conn| repair::repair_puuids(conn, &champions, || clock.now_ms()))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dialogs::Answers;
    use serde_json::{Value, json};
    use std::sync::{Arc, Mutex};
    use tauri::Listener;
    use tauri::test::{INVOKE_KEY, mock_builder, mock_context, noop_assets};

    fn mock_ctx() -> Ctx<tauri::test::MockRuntime> {
        let app = mock_builder()
            .build(mock_context(noop_assets()))
            .expect("build the mock app");
        let window =
            tauri::WebviewWindowBuilder::new(&app, crate::WINDOW_LABEL, Default::default())
                .build()
                .expect("build the mock window");
        Ctx {
            app: app.handle().clone(),
            window,
        }
    }

    /// `importing` is cleared in a `finally`, so an import that throws, or
    /// here panics, never leaves every later import refused.
    #[test]
    fn one_import_runs_at_a_time_and_a_panic_ends_it() {
        let ctx = mock_ctx();
        let (started, wait) = std::sync::mpsc::channel();
        let (release, held) = std::sync::mpsc::channel::<()>();
        let first = tauri::async_runtime::spawn({
            let ctx = owned(&ctx);
            async move {
                exclusively(&ctx, move || {
                    started.send(()).expect("say it started");
                    held.recv().expect("wait to be released");
                    Ok(1)
                })
                .await
            }
        });
        wait.recv().expect("the first import starts");
        assert_eq!(
            tauri::async_runtime::block_on(exclusively(&ctx, || Ok(2))),
            Ok(Err(ImportError::Thrown(
                "An import is already running".into()
            )))
        );
        release.send(()).expect("release the first");
        assert_eq!(
            tauri::async_runtime::block_on(first).expect("the first import joins"),
            Ok(Ok(1))
        );

        let hook = std::panic::take_hook();
        std::panic::set_hook(Box::new(|_| {}));
        let panicked =
            tauri::async_runtime::block_on(exclusively(&ctx, || panic!("index out of bounds")));
        std::panic::set_hook(hook);
        assert_eq!(
            panicked,
            Err(crate::commands::CommandError::thrown("index out of bounds"))
        );
        assert_eq!(
            tauri::async_runtime::block_on(exclusively(&ctx, || Ok(3))),
            Ok(Ok(3))
        );
    }

    #[test]
    fn default_names_take_the_utc_date() {
        // 2026-11-22T21:00 in New York, where the goldens were recorded
        assert_eq!(utc_date(1_795_399_200_000), "2026-11-23");
    }

    /// Runs the data channels through Tauri's IPC on folders an Electron
    /// probe prepared, one app per scenario, and writes what each answered
    /// beside it, for the probe to compare with trunk Electron's run on a
    /// copy of the same folder. `BMT_T18_SCENARIOS` names the list; without
    /// it there is nothing to run.
    #[test]
    // Times each call against Electron's; clippy.toml's clock rule is for bodies
    #[allow(clippy::disallowed_methods)]
    fn electron_scenarios() {
        let Some(list) = std::env::var_os("BMT_T18_SCENARIOS") else {
            return;
        };
        let scenarios: Vec<Value> =
            serde_json::from_str(&std::fs::read_to_string(list).unwrap()).unwrap();
        let clock = crate::commands::Clock::Fixed(1_795_399_200_000);
        for scenario in scenarios {
            let root = std::path::PathBuf::from(scenario["root"].as_str().unwrap());
            // SAFETY: this test is the only one that runs with the variable set
            unsafe { std::env::set_var("BMT_DATA_ROOT", &root) };
            let app = crate::app_builder(mock_builder(), crate::Host::replay(clock))
                .manage(Dialogs::scripted())
                .build(mock_context(noop_assets()))
                .unwrap();
            let window =
                tauri::WebviewWindowBuilder::new(&app, crate::WINDOW_LABEL, Default::default())
                    .build()
                    .unwrap();
            let events = Arc::new(Mutex::new(Vec::new()));
            for name in ["data:import-progress", "lcu:games-updated"] {
                let events = events.clone();
                app.listen_any(name, move |event| {
                    let payload: Value =
                        serde_json::from_str(event.payload()).unwrap_or(Value::Null);
                    events
                        .lock()
                        .unwrap()
                        .push(json!({ "event": name, "payload": payload }));
                });
            }
            let path = |key: &str| scenario[key].as_str().map(std::path::PathBuf::from);
            app.state::<Dialogs>().answer(Answers {
                save: path("save"),
                open: path("open"),
            });
            let request = tauri::webview::InvokeRequest {
                cmd: scenario["channel"].as_str().unwrap().into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: "tauri://localhost".parse().unwrap(),
                body: tauri::ipc::InvokeBody::Json(json!({})),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_string(),
            };
            let started = std::time::Instant::now();
            let answer = tauri::test::get_ipc_response(&window, request)
                .map(|body| body.deserialize::<Value>().unwrap());
            let shown: Vec<Value> = app
                .state::<Dialogs>()
                .take()
                .iter()
                .map(|s| s.seam_record())
                .collect();
            let out = json!({
                "answer": match answer { Ok(v) => json!({ "ok": v }), Err(e) => json!({ "err": e }) },
                "events": *events.lock().unwrap(),
                "shown": shown,
                "ms": started.elapsed().as_secs_f64() * 1000.0,
            });
            std::fs::write(root.join("rust-result.json"), out.to_string()).unwrap();
            // Waits out the launch backup, which runs on its own thread
            if let Some(backups) = app.try_state::<Backups>() {
                backups.list().expect("list the backups");
            }
            if let Some(db) = app.try_state::<Database>() {
                db.close();
            }
            drop(window);
            drop(app);
        }
    }

    /// Data Dragon hydrates the cache file at startup, and these are what the
    /// file's own reader gave for each of them before data.rs asked Dragon,
    /// checked against that reader then.
    #[test]
    fn champion_classes_are_what_the_disk_copy_gave() {
        use crate::assets::tests::Rig;
        let entry = |class: &str| format!(r#"{{"name":"N","key":"K","class":"{class}"}}"#);
        let mixed = format!(
            r#"{{"version":"16.20.1","champions":{{"1":{},"62":{{"name":"N","key":"K","class":""}},"x":{},"3":{{"name":"N","key":"K"}},"2.5":{},"-4":{},"5":"junk","06":{}}}}}"#,
            entry("Mage"),
            entry("Fighter"),
            entry("Tank"),
            entry("Support"),
            entry("Slayer"),
        );
        let numeric = format!(
            r#"{{"version":16.1,"champions":{{"1":{}}}}}"#,
            entry("Mage")
        );
        type Case<'a> = (&'a str, Option<String>, &'a str, Vec<(i64, &'a str)>);
        let cases: [Case; 8] = [
            ("missing", None, "none", vec![]),
            ("not-json", Some("nope".into()), "none", vec![]),
            (
                "no-version",
                Some(format!(r#"{{"champions":{{"1":{}}}}}"#, entry("Mage"))),
                "none",
                vec![],
            ),
            (
                "empty-version",
                Some(format!(
                    r#"{{"version":"","champions":{{"1":{}}}}}"#,
                    entry("Mage")
                )),
                "none",
                vec![],
            ),
            (
                "no-champions",
                Some(r#"{"version":"16.1.1"}"#.into()),
                "none",
                vec![],
            ),
            (
                "zero-version",
                Some(format!(
                    r#"{{"version":0,"champions":{{"1":{}}}}}"#,
                    entry("Mage")
                )),
                "none",
                vec![],
            ),
            ("numeric-version", Some(numeric), "16.1", vec![(1, "Mage")]),
            (
                "mixed",
                Some(mixed),
                "16.20.1",
                vec![(-4, "Support"), (1, "Mage"), (6, "Slayer")],
            ),
        ];
        for (name, file, version, classes) in cases {
            let rig = Rig::new(name);
            let data = rig.root.join("data");
            std::fs::create_dir_all(&data).unwrap();
            if let Some(text) = file {
                std::fs::write(data.join("champion-cache.json"), text).unwrap();
            }
            let dragon = Dragon::new(rig.web.clone(), rig.assets.clone(), data);
            drop(dragon.load_champion_data());
            let app = mock_builder()
                .manage(dragon)
                .build(mock_context(noop_assets()))
                .unwrap();
            let got = champion_classes(app.handle());
            let mut got_classes: Vec<(i64, &str)> = got
                .classes
                .iter()
                .map(|(id, c)| (*id, c.as_str()))
                .collect();
            got_classes.sort();
            assert_eq!(got.version, version, "{name}");
            assert_eq!(got_classes, classes, "{name}");
            std::fs::remove_dir_all(&rig.root).ok();
        }
    }

    #[test]
    fn without_data_dragon_there_are_no_classes() {
        let app = mock_builder().build(mock_context(noop_assets())).unwrap();
        let got = champion_classes(app.handle());
        assert_eq!(got.version, "none");
        assert!(got.classes.is_empty());
    }
}
