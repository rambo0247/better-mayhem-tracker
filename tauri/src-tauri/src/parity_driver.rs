//! The in-process driver the parity tools (`parity/run-tauri.ts`) use to put the
//! app in a state and photograph it. No outside process may read or click this
//! window on the operator's Mac, which grants neither Screen Recording nor
//! Accessibility, so the app does it from inside.
//!
//! It listens on 127.0.0.1 and answers only requests that carry the token from
//! `BMT_PARITY_TOKEN`. It offers primitives (eval, native mouse and keys,
//! resize, navigate, snapshot). What a state, a selector, or "settled" means
//! stays in `parity/`, shared with the Electron side.

// build.rs sets bmt_release_profile from the profile itself, because a release
// profile can turn debug_assertions back on
#[cfg(any(not(debug_assertions), bmt_release_profile))]
compile_error!("the parity-driver feature is for debug builds only");

use std::borrow::Cow;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Component, Path, PathBuf};
use std::sync::mpsc;
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::Duration;

use serde_json::{Value, json};
use tauri::webview::PageLoadEvent;
use tauri::{
    Builder, DynRuntime, LogicalPosition, LogicalSize, Manager, Url, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

use crate::snapshot::{self, SnapshotOptions};

/// Compiled in only with the driver. The release check in `tauri-ci.yml`
/// searches the binary for it, and its positive control must find it.
pub const SENTINEL: &str = "bmt-parity-driver-v1";

const TOKEN_ENV: &str = "BMT_PARITY_TOKEN";
const RENDERER_DIR_ENV: &str = "BMT_PARITY_RENDERER_DIR";
const ASSET_DIR_ENV: &str = "BMT_PARITY_ASSETS";
const INIT_SCRIPT_ENV: &str = "BMT_PARITY_INIT";
const BROWSER_ARGS_ENV: &str = "BMT_PARITY_BROWSER_ARGS";
const WEBVIEW_DATA_ENV: &str = "BMT_PARITY_WEBVIEW_DATA";
/// Set to `regular` to keep the Dock icon, only to show captures match with and without it.
#[cfg(target_os = "macos")]
const ACTIVATION_ENV: &str = "BMT_PARITY_ACTIVATION";
/// Set to `1` to open a screen-sized window of the app's own over everything else
/// at the normal level, only to show captures match with the driver window covered.
const COVER_ENV: &str = "BMT_PARITY_COVER";
const MIN_TOKEN_LEN: usize = 16;
const MAX_HEAD_BYTES: usize = 64 * 1024;
const MAX_BODY_BYTES: usize = 16 * 1024 * 1024;
const WINDOW_POSITION: (f64, f64) = (40.0, 40.0);

struct Config {
    token: String,
    /// A built renderer to load in place of the app's own pages, such as
    /// Electron's `out/renderer`.
    renderer_dir: Option<PathBuf>,
    /// An asset cache in Electron's layout, served under `asset:`.
    asset_dir: Option<PathBuf>,
    /// Runs before any page script on every load: the clock, the data, the API.
    init_script: Option<String>,
    browser_args: Option<String>,
    webview_data: Option<PathBuf>,
    #[cfg(target_os = "macos")]
    keep_dock_icon: bool,
}

impl Config {
    fn from_env() -> Result<Self, String> {
        let path = |name: &str| std::env::var_os(name).map(PathBuf::from);
        let init_script = match path(INIT_SCRIPT_ENV) {
            Some(file) => Some(
                std::fs::read_to_string(&file)
                    .map_err(|e| format!("{INIT_SCRIPT_ENV} {}: {e}", file.display()))?,
            ),
            None => None,
        };
        Ok(Self {
            token: token_from(std::env::var(TOKEN_ENV).ok())?,
            renderer_dir: path(RENDERER_DIR_ENV),
            asset_dir: path(ASSET_DIR_ENV),
            init_script,
            browser_args: std::env::var(BROWSER_ARGS_ENV).ok(),
            webview_data: path(WEBVIEW_DATA_ENV),
            #[cfg(target_os = "macos")]
            keep_dock_icon: std::env::var(ACTIVATION_ENV).is_ok_and(|v| v == "regular"),
        })
    }
}

static CONFIG: OnceLock<Config> = OnceLock::new();

fn config() -> &'static Config {
    CONFIG.get().expect("parity_driver::install runs first")
}

fn token_from(value: Option<String>) -> Result<String, String> {
    let token = value.unwrap_or_default().trim().to_string();
    if token.len() < MIN_TOKEN_LEN {
        return Err(format!(
            "{TOKEN_ENV} must hold at least {MIN_TOKEN_LEN} characters; the driver does not start without it"
        ));
    }
    Ok(token)
}

#[derive(Debug, PartialEq, Eq)]
enum Refusal {
    NotLoopback,
    MissingToken,
    WrongToken,
}

impl Refusal {
    fn status(&self) -> u16 {
        match self {
            Refusal::NotLoopback => 403,
            Refusal::MissingToken | Refusal::WrongToken => 401,
        }
    }
}

fn authorize(peer: SocketAddr, headers: &[(String, String)], token: &str) -> Result<(), Refusal> {
    if !peer.ip().is_loopback() {
        return Err(Refusal::NotLoopback);
    }
    let value = headers
        .iter()
        .find(|(name, _)| name == "authorization")
        .map(|(_, value)| value.as_str())
        .ok_or(Refusal::MissingToken)?;
    let given = value.strip_prefix("Bearer ").ok_or(Refusal::WrongToken)?;
    if constant_time_eq(given.as_bytes(), token.as_bytes()) {
        Ok(())
    } else {
        Err(Refusal::WrongToken)
    }
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Reads the environment, registers the renderer and asset schemes, and keeps
/// the app from activating itself on launch. Exits when the token is missing.
pub fn install(builder: Builder<DynRuntime>) -> Builder<DynRuntime> {
    let config = Config::from_env().unwrap_or_else(|error| {
        eprintln!("{SENTINEL} refused to start: {error}");
        std::process::exit(2);
    });
    let _ = CONFIG.set(config);
    let builder = builder
        .register_uri_scheme_protocol("parity", |_ctx, request| serve_renderer(request.uri()))
        .register_uri_scheme_protocol("asset", |_ctx, request| serve_asset(request.uri()));
    #[cfg(target_os = "macos")]
    let builder = builder.activate_ignoring_other_apps(false);
    builder
}

/// Runs in setup, before the window exists. A parity launch never shows in the
/// operator's Dock and never takes focus, so it is an accessory app on macOS.
pub fn prepare(app: &mut tauri::App<DynRuntime>) {
    // build.rs sets it, so WebKit's storage under ~/Library never lands in the real app's folders
    assert_eq!(
        app.config().identifier,
        "com.better-mayhem-tracker.parity",
        "a parity-driver build must carry the parity bundle identifier",
    );
    let home = match window_url() {
        Some(WebviewUrl::CustomProtocol(url)) => vec![url],
        _ => app_origins(app.config().build.dev_url.clone()),
    };
    let _ = HOME.set(home);
    #[cfg(target_os = "macos")]
    if !config().keep_dock_icon {
        app.set_activation_policy(tauri::ActivationPolicy::Accessory);
    }
}

/// Where the app's own pages load from: Tauri's scheme in both engines' forms,
/// and the dev server in a dev build.
fn app_origins(dev_url: Option<Url>) -> Vec<Url> {
    let mut origins: Vec<Url> = ["tauri://localhost/", "http://tauri.localhost/"]
        .iter()
        .map(|url| Url::parse(url).expect("a valid URL"))
        .collect();
    if tauri::is_dev() {
        origins.extend(dev_url);
    }
    origins
}

/// The origins the window opened at, set before the window exists.
static HOME: OnceLock<Vec<Url>> = OnceLock::new();

/// The page may only move within the origin it opened at, hash changes
/// included. Every other scheme and host is refused, `file:` and `https:` too.
fn may_navigate(url: &Url, home: &[Url]) -> bool {
    // Url::origin is opaque, so never equal, for custom schemes like parity:
    let origin = |u: &Url| {
        (
            u.scheme().to_string(),
            u.host_str().map(str::to_string),
            u.port_or_known_default(),
        )
    };
    url.as_str() == "about:blank" || home.iter().any(|h| origin(h) == origin(url))
}

/// The renderer to load, when one was given in place of the app's own pages.
pub fn window_url() -> Option<WebviewUrl> {
    config().renderer_dir.as_ref()?;
    let url = if cfg!(windows) {
        "http://parity.localhost/index.html"
    } else {
        "parity://localhost/index.html"
    };
    Some(WebviewUrl::CustomProtocol(
        Url::parse(url).expect("a valid URL"),
    ))
}

pub fn configure<'a, M: Manager<DynRuntime>>(
    builder: WebviewWindowBuilder<'a, DynRuntime, M>,
) -> WebviewWindowBuilder<'a, DynRuntime, M> {
    let config = config();
    let (x, y) = WINDOW_POSITION;
    // A private store keeps runs apart and keeps WebKit from writing a store
    // under the real bundle identifier
    let mut builder = builder
        .incognito(true)
        .focused(false)
        .position(x, y)
        // An accessory app's window opens behind the active app's, and WebKit stops
        // painting a covered window. Above other windows, never focused, it stays painted.
        .always_on_top(true)
        .on_navigation(|url| {
            let allowed = may_navigate(url, HOME.get().map_or(&[], Vec::as_slice));
            if !allowed {
                eprintln!("{SENTINEL} refused a navigation to {url}");
            }
            allowed
        })
        .on_page_load(|_window, payload| {
            if payload.event() == PageLoadEvent::Finished {
                let (count, changed) = &LOADS;
                *count.lock().expect("load counter") += 1;
                changed.notify_all();
            }
        });
    if let Some(script) = &config.init_script {
        builder = builder.initialization_script(script.clone());
    }
    if let Some(args) = &config.browser_args {
        builder = builder.additional_browser_args(args);
    }
    if let Some(dir) = &config.webview_data {
        builder = builder.data_directory(dir.clone());
    }
    builder
}

static LOADS: (Mutex<u64>, Condvar) = (Mutex::new(0), Condvar::new());

fn wait_for_load_after(before: u64, timeout: Duration) -> Result<(), String> {
    let (count, changed) = &LOADS;
    let guard = count.lock().map_err(|e| e.to_string())?;
    let (_loads, waited) = changed
        .wait_timeout_while(guard, timeout, |loads| *loads <= before)
        .map_err(|e| e.to_string())?;
    if waited.timed_out() {
        return Err(format!("no page load within {} ms", timeout.as_millis()));
    }
    Ok(())
}

fn loads_so_far() -> u64 {
    *LOADS.0.lock().expect("load counter")
}

/// Binds the listener and prints the line `run-tauri.ts` waits for.
pub fn start(window: &WebviewWindow) -> std::io::Result<()> {
    #[cfg(target_os = "macos")]
    mac::hold_off_app_nap();
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    let port = listener.local_addr()?.port();
    println!("{SENTINEL} listening 127.0.0.1:{port}");
    if std::env::var(COVER_ENV).is_ok_and(|v| v == "1") {
        cover_the_screen(window)?;
    }
    let window = window.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let window = window.clone();
            std::thread::spawn(move || handle(stream, &window));
        }
    });
    Ok(())
}

fn cover_the_screen(window: &WebviewWindow) -> std::io::Result<()> {
    let to_io = |e: tauri::Error| std::io::Error::other(e.to_string());
    let monitor = window.primary_monitor().map_err(to_io)?;
    let (width, height) = monitor.map_or((2560.0, 1440.0), |m| {
        let size = m.size().to_logical::<f64>(m.scale_factor());
        (size.width, size.height)
    });
    WebviewWindowBuilder::new(window.app_handle(), "cover", WebviewUrl::default())
        .title("parity cover")
        .position(0.0, 0.0)
        .inner_size(width, height)
        .focused(false)
        .background_color(tauri::window::Color(128, 128, 128, 255))
        .build()
        .map_err(to_io)?;
    Ok(())
}

struct Request {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

struct Response {
    status: u16,
    content_type: &'static str,
    headers: Vec<(&'static str, String)>,
    body: Vec<u8>,
}

impl Response {
    fn json(status: u16, value: &Value) -> Self {
        Self {
            status,
            content_type: "application/json",
            headers: Vec::new(),
            body: value.to_string().into_bytes(),
        }
    }

    fn error(status: u16, message: impl Into<String>) -> Self {
        Self::json(status, &json!({ "error": message.into() }))
    }
}

fn handle(mut stream: TcpStream, window: &WebviewWindow) {
    let response = match stream.peer_addr() {
        Ok(peer) => match stream
            .set_read_timeout(Some(Duration::from_secs(10)))
            .map_err(|e| e.to_string())
            .and_then(|()| read_request(&mut stream))
        {
            Ok(request) => respond(peer, &request, window),
            Err(error) => Response::error(400, error),
        },
        Err(error) => Response::error(400, error.to_string()),
    };
    let quitting =
        response.status == 200 && response.headers.iter().any(|(n, _)| *n == "x-bmt-quit");
    let _ = write_response(&mut stream, &response);
    drop(stream);
    if quitting {
        window.app_handle().exit(0);
    }
}

fn respond(peer: SocketAddr, request: &Request, window: &WebviewWindow) -> Response {
    if let Err(refusal) = authorize(peer, &request.headers, &config().token) {
        eprintln!("{SENTINEL} refused {peer}: {refusal:?}");
        return Response::error(refusal.status(), format!("refused: {refusal:?}"));
    }
    if request.method != "POST" || request.path != "/" {
        return Response::error(404, "POST / with a JSON body");
    }
    let body: Value = match serde_json::from_slice(&request.body) {
        Ok(body) => body,
        Err(error) => return Response::error(400, error.to_string()),
    };
    match dispatch(window, &body) {
        Ok(response) => response,
        Err(error) => Response::error(500, error),
    }
}

fn read_request(stream: impl Read) -> Result<Request, String> {
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    let mut head = 0;
    let mut next_line = |reader: &mut BufReader<_>, line: &mut String| {
        line.clear();
        let read = reader.read_line(line).map_err(|e| e.to_string())?;
        head += read;
        if read == 0 || head > MAX_HEAD_BYTES {
            return Err("bad request head".to_string());
        }
        Ok(line.trim_end().to_string())
    };
    let request_line = next_line(&mut reader, &mut line)?;
    let mut parts = request_line.split(' ');
    let method = parts.next().unwrap_or_default().to_string();
    let path = parts.next().unwrap_or_default().to_string();
    let mut headers = Vec::new();
    loop {
        let header = next_line(&mut reader, &mut line)?;
        if header.is_empty() {
            break;
        }
        if let Some((name, value)) = header.split_once(':') {
            headers.push((name.trim().to_ascii_lowercase(), value.trim().to_string()));
        }
    }
    let length: usize = headers
        .iter()
        .find(|(name, _)| name == "content-length")
        .map_or(Ok(0), |(_, value)| value.parse())
        .map_err(|_| "bad content-length".to_string())?;
    if length > MAX_BODY_BYTES {
        return Err("body too large".into());
    }
    let mut body = vec![0; length];
    reader.read_exact(&mut body).map_err(|e| e.to_string())?;
    Ok(Request {
        method,
        path,
        headers,
        body,
    })
}

fn write_response(stream: &mut TcpStream, response: &Response) -> std::io::Result<()> {
    let mut head = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n",
        response.status,
        if response.status == 200 {
            "OK"
        } else {
            "Error"
        },
        response.content_type,
        response.body.len()
    );
    for (name, value) in &response.headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str("\r\n");
    stream.write_all(head.as_bytes())?;
    stream.write_all(&response.body)?;
    stream.flush()
}

/// Waits for a result that the main thread delivers later.
fn wait<T>(
    rx: mpsc::Receiver<Result<T, String>>,
    timeout: Duration,
    what: &str,
) -> Result<T, String> {
    rx.recv_timeout(timeout)
        .map_err(|_| format!("{what} gave no answer within {} ms", timeout.as_millis()))?
}

fn number(body: &Value, key: &str) -> Result<f64, String> {
    body[key]
        .as_f64()
        .ok_or_else(|| format!("`{key}` must be a number"))
}

fn text<'a>(body: &'a Value, key: &str) -> Result<&'a str, String> {
    body[key]
        .as_str()
        .ok_or_else(|| format!("`{key}` must be a string"))
}

fn timeout_of(body: &Value, default_ms: u64) -> Duration {
    Duration::from_millis(body["timeoutMs"].as_u64().unwrap_or(default_ms))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MouseKind {
    Move,
    Down,
    Up,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum KeyKind {
    Down,
    Up,
}

/// A key by the name Playwright's `keyboard.press` takes, with what each
/// engine needs to synthesize it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Key {
    name: &'static str,
    code: &'static str,
    mac_key_code: u16,
    windows_key_code: u32,
    text: &'static str,
}

const fn key(
    name: &'static str,
    code: &'static str,
    mac_key_code: u16,
    windows_key_code: u32,
    text: &'static str,
) -> Key {
    Key {
        name,
        code,
        mac_key_code,
        windows_key_code,
        text,
    }
}

// macOS key codes from Carbon's Events.h, Windows virtual-key codes from WinUser.h
const NAMED_KEYS: &[Key] = &[
    key("Enter", "Enter", 36, 0x0d, "\r"),
    key("Tab", "Tab", 48, 0x09, "\t"),
    key("Escape", "Escape", 53, 0x1b, ""),
    key("Backspace", "Backspace", 51, 0x08, ""),
    key("Delete", "Delete", 117, 0x2e, ""),
    key(" ", "Space", 49, 0x20, " "),
    key("Space", "Space", 49, 0x20, " "),
    key("ArrowLeft", "ArrowLeft", 123, 0x25, ""),
    key("ArrowUp", "ArrowUp", 126, 0x26, ""),
    key("ArrowRight", "ArrowRight", 124, 0x27, ""),
    key("ArrowDown", "ArrowDown", 125, 0x28, ""),
    key("Home", "Home", 115, 0x24, ""),
    key("End", "End", 119, 0x23, ""),
    key("PageUp", "PageUp", 116, 0x21, ""),
    key("PageDown", "PageDown", 121, 0x22, ""),
];

const LETTER_KEY_CODES: [u16; 26] = [
    0, 11, 8, 2, 14, 3, 5, 4, 34, 38, 40, 37, 46, 45, 31, 35, 12, 15, 1, 17, 32, 9, 13, 7, 16, 6,
];
const DIGIT_KEY_CODES: [u16; 10] = [29, 18, 19, 20, 21, 23, 22, 26, 28, 25];
const LETTERS: &str = "abcdefghijklmnopqrstuvwxyz";
const DIGITS: &str = "0123456789";
const LETTER_CODES: [&str; 26] = [
    "KeyA", "KeyB", "KeyC", "KeyD", "KeyE", "KeyF", "KeyG", "KeyH", "KeyI", "KeyJ", "KeyK", "KeyL",
    "KeyM", "KeyN", "KeyO", "KeyP", "KeyQ", "KeyR", "KeyS", "KeyT", "KeyU", "KeyV", "KeyW", "KeyX",
    "KeyY", "KeyZ",
];
const DIGIT_CODES: [&str; 10] = [
    "Digit0", "Digit1", "Digit2", "Digit3", "Digit4", "Digit5", "Digit6", "Digit7", "Digit8",
    "Digit9",
];

fn find_key(name: &str) -> Result<Key, String> {
    if let Some(found) = NAMED_KEYS.iter().find(|k| k.name == name) {
        return Ok(*found);
    }
    let single = |set: &'static str, codes: &[&'static str], mac: &[u16], windows_base: u32| {
        let index = set.find(name)?;
        let text = &set[index..=index];
        Some(key(
            text,
            codes[index],
            mac[index],
            windows_base + index as u32,
            text,
        ))
    };
    if name.len() == 1 {
        if let Some(found) = single(LETTERS, &LETTER_CODES, &LETTER_KEY_CODES, 0x41) {
            return Ok(found);
        }
        if let Some(found) = single(DIGITS, &DIGIT_CODES, &DIGIT_KEY_CODES, 0x30) {
            return Ok(found);
        }
    }
    Err(format!("no key named {name:?}"))
}

/// Wraps an expression so both engines await it and return it as JSON text.
fn json_returning_body(expression: &str) -> String {
    format!(
        "const __bmtValue = await (\n{expression}\n);\nreturn JSON.stringify(__bmtValue) ?? \"null\";"
    )
}

fn dispatch(window: &WebviewWindow, body: &Value) -> Result<Response, String> {
    let op = text(body, "op")?;
    match op {
        "eval" => {
            let timeout = timeout_of(body, 30_000);
            let json_text = platform::eval(window, text(body, "expression")?, timeout)?;
            Ok(Response {
                status: 200,
                content_type: "application/json",
                headers: Vec::new(),
                body: json_text.into_bytes(),
            })
        }
        "mouse" => {
            let kind = match text(body, "kind")? {
                "move" => MouseKind::Move,
                "down" => MouseKind::Down,
                "up" => MouseKind::Up,
                other => return Err(format!("no mouse event {other:?}")),
            };
            let (x, y) = (number(body, "x")?, number(body, "y")?);
            let path = platform::mouse(window, kind, x, y)?;
            Ok(Response::json(200, &json!({ "path": path })))
        }
        "wheel" => {
            let (x, y) = (number(body, "x")?, number(body, "y")?);
            let (dx, dy) = (body["dx"].as_f64().unwrap_or(0.0), number(body, "dy")?);
            let path = platform::wheel(window, x, y, dx, dy)?;
            Ok(Response::json(200, &json!({ "path": path })))
        }
        "key" => {
            let kind = match text(body, "kind")? {
                "down" => KeyKind::Down,
                "up" => KeyKind::Up,
                other => return Err(format!("no key event {other:?}")),
            };
            let key = find_key(text(body, "key")?)?;
            let path = platform::key(window, kind, key)?;
            Ok(Response::json(200, &json!({ "path": path })))
        }
        "resize" => {
            let (width, height) = (number(body, "width")?, number(body, "height")?);
            platform::set_page_height(window, None)?;
            let (x, y) = WINDOW_POSITION;
            window
                .set_position(LogicalPosition::new(x, y))
                .map_err(|e| e.to_string())?;
            window
                .set_size(LogicalSize::new(width, height))
                .map_err(|e| e.to_string())?;
            Ok(Response::json(
                200,
                &json!({ "width": width, "height": height }),
            ))
        }
        "viewport" => {
            let (width, height) = (number(body, "width")?, number(body, "height")?);
            let scale = body["scale"].as_f64().unwrap_or(2.0);
            let emulated = platform::emulate_viewport(window, width, height, scale)?;
            Ok(Response::json(200, &json!({ "emulated": emulated })))
        }
        "page-height" => {
            let (width, height) = platform::set_page_height(window, body["height"].as_f64())?;
            Ok(Response::json(200, &json!({ "frame": [width, height] })))
        }
        "navigate" | "reload" => {
            let before = loads_so_far();
            if op == "reload" {
                window.reload().map_err(|e| e.to_string())?;
            } else {
                let url = Url::parse(text(body, "url")?).map_err(|e| e.to_string())?;
                if !may_navigate(&url, HOME.get().map_or(&[], Vec::as_slice)) {
                    return Err(format!("refused: {url} is outside the page's origin"));
                }
                window.navigate(url).map_err(|e| e.to_string())?;
            }
            wait_for_load_after(before, timeout_of(body, 20_000))?;
            Ok(Response::json(200, &json!({ "loads": loads_so_far() })))
        }
        "snapshot" => {
            let scale = body["scale"].as_f64().unwrap_or(2.0);
            let size = match (body["width"].as_f64(), body["height"].as_f64()) {
                (Some(width), Some(height)) => Some((width, height)),
                _ => None,
            };
            let (tx, rx) = mpsc::channel();
            snapshot::snapshot(window, SnapshotOptions { scale, size }, move |result| {
                let _ = tx.send(result);
            })
            .map_err(|e| e.to_string())?;
            let shot = wait(rx, timeout_of(body, 20_000), "the snapshot")?;
            let meta = json!({
                "width": shot.width,
                "height": shot.height,
                "sourceColorSpace": shot.source_color_space,
                "backingScale": shot.backing_scale,
            });
            Ok(Response {
                status: 200,
                content_type: "image/png",
                headers: vec![("x-bmt-snapshot", meta.to_string())],
                body: shot.png,
            })
        }
        "info" => {
            let scale = window.scale_factor().map_err(|e| e.to_string())?;
            let inner = window
                .inner_size()
                .map_err(|e| e.to_string())?
                .to_logical::<f64>(scale);
            let outer = window
                .outer_position()
                .map_err(|e| e.to_string())?
                .to_logical::<f64>(scale);
            Ok(Response::json(
                200,
                &json!({
                    "sentinel": SENTINEL,
                    "platform": std::env::consts::OS,
                    "scaleFactor": scale,
                    "inner": [inner.width, inner.height],
                    "position": [outer.x, outer.y],
                    "focused": window.is_focused().map_err(|e| e.to_string())?,
                    "visible": window.is_visible().map_err(|e| e.to_string())?,
                    "occluded": platform::occluded(window)?,
                    "topInset": platform::top_inset_of(window)?,
                    "loads": loads_so_far(),
                }),
            ))
        }
        "quit" => Ok(Response {
            status: 200,
            content_type: "application/json",
            headers: vec![("x-bmt-quit", "1".into())],
            body: b"{}".to_vec(),
        }),
        other => Err(format!("no primitive {other:?}")),
    }
}

fn http_response(
    status: u16,
    content_type: &str,
    body: Vec<u8>,
) -> tauri::http::Response<Cow<'static, [u8]>> {
    tauri::http::Response::builder()
        .status(status)
        .header("Content-Type", content_type)
        .header("Cache-Control", "no-store")
        .body(Cow::Owned(body))
        .expect("a valid response")
}

fn not_found() -> tauri::http::Response<Cow<'static, [u8]>> {
    http_response(404, "text/plain", Vec::new())
}

/// The URL's path, plus its host on schemes WebKit addresses as
/// `scheme://host/path`, so both engines' URLs read the same.
fn scheme_path(uri: &tauri::http::Uri) -> String {
    let path = uri.path().trim_start_matches('/');
    match uri.host() {
        Some(host) if !host.ends_with("localhost") => format!("{host}/{path}"),
        _ => path.to_string(),
    }
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let escaped = (bytes[i] == b'%')
            .then(|| text.get(i + 1..i + 3))
            .flatten()
            .and_then(|hex| u8::from_str_radix(hex, 16).ok());
        if let Some(value) = escaped {
            out.push(value);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// A file under `root`, or `None` for anything that could leave it: `..`, a
/// drive or UNC prefix, a root, a backslash, or a link that resolves outside.
fn safe_join(root: &Path, relative: &str) -> Option<PathBuf> {
    let mut path = root.to_path_buf();
    for segment in relative.split('/').filter(|s| !s.is_empty()) {
        // On macOS "C:" is an ordinary name, so ':' is refused on every platform
        if segment.contains(['\\', ':']) {
            return None;
        }
        let mut components = Path::new(segment).components();
        match (components.next(), components.next()) {
            (Some(Component::Normal(name)), None) => path.push(name),
            _ => return None,
        }
    }
    let inside = path.canonicalize().ok()?;
    inside
        .starts_with(root.canonicalize().ok()?)
        .then_some(inside)
}

fn content_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
    {
        "html" => "text/html",
        "js" | "mjs" => "text/javascript",
        "css" => "text/css",
        "json" => "application/json",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "svg" => "image/svg+xml",
        "webp" => "image/webp",
        _ => "application/octet-stream",
    }
}

fn serve_renderer(uri: &tauri::http::Uri) -> tauri::http::Response<Cow<'static, [u8]>> {
    let Some(root) = &config().renderer_dir else {
        return not_found();
    };
    let relative = percent_decode(&scheme_path(uri));
    let relative = if relative.is_empty() {
        "index.html".to_string()
    } else {
        relative
    };
    let Some(file) = safe_join(root, &relative) else {
        return not_found();
    };
    match std::fs::read(&file) {
        Ok(bytes) => http_response(200, content_type(&file), rewrite_for_engine(&file, bytes)),
        Err(_) => not_found(),
    }
}

/// WebView2 routes custom schemes only as `http://<scheme>.localhost`, so on
/// Windows the renderer's `asset://` URLs and its CSP have to say so.
fn rewrite_for_engine(file: &Path, bytes: Vec<u8>) -> Vec<u8> {
    if !cfg!(windows) {
        return bytes;
    }
    let ext = file
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default();
    match (ext, String::from_utf8(bytes)) {
        ("js", Ok(source)) => source
            .replace("${ASSET_SCHEME}://", "http://asset.localhost/")
            .into_bytes(),
        ("html", Ok(source)) => source
            .replace("img-src ", "img-src http://asset.localhost ")
            .into_bytes(),
        (_, Ok(source)) => source.into_bytes(),
        (_, Err(error)) => error.into_bytes(),
    }
}

fn is_patch(name: &str) -> bool {
    let mut parts = name.split('.');
    matches!(
        (parts.next(), parts.next(), parts.next()),
        (Some(a), Some(b), None) if !a.is_empty() && !b.is_empty()
            && a.bytes().all(|c| c.is_ascii_digit()) && b.bytes().all(|c| c.is_ascii_digit())
    )
}

fn patch_order(name: &str) -> (u32, u32) {
    let mut parts = name.split('.').map(|p| p.parse().unwrap_or(0));
    (parts.next().unwrap_or(0), parts.next().unwrap_or(0))
}

/// Where Electron's asset cache files a game path: the patch, then the sha1
/// of the path. With the network blocked, Electron reads the asked patch
/// first, then every cached patch newest first (`src/main/game-assets.ts`).
fn asset_candidates(root: &Path, branch: &str, game_path: &str) -> Vec<PathBuf> {
    let extension = Path::new(game_path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| format!(".{e}"))
        .unwrap_or_default();
    let name = format!("{}{extension}", sha1_smol::Sha1::from(game_path).digest());
    let mut patches: Vec<String> = std::fs::read_dir(root)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| is_patch(name))
        .collect();
    patches.sort_by_key(|name| std::cmp::Reverse(patch_order(name)));
    if is_patch(branch) {
        patches.retain(|p| p != branch);
        patches.insert(0, branch.to_string());
    }
    patches
        .iter()
        .map(|patch| root.join(patch).join(&name))
        .collect()
}

fn image_type(bytes: &[u8]) -> &'static str {
    if bytes.starts_with(b"\x89PNG") {
        "image/png"
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        "image/jpeg"
    } else if bytes.len() > 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        "image/webp"
    } else {
        "application/octet-stream"
    }
}

fn serve_asset(uri: &tauri::http::Uri) -> tauri::http::Response<Cow<'static, [u8]>> {
    let Some(root) = &config().asset_dir else {
        return not_found();
    };
    let segments: Vec<String> = scheme_path(uri)
        .split('/')
        .filter(|s| !s.is_empty())
        .map(percent_decode)
        .collect();
    let (branch, game_path) = match segments.as_slice() {
        [host, branch, rest @ ..] if host == "game-data" && !rest.is_empty() => {
            (branch.clone(), rest.join("/").to_lowercase())
        }
        [host, id] if host == "splash" && id.bytes().all(|c| c.is_ascii_digit()) => {
            ("latest".to_string(), format!("splash/{id}.jpg"))
        }
        _ => return http_response(400, "text/plain", Vec::new()),
    };
    for candidate in asset_candidates(root, &branch, &game_path) {
        if let Ok(bytes) = std::fs::read(&candidate) {
            let kind = image_type(&bytes);
            return http_response(200, kind, bytes);
        }
    }
    not_found()
}

#[cfg(target_os = "macos")]
mod mac {
    use std::sync::{Mutex, mpsc};
    use std::time::Duration;

    use block2::RcBlock;
    use objc2::MainThreadMarker;
    use objc2::runtime::{AnyObject, NSObjectProtocol};
    use objc2_app_kit::{NSEvent, NSEventModifierFlags, NSEventType, NSWindowOcclusionState};
    use objc2_foundation::{
        NSActivityOptions, NSEdgeInsets, NSError, NSPoint, NSProcessInfo, NSRect, NSSize, NSString,
    };
    use objc2_web_kit::{WKContentWorld, WKWebView};
    use tauri::WebviewWindow;

    use super::{Key, KeyKind, MouseKind, json_returning_body, wait};

    /// Keeps App Nap from slowing timers while the window sits behind others,
    /// and the display from idling to sleep mid-run: WebKit stops painting a
    /// window on a sleeping display, so every snapshot would time out.
    pub fn hold_off_app_nap() {
        let activity = NSProcessInfo::processInfo().beginActivityWithOptions_reason(
            NSActivityOptions::UserInitiated
                | NSActivityOptions::LatencyCritical
                | NSActivityOptions::IdleDisplaySleepDisabled,
            &NSString::from_str("parity capture"),
        );
        // Held for the life of the process
        std::mem::forget(activity);
    }

    /// Runs `f` with the WKWebView on the main thread and waits for its answer.
    fn on_webview<T: Send + 'static>(
        window: &WebviewWindow,
        timeout: Duration,
        what: &str,
        f: impl FnOnce(&WKWebView, MainThreadMarker, mpsc::Sender<Result<T, String>>) + Send + 'static,
    ) -> Result<T, String> {
        let (tx, rx) = mpsc::channel();
        window
            .with_webview(move |platform| {
                let Some(webview) = platform.downcast_ref::<tauri_runtime_wry::Webview>() else {
                    let _ = tx.send(Err("the webview is not a wry webview".into()));
                    return;
                };
                let mtm = MainThreadMarker::new().expect("with_webview runs on the main thread");
                // SAFETY: wry hands out its live WKWebView, on the main thread
                let web: &WKWebView = unsafe { &*webview.inner().cast::<WKWebView>() };
                f(web, mtm, tx);
            })
            .map_err(|e| e.to_string())?;
        wait(rx, timeout, what)
    }

    pub fn eval(
        window: &WebviewWindow,
        expression: &str,
        timeout: Duration,
    ) -> Result<String, String> {
        let body = json_returning_body(expression);
        on_webview(window, timeout, "the script", move |web, mtm, tx| {
            let block = RcBlock::new(move |value: *mut AnyObject, error: *mut NSError| {
                // SAFETY: WebKit passes a value or an error, valid for the call
                let result = match unsafe { (error.as_ref(), value.as_ref()) } {
                    (Some(error), _) => Err(describe(error)),
                    (None, Some(value)) => value
                        .downcast_ref::<NSString>()
                        .map(|s| s.to_string())
                        .ok_or_else(|| "the script returned a non-string".to_string()),
                    (None, None) => Ok("null".to_string()),
                };
                let _ = tx.send(result);
            });
            unsafe {
                web.callAsyncJavaScript_arguments_inFrame_inContentWorld_completionHandler(
                    &NSString::from_str(&body),
                    None,
                    None,
                    &WKContentWorld::pageWorld(mtm),
                    Some(&block),
                );
            }
        })
    }

    fn describe(error: &NSError) -> String {
        let info = error.userInfo();
        let message = info
            .objectForKey(&NSString::from_str("WKJavaScriptExceptionMessage"))
            .and_then(|m| m.downcast::<NSString>().ok())
            .map(|m| m.to_string());
        match message {
            Some(message) => message,
            None => error.localizedDescription().to_string(),
        }
    }

    fn uptime() -> f64 {
        NSProcessInfo::processInfo().systemUptime()
    }

    /// The strip at the top of the webview that the page does not lay out in.
    /// On macOS 26 a titled window puts 32 pt of the webview under its title bar.
    pub fn top_inset(web: &WKWebView) -> f64 {
        let public = objc2::sel!(obscuredContentInsets);
        if !web.respondsToSelector(public) {
            return 0.0;
        }
        // SAFETY: a public WKWebView property since macOS 26, checked above
        let insets: NSEdgeInsets = unsafe { objc2::msg_send![web, obscuredContentInsets] };
        insets.top
    }

    /// CSS px from the viewport's top left to the window's own coordinates.
    fn window_point(web: &WKWebView, x: f64, y: f64) -> NSPoint {
        let bounds = web.bounds();
        let y = y + top_inset(web);
        let view_y = if web.isFlipped() {
            y
        } else {
            bounds.size.height - y
        };
        web.convertPoint_toView(NSPoint::new(x, view_y), None)
    }

    /// Delivered to the webview itself rather than through the window, so
    /// AppKit never makes the window key or activates the app.
    pub fn mouse(
        window: &WebviewWindow,
        kind: MouseKind,
        x: f64,
        y: f64,
    ) -> Result<&'static str, String> {
        on_webview(
            window,
            Duration::from_secs(5),
            "the mouse event",
            move |web, _mtm, tx| {
                let Some(ns_window) = web.window() else {
                    let _ = tx.send(Err("the webview has no window".into()));
                    return;
                };
                let event_type = match kind {
                    MouseKind::Move => NSEventType::MouseMoved,
                    MouseKind::Down => NSEventType::LeftMouseDown,
                    MouseKind::Up => NSEventType::LeftMouseUp,
                };
                let event = NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
                event_type,
                window_point(web, x, y),
                NSEventModifierFlags::empty(),
                uptime(),
                ns_window.windowNumber(),
                None,
                0,
                if kind == MouseKind::Move { 0 } else { 1 },
                if kind == MouseKind::Down { 1.0 } else { 0.0 },
            );
                let Some(event) = event else {
                    let _ = tx.send(Err("AppKit made no mouse event".into()));
                    return;
                };
                match kind {
                    MouseKind::Move => web.mouseMoved(&event),
                    MouseKind::Down => web.mouseDown(&event),
                    MouseKind::Up => web.mouseUp(&event),
                }
                let _ = tx.send(Ok("native"));
            },
        )
    }

    /// A wheel NSEvent can only be made from a CGEvent at a screen position,
    /// which WebKit then reads in the wrong space for a window that is not
    /// under the real pointer. So this scrolls what the wheel would have.
    pub fn wheel(
        window: &WebviewWindow,
        x: f64,
        y: f64,
        dx: f64,
        dy: f64,
    ) -> Result<&'static str, String> {
        let script = format!(
            "(() => {{
  let el = document.elementFromPoint({x}, {y});
  const canScroll = (n) => {{
    const s = getComputedStyle(n);
    return /(auto|scroll|overlay)/.test(s.overflowY + s.overflowX) &&
      (n.scrollHeight > n.clientHeight || n.scrollWidth > n.clientWidth);
  }};
  while (el && el !== document.body && !canScroll(el)) el = el.parentElement;
  const target = el && el !== document.body ? el : document.scrollingElement;
  target.dispatchEvent(new WheelEvent('wheel', {{ deltaX: {dx}, deltaY: {dy}, clientX: {x}, clientY: {y}, bubbles: true, cancelable: true }}));
  target.scrollBy({dx}, {dy});
  return true;
}})()"
        );
        eval(window, &script, Duration::from_secs(5)).map(|_| "js")
    }

    pub fn key(window: &WebviewWindow, kind: KeyKind, key: Key) -> Result<&'static str, String> {
        on_webview(
            window,
            Duration::from_secs(5),
            "the key event",
            move |web, _mtm, tx| {
                let Some(ns_window) = web.window() else {
                    let _ = tx.send(Err("the webview has no window".into()));
                    return;
                };
                let characters = match key.name {
                    "Escape" => "\u{1b}",
                    "Backspace" => "\u{7f}",
                    "Delete" => "\u{f728}",
                    "ArrowUp" => "\u{f700}",
                    "ArrowDown" => "\u{f701}",
                    "ArrowLeft" => "\u{f702}",
                    "ArrowRight" => "\u{f703}",
                    "Home" => "\u{f729}",
                    "End" => "\u{f72b}",
                    "PageUp" => "\u{f72c}",
                    "PageDown" => "\u{f72d}",
                    _ => key.text,
                };
                let characters = NSString::from_str(characters);
                let event = NSEvent::keyEventWithType_location_modifierFlags_timestamp_windowNumber_context_characters_charactersIgnoringModifiers_isARepeat_keyCode(
                if kind == KeyKind::Down { NSEventType::KeyDown } else { NSEventType::KeyUp },
                NSPoint::new(0.0, 0.0),
                NSEventModifierFlags::empty(),
                uptime(),
                ns_window.windowNumber(),
                None,
                &characters,
                &characters,
                false,
                key.mac_key_code,
            );
                let Some(event) = event else {
                    let _ = tx.send(Err("AppKit made no key event".into()));
                    return;
                };
                match kind {
                    KeyKind::Down => web.keyDown(&event),
                    KeyKind::Up => web.keyUp(&event),
                }
                let _ = tx.send(Ok("native"));
            },
        )
    }

    /// WebKit has no viewport override, so the window size sets the page's.
    pub fn emulate_viewport(_: &WebviewWindow, _: f64, _: f64, _: f64) -> Result<bool, String> {
        Ok(false)
    }

    /// The frame the window gave the webview, kept while the webview is grown past it.
    static WINDOW_FRAME: Mutex<Option<NSRect>> = Mutex::new(None);

    /// macOS keeps a window on its screen, so a card taller than the screen would lay out
    /// and snapshot short. This grows the webview past the window's bottom edge until the
    /// page is `height` CSS px tall. `None` gives the webview back the window's frame.
    pub fn set_page_height(
        window: &WebviewWindow,
        height: Option<f64>,
    ) -> Result<(f64, f64), String> {
        on_webview(
            window,
            Duration::from_secs(5),
            "the webview frame",
            move |web, _mtm, tx| {
                let mut saved = WINDOW_FRAME
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                let frame = match height {
                    None => {
                        if let Some(frame) = saved.take() {
                            web.setFrame(frame);
                        }
                        web.frame()
                    }
                    Some(height) => {
                        let base = *saved.get_or_insert_with(|| web.frame());
                        let tall = height + top_inset(web);
                        // SAFETY: on the main thread, and the superview outlives this call
                        let superview = unsafe { web.superview() };
                        let flipped = superview.is_some_and(|view| view.isFlipped());
                        let y = if flipped {
                            base.origin.y
                        } else {
                            base.origin.y + base.size.height - tall
                        };
                        let frame = NSRect::new(
                            NSPoint::new(base.origin.x, y),
                            NSSize::new(base.size.width, tall),
                        );
                        web.setFrame(frame);
                        frame
                    }
                };
                let _ = tx.send(Ok((frame.size.width, frame.size.height)));
            },
        )
    }

    pub fn top_inset_of(window: &WebviewWindow) -> Result<f64, String> {
        on_webview(
            window,
            Duration::from_secs(5),
            "the inset",
            move |web, _mtm, tx| {
                let _ = tx.send(Ok(top_inset(web)));
            },
        )
    }

    pub fn occluded(window: &WebviewWindow) -> Result<bool, String> {
        on_webview(
            window,
            Duration::from_secs(5),
            "the window state",
            move |web, _mtm, tx| {
                let visible = web
                    .window()
                    .is_some_and(|w| w.occlusionState().contains(NSWindowOcclusionState::Visible));
                let _ = tx.send(Ok(!visible));
            },
        )
    }
}

#[cfg(windows)]
mod win {
    use std::sync::mpsc;
    use std::time::Duration;

    use serde_json::{Value, json};
    use tauri::WebviewWindow;

    use super::{Key, KeyKind, MouseKind, json_returning_body, wait};
    use crate::snapshot::win::cdp;

    fn call(
        window: &WebviewWindow,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        let (tx, rx) = mpsc::channel();
        cdp(window, method, params.to_string(), move |result| {
            let _ = tx.send(result);
        })
        .map_err(|e| e.to_string())?;
        let text = wait(rx, timeout, method)?;
        serde_json::from_str(&text).map_err(|e| e.to_string())
    }

    pub fn eval(
        window: &WebviewWindow,
        expression: &str,
        timeout: Duration,
    ) -> Result<String, String> {
        let source = format!(
            "(async () => {{\n{}\n}})()",
            json_returning_body(expression)
        );
        let reply = call(
            window,
            "Runtime.evaluate",
            json!({ "expression": source, "awaitPromise": true, "returnByValue": true }),
            timeout,
        )?;
        if let Some(details) = reply.get("exceptionDetails") {
            let message = details["exception"]["description"]
                .as_str()
                .or_else(|| details["text"].as_str())
                .unwrap_or("the script threw");
            return Err(message.to_string());
        }
        reply["result"]["value"]
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| "the script returned a non-string".into())
    }

    pub fn mouse(
        window: &WebviewWindow,
        kind: MouseKind,
        x: f64,
        y: f64,
    ) -> Result<&'static str, String> {
        let (kind, button, clicks) = match kind {
            MouseKind::Move => ("mouseMoved", "none", 0),
            MouseKind::Down => ("mousePressed", "left", 1),
            MouseKind::Up => ("mouseReleased", "left", 1),
        };
        call(
            window,
            "Input.dispatchMouseEvent",
            json!({ "type": kind, "x": x, "y": y, "button": button, "clickCount": clicks }),
            Duration::from_secs(5),
        )?;
        Ok("native")
    }

    pub fn wheel(
        window: &WebviewWindow,
        x: f64,
        y: f64,
        dx: f64,
        dy: f64,
    ) -> Result<&'static str, String> {
        call(
            window,
            "Input.dispatchMouseEvent",
            json!({ "type": "mouseWheel", "x": x, "y": y, "deltaX": dx, "deltaY": dy }),
            Duration::from_secs(5),
        )?;
        Ok("native")
    }

    pub fn key(window: &WebviewWindow, kind: KeyKind, key: Key) -> Result<&'static str, String> {
        let mut params = json!({
            "key": key.name,
            "code": key.code,
            "windowsVirtualKeyCode": key.windows_key_code,
        });
        // As Playwright sends them: a key that types text is keyDown with that text
        let event = match kind {
            KeyKind::Down if key.text.is_empty() => "rawKeyDown",
            KeyKind::Down => {
                params["text"] = key.text.into();
                "keyDown"
            }
            KeyKind::Up => "keyUp",
        };
        params["type"] = event.into();
        call(
            window,
            "Input.dispatchKeyEvent",
            params,
            Duration::from_secs(5),
        )?;
        Ok("native")
    }

    pub fn occluded(_window: &WebviewWindow) -> Result<bool, String> {
        Ok(false)
    }

    pub fn top_inset_of(_window: &WebviewWindow) -> Result<f64, String> {
        Ok(0.0)
    }

    /// The viewport emulation already sets any height, so the frame never grows.
    pub fn set_page_height(
        window: &WebviewWindow,
        height: Option<f64>,
    ) -> Result<(f64, f64), String> {
        match height {
            None => {
                let scale = window.scale_factor().map_err(|e| e.to_string())?;
                let size = window
                    .inner_size()
                    .map_err(|e| e.to_string())?
                    .to_logical::<f64>(scale);
                Ok((size.width, size.height))
            }
            Some(_) => Err("WebView2 sets the page height through viewport emulation".into()),
        }
    }

    /// What Playwright does for a viewport and device scale: a window of that size at scale 2
    /// is larger than a CI runner's screen, and the OS would shrink it.
    pub fn emulate_viewport(
        window: &WebviewWindow,
        width: f64,
        height: f64,
        scale: f64,
    ) -> Result<bool, String> {
        call(
            window,
            "Emulation.setDeviceMetricsOverride",
            json!({
                "width": width,
                "height": height,
                "deviceScaleFactor": scale,
                "mobile": false,
                "screenWidth": width,
                "screenHeight": height,
            }),
            Duration::from_secs(5),
        )?;
        Ok(true)
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
mod other {
    use std::time::Duration;

    use tauri::WebviewWindow;

    use super::{Key, KeyKind, MouseKind};

    const NONE: &str = "the parity driver is built for macOS and Windows only";

    pub fn eval(_: &WebviewWindow, _: &str, _: Duration) -> Result<String, String> {
        Err(NONE.into())
    }
    pub fn mouse(_: &WebviewWindow, _: MouseKind, _: f64, _: f64) -> Result<&'static str, String> {
        Err(NONE.into())
    }
    pub fn wheel(
        _: &WebviewWindow,
        _: f64,
        _: f64,
        _: f64,
        _: f64,
    ) -> Result<&'static str, String> {
        Err(NONE.into())
    }
    pub fn key(_: &WebviewWindow, _: KeyKind, _: Key) -> Result<&'static str, String> {
        Err(NONE.into())
    }
    pub fn occluded(_: &WebviewWindow) -> Result<bool, String> {
        Ok(false)
    }
    pub fn top_inset_of(_: &WebviewWindow) -> Result<f64, String> {
        Ok(0.0)
    }
    pub fn emulate_viewport(_: &WebviewWindow, _: f64, _: f64, _: f64) -> Result<bool, String> {
        Ok(false)
    }
    pub fn set_page_height(_: &WebviewWindow, height: Option<f64>) -> Result<(f64, f64), String> {
        match height {
            None => Ok((0.0, 0.0)),
            Some(_) => Err(NONE.into()),
        }
    }
}

#[cfg(target_os = "macos")]
use mac as platform;
#[cfg(not(any(target_os = "macos", windows)))]
use other as platform;
#[cfg(windows)]
use win as platform;

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "0123456789abcdef0123456789abcdef";

    fn loopback() -> SocketAddr {
        "127.0.0.1:50000".parse().unwrap()
    }

    fn bearer(token: &str) -> Vec<(String, String)> {
        vec![("authorization".into(), format!("Bearer {token}"))]
    }

    #[test]
    fn driver_accepts_the_token_from_loopback() {
        assert_eq!(authorize(loopback(), &bearer(TOKEN), TOKEN), Ok(()));
        let v6: SocketAddr = "[::1]:50000".parse().unwrap();
        assert_eq!(authorize(v6, &bearer(TOKEN), TOKEN), Ok(()));
    }

    #[test]
    fn driver_refuses_a_request_without_the_token() {
        assert_eq!(
            authorize(loopback(), &[], TOKEN),
            Err(Refusal::MissingToken)
        );
        let other_header = vec![("x-token".to_string(), TOKEN.to_string())];
        assert_eq!(
            authorize(loopback(), &other_header, TOKEN),
            Err(Refusal::MissingToken)
        );
    }

    #[test]
    fn driver_refuses_a_wrong_token() {
        let wrong = "0123456789abcdef0123456789abcdee";
        assert_eq!(
            authorize(loopback(), &bearer(wrong), TOKEN),
            Err(Refusal::WrongToken)
        );
        assert_eq!(
            authorize(loopback(), &bearer(&TOKEN[..31]), TOKEN),
            Err(Refusal::WrongToken)
        );
        let not_bearer = vec![("authorization".to_string(), TOKEN.to_string())];
        assert_eq!(
            authorize(loopback(), &not_bearer, TOKEN),
            Err(Refusal::WrongToken)
        );
        assert_eq!(Refusal::WrongToken.status(), 401);
    }

    #[test]
    fn driver_refuses_a_non_loopback_peer() {
        let lan: SocketAddr = "10.0.0.1:50000".parse().unwrap();
        assert_eq!(
            authorize(lan, &bearer(TOKEN), TOKEN),
            Err(Refusal::NotLoopback)
        );
        let public: SocketAddr = "[2001:db8::1]:50000".parse().unwrap();
        assert_eq!(
            authorize(public, &bearer(TOKEN), TOKEN),
            Err(Refusal::NotLoopback)
        );
        assert_eq!(Refusal::NotLoopback.status(), 403);
    }

    #[test]
    fn driver_does_not_start_without_a_token() {
        assert!(token_from(None).is_err());
        assert!(token_from(Some(String::new())).is_err());
        assert!(token_from(Some("   ".into())).is_err());
        assert!(token_from(Some("short".into())).is_err());
        assert_eq!(
            token_from(Some(format!(" {TOKEN}\n"))),
            Ok(TOKEN.to_string())
        );
    }

    #[test]
    fn driver_finds_keys_by_playwright_name() {
        assert_eq!(find_key("Enter").unwrap().mac_key_code, 36);
        assert_eq!(find_key("a").unwrap().code, "KeyA");
        assert_eq!(find_key("z").unwrap().windows_key_code, 0x5a);
        assert_eq!(find_key("7").unwrap().code, "Digit7");
        assert_eq!(find_key("7").unwrap().mac_key_code, 26);
        assert!(find_key("Hyper").is_err());
    }

    #[test]
    fn driver_files_assets_where_electron_caches_them() {
        let root = std::env::temp_dir().join(format!("bmt-asset-{}", std::process::id()));
        for patch in ["16.9", "16.22", "16.3", "latest-pointer"] {
            std::fs::create_dir_all(root.join(patch)).unwrap();
        }
        let path = "v1/champion-icons/1.png";
        let name = format!("{}.png", sha1_smol::Sha1::from(path).digest());
        let order = |branch: &str| -> Vec<String> {
            asset_candidates(&root, branch, path)
                .iter()
                .map(|p| {
                    assert_eq!(p.file_name().unwrap().to_str().unwrap(), name);
                    p.parent()
                        .unwrap()
                        .file_name()
                        .unwrap()
                        .to_str()
                        .unwrap()
                        .to_string()
                })
                .collect()
        };
        assert_eq!(order("latest"), ["16.22", "16.9", "16.3"]);
        assert_eq!(order("16.9"), ["16.9", "16.22", "16.3"]);
        assert_eq!(order("16.4"), ["16.4", "16.22", "16.9", "16.3"]);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn driver_reads_both_engines_scheme_urls_alike() {
        let webkit: tauri::http::Uri = "asset://game-data/16.22/v1/a%20b.png".parse().unwrap();
        let webview2: tauri::http::Uri = "http://asset.localhost/game-data/16.22/v1/a%20b.png"
            .parse()
            .unwrap();
        assert_eq!(scheme_path(&webkit), "game-data/16.22/v1/a%20b.png");
        assert_eq!(scheme_path(&webview2), scheme_path(&webkit));
        assert_eq!(percent_decode("a%20b%zz"), "a b%zz");
    }

    #[test]
    fn driver_refuses_a_mapped_ipv4_peer() {
        // The listener binds IPv4 only, so a mapped address is never a local caller
        for peer in ["[::ffff:10.0.0.1]:50000", "[::ffff:127.0.0.1]:50000"] {
            let peer: SocketAddr = peer.parse().unwrap();
            assert_eq!(
                authorize(peer, &bearer(TOKEN), TOKEN),
                Err(Refusal::NotLoopback),
                "{peer}"
            );
        }
    }

    struct Renderer(PathBuf);

    impl Renderer {
        fn new() -> Self {
            let base = std::env::temp_dir().join(format!(
                "bmt-renderer-{}-{:?}",
                std::process::id(),
                std::thread::current().id()
            ));
            let root = base.join("renderer");
            std::fs::create_dir_all(root.join("assets")).unwrap();
            std::fs::write(root.join("index.html"), "<html>").unwrap();
            std::fs::write(root.join("assets/app.js"), "").unwrap();
            std::fs::write(base.join("outside.txt"), "secret").unwrap();
            Self(base)
        }

        fn root(&self) -> PathBuf {
            self.0.join("renderer")
        }
    }

    impl Drop for Renderer {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[test]
    fn driver_serves_files_inside_the_renderer() {
        let dir = Renderer::new();
        let root = dir.root().canonicalize().unwrap();
        assert_eq!(
            safe_join(&dir.root(), "index.html"),
            Some(root.join("index.html"))
        );
        assert_eq!(
            safe_join(&dir.root(), "assets//app.js"),
            Some(root.join("assets/app.js"))
        );
        // A leading slash is the URL's, not the disk's root
        assert_eq!(
            safe_join(&dir.root(), "/index.html"),
            Some(root.join("index.html"))
        );
        assert_eq!(safe_join(&dir.root(), "missing.js"), None);
    }

    #[test]
    fn driver_refuses_paths_that_leave_the_renderer() {
        let dir = Renderer::new();
        let refused = [
            "../outside.txt",
            "assets/../../outside.txt",
            "./index.html",
            "C:/Windows/win.ini",
            "C:",
            "c:outside.txt",
            "\\\\server\\share\\x",
            "assets\\..\\..\\outside.txt",
            "\\outside.txt",
        ];
        for path in refused {
            assert_eq!(safe_join(&dir.root(), path), None, "{path}");
        }
        // The scheme handler decodes before joining, so an escaped ':' or '\\' is refused too
        for url in [
            "C%3A/Windows/win.ini",
            "%5C%5Cserver%5Cshare",
            "%2E%2E/outside.txt",
        ] {
            assert_eq!(safe_join(&dir.root(), &percent_decode(url)), None, "{url}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn driver_refuses_a_link_out_of_the_renderer() {
        let dir = Renderer::new();
        std::os::unix::fs::symlink(dir.0.join("outside.txt"), dir.root().join("link.txt")).unwrap();
        assert_eq!(safe_join(&dir.root(), "link.txt"), None);
    }

    #[test]
    fn driver_keeps_the_page_on_its_own_origin() {
        let renderer = [Url::parse("parity://localhost/index.html").unwrap()];
        let ok = |url: &str| may_navigate(&Url::parse(url).unwrap(), &renderer);
        assert!(ok("parity://localhost/index.html#/matches"));
        assert!(ok("parity://localhost/other.html"));
        assert!(ok("about:blank"));
        for refused in [
            "file:///etc/passwd",
            "https://example.com/",
            "http://localhost/",
            "parity://evil/index.html",
            "tauri://localhost/",
            "asset://game-data/16.22/x.png",
            "data:text/html,hi",
            "javascript:alert(1)",
        ] {
            assert!(!ok(refused), "{refused}");
        }
        let windows = [Url::parse("http://parity.localhost/index.html").unwrap()];
        let win = |url: &str| may_navigate(&Url::parse(url).unwrap(), &windows);
        assert!(win("http://parity.localhost/index.html#/x"));
        assert!(!win("https://parity.localhost/"));
        assert!(!win("http://parity.localhost:8080/"));
        assert!(!win("http://asset.localhost/game-data/x.png"));
        let app = app_origins(None);
        assert!(may_navigate(
            &Url::parse("tauri://localhost/index.html").unwrap(),
            &app
        ));
        assert!(may_navigate(
            &Url::parse("http://tauri.localhost/").unwrap(),
            &app
        ));
        assert!(!may_navigate(
            &Url::parse("https://tauri.localhost/").unwrap(),
            &app
        ));
        assert!(!may_navigate(&Url::parse("file:///").unwrap(), &[]));
    }

    fn parse(raw: &[u8]) -> Result<Request, String> {
        read_request(raw)
    }

    #[test]
    fn driver_reads_a_request() {
        let request = parse(
            b"POST / HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer abc\r\nContent-Length: 13\r\n\r\n{\"op\":\"info\"}",
        )
        .unwrap();
        assert_eq!(request.method, "POST");
        assert_eq!(request.path, "/");
        assert!(
            request
                .headers
                .contains(&("authorization".into(), "Bearer abc".into()))
        );
        assert_eq!(request.body, br#"{"op":"info"}"#);
        let bare = parse(b"GET /x HTTP/1.1\n\n").unwrap();
        assert_eq!((bare.method.as_str(), bare.path.as_str()), ("GET", "/x"));
        assert!(bare.body.is_empty());
    }

    #[test]
    fn driver_refuses_a_malformed_request() {
        assert!(parse(b"").is_err());
        assert!(parse(b"POST / HTTP/1.1\r\nContent-Length: 5\r\n").is_err());
        assert!(parse(b"POST / HTTP/1.1\r\nContent-Length: x\r\n\r\n").is_err());
        assert!(parse(b"POST / HTTP/1.1\r\nContent-Length: 10\r\n\r\nshort").is_err());
        let too_big = format!(
            "POST / HTTP/1.1\r\nContent-Length: {}\r\n\r\n",
            MAX_BODY_BYTES + 1
        );
        assert_eq!(
            parse(too_big.as_bytes()).err().as_deref(),
            Some("body too large")
        );
        let long_head = format!(
            "POST / HTTP/1.1\r\nX: {}\r\n\r\n",
            "a".repeat(MAX_HEAD_BYTES)
        );
        assert_eq!(
            parse(long_head.as_bytes()).err().as_deref(),
            Some("bad request head")
        );
    }
}
