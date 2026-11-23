//! A PNG of the webview's own pixels, taken inside the process, so it needs no
//! Screen Recording permission. The parity driver captures with it, and card
//! export (T25) photographs its card windows with it in release builds.

#[cfg(target_os = "macos")]
mod mac;
#[cfg(windows)]
pub mod win;

use tauri::WebviewWindow;

// WebView2 captures the viewport at the device scale its emulation already set
#[cfg_attr(windows, allow(dead_code))]
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

/// How a card window's webview turns CSS px into device px for the export.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum CardScale {
    /// The webview renders at exactly the card's scale. On macOS that is
    /// WebKit's `_setOverrideDeviceScaleFactor:` (decision E9), on Windows
    /// rasterization scale 1 times page zoom, as Electron's Chromium does it.
    Exact(f64),
    /// The private call is gone, so WebKit renders at the display's backing
    /// scale and the snapshot is scaled to the card's width afterwards.
    Backing(f64),
}

impl CardScale {
    /// Device px per CSS px the webview renders the page at.
    pub fn rendered(self) -> f64 {
        match self {
            CardScale::Exact(scale) | CardScale::Backing(scale) => scale,
        }
    }
}

/// Sets the card window's device scale before the page measures anything.
/// `done` runs on the main thread.
pub fn prepare_card_scale(
    window: &WebviewWindow,
    scale: f64,
    done: impl FnOnce(Result<CardScale, String>) + Send + 'static,
) -> tauri::Result<()> {
    #[cfg(target_os = "macos")]
    return mac::prepare_card_scale(window, scale, done);
    #[cfg(windows)]
    return win::prepare_card_scale(window, scale, done);
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = (window, scale);
        done(Err("card export is built for macOS and Windows only".into()));
        Ok(())
    }
}

/// A card's picture: the `width` by `height` CSS px at the page's top left,
/// `width * scale` device px wide, whatever the window's own size.
#[derive(Debug, Clone, Copy)]
pub struct CardShot {
    pub width: f64,
    pub height: f64,
    // WebView2 already renders at it, through the zoom `prepare_card_scale` set
    #[cfg_attr(windows, allow(dead_code))]
    pub scale: f64,
    pub rendered: CardScale,
}

/// A card's pixels: 8-bit sRGB, three bytes a pixel, rows packed top down.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CardBitmap {
    pub rgb: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

pub type CardResult = Result<CardBitmap, String>;

/// A PNG's pixels as a [`CardBitmap`], alpha dropped. WebView2 hands the card
/// back as a PNG.
#[cfg(any(windows, test))]
pub fn bitmap_from_png(png: &[u8]) -> CardResult {
    let mut decoder = png::Decoder::new(std::io::Cursor::new(png));
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = decoder.read_info().map_err(|e| e.to_string())?;
    let mut buffer = vec![
        0;
        reader
            .output_buffer_size()
            .ok_or("the snapshot is too large")?
    ];
    let frame = reader.next_frame(&mut buffer).map_err(|e| e.to_string())?;
    let channels = frame.color_type.samples();
    let mut rgb = Vec::with_capacity(frame.width as usize * frame.height as usize * 3);
    for row in buffer.chunks(frame.line_size).take(frame.height as usize) {
        for pixel in row[..frame.width as usize * channels].chunks(channels) {
            match pixel {
                [gray] | [gray, _] => rgb.extend_from_slice(&[*gray; 3]),
                [r, g, b, ..] => rgb.extend_from_slice(&[*r, *g, *b]),
                _ => return Err("the snapshot has no pixels".into()),
            }
        }
    }
    Ok(CardBitmap {
        rgb,
        width: frame.width,
        height: frame.height,
    })
}

pub fn card_snapshot(
    window: &WebviewWindow,
    shot: CardShot,
    done: impl FnOnce(CardResult) + Send + 'static,
) -> tauri::Result<()> {
    #[cfg(target_os = "macos")]
    return mac::card_snapshot(window, shot, done);
    #[cfg(windows)]
    return win::card_snapshot(window, shot, done);
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = (window, shot);
        done(Err("card export is built for macOS and Windows only".into()));
        Ok(())
    }
}
