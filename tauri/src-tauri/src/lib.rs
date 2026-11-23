pub mod commands;
pub mod events;
#[cfg(feature = "parity-driver")]
mod parity_driver;
// Card export (T25) calls it in release builds; until then only the driver does
#[cfg_attr(not(feature = "parity-driver"), allow(dead_code))]
mod snapshot;

use std::time::Instant;

use tauri::{Builder, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};
use tauri_runtime_wry::Wry;

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

/// The state and commands every build of the app has, the golden replay's
/// mock app included.
pub fn app_builder<R: Runtime>(builder: Builder<R>, clock: commands::Clock) -> Builder<R> {
    builder
        .manage(StartedAt(Instant::now()))
        .manage(clock)
        .invoke_handler(commands::handler())
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

pub fn run() {
    let started = Instant::now();
    let builder = app_builder(
        tauri::Builder::default().runtime(Wry::default()),
        commands::Clock::System,
    );
    #[cfg(feature = "parity-driver")]
    let builder = parity_driver::install(builder);
    builder
        .setup(move |app| {
            #[cfg(feature = "parity-driver")]
            parity_driver::prepare(app);
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
                .initialization_script(boot_script(None));
            #[cfg(feature = "parity-driver")]
            let window = parity_driver::configure(window);
            let window = window.build()?;
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
            #[cfg(feature = "parity-driver")]
            parity_driver::start(&window)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run the Better Mayhem Tracker shell");
}
