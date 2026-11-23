//! A PNG of the webview's own pixels, taken inside the process, so it needs no
//! Screen Recording permission. The parity driver captures with it, and card
//! export (T25) will reuse it in release builds.

#[cfg(target_os = "macos")]
mod mac;
#[cfg(windows)]
pub mod win;

use tauri::WebviewWindow;

#[derive(Debug, Clone, Copy)]
pub struct SnapshotOptions {
    /// Device pixels per CSS pixel in the PNG, whatever the display's own scale.
    pub scale: f64,
    /// The CSS px width and height to take from the viewport's top left, when the
    /// webview's frame is larger than the area the page lays out in.
    pub size: Option<(f64, f64)>,
}

#[derive(Debug)]
pub struct Snapshot {
    pub png: Vec<u8>,
    pub width: usize,
    pub height: usize,
    /// The color space the engine handed back, before conversion to sRGB.
    pub source_color_space: String,
    /// The display's device pixels per CSS pixel when the snapshot was taken.
    pub backing_scale: f64,
}

pub type SnapshotResult = Result<Snapshot, String>;

/// Starts a snapshot of the whole viewport. `done` runs later, on the main
/// thread, so a caller on another thread waits on a channel with a timeout.
pub fn snapshot(
    window: &WebviewWindow,
    options: SnapshotOptions,
    done: impl FnOnce(SnapshotResult) + Send + 'static,
) -> tauri::Result<()> {
    #[cfg(target_os = "macos")]
    return mac::snapshot(window, options, done);
    #[cfg(windows)]
    return win::snapshot(window, options, done);
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = (window, options);
        done(Err("snapshots are built for macOS and Windows only".into()));
        Ok(())
    }
}
