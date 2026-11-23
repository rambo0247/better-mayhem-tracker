// clippy.toml's time reads are refused in command bodies only
#![allow(clippy::disallowed_methods)]

// commands::guarded turns a panicking body into a rejected call, which only
// an unwinding build can do; an aborting one would end the app instead
#[cfg(panic = "abort")]
compile_error!(
    "Better Mayhem Tracker must build with panic = \"unwind\": a panicking command rejects its call rather than ending the app"
);

pub mod app_menu;
mod asset_cache;
mod assets;
pub mod autostart;
pub mod backup;
mod challenges;
#[deny(clippy::disallowed_methods)]
pub mod commands;
#[cfg(any(not(bmt_release_profile), debug_assertions))]
pub mod data_guard;
pub mod db;
pub mod dialogs;
// The commands that read it land with the dragon bodies, still stubs
#[allow(dead_code)]
mod dragon;
pub mod events;
// export:card-image and export:copy-card-image reach it once T25's restack
// wires T08's export bodies to it
#[allow(dead_code)]
mod export_image;
pub mod import;
pub mod install_location;
pub mod intl;
pub mod js_arg;
mod lcu;
mod live;
pub mod local_storage;
pub mod locale;
pub mod log;
pub mod mac_update_script;
pub mod op_score;
#[cfg(feature = "parity-driver")]
mod parity_driver;
#[cfg(feature = "parity-driver")]
mod parity_shell;
pub mod paths;
mod quit;
#[cfg(feature = "parity-driver")]
pub mod replay;
pub mod security;
pub mod session;
pub mod shell;
pub mod shortcut;
pub mod single_instance;
// Card export (T25) calls it in release builds; until then only the driver does
#[cfg_attr(not(feature = "parity-driver"), allow(dead_code))]
mod snapshot;
pub mod text;
pub mod transfer;
pub mod tray;
pub mod updater;
pub mod webview2;

use std::sync::Arc;
use std::time::Instant;

use tauri::{Builder, Manager, RunEvent, Runtime, WebviewUrl, WebviewWindowBuilder};
use tauri_runtime_wry::Wry;

use crate::commands::Clock;
use crate::paths::Paths;
use crate::security::Effects;

pub const PRODUCT_NAME: &str = "Better Mayhem Tracker";
pub const WINDOW_LABEL: &str = "main";
pub const WINDOW_SIZE: (f64, f64) = (1280.0, 820.0);
pub const WINDOW_MIN_SIZE: (f64, f64) = (900.0, 600.0);
pub const WINDOW_BACKGROUND: (u8, u8, u8) = (0x0a, 0x10, 0x24);

struct StartedAt(Instant);

fn log(message: impl AsRef<str>) {
    println!("[bmt pid={}] {}", std::process::id(), message.as_ref());
}

/// The line a page event logs. First content names its first row as JSON
/// text, which T06's probe reads to prove the run opened the fixture copy.
fn page_line(name: &str, ms: u128, row: Option<&str>) -> String {
    let mut line = format!("page {name} {ms} ms after process start");
    if let Some(row) = row.filter(|_| name == "first-content") {
        line.push_str(" row=");
        line.push_str(&serde_json::Value::from(row).to_string());
    }
    line
}

#[tauri::command]
fn page_event(
    started: tauri::State<'_, StartedAt>,
    paths: tauri::State<'_, Paths>,
    clock: tauri::State<'_, Clock>,
    confirmation: tauri::State<'_, local_storage::Confirmation>,
    name: String,
    row: Option<String>,
) {
    let line = page_line(&name, started.0.elapsed().as_millis(), row.as_deref());
    // T06's launch probe reads first-content from stdout, or from the file
    // BMT_PERF_LOG names, since a Windows release build has no stdout
    if name == "first-content" {
        if std::env::var_os("BMT_PERF").is_none_or(|value| value != "1") {
            return;
        }
        if let Some(path) = std::env::var_os("BMT_PERF_LOG") {
            use std::io::Write;
            let written = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)
                .and_then(|mut file| writeln!(file, "[bmt pid={}] {line}", std::process::id()));
            if let Err(error) = written {
                log(format!("could not write BMT_PERF_LOG: {error}"));
            }
        }
    }
    log(line);
    if name == local_storage::FILLED_EVENT {
        match confirmation.confirm(&paths, clock.now_ms()) {
            Ok(Some(carried)) => log(format!(
                "local storage import: page set {carried} keys, recorded"
            )),
            Ok(None) => {}
            Err(error) => log(format!(
                "local storage import: could not record it, will retry next start, {error}"
            )),
        }
    }
}

/// What the app runs against besides its data root, which golden replay and
/// parity lanes swap for a frozen clock and a recorder.
pub struct Host {
    pub clock: Clock,
    pub effects: Effects,
}

impl Host {
    /// The release app's host: the system clock and the real OS effects.
    pub fn system() -> Self {
        Self {
            clock: Clock::System,
            effects: Effects::System,
        }
    }

    /// The host golden replay builds every mock app on: `clock`, and nothing
    /// that reaches the operator's machine. A field a later unit adds for an
    /// OS seam gets its recording form here, never its real one, so a replayed
    /// `app:open-url` records the URL instead of opening it.
    #[cfg(feature = "parity-driver")]
    pub fn replay(clock: Clock) -> Self {
        Self {
            clock,
            effects: Effects::recorded(),
        }
    }
}

/// Electron's `app.getVersion()`: the root package.json's version, the one
/// the Electron release carries, so both builds of a release agree. build.rs
/// reads it.
pub fn app_version() -> &'static str {
    // A lane builds a release above 1.2.1 without editing package.json
    #[cfg(feature = "parity-driver")]
    if let Some(version) = option_env!("BMT_PARITY_VERSION") {
        return version;
    }
    env!("BMT_APP_VERSION")
}

/// The state and commands every build of the app has, the golden replay's
/// mock app included. Each domain adds its own state through
/// `commands::Domain::register`. The data root is resolved here, each time an
/// app is built, so a lane process can build apps over several roots.
pub fn app_builder<R: Runtime>(builder: Builder<R>, host: Host) -> Builder<R> {
    let paths = Paths::resolve();
    let clock = host.clock;
    // Golden replay recorded Electron with the network blocked
    let github = match host.effects {
        Effects::System => updater::Github::from_env(),
        Effects::Recorded(_) => updater::Github::blocked(),
    };
    let builder = match open_database(&paths, &host.clock) {
        Some((database, backups)) => builder.manage(database).manage(backups),
        None => builder,
    };
    commands::register(builder, &host)
        .manage(StartedAt(Instant::now()))
        .manage(host.clock)
        .manage(paths)
        .manage(host.effects)
        .manage(local_storage::Confirmation::default())
        .plugin(backup::schedule(clock))
        .manage(updater::State::new(github))
        .plugin(lcu::sync::plugin())
        .plugin(live::plugin())
        .invoke_handler(commands::handler())
}

/// `matches.db` in the data folder, which the guard has already passed, with
/// its backups beside it. Recovery runs first, before anything reads the
/// database.
fn open_database(paths: &Paths, clock: &Clock) -> Option<(db::Database, backup::Backups)> {
    let opened = paths
        .data_dir()
        .and_then(|dir| Ok((dir, paths.backup_dir()?)))
        .map_err(|err| err.to_string())
        .and_then(|(dir, backups)| {
            backup::init_database_with_recovery(&dir, backups, clock.now_ms())
                .map_err(|err| format!("{}: {err}", dir.display()))
        });
    match opened {
        Ok(opened) => Some(opened),
        Err(err) => {
            log::error(format!("Failed to open the database in {err}"));
            None
        }
    }
}

/// Where the login item goes. A parity build told to count as packaged writes
/// it under its data root, never the signed-in user's LaunchAgents or Run key.
fn login_items(paths: &Paths) -> autostart::LoginItems {
    if install_location::parity_packaged() {
        return autostart::LoginItems::At {
            launch_agents: paths.root().join("LaunchAgents"),
            run_key: r"Software\BetterMayhemTracker-parity\Run".into(),
            approved_key: r"Software\BetterMayhemTracker-parity\StartupApproved".into(),
        };
    }
    autostart::LoginItems::System
}

/// Electron's `process.platform` for this OS, which `window.api.platform` is.
pub fn electron_platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    }
}

/// Runs before any page script, so `src/api.ts` can hand the page
/// `platform` and `locale` synchronously, as Electron's preload does.
pub fn boot_script(locale: Option<&str>) -> String {
    let boot = serde_json::json!({ "platform": electron_platform(), "locale": locale });
    format!("Object.defineProperty(window, \"__BMT_BOOT__\", {{ value: Object.freeze({boot}) }});")
}

/// The first thing a launch does once it holds the single-instance lock. A
/// later launch hands over and exits before Tauri builds anything, so it
/// writes nothing, as Electron's second instance writes nothing. The data
/// guard has already run in `app_builder`'s `Paths::resolve`.
fn first_instance_started(hidden: bool) {
    log::start(Paths::resolve(), app_version());
    log(format!(
        "first instance started{}",
        if hidden { " with --hidden" } else { "" }
    ));
}

/// The game asset source and the game data built on it, over the data root's
/// `asset-cache/` and `data/`, as Electron lays them out.
fn game_data(paths: &Paths) -> Option<(assets::GameAssets, dragon::Dragon)> {
    let dirs = paths
        .asset_cache_dir()
        .and_then(|cache| Ok((cache, paths.data_dir()?)));
    let (cache, data) = match dirs {
        Ok(dirs) => dirs,
        Err(err) => {
            assets::log_error(format!("Cannot create the asset folders: {err}"));
            return None;
        }
    };
    let web = match assets::app_web() {
        Ok(web) => web,
        Err(err) => {
            assets::log_error(format!("Cannot build the web client: {err}"));
            return None;
        }
    };
    let game_assets = assets::GameAssets::new(cache, web.clone(), Arc::new(assets::NoClient));
    let dragon = dragon::Dragon::new(web, game_assets.clone(), data);
    Some((game_assets, dragon))
}

pub fn run() {
    let started = Instant::now();
    let mut context = tauri::generate_context!();
    let identifier = shell::scope_identifier(
        &context.config().identifier,
        shell::data_root_override().as_deref(),
    );
    let first = match single_instance::claim(&identifier) {
        single_instance::Claim::First(first) => Some(first),
        single_instance::Claim::HandedOver => std::process::exit(0),
        single_instance::Claim::NoAnswer(error) => {
            eprintln!("Better Mayhem Tracker is already running but did not answer: {error}");
            std::process::exit(1);
        }
        single_instance::Claim::Unguarded(error) => {
            eprintln!("starting without the single-instance lock: {error}");
            None
        }
    };
    // Before anything opens the data root, which a running 1.2.1 has open too
    if let Some(pid) = shell::electron_user_data()
        .as_deref()
        .and_then(single_instance::electron_holder)
    {
        log(format!(
            "Better Mayhem Tracker 1.2.1 (pid {pid}) is running on this data folder, so this launch exits"
        ));
        std::process::exit(0);
    }
    context.config_mut().identifier = identifier;
    let hidden = shell::launched_hidden(std::env::args());
    let locale = locale::system_locale();
    let mut builder = tauri::Builder::default().runtime(Wry::default());
    if let Some(first) = first {
        builder = builder.plugin(first.plugin(|app, _args, _cwd| shell::on_second_launch(app)));
    }
    #[cfg(not(feature = "parity-driver"))]
    let host = Host::system();
    // Lanes freeze the Rust clock as Electron's seam freezes Date
    #[cfg(feature = "parity-driver")]
    let host = Host {
        clock: Clock::from_env().expect("a valid BMT_FIXED_TIME"),
        effects: Effects::System,
    };
    let game_data = game_data(&Paths::resolve());
    let scheme_assets = game_data.as_ref().map(|(assets, _)| assets.clone());
    let builder = app_builder(builder, host)
        .manage(shell::Shell::new(hidden, |line| log(line)))
        .plugin(tauri_plugin_dialog::init())
        .on_window_event(shell::on_window_event)
        // Owns the `asset` name: Tauri's own asset protocol is off
        .register_asynchronous_uri_scheme_protocol(
            assets::ASSET_SCHEME,
            move |_ctx, request, responder| {
                let Some(assets) = scheme_assets.clone() else {
                    responder.respond(
                        tauri::http::Response::builder()
                            .status(503)
                            .body(Vec::new())
                            .expect("a valid response"),
                    );
                    return;
                };
                tauri::async_runtime::spawn(async move {
                    let response = assets.serve(request.method(), request.uri()).await;
                    #[cfg(feature = "parity-driver")]
                    parity_driver::log_asset(request.uri(), response.status().as_u16());
                    responder.respond(response);
                });
            },
        );
    // Electron's window with `show: false` never takes focus, so a login
    // launch leaves the app the user is in active
    #[cfg(target_os = "macos")]
    let builder = builder.activate_ignoring_other_apps(!hidden);
    #[cfg(windows)]
    let builder = builder.plugin(tauri_plugin_clipboard_manager::init());
    #[cfg(feature = "parity-driver")]
    let builder = parity_driver::install(builder);
    // A lane answers the export and import dialogs from a file it writes
    #[cfg(feature = "parity-driver")]
    let builder = match std::env::var_os("BMT_PARITY_DIALOGS") {
        Some(file) => builder.manage(dialogs::Dialogs::File(file.into())),
        None => builder,
    };
    builder
        .setup(move |app| {
            first_instance_started(hidden);
            shell::quit_on_signals(app.handle());
            #[cfg(target_os = "macos")]
            shell::quit_on_terminate(app.handle());
            let shell = app.state::<shell::Shell>();
            let handle = app.handle().clone();
            shell.final_fetch(move || quit::final_fetch(&handle));
            let handle = app.handle().clone();
            shell.on_stop_polling(move || quit::stop_polling(&handle));
            let handle = app.handle().clone();
            shell.on_stop_polling(move || {
                if let Some(tracking) = handle.try_state::<live::Tracking>() {
                    tracking.stop();
                }
            });
            let handle = app.handle().clone();
            shell.on_will_quit(move || quit::will_quit(&handle));
            shortcut::set_process_app_id();
            shortcut::ensure_start_menu_shortcut();
            // Before the window can ask whether this launch is the first on a new version
            updater::record_launch_version(app.handle());
            if let Some(database) = app.try_state::<db::Database>() {
                let target = autostart::registered_target();
                let items = login_items(&Paths::resolve());
                let synced = database.with(|conn| autostart::sync(conn, &items, target.as_deref()));
                if let Err(err) = synced {
                    log::error(format!("Failed to update the login item: {}", err.message));
                }
            }
            #[cfg(feature = "parity-driver")]
            parity_driver::prepare(app);
            #[cfg(feature = "parity-driver")]
            parity_shell::install_stand_ins(app.handle());
            #[cfg(feature = "parity-driver")]
            if let Some(lookup) = export_image::parity_match_lookup() {
                app.manage(lookup);
            }
            if let Some((game_assets, dragon)) = game_data {
                app.manage(game_assets.clone());
                app.manage(dragon.clone());
                app.manage::<Arc<dyn lcu::sync::Champions>>(Arc::new(dragon.clone()));
                // Registered before any command can wait on it
                drop(dragon.load_champion_data());
                tauri::async_runtime::spawn(async move {
                    game_assets.start();
                    dragon.start();
                });
            }
            // Before the window, so the script runs ahead of the page's first read
            let import_started = Instant::now();
            let carried = local_storage::import(
                &app.state::<Paths>(),
                app.state::<Clock>().now_ms(),
            );
            app.state::<local_storage::Confirmation>().expect(&carried);
            log(format!(
                "{} in {:.1} ms",
                carried.summary(),
                import_started.elapsed().as_secs_f64() * 1000.0
            ));
            let (width, height) = WINDOW_SIZE;
            let (min_width, min_height) = WINDOW_MIN_SIZE;
            let (r, g, b) = WINDOW_BACKGROUND;
            let url = WebviewUrl::default();
            #[cfg(feature = "parity-driver")]
            let url = parity_driver::window_url().unwrap_or(url);
            let window = WebviewWindowBuilder::new(app, WINDOW_LABEL, url)
                .title(PRODUCT_NAME)
                .inner_size(width, height)
                .min_inner_size(min_width, min_height)
                .background_color(tauri::window::Color(r, g, b, 255))
                .visible(!hidden)
                .initialization_script(boot_script(locale.as_deref()))
                .initialization_script(shell::devtools_keys_script());
            let window = match carried.script() {
                Some(script) => window.initialization_script(script),
                None => window,
            };
            // The header doubles as the title bar. macOS keeps its traffic
            // lights, inset into the header; tao lays the title bar out 9 pt
            // shorter than Electron, so its y of 24 lands where Electron's 15 does
            #[cfg(target_os = "macos")]
            let window = window
                .title_bar_style(tauri::TitleBarStyle::Overlay)
                .hidden_title(true)
                .traffic_light_position(tauri::LogicalPosition::new(16.0, 24.0));
            // Windows draws its own controls in the header (Header.tsx)
            #[cfg(windows)]
            let window = window.decorations(false);
            let window = security::harden(window, app.handle());
            #[cfg(feature = "parity-driver")]
            let window = parity_driver::configure(window);
            let window = window.build()?;
            // wry makes the webview first responder only in a window built visible
            // and focused. Otherwise AppKit picks one by the key view loop when the
            // window first turns key, and WebKit takes that for a Tab into the page:
            // it focuses the first link, ring and all. Chromium's view takes it
            // directly, so Electron's page focuses nothing.
            #[cfg(target_os = "macos")]
            window.as_ref().set_focus()?;
            let scale = window.scale_factor()?;
            let size = window.inner_size()?.to_logical::<f64>(scale);
            log(format!(
                "window {} title={:?} size={}x{} scale={} visible={} requested_size={}x{} requested_min={}x{} requested_background=#{:02x}{:02x}{:02x} built {} ms after process start",
                window.label(),
                window.title()?,
                size.width,
                size.height,
                scale,
                window.is_visible()?,
                width,
                height,
                min_width,
                min_height,
                r,
                g,
                b,
                started.elapsed().as_millis()
            ));
            debug_assert_eq!(app.webview_windows().len(), 1);
            tray::build(app.handle())?;
            app_menu::install(app.handle())?;
            #[cfg(feature = "parity-driver")]
            parity_driver::start(&window)?;
            // After the window, as Electron's startPolling(win) follows createWindow
            let lcu = app.state::<lcu::sync::LcuSync>();
            lcu.start_polling();
            // Follows the client into and out of matches, and records where the
            // ARAM challenges stand each day the client is up
            app.state::<live::Tracking>()
                .start(tauri::async_runtime::handle().inner(), lcu.lcu.subscribe());
            // Last, so an update never restarts the app under someone using it
            updater::start(app.handle());
            Ok(())
        })
        .build(context)
        .expect("failed to build the Better Mayhem Tracker shell")
        .run(|app, event| {
            // closeDatabase: checkpoint the WAL so a quit leaves no -wal file
            if let RunEvent::Exit = event
                && let Some(database) = app.try_state::<db::Database>()
            {
                database.close();
            }
            shell::on_run_event(app, event);
        });
}

#[cfg(test)]
mod tests {
    use super::page_line;

    #[test]
    fn first_content_names_its_row_as_json_text() {
        assert_eq!(
            page_line(
                "first-content",
                812,
                Some("VICTORY\n\"Kog'Maw\" 16 / 13 / 32")
            ),
            r#"page first-content 812 ms after process start row="VICTORY\n\"Kog'Maw\" 16 / 13 / 32""#
        );
        assert_eq!(
            page_line("first-content", 812, None),
            "page first-content 812 ms after process start"
        );
        // Only first content carries a row
        assert_eq!(
            page_line("local-storage-filled", 9, Some("x")),
            "page local-storage-filled 9 ms after process start"
        );
    }
}
