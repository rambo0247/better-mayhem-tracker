#[cfg(feature = "parity-driver")]
mod parity_driver;
// Card export (T25) calls it in release builds; until then only the driver does
#[cfg_attr(not(feature = "parity-driver"), allow(dead_code))]
mod snapshot;

use std::time::Instant;

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
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

pub fn run() {
    let started = Instant::now();
    let builder = tauri::Builder::default()
        .runtime(Wry::default())
        .manage(StartedAt(started))
        .invoke_handler(tauri::generate_handler![page_event]);
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
                .background_color(tauri::window::Color(r, g, b, 255));
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
