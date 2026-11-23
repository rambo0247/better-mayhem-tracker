//! The Live Game tab's data, `src/main/live.ts`: a snapshot of the running
//! match built from the client's gameflow session and the game's own API on
//! port 2999, polled every 3 s while the client says a match is on, and the
//! map it was rolled onto written down the first time it shows. Also the two
//! "is a game going on" checks the updater (T24) asks before a restart.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::future::BoxFuture;
use serde_json::Value;
use tokio::runtime::Handle;
use tokio::sync::broadcast;
use tokio::task::JoinHandle;
use tokio::time::Instant;

use crate::assets::log;
use crate::challenges::ChallengeTracker;
use crate::commands::CommandError;
use crate::commands::live::{
    ChallengesResult, LiveEvent, LiveEventTone, LiveGameSnapshot, LivePlayer,
};
use crate::db::Database;
use crate::db::js::{self, TypeError, nullish, opt_prop, or, prop, truthy};
use crate::db::live::{PlayerHistory, PlayerRef, get_player_histories, set_game_map};
use crate::dragon::{ChampionData, SummonerSpellData};
use crate::lcu::LcuStatus;
use crate::lcu::sync::{Client, js_number, template};

/// `LIVE_POLL_INTERVAL_MS`.
pub const POLL_INTERVAL: Duration = Duration::from_millis(3_000);
/// `LIVE_TIMEOUT_MS`: Node's socket idle timeout on the request.
const REQUEST_TIMEOUT: Duration = Duration::from_millis(4_000);
/// `MAX_EVENTS`: enough of the feed to catch up after looking away.
const MAX_EVENTS: usize = 40;
const MULTIKILL_NAMES: [&str; 6] = [
    "",
    "",
    "Double Kill",
    "Triple Kill",
    "Quadra Kill",
    "PENTAKILL",
];
/// Champion select through the end of the game itself.
#[cfg_attr(
    not(any(test, feature = "parity-driver")),
    expect(dead_code, reason = "T24's updater asks it")
)]
const MATCH_PHASES: [&str; 4] = ["ChampSelect", "GameStart", "InProgress", "Reconnect"];

pub const ALL_GAME_DATA_PATH: &str = "/liveclientdata/allgamedata";
#[cfg_attr(
    not(any(test, feature = "parity-driver")),
    expect(dead_code, reason = "T24's updater asks it")
)]
pub const GAME_STATS_PATH: &str = "/liveclientdata/gamestats";
pub const SESSION_PATH: &str = "/lol-gameflow/v1/session";
#[cfg_attr(
    not(any(test, feature = "parity-driver")),
    expect(dead_code, reason = "T24's updater asks it")
)]
const PHASE_PATH: &str = "/lol-gameflow/v1/gameflow-phase";

static EMPTY: Value = Value::String(String::new());

// ---------------------------------------------------------------------------
// JavaScript semantics the snapshot leans on

/// `String(value ?? "")`.
pub(crate) fn text(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        some => template(some),
    }
}

/// `String.prototype.trim`: JavaScript's white space and line terminators,
/// which add U+FEFF to Rust's set and leave out U+0085.
pub(crate) fn js_trim(text: &str) -> &str {
    text.trim_matches(|c: char| c == '\u{feff}' || (c != '\u{85}' && c.is_whitespace()))
}

/// `Number(x) || fallback`, `None` standing for `null`.
fn or_number(x: f64, fallback: Option<f64>) -> Option<f64> {
    if x != 0.0 && !x.is_nan() {
        Some(x)
    } else {
        fallback
    }
}

/// `Number(x) || 0`.
fn number_or_zero(value: Option<&Value>) -> f64 {
    or_number(js_number(value), None).unwrap_or(0.0)
}

/// `Object.values(value)` for parsed JSON, in JavaScript's property order:
/// array index keys ascending, then the rest as they were written.
pub(crate) fn object_values(value: &Value) -> Vec<&Value> {
    match value {
        Value::Array(items) => items.iter().collect(),
        Value::Object(map) => {
            let mut indexed: Vec<(u32, &Value)> = Vec::new();
            let mut named = Vec::new();
            for (key, item) in map {
                match key.parse::<u32>() {
                    Ok(index) if index < u32::MAX && index.to_string() == *key => {
                        indexed.push((index, item));
                    }
                    _ => named.push(item),
                }
            }
            indexed.sort_by_key(|(index, _)| *index);
            indexed
                .into_iter()
                .map(|(_, item)| item)
                .chain(named)
                .collect()
        }
        _ => Vec::new(),
    }
}

/// `for (const x of value ?? [])` and `[...(value ?? [])]`: an array's
/// items, a string's characters, nothing for `null` or `undefined`, and the
/// `TypeError` for anything else.
pub(crate) fn iterate(value: Option<&Value>, name: &str) -> Result<Vec<Value>, TypeError> {
    match value {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Array(items)) => Ok(items.clone()),
        Some(Value::String(s)) => Ok(s.chars().map(|c| Value::String(c.into())).collect()),
        Some(_) => Err(TypeError(format!("{name} is not iterable"))),
    }
}

/// `value === "x"` for any of the names.
fn is_one_of(value: Option<&Value>, names: &[&str]) -> bool {
    value
        .and_then(Value::as_str)
        .is_some_and(|value| names.contains(&value))
}

/// A case-insensitive ASCII prefix, as `/^Prefix/i` tests one.
fn starts_with_ignore_case(text: &str, prefix: &str) -> bool {
    text.get(..prefix.len())
        .is_some_and(|head| head.eq_ignore_ascii_case(prefix))
}

/// JavaScript's `.`: anything but a line terminator.
fn is_line_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// The `(.+)` of `/^GeneratedTip_SummonerSpell_(.+)_DisplayName$/i`.
fn spell_key(raw: &str) -> Option<&str> {
    const PREFIX: &str = "GeneratedTip_SummonerSpell_";
    const SUFFIX: &str = "_DisplayName";
    if raw.len() < PREFIX.len() + SUFFIX.len() + 1 || !starts_with_ignore_case(raw, PREFIX) {
        return None;
    }
    let tail = raw.get(raw.len() - SUFFIX.len()..)?;
    if !tail.eq_ignore_ascii_case(SUFFIX) {
        return None;
    }
    let key = raw.get(PREFIX.len()..raw.len() - SUFFIX.len())?;
    (!key.is_empty() && !key.chars().any(is_line_terminator)).then_some(key)
}

/// `mapNameForSkin` from `src/shared/maps.ts`.
pub fn map_name_for_skin(skin: &str) -> Option<String> {
    if skin.is_empty() {
        return None;
    }
    Some(match skin {
        "Default" => "Howling Abyss".into(),
        "Bilgewater" => "Butcher's Bridge".into(),
        "Bloom" => "Koeshin's Crossing".into(),
        other => other.replace('_', " "),
    })
}

/// A number in a template literal, where non-finite values print by name.
fn number_text(x: f64) -> String {
    match x {
        x if x.is_nan() => "NaN".into(),
        f64::INFINITY => "Infinity".into(),
        f64::NEG_INFINITY => "-Infinity".into(),
        x => js::number_to_string(x),
    }
}

/// A name set apart from the sentence around it with Unicode isolates, so a
/// right-to-left name can't pull the words beside it over to its side.
fn isolate(name: &str) -> String {
    format!("\u{2068}{name}\u{2069}")
}

// ---------------------------------------------------------------------------
// The game's own API on port 2999

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GameApiError {
    /// `ECONNREFUSED`: nothing is listening, so no game is running
    Refused,
    Failed(String),
}

impl std::fmt::Display for GameApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Refused => f.write_str("connect ECONNREFUSED 127.0.0.1:2999"),
            Self::Failed(message) => f.write_str(message),
        }
    }
}

/// `liveRequest`: one GET to the running match's API.
pub trait GameApi: Send + Sync {
    fn get<'a>(&'a self, path: &'a str) -> BoxFuture<'a, Result<Value, GameApiError>>;
}

/// Where the API is reached. Only a release build, or a debug build told
/// so, ever names port 2999; a parity build names the fake's port or
/// nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GameApiTarget {
    Port(u16),
    /// Every request fails as a refused connection, and none is made
    Refused,
}

#[cfg(feature = "parity-ca")]
pub const PARITY_LIVE_PORT_ENV: &str = "BMT_PARITY_LIVE_PORT";

impl GameApiTarget {
    const LIVE_PORT: u16 = 2999;

    #[cfg(feature = "parity-ca")]
    pub fn from_env() -> Self {
        Self::parity(std::env::var(PARITY_LIVE_PORT_ENV).ok().as_deref())
    }

    /// The fake live client's port, as the seam redirects Electron's 2999
    /// requests, or no request at all. Never 2999 itself, which is a real
    /// game's.
    #[cfg(feature = "parity-ca")]
    fn parity(port: Option<&str>) -> Self {
        match port
            .and_then(|port| port.parse::<u16>().ok())
            .filter(|p| *p != 0 && *p != Self::LIVE_PORT)
        {
            Some(port) => Self::Port(port),
            None => {
                log(format!(
                    "parity: in-game API requests are refused; set {PARITY_LIVE_PORT_ENV} to a fake live client's port"
                ));
                Self::Refused
            }
        }
    }

    #[cfg(all(debug_assertions, not(feature = "parity-ca")))]
    pub fn from_env() -> Self {
        Self::debug(std::env::var_os(crate::lcu::ALLOW_REAL_LEAGUE_ENV).as_deref())
    }

    /// A debug build runs where someone may be playing, so it leaves the game
    /// alone unless told otherwise, as T19's discovery does.
    #[cfg(all(debug_assertions, not(feature = "parity-ca")))]
    fn debug(allow: Option<&std::ffi::OsStr>) -> Self {
        if allow == Some("1".as_ref()) {
            return Self::Port(Self::LIVE_PORT);
        }
        log(format!(
            "In-game API requests are off in debug builds; set {}=1 to reach a real game",
            crate::lcu::ALLOW_REAL_LEAGUE_ENV
        ));
        Self::Refused
    }

    #[cfg(all(not(debug_assertions), not(feature = "parity-ca")))]
    pub fn from_env() -> Self {
        Self::Port(Self::LIVE_PORT)
    }
}

/// The API over HTTPS. The game serves Riot's own self-signed certificate, and
/// Electron requests it with `rejectUnauthorized: false`, so this checks the
/// handshake signatures and not the chain. It only ever talks to 127.0.0.1.
pub struct HttpGameApi {
    target: GameApiTarget,
    http: Result<reqwest::Client, String>,
}

impl HttpGameApi {
    pub fn new(target: GameApiTarget) -> Self {
        let http = unverified_config().and_then(|tls| {
            reqwest::Client::builder()
                .tls_backend_preconfigured(tls)
                .http1_only()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(REQUEST_TIMEOUT)
                .read_timeout(REQUEST_TIMEOUT)
                .build()
                .map_err(|err| err.to_string())
        });
        Self { target, http }
    }

    async fn request(&self, port: u16, path: &str) -> Result<Value, GameApiError> {
        let http = self
            .http
            .as_ref()
            .map_err(|err| GameApiError::Failed(err.clone()))?;
        let response = http
            .get(format!("https://127.0.0.1:{port}{path}"))
            .send()
            .await
            .map_err(transport_error)?;
        let status = response.status().as_u16();
        let body = response.bytes().await.map_err(transport_error)?;
        if status != 200 {
            return Err(GameApiError::Failed(format!(
                "In-game API returned {status}"
            )));
        }
        // setEncoding("utf8") replaces bad bytes, and JSON.parse keeps a BOM
        serde_json::from_str(&String::from_utf8_lossy(&body))
            .map_err(|err| GameApiError::Failed(err.to_string()))
    }
}

impl GameApi for HttpGameApi {
    fn get<'a>(&'a self, path: &'a str) -> BoxFuture<'a, Result<Value, GameApiError>> {
        Box::pin(async move {
            match self.target {
                GameApiTarget::Refused => Err(GameApiError::Refused),
                GameApiTarget::Port(port) => self.request(port, path).await,
            }
        })
    }
}

fn transport_error(err: reqwest::Error) -> GameApiError {
    let mut source: Option<&dyn std::error::Error> = Some(&err);
    while let Some(cause) = source {
        if let Some(io) = cause.downcast_ref::<std::io::Error>()
            && io.kind() == std::io::ErrorKind::ConnectionRefused
        {
            return GameApiError::Refused;
        }
        source = cause.source();
    }
    if err.is_timeout() {
        return GameApiError::Failed("In-game API request timed out".into());
    }
    GameApiError::Failed(err.to_string())
}

/// Node's `rejectUnauthorized: false`: any chain, any name, and the
/// handshake still signed by the certificate's key.
fn unverified_config() -> Result<rustls::ClientConfig, String> {
    use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
    use rustls::crypto::CryptoProvider;
    use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
    use rustls::{DigitallySignedStruct, SignatureScheme};

    #[derive(Debug)]
    struct AnyChain(Arc<CryptoProvider>);

    impl ServerCertVerifier for AnyChain {
        fn verify_server_cert(
            &self,
            _end_entity: &CertificateDer<'_>,
            _intermediates: &[CertificateDer<'_>],
            _server_name: &ServerName<'_>,
            _ocsp_response: &[u8],
            _now: UnixTime,
        ) -> Result<ServerCertVerified, rustls::Error> {
            Ok(ServerCertVerified::assertion())
        }

        fn verify_tls12_signature(
            &self,
            message: &[u8],
            cert: &CertificateDer<'_>,
            dss: &DigitallySignedStruct,
        ) -> Result<HandshakeSignatureValid, rustls::Error> {
            rustls::crypto::verify_tls12_signature(
                message,
                cert,
                dss,
                &self.0.signature_verification_algorithms,
            )
        }

        fn verify_tls13_signature(
            &self,
            message: &[u8],
            cert: &CertificateDer<'_>,
            dss: &DigitallySignedStruct,
        ) -> Result<HandshakeSignatureValid, rustls::Error> {
            rustls::crypto::verify_tls13_signature(
                message,
                cert,
                dss,
                &self.0.signature_verification_algorithms,
            )
        }

        fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
            self.0.signature_verification_algorithms.supported_schemes()
        }
    }

    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut config = rustls::ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .map_err(|err| err.to_string())?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(AnyChain(provider)))
        .with_no_client_auth();
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(config)
}

/// `isGameRunning`: a game is running unless the connection is refused. The
/// API answers non-200 while the game loads, and a probe that fails some
/// other way is no proof the game is gone.
#[cfg_attr(
    not(any(test, feature = "parity-driver")),
    expect(dead_code, reason = "T24's updater asks it")
)]
pub async fn is_game_running(game: &dyn GameApi) -> bool {
    game.get(GAME_STATS_PATH).await != Err(GameApiError::Refused)
}

/// `isMatchUnderway` from `lcu.ts`: champion select through the end of the
/// game itself, the stretch a restart would pull the app out from under.
#[cfg_attr(
    not(any(test, feature = "parity-driver")),
    expect(dead_code, reason = "T24's updater asks it")
)]
pub async fn is_match_underway(client: &dyn Client) -> bool {
    if !client.is_client_connected() {
        return false;
    }
    let phase = client.request_json(PHASE_PATH).await.ok();
    is_one_of(phase.as_ref(), &MATCH_PHASES)
}

// ---------------------------------------------------------------------------
// What the trackers read and tell outside the client

/// The database, the wall clock, champion and spell data, and the two events.
/// The app's is [`AppEnv`]; tests hold their own.
pub trait TrackingEnv: Send + Sync {
    fn db(&self) -> Option<&Database>;
    /// `Date.now()`, T08's clock in the app.
    fn now_ms(&self) -> i64;
    /// `getChampionData()`: whatever is loaded right now.
    fn champion_data(&self) -> ChampionData;
    /// `loadSummonerSpellKeys()`.
    fn spell_keys(&self) -> BoxFuture<'_, Option<Arc<HashMap<String, i64>>>>;
    /// `loadSummonerSpellData()`.
    fn spell_data(&self) -> BoxFuture<'_, Option<Arc<SummonerSpellData>>>;
    fn live_changed(&self, snapshot: &LiveGameSnapshot);
    fn challenges_changed(&self, result: &ChallengesResult);
}

/// A query on the database, failing as better-sqlite3 throws: closed, or
/// SQLite's own error.
pub(crate) fn query<T>(
    env: &dyn TrackingEnv,
    f: impl FnOnce(&rusqlite::Connection) -> rusqlite::Result<T>,
) -> Result<T, CommandError> {
    match env.db() {
        Some(db) => db.with(f),
        None => Err(CommandError {
            name: "TypeError".into(),
            message: "The database connection is not open".into(),
            code: None,
        }),
    }
}

/// [`query`] for code that only logs the failure, as `console.log` prints it.
pub(crate) fn with_db<T>(
    env: &dyn TrackingEnv,
    f: impl FnOnce(&rusqlite::Connection) -> rusqlite::Result<T>,
) -> Result<T, String> {
    query(env, f).map_err(|err| format!("{}: {}", err.name, err.message))
}

// ---------------------------------------------------------------------------
// The roster the client knows

/// What the client knows about one player: the in-game API never reports a
/// puuid, so this is the only route to one.
#[derive(Debug, Clone, PartialEq)]
struct RosterEntry {
    puuid: Option<String>,
    champion_id: f64,
    spell1: Option<f64>,
    spell2: Option<f64>,
}

/// `rosterNameKeys`: every identifier the player goes by, lowercased.
fn roster_name_keys(player: Option<&Value>) -> Vec<String> {
    let mut keys = Vec::new();
    let mut push = |value: Option<&Value>| {
        let text = js_trim(&text(value)).to_lowercase();
        if !text.is_empty() {
            keys.push(text);
        }
    };
    let field = |key| opt_prop(player, key);
    push(field("riotId"));
    let name = nullish(&[field("gameName"), field("riotIdGameName")]);
    if truthy(name) {
        let tag = nullish(&[field("tagLine"), field("riotIdTagLine")]);
        if truthy(tag) {
            let joined = Value::String(format!("{}#{}", template(name), template(tag)));
            push(Some(&joined));
        } else {
            push(name);
        }
        push(name);
    }
    push(field("summonerName"));
    push(field("summonerInternalName"));
    keys
}

/// `Number(x) || null`.
fn number_or_null(value: Option<&Value>) -> Option<f64> {
    or_number(js_number(value), None)
}

/// `buildLcuRoster`: the team rows and the champion-select rows, merged per
/// name so neither overwrites a field with nothing.
fn build_roster(session: Option<&Value>) -> Result<HashMap<String, RosterEntry>, TypeError> {
    let mut roster: HashMap<String, RosterEntry> = HashMap::new();
    let mut add = |player: &Value, champion_id: f64| {
        let player = Some(player);
        let entry = RosterEntry {
            puuid: opt_prop(player, "puuid")
                .and_then(Value::as_str)
                .filter(|p| !p.is_empty())
                .map(str::to_owned),
            champion_id,
            spell1: number_or_null(opt_prop(player, "spell1Id")),
            spell2: number_or_null(opt_prop(player, "spell2Id")),
        };
        for key in roster_name_keys(player) {
            let merged = match roster.get(&key) {
                Some(existing) => RosterEntry {
                    puuid: existing.puuid.clone().or_else(|| entry.puuid.clone()),
                    champion_id: or_number(existing.champion_id, Some(entry.champion_id))
                        .unwrap_or(entry.champion_id),
                    spell1: existing.spell1.or(entry.spell1),
                    spell2: existing.spell2.or(entry.spell2),
                },
                None => entry.clone(),
            };
            roster.insert(key, merged);
        }
    };
    let game_data = opt_prop(session, "gameData");
    let mut players = iterate(opt_prop(game_data, "teamOne"), "gameData.teamOne")?;
    players.extend(iterate(opt_prop(game_data, "teamTwo"), "gameData.teamTwo")?);
    for player in &players {
        add(player, number_or_zero(opt_prop(Some(player), "championId")));
    }
    let selections = iterate(
        opt_prop(game_data, "playerChampionSelections"),
        "gameData.playerChampionSelections",
    )?;
    for selection in &selections {
        add(
            selection,
            number_or_zero(opt_prop(Some(selection), "championId")),
        );
    }
    Ok(roster)
}

fn lookup_roster<'a>(
    roster: &'a HashMap<String, RosterEntry>,
    player: &Value,
) -> Option<&'a RosterEntry> {
    roster_name_keys(Some(player))
        .iter()
        .find_map(|key| roster.get(key))
}

// ---------------------------------------------------------------------------
// The kill feed

/// The name an event actor goes by in the feed.
fn event_actor(name: Option<&Value>, by_name: &HashMap<String, (String, String)>) -> String {
    let raw = text(name);
    if let Some((champion, player)) = by_name.get(&raw.to_lowercase()) {
        return isolate(if champion.is_empty() {
            player
        } else {
            champion
        });
    }
    // Structures arrive as their object ids, e.g. "Turret_T1_C_05_A"
    if starts_with_ignore_case(&raw, "Turret_") {
        return "a turret".into();
    }
    if starts_with_ignore_case(&raw, "Barracks_") {
        return "an inhibitor".into();
    }
    if starts_with_ignore_case(&raw, "Minion_") {
        return "a minion".into();
    }
    match raw.split('#').next() {
        Some(game_name) if !game_name.is_empty() => isolate(game_name),
        _ => "someone".into(),
    }
}

/// `describeEvent`: the events worth a line, in the feed's words.
fn describe_event(event: &Value, by_name: &HashMap<String, (String, String)>) -> Option<LiveEvent> {
    let event = Some(event);
    let field = |key| opt_prop(event, key);
    let raw_id = js_number(field("EventID"));
    let time = number_or_zero(field("EventTime"));
    let id = if raw_id.is_finite() { raw_id } else { time };
    let actor = |key| event_actor(field(key), by_name);
    let (tone, text) = match template(field("EventName")).as_str() {
        "FirstBlood" => (
            LiveEventTone::Special,
            format!("First blood: {}", actor("Recorder")),
        ),
        "ChampionKill" => {
            let assists = field("Assisters")
                .and_then(Value::as_array)
                .map_or(0, Vec::len);
            let tail = if assists > 0 {
                format!(" (+{assists})")
            } else {
                String::new()
            };
            (
                LiveEventTone::Kill,
                format!(
                    "{} killed {}{tail}",
                    actor("KillerName"),
                    actor("VictimName")
                ),
            )
        }
        "Multikill" => {
            let streak = number_or_zero(field("KillStreak"));
            let named = (streak.fract() == 0.0 && (0.0..6.0).contains(&streak))
                .then(|| MULTIKILL_NAMES[streak as usize])
                .filter(|name| !name.is_empty());
            let label =
                named.map_or_else(|| format!("{} kills", number_text(streak)), str::to_owned);
            (
                LiveEventTone::Special,
                format!("{}: {label}", actor("KillerName")),
            )
        }
        "Ace" => (LiveEventTone::Special, format!("Ace by {}", actor("Acer"))),
        "FirstBrick" => (
            LiveEventTone::Objective,
            format!("First tower: {}", actor("KillerName")),
        ),
        "TurretKilled" => (
            LiveEventTone::Objective,
            format!("{} destroyed a turret", actor("KillerName")),
        ),
        "InhibKilled" => (
            LiveEventTone::Objective,
            format!("{} destroyed an inhibitor", actor("KillerName")),
        ),
        // GameStart, MinionsSpawning, InhibRespawned, and anything Riot adds
        _ => return None,
    };
    Some(LiveEvent {
        id: id as i64,
        time,
        text,
        tone,
    })
}

// ---------------------------------------------------------------------------
// The tracker

/// Spell ids by the internal name and, for an English client, by the display
/// name, each set once its load settles.
#[derive(Default)]
struct SpellIds {
    by_key: Option<Arc<HashMap<String, i64>>>,
    by_name: Option<HashMap<String, i64>>,
}

impl SpellIds {
    /// `resolveSpellId`.
    fn resolve(&self, spell: Option<&Value>) -> Option<i64> {
        let raw = text(opt_prop(spell, "rawDisplayName"));
        if let Some(key) = spell_key(&raw)
            && let Some(id) = self
                .by_key
                .as_ref()
                .and_then(|keys| keys.get(&key.to_lowercase()))
            && *id != 0
        {
            return Some(*id);
        }
        let name = text(opt_prop(spell, "displayName")).to_lowercase();
        if name.is_empty() {
            return None;
        }
        self.by_name.as_ref()?.get(&name).copied()
    }
}

/// Records don't change mid-game, so they're looked up once per roster.
struct RecordCache {
    signature: String,
    histories: HashMap<String, PlayerHistory>,
}

struct LiveState {
    latest: LiveGameSnapshot,
    record_cache: Option<RecordCache>,
    /// The game whose map is already written
    stored_map_for: Option<f64>,
    poll: Option<JoinHandle<()>>,
}

pub struct LiveTracker {
    client: Arc<dyn Client>,
    game: Arc<dyn GameApi>,
    env: Arc<dyn TrackingEnv>,
    runtime: Handle,
    refreshing: AtomicBool,
    /// Whether events reach the window: `win` is set by `startLiveTracking`
    emitting: AtomicBool,
    state: Mutex<LiveState>,
    spells: Mutex<SpellIds>,
}

/// Clears the one-at-a-time flag however the refresh ends.
struct Refreshing<'a>(&'a AtomicBool);

impl Drop for Refreshing<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// `emptySnapshot`, for the live game ref as it stands.
fn empty_snapshot(reference: Option<crate::lcu::LiveGameRef>) -> LiveGameSnapshot {
    LiveGameSnapshot {
        in_game: false,
        starting: false,
        game_id: whole(reference.map(|r| r.game_id)),
        queue_id: whole(reference.map(|r| r.queue_id)),
        map_id: None,
        map_name: None,
        map_skin: None,
        game_time: 0.0,
        players: Vec::new(),
        events: Vec::new(),
    }
}

fn whole(x: Option<f64>) -> Option<i64> {
    x.filter(|x| !x.is_nan()).map(|x| x as i64)
}

impl LiveTracker {
    pub fn new(
        client: Arc<dyn Client>,
        game: Arc<dyn GameApi>,
        env: Arc<dyn TrackingEnv>,
        runtime: Handle,
    ) -> Arc<Self> {
        // `let latest = emptySnapshot()` runs once, at module load
        let latest = empty_snapshot(client.live_game_ref());
        Arc::new(Self {
            client,
            game,
            env,
            runtime,
            refreshing: AtomicBool::new(false),
            emitting: AtomicBool::new(false),
            state: Mutex::new(LiveState {
                latest,
                record_cache: None,
                stored_map_for: None,
                poll: None,
            }),
            spells: Mutex::default(),
        })
    }

    /// `emptySnapshot`. The game id outlives its match, which is what lets the
    /// page switch over to that game's recap the moment it ends.
    fn empty_snapshot(&self) -> LiveGameSnapshot {
        empty_snapshot(self.client.live_game_ref())
    }

    /// `getLiveGame`: the last snapshot published.
    pub fn latest(&self) -> LiveGameSnapshot {
        self.state.lock().expect("live lock").latest.clone()
    }

    fn publish(&self, snapshot: LiveGameSnapshot) {
        self.state.lock().expect("live lock").latest = snapshot.clone();
        if self.emitting.load(Ordering::SeqCst) {
            self.env.live_changed(&snapshot);
        }
    }

    /// `refreshLiveGame`: one refresh at a time, so two ticks never ask the
    /// same question twice and publish out of order. A failure publishes an
    /// empty snapshot rather than stale players.
    pub async fn refresh(&self) -> LiveGameSnapshot {
        if self.refreshing.swap(true, Ordering::SeqCst) {
            return self.latest();
        }
        self.refresh_claimed().await
    }

    /// The refresh once the one-at-a-time flag is taken.
    async fn refresh_claimed(&self) -> LiveGameSnapshot {
        let _refreshing = Refreshing(&self.refreshing);
        match self.build_snapshot().await {
            Ok(snapshot) => {
                self.publish(snapshot.clone());
                snapshot
            }
            Err(err) => {
                log(format!("Live game refresh failed: {err}"));
                self.publish(self.empty_snapshot());
                self.latest()
            }
        }
    }

    /// `void refreshLiveGame()`: the flag is taken here, as the async
    /// function takes it before its first await, so a call that lands before
    /// the task runs answers with the last snapshot.
    fn spawn_refresh(self: &Arc<Self>) {
        if self.refreshing.swap(true, Ordering::SeqCst) {
            return;
        }
        let this = self.clone();
        self.runtime.spawn(async move {
            this.refresh_claimed().await;
        });
    }

    /// `playerHistories`, cached per roster.
    fn player_histories(
        &self,
        game_id: Option<f64>,
        players: &[LivePlayer],
    ) -> Result<HashMap<String, PlayerHistory>, String> {
        let signature = format!(
            "{}:{}",
            game_id.map_or("null".into(), js::number_to_string),
            players
                .iter()
                .map(|p| format!("{}@{}", p.key, p.champion_id))
                .collect::<Vec<_>>()
                .join("|")
        );
        if let Some(cache) = &self.state.lock().expect("live lock").record_cache
            && cache.signature == signature
        {
            return Ok(cache.histories.clone());
        }
        let refs: Vec<PlayerRef> = players
            .iter()
            .map(|p| PlayerRef {
                key: p.key.clone(),
                puuid: p.puuid.clone(),
                game_name: Some(p.name.clone()),
                tag_line: p.tag_line.clone(),
                champion_id: p.champion_id as f64,
            })
            .collect();
        let histories = with_db(self.env.as_ref(), |conn| get_player_histories(conn, &refs))?;
        self.state.lock().expect("live lock").record_cache = Some(RecordCache {
            signature,
            histories: histories.clone(),
        });
        Ok(histories)
    }

    /// `buildSnapshot`.
    async fn build_snapshot(&self) -> Result<LiveGameSnapshot, String> {
        let reference = self.client.live_game_ref();
        let mut game_id = reference.map(|r| r.game_id);
        let mut queue_id = reference.map(|r| r.queue_id);
        let mut map_id = None;

        let session = self.client.request_json(SESSION_PATH).await.ok();
        let session = session.as_ref();
        let game_data = opt_prop(session, "gameData");
        if truthy(game_data) {
            game_id = or_number(js_number(opt_prop(game_data, "gameId")), game_id);
            let queue = opt_prop(opt_prop(game_data, "queue"), "id");
            queue_id = or_number(js_number(queue), queue_id);
            map_id = number_or_null(opt_prop(opt_prop(session, "map"), "id"));
        }

        // The game's API only exists while a match is running
        let data = self.game.get(ALL_GAME_DATA_PATH).await.ok();
        let data = data.as_ref();
        let all_players = match opt_prop(data, "allPlayers") {
            Some(Value::Array(players)) => players.as_slice(),
            _ => &[],
        };
        let mut snapshot = LiveGameSnapshot {
            in_game: false,
            starting: false,
            game_id: whole(game_id),
            queue_id: whole(queue_id),
            map_id: whole(map_id),
            map_name: None,
            map_skin: None,
            game_time: 0.0,
            players: Vec::new(),
            events: Vec::new(),
        };
        if all_players.is_empty() {
            // The loading screen is up: the client knows there is a game, the
            // game itself is not answering yet
            snapshot.starting = is_one_of(opt_prop(session, "phase"), &["InProgress", "GameStart"]);
            return Ok(snapshot);
        }

        let game = opt_prop(data, "gameData");
        snapshot.in_game = true;
        snapshot.game_time = number_or_zero(opt_prop(game, "gameTime")).floor();
        let (map_skin, map_name) = match nullish(&[opt_prop(game, "mapTerrain")]) {
            Some(Value::String(skin)) => (Some(skin.clone()), map_name_for_skin(skin)),
            // A falsy skin names nothing, and anything else has no replace()
            skin if !truthy(skin) => (None, None),
            _ => return Err("TypeError: skin.replace is not a function".into()),
        };
        snapshot.map_name = map_name;
        map_id = or_number(js_number(opt_prop(game, "mapNumber")), map_id);
        snapshot.map_id = whole(map_id);

        let roster = build_roster(session).map_err(|err| format!("TypeError: {err}"))?;
        let active = opt_prop(data, "activePlayer");
        let active_name = text(nullish(&[
            opt_prop(active, "riotId"),
            opt_prop(active, "summonerName"),
        ]))
        .to_lowercase();

        let mut champion_lookup: Option<HashMap<String, i64>> = None;
        let mut players = Vec::with_capacity(all_players.len());
        for player in all_players {
            players.push(self.live_player(player, &roster, &active_name, &mut champion_lookup)?);
        }

        let histories = self.player_histories(game_id, &players)?;
        for player in &mut players {
            let Some(history) = histories.get(&player.key) else {
                continue;
            };
            player.champion_record = history.champion.clone();
            player.overall_record = history.overall.clone();
            player.games_with_us = history.with_us as i64;
            player.friend_key = history.friend_key.clone();
        }

        let mut by_name: HashMap<String, (String, String)> = HashMap::new();
        for player in &players {
            let names = (player.champion_name.clone(), player.name.clone());
            by_name.insert(player.name.to_lowercase(), names.clone());
            if let Some(tag) = &player.tag_line {
                by_name.insert(format!("{}#{tag}", player.name).to_lowercase(), names);
            }
        }
        let feed = opt_prop(opt_prop(data, "events"), "Events");
        let mut events: Vec<LiveEvent> = iterate(feed, "data.events.Events")
            .map_err(|err| format!("TypeError: {err}"))?
            .iter()
            .filter_map(|event| describe_event(event, &by_name))
            .collect();
        events.drain(..events.len().saturating_sub(MAX_EVENTS));
        snapshot.events = events;
        snapshot.players = players;

        if let (Some(id), Some(skin)) = (game_id.filter(|id| *id != 0.0), map_skin.as_deref())
            && !skin.is_empty()
            && self.state.lock().expect("live lock").stored_map_for != Some(id)
        {
            with_db(self.env.as_ref(), |conn| {
                set_game_map(conn, id, map_id, skin)
            })?;
            self.state.lock().expect("live lock").stored_map_for = Some(id);
        }
        snapshot.map_skin = map_skin;
        Ok(snapshot)
    }

    /// One row of the scoreboard, as `allPlayers.map` builds it.
    fn live_player(
        &self,
        player: &Value,
        roster: &HashMap<String, RosterEntry>,
        active_name: &str,
        champion_lookup: &mut Option<HashMap<String, i64>>,
    ) -> Result<LivePlayer, String> {
        let entry = lookup_roster(roster, player);
        let p = Some(player);
        let field = |key| prop(p, key).map_err(|err| format!("TypeError: {err}"));
        let name = js_trim(&template(or(&[
            field("riotIdGameName")?,
            field("summonerName")?,
            Some(&EMPTY),
        ])))
        .to_owned();
        let tag_line = js_trim(&template(or(&[field("riotIdTagLine")?, Some(&EMPTY)]))).to_owned();
        let riot_id = js_trim(&template(or(&[field("riotId")?, Some(&EMPTY)]))).to_owned();
        let mut items = [0.0f64; 7];
        let listed =
            iterate(field("items")?, "player.items").map_err(|err| format!("TypeError: {err}"))?;
        for item in &listed {
            let slot = js_number(opt_prop(Some(item), "slot"));
            if slot >= 0.0 && slot < items.len() as f64 && slot.fract() == 0.0 {
                items[slot as usize] = number_or_zero(opt_prop(Some(item), "itemID"));
            }
        }
        let puuid = entry.and_then(|e| e.puuid.clone());
        let key = puuid
            .clone()
            .filter(|p| !p.is_empty())
            .or_else(|| (!riot_id.is_empty()).then(|| riot_id.clone()))
            .unwrap_or_else(|| name.clone());
        let champion_id = match entry
            .map(|e| e.champion_id)
            .filter(|id| *id != 0.0 && !id.is_nan())
        {
            Some(id) => id,
            None => {
                let lookup = champion_lookup
                    .get_or_insert_with(|| champion_id_lookup(&self.env.champion_data()));
                resolve_champion_id(lookup, field("rawChampionName")?, field("championName")?)
            }
        };
        let scores = field("scores")?;
        let score = |key| number_or_zero(opt_prop(scores, key));
        let spells = field("summonerSpells")?;
        let spell_ids = self.spells.lock().expect("spell lock");
        let spell = |own: Option<f64>, key| {
            own.map(|id| id as i64)
                .or_else(|| spell_ids.resolve(opt_prop(spells, key)))
        };
        let lower_active = |s: &str| !active_name.is_empty() && s.to_lowercase() == active_name;
        Ok(LivePlayer {
            name: [&name, &riot_id]
                .into_iter()
                .find(|s| !s.is_empty())
                .map_or_else(|| "Unknown".into(), |s| s.clone()),
            key,
            tag_line: (!tag_line.is_empty()).then_some(tag_line),
            puuid,
            champion_id: champion_id as i64,
            champion_name: template(or(&[field("championName")?, Some(&EMPTY)])),
            team_id: if is_one_of(field("team")?, &["CHAOS"]) {
                200
            } else {
                100
            },
            is_self: lower_active(&riot_id) || lower_active(&name),
            is_bot: field("isBot")? == Some(&Value::Bool(true)),
            level: number_or_zero(field("level")?) as i64,
            kills: score("kills") as i64,
            deaths: score("deaths") as i64,
            assists: score("assists") as i64,
            creep_score: score("creepScore"),
            items: items.iter().map(|id| *id as i64).collect(),
            is_dead: field("isDead")? == Some(&Value::Bool(true)),
            respawn_timer: number_or_zero(field("respawnTimer")?).ceil() as i64,
            spell1_id: spell(entry.and_then(|e| e.spell1), "summonerSpellOne"),
            spell2_id: spell(entry.and_then(|e| e.spell2), "summonerSpellTwo"),
            champion_record: None,
            overall_record: None,
            games_with_us: 0,
            friend_key: None,
        })
    }

    /// `startPolling`: every 3 s while the client says a match is on, and once
    /// straight away.
    fn start_polling(self: &Arc<Self>) {
        let mut state = self.state.lock().expect("live lock");
        if state.poll.is_some() {
            return;
        }
        let this = self.clone();
        state.poll = Some(self.runtime.spawn(async move {
            // setInterval reschedules from each run, so a stall costs one late
            // tick rather than a burst of missed ones
            loop {
                tokio::time::sleep_until(Instant::now() + POLL_INTERVAL).await;
                this.spawn_refresh();
            }
        }));
        drop(state);
        self.spawn_refresh();
    }

    /// `stopPolling`: one last refresh, so the page learns the match is over.
    fn stop_polling(self: &Arc<Self>) {
        {
            let mut state = self.state.lock().expect("live lock");
            if let Some(poll) = state.poll.take() {
                poll.abort();
            }
            state.record_cache = None;
        }
        self.spawn_refresh();
    }

    /// The status listener `startLiveTracking` registers.
    fn on_status(self: &Arc<Self>, status: LcuStatus) {
        if status == LcuStatus::Ingame {
            self.start_polling();
        } else if self.state.lock().expect("live lock").poll.is_some() {
            self.stop_polling();
        }
    }

    #[cfg(test)]
    pub fn is_polling(&self) -> bool {
        self.state.lock().expect("live lock").poll.is_some()
    }

    /// `startLiveTracking`'s own part: the window, and the spell loads.
    fn start_tracking(self: &Arc<Self>) {
        self.emitting.store(true, Ordering::SeqCst);
        let this = self.clone();
        self.runtime.spawn(async move {
            if let Some(keys) = this.env.spell_keys().await {
                this.spells.lock().expect("spell lock").by_key = Some(keys);
            }
        });
        let this = self.clone();
        self.runtime.spawn(async move {
            if let Some(spells) = this.env.spell_data().await {
                let by_name = spells
                    .iter()
                    .filter(|(_, spell)| !spell.name.is_empty())
                    .map(|(id, spell)| (spell.name.to_lowercase(), *id))
                    .collect();
                this.spells.lock().expect("spell lock").by_name = Some(by_name);
            }
        });
    }

    /// `stopLiveTracking`.
    fn stop_tracking(&self) {
        if let Some(poll) = self.state.lock().expect("live lock").poll.take() {
            poll.abort();
        }
        self.emitting.store(false, Ordering::SeqCst);
    }
}

/// `championIdLookup`: champion ids by Data Dragon key and, as the fallback,
/// by display name, both lowercased, later champions winning a clash.
fn champion_id_lookup(champions: &ChampionData) -> HashMap<String, i64> {
    let mut by_key = HashMap::new();
    // Data Dragon's keys are the champions' numeric ids
    for (id, champion) in champions.entries() {
        let Ok(id) = id.parse::<i64>() else {
            continue;
        };
        by_key.insert(champion.key.to_lowercase(), id);
        by_key.insert(champion.name.to_lowercase(), id);
    }
    by_key
}

/// `resolveChampionId`: the raw name is Data Dragon's key in every client
/// language; the localized name only stands in.
fn resolve_champion_id(
    lookup: &HashMap<String, i64>,
    raw: Option<&Value>,
    display: Option<&Value>,
) -> f64 {
    let raw = text(raw);
    let raw = raw
        .strip_prefix("game_character_displayname_")
        .unwrap_or(&raw);
    lookup
        .get(&raw.to_lowercase())
        .or_else(|| lookup.get(&text(display).to_lowercase()))
        .map_or(0.0, |id| *id as f64)
}

// ---------------------------------------------------------------------------
// The app's wiring

/// Both trackers and the one status listener they share, in the order
/// Electron registers them: live first, then challenges.
pub struct Tracking {
    trackers: Mutex<(Arc<LiveTracker>, Arc<ChallengeTracker>)>,
    listener: Mutex<Option<JoinHandle<()>>>,
}

impl Tracking {
    pub fn new(live: Arc<LiveTracker>, challenges: Arc<ChallengeTracker>) -> Self {
        Self {
            trackers: Mutex::new((live, challenges)),
            listener: Mutex::new(None),
        }
    }

    pub fn live(&self) -> Arc<LiveTracker> {
        self.trackers.lock().expect("trackers lock").0.clone()
    }

    pub fn challenges(&self) -> Arc<ChallengeTracker> {
        self.trackers.lock().expect("trackers lock").1.clone()
    }

    /// Puts scripted trackers in place for one golden case ([`golden`]).
    #[cfg(debug_assertions)]
    #[cfg_attr(
        not(any(test, feature = "parity-driver")),
        expect(dead_code, reason = "only the golden replay and tests seed")
    )]
    pub fn replace(&self, live: Arc<LiveTracker>, challenges: Arc<ChallengeTracker>) {
        *self.trackers.lock().expect("trackers lock") = (live, challenges);
    }

    /// `startLiveTracking(win)` and `startChallengeTracking(win)`, which
    /// follow `startPolling(win)` at launch. `changes` is the client's status
    /// changes, which the listeners hear in order.
    pub fn start(&self, runtime: &Handle, mut changes: broadcast::Receiver<LcuStatus>) {
        let (live, challenges) = (self.live(), self.challenges());
        live.start_tracking();
        challenges.start_tracking();
        let listener = runtime.spawn(async move {
            loop {
                match changes.recv().await {
                    Ok(status) => {
                        live.on_status(status);
                        challenges.on_status(status);
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        });
        if let Some(old) = self
            .listener
            .lock()
            .expect("listener lock")
            .replace(listener)
        {
            old.abort();
        }
    }

    /// `stopLiveTracking` at quit.
    pub fn stop(&self) {
        if let Some(listener) = self.listener.lock().expect("listener lock").take() {
            listener.abort();
        }
        self.live().stop_tracking();
        self.challenges().stop_tracking();
    }
}

/// The app's [`TrackingEnv`]: T11's database, T08's clock, T22's game data,
/// and the events, to the main window alone.
pub struct AppEnv<R: tauri::Runtime>(pub tauri::AppHandle<R>);

impl<R: tauri::Runtime> AppEnv<R> {
    fn dragon(&self) -> Option<crate::dragon::Dragon> {
        use tauri::Manager;
        self.0
            .try_state::<crate::dragon::Dragon>()
            .map(|d| d.inner().clone())
    }
}

impl<R: tauri::Runtime> TrackingEnv for AppEnv<R> {
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

    fn champion_data(&self) -> ChampionData {
        self.dragon()
            .map(|d| d.loaded_champion_data())
            .unwrap_or_default()
    }

    fn spell_keys(&self) -> BoxFuture<'_, Option<Arc<HashMap<String, i64>>>> {
        Box::pin(async move { self.dragon()?.summoner_spell_keys().await.ok() })
    }

    fn spell_data(&self) -> BoxFuture<'_, Option<Arc<SummonerSpellData>>> {
        Box::pin(async move { self.dragon()?.summoner_spells().await.ok() })
    }

    fn live_changed(&self, snapshot: &LiveGameSnapshot) {
        crate::events::live_changed(&self.0, snapshot);
    }

    fn challenges_changed(&self, result: &ChallengesResult) {
        crate::events::challenges_changed(&self.0, result);
    }
}

/// Manages [`Tracking`] once the app and T20's [`crate::lcu::sync::LcuSync`]
/// exist, the golden replay's mock app included. Tracking starts only where
/// the real app calls [`Tracking::start`].
pub fn plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("bmt-live")
        .setup(|app, _api| {
            use tauri::Manager;
            let runtime = tauri::async_runtime::handle().inner().clone();
            let lcu = app.state::<crate::lcu::sync::LcuSync>().lcu.clone();
            let client: Arc<dyn Client> = Arc::new(lcu);
            let env: Arc<dyn TrackingEnv> = Arc::new(AppEnv(app.clone()));
            let game: Arc<dyn GameApi> = Arc::new(HttpGameApi::new(GameApiTarget::from_env()));
            let live = LiveTracker::new(client.clone(), game, env.clone(), runtime.clone());
            let challenges = ChallengeTracker::new(client, env, runtime);
            app.manage(Tracking::new(live, challenges));
            Ok(())
        })
        .build()
}

/// Per-case seeding for T05's state goldens of `live:snapshot` and
/// `challenges:get`, which were recorded with T03's fake client in a given
/// state. The live domain's `Domain::before_golden_case` calls
/// [`golden::seed`]. A script is what the fake answers in one scenario, written by
/// T21's `record-scenarios.ts` from T03's scenario code over the fixture.
#[cfg(debug_assertions)]
#[cfg_attr(
    not(any(test, feature = "parity-driver")),
    expect(dead_code, reason = "only the golden replay and tests seed")
)]
pub mod golden {
    use std::path::Path;

    use serde::Deserialize;

    use super::*;
    use crate::lcu::{LcuError, LiveGameRef};

    #[derive(Debug, Clone, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct Script {
        pub phase: Value,
        pub session: Value,
        /// The in-game API's mode: "on", "loading" or "off"
        pub live: String,
        pub live_data: Value,
        pub challenges: Option<ScriptChallenges>,
        pub live_ref: Option<ScriptRef>,
    }

    #[derive(Debug, Clone, Deserialize)]
    pub struct ScriptChallenges {
        pub all: Value,
        pub summary: Value,
    }

    #[derive(Debug, Clone, Copy, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct ScriptRef {
        pub game_id: f64,
        pub queue_id: f64,
    }

    impl Script {
        pub fn read(dir: &Path, scenario: &str) -> Result<Self, String> {
            let path = dir.join(format!("{scenario}.json"));
            let text =
                std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
            serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))
        }
    }

    /// The fake client's answers, as `fake-lcu.ts` routes them.
    pub struct ScriptedClient {
        pub script: Script,
        pub connected: bool,
    }

    impl Client for ScriptedClient {
        fn request_json<'a>(&'a self, path: &'a str) -> BoxFuture<'a, Result<Value, LcuError>> {
            let missing = || LcuError::Status {
                status: 404,
                url: path.to_string(),
            };
            let challenges = self.script.challenges.as_ref();
            let answer = match path {
                PHASE_PATH => Some(self.script.phase.clone()),
                SESSION_PATH => Some(self.script.session.clone()).filter(|s| truthy(Some(s))),
                "/lol-challenges/v1/challenges/local-player" => challenges.map(|c| c.all.clone()),
                "/lol-challenges/v1/summary-player-data/local-player" => {
                    challenges.map(|c| c.summary.clone())
                }
                _ => None,
            };
            Box::pin(async move { answer.ok_or_else(missing) })
        }

        fn is_client_connected(&self) -> bool {
            self.connected
        }

        fn live_game_ref(&self) -> Option<LiveGameRef> {
            self.script.live_ref.map(|r| LiveGameRef {
                game_id: r.game_id,
                queue_id: r.queue_id,
            })
        }
    }

    /// The fake live client: data while "on", 404 while loading, 503 when off.
    pub struct ScriptedGame(pub Script);

    impl GameApi for ScriptedGame {
        fn get<'a>(&'a self, path: &'a str) -> BoxFuture<'a, Result<Value, GameApiError>> {
            let answer = match (self.0.live.as_str(), path) {
                ("on", ALL_GAME_DATA_PATH) => Ok(self.0.live_data.clone()),
                ("on", GAME_STATS_PATH) => Ok(self.0.live_data["gameData"].clone()),
                ("on" | "loading", _) => {
                    Err(GameApiError::Failed("In-game API returned 404".into()))
                }
                _ => Err(GameApiError::Failed("In-game API returned 503".into())),
            };
            Box::pin(async move { answer })
        }
    }

    /// T03's client state for a state golden: its scenario, whether the client
    /// is up, whether the connect listener's challenge refresh had run before
    /// the page asked, and whether the data was the empty copy.
    struct StateSpec {
        scenario: &'static str,
        connected: bool,
        refreshed: bool,
        empty: bool,
    }

    fn spec(state: &str) -> Option<StateSpec> {
        let spec = |scenario, connected, refreshed, empty| StateSpec {
            scenario,
            connected,
            refreshed,
            empty,
        };
        Some(match state {
            "live-in-game" => spec("in-game", true, false, false),
            // The page's first call lands while these scenarios' match runs
            "live-waiting" | "live-results-late" => spec("results-late", true, false, false),
            "live-game-over-recorded" => spec("end-of-game", true, false, false),
            "live-loading" => spec("in-game-loading", true, false, false),
            "live-champ-select" => spec("champ-select", true, false, false),
            "live-standby-connected" => spec("connected-idle", true, false, false),
            "challenges-loaded" => spec("challenges-loaded", true, true, false),
            "challenges-offline-stored" => spec("challenges-loaded", false, true, false),
            "challenges-offline-empty" => spec("connected-idle", false, false, true),
            _ => return None,
        })
    }

    /// Seeds the trackers for the T03 client state a golden was recorded in.
    /// False for a state with nothing to seed, such as a case recorded with no
    /// client. `challenges-offline-empty` ran on a copy with every table but
    /// `settings` emptied; this clears only what `challenges:get` reads.
    pub async fn seed(
        tracking: &Tracking,
        env: Arc<dyn TrackingEnv>,
        runtime: Handle,
        state: &str,
        scripts: &Path,
    ) -> Result<bool, String> {
        let Some(spec) = spec(state) else {
            return Ok(false);
        };
        let script = Script::read(scripts, spec.scenario)?;
        if spec.empty {
            with_db(env.as_ref(), |conn| {
                conn.execute_batch("DELETE FROM challenge_state")
            })?;
        }
        let build = |connected: bool| {
            let client: Arc<dyn Client> = Arc::new(ScriptedClient {
                script: script.clone(),
                connected,
            });
            let game: Arc<dyn GameApi> = Arc::new(ScriptedGame(script.clone()));
            (
                LiveTracker::new(client.clone(), game, env.clone(), runtime.clone()),
                ChallengeTracker::new(client, env.clone(), runtime.clone()),
            )
        };
        if spec.refreshed {
            let (_, challenges) = build(true);
            challenges.refresh_and_broadcast().await;
        }
        let (live, challenges) = build(spec.connected);
        tracking.replace(live, challenges);
        Ok(true)
    }

    /// The T03 state each case of `channel` was recorded in, from T05's
    /// `states/<state>.json`.
    pub fn states_of_cases(golden_dir: &Path, channel: &str) -> Vec<(String, String)> {
        let mut by_state: Vec<(String, Vec<String>)> = Vec::new();
        for entry in std::fs::read_dir(golden_dir.join("states"))
            .into_iter()
            .flatten()
            .flatten()
        {
            let Ok(text) = std::fs::read_to_string(entry.path()) else {
                continue;
            };
            let Ok(state) = serde_json::from_str::<Value>(&text) else {
                continue;
            };
            let mut cases: Vec<String> = Vec::new();
            for call in state["calls"].as_array().into_iter().flatten() {
                let case = call["case"].as_str().unwrap_or_default().to_string();
                if call["channel"] == channel && !cases.contains(&case) {
                    cases.push(case);
                }
            }
            by_state.push((state["state"].as_str().unwrap_or_default().into(), cases));
        }
        by_state.sort();
        // A state whose client changed while the page asked (offline-stored
        // stops the client after its first calls) only names its last case;
        // its earlier ones are seeded from a state that held still
        let mut out = Vec::new();
        for (state, cases) in &by_state {
            for (i, case) in cases.iter().enumerate() {
                let steady = cases.len() == 1 || i + 1 == cases.len();
                let elsewhere = by_state.iter().any(|(_, c)| c.len() == 1 && c[0] == *case);
                if case.starts_with("state-") && (steady || !elsewhere) {
                    out.push((case.clone(), state.clone()));
                }
            }
        }
        out.sort();
        out
    }
}

/// Stand-ins for the client, the game's API, and the app, on tokio's paused
/// clock, so each request's time is exact.
#[cfg(test)]
pub(crate) mod test_env {
    use std::collections::{HashMap, VecDeque};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};

    use futures_util::future::BoxFuture;
    use serde_json::Value;
    use tokio::sync::Notify;
    use tokio::time::Instant;

    use super::{GameApi, GameApiError, TrackingEnv};
    use crate::commands::live::{ChallengesResult, LiveGameSnapshot};
    use crate::db::Database;
    use crate::dragon::{ChampionData, SummonerSpellData};
    use crate::lcu::sync::Client;
    use crate::lcu::{LcuError, LiveGameRef};

    /// The anonymized fixture's frozen clock, as T05 recorded under.
    pub const NOW_MS: i64 = 1_795_399_200_000;

    #[derive(Clone)]
    pub enum Reply {
        Json(Value),
        Fail,
        /// Answers once the test releases it
        Held(Arc<Notify>, Value),
    }

    pub struct StubClient {
        started: Instant,
        pub connected: AtomicBool,
        pub live: Mutex<Option<LiveGameRef>>,
        routes: Mutex<HashMap<String, VecDeque<Reply>>>,
        log: Mutex<Vec<(u128, String)>>,
    }

    impl StubClient {
        pub fn new() -> Arc<Self> {
            Arc::new(Self {
                started: Instant::now(),
                connected: AtomicBool::new(true),
                live: Mutex::default(),
                routes: Mutex::default(),
                log: Mutex::default(),
            })
        }

        /// Replies in turn; the last one repeats.
        pub fn route(&self, path: &str, replies: Vec<Reply>) {
            self.routes
                .lock()
                .unwrap()
                .insert(path.into(), replies.into());
        }

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
    }

    impl Client for StubClient {
        fn request_json<'a>(&'a self, path: &'a str) -> BoxFuture<'a, Result<Value, LcuError>> {
            Box::pin(async move {
                self.log
                    .lock()
                    .unwrap()
                    .push((self.started.elapsed().as_millis(), path.to_string()));
                let reply = {
                    let mut routes = self.routes.lock().unwrap();
                    routes.get_mut(path).and_then(|queue| {
                        if queue.len() > 1 {
                            queue.pop_front()
                        } else {
                            queue.front().cloned()
                        }
                    })
                };
                match reply {
                    Some(Reply::Json(value)) => Ok(value),
                    Some(Reply::Held(gate, value)) => {
                        gate.notified().await;
                        Ok(value)
                    }
                    Some(Reply::Fail) | None => Err(LcuError::Status {
                        status: 404,
                        url: path.to_string(),
                    }),
                }
            })
        }

        fn is_client_connected(&self) -> bool {
            self.connected.load(Ordering::SeqCst)
        }

        fn live_game_ref(&self) -> Option<LiveGameRef> {
            *self.live.lock().unwrap()
        }
    }

    pub struct StubGame {
        started: Instant,
        pub answer: Mutex<Result<Value, GameApiError>>,
        pub gate: Mutex<Option<Arc<Notify>>>,
        log: Mutex<Vec<u128>>,
    }

    impl StubGame {
        pub fn new() -> Arc<Self> {
            Arc::new(Self {
                started: Instant::now(),
                answer: Mutex::new(Err(GameApiError::Refused)),
                gate: Mutex::default(),
                log: Mutex::default(),
            })
        }

        pub fn serve(&self, data: Value) {
            *self.answer.lock().unwrap() = Ok(data);
        }

        pub fn times(&self) -> Vec<u128> {
            self.log.lock().unwrap().clone()
        }
    }

    impl GameApi for StubGame {
        fn get<'a>(&'a self, _path: &'a str) -> BoxFuture<'a, Result<Value, GameApiError>> {
            Box::pin(async move {
                self.log
                    .lock()
                    .unwrap()
                    .push(self.started.elapsed().as_millis());
                let gate = self.gate.lock().unwrap().clone();
                if let Some(gate) = gate {
                    gate.notified().await;
                }
                self.answer.lock().unwrap().clone()
            })
        }
    }

    pub struct TestEnv {
        dir: PathBuf,
        pub db: Database,
        pub now: Mutex<i64>,
        pub champions: Mutex<ChampionData>,
        pub spell_keys: Mutex<Option<HashMap<String, i64>>>,
        pub spells: Mutex<Option<SummonerSpellData>>,
        events: Mutex<Vec<(String, Value)>>,
    }

    impl TestEnv {
        pub fn new(name: &str) -> Arc<Self> {
            let dir = std::env::temp_dir().join(format!("bmt-live-{name}-{}", std::process::id()));
            std::fs::remove_dir_all(&dir).ok();
            std::fs::create_dir_all(&dir).unwrap();
            Self::over(dir)
        }

        /// Over a data folder already holding `matches.db`.
        pub fn over(dir: PathBuf) -> Arc<Self> {
            Arc::new(Self {
                db: Database::open(&dir, NOW_MS).unwrap(),
                dir,
                now: Mutex::new(NOW_MS),
                champions: Mutex::default(),
                spell_keys: Mutex::default(),
                spells: Mutex::default(),
                events: Mutex::default(),
            })
        }

        pub fn events(&self, name: &str) -> Vec<Value> {
            self.events
                .lock()
                .unwrap()
                .iter()
                .filter(|(n, _)| n == name)
                .map(|(_, payload)| payload.clone())
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
    }

    impl Drop for TestEnv {
        fn drop(&mut self) {
            self.db.close();
            std::fs::remove_dir_all(&self.dir).ok();
        }
    }

    impl TrackingEnv for TestEnv {
        fn db(&self) -> Option<&Database> {
            Some(&self.db)
        }

        fn now_ms(&self) -> i64 {
            *self.now.lock().unwrap()
        }

        fn champion_data(&self) -> ChampionData {
            self.champions.lock().unwrap().clone()
        }

        fn spell_keys(&self) -> BoxFuture<'_, Option<Arc<HashMap<String, i64>>>> {
            Box::pin(async move { self.spell_keys.lock().unwrap().clone().map(Arc::new) })
        }

        fn spell_data(&self) -> BoxFuture<'_, Option<Arc<SummonerSpellData>>> {
            Box::pin(async move { self.spells.lock().unwrap().clone().map(Arc::new) })
        }

        fn live_changed(&self, snapshot: &LiveGameSnapshot) {
            let payload = serde_json::to_value(snapshot).unwrap();
            self.events
                .lock()
                .unwrap()
                .push(("live:changed".into(), payload));
        }

        fn challenges_changed(&self, result: &ChallengesResult) {
            let payload = serde_json::to_value(result).unwrap();
            self.events
                .lock()
                .unwrap()
                .push(("challenges:changed".into(), payload));
        }
    }

    /// Lets every task the tracker spawned run as far as it can.
    pub async fn settle() {
        for _ in 0..50 {
            tokio::task::yield_now().await;
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use serde_json::json;
    use tokio::sync::Notify;

    use super::test_env::{NOW_MS, Reply, StubClient, StubGame, TestEnv, settle};
    use super::*;
    use crate::dragon::{ChampionInfo, SummonerSpellInfo};
    use crate::lcu::LiveGameRef;

    struct Rig {
        client: Arc<StubClient>,
        game: Arc<StubGame>,
        env: Arc<TestEnv>,
        live: Arc<LiveTracker>,
    }

    fn rig(name: &str) -> Rig {
        let client = StubClient::new();
        let game = StubGame::new();
        let env = TestEnv::new(name);
        let live = LiveTracker::new(client.clone(), game.clone(), env.clone(), Handle::current());
        live.start_tracking();
        Rig {
            client,
            game,
            env,
            live,
        }
    }

    fn session(phase: &str) -> Value {
        json!({
            "phase": phase,
            "map": { "id": 12 },
            "gameData": {
                "gameId": 7_000_000_000_i64,
                "queue": { "id": 2400 },
                "teamOne": [
                    { "puuid": "p-ann", "gameName": "Ann", "tagLine": "EUW", "championId": 1, "spell1Id": 4, "spell2Id": 32 },
                    { "puuid": "", "gameName": "Bot", "championId": 0 },
                ],
                "teamTwo": [
                    { "puuid": "p-cy", "riotId": "Cy#NA1", "championId": 0 },
                ],
                "playerChampionSelections": [
                    { "gameName": "Bot", "championId": 3, "spell1Id": 6 },
                ],
            },
        })
    }

    fn all_game_data() -> Value {
        json!({
            "activePlayer": { "riotId": "ann#euw" },
            "allPlayers": [
                {
                    "riotIdGameName": " Ann ", "riotIdTagLine": "EUW", "riotId": "Ann#EUW",
                    "championName": "Annie", "rawChampionName": "game_character_displayname_Annie",
                    "team": "ORDER", "level": 7, "isDead": false, "respawnTimer": 0,
                    "scores": { "kills": 3, "deaths": 1, "assists": 4, "creepScore": 12.5 },
                    "items": [{ "slot": 0, "itemID": 1001 }, { "slot": 6, "itemID": 3340 }, { "slot": 1.5, "itemID": 9 }, { "slot": 9, "itemID": 9 }],
                },
                {
                    "riotIdGameName": "Bot", "championName": "", "rawChampionName": "game_character_displayname_Garen",
                    "team": "ORDER", "isBot": true, "level": "3", "isDead": true, "respawnTimer": 4.2,
                    "summonerSpells": { "summonerSpellTwo": { "rawDisplayName": "GeneratedTip_SummonerSpell_SummonerFlash_DisplayName" } },
                },
                {
                    "summonerName": "Cy", "riotId": "Cy#NA1", "championName": "Wukong",
                    "rawChampionName": "game_character_displayname_MonkeyKing", "team": "CHAOS",
                    "summonerSpells": {
                        "summonerSpellOne": { "displayName": "Ghost" },
                        "summonerSpellTwo": { "rawDisplayName": "nope", "displayName": "" },
                    },
                },
            ],
            "gameData": { "gameTime": 1450.9, "mapTerrain": "Bloom", "mapNumber": 12 },
            "events": { "Events": [
                { "EventID": 0, "EventName": "GameStart", "EventTime": 0.02 },
                { "EventID": 1, "EventName": "FirstBlood", "EventTime": 90.5, "Recorder": "Ann" },
                { "EventID": 2, "EventName": "ChampionKill", "EventTime": 91, "KillerName": "Ann", "VictimName": "Cy", "Assisters": ["Bot"] },
                { "EventID": 3, "EventName": "Multikill", "EventTime": 92, "KillerName": "Ann", "KillStreak": 2 },
                { "EventName": "Multikill", "EventTime": 93.25, "KillerName": "ann#euw", "KillStreak": 7 },
                { "EventID": 5, "EventName": "TurretKilled", "EventTime": 300, "KillerName": "Turret_T1_C_05_A" },
                { "EventID": 6, "EventName": "InhibKilled", "EventTime": 400, "KillerName": "Stranger#EUW" },
                { "EventID": 7, "EventName": "Ace", "EventTime": 401, "Acer": "#tag" },
                { "EventID": 8, "EventName": "FirstBrick", "EventTime": 402, "KillerName": "minion_t1" },
            ] },
        })
    }

    fn champions() -> ChampionData {
        let champion = |name: &str, key: &str| ChampionInfo {
            name: name.into(),
            key: key.into(),
            class: None,
        };
        let mut data = ChampionData::default();
        for (id, info) in [
            (1, champion("Annie", "Annie")),
            (62, champion("Wukong", "MonkeyKing")),
            (86, champion("Garen", "Garen")),
        ] {
            data.set(id.to_string(), info);
        }
        data
    }

    fn in_game(rig: &Rig) {
        rig.client
            .route(SESSION_PATH, vec![Reply::Json(session("InProgress"))]);
        rig.game.serve(all_game_data());
        *rig.env.champions.lock().unwrap() = champions();
        *rig.env.spell_keys.lock().unwrap() = Some(HashMap::from([("summonerflash".into(), 4)]));
        *rig.env.spells.lock().unwrap() = Some(SummonerSpellData::from([(
            6,
            SummonerSpellInfo {
                name: "Ghost".into(),
                icon_path: String::new(),
            },
        )]));
    }

    #[tokio::test]
    async fn no_game_is_an_empty_snapshot_that_keeps_the_last_game_id() {
        let rig = rig("empty");
        *rig.client.live.lock().unwrap() = Some(LiveGameRef {
            game_id: 55.0,
            queue_id: f64::NAN,
        });
        let snapshot = rig.live.refresh().await;
        assert_eq!(
            serde_json::to_value(&snapshot).unwrap(),
            json!({
                "inGame": false, "starting": false, "gameId": 55, "queueId": null, "mapId": null,
                "mapName": null, "mapSkin": null, "gameTime": 0.0, "players": [], "events": [],
            })
        );
        assert_eq!(rig.env.events("live:changed").len(), 1);
    }

    #[tokio::test]
    async fn the_loading_screen_is_a_starting_game_with_the_sessions_ids() {
        let rig = rig("loading");
        rig.client
            .route(SESSION_PATH, vec![Reply::Json(session("InProgress"))]);
        *rig.game.answer.lock().unwrap() =
            Err(GameApiError::Failed("In-game API returned 503".into()));
        let snapshot = rig.live.refresh().await;
        assert!(snapshot.starting && !snapshot.in_game);
        assert_eq!(
            (snapshot.game_id, snapshot.queue_id, snapshot.map_id),
            (Some(7_000_000_000), Some(2400), Some(12))
        );

        rig.client
            .route(SESSION_PATH, vec![Reply::Json(session("ChampSelect"))]);
        assert!(
            !rig.live.refresh().await.starting,
            "champion select is not a starting game"
        );
        assert_eq!(rig.env.query::<i64>("SELECT COUNT(*) FROM match_maps"), 0);
    }

    #[tokio::test]
    async fn a_running_game_is_built_from_the_client_and_the_game_api() {
        let rig = rig("in-game");
        in_game(&rig);
        // The spell loads settle at tracking start
        rig.live.start_tracking();
        settle().await;
        let snapshot = rig.live.refresh().await;
        let players = serde_json::to_value(&snapshot.players).unwrap();
        let player = |i: usize, key: &str| players[i][key].clone();

        assert!(snapshot.in_game && !snapshot.starting);
        assert_eq!(snapshot.game_time, 1450.0);
        assert_eq!(snapshot.map_skin.as_deref(), Some("Bloom"));
        assert_eq!(snapshot.map_name.as_deref(), Some("Koeshin's Crossing"));
        assert_eq!(
            (snapshot.game_id, snapshot.queue_id, snapshot.map_id),
            (Some(7_000_000_000), Some(2400), Some(12))
        );

        // Ann: puuid, champion and spells from the client, trimmed name, self
        assert_eq!(player(0, "key"), "p-ann");
        assert_eq!(player(0, "name"), "Ann");
        assert_eq!(player(0, "tagLine"), "EUW");
        assert_eq!(player(0, "isSelf"), true);
        assert_eq!(player(0, "championId"), 1);
        assert_eq!(
            (player(0, "spell1Id"), player(0, "spell2Id")),
            (json!(4), json!(32))
        );
        assert_eq!(player(0, "items"), json!([1001, 0, 0, 0, 0, 0, 3340]));
        assert_eq!(
            (player(0, "kills"), player(0, "creepScore")),
            (json!(3), json!(12.5))
        );
        // Bot: champion from champion select, a spell from its raw name
        assert_eq!(player(1, "key"), "Bot");
        assert_eq!(player(1, "championId"), 3);
        assert_eq!(
            (player(1, "spell1Id"), player(1, "spell2Id")),
            (json!(6), json!(4))
        );
        assert_eq!(
            (
                player(1, "isBot"),
                player(1, "isDead"),
                player(1, "respawnTimer"),
                player(1, "level")
            ),
            (json!(true), json!(true), json!(5), json!(3))
        );
        assert_eq!(player(1, "tagLine"), Value::Null);
        // Cy: no champion from the client, so Data Dragon's key; a spell by display name
        assert_eq!(player(2, "key"), "p-cy");
        assert_eq!(player(2, "name"), "Cy");
        assert_eq!(player(2, "championId"), 62);
        assert_eq!(player(2, "teamId"), 200);
        assert_eq!(
            (player(2, "spell1Id"), player(2, "spell2Id")),
            (json!(6), Value::Null)
        );

        let feed: Vec<(i64, f64, &str, LiveEventTone)> = snapshot
            .events
            .iter()
            .map(|e| (e.id, e.time, e.text.as_str(), e.tone))
            .collect();
        assert_eq!(
            feed,
            vec![
                (
                    1,
                    90.5,
                    "First blood: \u{2068}Annie\u{2069}",
                    LiveEventTone::Special
                ),
                (
                    2,
                    91.0,
                    "\u{2068}Annie\u{2069} killed \u{2068}Wukong\u{2069} (+1)",
                    LiveEventTone::Kill
                ),
                (
                    3,
                    92.0,
                    "\u{2068}Annie\u{2069}: Double Kill",
                    LiveEventTone::Special
                ),
                (
                    93,
                    93.25,
                    "\u{2068}Annie\u{2069}: 7 kills",
                    LiveEventTone::Special
                ),
                (
                    5,
                    300.0,
                    "a turret destroyed a turret",
                    LiveEventTone::Objective
                ),
                (
                    6,
                    400.0,
                    "\u{2068}Stranger\u{2069} destroyed an inhibitor",
                    LiveEventTone::Objective
                ),
                (7, 401.0, "Ace by someone", LiveEventTone::Special),
                (8, 402.0, "First tower: a minion", LiveEventTone::Objective),
            ]
        );
        assert_eq!(
            rig.env.query::<String>(
                "SELECT game_id || ':' || map_id || ':' || map_skin FROM match_maps"
            ),
            "7000000000:12:Bloom"
        );
    }

    #[tokio::test]
    async fn the_map_is_written_once_per_game() {
        let rig = rig("map-once");
        in_game(&rig);
        rig.live.refresh().await;
        rig.env.exec("DELETE FROM match_maps");
        rig.live.refresh().await;
        assert_eq!(rig.env.query::<i64>("SELECT COUNT(*) FROM match_maps"), 0);
    }

    #[tokio::test]
    async fn the_feed_keeps_the_last_forty_events() {
        let rig = rig("feed");
        in_game(&rig);
        let mut data = all_game_data();
        data["events"]["Events"] = (0..45)
            .map(|i| json!({ "EventID": i, "EventName": "TurretKilled", "EventTime": i, "KillerName": "Turret_x" }))
            .collect();
        rig.game.serve(data);
        let events = rig.live.refresh().await.events;
        assert_eq!((events.len(), events[0].id, events[39].id), (40, 5, 44));
    }

    #[tokio::test]
    async fn a_failed_build_publishes_an_empty_snapshot() {
        let rig = rig("failed");
        in_game(&rig);
        let mut data = all_game_data();
        data["allPlayers"][1] = Value::Null;
        rig.game.serve(data);
        let snapshot = rig.live.refresh().await;
        assert!(!snapshot.in_game && snapshot.players.is_empty());
        assert_eq!(
            snapshot.game_id, None,
            "the empty snapshot reads the live ref, not the session"
        );
        let mut data = all_game_data();
        data["gameData"]["mapTerrain"] = json!(5);
        rig.game.serve(data);
        assert!(
            !rig.live.refresh().await.in_game,
            "a skin with no replace() fails the build"
        );
        assert_eq!(rig.env.events("live:changed").len(), 2);
    }

    #[tokio::test]
    async fn one_refresh_runs_at_a_time() {
        let rig = rig("one-at-a-time");
        in_game(&rig);
        let first = rig.live.refresh().await;
        let gate = Arc::new(Notify::new());
        *rig.game.gate.lock().unwrap() = Some(gate.clone());
        let live = rig.live.clone();
        let running = tokio::spawn(async move { live.refresh().await });
        settle().await;
        // A refresh while one runs answers with the last snapshot at once
        assert_eq!(rig.live.refresh().await, first);
        assert_eq!(rig.game.times().len(), 2);
        gate.notify_one();
        running.await.unwrap();
        assert_eq!(rig.env.events("live:changed").len(), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn polls_every_three_seconds_in_game_and_once_more_after() {
        let rig = rig("poll");
        in_game(&rig);
        rig.live.on_status(LcuStatus::Connected);
        settle().await;
        assert!(
            rig.game.times().is_empty(),
            "connected alone starts nothing"
        );
        rig.live.on_status(LcuStatus::Ingame);
        tokio::time::sleep(Duration::from_millis(9_500)).await;
        rig.live.on_status(LcuStatus::Ingame);
        settle().await;
        assert_eq!(rig.game.times(), vec![0, 3_000, 6_000, 9_000]);
        rig.live.on_status(LcuStatus::Connected);
        settle().await;
        assert!(!rig.live.is_polling());
        tokio::time::sleep(Duration::from_millis(10_000)).await;
        assert_eq!(rig.game.times(), vec![0, 3_000, 6_000, 9_000, 9_500]);
        rig.live.on_status(LcuStatus::Disconnected);
        settle().await;
        assert_eq!(rig.game.times().len(), 5, "no poll to stop, so no refresh");
        assert_eq!(rig.env.events("live:changed").len(), 5);
    }

    #[tokio::test]
    async fn before_the_first_refresh_the_answer_is_the_launch_snapshot() {
        let rig = rig("launch-snapshot");
        in_game(&rig);
        *rig.client.live.lock().unwrap() = Some(LiveGameRef {
            game_id: 7.0,
            queue_id: 2400.0,
        });
        assert_eq!(
            rig.live.latest().game_id,
            None,
            "made when no game was known"
        );
        // The poll's first refresh holds the flag before its task runs, so a
        // call that lands first answers with the launch snapshot
        rig.live.on_status(LcuStatus::Ingame);
        let answer = rig.live.refresh().await;
        assert_eq!((answer.in_game, answer.game_id), (false, None));
        settle().await;
        assert!(rig.live.latest().in_game);
    }

    #[test]
    fn a_streak_past_the_names_is_counted() {
        let by_name = HashMap::new();
        let streak = |value: Value| {
            describe_event(
                &json!({ "EventName": "Multikill", "KillerName": "x", "KillStreak": value }),
                &by_name,
            )
            .unwrap()
            .text
        };
        assert_eq!(streak(json!(5)), "\u{2068}x\u{2069}: PENTAKILL");
        assert_eq!(streak(json!(1)), "\u{2068}x\u{2069}: 1 kills");
        assert_eq!(
            streak(json!("Infinity")),
            "\u{2068}x\u{2069}: Infinity kills"
        );
        assert_eq!(streak(json!(2.5)), "\u{2068}x\u{2069}: 2.5 kills");
        assert_eq!(streak(json!("nope")), "\u{2068}x\u{2069}: 0 kills");
    }

    #[tokio::test]
    async fn events_wait_for_tracking_to_start_and_stop_with_it() {
        let client = StubClient::new();
        let env = TestEnv::new("emitting");
        let live = LiveTracker::new(client, StubGame::new(), env.clone(), Handle::current());
        live.refresh().await;
        assert!(env.events("live:changed").is_empty());
        live.start_tracking();
        live.refresh().await;
        live.stop_tracking();
        live.refresh().await;
        assert_eq!(env.events("live:changed").len(), 1);
    }

    #[test]
    fn javascript_helpers_follow_javascript() {
        assert_eq!(js_trim("\u{feff} a\u{a0}\n"), "a");
        assert_eq!(js_trim("\u{85}a"), "\u{85}a");
        assert_eq!(
            spell_key("generatedtip_summonerspell_SummonerDot_DISPLAYNAME"),
            Some("SummonerDot")
        );
        assert_eq!(spell_key("GeneratedTip_SummonerSpell__DisplayName"), None);
        assert_eq!(
            spell_key("GeneratedTip_SummonerSpell_a\nb_DisplayName"),
            None
        );
        assert_eq!(
            map_name_for_skin("Default").as_deref(),
            Some("Howling Abyss")
        );
        assert_eq!(
            map_name_for_skin("New_Skin_2").as_deref(),
            Some("New Skin 2")
        );
        assert_eq!(map_name_for_skin(""), None);
        let ordered = json!({"b": 1, "10": 2, "2": 3, "01": 4, "4294967295": 5});
        assert_eq!(
            object_values(&ordered),
            vec![&json!(3), &json!(2), &json!(1), &json!(4), &json!(5)]
        );
        assert_eq!(
            iterate(Some(&json!("ab")), "x").unwrap(),
            vec![json!("a"), json!("b")]
        );
        assert_eq!(
            iterate(Some(&json!(null)), "x").unwrap(),
            Vec::<Value>::new()
        );
        assert!(iterate(Some(&json!({})), "x").is_err());
    }

    #[tokio::test]
    async fn is_match_underway_asks_the_phase_only_while_connected() {
        let client = StubClient::new();
        client.connected.store(false, Ordering::SeqCst);
        assert!(!is_match_underway(client.as_ref()).await);
        assert!(client.paths().is_empty());
        client.connected.store(true, Ordering::SeqCst);
        for (phase, underway) in [
            ("ChampSelect", true),
            ("GameStart", true),
            ("InProgress", true),
            ("Reconnect", true),
            ("EndOfGame", false),
            ("Lobby", false),
        ] {
            client.route(PHASE_PATH, vec![Reply::Json(json!(phase))]);
            assert_eq!(
                is_match_underway(client.as_ref()).await,
                underway,
                "{phase}"
            );
        }
        client.route(PHASE_PATH, vec![Reply::Fail]);
        assert!(!is_match_underway(client.as_ref()).await);
    }

    #[tokio::test]
    async fn is_game_running_unless_the_connection_is_refused() {
        let game = StubGame::new();
        assert!(!is_game_running(game.as_ref()).await);
        *game.answer.lock().unwrap() = Err(GameApiError::Failed("In-game API returned 404".into()));
        assert!(is_game_running(game.as_ref()).await);
        game.serve(json!({}));
        assert!(is_game_running(game.as_ref()).await);
    }

    #[cfg(feature = "parity-ca")]
    #[tokio::test]
    async fn a_parity_build_reaches_only_the_fake_live_client() {
        assert_eq!(GameApiTarget::parity(None), GameApiTarget::Refused);
        assert_eq!(GameApiTarget::parity(Some("")), GameApiTarget::Refused);
        assert_eq!(GameApiTarget::parity(Some("0")), GameApiTarget::Refused);
        assert_eq!(GameApiTarget::parity(Some("2999x")), GameApiTarget::Refused);
        assert_eq!(
            GameApiTarget::parity(Some("2999")),
            GameApiTarget::Refused,
            "a real game's port is no fake's"
        );
        assert_eq!(
            GameApiTarget::parity(Some("40123")),
            GameApiTarget::Port(40123)
        );
        let refused = HttpGameApi::new(GameApiTarget::parity(None));
        assert_eq!(
            refused.get(ALL_GAME_DATA_PATH).await,
            Err(GameApiError::Refused)
        );
        assert!(!is_game_running(&refused).await);
    }

    #[cfg(all(debug_assertions, not(feature = "parity-ca")))]
    #[test]
    fn a_debug_build_leaves_a_real_game_alone_unless_told() {
        assert_eq!(GameApiTarget::debug(None), GameApiTarget::Refused);
        assert_eq!(
            GameApiTarget::debug(Some("0".as_ref())),
            GameApiTarget::Refused
        );
        assert_eq!(
            GameApiTarget::debug(Some("1".as_ref())),
            GameApiTarget::Port(2999)
        );
    }

    /// A loopback HTTPS server with a self-signed certificate, answering
    /// every request with `status` and `body`.
    async fn tls_server(status: u16, body: &'static str) -> u16 {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let cert = rcgen::generate_simple_self_signed(vec!["localhost".into()]).unwrap();
        let key = rustls::pki_types::PrivateKeyDer::Pkcs8(cert.signing_key.serialize_der().into());
        let config = rustls::ServerConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(vec![cert.cert.der().clone()], key)
        .unwrap();
        let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(config));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((tcp, _)) = listener.accept().await {
                let acceptor = acceptor.clone();
                tokio::spawn(async move {
                    let Ok(mut tls) = acceptor.accept(tcp).await else {
                        return;
                    };
                    let mut buf = [0u8; 4096];
                    let _ = tls.read(&mut buf).await;
                    let response = format!(
                        "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = tls.write_all(response.as_bytes()).await;
                    let _ = tls.shutdown().await;
                });
            }
        });
        port
    }

    #[tokio::test]
    async fn the_game_api_is_read_over_tls_without_checking_the_chain() {
        let ok = HttpGameApi::new(GameApiTarget::Port(
            tls_server(200, r#"{"gameTime": 1.5}"#).await,
        ));
        assert_eq!(ok.get(GAME_STATS_PATH).await, Ok(json!({"gameTime": 1.5})));
        let loading = HttpGameApi::new(GameApiTarget::Port(tls_server(404, "{}").await));
        assert_eq!(
            loading.get(GAME_STATS_PATH).await,
            Err(GameApiError::Failed("In-game API returned 404".into()))
        );
        assert!(
            is_game_running(&loading).await,
            "a game that answers non-200 is still running"
        );
        let closed = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = closed.local_addr().unwrap().port();
        drop(closed);
        let nothing = HttpGameApi::new(GameApiTarget::Port(port));
        assert_eq!(
            nothing.get(GAME_STATS_PATH).await,
            Err(GameApiError::Refused)
        );
        assert!(!is_game_running(&nothing).await);
    }

    #[test]
    fn the_fixed_clock_is_the_goldens() {
        assert_eq!(NOW_MS, 1_795_399_200_000);
    }
}

/// Opt in: run T03's `parity/fake-lcu.ts`, then point `BMT_PARITY_LEAGUE_DIR`,
/// `BMT_PARITY_CA` and `BMT_PARITY_LIVE_PORT` at it and `BMT_TEST_DATA` at a
/// fixture copy's data root. Runs T20's sync and both trackers over the real
/// transport, with Dragon over the copy's caches and the web blocked, and
/// prints every event, and the two commands' answers at `BMT_TEST_CALLS_MS`
/// after the first connected status, as JSON lines.
#[cfg(all(test, feature = "parity-driver"))]
mod parity_run {
    use std::path::PathBuf;
    use std::time::Instant as WallInstant;

    use serde_json::json;

    use super::*;
    use crate::commands::lcu::{BackfillOutcome, BackfillProgress};
    use crate::dragon::Dragon;
    use crate::lcu::sync::{Champions, Env, LcuSync};
    use crate::live::test_env::NOW_MS;

    struct PrintingEnv {
        started: WallInstant,
        db: Database,
        dragon: Dragon,
        out: Mutex<()>,
    }

    impl PrintingEnv {
        fn print(&self, kind: &str, event: &str, payload: Value) {
            let _line = self.out.lock().unwrap();
            let line = json!({"t": self.started.elapsed().as_millis() as u64, "event": event, "payload": payload});
            println!("{kind} {line}");
        }
    }

    impl Env for PrintingEnv {
        fn db(&self) -> Option<&Database> {
            Some(&self.db)
        }
        fn champions(&self) -> Option<Arc<dyn Champions>> {
            Some(Arc::new(self.dragon.clone()))
        }
        fn now_ms(&self) -> i64 {
            NOW_MS
        }
        fn games_updated(&self) {
            self.print("EVENT", "lcu:games-updated", Value::Null);
        }
        fn backfill_progress(&self, progress: &BackfillProgress) {
            self.print(
                "EVENT",
                "lcu:backfill-progress",
                serde_json::to_value(progress).unwrap(),
            );
        }
        fn backfill_done(&self, outcome: &BackfillOutcome) {
            self.print(
                "EVENT",
                "lcu:backfill-done",
                serde_json::to_value(outcome).unwrap(),
            );
        }
    }

    impl TrackingEnv for PrintingEnv {
        fn db(&self) -> Option<&Database> {
            Some(&self.db)
        }
        fn now_ms(&self) -> i64 {
            NOW_MS
                + std::env::var("BMT_TEST_DAYS")
                    .ok()
                    .and_then(|d| d.parse::<i64>().ok())
                    .unwrap_or(0)
                    * 86_400_000
        }
        fn champion_data(&self) -> ChampionData {
            self.dragon.loaded_champion_data()
        }
        fn spell_keys(&self) -> BoxFuture<'_, Option<Arc<HashMap<String, i64>>>> {
            Box::pin(async move { self.dragon.summoner_spell_keys().await.ok() })
        }
        fn spell_data(&self) -> BoxFuture<'_, Option<Arc<SummonerSpellData>>> {
            Box::pin(async move { self.dragon.summoner_spells().await.ok() })
        }
        fn live_changed(&self, snapshot: &LiveGameSnapshot) {
            self.print(
                "EVENT",
                "live:changed",
                serde_json::to_value(snapshot).unwrap(),
            );
        }
        fn challenges_changed(&self, result: &ChallengesResult) {
            self.print(
                "EVENT",
                "challenges:changed",
                serde_json::to_value(result).unwrap(),
            );
        }
    }

    #[ignore = "needs a running parity fake client"]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn against_the_parity_fake_client() {
        let root = PathBuf::from(std::env::var_os("BMT_TEST_DATA").expect("BMT_TEST_DATA"));
        let ms = |name: &str, fallback: u64| {
            std::env::var(name)
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(fallback)
        };
        let calls: Vec<u64> = std::env::var("BMT_TEST_CALLS_MS")
            .unwrap_or_default()
            .split(',')
            .filter_map(|v| v.parse().ok())
            .collect();
        let started = WallInstant::now();
        let web = crate::assets::app_web().expect("the parity web");
        let assets = crate::assets::GameAssets::new(
            root.join("asset-cache"),
            web.clone(),
            Arc::new(crate::assets::NoClient),
        );
        let dragon = Dragon::new(web, assets.clone(), root.join("data"));
        drop(dragon.load_champion_data());
        assets.start();
        dragon.start();
        let env = Arc::new(PrintingEnv {
            started,
            db: Database::open(&root.join("data"), NOW_MS).expect("open the fixture copy"),
            dragon,
            out: Mutex::default(),
        });
        let printer = env.clone();
        let sync = LcuSync::new(
            env.clone(),
            Handle::current(),
            Box::new(move |status| {
                printer.print("EVENT", "lcu:status-changed", Value::from(status.as_str()))
            }),
        );
        let client: Arc<dyn Client> = Arc::new(sync.lcu.clone());
        let game: Arc<dyn GameApi> = Arc::new(HttpGameApi::new(GameApiTarget::from_env()));
        let tracking = Tracking::new(
            LiveTracker::new(client.clone(), game, env.clone(), Handle::current()),
            ChallengeTracker::new(client, env.clone(), Handle::current()),
        );
        let mut changes = sync.lcu.subscribe();
        sync.start_polling();
        tracking.start(&Handle::current(), sync.lcu.subscribe());

        let live = tracking.live();
        let challenges = tracking.challenges();
        let lcu = sync.lcu.clone();
        let caller = env.clone();
        tokio::spawn(async move {
            while let Ok(status) = changes.recv().await {
                if status.is_client_connected() {
                    break;
                }
            }
            let connected = WallInstant::now();
            for at in calls {
                tokio::time::sleep_until(tokio::time::Instant::from_std(
                    connected + Duration::from_millis(at),
                ))
                .await;
                let snapshot = if lcu.is_client_connected() {
                    live.refresh().await
                } else {
                    live.latest()
                };
                caller.print(
                    "CALL",
                    "live:snapshot",
                    serde_json::to_value(snapshot).unwrap(),
                );
                let result = challenges.get_challenges().map_err(|e| e.message);
                caller.print(
                    "CALL",
                    "challenges:get",
                    serde_json::to_value(result.ok()).unwrap(),
                );
            }
        });
        tokio::time::sleep(Duration::from_millis(ms("BMT_TEST_RUN_MS", 20_000))).await;
        tracking.stop();
        sync.stop_polling();
        env.db.close();
    }
}

/// Opt in: [`golden::seed`] against what trunk Electron answered under T03's
/// fake client, and against T05's state goldens when they are on disk.
/// `BMT_T21_SCRIPTS` names `record-scenarios.ts`'s output, `BMT_T21_FIXTURE`
/// a fixture data root, `BMT_T21_RUNS` the folder of `t21-run.ts` Electron
/// runs, and `BMT_GOLDEN_DIR` T05's goldens.
#[cfg(test)]
mod golden_states {
    use std::path::{Path, PathBuf};

    use super::golden::seed;
    use super::test_env::{StubClient, TestEnv};
    use super::*;

    fn canonical(value: &Value) -> Value {
        match value {
            Value::Object(map) => {
                let mut keys: Vec<&String> = map.keys().collect();
                keys.sort();
                Value::Object(
                    keys.into_iter()
                        .map(|k| (k.clone(), canonical(&map[k])))
                        .collect(),
                )
            }
            Value::Array(items) => Value::Array(items.iter().map(canonical).collect()),
            Value::Number(n) => serde_json::Number::from_f64(n.as_f64().unwrap())
                .map_or(value.clone(), Value::Number),
            other => other.clone(),
        }
    }

    fn copy_dir(from: &Path, to: &Path) {
        std::fs::create_dir_all(to).unwrap();
        for entry in std::fs::read_dir(from).unwrap().flatten() {
            let target = to.join(entry.file_name());
            if entry.file_type().unwrap().is_dir() {
                copy_dir(&entry.path(), &target);
            } else {
                std::fs::copy(entry.path(), target).unwrap();
            }
        }
    }

    /// The command's answer in `state`, on a fresh copy of the fixture.
    async fn answer(
        state: &str,
        channel: &str,
        scripts: &Path,
        fixture: &Path,
        n: usize,
    ) -> Option<Value> {
        let dir = std::env::temp_dir().join(format!("bmt-live-golden-{}-{n}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        copy_dir(&fixture.join("data"), &dir);
        let env = TestEnv::over(dir);
        let idle = StubClient::new();
        idle.connected.store(false, Ordering::SeqCst);
        let tracking = Tracking::new(
            LiveTracker::new(
                idle.clone(),
                Arc::new(HttpGameApi::new(GameApiTarget::Refused)),
                env.clone(),
                Handle::current(),
            ),
            ChallengeTracker::new(idle, env.clone(), Handle::current()),
        );
        if !seed(&tracking, env.clone(), Handle::current(), state, scripts)
            .await
            .unwrap()
        {
            return None;
        }
        match channel {
            "live:snapshot" => {
                let live = tracking.live();
                let connected = live.client.is_client_connected();
                let snapshot = if connected {
                    live.refresh().await
                } else {
                    live.latest()
                };
                Some(serde_json::to_value(snapshot).unwrap())
            }
            _ => {
                Some(serde_json::to_value(tracking.challenges().get_challenges().unwrap()).unwrap())
            }
        }
    }

    /// The first command answer of `channel` in an Electron run's events.
    fn electron_call(runs: &Path, run: &str, channel: &str) -> Option<Value> {
        let log = std::fs::read_to_string(runs.join(run).join("electron-events.log")).ok()?;
        log.lines().find_map(|line| {
            let body: Value = serde_json::from_str(line.strip_prefix("CALL ")?).ok()?;
            (body["event"] == channel).then(|| body["payload"].clone())
        })
    }

    #[ignore = "needs the T21 scripts, a fixture, and Electron runs or goldens"]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn seeded_states_answer_as_electron_did() {
        let path = |name| PathBuf::from(std::env::var_os(name).unwrap_or_else(|| panic!("{name}")));
        let (scripts, fixture) = (path("BMT_T21_SCRIPTS"), path("BMT_T21_FIXTURE"));
        let runs = std::env::var_os("BMT_T21_RUNS").map(PathBuf::from);
        let goldens = std::env::var_os("BMT_GOLDEN_DIR").map(PathBuf::from);
        let mut checked = 0;
        let mut failures = Vec::new();
        let mut n = 0;
        let mut check = |label: String, want: Value, got: Option<Value>| {
            let Some(got) = got else {
                println!("skip {label}: a state with nothing to seed");
                return;
            };
            if canonical(&want) == canonical(&got) {
                println!("pass {label}");
            } else {
                println!("FAIL {label}\n  electron {want}\n  rust     {got}");
                failures.push(label);
            }
            checked += 1;
        };
        if let Some(runs) = &runs {
            for (state, run, channel) in [
                ("live-in-game", "electron-in-game", "live:snapshot"),
                ("live-loading", "electron-in-game-loading", "live:snapshot"),
                (
                    "live-champ-select",
                    "electron-champ-select",
                    "live:snapshot",
                ),
                (
                    "challenges-loaded",
                    "electron-challenges-loaded",
                    "challenges:get",
                ),
            ] {
                let Some(want) = electron_call(runs, run, channel) else {
                    println!("skip {state}: no {run} run");
                    continue;
                };
                n += 1;
                check(
                    format!("{state} {channel} against {run}"),
                    want,
                    answer(state, channel, &scripts, &fixture, n).await,
                );
            }
        }
        if let Some(goldens) = &goldens {
            for channel in ["live:snapshot", "challenges:get"] {
                for (case, state) in golden::states_of_cases(goldens, channel) {
                    let file = goldens
                        .join("ipc")
                        .join(channel.replace(':', "."))
                        .join(format!("{case}.json"));
                    let Ok(text) = std::fs::read_to_string(&file) else {
                        continue;
                    };
                    let golden: Value = serde_json::from_str(&text).unwrap();
                    n += 1;
                    check(
                        format!("{state} {channel} {case} against T05"),
                        golden["outcome"]["result"].clone(),
                        answer(&state, channel, &scripts, &fixture, n).await,
                    );
                }
            }
        }
        println!("{checked} checked, {} failed", failures.len());
        assert!(failures.is_empty(), "{failures:?}");
    }
}
