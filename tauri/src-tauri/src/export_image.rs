//! Card image export, `src/main/export-image.ts`. A card is an ordinary route
//! of the app's own pages. Each export loads it in a throwaway window 1200 CSS
//! px wide at device scale 1.5, waits for the page to say it has finished
//! drawing, sizes the window to the card, and photographs the webview's own
//! pixels. The PNG never crosses IPC: only the result object does.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use jiff::Timestamp;
use jiff::tz::TimeZone;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Listener, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tokio::sync::oneshot;

use crate::snapshot::{self, CardBitmap, CardScale, CardShot};

/// The layout width, `CARD_WIDTH` in `src/shared/card.ts`.
pub const CARD_WIDTH: f64 = 1200.0;
/// Device px per CSS px in the image, Electron's page zoom.
pub const CARD_SCALE: f64 = 1.5;
/// Something to lay the card out in before it has said how tall it is.
const INITIAL_HEIGHT: f64 = 1200.0;
const READY_TIMEOUT: Duration = Duration::from_secs(30);
/// A native call that never answers (a failed downcast, a compositor that
/// stopped painting) fails the attempt instead of hanging the export.
const NATIVE_TIMEOUT: Duration = Duration::from_secs(10);
const CAPTURE_ATTEMPTS: u32 = 3;
/// What `useCardCapture` emits beside `window.__mayhemCardStatus`.
pub const STATUS_EVENT: &str = "card:status";
pub const LABEL_PREFIX: &str = "card-";
/// Electron's `#0a1024`, which shows in the extra row below a card.
const BACKGROUND: tauri::window::Color = tauri::window::Color(0x0a, 0x10, 0x24, 0xff);

// Word for word, because the renderer shows them and the lanes compare them
const WINDOW_CLOSED: &str = "The card window closed before the image was taken";
const NOT_DRAWN: &str = "The card could not be drawn";
const READY_TIMED_OUT: &str = "Timed out waiting for the card to finish drawing";
const BLANK: &str = "The card came back blank";
const CAPTURE_FAILED: &str = "The image couldn't be captured. Try again in a moment.";

/// What a card is of, `CardSpec` in `src/shared/card.ts`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum CardSpec {
    Game {
        game_id: i64,
    },
    Season {
        season_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        queue: Option<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        account: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        hide_friends: Option<bool>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExportCardResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CopyCardResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

// ---------------------------------------------------------------------------
// Names: the route, the dialog title, and the file name the dialog offers

/// `cardRoute`: the hash route of the card's page.
pub fn card_route(card: &CardSpec) -> String {
    match card {
        CardSpec::Game { game_id } => format!("/card/{game_id}"),
        CardSpec::Season {
            season_id,
            queue,
            account,
            hide_friends,
        } => {
            let mut params = Vec::new();
            if let Some(queue) = queue {
                params.push(format!("queue={}", form_encode(&queue.to_string())));
            }
            if let Some(account) = account.as_deref().filter(|a| !a.is_empty()) {
                params.push(format!("account={}", form_encode(account)));
            }
            if *hide_friends == Some(true) {
                params.push("hideFriends=1".to_string());
            }
            let query = params.join("&");
            let path = format!("/season-card/{}", encode_uri_component(season_id));
            if query.is_empty() {
                path
            } else {
                format!("{path}?{query}")
            }
        }
    }
}

/// JavaScript's `encodeURIComponent`.
fn encode_uri_component(text: &str) -> String {
    percent_encode(text, |b| {
        b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b)
    })
}

/// `URLSearchParams`' serializer, `application/x-www-form-urlencoded`.
fn form_encode(text: &str) -> String {
    percent_encode(text, |b| b.is_ascii_alphanumeric() || b"*-._ ".contains(&b)).replace(' ', "+")
}

fn percent_encode(text: &str, keep: impl Fn(u8) -> bool) -> String {
    let mut out = String::with_capacity(text.len());
    for &byte in text.as_bytes() {
        if keep(byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

pub fn dialog_title(card: &CardSpec) -> &'static str {
    match card {
        CardSpec::Game { .. } => "Export Game Image",
        CardSpec::Season { .. } => "Export Season Recap",
    }
}

/// `ALL_TIME_ID` and `SEASONS`' names in `src/shared/seasons.ts`.
const ALL_TIME_ID: &str = "all";
const SEASON_NAMES: [(&str, &str); 4] = [
    ("set-0", "Set 0"),
    ("set-1", "Set 1"),
    ("set-2", "Set 2"),
    ("set-3", "Set 3"),
];

/// What a game card's file name needs from `getMatchDetail`: when the game
/// was played, and the player's champion, when the game has a stats row.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchFacts {
    pub game_creation: i64,
    pub champion_id: Option<i64>,
}

/// Looks a game up for its file name. T13's `getMatchDetail` answers it once
/// the database sits under this branch; until then a parity build reads the
/// facts from a file, and any other build has none.
#[derive(Clone)]
pub struct MatchLookup(pub Arc<dyn Fn(i64) -> Option<MatchFacts> + Send + Sync>);

/// `defaultFileName`. `game` is the game's facts with its champion's name, or
/// `None` when the game is not in the database.
pub fn default_file_name(
    card: &CardSpec,
    now_ms: i64,
    zone: &TimeZone,
    game: Option<(MatchFacts, Option<&str>)>,
) -> String {
    match card {
        CardSpec::Season { season_id, .. } => {
            let name = if season_id == ALL_TIME_ID {
                "all-time"
            } else {
                SEASON_NAMES
                    .iter()
                    .find(|(id, _)| id == season_id)
                    .map_or(season_id.as_str(), |(_, name)| name)
            };
            format!(
                "better-mayhem-{}-recap-{}.png",
                slug(name).to_lowercase(),
                day_key(now_ms, zone)
            )
        }
        CardSpec::Game { game_id } => match game {
            None => format!("better-mayhem-game-{game_id}.png"),
            Some((facts, champion)) => format!(
                "better-mayhem-{}{}-{game_id}.png",
                champion.map_or(String::new(), |name| format!("{}-", slug(name))),
                day_key(facts.game_creation, zone)
            ),
        },
    }
}

/// `slug`: runs of anything but ASCII letters and digits become one dash, and
/// a dash at either end goes.
fn slug(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    for c in name.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') || out.is_empty() {
            out.push('-');
        }
    }
    let out = out.strip_prefix('-').unwrap_or(&out);
    out.strip_suffix('-').unwrap_or(out).to_string()
}

/// `dayKey`: the local calendar date, as the main process's zone reads it.
fn day_key(ms: i64, zone: &TimeZone) -> String {
    Timestamp::from_millisecond(ms)
        .map(|t| zone.to_datetime(t).date().to_string())
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// The PNG Electron's `toPNG` writes

/// A card's pixels, as the export writes and copies them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CardImage {
    pub png: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

/// `ceil(css_height * CARD_SCALE)`, the card's height in the image. Electron
/// sizes the window with the same rounding.
pub fn device_height(css_height: f64) -> u32 {
    (css_height * CARD_SCALE).ceil() as u32
}

/// Encodes a card the way Electron's `NativeImage.toPNG` writes one: 8-bit
/// RGB, cropped to `target_height` rows, with no chunk besides `IHDR`, `IDAT`
/// and `IEND`. WebKit's own PNG carries alpha, a color profile, EXIF and a
/// pixel density that Electron's does not.
pub fn encode_card_png(bitmap: &CardBitmap, target_height: u32) -> Result<CardImage, String> {
    let (width, height) = (bitmap.width, bitmap.height.min(target_height));
    let rows = &bitmap.rgb[..width as usize * height as usize * 3];
    let mut png = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut png, width, height);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        // Level 4 is 1.21x Electron's size for 50 ms more than fdeflate's 1.65x;
        // level 6 is 1.18x for 200 ms more. On Electron's own pixels level 6
        // matches Electron, so the gap left is in WebKit's pixels, not the encoder.
        encoder.set_deflate_compression(png::DeflateCompression::Level(4));
        encoder.set_filter(png::Filter::Adaptive);
        let mut writer = encoder.write_header().map_err(|e| e.to_string())?;
        writer.write_image_data(rows).map_err(|e| e.to_string())?;
    }
    Ok(CardImage { png, width, height })
}

// ---------------------------------------------------------------------------
// The capture window

/// The page's `card:status`, with what Rust checks before the picture.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StatusEvent {
    label: String,
    state: String,
    #[serde(default)]
    height: f64,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    inner_width: f64,
    #[serde(default)]
    dpr: f64,
    #[serde(default)]
    visibility: String,
}

static NEXT_CARD: AtomicU64 = AtomicU64::new(1);

/// Destroys the window when the export leaves, on every path, as Electron's
/// `finally` does. A leaked window is a leaked WebContent process.
struct CardWindow(WebviewWindow);

impl Drop for CardWindow {
    fn drop(&mut self) {
        if let Err(err) = self.0.destroy() {
            crate::assets::log_error(format!(
                "card export: could not close the card window: {err}"
            ));
        }
    }
}

fn card_url(route: &str) -> WebviewUrl {
    #[cfg(feature = "parity-driver")]
    if let Some(WebviewUrl::CustomProtocol(mut url)) = crate::parity_driver::window_url() {
        url.set_fragment(Some(route));
        return WebviewUrl::CustomProtocol(url);
    }
    WebviewUrl::App(format!("index.html#{route}").into())
}

/// Hands a main-thread callback's answer to the async side, or gives up after
/// `NATIVE_TIMEOUT`: `with_webview` silently skips a webview it cannot
/// downcast, and its callback would then never run.
async fn native<T: Send + 'static>(
    what: &str,
    start: impl FnOnce(Box<dyn FnOnce(Result<T, String>) + Send>) -> tauri::Result<()>,
) -> Result<T, String> {
    let (tx, rx) = oneshot::channel();
    start(Box::new(move |result| {
        let _ = tx.send(result);
    }))
    .map_err(|e| e.to_string())?;
    match tokio::time::timeout(NATIVE_TIMEOUT, rx).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err(format!("{what} was dropped")),
        Err(_) => Err(format!("{what} gave no answer within {NATIVE_TIMEOUT:?}")),
    }
}

/// Timings of one render, logged per export for the perf lane.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Timings {
    label: String,
    scale: String,
    visibility: String,
    window_ms: u128,
    ready_ms: u128,
    snapshot_ms: u128,
    encode_ms: u128,
    attempts: u32,
    css_height: f64,
    width: u32,
    height: u32,
}

/// `renderCard`: the card as Electron's `capturePage().toPNG()` would give it.
pub async fn render_card(app: &AppHandle, card: &CardSpec) -> Result<CardImage, String> {
    let started = Instant::now();
    let label = format!(
        "{LABEL_PREFIX}{}",
        NEXT_CARD.fetch_add(1, Ordering::Relaxed)
    );
    let mut timings = Timings {
        label: label.clone(),
        ..Timings::default()
    };

    // Listening before the window exists, so a page that is quick to draw
    // can't report before anyone hears it
    let (status_tx, status_rx) = oneshot::channel::<StatusEvent>();
    let status_tx = Arc::new(Mutex::new(Some(status_tx)));
    let listener = {
        let label = label.clone();
        let status_tx = status_tx.clone();
        app.listen_any(STATUS_EVENT, move |event| {
            let Ok(status) = serde_json::from_str::<StatusEvent>(event.payload()) else {
                return;
            };
            if status.label != label {
                return;
            }
            if let Some(tx) = status_tx.lock().expect("status lock").take() {
                let _ = tx.send(status);
            }
        })
    };
    let result = render_in_window(app, card, &label, status_rx, &mut timings, started).await;
    app.unlisten(listener);
    timings.window_ms = started.elapsed().as_millis();
    if let Ok(image) = &result {
        timings.width = image.width;
        timings.height = image.height;
    }
    crate::assets::log(format!(
        "card export: {}",
        serde_json::to_string(&timings).unwrap_or_default()
    ));
    result
}

async fn render_in_window(
    app: &AppHandle,
    card: &CardSpec,
    label: &str,
    status_rx: oneshot::Receiver<StatusEvent>,
    timings: &mut Timings,
    started: Instant,
) -> Result<CardImage, String> {
    let window = CardWindow(build_card_window(app, label, &card_route(card))?);
    let (closed_tx, closed_rx) = oneshot::channel::<()>();
    let closed_tx = Mutex::new(Some(closed_tx));
    window.0.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed)
            && let Some(tx) = closed_tx.lock().expect("closed lock").take()
        {
            let _ = tx.send(());
        }
    });

    let scale = if public_path_only() {
        Ok(CardScale::Backing(window.0.scale_factor().unwrap_or(1.0)))
    } else {
        native("the scale call", |done| {
            snapshot::prepare_card_scale(&window.0, CARD_SCALE, done)
        })
        .await
    }
    .unwrap_or_else(|err| {
        crate::assets::log_error(format!("card export: {err}"));
        CardScale::Backing(window.0.scale_factor().unwrap_or(1.0))
    });
    timings.scale = format!("{scale:?}");
    if let CardScale::Backing(backing) = scale {
        crate::assets::log_error(format!(
            "card export: _setOverrideDeviceScaleFactor: missing, using backing scale {backing}"
        ));
    }

    let status = tokio::select! {
        status = status_rx => status.map_err(|_| WINDOW_CLOSED.to_string())?,
        _ = closed_rx => return Err(WINDOW_CLOSED.into()),
        () = tokio::time::sleep(READY_TIMEOUT) => return Err(READY_TIMED_OUT.into()),
    };
    timings.ready_ms = started.elapsed().as_millis();
    timings.visibility = status.visibility.clone();
    if status.state == "error" {
        return Err(status
            .error
            .filter(|e| !e.is_empty())
            .unwrap_or_else(|| NOT_DRAWN.into()));
    }
    if status.state != "ready" {
        return Err(NOT_DRAWN.into());
    }
    if status.inner_width != CARD_WIDTH || status.dpr != CARD_SCALE {
        crate::assets::log_error(format!(
            "card export: the card laid out at {} CSS px and scale {}, not {CARD_WIDTH} and {CARD_SCALE}",
            status.inner_width, status.dpr
        ));
    }
    timings.css_height = status.height;

    // WebKit floors the snapshot's height, so one device row more is taken
    // than the card needs and cropped off again
    let target = device_height(status.height);
    let shot_height = f64::from(target + 1) / CARD_SCALE;
    grow(&window.0, shot_height).map_err(|e| e.to_string())?;

    let shot = CardShot {
        width: CARD_WIDTH,
        height: shot_height,
        scale: CARD_SCALE,
        rendered: scale,
    };
    let snapped = Instant::now();
    let mut attempt = 0;
    let bitmap = loop {
        attempt += 1;
        let taken = native("the snapshot", |done| {
            snapshot::card_snapshot(&window.0, shot, done)
        })
        .await
        .and_then(|bitmap| {
            if bitmap.width == 0 || bitmap.height == 0 {
                Err(BLANK.to_string())
            } else {
                Ok(bitmap)
            }
        });
        match taken {
            Ok(bitmap) => break bitmap,
            Err(err) if attempt >= CAPTURE_ATTEMPTS => {
                crate::assets::log_error(format!("Card capture failed: {err}"));
                return Err(CAPTURE_FAILED.into());
            }
            Err(err) => crate::assets::log_error(format!("card export: attempt {attempt}: {err}")),
        }
    };
    timings.attempts = attempt;
    timings.snapshot_ms = snapped.elapsed().as_millis();
    let encoded = Instant::now();
    let image = tauri::async_runtime::spawn_blocking(move || encode_card_png(&bitmap, target))
        .await
        .map_err(|err| err.to_string())
        .and_then(|encoded| encoded)
        .map_err(|err| {
            crate::assets::log_error(format!("Card capture failed: {err}"));
            CAPTURE_FAILED.to_string()
        })?;
    timings.encode_ms = encoded.elapsed().as_millis();
    if image.height != target {
        crate::assets::log_error(format!(
            "card export: the snapshot is {} rows, the card {target}",
            image.height
        ));
    }
    Ok(image)
}

/// A parity build with `BMT_PARITY_CARD_SCALE=backing` takes the path a macOS
/// without the private call would, so the lanes can measure E9's fallback.
fn public_path_only() -> bool {
    #[cfg(feature = "parity-driver")]
    return std::env::var("BMT_PARITY_CARD_SCALE").is_ok_and(|v| v == "backing");
    #[cfg(not(feature = "parity-driver"))]
    false
}

fn build_card_window(app: &AppHandle, label: &str, route: &str) -> Result<WebviewWindow, String> {
    let builder = WebviewWindowBuilder::new(app, label, card_url(route));
    // The driver's data, clock and API scripts, which the main window gets too
    #[cfg(feature = "parity-driver")]
    let builder = crate::parity_driver::configure(builder);
    let builder = builder
        .title(crate::PRODUCT_NAME)
        .visible(false)
        .focused(false)
        .decorations(false)
        .shadow(false)
        .skip_taskbar(true)
        .resizable(false)
        .background_color(BACKGROUND);
    #[cfg(windows)]
    let builder = builder.inner_size(CARD_WIDTH * CARD_SCALE, INITIAL_HEIGHT * CARD_SCALE);
    #[cfg(not(windows))]
    let builder = builder.inner_size(CARD_WIDTH, INITIAL_HEIGHT);
    let window = builder.build().map_err(|e| e.to_string())?;
    // Windows shrinks a window created larger than the screen; a resize after
    // the fact is not clamped
    grow(&window, INITIAL_HEIGHT).map_err(|e| e.to_string())?;
    Ok(window)
}

/// Sizes the window to `css_height` CSS px of a 1200 CSS px wide card. On
/// macOS the override keeps a CSS px one point. On Windows the zoom makes the
/// physical size the CSS size times the card's scale, whatever the monitor.
fn grow(window: &WebviewWindow, css_height: f64) -> tauri::Result<()> {
    #[cfg(windows)]
    return window.set_size(tauri::PhysicalSize::new(
        (CARD_WIDTH * CARD_SCALE).round() as u32,
        (css_height * CARD_SCALE).ceil() as u32,
    ));
    #[cfg(not(windows))]
    window.set_size(tauri::LogicalSize::new(CARD_WIDTH, css_height.ceil()))
}

// ---------------------------------------------------------------------------
// The save dialog

/// What Electron's `showSaveDialog` is called with.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveDialogOptions {
    pub title: String,
    pub default_path: String,
    pub filters: Vec<SaveFilter>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SaveFilter {
    pub name: String,
    pub extensions: Vec<String>,
}

fn save_options(card: &CardSpec, default_name: String) -> SaveDialogOptions {
    SaveDialogOptions {
        title: dialog_title(card).into(),
        default_path: default_name,
        filters: vec![SaveFilter {
            name: "PNG Image".into(),
            extensions: vec!["png".into()],
        }],
    }
}

/// The path the player chose, or `None` when the dialog was dismissed.
async fn ask_save_path(
    app: &AppHandle,
    parent: Option<&WebviewWindow>,
    options: &SaveDialogOptions,
) -> Option<PathBuf> {
    #[cfg(feature = "parity-driver")]
    {
        let _ = app;
        recorded_save_path(parent, options)
    }
    #[cfg(not(feature = "parity-driver"))]
    {
        use tauri_plugin_dialog::DialogExt;
        let mut dialog = app
            .dialog()
            .file()
            .set_title(&options.title)
            .set_file_name(&options.default_path);
        for filter in &options.filters {
            let extensions: Vec<&str> = filter.extensions.iter().map(String::as_str).collect();
            dialog = dialog.add_filter(&filter.name, &extensions);
        }
        // A sheet on the window that asked, hidden or not, as Electron passes it.
        // Without a parent, rfd would sheet it on whichever window AppKit calls
        // main, which can be a card window.
        if let Some(parent) = parent {
            dialog = dialog.set_parent(parent);
        }
        let (tx, rx) = oneshot::channel();
        dialog.save_file(move |path| {
            let _ = tx.send(path);
        });
        rx.await
            .ok()
            .flatten()
            .and_then(|path| path.into_path().ok())
    }
}

/// Parity builds never open a real dialog. The file `BMT_PARITY_SAVE_ANSWER`
/// names is read at each export: a folder in it answers the dialog with
/// `<folder>/<default name>`, and an empty file, or none, dismisses it. Either
/// way the options are logged in the shape Electron's goldens record them, and
/// the window the real dialog would be a sheet on beside them.
#[cfg(feature = "parity-driver")]
fn recorded_save_path(
    parent: Option<&WebviewWindow>,
    options: &SaveDialogOptions,
) -> Option<PathBuf> {
    crate::assets::log(format!(
        "card export: dialog parent {}",
        serde_json::json!({
            "label": parent.map(|w| w.label()),
            "visible": parent.and_then(|w| w.is_visible().ok()),
        })
    ));
    crate::assets::log(format!(
        "card export: save dialog {}",
        serde_json::to_string(options).unwrap_or_default()
    ));
    let answer = std::fs::read_to_string(std::env::var_os("BMT_PARITY_SAVE_ANSWER")?).ok()?;
    let dir = answer.trim();
    (!dir.is_empty()).then(|| std::path::Path::new(dir).join(&options.default_path))
}

// ---------------------------------------------------------------------------
// The two commands

/// The clock the file name is dated by. T08's `Ctx::now_ms` replaces it.
fn now_ms() -> i64 {
    #[cfg(feature = "parity-driver")]
    if let Some(ms) = std::env::var("BMT_FIXED_TIME")
        .ok()
        .and_then(|t| t.trim().parse().ok())
    {
        return ms;
    }
    Timestamp::now().as_millisecond()
}

async fn wait_for_champion_data(app: &AppHandle) {
    if let Some(dragon) = app.try_state::<crate::dragon::Dragon>() {
        dragon.wait_for_champion_data().await;
    }
}

async fn file_name(app: &AppHandle, card: &CardSpec) -> String {
    let game = match card {
        CardSpec::Game { game_id } => app
            .try_state::<MatchLookup>()
            .and_then(|lookup| (lookup.0)(*game_id)),
        CardSpec::Season { .. } => None,
    };
    let champions = match (&game, app.try_state::<crate::dragon::Dragon>()) {
        (
            Some(MatchFacts {
                champion_id: Some(_),
                ..
            }),
            Some(dragon),
        ) => Some(dragon.champion_data().await),
        _ => None,
    };
    let champion = game
        .and_then(|g| g.champion_id)
        .and_then(|id| champions.as_ref()?.get(&id))
        .map(|c| c.name.as_str());
    default_file_name(
        card,
        now_ms(),
        &TimeZone::system(),
        game.map(|g| (g, champion)),
    )
}

/// `export:card-image`. The dialog comes first, so a dismissed one renders
/// nothing and answers `{success: false}` with no error.
pub async fn export_card_image(
    app: &AppHandle,
    parent: Option<&WebviewWindow>,
    card: &CardSpec,
) -> ExportCardResult {
    // Both cards name champions, and the scoreboard scores by champion class
    wait_for_champion_data(app).await;
    let options = save_options(card, file_name(app, card).await);
    let Some(path) = ask_save_path(app, parent, &options).await else {
        return ExportCardResult {
            success: false,
            path: None,
            error: None,
        };
    };
    let written = match render_card(app, card).await {
        Ok(image) => tokio::fs::write(&path, &image.png)
            .await
            .map_err(|err| err.to_string()),
        Err(err) => Err(err),
    };
    match written {
        Ok(()) => ExportCardResult {
            success: true,
            path: Some(path.to_string_lossy().into_owned()),
            error: None,
        },
        Err(error) => ExportCardResult {
            success: false,
            path: None,
            error: Some(error),
        },
    }
}

/// `export:copy-card-image`: the same card onto the clipboard as `image/png`.
pub async fn copy_card_image(app: &AppHandle, card: &CardSpec) -> CopyCardResult {
    wait_for_champion_data(app).await;
    let copied = match render_card(app, card).await {
        Ok(image) => clipboard::write_png(app, image).await,
        Err(err) => Err(err),
    };
    CopyCardResult {
        success: copied.is_ok(),
        error: copied.err(),
    }
}

mod clipboard {
    use tauri::AppHandle;
    #[cfg(target_os = "macos")]
    use tauri::Manager;

    use super::CardImage;

    /// The PNG bytes as `public.png`, the one type Electron's
    /// `ClipboardItem({"image/png": ...})` puts on the general pasteboard.
    #[cfg(target_os = "macos")]
    pub async fn write_png(app: &AppHandle, image: CardImage) -> Result<(), String> {
        super::native("the clipboard", |done| {
            app.run_on_main_thread(move || done(write_to(&general(), &image.png)))
        })
        .await
    }

    #[cfg(target_os = "macos")]
    fn general() -> objc2::rc::Retained<objc2_app_kit::NSPasteboard> {
        objc2_app_kit::NSPasteboard::generalPasteboard()
    }

    #[cfg(target_os = "macos")]
    pub(super) fn write_to(
        pasteboard: &objc2_app_kit::NSPasteboard,
        png: &[u8],
    ) -> Result<(), String> {
        use objc2_app_kit::NSPasteboardTypePNG;
        use objc2_foundation::NSData;
        pasteboard.clearContents();
        let data = NSData::with_bytes(png);
        // SAFETY: the type is AppKit's constant, valid for the life of the process
        let written = pasteboard.setData_forType(Some(&data), unsafe { NSPasteboardTypePNG });
        if written {
            Ok(())
        } else {
            Err("The image couldn't be put on the clipboard".into())
        }
    }

    /// WebView2's own clipboard writes `PNG` and a DIB for an image; the
    /// plugin's arboard writes the same pair.
    #[cfg(windows)]
    pub async fn write_png(app: &AppHandle, image: CardImage) -> Result<(), String> {
        use tauri_plugin_clipboard_manager::ClipboardExt;
        let rgba = super::rgba(&image)?;
        app.clipboard()
            .write_image(&tauri::image::Image::new_owned(
                rgba,
                image.width,
                image.height,
            ))
            .map_err(|e| e.to_string())
    }

    #[cfg(not(any(target_os = "macos", windows)))]
    pub async fn write_png(_app: &AppHandle, _image: CardImage) -> Result<(), String> {
        Err("card export is built for macOS and Windows only".into())
    }
}

/// The card's pixels as RGBA, for a clipboard that takes raw pixels.
#[cfg(any(windows, test))]
fn rgba(image: &CardImage) -> Result<Vec<u8>, String> {
    let decoder = png::Decoder::new(std::io::Cursor::new(&image.png));
    let mut reader = decoder.read_info().map_err(|e| e.to_string())?;
    let mut rgb = vec![
        0;
        reader
            .output_buffer_size()
            .ok_or("the image is too large")?
    ];
    reader.next_frame(&mut rgb).map_err(|e| e.to_string())?;
    Ok(rgb
        .chunks(3)
        .flat_map(|p| [p[0], p[1], p[2], 0xff])
        .collect())
}

// ---------------------------------------------------------------------------
// The commands' registration until T08's contract sits under this branch.
// T08's `commands/export.rs` bodies call the two functions above in their place.

#[tauri::command]
pub async fn t25_export_card_image(
    app: AppHandle,
    window: WebviewWindow,
    card: CardSpec,
) -> ExportCardResult {
    export_card_image(&app, Some(&window), &card).await
}

#[tauri::command]
pub async fn t25_copy_card_image(app: AppHandle, card: CardSpec) -> CopyCardResult {
    copy_card_image(&app, &card).await
}

/// A parity build's [`MatchLookup`], from the JSON file `BMT_PARITY_MATCH_FACTS`
/// names: `{"<gameId>": {"gameCreation": ms, "championId": id | null}}`.
#[cfg(feature = "parity-driver")]
pub fn parity_match_lookup() -> Option<MatchLookup> {
    let file = std::env::var_os("BMT_PARITY_MATCH_FACTS")?;
    let text = std::fs::read_to_string(&file)
        .map_err(|err| crate::assets::log_error(format!("BMT_PARITY_MATCH_FACTS: {err}")))
        .ok()?;
    let facts: std::collections::HashMap<String, MatchFacts> = serde_json::from_str(&text)
        .map_err(|err| crate::assets::log_error(format!("BMT_PARITY_MATCH_FACTS: {err}")))
        .ok()?;
    Some(MatchLookup(Arc::new(move |id| {
        facts.get(&id.to_string()).copied()
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot_png(width: u32, height: u32) -> Vec<u8> {
        // What WebKit hands back: RGBA with a profile, EXIF and a density
        let mut out = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut out, width, height);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            encoder.set_source_srgb(png::SrgbRenderingIntent::Perceptual);
            encoder.set_pixel_dims(Some(png::PixelDimensions {
                xppu: 5669,
                yppu: 5669,
                unit: png::Unit::Meter,
            }));
            let mut writer = encoder.write_header().unwrap();
            writer
                .write_chunk(png::chunk::eXIf, b"MM\0*\0\0\0\x08\0\0")
                .unwrap();
            let pixels: Vec<u8> = (0..width * height)
                .flat_map(|i| [(i % 251) as u8, (i / width) as u8, 0x24, 0xff])
                .collect();
            writer.write_image_data(&pixels).unwrap();
        }
        out
    }

    fn decoded(png: &[u8]) -> CardBitmap {
        snapshot::bitmap_from_png(png).unwrap()
    }

    fn chunk_types(png: &[u8]) -> Vec<String> {
        let mut types = Vec::new();
        let mut at = 8;
        while at + 8 <= png.len() {
            let len = u32::from_be_bytes(png[at..at + 4].try_into().unwrap()) as usize;
            types.push(String::from_utf8_lossy(&png[at + 4..at + 8]).into_owned());
            at += 12 + len;
        }
        types
    }

    #[test]
    fn the_png_has_no_ancillary_chunks() {
        let card = encode_card_png(&decoded(&snapshot_png(1800, 40)), 38).unwrap();
        assert!(
            chunk_types(&snapshot_png(1800, 40))
                .iter()
                .any(|t| t == "eXIf")
        );
        let types = chunk_types(&card.png);
        assert_eq!(types.first().map(String::as_str), Some("IHDR"));
        assert_eq!(types.last().map(String::as_str), Some("IEND"));
        assert!(
            types
                .iter()
                .all(|t| ["IHDR", "IDAT", "IEND"].contains(&t.as_str())),
            "only critical chunks, got {types:?}"
        );
        // Color type 2: 8-bit RGB, no alpha, as toPNG writes a card
        assert_eq!(card.png[24], 8);
        assert_eq!(card.png[25], 2);
    }

    #[test]
    fn the_crop_height_is_the_card_height_rounded_up_at_scale() {
        // Electron's 951 CSS px card is 1427 rows; WebKit floors 951.33 pt to 1426
        assert_eq!(device_height(951.0), 1427);
        assert_eq!(device_height(640.3), 961);
        assert_eq!(device_height(100.0), 150);
        let target = device_height(951.0);
        let card = encode_card_png(&decoded(&snapshot_png(1800, target + 1)), target).unwrap();
        assert_eq!((card.width, card.height), (1800, 1427));
        let decoded = rgba(&card).unwrap();
        assert_eq!(decoded.len(), 1800 * 1427 * 4);
        // The rows kept are the top ones, pixel for pixel
        assert_eq!(&decoded[..4], &[0, 0, 0x24, 0xff]);
        let last = 1426 * 1800 * 4;
        assert_eq!(decoded[last + 1], (1426u32 % 256) as u8);
    }

    #[test]
    fn a_short_snapshot_keeps_every_row_it_has() {
        let card = encode_card_png(&decoded(&snapshot_png(1800, 10)), 20).unwrap();
        assert_eq!(card.height, 10);
    }

    #[test]
    fn routes_match_card_route() {
        assert_eq!(
            card_route(&CardSpec::Game {
                game_id: 5684865505
            }),
            "/card/5684865505"
        );
        let season = |queue, account: Option<&str>, hide| CardSpec::Season {
            season_id: "set-1".into(),
            queue,
            account: account.map(Into::into),
            hide_friends: hide,
        };
        assert_eq!(card_route(&season(None, None, None)), "/season-card/set-1");
        assert_eq!(
            card_route(&season(
                Some(2400),
                Some("fa4e0000-0000-4000-8000-000000000dea"),
                Some(true)
            )),
            "/season-card/set-1?queue=2400&account=fa4e0000-0000-4000-8000-000000000dea&hideFriends=1"
        );
        assert_eq!(
            card_route(&season(None, Some(""), Some(false))),
            "/season-card/set-1"
        );
        // encodeURIComponent and URLSearchParams escape differently
        let odd = CardSpec::Season {
            season_id: "a b/c'(x)".into(),
            queue: None,
            account: Some("x y&z=~é".into()),
            hide_friends: None,
        };
        assert_eq!(
            card_route(&odd),
            "/season-card/a%20b%2Fc'(x)?account=x+y%26z%3D%7E%C3%A9"
        );
    }

    #[test]
    fn card_spec_reads_the_renderer_shape() {
        let game: CardSpec = serde_json::from_str(r#"{"kind":"game","gameId":7}"#).unwrap();
        assert_eq!(game, CardSpec::Game { game_id: 7 });
        let season: CardSpec = serde_json::from_str(
            r#"{"kind":"season","seasonId":"set-1","queue":2400,"hideFriends":true}"#,
        )
        .unwrap();
        assert_eq!(
            card_route(&season),
            "/season-card/set-1?queue=2400&hideFriends=1"
        );
        // A dismissed dialog answers with no error key at all
        let none = serde_json::to_string(&ExportCardResult {
            success: false,
            path: None,
            error: None,
        })
        .unwrap();
        assert_eq!(none, r#"{"success":false}"#);
    }

    fn new_york() -> TimeZone {
        TimeZone::get("America/New_York").unwrap()
    }

    // 2026-11-22T21:00:00-05:00, the parity clock the T05 goldens ran on
    const FIXED: i64 = 1_795_399_200_000;

    #[test]
    fn file_names_match_the_goldens() {
        // export.card-image/game.json and season.json, recorded from Electron 1.2.1
        let game = CardSpec::Game {
            game_id: 5684865505,
        };
        let facts = MatchFacts {
            game_creation: FIXED - 3_600_000,
            champion_id: Some(79),
        };
        assert_eq!(
            default_file_name(&game, FIXED, &new_york(), Some((facts, Some("Gragas")))),
            "better-mayhem-Gragas-2026-11-22-5684865505.png"
        );
        let season = CardSpec::Season {
            season_id: "set-1".into(),
            queue: Some(2400),
            account: None,
            hide_friends: Some(true),
        };
        assert_eq!(
            default_file_name(&season, FIXED, &new_york(), None),
            "better-mayhem-set-1-recap-2026-11-22.png"
        );
        assert_eq!(dialog_title(&game), "Export Game Image");
        assert_eq!(dialog_title(&season), "Export Season Recap");
    }

    #[test]
    fn file_names_cover_every_branch_of_default_file_name() {
        let zone = new_york();
        let game = CardSpec::Game { game_id: 42 };
        assert_eq!(
            default_file_name(&game, FIXED, &zone, None),
            "better-mayhem-game-42.png"
        );
        let facts = MatchFacts {
            game_creation: FIXED,
            champion_id: None,
        };
        assert_eq!(
            default_file_name(&game, FIXED, &zone, Some((facts, None))),
            "better-mayhem-2026-11-22-42.png"
        );
        assert_eq!(
            default_file_name(&game, FIXED, &zone, Some((facts, Some("Nunu & Willump")))),
            "better-mayhem-Nunu-Willump-2026-11-22-42.png"
        );
        assert_eq!(
            default_file_name(&game, FIXED, &zone, Some((facts, Some("Kai'Sa")))),
            "better-mayhem-Kai-Sa-2026-11-22-42.png"
        );
        let season = |id: &str| CardSpec::Season {
            season_id: id.into(),
            queue: None,
            account: None,
            hide_friends: None,
        };
        assert_eq!(
            default_file_name(&season("all"), FIXED, &zone, None),
            "better-mayhem-all-time-recap-2026-11-22.png"
        );
        assert_eq!(
            default_file_name(&season("Mystery Set!"), FIXED, &zone, None),
            "better-mayhem-mystery-set-recap-2026-11-22.png"
        );
        // Dated in the local zone: 02:00 UTC on the 23rd is still the 22nd in New York
        assert_eq!(
            default_file_name(&season("set-3"), FIXED, &zone, None),
            "better-mayhem-set-3-recap-2026-11-22.png"
        );
        assert_eq!(
            default_file_name(&season("set-3"), FIXED, &TimeZone::UTC, None),
            "better-mayhem-set-3-recap-2026-11-23.png"
        );
    }

    #[test]
    fn slug_matches_the_renderer_regex() {
        assert_eq!(slug("Nunu & Willump"), "Nunu-Willump");
        assert_eq!(slug("  Dr. Mundo  "), "Dr-Mundo");
        assert_eq!(slug("--"), "");
        assert_eq!(slug("Renata Glasc"), "Renata-Glasc");
        assert_eq!(slug("Wukong"), "Wukong");
    }

    #[test]
    fn save_options_match_electrons_dialog_call() {
        let options = save_options(
            &CardSpec::Game { game_id: 1 },
            "better-mayhem-game-1.png".into(),
        );
        assert_eq!(
            serde_json::to_value(&options).unwrap(),
            serde_json::json!({
                "title": "Export Game Image",
                "defaultPath": "better-mayhem-game-1.png",
                "filters": [{ "name": "PNG Image", "extensions": ["png"] }],
            })
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_clipboard_holds_the_png_bytes_as_public_png() {
        use objc2_app_kit::{NSPasteboard, NSPasteboardTypePNG};
        use objc2_foundation::NSString;
        // A private pasteboard, so the test never touches the player's clipboard
        let name = NSString::from_str(&format!("bmt-t25-test-{}", std::process::id()));
        let pasteboard = NSPasteboard::pasteboardWithName(&name);
        let card = encode_card_png(&decoded(&snapshot_png(1800, 4)), 3).unwrap();
        clipboard::write_to(&pasteboard, &card.png).unwrap();
        // The item's own types: `types` on the pasteboard adds the ones AppKit
        // would convert to on request, as it does for Electron's copy too
        let types: Vec<Vec<String>> = pasteboard
            .pasteboardItems()
            .map(|items| {
                items
                    .iter()
                    .map(|item| item.types().iter().map(|t| t.to_string()).collect())
                    .collect()
            })
            .unwrap_or_default();
        let data = pasteboard.dataForType(unsafe { NSPasteboardTypePNG });
        // SAFETY: a plain message to a live pasteboard, taking and returning nothing
        let _: () = unsafe { objc2::msg_send![&pasteboard, releaseGlobally] };
        assert_eq!(types, [["public.png"]]);
        assert_eq!(data.map(|d| d.to_vec()), Some(card.png));
    }
}
