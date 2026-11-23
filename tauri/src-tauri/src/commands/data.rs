//! Export, import and the puuid repair. Ported by T18.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{Manager, Runtime};
use ts_rs::TS;

use super::{CommandResult, Ctx, Domain};
use crate::backup::{Backups, Reason};
use crate::db::scoring::ChampionClasses;
use crate::db::{self, Database, js, repair};
use crate::dialogs::{Dialogs, OpenDialog, SaveDialog, json_filter};
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

/// `getChampionClasses()` and `getChampionDataVersion()` from the champion
/// cache Electron hydrates at startup, `champion-cache.json` beside
/// `matches.db`, until T22 hands over the loaded Data Dragon state.
fn champion_classes(db: &Database) -> ChampionClasses {
    let mut champions = ChampionClasses::none();
    let cached = db
        .path()
        .parent()
        .and_then(|dir| std::fs::read_to_string(dir.join("champion-cache.json")).ok())
        .and_then(|text| serde_json::from_str::<Value>(&text).ok());
    let Some(cached) = cached else {
        return champions;
    };
    let entries = js::opt_prop(Some(&cached), "champions");
    let version = js::opt_prop(Some(&cached), "version");
    if !js::truthy(entries) || !js::truthy(version) {
        return champions;
    }
    champions.version = match version {
        Some(Value::String(v)) => v.clone(),
        Some(other) => js::stringify(other).trim_matches('"').to_owned(),
        None => String::new(),
    };
    if let Some(Value::Object(entries)) = entries {
        for (id, champ) in entries {
            let class = js::opt_prop(Some(champ), "class");
            if let (Ok(id), true) = (id.parse::<i64>(), js::truthy(class))
                && let Some(class) = js::string(class)
            {
                champions.classes.insert(id, class.to_owned());
            }
        }
    }
    champions
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
    let written = db::of(&ctx)
        .map_err(|err| err.message)
        .and_then(|db| transfer::write_export_to(&db, &path));
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
    let outcome = if IMPORTING.swap(true, Ordering::SeqCst) {
        Err(ImportError::Thrown("An import is already running".into()))
    } else {
        let outcome = import_file(&ctx, &path);
        IMPORTING.store(false, Ordering::SeqCst);
        outcome
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
    let champions = champion_classes(&db);
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
    let db = db::of(&ctx)?;
    // Repair rescoring needs champion classes; the cache stands in for
    // waitForChampionData until Data Dragon is ported
    let champions = champion_classes(&db);
    // A repair reassigns game ownership and rewrites every derived stat, so
    // there is no undo for it short of the snapshot taken here
    backup_quietly(&ctx, &db, Reason::PreRepair);
    let clock = *ctx.app.state::<super::Clock>();
    db.with(|conn| repair::repair_puuids(conn, &champions, || clock.now_ms()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dialogs::Answers;
    use serde_json::json;
    use std::sync::{Arc, Mutex};
    use tauri::Listener;
    use tauri::test::{INVOKE_KEY, mock_builder, mock_context, noop_assets};

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
}
