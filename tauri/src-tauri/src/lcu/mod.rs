//! The League client transport, ported from `src/main/lockfile.ts` and the
//! transport, socket, and loop parts of `src/main/lcu.ts`: finding the client,
//! HTTPS and the event socket over the pinned Riot root, the status the
//! renderer shows, and the 5 s connect loop with its 60 s poll. The sync work
//! (T20) plugs in through [`Hooks`].

pub mod http;
pub mod lockfile;
pub mod process_lookup;
pub mod socket;
pub mod status;
pub mod tls;

#[cfg(test)]
mod test_support;

use std::fmt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::future::BoxFuture;
use rustls::pki_types::CertificateDer;
use serde_json::Value;
use tokio::runtime::Handle;
use tokio::sync::{Semaphore, broadcast, oneshot};
use tokio::task::JoinHandle;
use tokio::time::{Instant, MissedTickBehavior, interval_at};

use http::Session;
use lockfile::{ClientLookup, InstallRoots};
use process_lookup::ProcessSource;
pub use status::LcuStatus;
use status::StatusCell;

/// The app's log until T09's logger lands; `lcu.ts` writes these through `console.log`.
fn log(message: impl AsRef<str>) {
    println!("[bmt pid={}] {}", std::process::id(), message.as_ref());
}

#[derive(Debug)]
pub enum LcuError {
    NotFound,
    Elevated,
    /// Refused, reset, or closed mid-answer: Node's ECONNREFUSED, ECONNRESET,
    /// socket hang up, and EPIPE
    ConnectionLost(String),
    Status {
        status: u16,
        url: String,
    },
    Other(String),
}

impl fmt::Display for LcuError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            // league-connect's messages
            Self::NotFound => f.write_str("League Client process could not be located"),
            Self::Elevated => {
                f.write_str("League Client has been detected but is running as administrator")
            }
            Self::Status { status, url } => write!(f, "LCU request failed: {status} {url}"),
            Self::ConnectionLost(text) | Self::Other(text) => f.write_str(text),
        }
    }
}

impl std::error::Error for LcuError {}

impl LcuError {
    fn transport(err: reqwest::Error) -> Self {
        let mut text = err.to_string();
        let mut lost = false;
        let mut source = std::error::Error::source(&err);
        while let Some(cause) = source {
            let shown = cause.to_string();
            if let Some(io) = cause.downcast_ref::<std::io::Error>() {
                use std::io::ErrorKind::*;
                lost |= matches!(
                    io.kind(),
                    ConnectionRefused | ConnectionReset | ConnectionAborted | BrokenPipe
                );
            }
            // hyper's name for what Node calls a socket hang up
            lost |= shown.contains("connection closed before message completed");
            text = format!("{text}: {shown}");
            source = cause.source();
        }
        if lost {
            Self::ConnectionLost(text)
        } else {
            Self::Other(text)
        }
    }

    /// `friendlyErrorMessage` in `lcu.ts`, for errors the UI shows.
    pub fn friendly_message(&self) -> String {
        match self {
            Self::NotFound => "League client is not running".into(),
            Self::Elevated => "League client is running as administrator — run Better Mayhem Tracker as administrator to connect".into(),
            Self::ConnectionLost(_) => "Lost connection to the League client".into(),
            other => other.to_string(),
        }
    }
}

/// The `lcu_install_dir` setting: where the client said it was installed, the
/// last time the process lookup had to find it. T20 backs it with the database.
pub trait InstallDirSetting: Send + Sync {
    fn get(&self) -> Option<String>;
    fn set(&self, dir: &str);
}

#[derive(Default)]
pub struct MemoryInstallDir(Mutex<Option<String>>);

impl InstallDirSetting for MemoryInstallDir {
    fn get(&self) -> Option<String> {
        self.0.lock().expect("setting lock").clone()
    }

    fn set(&self, dir: &str) {
        *self.0.lock().expect("setting lock") = Some(dir.to_string());
    }
}

/// Where the client is looked for.
pub enum Candidates {
    /// The setting, the Riot Client's records, and the default folder
    System(InstallRoots),
    /// This folder alone, or nowhere, with the setting ignored: the parity
    /// tools' fake client, or a test's temp folder
    #[cfg(any(test, feature = "parity-ca"))]
    Only(Option<PathBuf>),
}

pub struct Discovery {
    pub candidates: Candidates,
    pub process: ProcessSource,
}

#[cfg(feature = "parity-ca")]
pub const PARITY_LEAGUE_DIR_ENV: &str = "BMT_PARITY_LEAGUE_DIR";
#[cfg(feature = "parity-ca")]
pub const PARITY_PROCESS_ARGS_ENV: &str = "BMT_PARITY_PROCESS_ARGS";

impl Discovery {
    pub fn system() -> Self {
        Self {
            candidates: Candidates::System(InstallRoots::system()),
            process: ProcessSource::System,
        }
    }

    /// A parity build never looks at a real install or a real process: only
    /// the folder and the stand-in process list its environment names.
    #[cfg(feature = "parity-ca")]
    pub fn from_env() -> Self {
        let path = |name| std::env::var_os(name).map(PathBuf::from);
        let discovery = Self {
            candidates: Candidates::Only(path(PARITY_LEAGUE_DIR_ENV)),
            process: ProcessSource::file(path(PARITY_PROCESS_ARGS_ENV)),
        };
        log(format!(
            "parity: League client discovery limited to {:?}",
            path(PARITY_LEAGUE_DIR_ENV)
        ));
        discovery
    }

    #[cfg(not(feature = "parity-ca"))]
    pub fn from_env() -> Self {
        Self::system()
    }

    fn dirs(&self, reported: Option<String>) -> Vec<PathBuf> {
        match &self.candidates {
            Candidates::System(roots) => {
                lockfile::install_dir_candidates(reported.as_deref(), roots)
            }
            #[cfg(any(test, feature = "parity-ca"))]
            Candidates::Only(dir) => dir.iter().cloned().collect(),
        }
    }
}

/// Every interval and timeout the transport keeps, named as in `lcu.ts` and
/// `lockfile.ts`. Tests shorten them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Timing {
    pub connect_interval: Duration,
    pub poll_interval: Duration,
    pub attach_timeout: Duration,
    pub probe_timeout: Duration,
    pub authenticate_interval: Duration,
    pub client_file_timeout: Duration,
    pub file_lookup_ttl: Duration,
    pub client_file_concurrency: usize,
}

impl Default for Timing {
    fn default() -> Self {
        Self {
            connect_interval: Duration::from_millis(5_000),
            poll_interval: Duration::from_millis(60_000),
            attach_timeout: Duration::from_millis(15_000),
            probe_timeout: Duration::from_millis(1_000),
            authenticate_interval: Duration::from_millis(30_000),
            client_file_timeout: Duration::from_millis(5_000),
            file_lookup_ttl: Duration::from_millis(5_000),
            client_file_concurrency: 6,
        }
    }
}

/// What the sync work adds to the transport. T19's own [`TransportOnly`] asks
/// for the signed-in summoner and nothing else.
pub trait Hooks: Send + Sync + 'static {
    /// One poll's work, on connect and every 60 s after. An error restarts the
    /// connect loop, as a throw from `syncGames` does.
    fn on_poll<'a>(&'a self, lcu: &'a Lcu) -> BoxFuture<'a, Result<(), LcuError>>;

    /// Every event off the socket, after the transport has read the gameflow
    /// phase and session from it.
    fn on_event(&self, _lcu: &Lcu, _event: &Value) {}
}

pub struct TransportOnly;

const SUMMONER_PATH: &str = "/lol-summoner/v1/current-summoner";

impl Hooks for TransportOnly {
    fn on_poll<'a>(&'a self, lcu: &'a Lcu) -> BoxFuture<'a, Result<(), LcuError>> {
        Box::pin(async move {
            lcu.request_json(SUMMONER_PATH).await?;
            log(format!("{SUMMONER_PATH} returned 200"));
            Ok(())
        })
    }
}

/// The match being played, or the last one this client session. Never cleared
/// while connected, which keeps the Live Game page on a game after it ends.
/// JavaScript numbers, as `Number()` read them off the session.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LiveGameRef {
    pub game_id: f64,
    pub queue_id: f64,
}

const GAMEFLOW_SESSION_PATH: &str = "lol-gameflow/v1/session";
const GAMEFLOW_PHASE_PATH: &str = "lol-gameflow/v1/gameflow-phase";
const INSTALL_DIR_PATH: &str = "/data-store/v1/install-dir";
/// Reconnect rejoins a match already underway, so it counts as in game too
const IN_GAME_PHASES: [&str; 2] = ["InProgress", "Reconnect"];

/// `Number(value)` for the shapes JSON can hold.
fn js_number(value: Option<&Value>) -> f64 {
    match value {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => {
            let s = s.trim();
            if s.is_empty() {
                0.0
            } else {
                s.parse().unwrap_or(f64::NAN)
            }
        }
        Some(_) => f64::NAN,
    }
}

#[derive(Default)]
struct Loops {
    /// Bumped by every start and stop, so a superseded loop can tell
    generation: u64,
    stopped: bool,
    connect: Option<JoinHandle<()>>,
    poll: Option<JoinHandle<()>>,
}

impl Loops {
    fn abort(&mut self) {
        for task in [self.connect.take(), self.poll.take()].into_iter().flatten() {
            task.abort();
        }
    }
}

#[derive(Default)]
struct SocketSlot {
    attaching: bool,
    /// The open socket's id, and the way to close it
    open: Option<(u64, oneshot::Sender<()>)>,
}

/// Read for every new session; see [`tls::lcu_anchors`].
type Anchors = Box<dyn Fn() -> Vec<CertificateDer<'static>> + Send + Sync>;

struct FileLookup {
    at: Instant,
    session: Option<Arc<Session>>,
}

struct Inner {
    runtime: Handle,
    discovery: Discovery,
    install_dir: Arc<dyn InstallDirSetting>,
    hooks: Arc<dyn Hooks>,
    anchors: Anchors,
    timing: Timing,
    status: StatusCell,
    session: Mutex<Option<Arc<Session>>>,
    next_authenticate_at: Mutex<Option<Instant>>,
    loops: Mutex<Loops>,
    /// A sync can outlast the tick that scheduled the next one
    syncing: AtomicBool,
    socket: Mutex<SocketSlot>,
    next_socket_id: AtomicU64,
    live_game: Mutex<Option<LiveGameRef>>,
    file_lookup: tokio::sync::Mutex<Option<FileLookup>>,
    file_slots: Semaphore,
}

/// The transport, shared by the loops, the commands, and T20 and T21.
#[derive(Clone)]
pub struct Lcu(Arc<Inner>);

pub struct LcuOptions {
    pub runtime: Handle,
    pub discovery: Discovery,
    pub install_dir: Arc<dyn InstallDirSetting>,
    pub hooks: Arc<dyn Hooks>,
    pub emit: status::Emit,
    pub timing: Timing,
}

impl Lcu {
    pub fn new(options: LcuOptions) -> Self {
        Self::with_anchors(options, Box::new(tls::lcu_anchors))
    }

    fn with_anchors(options: LcuOptions, anchors: Anchors) -> Self {
        let concurrency = options.timing.client_file_concurrency;
        Self(Arc::new(Inner {
            runtime: options.runtime,
            discovery: options.discovery,
            install_dir: options.install_dir,
            hooks: options.hooks,
            anchors,
            timing: options.timing,
            status: StatusCell::new(options.emit),
            session: Mutex::default(),
            next_authenticate_at: Mutex::default(),
            loops: Mutex::default(),
            syncing: AtomicBool::new(false),
            socket: Mutex::default(),
            next_socket_id: AtomicU64::new(0),
            live_game: Mutex::default(),
            file_lookup: tokio::sync::Mutex::default(),
            file_slots: Semaphore::new(concurrency),
        }))
    }

    pub fn status(&self) -> LcuStatus {
        self.0.status.get()
    }

    pub fn is_client_connected(&self) -> bool {
        self.status().is_client_connected()
    }

    /// Changes only, in order: what `onLcuStatusChange` listeners hear.
    pub fn subscribe(&self) -> broadcast::Receiver<LcuStatus> {
        self.0.status.subscribe()
    }

    pub fn live_game_ref(&self) -> Option<LiveGameRef> {
        *self.0.live_game.lock().expect("live game lock")
    }

    fn spawn(&self, task: impl Future<Output = ()> + Send + 'static) -> JoinHandle<()> {
        self.0.runtime.spawn(task)
    }

    fn session(&self) -> Option<Arc<Session>> {
        self.0.session.lock().expect("session lock").clone()
    }

    fn set_session(&self, session: Option<Arc<Session>>) {
        *self.0.session.lock().expect("session lock") = session;
    }

    fn new_session(&self, credentials: lockfile::Credentials) -> Result<Arc<Session>, LcuError> {
        Ok(Arc::new(Session::new(credentials, &(self.0.anchors)())?))
    }

    /// `connect()`: the lockfile first, and the process lookup only when no
    /// lockfile can say, at most once per `authenticate_interval`.
    async fn connect(&self) -> Result<Arc<Session>, LcuError> {
        let inner = &self.0;
        let dirs = inner.discovery.dirs(inner.install_dir.get());
        match lockfile::find_client(&dirs, inner.timing.probe_timeout).await {
            ClientLookup::Running(credentials) => {
                let session = self.new_session(credentials)?;
                self.set_session(Some(session.clone()));
                Ok(session)
            }
            // An install with no live lockfile is a closed client, and asking
            // the process list would only say so more slowly
            ClientLookup::Closed => {
                self.set_session(None);
                Err(LcuError::NotFound)
            }
            ClientLookup::Unknown => {
                {
                    let mut next = inner.next_authenticate_at.lock().expect("lookup lock");
                    let now = Instant::now();
                    if next.is_some_and(|at| now < at) {
                        return Err(LcuError::NotFound);
                    }
                    *next = Some(now + inner.timing.authenticate_interval);
                }
                let credentials = process_lookup::lookup(&inner.discovery.process).await?;
                let session = self.new_session(credentials)?;
                self.set_session(Some(session.clone()));
                let lcu = self.clone();
                self.spawn(async move { lcu.remember_install_dir().await });
                Ok(session)
            }
        }
    }

    /// The client knows where it runs from, and remembering its answer lets
    /// every later lookup read the lockfile instead of the process list.
    async fn remember_install_dir(&self) {
        if let Some(Value::String(dir)) = self.json_or_none(INSTALL_DIR_PATH).await
            && !dir.is_empty()
        {
            self.0.install_dir.set(&dir);
        }
    }

    /// `lcuRequest`: finds the client first when there are no credentials.
    pub async fn request_json(&self, path: &str) -> Result<Value, LcuError> {
        let session = match self.session() {
            Some(session) => session,
            None => self.connect().await?,
        };
        session.json(path).await
    }

    /// `lcuJson`: an unreachable client is no answer rather than a failure.
    pub async fn json_or_none(&self, path: &str) -> Option<Value> {
        self.request_json(path).await.ok()
    }

    /// The connect loop's credentials once it has them. Before that, whatever
    /// the lockfile says, read at most once per `file_lookup_ttl`, and never
    /// the process list: a file request is not worth a PowerShell launch.
    async fn file_session(&self) -> Option<Arc<Session>> {
        if let Some(session) = self.session() {
            return Some(session);
        }
        let inner = &self.0;
        let mut cached = inner.file_lookup.lock().await;
        if let Some(lookup) = cached.as_ref()
            && lookup.at.elapsed() <= inner.timing.file_lookup_ttl
        {
            return lookup.session.clone();
        }
        let at = Instant::now();
        let dirs = inner.discovery.dirs(inner.install_dir.get());
        let session = match lockfile::find_client(&dirs, inner.timing.probe_timeout).await {
            ClientLookup::Running(credentials) => self.new_session(credentials).ok(),
            _ => None,
        };
        *cached = Some(FileLookup {
            at,
            session: session.clone(),
        });
        session
    }

    /// `lcuBytes`: the raw body the client serves at `path`, or `None` when it
    /// isn't running or has nothing there. At most six at a time, in order.
    pub async fn bytes(&self, path: &str) -> Option<Vec<u8>> {
        let session = self.file_session().await?;
        let _slot = self.0.file_slots.acquire().await.ok()?;
        session.bytes(path, self.0.timing.client_file_timeout).await
    }

    /// The phase, or `None` when the request fails or answers `null`.
    pub async fn fetch_gameflow_phase(&self) -> Option<Value> {
        self.json_or_none(&format!("/{GAMEFLOW_PHASE_PATH}"))
            .await
            .filter(|phase| !phase.is_null())
    }

    /// The phase only decides between the two connected states. A phase that
    /// arrives late must never bring a disconnected client back up.
    fn apply_phase(&self, phase: Option<&Value>) {
        if !self.is_client_connected() {
            return;
        }
        let in_game = phase
            .and_then(Value::as_str)
            .is_some_and(|phase| IN_GAME_PHASES.contains(&phase));
        self.0.status.set(if in_game {
            LcuStatus::Ingame
        } else {
            LcuStatus::Connected
        });
    }

    fn handle_event(&self, event: &Value) {
        let uri = match event.get("uri") {
            Some(Value::String(uri)) => uri.as_str(),
            _ => "",
        };
        match uri.strip_prefix('/').unwrap_or(uri) {
            GAMEFLOW_SESSION_PATH => {
                let game = event.get("data").and_then(|data| data.get("gameData"));
                let game_id = js_number(game.and_then(|g| g.get("gameId")));
                if game_id.is_finite() && game_id > 0.0 {
                    let queue_id = js_number(
                        game.and_then(|g| g.get("queue"))
                            .and_then(|queue| queue.get("id")),
                    );
                    *self.0.live_game.lock().expect("live game lock") =
                        Some(LiveGameRef { game_id, queue_id });
                }
            }
            GAMEFLOW_PHASE_PATH => self.apply_phase(event.get("data")),
            _ => {}
        }
        self.0.hooks.on_event(self, event);
    }

    fn socket_open(&self) -> bool {
        self.0.socket.lock().expect("socket lock").open.is_some()
    }

    /// One attempt with no retry of its own: the poll is what tries again.
    async fn attach_socket(&self) -> Result<(), LcuError> {
        {
            let mut slot = self.0.socket.lock().expect("socket lock");
            if slot.open.is_some() || slot.attaching {
                return Ok(());
            }
            slot.attaching = true;
        }
        let opened = async {
            let session = match self.session() {
                Some(session) => session,
                None => self.connect().await?,
            };
            socket::connect(&session, self.0.timing.attach_timeout).await
        }
        .await;
        let socket = {
            let mut slot = self.0.socket.lock().expect("socket lock");
            slot.attaching = false;
            let socket = opened?;
            let id = self.0.next_socket_id.fetch_add(1, Ordering::SeqCst);
            let (close, closed) = oneshot::channel();
            slot.open = Some((id, close));
            (id, socket, closed)
        };
        log("Listening for post-game results");
        let lcu = self.clone();
        self.spawn(async move { lcu.read_socket(socket.0, socket.1, socket.2).await });

        // The socket only carries changes, so a client already in a match when
        // it attached needs the current phase read once
        let lcu = self.clone();
        self.spawn(async move {
            let phase = lcu.fetch_gameflow_phase().await;
            lcu.apply_phase(phase.as_ref());
        });
        Ok(())
    }

    async fn read_socket(
        self,
        id: u64,
        mut socket: socket::EventSocket,
        mut closed: oneshot::Receiver<()>,
    ) {
        loop {
            tokio::select! {
                _ = &mut closed => {
                    socket.close().await;
                    return;
                }
                event = socket.next() => match event {
                    Some(event) => self.handle_event(&event),
                    None => break,
                },
            }
        }
        {
            // A socket the app replaced, or closed on the way out, isn't news
            let mut slot = self.0.socket.lock().expect("socket lock");
            if slot.open.as_ref().map(|(open, _)| *open) != Some(id) {
                return;
            }
            slot.open = None;
        }
        // Nothing is left to report the match ending
        if self.status() == LcuStatus::Ingame {
            self.0.status.set(LcuStatus::Connected);
        }
        self.handle_socket_drop().await;
    }

    /// The socket drops the moment the client exits, well before the next
    /// poll, but it can also drop with the client still there. A request
    /// decides which.
    async fn handle_socket_drop(&self) {
        if self.fetch_gameflow_phase().await.is_some() {
            return;
        }
        // A client that comes back comes back on a different port
        self.set_session(None);
        self.restart_connect_loop();
    }

    fn close_socket(&self) {
        let open = self.0.socket.lock().expect("socket lock").open.take();
        if let Some((_, close)) = open {
            // The reader is gone already if the socket closed on its own
            let _ = close.send(());
        }
    }

    fn spawn_poll_tick(&self) {
        let lcu = self.clone();
        self.spawn(async move { lcu.poll_tick().await });
    }

    async fn poll_tick(&self) {
        // A socket that dropped on its own doesn't fail the poll, so without
        // this the event socket would stay down for the rest of the session
        if !self.socket_open() {
            let lcu = self.clone();
            self.spawn(async move {
                // The next tick tries again
                let _ = lcu.attach_socket().await;
            });
        }

        if self.0.syncing.swap(true, Ordering::SeqCst) {
            return;
        }
        let result = self.0.hooks.on_poll(self).await;
        self.0.syncing.store(false, Ordering::SeqCst);
        if let Err(err) = result {
            log(format!("Poll fetch error: {err}"));
            self.restart_connect_loop();
        }
    }

    /// `startPolling`: "connecting" only on the very first attempt after
    /// launch, "disconnected" on every restart. The first attempt lands one
    /// interval in, not at once.
    pub fn start_polling(&self, first_attempt: bool) {
        let mut loops = self.0.loops.lock().expect("loops lock");
        self.start_locked(&mut loops, first_attempt);
    }

    fn start_locked(&self, loops: &mut Loops, first_attempt: bool) {
        loops.abort();
        loops.stopped = false;
        loops.generation += 1;
        self.0.status.set(if first_attempt {
            LcuStatus::Connecting
        } else {
            LcuStatus::Disconnected
        });
        let lcu = self.clone();
        let generation = loops.generation;
        loops.connect = Some(self.spawn(async move { lcu.connect_loop(generation, first_attempt).await }));
    }

    async fn connect_loop(self, generation: u64, mut first_attempt: bool) {
        let period = self.0.timing.connect_interval;
        let mut ticks = interval_at(Instant::now() + period, period);
        // A slow lookup skips the ticks it overran, as the `connecting` flag does
        ticks.set_missed_tick_behavior(MissedTickBehavior::Skip);
        loop {
            ticks.tick().await;
            if self.connect().await.is_ok() {
                break;
            }
            if first_attempt {
                first_attempt = false;
                self.0.status.set(LcuStatus::Disconnected);
            }
        }

        let mut loops = self.0.loops.lock().expect("loops lock");
        if loops.stopped || loops.generation != generation {
            return;
        }
        self.0.status.set(LcuStatus::Connected);
        loops.connect = None;
        // Installed before the first poll runs, never after: the first poll of
        // a session is the one most likely to fail, and this is what retries it
        let lcu = self.clone();
        let period = self.0.timing.poll_interval;
        loops.poll = Some(self.spawn(async move {
            let mut ticks = interval_at(Instant::now() + period, period);
            ticks.set_missed_tick_behavior(MissedTickBehavior::Skip);
            loop {
                ticks.tick().await;
                lcu.spawn_poll_tick();
            }
        }));
        drop(loops);
        self.spawn_poll_tick();
    }

    fn restart_connect_loop(&self) {
        let mut loops = self.0.loops.lock().expect("loops lock");
        // A drop check can still be waiting on a request when the app quits,
        // and restarting then would outlive the database it fetches into
        if loops.stopped {
            return;
        }
        self.start_locked(&mut loops, false);
    }

    /// `stopPolling`, for quit.
    pub fn stop_polling(&self) {
        {
            let mut loops = self.0.loops.lock().expect("loops lock");
            loops.stopped = true;
            loops.generation += 1;
            loops.abort();
        }
        self.close_socket();
        *self.0.live_game.lock().expect("live game lock") = None;
    }
}

/// Sends every status to the main window only, as `sendToRenderer` does.
pub fn emit_to_main<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> status::Emit {
    use tauri::Emitter;
    Box::new(move |status| {
        if let Err(err) = app.emit_to(crate::WINDOW_LABEL, "lcu:status-changed", status.as_str()) {
            log(format!("Status event failed: {err}"));
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use test_support::{FakeClient, PHASE, Reply, TempDir, TestCa, eventually, self_signed};

    const WAIT: Duration = Duration::from_secs(10);

    fn fast() -> Timing {
        Timing {
            connect_interval: Duration::from_millis(50),
            poll_interval: Duration::from_secs(60),
            attach_timeout: Duration::from_secs(2),
            probe_timeout: Duration::from_millis(300),
            authenticate_interval: Duration::from_millis(400),
            client_file_timeout: Duration::from_millis(500),
            file_lookup_ttl: Duration::from_secs(5),
            client_file_concurrency: 6,
        }
    }

    #[derive(Default)]
    struct Recorder {
        events: Mutex<Vec<Value>>,
        fail_polls: AtomicBool,
        polls: AtomicUsize,
    }

    impl Hooks for Recorder {
        fn on_poll<'a>(&'a self, _lcu: &'a Lcu) -> BoxFuture<'a, Result<(), LcuError>> {
            self.polls.fetch_add(1, Ordering::SeqCst);
            let fail = self.fail_polls.load(Ordering::SeqCst);
            Box::pin(async move {
                if fail {
                    Err(LcuError::Other("poll failed".into()))
                } else {
                    Ok(())
                }
            })
        }

        fn on_event(&self, _lcu: &Lcu, event: &Value) {
            self.events.lock().unwrap().push(event.clone());
        }
    }

    struct Rig {
        lcu: Lcu,
        sent: Arc<Mutex<Vec<LcuStatus>>>,
        install_dir: Arc<MemoryInstallDir>,
        hooks: Arc<Recorder>,
    }

    impl Rig {
        fn new(dir: Option<&TempDir>, args: Option<PathBuf>, ca: &TestCa) -> Self {
            Self::with_hooks(dir, args, ca, None)
        }

        fn with_hooks(
            dir: Option<&TempDir>,
            args: Option<PathBuf>,
            ca: &TestCa,
            hooks: Option<Arc<dyn Hooks>>,
        ) -> Self {
            let sent = Arc::new(Mutex::new(vec![]));
            let sink = sent.clone();
            let recorder = Arc::new(Recorder::default());
            let install_dir = Arc::new(MemoryInstallDir::default());
            let anchor = ca.cert();
            let lcu = Lcu::with_anchors(
                LcuOptions {
                    runtime: Handle::current(),
                    discovery: Discovery {
                        candidates: Candidates::Only(dir.map(|d| d.path().to_path_buf())),
                        process: ProcessSource::file(args),
                    },
                    install_dir: install_dir.clone(),
                    hooks: hooks.unwrap_or_else(|| recorder.clone()),
                    emit: Box::new(move |status| sink.lock().unwrap().push(status)),
                    timing: fast(),
                },
                Box::new(move || vec![anchor.clone()]),
            );
            Self {
                lcu,
                sent,
                install_dir,
                hooks: recorder,
            }
        }

        fn sent(&self) -> Vec<LcuStatus> {
            self.sent.lock().unwrap().clone()
        }

        fn lookups(&self) -> usize {
            match &self.lcu.0.discovery.process {
                ProcessSource::File { runs, .. } => runs.load(Ordering::SeqCst),
                ProcessSource::System => unreachable!("tests never read real processes"),
            }
        }

        async fn until(&self, what: &str, check: impl Fn(&[LcuStatus]) -> bool) {
            eventually(what, WAIT, || check(&self.sent())).await;
        }
    }

    impl Drop for Rig {
        fn drop(&mut self) {
            self.lcu.stop_polling();
        }
    }

    fn args_file(dir: &TempDir, port: u16, password: &str) -> PathBuf {
        let path = dir.path().join("ps.txt");
        std::fs::write(
            &path,
            format!(
                "/x/LeagueClientUx --remoting-auth-token={password} --app-port={port} --app-pid=1 --region=NA\n"
            ),
        )
        .expect("write args");
        path
    }

    use LcuStatus::*;

    #[test]
    fn timing_matches_lcu_ts() {
        assert_eq!(
            Timing::default(),
            Timing {
                connect_interval: Duration::from_secs(5),
                poll_interval: Duration::from_secs(60),
                attach_timeout: Duration::from_secs(15),
                probe_timeout: Duration::from_secs(1),
                authenticate_interval: Duration::from_secs(30),
                client_file_timeout: Duration::from_secs(5),
                file_lookup_ttl: Duration::from_secs(5),
                client_file_concurrency: 6,
            }
        );
    }

    #[test]
    fn friendly_messages_match_lcu_ts() {
        assert_eq!(
            LcuError::NotFound.friendly_message(),
            "League client is not running"
        );
        assert_eq!(
            LcuError::Elevated.friendly_message(),
            "League client is running as administrator — run Better Mayhem Tracker as administrator to connect"
        );
        assert_eq!(
            LcuError::ConnectionLost("refused".into()).friendly_message(),
            "Lost connection to the League client"
        );
        assert_eq!(
            LcuError::Status {
                status: 500,
                url: "/a".into()
            }
            .friendly_message(),
            "LCU request failed: 500 /a"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_refused_port_is_a_lost_connection() {
        let ca = TestCa::named("test root");
        let dead = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = dead.local_addr().expect("addr").port();
        drop(dead);
        let session = Session::new(
            lockfile::Credentials {
                pid: 1,
                port,
                password: "pw".into(),
            },
            &[ca.cert()],
        )
        .expect("session");
        let err = session.json("/a").await.expect_err("refused");
        assert!(matches!(err, LcuError::ConnectionLost(_)), "{err:?}");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn connects_by_lockfile_subscribes_and_follows_the_phase() {
        let ca = TestCa::named("test root");
        let client = FakeClient::start(&ca.leaf(&["127.0.0.1"])).await;
        let dir = TempDir::new();
        client.write_lockfile(dir.path(), "pw");
        let rig = Rig::new(Some(&dir), None, &ca);

        rig.lcu.start_polling(true);
        assert_eq!(rig.sent(), [Connecting], "connecting at once, no attempt yet");
        rig.until("connected", |s| s.contains(&Connected)).await;
        eventually("the subscribe", WAIT, || !client.first_frames().is_empty()).await;
        assert_eq!(client.first_frames(), [socket::SUBSCRIBE]);
        // The phase read after attaching sends connected again
        rig.until("the attach phase", |s| s == [Connecting, Connected, Connected])
            .await;
        assert!(rig.hooks.polls.load(Ordering::SeqCst) >= 1);

        client.publish(serde_json::json!({
            "uri": "/lol-gameflow/v1/session",
            "eventType": "Update",
            "data": {"gameData": {"gameId": 777, "queue": {"id": 2400}}},
        }));
        client.publish(serde_json::json!({
            "uri": "lol-gameflow/v1/gameflow-phase",
            "eventType": "Update",
            "data": "InProgress",
        }));
        rig.until("in game", |s| s.last() == Some(&Ingame)).await;
        assert_eq!(rig.lcu.status(), Ingame);
        assert_eq!(
            rig.lcu.live_game_ref(),
            Some(LiveGameRef {
                game_id: 777.0,
                queue_id: 2400.0
            })
        );

        client.publish(serde_json::json!({
            "uri": "/lol-gameflow/v1/gameflow-phase",
            "eventType": "Update",
            "data": "EndOfGame",
        }));
        rig.until("back to connected", |s| s.last() == Some(&Connected))
            .await;
        eventually("every event reaches the hook", WAIT, || {
            rig.hooks.events.lock().unwrap().len() == 3
        })
        .await;
        assert_eq!(rig.lcu.live_game_ref().map(|g| g.game_id), Some(777.0));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn no_client_reads_disconnected_once() {
        let ca = TestCa::named("test root");
        let dir = TempDir::new();
        let rig = Rig::new(Some(&dir), None, &ca);
        rig.lcu.start_polling(true);
        rig.until("disconnected", |s| s.contains(&Disconnected)).await;
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert_eq!(rig.sent(), [Connecting, Disconnected]);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_client_that_exits_reads_disconnected_and_its_stale_lockfile_stays_closed() {
        let ca = TestCa::named("test root");
        let client = FakeClient::start(&ca.leaf(&["127.0.0.1"])).await;
        let other = FakeClient::start(&ca.leaf(&["127.0.0.1"])).await;
        let dir = TempDir::new();
        client.write_lockfile(dir.path(), "pw");
        // A process list that would find a live client if anything read it
        let args = args_file(&dir, other.port(), "pw");
        let rig = Rig::new(Some(&dir), Some(args), &ca);

        rig.lcu.start_polling(true);
        eventually("the subscribe", WAIT, || !client.first_frames().is_empty()).await;
        client.publish(serde_json::json!({
            "uri": "/lol-gameflow/v1/gameflow-phase",
            "data": "InProgress",
        }));
        rig.until("in game", |s| s.last() == Some(&Ingame)).await;

        let before = rig.sent().len();
        client.stop();
        rig.until("disconnected", |s| s.last() == Some(&Disconnected))
            .await;
        assert_eq!(rig.sent()[before..], [Connected, Disconnected]);

        tokio::time::sleep(Duration::from_millis(600)).await;
        assert_eq!(rig.lcu.status(), Disconnected);
        assert_eq!(rig.sent().len(), before + 2, "no status after the drop");
        assert_eq!(rig.lookups(), 0, "a stale lockfile never runs the lookup");
        assert!(other.requests().is_empty());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_impostor_never_gets_a_request_and_the_status_flaps_like_electron() {
        let ca = TestCa::named("test root");
        let impostor = FakeClient::start(&self_signed(&["127.0.0.1", "localhost"], false)).await;
        let dir = TempDir::new();
        impostor.write_lockfile(dir.path(), "pw");
        let rig = Rig::with_hooks(Some(&dir), None, &ca, Some(Arc::new(TransportOnly)));

        rig.lcu.start_polling(true);
        rig.until("a poll failure and reconnect", |s| {
            s.windows(3).any(|w| w == [Connected, Disconnected, Connected])
        })
        .await;
        assert!(impostor.requests().is_empty(), "no HTTP request got through");
        assert!(impostor.upgrades().is_empty(), "no socket got through");
        assert!(impostor.first_frames().is_empty());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_failed_poll_restarts_the_loop() {
        let ca = TestCa::named("test root");
        let client = FakeClient::start(&ca.leaf(&["127.0.0.1"])).await;
        let dir = TempDir::new();
        client.write_lockfile(dir.path(), "pw");
        let rig = Rig::new(Some(&dir), None, &ca);
        rig.hooks.fail_polls.store(true, Ordering::SeqCst);
        rig.lcu.start_polling(true);
        rig.until("restart", |s| {
            s.windows(2).any(|w| w == [Connected, Disconnected])
        })
        .await;
        rig.hooks.fail_polls.store(false, Ordering::SeqCst);
        rig.until("reconnected", |s| s.last() == Some(&Connected)).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_process_lookup_runs_at_most_once_per_interval() {
        let ca = TestCa::named("test root");
        let dir = TempDir::new();
        let args = dir.path().join("ps.txt");
        std::fs::write(&args, "nothing like a client here\n").expect("write");
        let rig = Rig::new(Some(&dir), Some(args), &ca);
        let started = std::time::Instant::now();
        rig.lcu.start_polling(true);
        eventually("two lookups", WAIT, || rig.lookups() >= 2).await;
        tokio::time::sleep(Duration::from_millis(1_000)).await;
        let elapsed = started.elapsed().as_millis() as usize;
        let allowed = elapsed / 400 + 1;
        assert!(
            rig.lookups() <= allowed,
            "{} lookups in {elapsed} ms",
            rig.lookups()
        );
        assert_eq!(rig.sent(), [Connecting, Disconnected]);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_client_found_by_its_process_connects_and_its_folder_is_remembered() {
        let ca = TestCa::named("test root");
        let client = FakeClient::start(&ca.leaf(&["127.0.0.1"])).await;
        client.route(
            INSTALL_DIR_PATH,
            Reply::Json(200, Value::from("/Games/League of Legends")),
        );
        let dir = TempDir::new();
        let args = args_file(&dir, client.port(), "pw");
        let rig = Rig::new(Some(&dir), Some(args), &ca);
        rig.lcu.start_polling(true);
        rig.until("connected", |s| s.contains(&Connected)).await;
        eventually("the folder remembered", WAIT, || {
            rig.install_dir.get().as_deref() == Some("/Games/League of Legends")
        })
        .await;
        assert_eq!(rig.lookups(), 1);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn stop_polling_goes_quiet() {
        let ca = TestCa::named("test root");
        let client = FakeClient::start(&ca.leaf(&["127.0.0.1"])).await;
        let dir = TempDir::new();
        client.write_lockfile(dir.path(), "pw");
        let rig = Rig::new(Some(&dir), None, &ca);
        rig.lcu.start_polling(true);
        eventually("the subscribe", WAIT, || !client.first_frames().is_empty()).await;
        rig.until("attached", |s| s.len() >= 3).await;
        rig.lcu.stop_polling();
        let after = rig.sent();
        client.stop();
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert_eq!(rig.sent(), after, "nothing restarts after quit");
        assert_eq!(rig.lcu.live_game_ref(), None);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn bytes_use_the_lockfile_alone_and_six_at_a_time() {
        let ca = TestCa::named("test root");
        let client = FakeClient::start(&ca.leaf(&["127.0.0.1"])).await;
        let gate = Arc::new(tokio::sync::Semaphore::new(0));
        client.route("/art", Reply::Hold(gate.clone()));

        let unknown = TempDir::new();
        let args = args_file(&unknown, client.port(), "pw");
        let no_lockfile = Rig::new(Some(&unknown), Some(args), &ca);
        assert_eq!(no_lockfile.lcu.bytes("/art").await, None);
        assert_eq!(no_lockfile.lookups(), 0, "a file request never runs the lookup");

        let dir = TempDir::new();
        client.write_lockfile(dir.path(), "pw");
        let rig = Rig::new(Some(&dir), None, &ca);
        let requests: Vec<_> = (0..10)
            .map(|_| {
                let lcu = rig.lcu.clone();
                tokio::spawn(async move { lcu.bytes("/art").await })
            })
            .collect();
        eventually("six in flight", WAIT, || client.most_in_flight() == 6).await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(client.most_in_flight(), 6);
        gate.add_permits(10);
        for request in requests {
            assert_eq!(request.await.expect("joined"), Some(b"held".to_vec()));
        }
        assert_eq!(client.most_in_flight(), 6);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_null_phase_counts_as_no_answer() {
        let ca = TestCa::named("test root");
        let client = FakeClient::start(&ca.leaf(&["127.0.0.1"])).await;
        client.route(PHASE, Reply::Json(200, Value::Null));
        let dir = TempDir::new();
        client.write_lockfile(dir.path(), "pw");
        let rig = Rig::new(Some(&dir), None, &ca);
        assert_eq!(rig.lcu.fetch_gameflow_phase().await, None);
        client.route(PHASE, Reply::Json(200, Value::from("Lobby")));
        assert_eq!(rig.lcu.fetch_gameflow_phase().await, Some(Value::from("Lobby")));
    }

    /// Opt in: run T03's `parity/fake-lcu.ts`, then point `BMT_PARITY_LEAGUE_DIR`
    /// and `BMT_PARITY_CA` at its folder. Prints every status and event, with
    /// milliseconds since start, for `BMT_TEST_RUN_MS`.
    #[cfg(feature = "parity-ca")]
    #[ignore = "needs a running parity fake client"]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn against_the_parity_fake_client() {
        struct Printer(std::time::Instant);
        impl Hooks for Printer {
            fn on_poll<'a>(&'a self, lcu: &'a Lcu) -> BoxFuture<'a, Result<(), LcuError>> {
                TransportOnly.on_poll(lcu)
            }
            fn on_event(&self, _lcu: &Lcu, event: &Value) {
                println!(
                    "{:>6} ms event {} {}",
                    self.0.elapsed().as_millis(),
                    event["eventType"].as_str().unwrap_or_default(),
                    event["uri"].as_str().unwrap_or_default()
                );
            }
        }
        let run = std::env::var("BMT_TEST_RUN_MS")
            .ok()
            .and_then(|ms| ms.parse().ok())
            .unwrap_or(20_000);
        let started = std::time::Instant::now();
        let lcu = Lcu::new(LcuOptions {
            runtime: Handle::current(),
            discovery: Discovery::from_env(),
            install_dir: Arc::new(MemoryInstallDir::default()),
            hooks: Arc::new(Printer(started)),
            emit: Box::new(move |status| {
                println!("{:>6} ms status {}", started.elapsed().as_millis(), status.as_str())
            }),
            timing: Timing::default(),
        });
        lcu.start_polling(true);
        tokio::time::sleep(Duration::from_millis(run)).await;
        println!("live game {:?}", lcu.live_game_ref());
        lcu.stop_polling();
    }

    #[test]
    fn js_number_reads_like_number() {
        assert_eq!(js_number(Some(&Value::from(5))), 5.0);
        assert_eq!(js_number(Some(&Value::from(" 12 "))), 12.0);
        assert_eq!(js_number(Some(&Value::Null)), 0.0);
        assert!(js_number(None).is_nan());
        assert!(js_number(Some(&Value::from("x"))).is_nan());
    }
}
