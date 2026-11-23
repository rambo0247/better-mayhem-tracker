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
fn first_paint(started: tauri::State<'_, StartedAt>) {
    log(format!(
        "first paint {} ms after process start",
        started.0.elapsed().as_millis()
    ));
}

pub fn run() {
    let started = Instant::now();
    tauri::Builder::default()
        .runtime(Wry::default())
        .manage(StartedAt(started))
        .invoke_handler(tauri::generate_handler![first_paint])
        .setup(move |app| {
            let (width, height) = WINDOW_SIZE;
            let (min_width, min_height) = WINDOW_MIN_SIZE;
            let (r, g, b) = WINDOW_BACKGROUND;
            let window = WebviewWindowBuilder::new(app, WINDOW_LABEL, WebviewUrl::default())
                .title(PRODUCT_NAME)
                .inner_size(width, height)
                .min_inner_size(min_width, min_height)
                .background_color(tauri::window::Color(r, g, b, 255))
                .build()?;
            let size = window.inner_size()?.to_logical::<f64>(window.scale_factor()?);
            log(format!(
                "window {} title={:?} size={}x{} min={}x{} background=#{:02x}{:02x}{:02x} built {} ms after process start",
                window.label(),
                window.title()?,
                size.width,
                size.height,
                min_width,
                min_height,
                r,
                g,
                b,
                started.elapsed().as_millis()
            ));
            debug_assert_eq!(app.webview_windows().len(), 1);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run the Better Mayhem Tracker shell");
}
