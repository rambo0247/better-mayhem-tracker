//! Every piece of League art the app draws, and the game data that names it:
//! `src/main/game-assets.ts` and the URL builders in `src/shared/game-assets.ts`.
//! Sources, in order:
//!
//!   1. A copy on disk ([`AssetCache`]), filed under the patch it is from. A
//!      patch's files never change once it ships, so a copy stays good until
//!      it's pruned. "latest" is filed under the patch it currently holds.
//!   2. CommunityDragon, the only source with archived patches.
//!   3. The running client, which serves the current patch's files under
//!      /lol-game-data/assets/, including a few CommunityDragon doesn't export.
//!   4. For art only, the same file from another patch.
//!
//! Game data on "latest" asks CommunityDragon before the disk instead, because
//! Riot hotfixes it mid-patch; the disk copy is then its fallback.

use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::path::PathBuf;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, SystemTime};

use futures_util::FutureExt;
use futures_util::future::{BoxFuture, Shared};
use regex::Regex;
use rustls::{ClientConfig, RootCertStore};
use serde_json::Value;
use tauri::http::{Method, Response, Uri};
use tokio::sync::{Semaphore, broadcast};
use tokio::task::JoinHandle;
use tokio::time::Instant;

use crate::asset_cache::{AssetCache, is_patch_branch};
use crate::lcu::{Lcu, LcuStatus};

pub const ASSET_SCHEME: &str = "asset";
/// The host WebView2 serves a custom scheme under, since it routes only
/// `http://<scheme>.localhost`. The kind of URL ("game-data", "splash") is then
/// the first path segment instead of the host.
pub const WEBVIEW2_HOST: &str = "asset.localhost";

const CDRAGON: &str = "https://raw.communitydragon.org";
pub const USER_AGENT: &str = "BetterMayhemTracker/1.0";
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
/// A stats page asks for hundreds of icons at once. This many at a time still
/// keeps up with the page, without aiming the whole burst at a host that
/// throttles bursts.
const REMOTE_CONCURRENCY: usize = 8;
/// How long to stop asking CommunityDragon once it fails to answer. Otherwise
/// every icon on a page waits out its own timeout before falling back.
pub const OUTAGE_BACKOFF: Duration = Duration::from_secs(30);
/// How soon to ask again which patch "latest" holds, after failing to find out
const LATEST_RETRY: Duration = Duration::from_secs(60);
const CLIENT_PATCH_RETRY: Duration = Duration::from_secs(10);
pub const PRUNE_DELAY: Duration = Duration::from_secs(60);
pub const PRUNE_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);

/// `console.log`, until T09's logger lands.
pub(crate) fn log(message: impl AsRef<str>) {
    println!("[bmt pid={}] {}", std::process::id(), message.as_ref());
}

/// `console.error`, until T09's logger lands.
pub(crate) fn log_error(message: impl AsRef<str>) {
    eprintln!("[bmt pid={}] {}", std::process::id(), message.as_ref());
}

// ---------------------------------------------------------------------------
// The public web: Data Dragon and CommunityDragon

/// What a GET to a public host came back with.
#[derive(Debug, Clone)]
pub enum WebAnswer {
    Status(u16, Arc<[u8]>),
    /// No answer at all: refused, reset, timed out, or the body cut off
    Failed(String),
}

pub trait Web: Send + Sync + 'static {
    fn get<'a>(&'a self, url: &'a str) -> BoxFuture<'a, WebAnswer>;
}

/// The roots Data Dragon and CommunityDragon are checked against: Mozilla's
/// set from `webpki-roots`. A config of its own, so the League client's,
/// which trusts Riot's root alone (`lcu/tls.rs`), never gains these.
#[cfg_attr(feature = "parity-driver", allow(dead_code))]
pub fn public_roots() -> RootCertStore {
    let mut roots = RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    roots
}

#[cfg_attr(feature = "parity-driver", allow(dead_code))]
fn public_tls_config() -> Result<ClientConfig, rustls::Error> {
    let mut config =
        ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions()?
            .with_root_certificates(public_roots())
            .with_no_client_auth();
    // Node's fetch speaks HTTP/1.1
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(config)
}

/// `fetch(url, { headers: { "User-Agent": ... }, signal: AbortSignal.timeout(10_000) })`.
#[cfg_attr(feature = "parity-driver", allow(dead_code))]
pub struct PublicWeb(reqwest::Client);

#[cfg_attr(feature = "parity-driver", allow(dead_code))]
impl PublicWeb {
    pub fn new() -> Result<Self, String> {
        reqwest::Client::builder()
            .tls_backend_preconfigured(public_tls_config().map_err(|err| err.to_string())?)
            .http1_only()
            .user_agent(USER_AGENT)
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map(Self)
            .map_err(|err| err.to_string())
    }
}

impl Web for PublicWeb {
    fn get<'a>(&'a self, url: &'a str) -> BoxFuture<'a, WebAnswer> {
        async move {
            let response = match self.0.get(url).send().await {
                Ok(response) => response,
                Err(err) => return WebAnswer::Failed(err.to_string()),
            };
            let status = response.status().as_u16();
            match response.bytes().await {
                Ok(body) => WebAnswer::Status(status, Arc::from(&body[..])),
                Err(err) => WebAnswer::Failed(err.to_string()),
            }
        }
        .boxed()
    }
}

/// What parity builds use, so no lane reaches the real hosts, as Electron's
/// seam blocks them. With `BMT_PARITY_WEB` set to a loopback base URL, every
/// `https://<host>/<path>` is fetched as `<base>/<host>/<path>` from a fake
/// the lane runs; otherwise every request fails the way a blocked one does.
#[cfg(feature = "parity-driver")]
pub mod parity_web {
    use super::*;

    pub const BASE_ENV: &str = "BMT_PARITY_WEB";

    pub struct ParityWeb {
        base: Option<String>,
        client: reqwest::Client,
    }

    pub fn from_env() -> ParityWeb {
        let base = std::env::var(BASE_ENV)
            .ok()
            .filter(|base| is_loopback(base))
            .map(|base| base.trim_end_matches('/').to_string());
        ParityWeb {
            base,
            client: reqwest::Client::builder()
                .no_proxy()
                .user_agent(USER_AGENT)
                .timeout(REQUEST_TIMEOUT)
                .build()
                .expect("a plain HTTP client"),
        }
    }

    fn is_loopback(base: &str) -> bool {
        ["http://127.0.0.1:", "http://localhost:", "http://[::1]:"]
            .iter()
            .any(|prefix| base.starts_with(prefix))
    }

    impl Web for ParityWeb {
        fn get<'a>(&'a self, url: &'a str) -> BoxFuture<'a, WebAnswer> {
            async move {
                let (Some(base), Some(rest)) = (&self.base, url.strip_prefix("https://")) else {
                    log(format!("parity blocked network: {url}"));
                    return WebAnswer::Failed(format!("parity blocked network: {url}"));
                };
                let response = match self.client.get(format!("{base}/{rest}")).send().await {
                    Ok(response) => response,
                    Err(err) => return WebAnswer::Failed(err.to_string()),
                };
                let status = response.status().as_u16();
                match response.bytes().await {
                    Ok(body) => WebAnswer::Status(status, Arc::from(&body[..])),
                    Err(err) => WebAnswer::Failed(err.to_string()),
                }
            }
            .boxed()
        }
    }
}

/// The web the app talks to: the real hosts, or in parity builds the lane's.
pub fn app_web() -> Result<Arc<dyn Web>, String> {
    #[cfg(feature = "parity-driver")]
    return Ok(Arc::new(parity_web::from_env()));
    #[cfg(not(feature = "parity-driver"))]
    return Ok(Arc::new(PublicWeb::new()?));
}

// ---------------------------------------------------------------------------
// The running client

/// `lcuBytes`: the client's raw file at a path, or `None`.
pub trait ClientFiles: Send + Sync + 'static {
    fn bytes<'a>(&'a self, path: &'a str) -> BoxFuture<'a, Option<Vec<u8>>>;
}

impl ClientFiles for Lcu {
    fn bytes<'a>(&'a self, path: &'a str) -> BoxFuture<'a, Option<Vec<u8>>> {
        Lcu::bytes(self, path).boxed()
    }
}

/// No client to ask, until T20 builds the [`Lcu`] the app runs.
pub struct NoClient;

impl ClientFiles for NoClient {
    fn bytes<'a>(&'a self, _path: &'a str) -> BoxFuture<'a, Option<Vec<u8>>> {
        async { None }.boxed()
    }
}

// ---------------------------------------------------------------------------
// Single flight

/// Several callers asking for the same thing share one task, which always runs
/// to the end, as a promise does, and drops its entry once it settles.
pub(crate) struct Flights<V: Clone> {
    running: Mutex<HashMap<String, Shared<BoxFuture<'static, V>>>>,
}

impl<V: Clone + Send + Sync + 'static> Flights<V> {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            running: Mutex::new(HashMap::new()),
        })
    }

    pub fn join<F>(
        self: &Arc<Self>,
        key: &str,
        start: impl FnOnce() -> F,
    ) -> impl Future<Output = V>
    where
        F: Future<Output = V> + Send + 'static,
    {
        let mut running = self.running.lock().expect("flights lock");
        if let Some(flight) = running.get(key) {
            return flight.clone();
        }
        let work = start();
        let flights = Arc::clone(self);
        let owned = key.to_string();
        let task = tokio::spawn(async move {
            let value = work.await;
            flights.running.lock().expect("flights lock").remove(&owned);
            value
        });
        let flight = async move { task.await.expect("a single-flight task panicked") }
            .boxed()
            .shared();
        running.insert(key.to_string(), flight.clone());
        flight
    }
}

// ---------------------------------------------------------------------------
// Game files

/// "missing" is a source answering that it has no such file; "error" is no
/// source answering at all, which says nothing about the file.
#[derive(Debug, Clone)]
pub enum Fetched {
    Ok(Arc<[u8]>),
    Missing,
    Error,
}

impl Fetched {
    fn state(&self) -> &'static str {
        match self {
            Fetched::Ok(_) => "ok",
            Fetched::Missing => "missing",
            Fetched::Error => "error",
        }
    }
}

/// A CommunityDragon branch. Only patches are filed on disk; "latest" is filed
/// under the patch it holds, and anything else is never kept.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Branch {
    Latest,
    Pbe,
    Patch(String),
    /// A name the renderer passed that is none of the above, which Electron
    /// still asks CommunityDragon for
    Other(String),
}

impl Branch {
    pub fn parse(name: &str) -> Self {
        match name {
            "latest" => Self::Latest,
            "pbe" => Self::Pbe,
            _ if is_patch_branch(name) => Self::Patch(name.to_string()),
            _ => Self::Other(name.to_string()),
        }
    }

    pub fn name(&self) -> &str {
        match self {
            Self::Latest => "latest",
            Self::Pbe => "pbe",
            Self::Patch(name) | Self::Other(name) => name,
        }
    }
}

/// Where the running client keeps its copy.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Local {
    /// `/lol-game-data/assets/<path>`
    GameData,
    /// The base skin's `splashPath` from the champion's own data
    Splash(u64),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GameFile {
    branch: Branch,
    /// Its identity within the branch, and what its disk copy is filed under
    path: String,
    /// Where CommunityDragon serves it
    remote: String,
    local: Local,
}

impl GameFile {
    /// A path under /lol-game-data/assets/. The client serves its own data
    /// (v1/) and the game's files from that one root; CommunityDragon exports
    /// the two separately.
    pub fn game_data(branch: Branch, game_path: &str) -> Self {
        let remote = if game_path.starts_with("v1/") {
            format!(
                "{CDRAGON}/{}/plugins/rcp-be-lol-game-data/global/default/{game_path}",
                branch.name()
            )
        } else {
            format!("{CDRAGON}/{}/game/{game_path}", branch.name())
        };
        Self {
            branch,
            path: game_path.to_string(),
            remote,
            local: Local::GameData,
        }
    }

    pub fn splash(champion_id: u64) -> Self {
        Self {
            branch: Branch::Latest,
            path: format!("splash/{champion_id}.jpg"),
            // The cdn host looks up where the art is and redirects there
            remote: format!(
                "https://cdn.communitydragon.org/latest/champion/{champion_id}/splash-art/centered"
            ),
            local: Local::Splash(champion_id),
        }
    }

    /// A success that isn't the file (an error page served with a 200) must
    /// not be filed away as one: a patch's copy is never fetched again.
    fn is_well_formed(&self, bytes: &[u8]) -> bool {
        if self.path.ends_with(".json") {
            serde_json::from_slice::<Value>(bytes).is_ok()
        } else {
            image_type(bytes).is_some()
        }
    }
}

pub fn image_type(bytes: &[u8]) -> Option<&'static str> {
    if bytes.len() >= 8 && bytes.starts_with(&[0x89, 0x50, 0x4e, 0x47]) {
        Some("image/png")
    } else if bytes.len() >= 3 && bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct LoadMode {
    /// Ask CommunityDragon before reading the disk copy
    network_first: bool,
    /// Accept another patch's copy when nothing else answers
    stale: bool,
}

/// `majorMinor` in game-assets.ts: "16.23.1" is "16.23". The trailing dot is
/// required, unlike Data Dragon's version match in dragon.ts.
fn major_minor(version: &Value) -> Option<String> {
    static VERSION: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^(\d+)\.(\d+)\.").expect("a valid pattern"));
    let text = js_string(version);
    let captures = VERSION.captures(&text)?;
    Some(format!("{}.{}", &captures[1], &captures[2]))
}

/// `String(value)` for the JSON values a version arrives as.
pub(crate) fn js_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Null => "null".into(),
        other => other.to_string(),
    }
}

/// A patch that is found once and then kept, asked for again only after a
/// pause when the asking fails.
struct Remembered {
    known: Option<String>,
    pending: Option<Shared<BoxFuture<'static, Option<String>>>>,
    asked_at: Option<Instant>,
}

impl Remembered {
    const fn new() -> Self {
        Self {
            known: None,
            pending: None,
            asked_at: None,
        }
    }
}

struct Inner {
    cache: AssetCache,
    web: Arc<dyn Web>,
    client: Arc<dyn ClientFiles>,
    remote_slots: Semaphore,
    outage_until: Mutex<Option<Instant>>,
    /// The patch CommunityDragon's "latest" holds, by its own metadata rather
    /// than Riot's version list, since on patch day the two disagree for hours.
    /// Nothing from "latest" is filed away before it is known.
    latest: Mutex<Remembered>,
    /// The patch the running client is on, which is what its files are copies
    /// of. Forgotten whenever the client comes or goes, since it may have
    /// updated.
    client_patch: Mutex<Remembered>,
    /// Files a source said don't exist, for the rest of the session. The
    /// renderer steps through fallback paths on every remount, and each would
    /// otherwise ask again.
    missing: Mutex<HashSet<String>>,
    loads: Arc<Flights<Fetched>>,
    background: Mutex<Vec<JoinHandle<()>>>,
}

/// The game asset source the scheme and the game data loaders share.
#[derive(Clone)]
pub struct GameAssets(Arc<Inner>);

impl GameAssets {
    pub fn new(cache_root: PathBuf, web: Arc<dyn Web>, client: Arc<dyn ClientFiles>) -> Self {
        Self(Arc::new(Inner {
            cache: AssetCache::new(cache_root),
            web,
            client,
            remote_slots: Semaphore::new(REMOTE_CONCURRENCY),
            outage_until: Mutex::new(None),
            latest: Mutex::new(Remembered::new()),
            client_patch: Mutex::new(Remembered::new()),
            missing: Mutex::new(HashSet::new()),
            loads: Flights::new(),
            background: Mutex::new(Vec::new()),
        }))
    }

    pub fn cache(&self) -> &AssetCache {
        &self.0.cache
    }

    /// `startGameAssets`, less the scheme, which the builder registers. Asks
    /// which patch "latest" holds, so the first icon usually reads from the
    /// right one, and prunes a minute in and then daily.
    pub fn start(&self) {
        let assets = self.clone();
        tokio::spawn(async move {
            assets.confirm_latest_patch().await;
        });
        let assets = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(PRUNE_DELAY).await;
            loop {
                assets.cache().prune(SystemTime::now()).await;
                tokio::time::sleep(PRUNE_INTERVAL).await;
            }
        });
    }

    /// Forgets the client's patch whenever the client's status changes. T20
    /// calls it once it builds the app's [`Lcu`].
    #[allow(dead_code)]
    pub fn follow_client(&self, mut changes: broadcast::Receiver<LcuStatus>) {
        let assets = self.clone();
        tokio::spawn(async move {
            loop {
                match changes.recv().await {
                    Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {
                        let mut patch = assets.0.client_patch.lock().expect("client patch lock");
                        patch.known = None;
                        patch.asked_at = None;
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        });
    }

    fn spawn_background(&self, work: impl Future<Output = ()> + Send + 'static) {
        let mut background = self.0.background.lock().expect("background lock");
        background.retain(|task| !task.is_finished());
        background.push(tokio::spawn(work));
    }

    /// Waits for the copies being filed in the background.
    #[cfg(test)]
    pub async fn settle(&self) {
        loop {
            let tasks: Vec<_> = std::mem::take(&mut *self.0.background.lock().unwrap());
            if tasks.is_empty() {
                return;
            }
            for task in tasks {
                task.await.unwrap();
            }
        }
    }

    // -----------------------------------------------------------------------
    // CommunityDragon

    fn is_outage(&self) -> bool {
        self.0
            .outage_until
            .lock()
            .expect("outage lock")
            .is_some_and(|until| Instant::now() < until)
    }

    fn note_outage(&self, reason: &str) {
        let mut until = self.0.outage_until.lock().expect("outage lock");
        let now = Instant::now();
        if until.is_none_or(|until| now >= until) {
            log(format!(
                "CommunityDragon is not answering ({reason}); serving art from the client and disk"
            ));
        }
        *until = Some(now + OUTAGE_BACKOFF);
    }

    async fn fetch_remote(&self, url: &str) -> Fetched {
        if self.is_outage() {
            return Fetched::Error;
        }
        let Ok(_slot) = self.0.remote_slots.acquire().await else {
            return Fetched::Error;
        };
        // It may have gone down while this waited its turn
        if self.is_outage() {
            return Fetched::Error;
        }
        match self.0.web.get(url).await {
            WebAnswer::Status(status, body) if (200..300).contains(&status) => Fetched::Ok(body),
            WebAnswer::Status(404, _) => Fetched::Missing,
            WebAnswer::Status(status, _) => {
                // A throttled request is CommunityDragon answering, just not
                // this request, so only a failing server counts as an outage.
                if status >= 500 {
                    self.note_outage(&format!("HTTP {status}"));
                }
                Fetched::Error
            }
            WebAnswer::Failed(reason) => {
                self.note_outage(&reason);
                Fetched::Error
            }
        }
    }

    /// JSON CommunityDragon serves outside the game data (its branch listing),
    /// not kept on disk, but held to the same outage backoff and concurrency.
    pub async fn fetch_cdragon_json(&self, url: &str) -> Result<Value, String> {
        match self.fetch_remote(url).await {
            Fetched::Ok(bytes) => serde_json::from_slice(&bytes).map_err(|err| err.to_string()),
            other => Err(format!("Request failed ({}): {url}", other.state())),
        }
    }

    // -----------------------------------------------------------------------
    // Which patch a copy belongs to

    fn remembered(
        &self,
        which: fn(&Inner) -> &Mutex<Remembered>,
        retry: Duration,
        ask: impl FnOnce(GameAssets) -> BoxFuture<'static, Option<String>>,
    ) -> Shared<BoxFuture<'static, Option<String>>> {
        let mut state = which(&self.0).lock().expect("remembered lock");
        if let Some(known) = &state.known {
            let known = known.clone();
            return async move { Some(known) }.boxed().shared();
        }
        if let Some(pending) = &state.pending {
            return pending.clone();
        }
        let now = Instant::now();
        if state
            .asked_at
            .is_some_and(|at| now.duration_since(at) < retry)
        {
            return async { None }.boxed().shared();
        }
        state.asked_at = Some(now);
        let assets = self.clone();
        let asked = ask(self.clone());
        let task = tokio::spawn(async move {
            let found = asked.await;
            let mut state = which(&assets.0).lock().expect("remembered lock");
            if found.is_some() {
                state.known = found;
            }
            state.pending = None;
            state.known.clone()
        });
        let pending = async move { task.await.ok().flatten() }.boxed().shared();
        state.pending = Some(pending.clone());
        pending
    }

    fn confirm_latest_patch(&self) -> Shared<BoxFuture<'static, Option<String>>> {
        self.remembered(
            |inner| &inner.latest,
            LATEST_RETRY,
            |assets| {
                async move {
                    let url = format!("{CDRAGON}/latest/content-metadata.json");
                    match assets.fetch_remote(&url).await {
                        Fetched::Ok(bytes) => serde_json::from_slice::<Value>(&bytes)
                            .ok()
                            .and_then(|meta| major_minor(meta.get("version")?)),
                        // Unreadable metadata says nothing; ask again later
                        _ => None,
                    }
                }
                .boxed()
            },
        )
    }

    /// A client still starting up can fail to say, so only an answer is
    /// remembered, and a failure is asked again after a pause rather than
    /// once per file.
    fn client_patch(&self) -> Shared<BoxFuture<'static, Option<String>>> {
        self.remembered(
            |inner| &inner.client_patch,
            CLIENT_PATCH_RETRY,
            |assets| {
                async move {
                    let bytes = assets.0.client.bytes("/lol-patch/v1/game-version").await?;
                    major_minor(&serde_json::from_slice::<Value>(&bytes).ok()?)
                }
                .boxed()
            },
        )
    }

    /// Where a branch's copies are read from. Until CommunityDragon says which
    /// patch "latest" holds, the newest one on disk stands in.
    fn read_key(&self, branch: &Branch) -> Option<String> {
        match branch {
            Branch::Patch(patch) => Some(patch.clone()),
            Branch::Latest => {
                let known = self.0.latest.lock().expect("latest lock").known.clone();
                known.or_else(|| self.cache().patches().into_iter().next())
            }
            Branch::Pbe | Branch::Other(_) => None,
        }
    }

    /// Where a copy fresh from CommunityDragon is filed. "pbe" changes too
    /// often to be worth keeping.
    async fn remote_key(&self, branch: &Branch) -> Option<String> {
        match branch {
            Branch::Patch(patch) => Some(patch.clone()),
            Branch::Latest => self.confirm_latest_patch().await,
            Branch::Pbe | Branch::Other(_) => None,
        }
    }

    // -----------------------------------------------------------------------
    // Loading

    async fn local(&self, file: &GameFile) -> Option<Vec<u8>> {
        match file.local {
            Local::GameData => {
                let path = format!("/lol-game-data/assets/{}", file.path);
                self.0.client.bytes(&path).await
            }
            Local::Splash(id) => {
                let path = format!("/lol-game-data/assets/v1/champions/{id}.json");
                let data = self.0.client.bytes(&path).await?;
                let champion: Value = serde_json::from_slice(&data).ok()?;
                let skins = champion.get("skins")?.as_array()?;
                let base = skins
                    .iter()
                    .find(|skin| js_truthy(skin.get("isBase")))
                    .or(skins.first())?;
                let splash = base.get("splashPath")?.as_str()?;
                self.0.client.bytes(splash).await
            }
        }
    }

    async fn resolve_file(&self, file: &GameFile, mode: LoadMode) -> Fetched {
        let key = self.read_key(&file.branch);
        let copy = key.as_deref().map(|key| self.cache().file(key, &file.path));
        if let Some(copy) = copy.as_deref().filter(|_| !mode.network_first)
            && let Some(bytes) = self.cache().read(copy).await
        {
            return Fetched::Ok(bytes.into());
        }

        let mut remote = self.fetch_remote(&file.remote).await;
        if let Fetched::Ok(bytes) = &remote {
            if file.is_well_formed(bytes) {
                let (assets, file, bytes) = (self.clone(), file.clone(), bytes.clone());
                self.spawn_background(async move {
                    let target = assets.remote_key(&file.branch).await;
                    assets
                        .cache()
                        .store(target.as_deref(), &file.path, &bytes)
                        .await;
                });
                return remote;
            }
            remote = Fetched::Error;
        }

        // The client only holds today's files. For "latest" those are the
        // files themselves. For a patch CommunityDragon couldn't be asked
        // about, they are a stand-in, which art can take but data can't; and a
        // patch branch that answered "missing" has the last word.
        let is_latest = file.branch == Branch::Latest;
        if (is_latest || (matches!(remote, Fetched::Error) && mode.stale))
            && let Some(bytes) = self.local(file).await
            && file.is_well_formed(&bytes)
        {
            let bytes: Arc<[u8]> = bytes.into();
            if is_latest {
                let (assets, path, stored) = (self.clone(), file.path.clone(), bytes.clone());
                self.spawn_background(async move {
                    let target = assets.client_patch().await;
                    assets
                        .cache()
                        .store(target.as_deref(), &path, &stored)
                        .await;
                });
            }
            return Fetched::Ok(bytes);
        }

        if let Some(copy) = copy.as_deref().filter(|_| mode.network_first)
            && let Some(bytes) = self.cache().read(copy).await
        {
            return Fetched::Ok(bytes.into());
        }
        if matches!(remote, Fetched::Missing) {
            return remote;
        }

        if mode.stale {
            for other in self.cache().patches() {
                if key.as_deref() == Some(other.as_str()) {
                    continue;
                }
                let file = self.cache().file(&other, &file.path);
                if let Some(bytes) = self.cache().read(&file).await {
                    return Fetched::Ok(bytes.into());
                }
            }
        }
        Fetched::Error
    }

    async fn load(&self, file: GameFile, mode: LoadMode) -> Fetched {
        let id = format!("{}|{}", file.branch.name(), file.path);
        if self.0.missing.lock().expect("missing lock").contains(&id) {
            return Fetched::Missing;
        }
        // Several icons on a page are often the same file
        let key = format!("{id}|{}|{}", mode.network_first, mode.stale);
        let assets = self.clone();
        self.0
            .loads
            .join(&key, move || async move {
                let result = assets.resolve_file(&file, mode).await;
                if matches!(result, Fetched::Missing) {
                    assets.0.missing.lock().expect("missing lock").insert(id);
                }
                result
            })
            .await
    }

    /// Art at a game-data path (see [`game_data_path`]) as of a branch.
    pub async fn load_game_image(&self, branch: &str, game_path: &str) -> Fetched {
        let file = GameFile::game_data(Branch::parse(branch), game_path);
        self.load(
            file,
            LoadMode {
                network_first: false,
                stale: true,
            },
        )
        .await
    }

    /// Parsed game data at a game-data path (such as "v1/items.json") as of a
    /// branch. Fails when no source has it.
    pub async fn load_game_data(&self, branch: &str, game_path: &str) -> Result<Value, String> {
        let parsed = Branch::parse(branch);
        let mode = LoadMode {
            network_first: !matches!(parsed, Branch::Patch(_)),
            // Another patch's data would misreport what this one shipped.
            // Whether "latest" may stand in for an archived patch is the
            // caller's decision.
            stale: parsed == Branch::Latest,
        };
        match self
            .load(GameFile::game_data(parsed, game_path), mode)
            .await
        {
            Fetched::Ok(bytes) => serde_json::from_slice(&bytes).map_err(|err| err.to_string()),
            other => Err(format!("No {game_path} on {branch} ({})", other.state())),
        }
    }

    // -----------------------------------------------------------------------
    // The asset: scheme

    /// The answer to one request on the scheme: the file, 400 for any URL the
    /// renderer's builders don't make, 404 when a source said it has no such
    /// file, and 503 when none answered.
    pub async fn serve(&self, method: &Method, uri: &Uri) -> Response<Cow<'static, [u8]>> {
        let file = (*method == Method::GET)
            .then(|| parse_asset_url(uri))
            .flatten();
        let Some(file) = file else {
            return empty_response(400);
        };
        let result = self
            .load(
                file,
                LoadMode {
                    network_first: false,
                    stale: true,
                },
            )
            .await;
        match result {
            Fetched::Ok(bytes) => Response::builder()
                .status(200)
                .header(
                    "Content-Type",
                    image_type(&bytes).unwrap_or("application/octet-stream"),
                )
                .body(Cow::Owned(bytes.to_vec()))
                .expect("a valid response"),
            Fetched::Missing => empty_response(404),
            Fetched::Error => empty_response(503),
        }
    }
}

fn empty_response(status: u16) -> Response<Cow<'static, [u8]>> {
    Response::builder()
        .status(status)
        .body(Cow::Borrowed(&[][..]))
        .expect("a valid response")
}

/// JavaScript truthiness for a JSON value that may be absent.
pub(crate) fn js_truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(_) | Value::Object(_)) => true,
    }
}

/// `decodeURIComponent`, which throws on a malformed escape or bytes that are
/// not UTF-8.
fn decode_uri_component(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = text.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// `encodeURIComponent`: everything but `A-Za-z0-9-_.!~*'()` as UTF-8 escapes.
fn encode_uri_component(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// A segment that could climb out of where it is joined, or name a drive or a
/// root, before or after decoding. The cache never joins one (copies are filed
/// by hash), but the client is asked for the path as it is.
fn is_unsafe_segment(segment: &str) -> bool {
    segment.is_empty()
        || segment.bytes().all(|b| b == b'.')
        || segment.contains(['/', '\\', ':', '\0'])
}

/// The URLs [`game_asset_url`] and [`champion_splash_url`] build, and nothing
/// else: no segment that could climb out of /lol-game-data/assets/ on the
/// client, or out of the cache. Takes both the WebKit form
/// (`asset://game-data/...`) and the WebView2 one
/// (`http://asset.localhost/game-data/...`).
pub fn parse_asset_url(uri: &Uri) -> Option<GameFile> {
    static IMAGE_PATH: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^[a-z0-9_.-]+(/[a-z0-9_.-]+)*\.(png|jpe?g|webp)$").expect("a valid pattern")
    });
    let host = uri.host()?.to_ascii_lowercase();
    let mut raw = uri.path().split('/').filter(|s| !s.is_empty());
    let kind = if host == WEBVIEW2_HOST {
        raw.next()?.to_string()
    } else {
        host
    };
    let mut segments = Vec::new();
    for segment in raw {
        let decoded = decode_uri_component(segment)?;
        if is_unsafe_segment(&decoded) {
            return None;
        }
        segments.push(decoded);
    }

    match (kind.as_str(), segments.as_slice()) {
        ("game-data", [branch, rest @ ..]) => {
            let branch = match Branch::parse(branch) {
                Branch::Other(_) => return None,
                branch => branch,
            };
            let game_path = rest.join("/").to_lowercase();
            IMAGE_PATH
                .is_match(&game_path)
                .then(|| GameFile::game_data(branch, &game_path))
        }
        ("splash", [id]) if id.bytes().all(|b| b.is_ascii_digit()) => {
            Some(GameFile::splash(id.parse().ok()?))
        }
        _ => None,
    }
}

/// A game-data path (as items.json and cherry-augments.json name an icon)
/// reduced to what follows /lol-game-data/assets/ in the client's own URLs,
/// lowercased, because CommunityDragon's exports are.
pub fn game_data_path(icon_path: &str) -> String {
    const PREFIX: &str = "/lol-game-data/assets/";
    let rest = match icon_path.get(..PREFIX.len()) {
        Some(head) if head.eq_ignore_ascii_case(PREFIX) => &icon_path[PREFIX.len()..],
        _ => icon_path,
    };
    rest.to_lowercase()
}

/// The file at a game-data path as of a branch, as the renderer addresses it.
pub fn game_asset_url(branch: &str, icon_path: &str) -> String {
    let encoded: Vec<String> = game_data_path(icon_path)
        .split('/')
        .map(encode_uri_component)
        .collect();
    format!("{ASSET_SCHEME}://game-data/{branch}/{}", encoded.join("/"))
}

#[cfg(test)]
pub fn champion_splash_url(id: u64) -> String {
    format!("{ASSET_SCHEME}://splash/{id}")
}

/// An `asset://` URL in the form this platform's webview routes: unchanged in
/// WebKit, `http://asset.localhost/...` in WebView2. For URLs a command hands
/// the renderer, such as a resolved augment icon; stored URLs stay `asset://`
/// so Electron's files read the same. `dragon:augment-icon` calls it once
/// T08's command layer is under this branch.
#[allow(dead_code)]
pub fn for_webview(url: String) -> String {
    if cfg!(windows) { to_webview2(url) } else { url }
}

#[cfg_attr(not(any(windows, test)), allow(dead_code))]
fn to_webview2(url: String) -> String {
    match url.strip_prefix("asset://") {
        Some(rest) => format!("http://{WEBVIEW2_HOST}/{rest}"),
        None => url,
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::asset_cache::tests::temp_dir;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// A CommunityDragon and Data Dragon that answer from a table, count what
    /// they were asked, and can go down. Nothing here reaches a real host.
    #[derive(Default)]
    pub struct FakeWeb {
        pub answers: Mutex<HashMap<String, WebAnswer>>,
        pub asked: Mutex<Vec<String>>,
        pub down: std::sync::atomic::AtomicBool,
        pub in_flight: AtomicUsize,
        pub most_in_flight: AtomicUsize,
        pub delay: Mutex<Option<Duration>>,
    }

    impl FakeWeb {
        pub fn serve(&self, url: &str, status: u16, body: &[u8]) {
            self.answers
                .lock()
                .unwrap()
                .insert(url.to_string(), WebAnswer::Status(status, body.into()));
        }

        pub fn serve_json(&self, url: &str, body: &Value) {
            self.serve(url, 200, body.to_string().as_bytes());
        }

        pub fn asked(&self, url: &str) -> usize {
            self.asked
                .lock()
                .unwrap()
                .iter()
                .filter(|u| *u == url)
                .count()
        }

        pub fn total_asked(&self) -> usize {
            self.asked.lock().unwrap().len()
        }
    }

    impl Web for FakeWeb {
        fn get<'a>(&'a self, url: &'a str) -> BoxFuture<'a, WebAnswer> {
            async move {
                self.asked.lock().unwrap().push(url.to_string());
                let now = self.in_flight.fetch_add(1, Ordering::SeqCst) + 1;
                self.most_in_flight.fetch_max(now, Ordering::SeqCst);
                let delay = *self.delay.lock().unwrap();
                if let Some(delay) = delay {
                    tokio::time::sleep(delay).await;
                }
                self.in_flight.fetch_sub(1, Ordering::SeqCst);
                if self.down.load(Ordering::SeqCst) {
                    return WebAnswer::Failed("connect ECONNREFUSED".into());
                }
                self.answers
                    .lock()
                    .unwrap()
                    .get(url)
                    .cloned()
                    .unwrap_or(WebAnswer::Status(404, Arc::from(&b""[..])))
            }
            .boxed()
        }
    }

    #[derive(Default)]
    pub struct FakeClient {
        pub files: Mutex<HashMap<String, Vec<u8>>>,
    }

    impl ClientFiles for FakeClient {
        fn bytes<'a>(&'a self, path: &'a str) -> BoxFuture<'a, Option<Vec<u8>>> {
            async move { self.files.lock().unwrap().get(path).cloned() }.boxed()
        }
    }

    pub fn png(tag: u8) -> Vec<u8> {
        let mut bytes = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
        bytes.push(tag);
        bytes
    }

    pub fn jpeg(tag: u8) -> Vec<u8> {
        vec![0xff, 0xd8, 0xff, 0xe0, tag]
    }

    pub fn game_url(branch: &str, path: &str) -> String {
        if path.starts_with("v1/") {
            format!("{CDRAGON}/{branch}/plugins/rcp-be-lol-game-data/global/default/{path}")
        } else {
            format!("{CDRAGON}/{branch}/game/{path}")
        }
    }

    pub const METADATA: &str = "https://raw.communitydragon.org/latest/content-metadata.json";

    pub struct Rig {
        pub root: PathBuf,
        pub web: Arc<FakeWeb>,
        pub client: Arc<FakeClient>,
        pub assets: GameAssets,
    }

    impl Rig {
        pub fn new(name: &str) -> Self {
            let root = temp_dir(name);
            let web = Arc::new(FakeWeb::default());
            let client = Arc::new(FakeClient::default());
            let assets = GameAssets::new(root.join("asset-cache"), web.clone(), client.clone());
            Self {
                root,
                web,
                client,
                assets,
            }
        }

        pub fn put(&self, patch: &str, game_path: &str, bytes: &[u8]) {
            let file = self.assets.cache().file(patch, game_path);
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(file, bytes).unwrap();
        }

        pub fn on_disk(&self, patch: &str, game_path: &str) -> Option<Vec<u8>> {
            std::fs::read(self.assets.cache().file(patch, game_path)).ok()
        }

        async fn get(&self, url: &str) -> (u16, Vec<u8>) {
            let response = self.assets.serve(&Method::GET, &url.parse().unwrap()).await;
            (response.status().as_u16(), response.body().to_vec())
        }
    }

    impl Drop for Rig {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn parsed(url: &str) -> Option<(String, String)> {
        parse_asset_url(&url.parse().unwrap())
            .map(|file| (file.branch.name().to_string(), file.path))
    }

    #[test]
    fn each_url_shape_the_renderer_builds_resolves_to_electrons_cache_path() {
        let cache = AssetCache::new(PathBuf::from("/root/asset-cache"));
        let builders = [
            // championIconUrl, profileIconUrl, an item, an augment, a spell,
            // and a PBE icon, as src/shared/game-assets.ts builds them
            (
                game_asset_url("latest", "v1/champion-icons/1.png"),
                "latest",
                "v1/champion-icons/1.png",
            ),
            (
                game_asset_url("latest", "v1/profile-icons/29.jpg"),
                "latest",
                "v1/profile-icons/29.jpg",
            ),
            (
                game_asset_url(
                    "16.22",
                    "/lol-game-data/assets/ASSETS/Items/Icons2D/3153_Marksman_T3_BladeOfTheRuinedKing.png",
                ),
                "16.22",
                "assets/items/icons2d/3153_marksman_t3_bladeoftheruinedking.png",
            ),
            (
                game_asset_url(
                    "16.1",
                    "/lol-game-data/assets/ASSETS/UX/Kiwi/Augments/Icons/HatOnAHat_Large.png",
                ),
                "16.1",
                "assets/ux/kiwi/augments/icons/hatonahat_large.png",
            ),
            (
                game_asset_url(
                    "pbe",
                    "/lol-game-data/assets/DATA/Spells/Icons2D/Summoner_Flash.png",
                ),
                "pbe",
                "data/spells/icons2d/summoner_flash.png",
            ),
            (champion_splash_url(266), "latest", "splash/266.jpg"),
        ];
        for (url, branch, path) in builders {
            assert_eq!(parsed(&url), Some((branch.into(), path.into())), "{url}");
            let webview2 = to_webview2(url.clone());
            assert!(
                webview2.starts_with("http://asset.localhost/"),
                "{webview2}"
            );
            assert_eq!(
                parsed(&webview2),
                Some((branch.into(), path.into())),
                "{webview2}"
            );
        }
        // The cache files a patch's copy where Electron does: sha1 of the path
        assert_eq!(
            cache.file("16.23", "v1/champion-icons/1.png"),
            PathBuf::from("/root/asset-cache/16.23/32a4b57252acdc0625734c11bb5e3fd83e161ea5.png")
        );
        // An encoded space decodes, as decodeURIComponent does, then fails the
        // path rule, as in Electron
        assert_eq!(
            game_asset_url("latest", "v1/a b.png"),
            "asset://game-data/latest/v1/a%20b.png"
        );
        assert_eq!(parsed("asset://game-data/latest/v1/a%20b.png"), None);
        // Case folds to the lowercase CommunityDragon serves
        assert_eq!(
            parsed("asset://game-data/latest/V1/Champion-Icons/1.PNG"),
            Some(("latest".into(), "v1/champion-icons/1.png".into()))
        );
    }

    #[test]
    fn the_scheme_refuses_every_traversal_form() {
        let refused = [
            // Plain and encoded parent segments
            "asset://game-data/latest/../../etc/passwd.png",
            "asset://game-data/latest/v1/%2e%2e/x.png",
            "asset://game-data/latest/v1/%2E%2E/%2E%2E/x.png",
            "asset://game-data/latest/v1/./x.png",
            "asset://game-data/latest/v1/.../x.png",
            "http://asset.localhost/game-data/latest/v1/%2e%2e/x.png",
            // An encoded separator, which would make an absolute or nested path
            "asset://game-data/latest/%2Fetc%2Fpasswd.png",
            "asset://game-data/latest/v1%2F..%2F..%2Fx.png",
            "asset://game-data/latest/..%5C..%5Cx.png",
            "asset://game-data/latest/%5Cwindows%5Cx.png",
            // Drive prefixes, plain and encoded
            "asset://game-data/latest/C:/windows/x.png",
            "asset://game-data/latest/C%3A/windows/x.png",
            "asset://game-data/latest/%43%3A%5Cx.png",
            // A branch that is not latest, pbe or a patch, or one that climbs
            "asset://game-data/../x.png",
            "asset://game-data/%2e%2e/v1/x.png",
            "asset://game-data/16.1.1/v1/x.png",
            "asset://game-data/main/v1/x.png",
            // Malformed escapes and bytes that are not UTF-8
            "asset://game-data/latest/v1/%zz.png",
            "asset://game-data/latest/v1/%ff.png",
            "asset://game-data/latest/v1/%00.png",
            // Not an image, or no path at all
            "asset://game-data/latest/v1/items.json",
            "asset://game-data/latest",
            "asset://game-data/latest/x.gif",
            // Splash takes one numeric id and nothing more
            "asset://splash/../1",
            "asset://splash/1/2",
            "asset://splash/-1",
            "asset://splash/%31%2e",
            // Unknown kinds, on both engines
            "asset://localhost/x.png",
            "asset://files/etc/passwd.png",
            "http://asset.localhost/",
            "http://asset.localhost/files/x.png",
        ];
        for url in refused {
            assert_eq!(parsed(url), None, "{url} was served");
        }
    }

    #[tokio::test]
    async fn traversal_answers_400_and_reads_nothing() {
        let rig = Rig::new("traversal");
        // A file one level above the cache, where a climbing path would land
        std::fs::write(rig.root.join("secret.png"), png(1)).unwrap();
        for url in [
            "asset://game-data/latest/../../secret.png",
            "asset://game-data/16.1/%2e%2e%2f%2e%2e%2fsecret.png",
            "http://asset.localhost/game-data/latest/..%5Csecret.png",
        ] {
            assert_eq!(rig.get(url).await.0, 400, "{url}");
        }
        let response = rig
            .assets
            .serve(&Method::POST, &"asset://splash/1".parse().unwrap())
            .await;
        assert_eq!(response.status(), 400);
        assert_eq!(rig.web.total_asked(), 0);
    }

    #[tokio::test]
    async fn serves_a_cached_copy_with_no_network() {
        let rig = Rig::new("cached");
        rig.web.down.store(true, Ordering::SeqCst);
        rig.put("16.23", "v1/champion-icons/1.png", &png(1));
        rig.put("16.22", "v1/champion-icons/2.png", &png(2));
        rig.put("16.23", "splash/266.jpg", &jpeg(3));
        // "latest" reads the newest patch on disk until CommunityDragon says
        let (status, body) = rig
            .get("asset://game-data/latest/v1/champion-icons/1.png")
            .await;
        assert_eq!((status, body), (200, png(1)));
        assert_eq!(rig.web.total_asked(), 0);
        // Art missing from its patch takes another patch's copy
        let (status, body) = rig
            .get("http://asset.localhost/game-data/latest/v1/champion-icons/2.png")
            .await;
        assert_eq!((status, body), (200, png(2)));
        let response = rig
            .assets
            .serve(&Method::GET, &"asset://splash/266".parse().unwrap())
            .await;
        assert_eq!(response.status(), 200);
        assert_eq!(response.headers()["Content-Type"], "image/jpeg");
        // Nothing anywhere, and CommunityDragon down, is 503
        assert_eq!(rig.get("asset://game-data/16.23/v1/none.png").await.0, 503);
    }

    #[tokio::test]
    async fn a_miss_is_fetched_into_the_path_electron_uses() {
        let rig = Rig::new("miss");
        rig.web.serve_json(
            METADATA,
            &serde_json::json!({ "version": "16.23.715.1234" }),
        );
        rig.web
            .serve(&game_url("latest", "v1/champion-icons/7.png"), 200, &png(7));
        rig.web.serve(
            &game_url("16.20", "assets/items/icons2d/1001.png"),
            200,
            &png(8),
        );
        rig.web.serve(
            "https://cdn.communitydragon.org/latest/champion/7/splash-art/centered",
            200,
            &jpeg(9),
        );
        rig.web
            .serve(&game_url("pbe", "v1/champion-icons/950.png"), 200, &png(10));
        assert_eq!(
            rig.get("asset://game-data/latest/v1/champion-icons/7.png")
                .await
                .1,
            png(7)
        );
        assert_eq!(
            rig.get("asset://game-data/16.20/assets/items/icons2d/1001.png")
                .await
                .1,
            png(8)
        );
        assert_eq!(rig.get("asset://splash/7").await.1, jpeg(9));
        assert_eq!(
            rig.get("asset://game-data/pbe/v1/champion-icons/950.png")
                .await
                .1,
            png(10)
        );
        rig.assets.settle().await;
        // "latest" is filed under the patch CommunityDragon says it holds
        assert_eq!(
            rig.on_disk("16.23", "v1/champion-icons/7.png"),
            Some(png(7))
        );
        assert_eq!(rig.on_disk("16.23", "splash/7.jpg"), Some(jpeg(9)));
        assert_eq!(
            rig.on_disk("16.20", "assets/items/icons2d/1001.png"),
            Some(png(8))
        );
        // "pbe" is never kept
        let mut patches = rig.assets.cache().patches();
        patches.sort();
        assert_eq!(patches, ["16.20", "16.23"]);
        // A second ask reads the copy
        let before = rig.web.total_asked();
        assert_eq!(
            rig.get("asset://game-data/latest/v1/champion-icons/7.png")
                .await
                .1,
            png(7)
        );
        assert_eq!(rig.web.total_asked(), before);
    }

    #[tokio::test]
    async fn an_error_page_served_as_200_is_not_filed() {
        let rig = Rig::new("malformed");
        rig.web
            .serve(&game_url("16.20", "v1/x.png"), 200, b"<html>oops</html>");
        assert_eq!(rig.get("asset://game-data/16.20/v1/x.png").await.0, 503);
        rig.assets.settle().await;
        assert_eq!(rig.on_disk("16.20", "v1/x.png"), None);
    }

    #[tokio::test]
    async fn a_missing_file_is_remembered_for_the_session() {
        let rig = Rig::new("missing");
        let url = game_url("16.20", "v1/gone.png");
        assert_eq!(rig.get("asset://game-data/16.20/v1/gone.png").await.0, 404);
        assert_eq!(rig.get("asset://game-data/16.20/v1/gone.png").await.0, 404);
        assert_eq!(rig.web.asked(&url), 1);
    }

    #[tokio::test]
    async fn the_client_answers_for_latest_and_stands_in_for_an_unreachable_patch() {
        let rig = Rig::new("client");
        rig.web.down.store(true, Ordering::SeqCst);
        rig.client.files.lock().unwrap().extend([
            (
                "/lol-game-data/assets/v1/champion-icons/3.png".to_string(),
                png(3),
            ),
            (
                "/lol-patch/v1/game-version".to_string(),
                br#""16.23.715.1234""#.to_vec(),
            ),
            (
                "/lol-game-data/assets/v1/champions/3.json".to_string(),
                br#"{"skins":[{"isBase":false,"splashPath":"/x"},{"isBase":true,"splashPath":"/lol-game-data/assets/v1/splash/3.jpg"}]}"#.to_vec(),
            ),
            ("/lol-game-data/assets/v1/splash/3.jpg".to_string(), jpeg(3)),
        ]);
        assert_eq!(
            rig.get("asset://game-data/latest/v1/champion-icons/3.png")
                .await
                .1,
            png(3)
        );
        assert_eq!(
            rig.get("asset://game-data/16.10/v1/champion-icons/3.png")
                .await
                .1,
            png(3)
        );
        assert_eq!(rig.get("asset://splash/3").await.1, jpeg(3));
        rig.assets.settle().await;
        // The client's copy of "latest" is filed under the client's patch; the
        // stand-in for 16.10 is not filed at all
        assert_eq!(
            rig.on_disk("16.23", "v1/champion-icons/3.png"),
            Some(png(3))
        );
        assert_eq!(rig.on_disk("16.23", "splash/3.jpg"), Some(jpeg(3)));
        assert_eq!(rig.on_disk("16.10", "v1/champion-icons/3.png"), None);
    }

    #[tokio::test(start_paused = true)]
    async fn an_outage_backs_off_for_thirty_seconds() {
        let rig = Rig::new("outage");
        rig.web.down.store(true, Ordering::SeqCst);
        assert_eq!(rig.get("asset://game-data/16.20/v1/a.png").await.0, 503);
        assert_eq!(rig.web.total_asked(), 1);
        // Inside the backoff nothing is asked, whatever the file
        tokio::time::advance(OUTAGE_BACKOFF - Duration::from_millis(1)).await;
        assert_eq!(rig.get("asset://game-data/16.20/v1/b.png").await.0, 503);
        assert!(
            rig.assets
                .fetch_cdragon_json(&format!("{CDRAGON}/json/"))
                .await
                .is_err()
        );
        assert_eq!(rig.web.total_asked(), 1);
        // Once it passes, the next request asks again
        tokio::time::advance(Duration::from_millis(1)).await;
        rig.web.down.store(false, Ordering::SeqCst);
        rig.web.serve(&game_url("16.20", "v1/c.png"), 200, &png(1));
        assert_eq!(rig.get("asset://game-data/16.20/v1/c.png").await.0, 200);
        assert_eq!(rig.web.total_asked(), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn throttling_is_not_an_outage_but_a_5xx_is() {
        let rig = Rig::new("throttle");
        rig.web.serve(&game_url("16.20", "v1/a.png"), 429, b"");
        assert_eq!(rig.get("asset://game-data/16.20/v1/a.png").await.0, 503);
        rig.web.serve(&game_url("16.20", "v1/b.png"), 200, &png(1));
        assert_eq!(rig.get("asset://game-data/16.20/v1/b.png").await.0, 200);
        rig.web.serve(&game_url("16.20", "v1/c.png"), 502, b"");
        assert_eq!(rig.get("asset://game-data/16.20/v1/c.png").await.0, 503);
        rig.web.serve(&game_url("16.20", "v1/d.png"), 200, &png(1));
        assert_eq!(rig.get("asset://game-data/16.20/v1/d.png").await.0, 503);
        assert_eq!(rig.web.asked(&game_url("16.20", "v1/d.png")), 0);
    }

    #[tokio::test]
    async fn at_most_eight_requests_at_a_time_and_one_per_file() {
        let rig = Rig::new("concurrency");
        *rig.web.delay.lock().unwrap() = Some(Duration::from_millis(30));
        for i in 0..20 {
            rig.web
                .serve(&game_url("16.20", &format!("v1/{i}.png")), 200, &png(i));
        }
        let mut requests = Vec::new();
        for i in 0..20 {
            for _ in 0..3 {
                let assets = rig.assets.clone();
                let uri: Uri = format!("asset://game-data/16.20/v1/{i}.png")
                    .parse()
                    .unwrap();
                requests.push(tokio::spawn(async move {
                    assets.serve(&Method::GET, &uri).await.status().as_u16()
                }));
            }
        }
        for request in requests {
            assert_eq!(request.await.unwrap(), 200);
        }
        assert_eq!(rig.web.total_asked(), 20);
        assert_eq!(rig.web.most_in_flight.load(Ordering::SeqCst), 8);
    }

    #[tokio::test]
    async fn game_data_on_latest_asks_the_network_first_and_falls_back_to_disk() {
        let rig = Rig::new("data");
        rig.web
            .serve_json(METADATA, &serde_json::json!({ "version": "16.23.1.2" }));
        rig.put("16.23", "v1/items.json", br#"[{"id":1}]"#);
        rig.web.serve_json(
            &game_url("latest", "v1/items.json"),
            &serde_json::json!([{ "id": 2 }]),
        );
        let data = rig
            .assets
            .load_game_data("latest", "v1/items.json")
            .await
            .unwrap();
        assert_eq!(data, serde_json::json!([{ "id": 2 }]));
        rig.assets.settle().await;
        assert_eq!(
            rig.on_disk("16.23", "v1/items.json"),
            Some(br#"[{"id":2}]"#.to_vec())
        );

        let rig = Rig::new("data-offline");
        rig.web.down.store(true, Ordering::SeqCst);
        rig.put("16.23", "v1/items.json", br#"[{"id":1}]"#);
        rig.put("16.22", "v1/x.json", br#"[]"#);
        let data = rig
            .assets
            .load_game_data("latest", "v1/items.json")
            .await
            .unwrap();
        assert_eq!(data, serde_json::json!([{ "id": 1 }]));
        // A patch's data reads its own copy and never another patch's
        let data = rig
            .assets
            .load_game_data("16.23", "v1/items.json")
            .await
            .unwrap();
        assert_eq!(data, serde_json::json!([{ "id": 1 }]));
        let err = rig
            .assets
            .load_game_data("16.21", "v1/items.json")
            .await
            .unwrap_err();
        assert_eq!(err, "No v1/items.json on 16.21 (error)");
        // "latest" data may take another patch's copy
        assert!(
            rig.assets
                .load_game_data("latest", "v1/x.json")
                .await
                .is_ok()
        );
    }

    #[test]
    fn the_public_web_trusts_mozillas_roots_and_not_riots() {
        let roots = public_roots();
        assert_eq!(roots.len(), webpki_roots::TLS_SERVER_ROOTS.len());
        assert!(roots.len() > 100);
        let riot = b"LoL Game Engineering Certificate Authority";
        assert!(
            !roots
                .subjects()
                .iter()
                .any(|name| name.as_ref().windows(riot.len()).any(|w| w == riot))
        );
        assert!(PublicWeb::new().is_ok());
    }

    #[test]
    fn for_webview_rewrites_only_asset_urls_on_windows() {
        let url = "asset://game-data/16.1/assets/ux/a.png".to_string();
        assert_eq!(
            to_webview2(url.clone()),
            "http://asset.localhost/game-data/16.1/assets/ux/a.png"
        );
        assert_eq!(to_webview2("https://x/y.png".into()), "https://x/y.png");
        assert_eq!(for_webview(url.clone()) == url, !cfg!(windows));
    }

    #[test]
    fn versions_read_as_major_minor() {
        assert_eq!(major_minor(&"16.23.715.1234".into()), Some("16.23".into()));
        assert_eq!(major_minor(&"16.23".into()), None);
        assert_eq!(major_minor(&Value::Null), None);
    }
}
