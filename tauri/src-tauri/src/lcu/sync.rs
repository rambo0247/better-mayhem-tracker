//! The game sync in `src/main/lcu.ts`: the poll's work (`syncGames`, the
//! recent-games window, the escalation to a history walk), the final fetch on
//! quit, and what the app holds to run them. The history walk is in
//! [`super::backfill`] and the post-game capture in [`super::eog`]. All three
//! plug into T19's transport through [`Hooks`].

use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::future::BoxFuture;
use rusqlite::types::Value as Sql;
use rusqlite::{Connection, OptionalExtension};
use serde_json::Value;
use tokio::runtime::Handle;
use tokio::time::Instant;

use super::backfill::Sgp;
use super::eog::Eog;
use super::{Hooks, InstallDirSetting, Lcu, LcuError, LiveGameRef, log};
use crate::commands::lcu::{BackfillOutcome, BackfillProgress};
use crate::db::scoring::{ChampionClasses, check_score_backfill};
use crate::db::{Database, js};

pub const SUMMONER_PATH: &str = "/lol-summoner/v1/current-summoner";
const PHASE_PATH: &str = "/lol-gameflow/v1/gameflow-phase";
const INSTALL_DIR_SETTING: &str = "lcu_install_dir";
/// `MAYHEM_QUEUE_IDS` in `src/shared/queues.ts`.
const MAYHEM_QUEUE_IDS: [f64; 2] = [2400.0, 2450.0];
/// How many games the client's match list holds. Asking for more is accepted
/// and ignored, so this is the whole window the recent-games sync sees.
const LCU_HISTORY_PAGE_SIZE: usize = 20;
/// How long a failed automatic walk waits before the poll tries one again.
pub const AUTO_BACKFILL_RETRY_DELAY: Duration = Duration::from_secs(15 * 60);
const IN_GAME_PHASES: [&str; 2] = ["InProgress", "Reconnect"];

/// What a JavaScript `throw` carried: the client's errors, the match history
/// service's status, or any other `Error`'s message.
#[derive(Debug)]
pub enum Thrown {
    Lcu(LcuError),
    /// `SgpHttpError`, so a walk can tell a shard that stopped serving the
    /// account from a service that is merely unhappy
    SgpHttp(u16),
    Error(String),
}

impl std::fmt::Display for Thrown {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Lcu(err) => err.fmt(f),
            Self::SgpHttp(status) => write!(f, "Match history service returned {status}"),
            Self::Error(message) => f.write_str(message),
        }
    }
}

impl From<LcuError> for Thrown {
    fn from(err: LcuError) -> Self {
        Self::Lcu(err)
    }
}

impl From<js::TypeError> for Thrown {
    fn from(err: js::TypeError) -> Self {
        Self::Error(err.0)
    }
}

impl Thrown {
    /// `friendlyErrorMessage`.
    pub fn friendly(&self) -> String {
        match self {
            Self::Lcu(err) => err.friendly_message(),
            other => {
                let message = other.to_string();
                if lost_connection(&message) {
                    "Lost connection to the League client".into()
                } else {
                    message
                }
            }
        }
    }
}

fn lost_connection(message: &str) -> bool {
    let lower = message.to_lowercase();
    ["econnrefused", "econnreset", "socket hang up", "epipe"]
        .iter()
        .any(|name| lower.contains(name))
}

/// The transport as the sync uses it. [`Lcu`] in the app, a stand-in in tests.
pub trait Client: Send + Sync {
    fn request_json<'a>(&'a self, path: &'a str) -> BoxFuture<'a, Result<Value, LcuError>>;
    fn is_client_connected(&self) -> bool;
    fn live_game_ref(&self) -> Option<LiveGameRef>;
}

impl Client for Lcu {
    fn request_json<'a>(&'a self, path: &'a str) -> BoxFuture<'a, Result<Value, LcuError>> {
        Box::pin(Lcu::request_json(self, path))
    }

    fn is_client_connected(&self) -> bool {
        Lcu::is_client_connected(self)
    }

    fn live_game_ref(&self) -> Option<LiveGameRef> {
        Lcu::live_game_ref(self)
    }
}

/// Champion class data, which scoring reads: T22's `Dragon`, which hydrates
/// from `champion-cache.json` at startup as Electron's `dragon.ts` does.
pub trait Champions: Send + Sync {
    /// `getChampionClasses()` and `getChampionDataVersion()` as they stand now.
    fn classes(&self) -> ChampionClasses;
    /// `waitForChampionData()`.
    fn wait_for_champion_data(&self) -> BoxFuture<'_, ()>;
}

/// What the sync reads and tells outside the client: the database, champion
/// data, the wall clock (`Date.now()`, T08's [`crate::commands::Clock`] in the
/// app), and the three events it sends the main window.
pub trait Env: Send + Sync {
    fn db(&self) -> Option<&Database>;
    /// `None` until a champion data source is wired, when nothing is scored
    fn champions(&self) -> Option<Arc<dyn Champions>>;
    fn now_ms(&self) -> i64;
    fn games_updated(&self);
    fn backfill_progress(&self, progress: &BackfillProgress);
    fn backfill_done(&self, outcome: &BackfillOutcome);
}

/// `autoBackfillPausedUntil`: unset (`0`), a time, or `Infinity`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Pause {
    Until(Instant),
    Forever,
}

#[derive(Default)]
pub(super) struct SyncState {
    pub backfill_running: bool,
    pub backfill_cancelled: bool,
    pub auto_paused: Option<Pause>,
    /// Accounts walked end to end this launch, by their puuid's JSON text
    pub swept: HashSet<String>,
    pub sgp_host: Option<String>,
}

/// The sync's shared state, the event sink, and the match history service.
/// One per app, behind the transport's [`Hooks`].
pub struct GameSync {
    pub(super) env: Arc<dyn Env>,
    pub(super) sgp: Arc<dyn Sgp>,
    pub(super) runtime: Handle,
    pub(super) state: Mutex<SyncState>,
    pub(super) eog: Eog,
}

impl GameSync {
    pub fn new(env: Arc<dyn Env>, sgp: Arc<dyn Sgp>, runtime: Handle) -> Arc<Self> {
        Arc::new(Self {
            env,
            sgp,
            runtime,
            state: Mutex::default(),
            eog: Eog::default(),
        })
    }

    pub(super) fn state(&self) -> std::sync::MutexGuard<'_, SyncState> {
        self.state.lock().expect("sync state lock")
    }

    /// `Date.now() >= autoBackfillPausedUntil`.
    pub(super) fn auto_backfill_allowed(&self) -> bool {
        match self.state().auto_paused {
            None => true,
            Some(Pause::Until(at)) => Instant::now() >= at,
            Some(Pause::Forever) => false,
        }
    }

    #[cfg(test)]
    pub(super) fn swept_for_test(&self, puuid_json: &str) {
        self.state().swept.insert(puuid_json.into());
    }

    pub(super) fn pause_auto_backfill(&self, pause: Pause) {
        self.state().auto_paused = Some(pause);
    }

    /// Runs `f` on the database, with better-sqlite3's error for a closed one.
    pub(super) fn db<T>(
        &self,
        f: impl FnOnce(&Connection) -> rusqlite::Result<T>,
    ) -> Result<T, Thrown> {
        let db = self
            .env
            .db()
            .ok_or_else(|| Thrown::Error("The database connection is not open".into()))?;
        db.with(f).map_err(|err| Thrown::Error(err.message))
    }

    pub(super) fn upsert_summoner(&self, summoner: &Value) -> Result<(), Thrown> {
        let now = self.env.now_ms();
        self.db(|conn| crate::db::summoner::upsert_summoner(conn, summoner, now))
    }

    /// `db.insertGameFull(game, puuid)`, scored with the classes loaded at
    /// this moment.
    pub(super) fn insert_game(&self, game: &Value, puuid: Option<&Value>) -> Result<bool, Thrown> {
        let champions = self.env.champions().ok_or_else(no_champion_data)?;
        let classes = champions.classes().classes;
        let puuid = js::string(puuid).unwrap_or_default();
        self.db(|conn| crate::db::ingest::insert_game_full(conn, game, puuid, &classes))
    }

    /// Electron's startup `waitForChampionData().then(checkScoreBackfill)`:
    /// stored scores are recomputed once champion data has loaded, and the
    /// page re-queries when they were.
    pub async fn score_backfill_when_champions_load(&self) {
        let Some(champions) = self.env.champions() else {
            log(no_champion_data().to_string());
            return;
        };
        champions.wait_for_champion_data().await;
        let classes = champions.classes();
        match self.db(|conn| check_score_backfill(conn, &classes)) {
            Ok(true) => self.env.games_updated(),
            Ok(false) => {}
            Err(err) => log(format!("Score backfill failed: {err}")),
        }
    }

    async fn is_in_game(&self, client: &dyn Client) -> bool {
        client
            .request_json(PHASE_PATH)
            .await
            .ok()
            .and_then(|phase| phase.as_str().map(|p| IN_GAME_PHASES.contains(&p)))
            .unwrap_or(false)
    }

    /// `syncGames`: the account's first sync this launch walks its whole
    /// history; every later one reads the client's twenty-game window.
    pub async fn sync_games(self: &Arc<Self>, client: &Arc<dyn Client>) -> Result<(), Thrown> {
        let summoner = client.request_json(SUMMONER_PATH).await.ok();
        let key = summoner
            .as_ref()
            .map(|s| puuid_key(js::opt_prop(Some(s), "puuid")));
        let wants_sweep = js::truthy(summoner.as_ref())
            && self.auto_backfill_allowed()
            && key
                .as_ref()
                .is_some_and(|k| !self.state().swept.contains(k));

        if wants_sweep && !self.is_in_game(client.as_ref()).await {
            match self.backfill_history(client, true).await {
                Ok(_) => {
                    self.state().swept.extend(key);
                    return Ok(());
                }
                Err(err) => {
                    log(format!(
                        "Automatic backfill failed, falling back to recent games: {err}"
                    ));
                    self.pause_auto_backfill(Pause::Until(
                        Instant::now() + AUTO_BACKFILL_RETRY_DELAY,
                    ));
                }
            }
        }

        self.sync_recent_games(client, summoner.filter(|s| !s.is_null()))
            .await
    }

    /// `syncRecentGames`: a full window with nothing already accounted for
    /// has rolled past games the app never saw, so walk history for them.
    async fn sync_recent_games(
        self: &Arc<Self>,
        client: &Arc<dyn Client>,
        known_summoner: Option<Value>,
    ) -> Result<(), Thrown> {
        let rolled_over = self
            .fetch_new_games(client.as_ref(), known_summoner)
            .await?;
        if !rolled_over || self.state().backfill_running || !self.auto_backfill_allowed() {
            return Ok(());
        }
        log("Recent games contained nothing already known; walking history for missed games");
        if let Err(err) = self.backfill_history(client, false).await {
            log(format!(
                "History walk after a rolled-over window failed: {err}"
            ));
            self.pause_auto_backfill(Pause::Until(Instant::now() + AUTO_BACKFILL_RETRY_DELAY));
        }
        Ok(())
    }

    /// `fetchNewGames`: the client's recent games, each stored, ignored, or
    /// left for the next sync. True when the window rolled over.
    pub async fn fetch_new_games(
        &self,
        client: &dyn Client,
        known_summoner: Option<Value>,
    ) -> Result<bool, Thrown> {
        let summoner = match known_summoner {
            Some(summoner) => summoner,
            None => client.request_json(SUMMONER_PATH).await?,
        };
        self.upsert_summoner(&summoner)?;
        let puuid = js::prop(Some(&summoner), "puuid")?;

        let by_puuid = format!(
            "/lol-match-history/v1/products/lol/{}/matches?begIndex=0&endIndex={}",
            template(puuid),
            LCU_HISTORY_PAGE_SIZE - 1
        );
        let history = match client.request_json(&by_puuid).await {
            Ok(history) => history,
            Err(_) => {
                let current = format!(
                    "/lol-match-history/v1/products/lol/current-summoner/matches?begIndex=0&endIndex={}",
                    LCU_HISTORY_PAGE_SIZE - 1
                );
                match client.request_json(&current).await {
                    Ok(history) => history,
                    Err(_) => return Ok(false),
                }
            }
        };

        // historyResponse.games?.games || historyResponse.games || []
        let outer = js::prop(Some(&history), "games")?;
        let inner = js::opt_prop(outer, "games");
        let empty = Value::Array(vec![]);
        let games = if js::truthy(inner) {
            inner
        } else if js::truthy(outer) {
            outer
        } else {
            Some(&empty)
        };
        let Some(Value::Array(games)) = games else {
            return Err(Thrown::Error("games is not iterable".into()));
        };

        let mut stored = 0;
        let mut saw_known = false;
        for game in games {
            let game_id = js::prop(Some(game), "gameId")?;
            let id = js::bind(game_id).map_err(sqlite_thrown)?;
            if self.db(|conn| is_game_known(conn, &id))? {
                saw_known = true;
                continue;
            }
            // Recorded rather than skipped, so the next window has it as an
            // anchor too
            if !is_mayhem(js::prop(Some(game), "queueId")?) {
                self.db(|conn| mark_ignored_game(conn, &id))?;
                continue;
            }
            // Stored from the list entry it would hold one player of ten;
            // left unrecorded, the next sync tries it again
            let Ok(full) = client
                .request_json(&format!(
                    "/lol-match-history/v1/games/{}",
                    template(game_id)
                ))
                .await
            else {
                continue;
            };
            if self.insert_game(&full, puuid)? {
                stored += 1;
                log(format!(
                    "Stored ARAM Mayhem game {}",
                    template(js::opt_prop(Some(&full), "gameId"))
                ));
            }
        }

        if stored > 0 {
            self.env.games_updated();
        }
        // A window shorter than the cap is the account's whole recent history
        Ok(games.len() >= LCU_HISTORY_PAGE_SIZE && !saw_known)
    }

    /// The final fetch on quit, for T10's shell hook: `fetchNewGames` alone,
    /// and only while the client is connected. The shell bounds it at 5 s.
    pub fn final_fetch(
        self: &Arc<Self>,
        client: Arc<dyn Client>,
    ) -> Option<BoxFuture<'static, Result<(), String>>> {
        if !client.is_client_connected() {
            return None;
        }
        let sync = self.clone();
        Some(Box::pin(async move {
            sync.fetch_new_games(client.as_ref(), None)
                .await
                .map(|_| ())
                .map_err(|err| err.to_string())
        }))
    }
}

/// The transport's hooks: the poll runs `syncGames`, and every socket event
/// reaches the post-game capture.
pub struct SyncHooks(pub Arc<GameSync>);

impl Hooks for SyncHooks {
    fn on_poll<'a>(&'a self, lcu: &'a Lcu) -> BoxFuture<'a, Result<(), LcuError>> {
        Box::pin(async move {
            // A manual backfill is already covering everything this would fetch
            if self.0.state().backfill_running {
                return Ok(());
            }
            let client: Arc<dyn Client> = Arc::new(lcu.clone());
            self.0.sync_games(&client).await.map_err(|err| match err {
                Thrown::Lcu(err) => err,
                other => LcuError::Other(other.to_string()),
            })
        })
    }

    fn on_event(&self, lcu: &Lcu, event: &Value) {
        self.0.on_frame(Arc::new(lcu.clone()), event);
    }
}

/// The `lcu_install_dir` setting, in the database.
pub struct DbInstallDir(pub Arc<GameSync>);

impl InstallDirSetting for DbInstallDir {
    fn get(&self) -> Option<String> {
        self.0
            .db(|conn| crate::db::settings::get_setting(conn, INSTALL_DIR_SETTING))
            .ok()
            .flatten()
    }

    fn set(&self, dir: &str) {
        if let Err(err) = self
            .0
            .db(|conn| crate::db::settings::set_setting(conn, INSTALL_DIR_SETTING, dir))
        {
            log(format!("Failed to remember the client folder: {err}"));
        }
    }
}

/// `MAYHEM_QUEUE_IDS.includes(queueId)`: strict, so only a JSON number matches.
pub(super) fn is_mayhem(queue_id: Option<&Value>) -> bool {
    matches!(queue_id, Some(Value::Number(n)) if n.as_f64().is_some_and(|q| MAYHEM_QUEUE_IDS.contains(&q)))
}

pub(super) fn is_mayhem_number(queue_id: f64) -> bool {
    MAYHEM_QUEUE_IDS.contains(&queue_id)
}

/// `String(value)`, as a template literal prints it.
pub(super) fn template(value: Option<&Value>) -> String {
    match value {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => js::number_to_string(n.as_f64().unwrap_or(f64::NAN)),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                other => template(Some(other)),
            })
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".into(),
    }
}

/// `Number(text)`: whitespace trimmed, empty is 0, and the hex, octal, and
/// binary prefixes a JavaScript numeric literal takes.
pub(super) fn js_number_of_str(text: &str) -> f64 {
    let s = text.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
    if s.is_empty() {
        return 0.0;
    }
    for (prefix, radix) in [
        ("0x", 16),
        ("0X", 16),
        ("0o", 8),
        ("0O", 8),
        ("0b", 2),
        ("0B", 2),
    ] {
        if let Some(digits) = s.strip_prefix(prefix) {
            if digits.is_empty() || !digits.chars().all(|c| c.is_digit(radix)) {
                return f64::NAN;
            }
            return digits.chars().fold(0.0, |acc, c| {
                acc * f64::from(radix) + f64::from(c.to_digit(radix).unwrap_or(0))
            });
        }
    }
    let body = s.strip_prefix(['+', '-']).unwrap_or(s);
    if body == "Infinity" {
        return if s.starts_with('-') {
            f64::NEG_INFINITY
        } else {
            f64::INFINITY
        };
    }
    // Rust also reads "inf", "nan", and the like, which JavaScript does not
    let literal = body
        .chars()
        .all(|c| c.is_ascii_digit() || matches!(c, '.' | 'e' | 'E' | '+' | '-'));
    if !literal {
        return f64::NAN;
    }
    s.parse().unwrap_or(f64::NAN)
}

/// `Number(value)` for a JSON value, `None` being `undefined`.
pub(super) fn js_number(value: Option<&Value>) -> f64 {
    match value {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => js_number_of_str(s),
        Some(array @ Value::Array(_)) => js_number_of_str(&template(Some(array))),
        Some(Value::Object(_)) => f64::NAN,
    }
}

/// A key for the puuid the way a `Set` tells values apart.
fn puuid_key(puuid: Option<&Value>) -> String {
    puuid.map_or_else(|| "undefined".into(), Value::to_string)
}

fn no_champion_data() -> Thrown {
    Thrown::Error("No champion data source is wired, so games cannot be scored".into())
}

fn sqlite_thrown(err: rusqlite::Error) -> Thrown {
    Thrown::Error(err.to_string())
}

/// A JavaScript number as better-sqlite3 binds it.
pub(super) fn bound(id: f64) -> Sql {
    Sql::Real(id)
}

/// `isGameKnown`, `markIgnoredGame`, and `gameExists` from `db/ingest.ts`,
/// for an id bound as better-sqlite3 binds whatever JavaScript passed.
pub(super) fn is_game_known(conn: &Connection, id: &Sql) -> rusqlite::Result<bool> {
    conn.prepare_cached(
        "SELECT 1 FROM games WHERE game_id = ? UNION ALL SELECT 1 FROM ignored_games WHERE game_id = ? LIMIT 1",
    )?
    .query_row([id, id], |_| Ok(()))
    .optional()
    .map(|row| row.is_some())
}

pub(super) fn mark_ignored_game(conn: &Connection, id: &Sql) -> rusqlite::Result<()> {
    conn.prepare_cached("INSERT OR IGNORE INTO ignored_games (game_id) VALUES (?)")?
        .execute([id])?;
    Ok(())
}

pub(super) fn game_exists(conn: &Connection, id: &Sql) -> rusqlite::Result<bool> {
    conn.prepare_cached("SELECT 1 FROM games WHERE game_id = ?")?
        .query_row([id], |_| Ok(()))
        .optional()
        .map(|row| row.is_some())
}

/// `getDashboardData().totalGames` with no filters: every non-remake game in
/// a queue that is not hidden.
pub(super) fn total_games(conn: &Connection) -> rusqlite::Result<i64> {
    let mut filters = crate::db::filters::Where {
        conditions: vec!["g.is_remake = 0".into()],
        params: vec![],
    };
    crate::db::filters::apply_queue_filter(conn, &mut filters, None, "g")?;
    let sql = format!(
        "SELECT COUNT(*) FROM player_stats ps JOIN games g ON ps.game_id = g.game_id WHERE {}",
        filters.conditions.join(" AND ")
    );
    conn.prepare(&sql)?
        .query_row(rusqlite::params_from_iter(filters.params), |row| row.get(0))
}

/// What the app holds: the transport with the sync plugged in.
pub struct LcuSync {
    pub lcu: Lcu,
    pub sync: Arc<GameSync>,
}

impl LcuSync {
    pub fn new(env: Arc<dyn Env>, runtime: Handle, emit: super::status::Emit) -> Self {
        let sync = GameSync::new(
            env,
            Arc::new(super::backfill::HttpSgp::new()),
            runtime.clone(),
        );
        let lcu = Lcu::new(super::LcuOptions {
            runtime,
            discovery: super::Discovery::from_env(),
            install_dir: Arc::new(DbInstallDir(sync.clone())),
            hooks: Arc::new(SyncHooks(sync.clone())),
            emit,
            timing: super::Timing::default(),
        });
        Self { lcu, sync }
    }

    /// `startPolling(win)` at launch, with the score backfill that waits for
    /// champion data beside it. With no champion data source wired nothing
    /// could be scored, so nothing starts.
    pub fn start_polling(&self) {
        if self.sync.env.champions().is_none() {
            log(no_champion_data().to_string());
            return;
        }
        let sync = self.sync.clone();
        self.sync
            .runtime
            .spawn(async move { sync.score_backfill_when_champions_load().await });
        self.sync.eog.resume();
        self.lcu.start_polling(true);
    }

    /// `stopPolling`, for T10's `on_stop_polling` hook: the loops, the socket,
    /// and every scheduled capture retry.
    pub fn stop_polling(&self) {
        self.lcu.stop_polling();
        self.sync.eog.stop();
    }

    /// For T10's `final_fetch` hook.
    pub fn final_fetch(&self) -> Option<BoxFuture<'static, Result<(), String>>> {
        self.sync.final_fetch(Arc::new(self.lcu.clone()))
    }

    pub async fn backfill_from_settings(&self) -> BackfillOutcome {
        let client: Arc<dyn Client> = Arc::new(self.lcu.clone());
        self.sync.backfill_from_settings(&client).await
    }
}

/// The app's side of [`Env`]: T11's managed database, T08's clock, and the
/// events, sent to the main window alone.
pub struct AppEnv<R: tauri::Runtime>(pub tauri::AppHandle<R>);

impl<R: tauri::Runtime> Env for AppEnv<R> {
    fn db(&self) -> Option<&Database> {
        use tauri::Manager;
        self.0.try_state::<Database>().map(|state| state.inner())
    }

    fn now_ms(&self) -> i64 {
        use tauri::Manager;
        self.0
            .try_state::<crate::commands::Clock>()
            .map_or(crate::commands::Clock::System, |clock| *clock)
            .now_ms()
    }

    fn champions(&self) -> Option<Arc<dyn Champions>> {
        use tauri::Manager;
        self.0
            .try_state::<Arc<dyn Champions>>()
            .map(|champions| champions.inner().clone())
    }

    fn games_updated(&self) {
        crate::events::games_updated(&self.0);
    }

    fn backfill_progress(&self, progress: &BackfillProgress) {
        crate::events::backfill_progress(&self.0, progress);
    }

    fn backfill_done(&self, outcome: &BackfillOutcome) {
        crate::events::backfill_done(&self.0, outcome);
    }
}

/// Manages [`LcuSync`] once the app exists, in every build, the golden
/// replay's mock app included. Polling starts only where the real app calls
/// [`LcuSync::start_polling`], after its window is up.
pub fn plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("bmt-lcu")
        .setup(|app, _api| {
            use tauri::Manager;
            let runtime = tauri::async_runtime::handle().inner().clone();
            let env = Arc::new(AppEnv(app.clone()));
            app.manage(LcuSync::new(env, runtime, super::emit_to_main(app.clone())));
            Ok(())
        })
        .build()
}

/// In-memory stand-ins for the client, the match history service, and the
/// app, on a paused tokio clock, so every request's time is exact.
#[cfg(test)]
pub(super) mod rig {
    use std::collections::{HashMap, VecDeque};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, Ordering};

    use serde_json::json;
    use tokio::sync::Notify;

    use super::*;
    use crate::lcu::backfill::{Sgp, SgpResponse};

    /// The anonymized fixture's frozen clock, as T05 recorded under.
    pub const NOW_MS: i64 = 1_795_399_200_000;

    #[derive(Clone)]
    pub enum Reply {
        Json(Value),
        Status(u16),
        /// Refused, as a client that went away answers
        Lost,
        /// Never answers
        Hang,
        After(Duration, Box<Reply>),
    }

    pub struct FakeClient {
        started: Instant,
        /// The last reply for a path repeats once the ones before it are used
        routes: Mutex<HashMap<String, VecDeque<Reply>>>,
        log: Mutex<Vec<(u128, String)>>,
        pub connected: AtomicBool,
        pub live: Mutex<Option<LiveGameRef>>,
    }

    impl FakeClient {
        pub fn route(&self, path: &str, replies: Vec<Reply>) {
            self.routes
                .lock()
                .unwrap()
                .insert(path.into(), replies.into());
        }

        /// Milliseconds after the rig started, for each request to `path`.
        pub fn times(&self, path: &str) -> Vec<u128> {
            self.log
                .lock()
                .unwrap()
                .iter()
                .filter(|(_, p)| p == path)
                .map(|(t, _)| *t)
                .collect()
        }

        pub fn paths(&self) -> Vec<String> {
            self.log
                .lock()
                .unwrap()
                .iter()
                .map(|(_, p)| p.clone())
                .collect()
        }

        fn next(&self, path: &str) -> Reply {
            let mut routes = self.routes.lock().unwrap();
            match routes.get_mut(path) {
                Some(replies) if replies.len() > 1 => replies.pop_front().unwrap(),
                Some(replies) => replies.front().cloned().unwrap_or(Reply::Status(404)),
                None => Reply::Status(404),
            }
        }
    }

    async fn answer(reply: Reply, path: &str) -> Result<Value, LcuError> {
        let mut reply = reply;
        loop {
            match reply {
                Reply::Json(value) => return Ok(value),
                Reply::Status(status) => {
                    return Err(LcuError::Status {
                        status,
                        url: path.into(),
                    });
                }
                Reply::Lost => return Err(LcuError::ConnectionLost("refused".into())),
                Reply::Hang => std::future::pending::<()>().await,
                Reply::After(delay, then) => {
                    tokio::time::sleep(delay).await;
                    reply = *then;
                }
            }
        }
    }

    impl Client for FakeClient {
        fn request_json<'a>(&'a self, path: &'a str) -> BoxFuture<'a, Result<Value, LcuError>> {
            let at = self.started.elapsed().as_millis();
            self.log.lock().unwrap().push((at, path.to_string()));
            let reply = self.next(path);
            Box::pin(answer(reply, path))
        }

        fn is_client_connected(&self) -> bool {
            self.connected.load(Ordering::SeqCst)
        }

        fn live_game_ref(&self) -> Option<LiveGameRef> {
            *self.live.lock().unwrap()
        }
    }

    pub type SgpAnswer = Box<dyn Fn(&str) -> Reply + Send + Sync>;

    pub struct FakeSgp {
        started: Instant,
        pub answer: Mutex<SgpAnswer>,
        log: Mutex<Vec<(u128, String, Duration)>>,
    }

    impl FakeSgp {
        pub fn urls(&self) -> Vec<String> {
            self.log
                .lock()
                .unwrap()
                .iter()
                .map(|(_, u, _)| u.clone())
                .collect()
        }

        pub fn timeouts(&self) -> Vec<Duration> {
            self.log
                .lock()
                .unwrap()
                .iter()
                .map(|(_, _, t)| *t)
                .collect()
        }
    }

    impl Sgp for FakeSgp {
        fn get<'a>(
            &'a self,
            url: &'a str,
            token: &'a str,
            timeout: Duration,
        ) -> BoxFuture<'a, Result<SgpResponse, Thrown>> {
            assert_eq!(token, "parity-fake-token");
            let at = self.started.elapsed().as_millis();
            self.log
                .lock()
                .unwrap()
                .push((at, url.to_string(), timeout));
            let reply = (self.answer.lock().unwrap())(url);
            Box::pin(async move {
                let answered = tokio::time::timeout(timeout, async {
                    let mut reply = reply;
                    loop {
                        match reply {
                            Reply::Json(body) => {
                                break Ok(SgpResponse {
                                    status: 200,
                                    body: body.to_string().into_bytes(),
                                });
                            }
                            Reply::Status(status) => {
                                break Ok(SgpResponse {
                                    status,
                                    body: b"{}".to_vec(),
                                });
                            }
                            Reply::Lost => break Err(Thrown::Error("fetch failed".into())),
                            Reply::Hang => std::future::pending::<()>().await,
                            Reply::After(delay, then) => {
                                tokio::time::sleep(delay).await;
                                reply = *then;
                            }
                        }
                    }
                })
                .await;
                answered.unwrap_or_else(|_| {
                    Err(Thrown::Error(
                        "The operation was aborted due to timeout".into(),
                    ))
                })
            })
        }
    }

    pub struct TestChampions {
        pub classes: Mutex<ChampionClasses>,
        pub loaded: AtomicBool,
        notify: Notify,
    }

    impl TestChampions {
        pub fn load(&self, classes: ChampionClasses) {
            *self.classes.lock().unwrap() = classes;
            self.loaded.store(true, Ordering::SeqCst);
            self.notify.notify_waiters();
        }
    }

    impl Champions for TestChampions {
        fn classes(&self) -> ChampionClasses {
            self.classes.lock().unwrap().clone()
        }

        fn wait_for_champion_data(&self) -> BoxFuture<'_, ()> {
            Box::pin(async move {
                while !self.loaded.load(Ordering::SeqCst) {
                    let notified = self.notify.notified();
                    if self.loaded.load(Ordering::SeqCst) {
                        break;
                    }
                    notified.await;
                }
            })
        }
    }

    pub struct TestEnv {
        started: Instant,
        dir: PathBuf,
        db: Database,
        pub champions: Arc<TestChampions>,
        events: Mutex<Vec<(u128, String, Value)>>,
    }

    impl TestEnv {
        /// Every event sent, as `name payload` lines.
        pub fn events(&self) -> Vec<String> {
            self.events
                .lock()
                .unwrap()
                .iter()
                .map(|(_, name, payload)| format!("{name} {payload}"))
                .collect()
        }

        pub fn event_times(&self, name: &str) -> Vec<u128> {
            self.events
                .lock()
                .unwrap()
                .iter()
                .filter(|(_, n, _)| n == name)
                .map(|(t, _, _)| *t)
                .collect()
        }

        pub fn query<T: rusqlite::types::FromSql>(&self, sql: &str) -> T {
            self.db
                .with(|conn| conn.query_row(sql, [], |row| row.get(0)))
                .unwrap()
        }

        pub fn exec(&self, sql: &str) {
            self.db.with(|conn| conn.execute_batch(sql)).unwrap();
        }

        fn push(&self, name: &str, payload: Value) {
            let at = self.started.elapsed().as_millis();
            self.events.lock().unwrap().push((at, name.into(), payload));
        }
    }

    impl Drop for TestEnv {
        fn drop(&mut self) {
            self.db.close();
            std::fs::remove_dir_all(&self.dir).ok();
        }
    }

    impl Env for TestEnv {
        fn db(&self) -> Option<&Database> {
            Some(&self.db)
        }

        fn champions(&self) -> Option<Arc<dyn Champions>> {
            Some(self.champions.clone())
        }

        fn now_ms(&self) -> i64 {
            NOW_MS
        }

        fn games_updated(&self) {
            self.push("lcu:games-updated", Value::Null);
        }

        fn backfill_progress(&self, progress: &BackfillProgress) {
            self.push(
                "lcu:backfill-progress",
                serde_json::to_value(progress).unwrap(),
            );
        }

        fn backfill_done(&self, outcome: &BackfillOutcome) {
            self.push("lcu:backfill-done", serde_json::to_value(outcome).unwrap());
        }
    }

    pub struct Rig {
        pub sync: Arc<GameSync>,
        pub client: Arc<FakeClient>,
        pub dyn_client: Arc<dyn Client>,
        pub sgp: Arc<FakeSgp>,
        pub env: Arc<TestEnv>,
    }

    /// A fresh database, a client signed in as `me`, and a match history
    /// service that serves nothing until a test says otherwise.
    pub fn rig(name: &str) -> Rig {
        let started = Instant::now();
        let dir = std::env::temp_dir().join(format!("bmt-sync-{name}-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        let env = Arc::new(TestEnv {
            started,
            db: Database::open(&dir, NOW_MS).unwrap(),
            dir,
            champions: Arc::new(TestChampions {
                classes: Mutex::new(ChampionClasses::none()),
                loaded: AtomicBool::new(false),
                notify: Notify::new(),
            }),
            events: Mutex::default(),
        });
        let client = Arc::new(FakeClient {
            started,
            routes: Mutex::default(),
            log: Mutex::default(),
            connected: AtomicBool::new(true),
            live: Mutex::default(),
        });
        client.route(SUMMONER_PATH, vec![Reply::Json(summoner())]);
        client.route(PHASE_PATH, vec![Reply::Json(json!("None"))]);
        client.route(
            "/lol-rso-auth/v1/authorization/access-token",
            vec![Reply::Json(json!({"token": "parity-fake-token"}))],
        );
        client.route(
            "/riotclient/region-locale",
            vec![Reply::Json(json!({"region": "NA"}))],
        );
        let sgp = Arc::new(FakeSgp {
            started,
            answer: Mutex::new(Box::new(|_| Reply::Json(json!([])))),
            log: Mutex::default(),
        });
        let sync = GameSync::new(env.clone(), sgp.clone(), Handle::current());
        Rig {
            sync,
            dyn_client: client.clone(),
            client,
            sgp,
            env,
        }
    }

    pub fn summoner() -> Value {
        json!({"puuid": "me", "gameName": "Me", "tagLine": "NA1", "summonerId": 1, "accountId": 2, "profileIconId": 3})
    }

    pub fn detail_path(game_id: i64) -> String {
        format!("/lol-match-history/v1/games/{game_id}")
    }

    /// A game `me` played, in `queue`, with two others.
    pub fn payload(game_id: i64, queue: i64) -> Value {
        let player = |id: i64, team: i64, win: bool, kills: i64| {
            json!({ "participantId": id, "championId": 10 + id, "teamId": team,
                "spell1Id": 4, "spell2Id": 32,
                "stats": { "win": win, "kills": kills, "deaths": 3, "assists": 7,
                    "totalDamageDealtToChampions": 15000 + id * 1000, "totalDamageTaken": 20000,
                    "goldEarned": 9000, "totalHeal": 4000, "largestKillingSpree": 2,
                    "item0": 1001, "item6": 3340, "playerAugment1": 77 } })
        };
        let identity = |puuid: &str| json!({ "player": { "puuid": puuid, "gameName": puuid, "tagLine": "NA1" } });
        json!({
            "gameId": game_id, "queueId": queue, "gameMode": "KIWI",
            "gameCreation": 1_790_000_000_000_i64 - game_id, "gameDuration": 1200,
            "gameVersion": "16.23.712.3456",
            "participants": [player(1, 100, true, 9), player(2, 100, true, 4), player(3, 200, false, 6)],
            "participantIdentities": [identity("me"), identity("ally"), identity("foe")],
        })
    }
}

#[cfg(test)]
mod tests {
    use super::rig::{Reply, Rig, detail_path, payload, rig, summoner};
    use super::*;
    use serde_json::json;

    const BY_PUUID: &str = "/lol-match-history/v1/products/lol/me/matches?begIndex=0&endIndex=19";
    const CURRENT: &str =
        "/lol-match-history/v1/products/lol/current-summoner/matches?begIndex=0&endIndex=19";

    fn list(rig: &Rig, entries: &[(i64, i64)]) {
        let games: Vec<Value> = entries
            .iter()
            .map(|(id, queue)| json!({"gameId": id, "queueId": queue}))
            .collect();
        rig.client.route(
            BY_PUUID,
            vec![Reply::Json(json!({"games": {"games": games}}))],
        );
    }

    fn count(rig: &Rig, table: &str) -> i64 {
        rig.env.query(&format!("SELECT count(*) FROM {table}"))
    }

    #[tokio::test(start_paused = true)]
    async fn the_recent_window_stores_new_games_and_ignores_other_queues() {
        let rig = rig("recent");
        rig.env
            .exec("INSERT INTO ignored_games (game_id) VALUES (3)");
        list(&rig, &[(1, 2400), (2, 450), (3, 2400), (4, 2450)]);
        rig.client
            .route(&detail_path(1), vec![Reply::Json(payload(1, 2400))]);
        // A detail that fails leaves the game for the next sync
        rig.client.route(&detail_path(4), vec![Reply::Status(500)]);

        let rolled = rig
            .sync
            .fetch_new_games(rig.client.as_ref(), None)
            .await
            .unwrap();
        assert!(!rolled);
        assert_eq!(count(&rig, "games"), 1);
        assert_eq!(count(&rig, "ignored_games"), 2);
        assert_eq!(rig.env.events(), ["lcu:games-updated null"]);
        assert_eq!(
            rig.env
                .query::<i64>("SELECT updated_at FROM summoner WHERE puuid = 'me'"),
            rig::NOW_MS,
            "the summoner row carries the frozen clock"
        );
        assert!(!rig.client.paths().contains(&detail_path(3)));
    }

    #[tokio::test(start_paused = true)]
    async fn a_failed_list_falls_back_to_the_current_summoner_and_then_gives_up_quietly() {
        let rig = rig("recent-fallback");
        rig.client.route(BY_PUUID, vec![Reply::Status(500)]);
        rig.client.route(
            CURRENT,
            vec![Reply::Json(
                json!({"games": [{"gameId": 9, "queueId": 450}]}),
            )],
        );
        rig.sync
            .fetch_new_games(rig.client.as_ref(), None)
            .await
            .unwrap();
        assert_eq!(count(&rig, "ignored_games"), 1);

        rig.client.route(CURRENT, vec![Reply::Status(500)]);
        assert!(
            !rig.sync
                .fetch_new_games(rig.client.as_ref(), None)
                .await
                .unwrap()
        );
        // A null answer is a throw, which restarts the connect loop
        rig.client.route(BY_PUUID, vec![Reply::Json(Value::Null)]);
        let err = rig
            .sync
            .fetch_new_games(rig.client.as_ref(), None)
            .await
            .unwrap_err();
        assert_eq!(
            err.to_string(),
            "Cannot read properties of null (reading 'games')"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_rolled_over_window_walks_history_without_the_full_flag() {
        let rig = rig("rolled-over");
        let entries: Vec<(i64, i64)> = (1..=20).map(|id| (id, 450)).collect();
        list(&rig, &entries);
        let ids: Vec<i64> = (1..=25).rev().collect();
        *rig.sgp.answer.lock().unwrap() = Box::new(move |_| {
            Reply::Json(json!(
                ids.iter().map(|id| format!("NA1_{id}")).collect::<Vec<_>>()
            ))
        });
        rig.sync.swept_for_test("\"me\"");
        rig.sync.sync_games(&rig.dyn_client).await.unwrap();
        // The walk found 25, of which the first 20 were just ignored
        assert_eq!(
            rig.client
                .paths()
                .iter()
                .filter(|p| p.starts_with("/lol-match-history/v1/games/"))
                .count(),
            // One for the window probe (game 1), then 21 to 25
            6
        );
    }

    #[tokio::test(start_paused = true)]
    async fn the_launch_sweep_waits_out_a_match_and_runs_once() {
        let rig = rig("sweep");
        rig.client.route(
            "/lol-gameflow/v1/gameflow-phase",
            vec![Reply::Json(json!("InProgress"))],
        );
        list(&rig, &[]);
        rig.sync.sync_games(&rig.dyn_client).await.unwrap();
        assert!(rig.sgp.urls().is_empty(), "no walk mid-match");

        assert_eq!(rig.client.times(BY_PUUID).len(), 1, "the window instead");

        rig.client.route(
            "/lol-gameflow/v1/gameflow-phase",
            vec![Reply::Json(json!("EndOfGame"))],
        );
        rig.sync.sync_games(&rig.dyn_client).await.unwrap();
        let walked = rig.sgp.urls().len();
        assert!(walked > 0);
        assert_eq!(
            rig.client.times(BY_PUUID).len(),
            1,
            "a sweep replaces the window"
        );

        rig.sync.sync_games(&rig.dyn_client).await.unwrap();
        assert_eq!(rig.sgp.urls().len(), walked, "once per launch");
        assert_eq!(rig.client.times(BY_PUUID).len(), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn a_failed_sweep_falls_back_and_waits_fifteen_minutes() {
        let rig = rig("sweep-fails");
        *rig.sgp.answer.lock().unwrap() = Box::new(|_| Reply::Status(500));
        rig.env
            .exec("INSERT INTO settings (key, value) VALUES ('sgp_host', 'https://usw2-red.pp.sgp.pvp.net')");
        list(&rig, &[]);
        rig.sync.sync_games(&rig.dyn_client).await.unwrap();
        assert_eq!(
            rig.env.events(),
            [r#"lcu:backfill-done {"error":"Match history service returned 500"}"#]
        );
        assert_eq!(rig.client.times(BY_PUUID).len(), 1);

        tokio::time::sleep(AUTO_BACKFILL_RETRY_DELAY - Duration::from_secs(1)).await;
        rig.sync.sync_games(&rig.dyn_client).await.unwrap();
        assert_eq!(rig.sgp.urls().len(), 1, "paused");
        tokio::time::sleep(Duration::from_secs(1)).await;
        rig.sync.sync_games(&rig.dyn_client).await.unwrap();
        assert_eq!(
            rig.sgp.urls().len(),
            2,
            "tried again once the pause is over"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn the_poll_steps_aside_while_a_backfill_runs() {
        let rig = rig("poll-aside");
        rig.sync.state().backfill_running = true;
        let hooks = SyncHooks(rig.sync.clone());
        // The hook needs no client to skip, so a transport that finds nothing will do
        let lcu = test_lcu();
        hooks.on_poll(&lcu).await.unwrap();
        assert!(rig.client.paths().is_empty());
        lcu.stop_polling();
    }

    fn test_lcu() -> Lcu {
        Lcu::new(super::super::LcuOptions {
            runtime: Handle::current(),
            discovery: super::super::Discovery {
                candidates: super::super::Candidates::Only(None),
                process: super::super::process_lookup::ProcessSource::file(None),
            },
            install_dir: Arc::new(super::super::MemoryInstallDir::default()),
            hooks: Arc::new(super::super::TransportOnly),
            emit: Box::new(|_| {}),
            timing: super::super::Timing::default(),
        })
    }

    #[tokio::test(start_paused = true)]
    async fn the_final_fetch_runs_the_recent_sync_only_while_connected() {
        let rig = rig("final-fetch");
        list(&rig, &[(1, 2400)]);
        rig.client
            .route(&detail_path(1), vec![Reply::Json(payload(1, 2400))]);
        rig.client
            .connected
            .store(false, std::sync::atomic::Ordering::SeqCst);
        assert!(rig.sync.final_fetch(rig.dyn_client.clone()).is_none());

        rig.client
            .connected
            .store(true, std::sync::atomic::Ordering::SeqCst);
        rig.sync
            .final_fetch(rig.dyn_client.clone())
            .unwrap()
            .await
            .unwrap();
        assert_eq!(count(&rig, "games"), 1);
        assert!(rig.sgp.urls().is_empty(), "no sweep on the way out");

        rig.client.route(SUMMONER_PATH, vec![Reply::Status(503)]);
        let err = rig.sync.final_fetch(rig.dyn_client.clone()).unwrap().await;
        assert_eq!(err, Err(format!("LCU request failed: 503 {SUMMONER_PATH}")));
    }

    #[tokio::test(start_paused = true)]
    async fn stored_scores_wait_for_champion_data_and_inserts_use_the_classes_of_the_moment() {
        let rig = rig("champions");
        let sync = rig.sync.clone();
        let backfill = tokio::spawn(async move { sync.score_backfill_when_champions_load().await });
        tokio::time::sleep(Duration::from_secs(5)).await;
        assert!(!backfill.is_finished(), "waits for champion data");
        assert_eq!(
            rig.env
                .query::<i64>("SELECT count(*) FROM settings WHERE key = 'score_formula_version'"),
            0
        );

        let mut classes = ChampionClasses {
            version: "16.23.1".into(),
            classes: Default::default(),
        };
        classes.classes.insert(11, "Mage".into());
        rig.env.champions.load(classes.clone());
        backfill.await.unwrap();
        assert_eq!(
            rig.env
                .query::<String>("SELECT value FROM settings WHERE key = 'score_formula_version'"),
            crate::db::scoring::score_formula_key(&classes)
        );
        assert_eq!(rig.env.events(), ["lcu:games-updated null"]);

        // A game stored now is scored with the loaded classes
        assert!(
            rig.sync
                .insert_game(&payload(1, 2400), Some(&json!("me")))
                .unwrap()
        );
        let with_none = {
            let other = rig::rig("champions-none");
            assert!(
                other
                    .sync
                    .insert_game(&payload(1, 2400), Some(&json!("me")))
                    .unwrap()
            );
            other.env.query::<f64>("SELECT score_raw FROM player_stats")
        };
        let rows = crate::db::payloads::participant_rows_from_raw(Some(&payload(1, 2400))).unwrap();
        let score_rows: Vec<crate::db::scoring::ScoreRow> = rows
            .iter()
            .map(crate::db::scoring::ScoreRow::from)
            .collect();
        let want = crate::db::scoring::compute_owner_score(
            &score_rows,
            Some("me"),
            None,
            &classes.classes,
        )
        .unwrap();
        let stored = rig.env.query::<f64>("SELECT score_raw FROM player_stats");
        assert_eq!(stored.to_bits(), want.raw.to_bits());
        assert_ne!(
            stored.to_bits(),
            with_none.to_bits(),
            "the classes changed the score"
        );
    }

    /// The `end-of-game` scenario through T19's transport over TLS: the poll
    /// defers the sweep mid-match, the socket's EndOfGame captures the game.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_game_that_ends_on_the_socket_is_stored_through_the_transport() {
        use super::super::test_support::{FakeClient, Reply as Wire, TempDir, TestCa, eventually};
        use super::super::{Candidates, Discovery, LcuStatus::*, Timing};
        let ca = TestCa::named("test root");
        let client = FakeClient::start(&ca.leaf(&["127.0.0.1"])).await;
        let dir = TempDir::new();
        client.write_lockfile(dir.path(), "pw");
        const GAME: i64 = 7_000_000_000;
        client.route(SUMMONER_PATH, Wire::Json(200, summoner()));
        client.route(PHASE_PATH, Wire::Json(200, json!("InProgress")));
        client.route(
            "/lol-match-history/v1/products/lol/me/matches",
            Wire::Json(200, json!({"games": {"games": []}})),
        );
        client.route(&detail_path(GAME), Wire::Json(200, payload(GAME, 2400)));

        let rig = rig("transport");
        let sent = Arc::new(Mutex::new(Vec::new()));
        let sink = sent.clone();
        let anchor = ca.cert();
        let lcu = Lcu::with_anchors(
            super::super::LcuOptions {
                runtime: Handle::current(),
                discovery: Discovery {
                    candidates: Candidates::Only(Some(dir.path().to_path_buf())),
                    process: super::super::process_lookup::ProcessSource::file(None),
                },
                install_dir: Arc::new(DbInstallDir(rig.sync.clone())),
                hooks: Arc::new(SyncHooks(rig.sync.clone())),
                emit: Box::new(move |status| sink.lock().unwrap().push(status)),
                timing: Timing {
                    connect_interval: Duration::from_millis(50),
                    ..Timing::default()
                },
            },
            Box::new(move || vec![anchor.clone()]),
        );
        let statuses = || sent.lock().unwrap().clone();
        lcu.start_polling(true);
        eventually("the attach phase", Duration::from_secs(10), || {
            statuses().ends_with(&[Ingame])
        })
        .await;
        eventually("the recent sync", Duration::from_secs(10), || {
            client
                .requests()
                .iter()
                .any(|r| r.path.contains("/matches?"))
        })
        .await;
        assert!(rig.sgp.urls().is_empty(), "the sweep waits out the match");

        client.publish(
            json!({"uri": "/lol-gameflow/v1/session", "eventType": "Update",
            "data": {"gameData": {"gameId": GAME, "queue": {"id": 2400}}}}),
        );
        client.route(PHASE_PATH, Wire::Json(200, json!("EndOfGame")));
        client.publish(json!({"uri": "/lol-gameflow/v1/gameflow-phase", "eventType": "Update", "data": "EndOfGame"}));
        eventually("the capture", Duration::from_secs(10), || {
            !rig.env.events().is_empty()
        })
        .await;
        assert_eq!(rig.env.events(), ["lcu:games-updated null"]);
        assert_eq!(
            rig.env.query::<i64>(&format!(
                "SELECT count(*) FROM games WHERE game_id = {GAME}"
            )),
            1
        );
        assert_eq!(statuses(), [Connecting, Connected, Ingame, Connected]);
        lcu.stop_polling();
    }

    #[test]
    fn friendly_messages_match_friendly_error_message() {
        assert_eq!(
            Thrown::Lcu(LcuError::NotFound).friendly(),
            "League client is not running"
        );
        assert_eq!(
            Thrown::Error("read ECONNRESET".into()).friendly(),
            "Lost connection to the League client"
        );
        assert_eq!(
            Thrown::SgpHttp(429).friendly(),
            "Match history service returned 429"
        );
        assert_eq!(
            Thrown::Error("fetch failed".into()).friendly(),
            "fetch failed"
        );
    }

    #[test]
    fn numbers_read_as_javascript_reads_them() {
        assert_eq!(js_number_of_str("0b101"), 5.0);
        assert_eq!(js_number_of_str("0o17"), 15.0);
        assert_eq!(js_number_of_str("-0x10").to_bits(), f64::NAN.to_bits());
        assert_eq!(js_number_of_str("1e3"), 1000.0);
        assert_eq!(js_number_of_str("-Infinity"), f64::NEG_INFINITY);
        assert!(js_number_of_str("infinity").is_nan());
        assert!(js_number_of_str("NaN").is_nan());
        assert_eq!(js_number(Some(&json!([7]))), 7.0);
        assert_eq!(template(Some(&json!([1, null, "a"]))), "1,,a");
        assert_eq!(template(Some(&summoner())), "[object Object]");
    }
}
