use std::cell::Cell;
use std::rc::Rc;

use base64::Engine as _;
use tauri::WebviewWindow;
use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
use windows_core::HSTRING;

use super::{Snapshot, SnapshotOptions, SnapshotResult};

/// Calls a Chrome DevTools Protocol method on the window's WebView2 and hands
/// `done` the JSON result. This is the channel Playwright drives Chromium on.
pub fn cdp(
    window: &WebviewWindow,
    method: &str,
    params: String,
    done: impl FnOnce(Result<String, String>) + Send + 'static,
) -> tauri::Result<()> {
    let method = method.to_string();
    window.with_webview(move |platform| {
        let done = Rc::new(Cell::new(Some(done)));
        let finish = move |result: Result<String, String>| {
            if let Some(done) = done.take() {
                done(result);
            }
        };
        let Some(webview) = platform.downcast_ref::<tauri_runtime_wry::Webview>() else {
            return finish(Err("the webview is not a wry webview".into()));
        };
        // SAFETY: wry's controller is live, and this closure runs on the main thread
        let core = match unsafe { webview.controller().CoreWebView2() } {
            Ok(core) => core,
            Err(error) => return finish(Err(error.to_string())),
        };
        let on_done = finish.clone();
        let handler =
            CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |status, json| {
                on_done(status.map(|()| json).map_err(|error| error.to_string()));
                Ok(())
            }));
        let started = unsafe {
            core.CallDevToolsProtocolMethod(
                &HSTRING::from(method),
                &HSTRING::from(params),
                &handler,
            )
        };
        if let Err(error) = started {
            finish(Err(error.to_string()));
        }
    })
}

pub fn snapshot(
    window: &WebviewWindow,
    // The device scale comes from --force-device-scale-factor in the browser
    // arguments, the flag the Electron baseline runs with
    _options: SnapshotOptions,
    done: impl FnOnce(SnapshotResult) + Send + 'static,
) -> tauri::Result<()> {
    let backing_scale = window.scale_factor()?;
    cdp(
        window,
        "Page.captureScreenshot",
        r#"{"format":"png","captureBeyondViewport":false,"fromSurface":true}"#.into(),
        move |result| {
            done(result.and_then(|json| decode(&json, backing_scale)));
        },
    )
}

fn decode(json: &str, backing_scale: f64) -> SnapshotResult {
    let value: serde_json::Value = serde_json::from_str(json).map_err(|e| e.to_string())?;
    let data = value["data"]
        .as_str()
        .ok_or("Page.captureScreenshot returned no data")?;
    let png = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|e| e.to_string())?;
    let (width, height) = png_size(&png).ok_or("the screenshot is not a PNG")?;
    Ok(Snapshot {
        png,
        width,
        height,
        source_color_space: "as rendered (--force-color-profile)".into(),
        backing_scale,
    })
}

fn png_size(png: &[u8]) -> Option<(usize, usize)> {
    let header = png.get(16..24)?;
    let width = u32::from_be_bytes(header[0..4].try_into().ok()?);
    let height = u32::from_be_bytes(header[4..8].try_into().ok()?);
    Some((width as usize, height as usize))
}
