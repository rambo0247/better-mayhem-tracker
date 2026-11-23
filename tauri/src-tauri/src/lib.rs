// clippy.toml's time reads are refused in command bodies only
#![allow(clippy::disallowed_methods)]

// commands::guarded turns a panicking body into a rejected call, which only
// an unwinding build can do; an aborting one would end the app instead
#[cfg(panic = "abort")]
compile_error!(
    "Better Mayhem Tracker must build with panic = \"unwind\": a panicking command rejects its call rather than ending the app"
);

pub mod app_menu;
pub mod backup;
#[deny(clippy::disallowed_methods)]
pub mod commands;
#[cfg(any(not(bmt_release_profile), debug_assertions))]
pub mod data_guard;
pub mod db;
pub mod dialogs;
pub mod events;
pub mod import;
pub mod install_location;
pub mod intl;
pub mod js_arg;
// Its entry points carry allow(dead_code) until T08's commands and T20 call them
mod lcu;
pub mod locale;
pub mod log;
pub mod op_score;
#[cfg(feature = "parity-driver")]
mod parity_driver;
#[cfg(feature = "parity-driver")]
mod parity_shell;
pub mod paths;
#[cfg(feature = "parity-driver")]
pub mod replay;
pub mod security;
pub mod session;
pub mod shell;
pub mod single_instance;
// Card export (T25) calls it in release builds; until then only the driver does
#[cfg_attr(not(feature = "parity-driver"), allow(dead_code))]
mod snapshot;
pub mod text;
pub mod transfer;
pub mod tray;

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

#[tauri::command]
fn page_event(started: tauri::State<'_, StartedAt>, name: String) {
    log(format!(
        "page {name} {} ms after process start",
        started.0.elapsed().as_millis()
    ));
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
    env!("BMT_APP_VERSION")
}

/// The state and commands every build of the app has, the golden replay's
/// mock app included. Each domain adds its own state through
/// `commands::Domain::register`. The data root is resolved here, each time an
/// app is built, so a lane process can build apps over several roots.
pub fn app_builder<R: Runtime>(builder: Builder<R>, host: Host) -> Builder<R> {
    let paths = Paths::resolve();
    let clock = host.clock;
    let builder = match open_database(&paths, &host.clock) {
        Some((database, backups)) => builder.manage(database).manage(backups),
        None => builder,
    };
    commands::register(builder, &host)
        .manage(StartedAt(Instant::now()))
        .manage(host.clock)
        .manage(paths)
        .manage(host.effects)
        .plugin(backup::schedule(clock))
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
    let builder = app_builder(builder, host)
        .manage(shell::Shell::new(hidden, |line| log(line)))
        .plugin(tauri_plugin_dialog::init())
        .on_window_event(shell::on_window_event);
    // Electron's window with `show: false` never takes focus, so a login
    // launch leaves the app the user is in active
    #[cfg(target_os = "macos")]
    let builder = builder.activate_ignoring_other_apps(!hidden);
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
            #[cfg(feature = "parity-driver")]
            parity_driver::prepare(app);
            #[cfg(feature = "parity-driver")]
            parity_shell::install_stand_ins(app.handle());
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
