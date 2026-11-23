//! `src/main/updater.ts`: checks GitHub's releases, downloads the install
//! asset while hashing it, swaps it in with a detached script, and quits.
//! Electron 1.2.1 installs the first Tauri release through its own copy of
//! this code, and every later release installs through this one, so the
//! release page, the asset names, the swap, and every string the page shows
//! stay as 1.2.1 has them (decision E6).
//!
//! The decisions are pure functions ([`evaluate`], [`release_notes_between`]).
//! The install flow and the schedule run against a [`Host`], which the app
//! implements over its state and tests implement with fakes. Every wait is on
//! `tokio::time`, so tests drive the schedule with a paused clock.

use std::cmp::Ordering as CmpOrdering;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use futures_util::future::BoxFuture;
use regex::Regex;
use serde_json::Value;
use tokio::sync::{OnceCell, mpsc};
use tokio::time::{Instant, MissedTickBehavior, sleep, timeout};

use crate::commands::app::{DownloadUpdateResult, ReleaseNote, UpdateInfo, UpdateNotes};
use crate::shell::HIDDEN_FLAG;

pub const RELEASES_URL: &str =
    "https://api.github.com/repos/rambo0247/better-mayhem-tracker/releases?per_page=20";
pub const DOWNLOAD_PREFIX: &str = "https://github.com/rambo0247/better-mayhem-tracker/";
const RELEASE_TAG_URL: &str = "https://github.com/rambo0247/better-mayhem-tracker/releases/tag/v";
pub const USER_AGENT: &str = "better-mayhem-tracker";

pub const CHECK_TIMEOUT: Duration = Duration::from_secs(10);
const RELEASE_PAGE_SIZE: usize = 20;
const MAX_BODY_CHARS: usize = 4_000;
/// Per chunk, not for the whole download: a slow but moving download is fine.
pub const DOWNLOAD_STALL_TIMEOUT: Duration = Duration::from_secs(30);
const LAUNCH_CHECK_ATTEMPTS: u32 = 3;
pub const LAUNCH_RETRY: Duration = Duration::from_secs(60);
pub const BACKGROUND_CHECK: Duration = Duration::from_secs(45 * 60);
pub const AWAY_SETTLE: Duration = Duration::from_secs(2 * 60);
/// Lets the command's answer reach the page before the app quits.
pub const QUIT_DELAY: Duration = Duration::from_millis(200);

const NO_RELEASES: &str = "No releases found";
const CHECK_FAILED: &str = "Failed to check for updates";
const ALREADY_INSTALLING: &str = "An update is already being installed";
const NOT_DURABLE_MAC: &str =
    "In-app update only works once the app is in your Applications folder";
const NOT_DURABLE_WINDOWS: &str = "In-app update only works in the portable exe build";
const UNEXPECTED_URL: &str = "Unexpected download URL";
const NOT_LATEST: &str = "That download is no longer the latest release";
const INCOMPLETE: &str = "Download incomplete, please try again";
const INTEGRITY: &str = "Downloaded file failed its integrity check";
const STALLED: &str = "Download stalled, please try again";
const MATCH_STARTED: &str =
    "A match started during the download. Install from here once it's over.";
const UNPACK_FAILED: &str = "The downloaded update couldn't be unpacked";
const UPDATE_FAILED: &str = "Update failed";
/// What Node's fetch rejects with for any transport failure.
const FETCH_FAILED: &str = "fetch failed";

// ---------------------------------------------------------------------------
// Versions, assets, and release notes

/// `parseVersion`: the leading `X.Y.Z` of a tag, each part as JS's `Number`.
pub fn parse_version(version: &str) -> Option<[f64; 3]> {
    static VERSION: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^([0-9]+)\.([0-9]+)\.([0-9]+)").expect("a valid regex"));
    let trimmed = js_trim(version);
    let bare = trimmed.strip_prefix('v').unwrap_or(trimmed);
    let caps = VERSION.captures(bare)?;
    let part = |i: usize| caps[i].parse::<f64>().ok();
    Some([part(1)?, part(2)?, part(3)?])
}

/// `compareVersions`. An unparseable tag sorts older, so a malformed release
/// never presents itself as an update.
pub fn compare_versions(a: &str, b: &str) -> CmpOrdering {
    match (parse_version(a), parse_version(b)) {
        (Some(pa), Some(pb)) => pa
            .iter()
            .zip(pb.iter())
            .find(|(x, y)| x != y)
            .map_or(CmpOrdering::Equal, |(x, y)| {
                x.partial_cmp(y).unwrap_or(CmpOrdering::Equal)
            }),
        (Some(_), None) => CmpOrdering::Greater,
        (None, Some(_)) => CmpOrdering::Less,
        (None, None) => CmpOrdering::Equal,
    }
}

fn newer(a: &str, b: &str) -> bool {
    compare_versions(a, b) == CmpOrdering::Greater
}

/// `String.prototype.trim`: JS whitespace and line terminators, BOM included.
fn js_trim(text: &str) -> &str {
    fn is_js_space(c: char) -> bool {
        matches!(
            c,
            '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
                ..='\u{200a}'
                    | '\u{2028}'
                    | '\u{2029}'
                    | '\u{202f}'
                    | '\u{205f}'
                    | '\u{3000}'
                    | '\u{feff}'
        )
    }
    text.trim_matches(is_js_space)
}

/// The first `units` UTF-16 code units, as `String.prototype.slice` counts. A
/// pair the cut would split is dropped whole, since a Rust string cannot hold
/// the lone half JS would keep.
fn utf16_prefix(text: &str, units: usize) -> &str {
    let mut used = 0;
    for (index, c) in text.char_indices() {
        used += c.len_utf16();
        if used > units {
            return &text[..index];
        }
    }
    text
}

/// JS's `String(value)` for the shapes a release field can take.
fn js_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        Value::Array(_) | Value::Object(_) => "[object Object]".into(),
    }
}

fn js_truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn tag_of(release: &Value) -> String {
    let tag = js_string(release.get("tag_name").unwrap_or(&Value::Null));
    tag.strip_prefix('v').map(str::to_owned).unwrap_or(tag)
}

/// `toReleaseNote`.
pub fn to_release_note(release: &Value) -> ReleaseNote {
    // GitHub appends this to every generated body; the dialog links to the
    // release page already. JS's `.` stops at any line terminator.
    static FULL_CHANGELOG: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?im)^[ \t]*\*\*Full Changelog\*\*:[^\n\r\u{2028}\u{2029}]*")
            .expect("a valid regex")
    });
    let body = match release.get("body") {
        None | Some(Value::Null) => String::new(),
        Some(value) => js_string(value),
    };
    let body = body.replace("\r\n", "\n");
    let body = FULL_CHANGELOG.replace_all(&body, "");
    let body = js_trim(&body);
    let body = if body.encode_utf16().count() > MAX_BODY_CHARS {
        format!("{}…", utf16_prefix(body, MAX_BODY_CHARS))
    } else {
        body.to_owned()
    };
    ReleaseNote {
        version: tag_of(release),
        published_at: string_field(release, "published_at").unwrap_or_default(),
        body,
        url: string_field(release, "html_url").unwrap_or_default(),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Os {
    Mac,
    Windows,
    Other,
}

/// Electron's `process.platform` and `process.arch`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Platform {
    pub os: Os,
    pub arch: &'static str,
}

impl Platform {
    /// The build's own target, as `process.arch` is the Electron binary's.
    pub fn current() -> Self {
        let os = match std::env::consts::OS {
            "macos" => Os::Mac,
            "windows" => Os::Windows,
            _ => Os::Other,
        };
        Self {
            os,
            arch: node_arch(std::env::consts::ARCH),
        }
    }
}

/// Rust's arch names as Node spells them.
pub fn node_arch(rust_arch: &'static str) -> &'static str {
    match rust_arch {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        "x86" => "ia32",
        other => other,
    }
}

/// `isInstallAsset`: the zipped bundle for this arch on macOS, the first
/// `.exe` anywhere else. The dmg is for first installs only.
pub fn is_install_asset(name: Option<&Value>, platform: Platform) -> bool {
    let Some(name) = name.and_then(Value::as_str) else {
        return false;
    };
    match platform.os {
        Os::Mac => name == format!("BetterMayhemTracker-mac-{}.zip", platform.arch),
        _ => name.ends_with(".exe"),
    }
}

/// `parseDigest`: GitHub reports `sha256:<hex>`.
pub fn parse_digest(digest: Option<&Value>) -> Option<String> {
    static DIGEST: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)^sha256:([0-9a-f]{64})$").expect("a valid regex"));
    let digest = digest?.as_str()?;
    Some(DIGEST.captures(digest)?[1].to_ascii_lowercase())
}

/// The release page as GitHub sent it, and the part of it that was published.
#[derive(Debug, Clone)]
pub struct Page {
    pub page: Vec<Value>,
    pub published: Vec<Value>,
}

impl Page {
    /// Drafts and prereleases are on this endpoint too, and were never meant
    /// to be offered.
    pub fn from_body(body: Value) -> Self {
        let page = match body {
            Value::Array(items) => items,
            _ => Vec::new(),
        };
        let published = page
            .iter()
            .filter(|r| {
                js_truthy(Some(r))
                    && !js_truthy(r.get("draft"))
                    && !js_truthy(r.get("prerelease"))
                    && r.get("tag_name").is_some_and(Value::is_string)
            })
            .cloned()
            .collect();
        Self { page, published }
    }
}

/// The asset URL and digest from the last check. The page only ever echoes a
/// URL back, so the hash checked against always came from GitHub.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CachedAsset {
    pub asset_url: String,
    pub sha256: Option<String>,
}

fn failed_check(error: &str) -> UpdateInfo {
    UpdateInfo {
        has_update: false,
        error: Some(error.into()),
        ..UpdateInfo::default()
    }
}

/// A release whose `assets` is neither a list nor missing, where Electron's
/// `.find` throws.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MalformedRelease;

/// `checkForUpdate` once the page is in. The asset is returned only when the
/// newest release has one with a URL, which is when Electron overwrites its
/// cache. `Err` is where Electron's code would have thrown.
pub fn evaluate(
    page: &Page,
    current: &str,
    platform: Platform,
) -> Result<(UpdateInfo, Option<CachedAsset>), MalformedRelease> {
    let Some(newest) = page.published.first() else {
        return Ok((failed_check(NO_RELEASES), None));
    };
    let latest = tag_of(newest);
    let asset = match newest.get("assets") {
        None | Some(Value::Null) => None,
        Some(Value::Array(assets)) => assets
            .iter()
            .find(|a| is_install_asset(a.get("name"), platform)),
        Some(_) => return Err(MalformedRelease),
    };
    let asset_url = asset.and_then(|a| string_field(a, "browser_download_url"));
    let cached = asset_url
        .as_ref()
        .filter(|url| !url.is_empty())
        .map(|url| CachedAsset {
            asset_url: url.clone(),
            sha256: parse_digest(asset.and_then(|a| a.get("digest"))),
        });
    // A local build can sit ahead of the newest release, and a release with
    // nothing for macOS would only ever point a Mac at a Windows exe
    let has_update = newer(&latest, current) && (platform.os != Os::Mac || asset.is_some());
    let missed: Vec<ReleaseNote> = if has_update {
        page.published
            .iter()
            .filter(|r| newer(&js_string(&r["tag_name"]), current))
            .map(to_release_note)
            .collect()
    } else {
        Vec::new()
    };
    let reached_current = page.page.len() < RELEASE_PAGE_SIZE
        || page
            .published
            .iter()
            .any(|r| !newer(&js_string(&r["tag_name"]), current));
    let info = UpdateInfo {
        has_update,
        latest: Some(latest),
        current: Some(current.to_owned()),
        url: string_field(newest, "html_url"),
        asset_url,
        asset_size: asset
            .and_then(|a| a.get("size"))
            .and_then(Value::as_f64)
            .map(|size| size as i64),
        releases: Some(missed),
        more_versions: Some(has_update && !reached_current),
        error: None,
    };
    Ok((info, cached))
}

/// `loadUpdateNotes` once the page is in, or with no page when it failed.
pub fn release_notes_between(page: Option<&Page>, from: &str, to: &str) -> UpdateNotes {
    let releases = page
        .map(|page| {
            page.published
                .iter()
                .filter(|r| {
                    let tag = js_string(&r["tag_name"]);
                    newer(&tag, from) && !newer(&tag, to)
                })
                .map(to_release_note)
                .collect()
        })
        .unwrap_or_default();
    UpdateNotes {
        from: from.to_owned(),
        to: to.to_owned(),
        url: format!("{RELEASE_TAG_URL}{to}"),
        releases,
    }
}

/// `recordLaunchVersion`: the version this install ran as before, when this
/// launch is the first on a newer one, and whether to write `current`.
pub fn launch_version_change(previous: Option<&str>, current: &str) -> (Option<String>, bool) {
    let updated_from = previous
        .filter(|p| !p.is_empty() && newer(current, p))
        .map(str::to_owned);
    (updated_from, previous != Some(current))
}

// ---------------------------------------------------------------------------
// What the updater runs against

#[derive(Debug, Clone, PartialEq)]
pub enum UpdateEvent {
    Progress(i64),
    Installing(UpdateInfo),
    InstallFailed(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Level {
    Info,
    Warn,
    Error,
}

/// What gets swapped: the bundle on macOS, the exe on Windows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InstallTarget {
    MacBundle(PathBuf),
    WindowsExe(PathBuf),
}

/// A download's body, a chunk at a time. `None` once it is done.
pub trait Chunks: Send {
    fn next_chunk(&mut self) -> BoxFuture<'_, Result<Option<Vec<u8>>, String>>;
}

pub struct Download {
    pub status: u16,
    pub content_length: Option<u64>,
    pub body: Box<dyn Chunks>,
}

pub trait Host: Send + Sync + 'static {
    fn platform(&self) -> Platform;
    fn current_version(&self) -> String;
    /// The release page's JSON. `Ok(None)` when GitHub answered non-OK, `Err`
    /// when the request failed or the body was not JSON.
    fn fetch_page(&self) -> BoxFuture<'_, Result<Option<Value>, String>>;
    fn open_download<'a>(&'a self, url: &'a str) -> BoxFuture<'a, Result<Download, String>>;
    fn setting(&self, key: &str) -> Option<String>;
    fn install_target(&self) -> Option<InstallTarget>;
    fn window_visible(&self) -> bool;
    fn window_minimized(&self) -> bool;
    /// `matchUnderway`: the client's phase or the game's own API.
    fn match_underway(&self) -> BoxFuture<'_, bool>;
    fn backfill_running(&self) -> bool;
    fn emit(&self, event: UpdateEvent);
    fn log(&self, level: Level, line: &str);
    fn temp_dir(&self) -> PathBuf;
    /// Stages the download and starts the detached swap script.
    fn apply(
        &self,
        target: &InstallTarget,
        download: &Path,
        tmp_dir: &Path,
        relaunch_hidden: bool,
    ) -> Result<(), String>;
    /// Electron's `app.quit()`, through the final fetch.
    fn quit(&self);
}

fn has_durable_install(host: &dyn Host) -> bool {
    host.install_target().is_some()
}

fn auto_update_on(host: &dyn Host) -> bool {
    host.setting("auto_update").as_deref() != Some("false")
}

fn window_in_use(host: &dyn Host) -> bool {
    host.window_visible() && !host.window_minimized()
}

// ---------------------------------------------------------------------------
// The updater

#[derive(Default)]
pub struct Updater {
    cached: Mutex<Option<CachedAsset>>,
    installing: AtomicBool,
    launch_install: Mutex<Option<UpdateInfo>>,
    updated_from: Mutex<Option<String>>,
    notes: OnceCell<Option<UpdateNotes>>,
}

fn failure(error: impl Into<String>) -> DownloadUpdateResult {
    DownloadUpdateResult {
        success: false,
        error: Some(error.into()),
    }
}

/// Removes the download's temp folder on every way out of a failed install.
struct TempDir(PathBuf);

impl TempDir {
    fn remove(self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// `fs.mkdtempSync(path.join(os.tmpdir(), "better-mayhem-update-"))`: six
/// random letters and digits, and the folder made only if it is new.
fn make_temp_dir(parent: &Path) -> std::io::Result<PathBuf> {
    use ring::rand::{SecureRandom, SystemRandom};
    const LETTERS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let random = SystemRandom::new();
    loop {
        let mut bytes = [0u8; 6];
        random
            .fill(&mut bytes)
            .map_err(|_| std::io::Error::other("no randomness"))?;
        let suffix: String = bytes
            .iter()
            .map(|b| LETTERS[*b as usize % LETTERS.len()] as char)
            .collect();
        let dir = parent.join(format!("better-mayhem-update-{suffix}"));
        match std::fs::create_dir(&dir) {
            Ok(()) => return Ok(dir),
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(err) => return Err(err),
        }
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

impl Updater {
    pub fn new() -> Self {
        Self::default()
    }

    /// `checkForUpdate`.
    pub async fn check(&self, host: &dyn Host) -> UpdateInfo {
        let body = match host.fetch_page().await {
            Ok(Some(body)) => body,
            Ok(None) => return failed_check(NO_RELEASES),
            Err(_) => return failed_check(CHECK_FAILED),
        };
        let page = Page::from_body(body);
        match evaluate(&page, &host.current_version(), host.platform()) {
            Ok((info, cached)) => {
                if let Some(cached) = cached {
                    *self.cached.lock().expect("cached asset") = Some(cached);
                }
                info
            }
            Err(MalformedRelease) => failed_check(CHECK_FAILED),
        }
    }

    /// The digest for `url` when the last check found that URL.
    fn cached_digest(&self, url: &str) -> Option<Option<String>> {
        let cached = self.cached.lock().expect("cached asset");
        cached
            .as_ref()
            .filter(|c| c.asset_url == url)
            .map(|c| c.sha256.clone())
    }

    pub fn launch_install(&self) -> Option<UpdateInfo> {
        self.launch_install.lock().expect("launch install").clone()
    }

    fn set_launch_install(&self, info: Option<UpdateInfo>) {
        *self.launch_install.lock().expect("launch install") = info;
    }

    /// `downloadAndInstall`. `guard_match` is the launch and background
    /// installs' `canRestart`, asked once the download is verified.
    pub async fn download_and_install(
        &self,
        host: Arc<dyn Host>,
        asset_url: &str,
        guard_match: bool,
    ) -> DownloadUpdateResult {
        if self
            .installing
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return failure(ALREADY_INSTALLING);
        }
        let result = self.install(host, asset_url, guard_match).await;
        // Left set on success: the app is on its way out
        if !result.success {
            self.installing.store(false, Ordering::SeqCst);
        }
        result
    }

    async fn install(
        &self,
        host: Arc<dyn Host>,
        asset_url: &str,
        guard_match: bool,
    ) -> DownloadUpdateResult {
        let Some(target) = host.install_target() else {
            return failure(match host.platform().os {
                Os::Mac => NOT_DURABLE_MAC,
                _ => NOT_DURABLE_WINDOWS,
            });
        };
        if !asset_url.starts_with(DOWNLOAD_PREFIX) {
            return failure(UNEXPECTED_URL);
        }
        let expected = match self.cached_digest(asset_url) {
            Some(expected) => expected,
            None => {
                self.check(host.as_ref()).await;
                match self.cached_digest(asset_url) {
                    Some(expected) => expected,
                    None => return failure(NOT_LATEST),
                }
            }
        };
        let tmp_dir = match make_temp_dir(&host.temp_dir()) {
            Ok(dir) => TempDir(dir),
            Err(err) => return failure(format!("Failed to create temp dir: {err}")),
        };
        let file_name = match target {
            InstallTarget::MacBundle(_) => "better-mayhem-tracker-update.zip",
            InstallTarget::WindowsExe(_) => "better-mayhem-tracker-update.exe",
        };
        let download = tmp_dir.0.join(file_name);
        if let Err(error) = fetch_to_file(host.as_ref(), asset_url, &download, expected).await {
            tmp_dir.remove();
            return failure(error);
        }
        if guard_match && host.match_underway().await {
            tmp_dir.remove();
            return failure(MATCH_STARTED);
        }
        // Comes back the way it was left: updated from the tray, it reopens there
        let relaunch_hidden = !host.window_visible();
        let applied = {
            let host = host.clone();
            let target = target.clone();
            let (download, dir) = (download.clone(), tmp_dir.0.clone());
            tokio::task::spawn_blocking(move || {
                host.apply(&target, &download, &dir, relaunch_hidden)
            })
            .await
            .unwrap_or_else(|err| Err(err.to_string()))
        };
        if let Err(error) = applied {
            tmp_dir.remove();
            return failure(error);
        }
        // The script removes the temp folder itself once the swap is done
        tokio::spawn(async move {
            sleep(QUIT_DELAY).await;
            host.quit();
        });
        DownloadUpdateResult {
            success: true,
            error: None,
        }
    }

    /// `installUpdateOnLaunch`: once per launch, so an update only restarts
    /// the app at a moment the user just started it.
    pub async fn install_on_launch(&self, host: Arc<dyn Host>) {
        if !has_durable_install(host.as_ref()) || !auto_update_on(host.as_ref()) {
            return;
        }
        let mut info = self.check(host.as_ref()).await;
        let mut attempt = 1;
        while info.error.is_some() && attempt < LAUNCH_CHECK_ATTEMPTS {
            sleep(LAUNCH_RETRY).await;
            info = self.check(host.as_ref()).await;
            attempt += 1;
        }
        if let Some(error) = &info.error {
            host.log(Level::Info, &format!("Launch update check failed: {error}"));
        }
        let Some(asset_url) = info.asset_url.clone().filter(|_| info.has_update) else {
            return;
        };
        let latest = info.latest.clone().unwrap_or_default();
        if host.match_underway().await {
            host.log(
                Level::Info,
                &format!("Update {latest} available; not installing during a match"),
            );
            return;
        }
        host.log(
            Level::Info,
            &format!("Installing update {latest} on launch"),
        );
        self.run_install(host, info, &asset_url, "Launch update failed:")
            .await;
    }

    async fn run_install(
        &self,
        host: Arc<dyn Host>,
        info: UpdateInfo,
        asset_url: &str,
        failed: &str,
    ) {
        self.set_launch_install(Some(info.clone()));
        host.emit(UpdateEvent::Installing(info));
        let result = self
            .download_and_install(host.clone(), asset_url, true)
            .await;
        if !result.success {
            self.set_launch_install(None);
            let error = result.error.unwrap_or_else(|| UPDATE_FAILED.into());
            host.log(Level::Info, &format!("{failed} {error}"));
            host.emit(UpdateEvent::InstallFailed(error));
        }
    }

    /// `installInBackground`: only while nobody is using the app.
    pub async fn install_in_background(&self, host: Arc<dyn Host>) {
        if self.installing.load(Ordering::SeqCst) || window_in_use(host.as_ref()) {
            return;
        }
        if !has_durable_install(host.as_ref()) || !auto_update_on(host.as_ref()) {
            return;
        }
        if host.backfill_running() {
            return;
        }
        let info = self.check(host.as_ref()).await;
        let Some(asset_url) = info.asset_url.clone().filter(|_| info.has_update) else {
            return;
        };
        // The window may have come back while the request was out
        if window_in_use(host.as_ref()) || host.match_underway().await {
            return;
        }
        let latest = info.latest.clone().unwrap_or_default();
        host.log(
            Level::Info,
            &format!("Installing update {latest} in the background"),
        );
        self.run_install(host, info, &asset_url, "Background update failed:")
            .await;
    }

    /// `startBackgroundUpdates`: every 45 minutes, and 2 minutes after the
    /// window was last put away. Each run is its own task, as each timer
    /// callback is in Electron.
    pub async fn run_background(
        self: Arc<Self>,
        host: Arc<dyn Host>,
        mut put_away: mpsc::UnboundedReceiver<()>,
    ) {
        // setInterval's first run is one period out, not at once
        let mut interval =
            tokio::time::interval_at(Instant::now() + BACKGROUND_CHECK, BACKGROUND_CHECK);
        interval.set_missed_tick_behavior(MissedTickBehavior::Delay);
        let mut settle: Option<std::pin::Pin<Box<tokio::time::Sleep>>> = None;
        let mut away_open = true;
        loop {
            let settled = async {
                match settle.as_mut() {
                    Some(timer) => timer.as_mut().await,
                    None => std::future::pending().await,
                }
            };
            tokio::select! {
                _ = interval.tick() => {}
                () = settled => settle = None,
                away = put_away.recv(), if away_open => {
                    match away {
                        Some(()) => settle = Some(Box::pin(sleep(AWAY_SETTLE))),
                        None => away_open = false,
                    }
                    continue;
                }
            }
            let (updater, host) = (self.clone(), host.clone());
            tokio::spawn(async move { updater.install_in_background(host).await });
        }
    }

    /// `recordLaunchVersion`'s in-memory half: set once at startup.
    pub fn set_updated_from(&self, from: Option<String>) {
        *self.updated_from.lock().expect("updated from") = from;
    }

    /// `getUpdateNotes`, memoized for the launch, so a reload asks GitHub once.
    pub async fn update_notes(&self, host: &dyn Host) -> Option<UpdateNotes> {
        self.notes
            .get_or_init(|| async {
                let from = self.updated_from.lock().expect("updated from").clone()?;
                if host.setting("show_release_notes").as_deref() == Some("false") {
                    return None;
                }
                let to = host.current_version();
                let page = host.fetch_page().await.ok().flatten().map(Page::from_body);
                Some(release_notes_between(page.as_ref(), &from, &to))
            })
            .await
            .clone()
    }
}

/// The streaming half of `install`: the stall timer covers the request and
/// each chunk, every chunk is hashed and written, and the size and digest are
/// checked at the end.
async fn fetch_to_file(
    host: &dyn Host,
    url: &str,
    file: &Path,
    expected: Option<String>,
) -> Result<(), String> {
    use std::io::Write;
    let stalled = |_| STALLED.to_owned();
    let mut download = timeout(DOWNLOAD_STALL_TIMEOUT, host.open_download(url))
        .await
        .map_err(stalled)?
        .map_err(|_| format!("Download failed: {FETCH_FAILED}"))?;
    if !(200..300).contains(&download.status) {
        return Err(format!("Download failed (HTTP {})", download.status));
    }
    let total = download.content_length.unwrap_or(0);
    let mut out = std::fs::File::create(file).map_err(|err| format!("Download failed: {err}"))?;
    let mut hash = ring::digest::Context::new(&ring::digest::SHA256);
    let mut received: u64 = 0;
    loop {
        let chunk = timeout(DOWNLOAD_STALL_TIMEOUT, download.body.next_chunk())
            .await
            .map_err(stalled)?
            .map_err(|_| format!("Download failed: {FETCH_FAILED}"))?;
        let Some(chunk) = chunk else { break };
        received += chunk.len() as u64;
        hash.update(&chunk);
        out.write_all(&chunk)
            .map_err(|err| format!("Download failed: {err}"))?;
        if total > 0 {
            let percent = (received as f64 / total as f64 * 100.0).round() as i64;
            host.emit(UpdateEvent::Progress(percent));
        }
    }
    out.flush()
        .and_then(|()| out.sync_all())
        .map_err(|err| format!("Download failed: {err}"))?;
    if total > 0 && received != total {
        return Err(INCOMPLETE.into());
    }
    // A release from before GitHub reported digests has nothing to check
    match expected {
        Some(expected) => {
            let actual = hex(hash.finish().as_ref());
            if actual != expected {
                host.log(
                    Level::Error,
                    &format!("Update hash mismatch: expected {expected}, got {actual}"),
                );
                return Err(INTEGRITY.into());
            }
        }
        None => host.log(
            Level::Warn,
            "Release asset has no digest; skipping hash verification",
        ),
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// The swap

pub const WINDOWS_EXE_NAME: &str = crate::install_location::WINDOWS_EXE_NAME;

/// `applyWindowsUpdate`'s `update.cmd`. It stages the new exe beside the old
/// one, waits for the old one to unlock by deleting it until it is gone, moves
/// the new one into place under the release's name, and relaunches. 1.2.1
/// trusts the `move`, so one that fails after the delete leaves no exe. This
/// one keeps a copy of the old exe until the move succeeds, and puts it back
/// and starts it when the move fails.
pub fn windows_swap_script(
    current_exe: &str,
    new_exe: &str,
    tmp_dir: &str,
    relaunch_hidden: bool,
) -> String {
    let relaunch = if relaunch_hidden {
        format!(" {HIDDEN_FLAG}")
    } else {
        String::new()
    };
    let (current, new, tmp) = (current_exe, new_exe, tmp_dir);
    let target = windows_target(current_exe);
    let staged = format!("{target}.new");
    let backup = format!("{current}.old");
    [
        "@echo off".to_owned(),
        format!(r#"copy /y "{new}" "{staged}" >nul 2>&1"#),
        "if errorlevel 1 goto fail".to_owned(),
        format!(r#"copy /y "{current}" "{backup}" >nul 2>&1"#),
        "if errorlevel 1 goto fail".to_owned(),
        "set tries=0".to_owned(),
        ":wait".to_owned(),
        "set /a tries+=1".to_owned(),
        "if %tries% gtr 120 goto fail".to_owned(),
        "ping -n 2 127.0.0.1 >nul".to_owned(),
        format!(r#"del /f "{current}" >nul 2>&1"#),
        format!(r#"if exist "{current}" goto wait"#),
        format!(r#"move /y "{staged}" "{target}" >nul 2>&1"#),
        "if errorlevel 1 goto restore".to_owned(),
        format!(r#"del /f "{backup}" >nul 2>&1"#),
        format!(r#"start "" "{target}"{relaunch}"#),
        "goto cleanup".to_owned(),
        ":restore".to_owned(),
        format!(r#"move /y "{backup}" "{current}" >nul 2>&1"#),
        ":fail".to_owned(),
        format!(r#"del /f "{staged}" >nul 2>&1"#),
        // A failed restore leaves the copy as the only old exe
        format!(r#"if exist "{current}" del /f "{backup}" >nul 2>&1"#),
        format!(r#"start "" "{current}"{relaunch}"#),
        ":cleanup".to_owned(),
        format!(r#"rd /s /q "{tmp}""#),
        String::new(),
    ]
    .join("\r\n")
}

/// `path.join(path.dirname(currentExe), WINDOWS_EXE_NAME)` with win32 paths:
/// installed under the artifact name whatever the current file is called.
fn windows_target(current_exe: &str) -> String {
    match current_exe.rfind(['\\', '/']) {
        Some(0) => format!("\\{WINDOWS_EXE_NAME}"),
        Some(slash) => format!("{}\\{WINDOWS_EXE_NAME}", &current_exe[..slash]),
        None => format!(".\\{WINDOWS_EXE_NAME}"),
    }
}

/// `applyMacUpdate`: unpacked beside the installed bundle, so the swap is a
/// rename within one folder, with `ditto`, which keeps the bundle's symlinks,
/// permissions, and signature.
pub fn apply_mac_update(
    bundle: &Path,
    zip: &Path,
    tmp_dir: &Path,
    relaunch_hidden: bool,
) -> Result<(), String> {
    use crate::mac_update_script::{MacSwap, mac_join, mac_parent, mac_swap_script};
    let name = bundle
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let bundle_text = bundle.to_string_lossy().into_owned();
    let parent = mac_parent(&bundle_text);
    let staging = mac_join(parent, &format!(".{name}.update"));
    let prepared = match std::fs::remove_dir_all(&staging) {
        Err(err) if err.kind() != std::io::ErrorKind::NotFound => Err(err),
        _ => std::fs::create_dir(&staging),
    };
    if let Err(err) = prepared {
        return Err(format!(
            "Can't write next to {name}: {err}. Download it manually instead."
        ));
    }
    let unpacked = std::process::Command::new("/usr/bin/ditto")
        .arg("-x")
        .arg("-k")
        .arg(zip)
        .arg(&staging)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|status| status.success());
    let staged = std::fs::read_dir(&staging).ok().and_then(|entries| {
        entries
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .find(|name| name.ends_with(".app"))
    });
    let (true, Some(staged)) = (unpacked, staged) else {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(UNPACK_FAILED.into());
    };
    let script = tmp_dir.join("update.sh");
    let swap = MacSwap {
        pid: std::process::id(),
        staged_bundle: mac_join(&staging, &staged),
        backup: mac_join(parent, &format!(".{name}.update.old")),
        bundle: bundle_text,
        staging_dir: staging,
        tmp_dir: tmp_dir.to_string_lossy().into_owned(),
        relaunch_args: if relaunch_hidden {
            vec![HIDDEN_FLAG.to_owned()]
        } else {
            Vec::new()
        },
    };
    std::fs::write(&script, mac_swap_script(&swap)).map_err(|err| err.to_string())?;
    spawn_detached(std::process::Command::new("/bin/sh").arg(&script))
}

pub fn apply_windows_update(
    current_exe: &Path,
    new_exe: &Path,
    tmp_dir: &Path,
    relaunch_hidden: bool,
) -> Result<(), String> {
    let script = tmp_dir.join("update.cmd");
    std::fs::write(
        &script,
        windows_swap_script(
            &current_exe.to_string_lossy(),
            &new_exe.to_string_lossy(),
            &tmp_dir.to_string_lossy(),
            relaunch_hidden,
        ),
    )
    .map_err(|err| err.to_string())?;
    spawn_detached(std::process::Command::new("cmd.exe").arg("/c").arg(&script))
}

/// Node's `spawn(..., { detached: true, stdio: "ignore" })`, which outlives
/// the app: a new session on Unix. On Windows the script gets a console with
/// no window, which `ping`, `copy`, and `move` inherit, in place of libuv's
/// hidden console window, which `std::process` cannot ask for.
fn spawn_detached(command: &mut std::process::Command) -> Result<(), String> {
    use std::process::Stdio;
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // SAFETY: setsid is async-signal-safe and touches no memory
        unsafe {
            command.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
    }
    command.spawn().map(drop).map_err(|err| err.to_string())
}

// ---------------------------------------------------------------------------
// GitHub

/// Where GitHub requests go: the real hosts, nowhere (golden replay, which
/// recorded Electron with the network blocked), or in parity builds a lane's
/// fake on loopback. A parity build with no fake reaches no host, as
/// Electron's seam blocks them.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Route {
    #[cfg(not(feature = "parity-driver"))]
    Public,
    Blocked,
    #[cfg(feature = "parity-driver")]
    Parity(String),
}

/// The parity fake's base URL, read only by parity builds.
#[cfg(feature = "parity-driver")]
pub const PARITY_GITHUB_ENV: &str = "BMT_PARITY_GITHUB";

pub struct Github {
    route: Route,
    client: reqwest::Client,
}

impl Github {
    /// What the app runs: the real GitHub, or in a parity build the fake
    /// `BMT_PARITY_GITHUB` names, which must be on loopback.
    pub fn from_env() -> Self {
        #[cfg(feature = "parity-driver")]
        let route = match std::env::var(PARITY_GITHUB_ENV) {
            Ok(base) if is_loopback(&base) => Route::Parity(base.trim_end_matches('/').to_owned()),
            _ => Route::Blocked,
        };
        #[cfg(not(feature = "parity-driver"))]
        let route = Route::Public;
        Self::with_route(route)
    }

    pub fn blocked() -> Self {
        Self::with_route(Route::Blocked)
    }

    fn with_route(route: Route) -> Self {
        let mut builder = reqwest::Client::builder()
            .http1_only()
            .user_agent(USER_AGENT);
        if let Ok(tls) = crate::assets::public_tls_config() {
            builder = builder.tls_backend_preconfigured(tls);
        }
        #[cfg(feature = "parity-driver")]
        if matches!(route, Route::Parity(_)) {
            builder = builder.no_proxy();
        }
        Self {
            route,
            client: builder.build().unwrap_or_default(),
        }
    }

    /// The URL actually requested. Checks such as the download prefix run on
    /// the github.com URL before this.
    fn resolve(&self, url: &str) -> Result<String, String> {
        match &self.route {
            #[cfg(not(feature = "parity-driver"))]
            Route::Public => Ok(url.to_owned()),
            Route::Blocked => Err(format!("blocked network: {url}")),
            #[cfg(feature = "parity-driver")]
            Route::Parity(base) => url
                .strip_prefix("https://")
                .map(|rest| format!("{base}/{rest}"))
                .ok_or_else(|| format!("parity blocked network: {url}")),
        }
    }

    /// `fetchReleasePage`'s request: 10 s for the whole of it, body included.
    pub async fn fetch_page(&self) -> Result<Option<Value>, String> {
        let url = self.resolve(RELEASES_URL)?;
        let request = async {
            let response = self
                .client
                .get(url)
                .send()
                .await
                .map_err(|e| e.to_string())?;
            if !response.status().is_success() {
                return Ok(None);
            }
            let body = response.bytes().await.map_err(|e| e.to_string())?;
            serde_json::from_slice(&body)
                .map(Some)
                .map_err(|e| e.to_string())
        };
        timeout(CHECK_TIMEOUT, request)
            .await
            .unwrap_or_else(|_| Err("timed out".into()))
    }

    /// The asset request, which follows GitHub's redirect to its objects host.
    pub async fn open_download(&self, url: &str) -> Result<Download, String> {
        let url = self.resolve(url)?;
        let response = self
            .client
            .get(url)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        Ok(Download {
            status: response.status().as_u16(),
            content_length: response.content_length(),
            body: Box::new(ResponseChunks(response)),
        })
    }
}

#[cfg(feature = "parity-driver")]
fn is_loopback(base: &str) -> bool {
    ["http://127.0.0.1:", "http://localhost:", "http://[::1]:"]
        .iter()
        .any(|prefix| base.starts_with(prefix))
}

struct ResponseChunks(reqwest::Response);

impl Chunks for ResponseChunks {
    fn next_chunk(&mut self) -> BoxFuture<'_, Result<Option<Vec<u8>>, String>> {
        Box::pin(async move {
            self.0
                .chunk()
                .await
                .map(|chunk| chunk.map(|c| c.to_vec()))
                .map_err(|e| e.to_string())
        })
    }
}

// ---------------------------------------------------------------------------
// The app's host

/// What the app manages: the updater, its GitHub, and the channel the window
/// reports being put away on, until the schedule takes it.
pub struct State {
    pub updater: Arc<Updater>,
    pub github: Arc<Github>,
    put_away: Mutex<Option<mpsc::UnboundedReceiver<()>>>,
    put_away_tx: mpsc::UnboundedSender<()>,
}

impl State {
    pub fn new(github: Github) -> Self {
        let (tx, rx) = mpsc::unbounded_channel();
        Self {
            updater: Arc::new(Updater::new()),
            github: Arc::new(github),
            put_away: Mutex::new(Some(rx)),
            put_away_tx: tx,
        }
    }
}

pub struct AppHost<R: tauri::Runtime> {
    app: tauri::AppHandle<R>,
    github: Arc<Github>,
}

impl<R: tauri::Runtime> AppHost<R> {
    pub fn of(app: &tauri::AppHandle<R>) -> Arc<dyn Host> {
        use tauri::Manager;
        Arc::new(Self {
            app: app.clone(),
            github: app.state::<State>().github.clone(),
        })
    }

    fn window(&self) -> Option<tauri::WebviewWindow<R>> {
        use tauri::Manager;
        self.app.get_webview_window(crate::WINDOW_LABEL)
    }
}

/// Where this run would swap itself in. A parity build refuses a bundle in
/// an Applications folder, so no lane can replace an installed app.
fn install_target() -> Option<InstallTarget> {
    use crate::install_location::{mac_app_bundle, portable_exe};
    let target = if let Some(bundle) = mac_app_bundle() {
        InstallTarget::MacBundle(bundle)
    } else {
        InstallTarget::WindowsExe(portable_exe()?)
    };
    #[cfg(feature = "parity-driver")]
    if let InstallTarget::MacBundle(bundle) = &target {
        let home_apps = dirs::home_dir().map(|home| home.join("Applications"));
        let installed = bundle.starts_with("/Applications")
            || home_apps.is_some_and(|apps| bundle.starts_with(apps));
        if installed {
            crate::log::error(format!(
                "parity build refuses to update {}",
                bundle.display()
            ));
            return None;
        }
    }
    Some(target)
}

impl<R: tauri::Runtime> Host for AppHost<R> {
    fn platform(&self) -> Platform {
        Platform::current()
    }

    fn current_version(&self) -> String {
        crate::app_version().to_owned()
    }

    fn fetch_page(&self) -> BoxFuture<'_, Result<Option<Value>, String>> {
        Box::pin(self.github.fetch_page())
    }

    fn open_download<'a>(&'a self, url: &'a str) -> BoxFuture<'a, Result<Download, String>> {
        Box::pin(self.github.open_download(url))
    }

    fn setting(&self, key: &str) -> Option<String> {
        use tauri::Manager;
        let database = self.app.try_state::<crate::db::Database>()?;
        database
            .with(|conn| crate::db::settings::get_setting(conn, key))
            .ok()
            .and_then(|cell| cell.as_str().map(str::to_owned))
    }

    fn install_target(&self) -> Option<InstallTarget> {
        install_target()
    }

    fn window_visible(&self) -> bool {
        self.window()
            .is_some_and(|w| w.is_visible().unwrap_or(false))
    }

    fn window_minimized(&self) -> bool {
        self.window()
            .is_some_and(|w| w.is_minimized().unwrap_or(false))
    }

    fn match_underway(&self) -> BoxFuture<'_, bool> {
        use tauri::Manager;
        Box::pin(async move {
            let Some(sync) = self.app.try_state::<crate::lcu::sync::LcuSync>() else {
                return false;
            };
            let lcu = sync.lcu.clone();
            let game = crate::live::HttpGameApi::new(crate::live::GameApiTarget::from_env());
            let (client, game) = futures_util::future::join(
                crate::live::is_match_underway(&lcu),
                crate::live::is_game_running(&game),
            )
            .await;
            client || game
        })
    }

    fn backfill_running(&self) -> bool {
        use tauri::Manager;
        self.app
            .try_state::<crate::lcu::sync::LcuSync>()
            .is_some_and(|sync| sync.sync.is_backfill_running())
    }

    fn emit(&self, event: UpdateEvent) {
        match event {
            UpdateEvent::Progress(percent) => crate::events::update_progress(&self.app, &percent),
            UpdateEvent::Installing(info) => crate::events::update_installing(&self.app, &info),
            UpdateEvent::InstallFailed(error) => {
                crate::events::update_install_failed(&self.app, &error)
            }
        }
    }

    fn log(&self, level: Level, line: &str) {
        match level {
            Level::Info => crate::log::info(line),
            Level::Warn => crate::log::warn(line),
            Level::Error => crate::log::error(line),
        }
    }

    fn temp_dir(&self) -> PathBuf {
        std::env::temp_dir()
    }

    fn apply(
        &self,
        target: &InstallTarget,
        download: &Path,
        tmp_dir: &Path,
        relaunch_hidden: bool,
    ) -> Result<(), String> {
        match target {
            InstallTarget::MacBundle(bundle) => {
                apply_mac_update(bundle, download, tmp_dir, relaunch_hidden)
            }
            InstallTarget::WindowsExe(exe) => {
                apply_windows_update(exe, download, tmp_dir, relaunch_hidden)
            }
        }
    }

    fn quit(&self) {
        crate::shell::request_quit(&self.app);
    }
}

/// `recordLaunchVersion`, right after the database opens.
pub fn record_launch_version<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use tauri::Manager;
    let Some(database) = app.try_state::<crate::db::Database>() else {
        return;
    };
    let current = crate::app_version();
    let recorded = database.with(|conn| {
        let previous = crate::db::settings::get_setting(conn, "last_run_version")?;
        let (updated_from, write) = launch_version_change(previous.as_str(), current);
        if write {
            crate::db::settings::set_setting(conn, "last_run_version", current)?;
        }
        Ok(updated_from)
    });
    match recorded {
        Ok(from) => app.state::<State>().updater.set_updated_from(from),
        Err(err) => crate::log::error(format!(
            "Failed to record the launch version: {}",
            err.message
        )),
    }
}

/// Last in startup, as in `index.ts`: the launch install, then the
/// background schedule, which hears each hide-to-tray and minimize.
pub fn start<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use tauri::Manager;
    let state = app.state::<State>();
    let host = AppHost::of(app);
    let updater = state.updater.clone();
    {
        let host = host.clone();
        let updater = updater.clone();
        tauri::async_runtime::spawn(async move { updater.install_on_launch(host).await });
    }
    let Some(put_away) = state.put_away.lock().expect("put away").take() else {
        return;
    };
    let tx = state.put_away_tx.clone();
    app.state::<crate::shell::Shell>().on_put_away(move || {
        let _ = tx.send(());
    });
    tauri::async_runtime::spawn(updater.run_background(host, put_away));
}

#[cfg(test)]
mod tests {
    use std::collections::{HashMap, VecDeque};
    use std::sync::atomic::AtomicUsize;

    use serde_json::json;

    use super::*;

    const MAC: Platform = Platform {
        os: Os::Mac,
        arch: "arm64",
    };
    const MAC_INTEL: Platform = Platform {
        os: Os::Mac,
        arch: "x64",
    };
    const WINDOWS: Platform = Platform {
        os: Os::Windows,
        arch: "x64",
    };

    fn asset_url(tag: &str, name: &str) -> String {
        format!("{DOWNLOAD_PREFIX}releases/download/v{tag}/{name}")
    }

    fn release(tag: &str) -> Value {
        let assets: Vec<Value> = [
            "BetterMayhemTracker.exe",
            "BetterMayhemTracker-mac-arm64.zip",
            "BetterMayhemTracker-mac-x64.zip",
            "BetterMayhemTracker-mac-arm64.dmg",
        ]
        .iter()
        .map(|name| {
            json!({
                "name": name,
                "size": 4_200_000,
                "digest": format!("sha256:{}", "ab".repeat(32)),
                "browser_download_url": asset_url(tag, name),
            })
        })
        .collect();
        json!({
            "tag_name": format!("v{tag}"),
            "draft": false,
            "prerelease": false,
            "published_at": "2026-11-20T00:00:00.000Z",
            "html_url": format!("{RELEASE_TAG_URL}{tag}"),
            "body": format!("Notes for {tag}\r\n\r\n**Full Changelog**: https://x/compare"),
            "assets": assets,
        })
    }

    fn page(tags: &[&str]) -> Page {
        Page::from_body(Value::Array(tags.iter().map(|t| release(t)).collect()))
    }

    #[test]
    fn versions_compare_as_numeric_triples() {
        use CmpOrdering::*;
        assert_eq!(compare_versions("1.10.0", "1.9.9"), Greater);
        assert_eq!(compare_versions("v1.2.1", "1.2.1"), Equal);
        assert_eq!(compare_versions(" v1.3.0\n", "1.2.1"), Greater);
        assert_eq!(compare_versions("1.2.1-rc.1", "1.2.1"), Equal);
        assert_eq!(
            compare_versions("1.2", "1.2.1"),
            Less,
            "unparseable sorts older"
        );
        assert_eq!(compare_versions("1.2.1", "nightly"), Greater);
        assert_eq!(compare_versions("x", "y"), Equal);
        assert_eq!(compare_versions("vv1.2.3", "0.0.1"), Less, "one v only");
        assert_eq!(
            compare_versions("１.2.3", "0.0.1"),
            Less,
            "ASCII digits only"
        );
        assert_eq!(
            parse_version("99999999999999999999999.0.0").map(|v| v[0] > 1e22),
            Some(true)
        );
    }

    #[test]
    fn the_install_asset_is_the_zip_for_this_arch_or_the_first_exe() {
        let name = |n: &str| Some(json!(n));
        assert!(is_install_asset(
            name("BetterMayhemTracker-mac-arm64.zip").as_ref(),
            MAC
        ));
        assert!(!is_install_asset(
            name("BetterMayhemTracker-mac-x64.zip").as_ref(),
            MAC
        ));
        assert!(is_install_asset(
            name("BetterMayhemTracker-mac-x64.zip").as_ref(),
            MAC_INTEL
        ));
        assert!(!is_install_asset(
            name("BetterMayhemTracker-mac-arm64.dmg").as_ref(),
            MAC
        ));
        assert!(is_install_asset(name("Anything.exe").as_ref(), WINDOWS));
        assert!(
            !is_install_asset(name("Anything.EXE").as_ref(), WINDOWS),
            "case-sensitive"
        );
        assert!(!is_install_asset(Some(&json!(3)), WINDOWS));
        assert!(!is_install_asset(None, WINDOWS));
        assert_eq!(node_arch("aarch64"), "arm64");
        assert_eq!(node_arch("x86_64"), "x64");
        let (info, _) = evaluate(&page(&["1.3.0"]), "1.2.1", WINDOWS).expect("evaluates");
        assert_eq!(
            info.asset_url.as_deref(),
            Some(&*asset_url("1.3.0", "BetterMayhemTracker.exe"))
        );
    }

    #[test]
    fn digests_parse_only_as_sha256_hex() {
        let hex64 = "AB".repeat(32);
        assert_eq!(
            parse_digest(Some(&json!(format!("sha256:{hex64}")))),
            Some(hex64.to_lowercase())
        );
        assert_eq!(
            parse_digest(Some(&json!(format!("SHA256:{hex64}")))),
            Some(hex64.to_lowercase())
        );
        assert_eq!(parse_digest(Some(&json!("sha256:abc"))), None);
        assert_eq!(parse_digest(Some(&json!(format!("sha512:{hex64}")))), None);
        assert_eq!(parse_digest(Some(&json!(1))), None);
        assert_eq!(parse_digest(None), None);
    }

    #[test]
    fn an_update_lists_every_missed_release_and_caches_the_asset() {
        let (info, cached) = evaluate(&page(&["1.4.0", "1.3.0", "1.2.1", "1.2.0"]), "1.2.1", MAC)
            .expect("evaluates");
        assert!(info.has_update);
        assert_eq!(info.latest.as_deref(), Some("1.4.0"));
        assert_eq!(info.current.as_deref(), Some("1.2.1"));
        assert_eq!(info.asset_size, Some(4_200_000));
        let versions: Vec<_> = info
            .releases
            .as_ref()
            .unwrap()
            .iter()
            .map(|r| r.version.clone())
            .collect();
        assert_eq!(versions, ["1.4.0", "1.3.0"]);
        assert_eq!(info.releases.as_ref().unwrap()[0].body, "Notes for 1.4.0");
        assert_eq!(info.more_versions, Some(false));
        assert_eq!(
            cached,
            Some(CachedAsset {
                asset_url: asset_url("1.4.0", "BetterMayhemTracker-mac-arm64.zip"),
                sha256: Some("ab".repeat(32)),
            })
        );
        let json = serde_json::to_value(&info).expect("serializes");
        let keys: Vec<_> = json.as_object().unwrap().keys().cloned().collect();
        assert_eq!(
            keys,
            [
                "hasUpdate",
                "latest",
                "current",
                "url",
                "assetUrl",
                "assetSize",
                "releases",
                "moreVersions"
            ]
        );
    }

    #[test]
    fn drafts_prereleases_and_tagless_entries_are_never_offered() {
        let mut body = vec![
            json!({"tag_name": "v9.0.0", "draft": true}),
            json!({"tag_name": "v8.0.0", "prerelease": true}),
            json!({"tag_name": 7}),
            json!(null),
        ];
        body.push(release("1.2.1"));
        let page = Page::from_body(Value::Array(body));
        assert_eq!(page.published.len(), 1);
        let (info, _) = evaluate(&page, "1.2.1", MAC).expect("evaluates");
        assert!(!info.has_update);
        assert_eq!(info.releases, Some(vec![]));
        assert_eq!(
            Page::from_body(json!({"message": "rate limited"}))
                .published
                .len(),
            0
        );
    }

    #[test]
    fn a_release_with_nothing_for_this_platform() {
        let mut bare = release("1.3.0");
        bare["assets"] = json!([]);
        let page = Page::from_body(json!([bare, release("1.2.1")]));
        let (mac, cached) = evaluate(&page, "1.2.1", MAC).expect("evaluates");
        assert!(!mac.has_update, "macOS needs its zip");
        assert_eq!(cached, None);
        let (win, _) = evaluate(&page, "1.2.1", WINDOWS).expect("evaluates");
        assert!(win.has_update, "Windows still shows the badge");
        assert_eq!(win.asset_url, None);
        bare["assets"] = json!({"not": "an array"});
        assert!(evaluate(&Page::from_body(json!([bare])), "1.2.1", MAC).is_err());
    }

    #[test]
    fn more_versions_only_when_a_full_page_never_reached_current() {
        let tags: Vec<String> = (0..20).map(|i| format!("1.{}.0", 40 - i)).collect();
        let tags: Vec<&str> = tags.iter().map(String::as_str).collect();
        let (full, _) = evaluate(&page(&tags), "1.2.1", MAC).expect("evaluates");
        assert_eq!(full.more_versions, Some(true));
        let (short, _) = evaluate(&page(&tags[..19]), "1.2.1", MAC).expect("evaluates");
        assert_eq!(short.more_versions, Some(false));
        let (none, _) = evaluate(&page(&tags), "9.0.0", MAC).expect("evaluates");
        assert_eq!(none.more_versions, Some(false));
    }

    #[test]
    fn release_notes_are_cleaned_and_capped_as_electron_does() {
        let long = "é".repeat(4_100);
        let note = to_release_note(&json!({"tag_name": "v1.3.0", "body": long}));
        assert_eq!(note.body.chars().count(), 4_001);
        assert!(note.body.ends_with('…'));
        assert_eq!(note.published_at, "");
        assert_eq!(note.url, "");
        let emoji = "😀".repeat(2_001);
        assert_eq!(
            to_release_note(&json!({"tag_name": "1", "body": emoji})).body,
            format!("{}…", "😀".repeat(2_000))
        );
        let note = to_release_note(&json!({
            "tag_name": "v1.3.0",
            "body": "\u{feff}  - one\r\n  **full changelog**: x\r\n- two  ",
        }));
        assert_eq!(note.body, "- one\n\n- two");
        assert_eq!(
            to_release_note(&json!({"tag_name": "v1", "body": null})).body,
            ""
        );
    }

    #[test]
    fn whats_new_takes_the_releases_after_from_up_to_to() {
        let notes = release_notes_between(
            Some(&page(&["1.4.0", "1.3.1", "1.3.0", "1.2.1"])),
            "1.2.1",
            "1.3.1",
        );
        let versions: Vec<_> = notes.releases.iter().map(|r| r.version.as_str()).collect();
        assert_eq!(versions, ["1.3.1", "1.3.0"]);
        assert_eq!(
            notes.url,
            "https://github.com/rambo0247/better-mayhem-tracker/releases/tag/v1.3.1"
        );
        assert_eq!(
            release_notes_between(None, "1.2.1", "1.3.0").releases,
            vec![]
        );
    }

    #[test]
    fn a_launch_on_a_newer_version_counts_as_an_update() {
        assert_eq!(
            launch_version_change(Some("1.2.1"), "1.3.0"),
            (Some("1.2.1".into()), true)
        );
        assert_eq!(launch_version_change(Some("1.3.0"), "1.3.0"), (None, false));
        assert_eq!(launch_version_change(Some("1.4.0"), "1.3.0"), (None, true));
        assert_eq!(launch_version_change(None, "1.3.0"), (None, true));
        assert_eq!(launch_version_change(Some(""), "1.3.0"), (None, true));
    }

    /// The few `cmd.exe` commands `update.cmd` uses, over a folder of named
    /// files: a delete of a running exe fails, a copy reads it anyway, and
    /// `del` leaves the errorlevel as it was.
    struct Cmd {
        files: std::collections::BTreeMap<String, &'static str>,
        /// How many more deletes of each path fail, as while the app runs
        running: HashMap<String, u32>,
        /// A file `move` can't take, as one a virus scanner holds open
        held: Option<String>,
        started: Vec<String>,
        errorlevel: i32,
        tries: i64,
    }

    impl Cmd {
        fn new(files: &[(&str, &'static str)]) -> Self {
            Self {
                files: files.iter().map(|(p, c)| (p.to_string(), *c)).collect(),
                running: HashMap::new(),
                held: None,
                started: Vec::new(),
                errorlevel: 0,
                tries: 0,
            }
        }

        fn words(line: &str) -> Vec<String> {
            let mut words = Vec::new();
            let mut word: Option<String> = None;
            let mut quoted = false;
            for c in line.chars() {
                match c {
                    '"' => {
                        quoted = !quoted;
                        word.get_or_insert_with(String::new);
                    }
                    ' ' if !quoted => words.extend(word.take()),
                    c => word.get_or_insert_with(String::new).push(c),
                }
            }
            words.extend(word);
            words.retain(|w| w != ">nul" && w != "2>&1");
            words
        }

        fn run(&mut self, script: &str) {
            let lines: Vec<&str> = script.split("\r\n").collect();
            let mut at = 0;
            for _ in 0..10_000 {
                let Some(line) = lines.get(at) else {
                    return;
                };
                let line = line.replace("%tries%", &self.tries.to_string());
                at += 1;
                if let Some(label) = self.exec(&Self::words(&line)) {
                    at = lines
                        .iter()
                        .position(|l| *l == format!(":{label}"))
                        .unwrap_or_else(|| panic!("no label {label}"));
                }
            }
            panic!("update.cmd never ended");
        }

        /// The label a `goto` jumps to.
        fn exec(&mut self, w: &[String]) -> Option<String> {
            let w: Vec<&str> = w.iter().map(String::as_str).collect();
            match w.as_slice() {
                [] | ["@echo", "off"] => None,
                [label] if label.starts_with(':') => None,
                ["goto", label] => Some(label.to_string()),
                ["if", "errorlevel", n, rest @ ..] => {
                    (self.errorlevel >= n.parse().unwrap()).then(|| self.exec_rest(rest))?
                }
                ["if", "exist", path, rest @ ..] => self
                    .files
                    .contains_key(*path)
                    .then(|| self.exec_rest(rest))?,
                ["if", a, "gtr", b, rest @ ..] => (a.parse::<i64>().unwrap() > b.parse().unwrap())
                    .then(|| self.exec_rest(rest))?,
                ["set", "tries=0"] => {
                    self.tries = 0;
                    None
                }
                ["set", "/a", "tries+=1"] => {
                    self.tries += 1;
                    None
                }
                ["ping", ..] => {
                    self.errorlevel = 0;
                    None
                }
                ["copy", "/y", from, to] => {
                    self.errorlevel = match self.files.get(*from) {
                        Some(content) => {
                            self.files.insert(to.to_string(), content);
                            0
                        }
                        None => 1,
                    };
                    None
                }
                ["move", "/y", from, to] => {
                    self.errorlevel = match self.files.get(*from).copied() {
                        Some(content) if self.held.as_deref() != Some(*from) => {
                            self.files.remove(*from);
                            self.files.insert(to.to_string(), content);
                            0
                        }
                        _ => 1,
                    };
                    None
                }
                ["del", "/f", path] => {
                    match self.running.get_mut(*path) {
                        Some(left) if *left > 0 => *left -= 1,
                        _ => {
                            self.files.remove(*path);
                        }
                    }
                    None
                }
                ["start", "", path, args @ ..] => {
                    let shown = std::iter::once(*path)
                        .chain(args.iter().copied())
                        .collect::<Vec<_>>()
                        .join(" ");
                    self.started.push(match self.files.contains_key(*path) {
                        true => shown,
                        false => format!("nothing at {shown}"),
                    });
                    None
                }
                ["rd", "/s", "/q", dir] => {
                    let inside = format!("{dir}\\");
                    self.files.retain(|path, _| !path.starts_with(&inside));
                    None
                }
                other => panic!("update.cmd runs {other:?}"),
            }
        }

        fn exec_rest(&mut self, rest: &[&str]) -> Option<String> {
            self.exec(&rest.iter().map(|w| w.to_string()).collect::<Vec<_>>())
        }
    }

    const CURRENT: &str = r"C:\Users\me\Apps\BMT 1.2.1.exe";
    const TARGET: &str = r"C:\Users\me\Apps\BetterMayhemTracker.exe";
    const NEW: &str = r"C:\Temp\better-mayhem-update-AbC123\better-mayhem-tracker-update.exe";
    const TMP: &str = r"C:\Temp\better-mayhem-update-AbC123";

    /// Runs `update.cmd` over the old exe and the download, the old app
    /// holding its exe for its first two deletes.
    fn swap(current: &str, setup: impl FnOnce(&mut Cmd)) -> Cmd {
        let mut cmd = Cmd::new(&[(current, "old"), (NEW, "new")]);
        cmd.running.insert(current.into(), 2);
        setup(&mut cmd);
        cmd.run(&windows_swap_script(current, NEW, TMP, true));
        cmd
    }

    fn files(cmd: &Cmd) -> Vec<(&str, &str)> {
        cmd.files.iter().map(|(p, c)| (p.as_str(), *c)).collect()
    }

    #[test]
    fn the_windows_swap_installs_the_new_exe_under_the_release_name() {
        let cmd = swap(CURRENT, |_| {});
        assert_eq!(files(&cmd), [(TARGET, "new")]);
        assert_eq!(cmd.started, [format!("{TARGET} --hidden")]);
        let cmd = swap(TARGET, |_| {});
        assert_eq!(files(&cmd), [(TARGET, "new")]);
        let mut shown = Cmd::new(&[(CURRENT, "old"), (NEW, "new")]);
        shown.run(&windows_swap_script(CURRENT, NEW, TMP, false));
        assert_eq!(shown.started, [TARGET]);
    }

    /// 1.2.1's script deletes the old exe and then trusts the move, so a
    /// failed move left no app to start.
    #[test]
    fn a_failed_move_puts_the_old_exe_back_and_starts_it() {
        for current in [CURRENT, TARGET] {
            let cmd = swap(current, |cmd| cmd.held = Some(format!("{TARGET}.new")));
            assert_eq!(files(&cmd), [(current, "old")], "{current}");
            assert_eq!(cmd.started, [format!("{current} --hidden")], "{current}");
        }
    }

    #[test]
    fn an_app_that_never_exits_or_a_missing_download_keeps_the_old_exe() {
        let cmd = swap(CURRENT, |cmd| {
            cmd.running.insert(CURRENT.into(), u32::MAX);
        });
        assert_eq!((files(&cmd), cmd.tries), (vec![(CURRENT, "old")], 121));
        assert_eq!(cmd.started, [format!("{CURRENT} --hidden")]);
        let cmd = swap(CURRENT, |cmd| {
            cmd.files.remove(NEW);
        });
        assert_eq!(files(&cmd), [(CURRENT, "old")]);
        assert_eq!(cmd.started, [format!("{CURRENT} --hidden")]);
    }

    /// The same swap under the real `cmd.exe`, with the release name held
    /// open so `move` can't replace it. The old exe is a copy of
    /// `hostname.exe`, which the relaunch runs and which exits at once.
    #[cfg(windows)]
    #[test]
    fn on_windows_a_failed_move_puts_the_old_exe_back() {
        use std::os::windows::fs::OpenOptionsExt;
        let root = std::env::temp_dir().join(format!("bmt-swap-{}", std::process::id()));
        let (apps, tmp) = (root.join("Apps"), root.join("update"));
        std::fs::create_dir_all(&apps).unwrap();
        std::fs::create_dir_all(&tmp).unwrap();
        let hostname =
            Path::new(&std::env::var("SystemRoot").unwrap()).join(r"System32\hostname.exe");
        let current = apps.join("BMT 1.2.1.exe");
        std::fs::copy(&hostname, &current).unwrap();
        let new = tmp.join("better-mayhem-tracker-update.exe");
        std::fs::write(&new, b"new").unwrap();
        let target = apps.join(WINDOWS_EXE_NAME);
        std::fs::write(&target, b"held").unwrap();
        let held = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&target)
            .unwrap();
        let script = root.join("update.cmd");
        let text = windows_swap_script(
            &current.to_string_lossy(),
            &new.to_string_lossy(),
            &tmp.to_string_lossy(),
            true,
        );
        std::fs::write(&script, text).unwrap();
        let ran = std::process::Command::new("cmd.exe")
            .arg("/c")
            .arg(&script)
            .status()
            .unwrap();
        drop(held);
        assert!(ran.success(), "{ran}");
        assert_eq!(
            std::fs::read(&current).unwrap(),
            std::fs::read(&hostname).unwrap()
        );
        assert_eq!(std::fs::read(&target).unwrap(), b"held");
        let mut left: Vec<_> = std::fs::read_dir(&apps)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        left.sort();
        assert_eq!(left, ["BMT 1.2.1.exe", WINDOWS_EXE_NAME]);
        assert!(!tmp.exists(), "temp folder removed");
    }

    // -----------------------------------------------------------------------
    // The install flow and the schedule against a fake host

    enum Step {
        Bytes(Vec<u8>),
        Fail,
        Hang,
    }

    struct FakeChunks(VecDeque<Step>);

    impl Chunks for FakeChunks {
        fn next_chunk(&mut self) -> BoxFuture<'_, Result<Option<Vec<u8>>, String>> {
            let step = self.0.pop_front();
            Box::pin(async move {
                match step {
                    None => Ok(None),
                    Some(Step::Bytes(bytes)) => Ok(Some(bytes)),
                    Some(Step::Fail) => Err("socket hang up".into()),
                    Some(Step::Hang) => std::future::pending().await,
                }
            })
        }
    }

    #[derive(Clone)]
    enum Serve {
        Ok {
            chunks: Vec<Vec<u8>>,
            length: Option<u64>,
        },
        Status(u16),
        HangHeaders,
        HangBody,
        DropBody,
    }

    struct Fake {
        platform: Platform,
        version: String,
        page: Mutex<Result<Option<Value>, String>>,
        serve: Mutex<Serve>,
        settings: Mutex<HashMap<String, String>>,
        target: Option<InstallTarget>,
        visible: AtomicBool,
        minimized: AtomicBool,
        in_match: AtomicBool,
        backfill: AtomicBool,
        match_on_download: AtomicBool,
        fetches: Mutex<Vec<Duration>>,
        downloads: AtomicUsize,
        events: Mutex<Vec<UpdateEvent>>,
        logs: Mutex<Vec<(Level, String)>>,
        applied: Mutex<Vec<(PathBuf, bool)>>,
        quits: Mutex<Vec<Duration>>,
        tmp: PathBuf,
        started: Instant,
    }

    static NEXT: AtomicUsize = AtomicUsize::new(0);

    fn payload() -> Vec<u8> {
        (0..10_000u32).map(|i| (i % 251) as u8).collect()
    }

    fn sha(bytes: &[u8]) -> String {
        hex(ring::digest::digest(&ring::digest::SHA256, bytes).as_ref())
    }

    fn mac_page(digest: Option<String>) -> Value {
        let mut newest = release("1.3.0");
        for asset in newest["assets"].as_array_mut().unwrap() {
            match &digest {
                Some(d) => asset["digest"] = json!(format!("sha256:{d}")),
                None => asset["digest"] = Value::Null,
            }
        }
        json!([newest, release("1.2.1")])
    }

    impl Fake {
        fn new() -> Arc<Self> {
            let tmp = std::env::temp_dir().join(format!(
                "bmt-updater-test-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::SeqCst)
            ));
            std::fs::create_dir_all(&tmp).unwrap();
            let bytes = payload();
            Arc::new(Self {
                platform: MAC,
                version: "1.2.1".into(),
                page: Mutex::new(Ok(Some(mac_page(Some(sha(&bytes)))))),
                serve: Mutex::new(Serve::Ok {
                    length: Some(bytes.len() as u64),
                    chunks: bytes.chunks(4_000).map(<[u8]>::to_vec).collect(),
                }),
                settings: Mutex::new(HashMap::new()),
                target: Some(InstallTarget::MacBundle(
                    "/scratch/Better Mayhem Tracker.app".into(),
                )),
                visible: AtomicBool::new(false),
                minimized: AtomicBool::new(false),
                in_match: AtomicBool::new(false),
                backfill: AtomicBool::new(false),
                match_on_download: AtomicBool::new(false),
                fetches: Mutex::new(Vec::new()),
                downloads: AtomicUsize::new(0),
                events: Mutex::new(Vec::new()),
                logs: Mutex::new(Vec::new()),
                applied: Mutex::new(Vec::new()),
                quits: Mutex::new(Vec::new()),
                tmp,
                started: Instant::now(),
            })
        }

        fn host(self: &Arc<Self>) -> Arc<dyn Host> {
            self.clone()
        }

        fn lines(&self) -> Vec<String> {
            self.logs
                .lock()
                .unwrap()
                .iter()
                .map(|(_, l)| l.clone())
                .collect()
        }

        fn leftovers(&self) -> usize {
            std::fs::read_dir(&self.tmp).unwrap().count()
        }

        fn url(&self) -> String {
            asset_url("1.3.0", "BetterMayhemTracker-mac-arm64.zip")
        }
    }

    impl Host for Fake {
        fn platform(&self) -> Platform {
            self.platform
        }
        fn current_version(&self) -> String {
            self.version.clone()
        }
        fn fetch_page(&self) -> BoxFuture<'_, Result<Option<Value>, String>> {
            self.fetches.lock().unwrap().push(self.started.elapsed());
            let page = self.page.lock().unwrap().clone();
            Box::pin(async move { page })
        }
        fn open_download<'a>(&'a self, _url: &'a str) -> BoxFuture<'a, Result<Download, String>> {
            self.downloads.fetch_add(1, Ordering::SeqCst);
            if self.match_on_download.load(Ordering::SeqCst) {
                self.in_match.store(true, Ordering::SeqCst);
            }
            let serve = self.serve.lock().unwrap().clone();
            Box::pin(async move {
                let (status, length, steps) = match serve {
                    Serve::Ok { chunks, length } => {
                        (200, length, chunks.into_iter().map(Step::Bytes).collect())
                    }
                    Serve::Status(code) => (code, None, VecDeque::new()),
                    Serve::HangHeaders => std::future::pending().await,
                    Serve::HangBody => (
                        200,
                        Some(10),
                        VecDeque::from([Step::Bytes(vec![1]), Step::Hang]),
                    ),
                    Serve::DropBody => (200, None, VecDeque::from([Step::Fail])),
                };
                Ok(Download {
                    status,
                    content_length: length,
                    body: Box::new(FakeChunks(steps)),
                })
            })
        }
        fn setting(&self, key: &str) -> Option<String> {
            self.settings.lock().unwrap().get(key).cloned()
        }
        fn install_target(&self) -> Option<InstallTarget> {
            self.target.clone()
        }
        fn window_visible(&self) -> bool {
            self.visible.load(Ordering::SeqCst)
        }
        fn window_minimized(&self) -> bool {
            self.minimized.load(Ordering::SeqCst)
        }
        fn match_underway(&self) -> BoxFuture<'_, bool> {
            let underway = self.in_match.load(Ordering::SeqCst);
            Box::pin(async move { underway })
        }
        fn backfill_running(&self) -> bool {
            self.backfill.load(Ordering::SeqCst)
        }
        fn emit(&self, event: UpdateEvent) {
            self.events.lock().unwrap().push(event);
        }
        fn log(&self, level: Level, line: &str) {
            self.logs.lock().unwrap().push((level, line.to_owned()));
        }
        fn temp_dir(&self) -> PathBuf {
            self.tmp.clone()
        }
        fn apply(
            &self,
            _: &InstallTarget,
            download: &Path,
            _: &Path,
            hidden: bool,
        ) -> Result<(), String> {
            let bytes = std::fs::read(download).map_err(|e| e.to_string())?;
            assert_eq!(
                bytes,
                payload(),
                "the verified download is what gets applied"
            );
            self.applied
                .lock()
                .unwrap()
                .push((download.to_path_buf(), hidden));
            Ok(())
        }
        fn quit(&self) {
            self.quits.lock().unwrap().push(self.started.elapsed());
        }
    }

    async fn install(fake: &Arc<Fake>, updater: &Updater) -> DownloadUpdateResult {
        updater
            .download_and_install(fake.host(), &fake.url(), false)
            .await
    }

    #[tokio::test(start_paused = true)]
    async fn a_verified_download_is_applied_then_the_app_quits_200_ms_later() {
        let fake = Fake::new();
        let updater = Updater::new();
        updater.check(fake.as_ref()).await;
        let result = install(&fake, &updater).await;
        assert_eq!(
            result,
            DownloadUpdateResult {
                success: true,
                error: None
            }
        );
        let applied = fake.applied.lock().unwrap().clone();
        assert_eq!(applied.len(), 1);
        assert!(applied[0].1, "a hidden window relaunches hidden");
        assert!(applied[0].0.ends_with("better-mayhem-tracker-update.zip"));
        let name = applied[0]
            .0
            .parent()
            .unwrap()
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        assert!(
            name.starts_with("better-mayhem-update-") && name.len() == 27,
            "{name}"
        );
        let progress: Vec<i64> = fake
            .events
            .lock()
            .unwrap()
            .iter()
            .filter_map(|e| match e {
                UpdateEvent::Progress(p) => Some(*p),
                _ => None,
            })
            .collect();
        assert_eq!(progress, [40, 80, 100]);
        assert!(fake.quits.lock().unwrap().is_empty());
        sleep(Duration::from_millis(250)).await;
        assert_eq!(
            fake.quits.lock().unwrap().clone(),
            [Duration::from_millis(200)]
        );
        assert_eq!(
            install(&fake, &updater).await.error.as_deref(),
            Some(ALREADY_INSTALLING),
            "the flag stays set once an install succeeded"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_visible_window_relaunches_visible() {
        let fake = Fake::new();
        fake.visible.store(true, Ordering::SeqCst);
        let updater = Updater::new();
        assert!(
            install(&fake, &updater).await.success,
            "an unseen URL is re-checked first"
        );
        assert_eq!(fake.fetches.lock().unwrap().len(), 1);
        assert!(!fake.applied.lock().unwrap()[0].1);
    }

    #[tokio::test(start_paused = true)]
    async fn a_wrong_digest_is_refused_and_leaves_nothing_behind() {
        let fake = Fake::new();
        *fake.page.lock().unwrap() = Ok(Some(mac_page(Some("0".repeat(64)))));
        let updater = Updater::new();
        let result = install(&fake, &updater).await;
        assert_eq!(result.error.as_deref(), Some(INTEGRITY));
        assert!(fake.applied.lock().unwrap().is_empty());
        assert_eq!(fake.leftovers(), 0, "temp folder removed");
        let expected = format!(
            "Update hash mismatch: expected {}, got {}",
            "0".repeat(64),
            sha(&payload())
        );
        assert!(
            fake.logs
                .lock()
                .unwrap()
                .contains(&(Level::Error, expected))
        );
        *fake.page.lock().unwrap() = Ok(Some(mac_page(Some(sha(&payload())))));
        updater.check(fake.as_ref()).await;
        assert!(
            install(&fake, &updater).await.success,
            "a failure clears the flag"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn no_digest_skips_the_hash_with_a_warning() {
        let fake = Fake::new();
        *fake.page.lock().unwrap() = Ok(Some(mac_page(None)));
        assert!(install(&fake, &Updater::new()).await.success);
        assert!(fake.logs.lock().unwrap().contains(&(
            Level::Warn,
            "Release asset has no digest; skipping hash verification".into()
        )));
    }

    #[tokio::test(start_paused = true)]
    async fn short_failed_and_stalled_downloads() {
        let cases = [
            (
                Serve::Ok {
                    chunks: vec![payload()[..10].to_vec()],
                    length: Some(11),
                },
                INCOMPLETE.to_owned(),
            ),
            (Serve::Status(404), "Download failed (HTTP 404)".to_owned()),
            (Serve::DropBody, format!("Download failed: {FETCH_FAILED}")),
            (Serve::HangHeaders, STALLED.to_owned()),
            (Serve::HangBody, STALLED.to_owned()),
        ];
        for (serve, error) in cases {
            let fake = Fake::new();
            *fake.serve.lock().unwrap() = serve;
            let started = Instant::now();
            let result = install(&fake, &Updater::new()).await;
            assert_eq!(result.error.as_deref(), Some(&*error));
            assert_eq!(fake.leftovers(), 0, "{error}: temp folder removed");
            if error == STALLED {
                assert_eq!(
                    started.elapsed(),
                    DOWNLOAD_STALL_TIMEOUT,
                    "stalls after 30 s"
                );
            }
        }
    }

    #[tokio::test(start_paused = true)]
    async fn the_url_and_the_install_location_are_checked_first() {
        let fake = Fake::new();
        let updater = Updater::new();
        let result = updater
            .download_and_install(fake.host(), "https://example.com/x.zip", false)
            .await;
        assert_eq!(result.error.as_deref(), Some(UNEXPECTED_URL));
        let stale = asset_url("1.2.9", "BetterMayhemTracker-mac-arm64.zip");
        let result = updater
            .download_and_install(fake.host(), &stale, false)
            .await;
        assert_eq!(result.error.as_deref(), Some(NOT_LATEST));
        assert_eq!(fake.downloads.load(Ordering::SeqCst), 0);

        let mut unpackaged = Arc::into_inner(Fake::new()).unwrap();
        unpackaged.target = None;
        let unpackaged = Arc::new(unpackaged);
        let result = updater
            .download_and_install(unpackaged.host(), &fake.url(), false)
            .await;
        assert_eq!(result.error.as_deref(), Some(NOT_DURABLE_MAC));
        let mut windows = Arc::into_inner(Fake::new()).unwrap();
        windows.target = None;
        windows.platform = WINDOWS;
        let result = updater
            .download_and_install(Arc::new(windows), &fake.url(), false)
            .await;
        assert_eq!(result.error.as_deref(), Some(NOT_DURABLE_WINDOWS));
    }

    #[tokio::test(start_paused = true)]
    async fn two_installs_at_once_run_one() {
        let fake = Fake::new();
        let updater = Updater::new();
        let (a, b) = tokio::join!(install(&fake, &updater), install(&fake, &updater));
        let errors: Vec<_> = [a, b].into_iter().filter_map(|r| r.error).collect();
        assert_eq!(errors, [ALREADY_INSTALLING]);
        assert_eq!(fake.applied.lock().unwrap().len(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn the_launch_check_retries_three_times_a_minute_apart() {
        let fake = Fake::new();
        *fake.page.lock().unwrap() = Err("offline".into());
        Updater::new().install_on_launch(fake.host()).await;
        assert_eq!(
            fake.fetches.lock().unwrap().clone(),
            [Duration::ZERO, LAUNCH_RETRY, LAUNCH_RETRY * 2]
        );
        assert_eq!(
            fake.lines(),
            ["Launch update check failed: Failed to check for updates"]
        );
        let fake = Fake::new();
        *fake.page.lock().unwrap() = Ok(None);
        Updater::new().install_on_launch(fake.host()).await;
        assert_eq!(
            fake.fetches.lock().unwrap().len(),
            3,
            "No releases found is an error too"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn the_launch_install_skips_a_match_and_installs_otherwise() {
        let fake = Fake::new();
        fake.in_match.store(true, Ordering::SeqCst);
        let updater = Updater::new();
        updater.install_on_launch(fake.host()).await;
        assert_eq!(
            fake.lines(),
            ["Update 1.3.0 available; not installing during a match"]
        );
        assert_eq!(fake.downloads.load(Ordering::SeqCst), 0);
        assert_eq!(updater.launch_install(), None);

        let fake = Fake::new();
        updater.install_on_launch(fake.host()).await;
        assert_eq!(fake.lines(), ["Installing update 1.3.0 on launch"]);
        assert!(
            matches!(fake.events.lock().unwrap()[0], UpdateEvent::Installing(ref i) if i.latest.as_deref() == Some("1.3.0"))
        );
        assert!(
            updater.launch_install().is_some(),
            "held for a window that loads late"
        );
        assert_eq!(fake.applied.lock().unwrap().len(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn a_match_that_starts_during_the_launch_download_backs_out() {
        let fake = Fake::new();
        let updater = Updater::new();
        fake.match_on_download.store(true, Ordering::SeqCst);
        updater.check(fake.as_ref()).await;
        let result = updater
            .download_and_install(fake.host(), &fake.url(), true)
            .await;
        assert_eq!(result.error.as_deref(), Some(MATCH_STARTED));
        assert_eq!(fake.leftovers(), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn launch_is_off_without_a_durable_install_or_with_auto_update_off() {
        let fake = Fake::new();
        fake.settings
            .lock()
            .unwrap()
            .insert("auto_update".into(), "false".into());
        Updater::new().install_on_launch(fake.host()).await;
        assert!(fake.fetches.lock().unwrap().is_empty());
        let mut bare = Arc::into_inner(Fake::new()).unwrap();
        bare.target = None;
        let bare = Arc::new(bare);
        Updater::new().install_on_launch(bare.host()).await;
        assert!(bare.fetches.lock().unwrap().is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn a_failed_launch_install_says_so() {
        let fake = Fake::new();
        *fake.page.lock().unwrap() = Ok(Some(mac_page(Some("0".repeat(64)))));
        let updater = Updater::new();
        updater.install_on_launch(fake.host()).await;
        assert_eq!(updater.launch_install(), None);
        assert_eq!(
            fake.events.lock().unwrap().last(),
            Some(&UpdateEvent::InstallFailed(INTEGRITY.into()))
        );
        assert!(
            fake.lines()
                .contains(&format!("Launch update failed: {INTEGRITY}"))
        );
    }

    async fn settle_tasks() {
        for _ in 0..50 {
            tokio::task::yield_now().await;
        }
    }

    #[tokio::test(start_paused = true)]
    async fn the_background_check_runs_every_45_minutes_and_not_at_launch() {
        let fake = Fake::new();
        fake.visible.store(true, Ordering::SeqCst);
        let (_tx, rx) = mpsc::unbounded_channel();
        let updater = Arc::new(Updater::new());
        tokio::spawn(updater.clone().run_background(fake.host(), rx));
        settle_tasks().await;
        sleep(BACKGROUND_CHECK - Duration::from_secs(1)).await;
        settle_tasks().await;
        assert!(
            fake.fetches.lock().unwrap().is_empty(),
            "nothing before the first period"
        );
        sleep(Duration::from_secs(2)).await;
        settle_tasks().await;
        assert!(
            fake.fetches.lock().unwrap().is_empty(),
            "a window in use is left alone"
        );
        fake.minimized.store(true, Ordering::SeqCst);
        sleep(BACKGROUND_CHECK).await;
        settle_tasks().await;
        assert_eq!(fake.fetches.lock().unwrap().clone(), [BACKGROUND_CHECK * 2]);
        assert_eq!(fake.lines(), ["Installing update 1.3.0 in the background"]);
        assert_eq!(fake.applied.lock().unwrap().len(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn putting_the_window_away_installs_two_minutes_after_the_last_time() {
        let fake = Fake::new();
        let (tx, rx) = mpsc::unbounded_channel();
        let updater = Arc::new(Updater::new());
        tokio::spawn(updater.clone().run_background(fake.host(), rx));
        settle_tasks().await;
        tx.send(()).unwrap();
        sleep(Duration::from_secs(90)).await;
        tx.send(()).unwrap();
        settle_tasks().await;
        sleep(Duration::from_secs(119)).await;
        settle_tasks().await;
        assert!(
            fake.fetches.lock().unwrap().is_empty(),
            "re-armed by the second hide"
        );
        sleep(Duration::from_secs(2)).await;
        settle_tasks().await;
        assert_eq!(
            fake.fetches.lock().unwrap().clone(),
            [Duration::from_secs(90) + AWAY_SETTLE]
        );
    }

    #[tokio::test(start_paused = true)]
    async fn the_background_install_waits_out_backfill_matches_and_a_returning_window() {
        let updater = Updater::new();
        let fake = Fake::new();
        fake.backfill.store(true, Ordering::SeqCst);
        updater.install_in_background(fake.host()).await;
        assert!(
            fake.fetches.lock().unwrap().is_empty(),
            "backfill: no check at all"
        );

        let fake = Fake::new();
        fake.in_match.store(true, Ordering::SeqCst);
        updater.install_in_background(fake.host()).await;
        assert_eq!(fake.fetches.lock().unwrap().len(), 1);
        assert_eq!(
            fake.downloads.load(Ordering::SeqCst),
            0,
            "match: checked, not installed"
        );

        let fake = Fake::new();
        fake.settings
            .lock()
            .unwrap()
            .insert("auto_update".into(), "false".into());
        updater.install_in_background(fake.host()).await;
        assert!(fake.fetches.lock().unwrap().is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn whats_new_is_fetched_once_per_launch() {
        let fake = Fake::new();
        let updater = Updater::new();
        assert_eq!(updater.update_notes(fake.as_ref()).await, None);
        assert!(fake.fetches.lock().unwrap().is_empty());

        let mut newer = Arc::into_inner(Fake::new()).unwrap();
        newer.version = "1.3.0".into();
        let newer = Arc::new(newer);
        let updater = Updater::new();
        updater.set_updated_from(Some("1.2.1".into()));
        let notes = updater.update_notes(newer.as_ref()).await.expect("notes");
        assert_eq!((notes.from.as_str(), notes.to.as_str()), ("1.2.1", "1.3.0"));
        assert_eq!(notes.releases.len(), 1);
        assert_eq!(updater.update_notes(newer.as_ref()).await, Some(notes));
        assert_eq!(newer.fetches.lock().unwrap().len(), 1);

        let updater = Updater::new();
        updater.set_updated_from(Some("1.2.1".into()));
        newer
            .settings
            .lock()
            .unwrap()
            .insert("show_release_notes".into(), "false".into());
        assert_eq!(updater.update_notes(newer.as_ref()).await, None);
    }

    #[tokio::test]
    async fn golden_replay_and_unset_parity_builds_reach_no_host() {
        let blocked = Github::blocked();
        assert!(blocked.fetch_page().await.is_err());
        assert!(
            blocked
                .open_download(&asset_url("1.3.0", "x.zip"))
                .await
                .is_err()
        );
        #[cfg(feature = "parity-driver")]
        {
            assert!(is_loopback("http://127.0.0.1:4100"));
            assert!(!is_loopback("https://api.github.com"));
            let parity = Github::with_route(Route::Parity("http://127.0.0.1:9".into()));
            assert_eq!(
                parity.resolve(RELEASES_URL).unwrap(),
                "http://127.0.0.1:9/api.github.com/repos/rambo0247/better-mayhem-tracker/releases?per_page=20"
            );
        }
    }

    #[test]
    fn mac_staging_failures_use_electrons_messages() {
        let root = std::env::temp_dir().join(format!("bmt-apply-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let bundle = root.join("Better Mayhem Tracker.app");
        std::fs::create_dir_all(&bundle).unwrap();
        let zip = root.join("not-a.zip");
        std::fs::write(&zip, b"not a zip").unwrap();
        if cfg!(target_os = "macos") {
            assert_eq!(
                apply_mac_update(&bundle, &zip, &root, false),
                Err(UNPACK_FAILED.into())
            );
            assert!(!root.join(".Better Mayhem Tracker.app.update").exists());
        }
        let missing = root.join("gone").join("X.app");
        let error = apply_mac_update(&missing, &zip, &root, false).unwrap_err();
        assert!(error.starts_with("Can't write next to X.app: "), "{error}");
        assert!(
            error.ends_with(". Download it manually instead."),
            "{error}"
        );
        std::fs::remove_dir_all(&root).unwrap();
    }
}
