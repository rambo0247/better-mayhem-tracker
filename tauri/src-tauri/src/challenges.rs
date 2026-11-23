//! The Challenges tab's data, `src/main/challenges.ts`: the ARAM challenge
//! tree read from the client, snapshotted once a day, and stored so the tab
//! draws with the client closed. Also what each game moved, which the client
//! only answers for the most recent game and so is captured as it ends.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::FutureExt;
use futures_util::future::{BoxFuture, Shared};
use jiff::civil::Date;
use jiff::tz::TimeZone;
use serde_json::Value;
use tokio::runtime::Handle;

use crate::assets::log;
use crate::commands::CommandError;
use crate::commands::live::{
    ChallengeGroup, ChallengePlayerSummary, ChallengeProgress, ChallengeReward, ChallengesData,
    ChallengesResult,
};
use crate::commands::types::ChallengeLevel;
use crate::db::challenges::{
    Baseline, DayValue, GameProgress, get_challenge_baseline, get_stored_challenges,
    has_game_challenges, save_challenges, save_game_challenges,
};
use crate::db::js::{self, opt_prop, or};
use crate::js_arg::{JsNumber, non_finite_as_null};
use crate::lcu::LcuStatus;
use crate::lcu::sync::{Client, js_number, template};
use crate::live::{SESSION_PATH, TrackingEnv, iterate, object_values, query, text, with_db};

/// `ARAM_GAME_MODES`: Mayhem's queues count toward the ARAM challenges.
const ARAM_GAME_MODES: [&str; 3] = ["ARAM", "KIWI", "KIWI_JADE"];
/// `ARAM_CAPSTONE_ID` and `ARAM_GROUP_IDS`, named because the tree's own
/// nodes carry no game modes.
const ARAM_CAPSTONE_ID: f64 = 101000.0;
const ARAM_GROUP_IDS: [f64; 3] = [101100.0, 101200.0, 101300.0];
/// `CHALLENGE_DELTA_DAYS`.
const CHALLENGE_DELTA_DAYS: i32 = 7;
/// `GAME_CAPTURE_DELAYS_MS`: the client can reach "connected" while it is
/// still writing the match up, so an empty first answer isn't final.
pub const GAME_CAPTURE_DELAYS: [Duration; 4] = [
    Duration::ZERO,
    Duration::from_millis(5_000),
    Duration::from_millis(20_000),
    Duration::from_millis(60_000),
];

const CHALLENGES_PATH: &str = "/lol-challenges/v1/challenges/local-player";
const SUMMARY_PATH: &str = "/lol-challenges/v1/summary-player-data/local-player";

const LEVELS: [(&str, ChallengeLevel); 9] = [
    ("IRON", ChallengeLevel::Iron),
    ("BRONZE", ChallengeLevel::Bronze),
    ("SILVER", ChallengeLevel::Silver),
    ("GOLD", ChallengeLevel::Gold),
    ("PLATINUM", ChallengeLevel::Platinum),
    ("DIAMOND", ChallengeLevel::Diamond),
    ("MASTER", ChallengeLevel::Master),
    ("GRANDMASTER", ChallengeLevel::Grandmaster),
    ("CHALLENGER", ChallengeLevel::Challenger),
];

fn level_name(level: ChallengeLevel) -> &'static str {
    LEVELS
        .iter()
        .find(|(_, l)| *l == level)
        .map_or("NONE", |(name, _)| name)
}

// ---------------------------------------------------------------------------
// Days

/// `challengeDay`: the local calendar day, in the process time zone as
/// `new Date(ts)` reads it.
pub fn challenge_day(ms: i64) -> String {
    let date = jiff::Timestamp::from_millisecond(ms)
        .map(|t| t.to_zoned_datetime(TimeZone::system()).date())
        .unwrap_or_default();
    format_day(date)
}

fn format_day(date: Date) -> String {
    format!("{:04}-{:02}-{:02}", date.year(), date.month(), date.day())
}

/// `daysBefore`: `new Date(y, m - 1, d - days)` rolls over the calendar, and
/// local midnight always falls on its own day, so this is date arithmetic.
pub fn days_before(day: &str, days: i32) -> String {
    let parse = |range: std::ops::Range<usize>| day.get(range)?.parse::<i16>().ok();
    let date = parse(0..4)
        .zip(parse(5..7))
        .zip(parse(8..10))
        .and_then(|((y, m), d)| Date::new(y, m as i8, 1).ok().map(|first| (first, d)))
        .and_then(|(first, d)| {
            first
                .checked_add(jiff::Span::new().days(i64::from(d) - 1 - i64::from(days)))
                .ok()
        });
    date.map_or_else(String::new, format_day)
}

/// `challengeFraction`: how far a challenge has come through its tier.
fn challenge_fraction(value: f64, current: f64, next: Option<f64>) -> f64 {
    let Some(next) = next else { return 1.0 };
    let span = next - current;
    if span <= 0.0 {
        return 0.0;
    }
    ((value - current) / span).clamp(0.0, 1.0)
}

// ---------------------------------------------------------------------------
// Shaping Riot's challenge objects

/// `finite(value, fallback)`.
fn finite(value: Option<&Value>, fallback: f64) -> f64 {
    let number = js_number(value);
    if number.is_finite() { number } else { fallback }
}

/// `toLevel`.
fn to_level(value: Option<&Value>) -> ChallengeLevel {
    let level = text(value);
    LEVELS
        .iter()
        .find(|(name, _)| *name == level)
        .map_or(ChallengeLevel::None, |(_, level)| *level)
}

fn rewards_for(raw: &Value, level: ChallengeLevel) -> Vec<ChallengeReward> {
    let thresholds = opt_prop(Some(raw), "thresholds");
    let list = opt_prop(opt_prop(thresholds, level_name(level)), "rewards");
    let Some(Value::Array(list)) = list else {
        return Vec::new();
    };
    list.iter()
        .map(|reward| ChallengeReward {
            category: text(opt_prop(Some(reward), "category")),
            name: text(opt_prop(Some(reward), "name")),
            quantity: finite(opt_prop(Some(reward), "quantity"), 0.0),
        })
        .collect()
}

/// `tokenPath`: an unstarted challenge has no token of its own, so it wears
/// the IRON one.
fn token_path(raw: &Value, level: ChallengeLevel) -> String {
    let paths = opt_prop(Some(raw), "levelToIconPath");
    let tier = if level == ChallengeLevel::None {
        "IRON"
    } else {
        level_name(level)
    };
    text(opt_prop(paths, tier))
}

/// `String(a || b || "")`.
fn first_text(values: &[Option<&Value>]) -> String {
    static EMPTY: Value = Value::String(String::new());
    let mut operands = values.to_vec();
    operands.push(Some(&EMPTY));
    template(or(&operands))
}

/// The ids a JavaScript `Map` or `Set` tells apart: `-0` is `0`.
fn id_key(id: f64) -> u64 {
    if id == 0.0 {
        0f64.to_bits()
    } else {
        id.to_bits()
    }
}

fn shape(raw: &Value, baseline: Option<&HashMap<String, f64>>) -> ChallengeProgress {
    let field = |key| opt_prop(Some(raw), key);
    let id = js_number(field("id"));
    let level = to_level(field("currentLevel"));
    let next_level = to_level(field("nextLevel"));
    // An empty nextLevel is the client saying the top tier is reached
    let maxed = next_level == ChallengeLevel::None;
    let value = finite(field("currentValue"), 0.0);
    let previous = baseline.and_then(|values| values.get(&js::number_to_string(id)));
    let name = match field("name") {
        None | Some(Value::Null) => format!("Challenge {}", js::number_to_string(id)),
        name => template(name),
    };
    ChallengeProgress {
        id: JsNumber(id),
        name,
        description: first_text(&[field("description"), field("descriptionShort")]),
        level,
        value,
        current_threshold: finite(field("currentThreshold"), 0.0),
        next_level: (!maxed).then_some(next_level),
        next_threshold: (!maxed).then(|| finite(field("nextThreshold"), 0.0)),
        next_rewards: if maxed {
            Vec::new()
        } else {
            rewards_for(raw, next_level)
        },
        percentile: finite(field("percentile"), 100.0),
        points_awarded: finite(field("pointsAwarded"), 0.0),
        icon_path: token_path(raw, level),
        retired: finite(field("retireTimestamp"), 0.0) > 0.0,
        completed_champion_ids: (field("idListType") == Some(&Value::String("CHAMPION".into())))
            .then(|| match field("completedIds") {
                Some(Value::Array(ids)) => ids
                    .iter()
                    .map(|id| Some(JsNumber(js_number(Some(id)))))
                    .collect(),
                _ => Vec::new(),
            }),
        delta: previous.map(|previous| value - previous),
    }
}

/// `isAramChallenge`: the tree by id, everything else by game mode.
fn is_aram_challenge(raw: &Value) -> bool {
    let id = js_number(opt_prop(Some(raw), "id"));
    if id == ARAM_CAPSTONE_ID || ARAM_GROUP_IDS.contains(&id) {
        return true;
    }
    match opt_prop(Some(raw), "gameModes") {
        Some(Value::Array(modes)) => modes
            .iter()
            .any(|mode| ARAM_GAME_MODES.contains(&template(Some(mode)).as_str())),
        _ => false,
    }
}

/// `byProgress`'s rank: closest to a new tier first, finished ones last.
fn rank(c: &ChallengeProgress) -> f64 {
    match c.next_threshold {
        None => -1.0,
        next => challenge_fraction(c.value, c.current_threshold, next),
    }
}

fn player_summary(summary: Option<&Value>) -> ChallengePlayerSummary {
    let field = |key| opt_prop(summary, key);
    let points = match field("categoryProgress") {
        Some(Value::Array(categories)) => categories.iter().fold(0.0, |total, c| {
            total + finite(opt_prop(Some(c), "current"), 0.0)
        }),
        _ => 0.0,
    };
    ChallengePlayerSummary {
        level: to_level(field("overallChallengeLevel")),
        // The client reports points per category and never a total
        points,
        points_until_next_rank: finite(field("pointsUntilNextRank"), 0.0),
        percentile: finite(field("positionPercentile"), 100.0),
        title: text(opt_prop(field("title"), "name")),
    }
}

/// `shapeGameChallenge`.
fn shape_game_challenge(raw: &Value) -> GameProgress {
    let field = |key| opt_prop(Some(raw), key);
    let level = to_level(field("currentLevel"));
    let next_level = to_level(field("nextLevel"));
    let maxed = next_level == ChallengeLevel::None;
    let name = match field("name") {
        None | Some(Value::Null) => format!("Challenge {}", template(field("id"))),
        name => template(name),
    };
    GameProgress {
        id: js_number(field("id")),
        name,
        description: first_text(&[field("description"), field("descriptionShort")]),
        previous_value: finite(field("previousValue"), 0.0),
        current_value: finite(field("currentValue"), 0.0),
        previous_level: level_name(to_level(field("previousLevel"))),
        current_level: level_name(level),
        next_level: (!maxed).then(|| level_name(next_level)),
        next_threshold: (!maxed).then(|| finite(field("nextThreshold"), 0.0)),
        icon_path: token_path(raw, level),
    }
}

/// `!raw || typeof raw !== "object"`: only an object or an array has values.
fn has_values(raw: Option<&Value>) -> Option<&Value> {
    raw.filter(|raw| matches!(raw, Value::Object(_) | Value::Array(_)))
}

/// The challenges payload as `JSON.stringify` writes it, numbers included.
fn stringify(data: &ChallengesData) -> Result<String, String> {
    let mut value = serde_json::to_value(data).map_err(|err| err.to_string())?;
    non_finite_as_null(&mut value);
    Ok(js::stringify(&value))
}

// ---------------------------------------------------------------------------
// The tracker

type Refresh = Shared<BoxFuture<'static, Option<ChallengesData>>>;

pub struct ChallengeTracker {
    client: Arc<dyn Client>,
    env: Arc<dyn TrackingEnv>,
    runtime: Handle,
    /// One refresh at a time: the tab, the status listener and a manual
    /// refresh can all land together
    refreshing: Mutex<Option<Refresh>>,
    /// Games a capture chain is already running for
    capture_pending: Mutex<HashSet<u64>>,
    /// Whether events reach the window: `win` is set by `startChallengeTracking`
    emitting: AtomicBool,
}

impl ChallengeTracker {
    pub fn new(client: Arc<dyn Client>, env: Arc<dyn TrackingEnv>, runtime: Handle) -> Arc<Self> {
        Arc::new(Self {
            client,
            env,
            runtime,
            refreshing: Mutex::new(None),
            capture_pending: Mutex::new(HashSet::new()),
            emitting: AtomicBool::new(false),
        })
    }

    async fn json(&self, path: &str) -> Option<Value> {
        self.client.request_json(path).await.ok()
    }

    /// `refreshChallenges`: the ARAM tree from the running client, written
    /// down, and returned. `None` when the client answered with nothing usable.
    async fn refresh_challenges(&self) -> Result<Option<ChallengesData>, String> {
        let (raw, summary) =
            futures_util::join!(self.json(CHALLENGES_PATH), self.json(SUMMARY_PATH));
        let Some(raw) = has_values(raw.as_ref()) else {
            return Ok(None);
        };
        let summary = summary.as_ref();

        // A Map by id: a repeated id keeps its first place and its last value
        let mut order: Vec<u64> = Vec::new();
        let mut by_id: HashMap<u64, &Value> = HashMap::new();
        for entry in object_values(raw) {
            let id = js_number(opt_prop(Some(entry), "id"));
            if id.is_finite() && by_id.insert(id_key(id), entry).is_none() {
                order.push(id_key(id));
            }
        }
        // An empty answer would overwrite a good snapshot with a blank one
        if by_id.is_empty() {
            return Ok(None);
        }

        let today = challenge_day(self.env.now_ms());
        let cutoff = days_before(&today, CHALLENGE_DELTA_DAYS);
        let baseline: Option<Baseline> = with_db(self.env.as_ref(), |conn| {
            get_challenge_baseline(conn, &cutoff, &today)
        })?;
        let values = baseline.as_ref().map(|b| &b.values);
        let shape_one = |entry: &Value| shape(entry, values);

        let mut in_tree: HashSet<u64> = HashSet::from([id_key(ARAM_CAPSTONE_ID)]);
        let mut groups = Vec::new();
        for group_id in ARAM_GROUP_IDS {
            let Some(node) = by_id.get(&id_key(group_id)) else {
                continue;
            };
            in_tree.insert(id_key(group_id));
            let mut challenges = Vec::new();
            let children = iterate(opt_prop(Some(node), "childrenIds"), "node.childrenIds")
                .map_err(|err| format!("TypeError: {err}"))?;
            for raw_child in &children {
                let child_id = js_number(Some(raw_child));
                let Some(child) = by_id.get(&id_key(child_id)) else {
                    continue;
                };
                in_tree.insert(id_key(child_id));
                challenges.push(shape_one(child));
            }
            challenges.sort_by(|a, b| {
                rank(b)
                    .partial_cmp(&rank(a))
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
            groups.push(ChallengeGroup {
                summary: shape_one(node),
                challenges,
            });
        }

        let capstone = by_id
            .get(&id_key(ARAM_CAPSTONE_ID))
            .map(|raw| shape_one(raw));
        let mut seasonal: Vec<(f64, ChallengeProgress)> = order
            .iter()
            .map(|key| by_id[key])
            .filter(|entry| {
                let id = js_number(opt_prop(Some(entry), "id"));
                !in_tree.contains(&id_key(id)) && is_aram_challenge(entry)
            })
            .map(|entry| (js_number(opt_prop(Some(entry), "id")), shape_one(entry)))
            .collect();
        seasonal.sort_by(|(a, _), (b, _)| {
            (b - a)
                .partial_cmp(&0.0)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        let seasonal: Vec<ChallengeProgress> = seasonal.into_iter().map(|(_, c)| c).collect();

        let equipped = text(opt_prop(summary, "selectedChallengesString"))
            .split(',')
            .map(js::string_to_number)
            .filter(|id| id.is_finite())
            .filter_map(|id| by_id.get(&id_key(id)))
            .map(|entry| shape_one(entry))
            .collect();

        let data = ChallengesData {
            player: player_summary(summary),
            capstone,
            groups,
            seasonal,
            equipped,
            fetched_at: self.env.now_ms(),
            since: baseline.map(|b| b.day),
        };

        // Retired challenges are frozen, and the equipped three are whatever
        // the player pinned, so neither earns a row a day
        let tracked: Vec<DayValue> = data
            .capstone
            .iter()
            .chain(
                data.groups
                    .iter()
                    .flat_map(|g| std::iter::once(&g.summary).chain(&g.challenges)),
            )
            .chain(&data.seasonal)
            .filter(|c| !c.retired)
            .map(|c| DayValue {
                id: c.id.0,
                value: c.value,
                level: level_name(c.level),
            })
            .collect();
        let payload = stringify(&data)?;
        // saveChallenges stamps the row with a clock read of its own
        let now = self.env.now_ms();
        with_db(self.env.as_ref(), |conn| {
            save_challenges(conn, &today, &payload, &tracked, now)
        })?;
        Ok(Some(data))
    }

    /// `readStored`: the stored payload, with `fetchedAt` off the row. Only a
    /// payload that won't parse is caught; a failed read throws.
    fn read_stored(&self) -> Result<Option<ChallengesData>, CommandError> {
        let Some((payload, fetched_at)) = query(self.env.as_ref(), get_stored_challenges)? else {
            return Ok(None);
        };
        let parsed =
            serde_json::from_str::<Value>(&payload).map_err(|err| format!("SyntaxError: {err}"));
        let shaped = parsed.and_then(|mut value| {
            if let Value::Object(map) = &mut value {
                map.insert("fetchedAt".into(), Value::from(fetched_at as i64));
            }
            serde_json::from_value::<ChallengesData>(value).map_err(|err| err.to_string())
        });
        Ok(match shaped {
            Ok(data) => Some(data),
            Err(err) => {
                log(format!("Stored challenges unreadable: {err}"));
                None
            }
        })
    }

    /// `refreshAndBroadcast`: the one refresh in flight, started if there is
    /// none. It runs whether or not anyone waits on it.
    pub fn refresh_and_broadcast(self: &Arc<Self>) -> Refresh {
        let mut refreshing = self.refreshing.lock().expect("refresh lock");
        if let Some(running) = refreshing.as_ref() {
            return running.clone();
        }
        let this = self.clone();
        let refresh = async move {
            let data = match this.refresh_challenges().await {
                Ok(Some(data)) => {
                    if this.emitting.load(Ordering::SeqCst) {
                        this.env.challenges_changed(&ChallengesResult {
                            data: Some(data.clone()),
                            pending: false,
                        });
                    }
                    Some(data)
                }
                Ok(None) => None,
                Err(err) => {
                    log(format!("Challenge fetch failed: {err}"));
                    None
                }
            };
            *this.refreshing.lock().expect("refresh lock") = None;
            data
        }
        .boxed()
        .shared();
        *refreshing = Some(refresh.clone());
        drop(refreshing);
        self.runtime.spawn(refresh.clone());
        refresh
    }

    /// `getChallenges`: the stored snapshot at once, and a live refresh in the
    /// background when the client is up, which arrives as `challenges:changed`.
    pub fn get_challenges(self: &Arc<Self>) -> Result<ChallengesResult, CommandError> {
        let pending = self.client.is_client_connected();
        let data = self.read_stored();
        if pending {
            drop(self.refresh_and_broadcast());
        }
        Ok(ChallengesResult {
            data: data?,
            pending,
        })
    }

    /// `captureGameChallenges`: how many challenges one game moved, written
    /// down, or 0 when the client has nothing for it.
    async fn capture_game_challenges(&self, game_id: f64) -> Result<usize, String> {
        let path = format!(
            "/lol-challenges/v1/my-updated-challenges/{}",
            js::number_to_string(game_id)
        );
        // A game with no movement answers 404, which reads as no answer
        let raw = self.json(&path).await;
        let Some(raw) = has_values(raw.as_ref()) else {
            return Ok(0);
        };
        let rows: Vec<GameProgress> = object_values(raw)
            .into_iter()
            .filter(|entry| js_number(opt_prop(Some(entry), "id")).is_finite())
            .map(shape_game_challenge)
            .collect();
        if rows.is_empty() {
            return Ok(0);
        }
        with_db(self.env.as_ref(), |conn| {
            save_game_challenges(conn, game_id, &rows)
        })?;
        log(format!(
            "Captured {} challenge updates for game {}",
            rows.len(),
            js::number_to_string(game_id)
        ));
        Ok(rows.len())
    }

    /// `startGameCapture`: up to four tries, each after the one before ends.
    pub fn start_game_capture(self: &Arc<Self>, game_id: f64) -> Result<(), String> {
        {
            // Checked and claimed in one step, as the synchronous original is
            let mut pending = self.capture_pending.lock().expect("capture lock");
            if pending.contains(&id_key(game_id))
                || with_db(self.env.as_ref(), |conn| has_game_challenges(conn, game_id))?
            {
                return Ok(());
            }
            pending.insert(id_key(game_id));
        }
        let this = self.clone();
        self.runtime.spawn(async move {
            for delay in GAME_CAPTURE_DELAYS {
                if !delay.is_zero() {
                    tokio::time::sleep(delay).await;
                }
                match this.capture_game_challenges(game_id).await {
                    Ok(0) => {}
                    Ok(_) => break,
                    Err(err) => log(format!(
                        "Challenge capture for game {} failed: {err}",
                        js::number_to_string(game_id)
                    )),
                }
            }
            this.capture_pending
                .lock()
                .expect("capture lock")
                .remove(&id_key(game_id));
        });
        Ok(())
    }

    /// `capturableGameId`: the match this process watched end, or the one the
    /// gameflow session still names while the post-game screen is up.
    async fn capturable_game_id(&self) -> Option<f64> {
        if let Some(live) = self.client.live_game_ref() {
            return Some(live.game_id);
        }
        let session = self.json(SESSION_PATH).await;
        let game_id = js_number(opt_prop(opt_prop(session.as_ref(), "gameData"), "gameId"));
        (game_id.is_finite() && game_id > 0.0).then_some(game_id)
    }

    /// The status listener `startChallengeTracking` registers: leaving a match
    /// is when the numbers move, and the finished game is still the one the
    /// client will answer about.
    pub(crate) fn on_status(self: &Arc<Self>, status: LcuStatus) {
        if status != LcuStatus::Connected {
            return;
        }
        let this = self.clone();
        self.runtime.spawn(async move {
            this.refresh_and_broadcast().await;
            if let Some(game_id) = this.capturable_game_id().await
                && let Err(err) = this.start_game_capture(game_id)
            {
                log(format!("Unhandled rejection: {err}"));
            }
        });
    }

    pub(crate) fn start_tracking(&self) {
        self.emitting.store(true, Ordering::SeqCst);
    }

    pub(crate) fn stop_tracking(&self) {
        self.emitting.store(false, Ordering::SeqCst);
    }

    #[cfg(test)]
    fn pending_captures(&self) -> usize {
        self.capture_pending.lock().expect("capture lock").len()
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use serde_json::json;
    use tokio::sync::Notify;

    use super::*;
    use crate::lcu::LiveGameRef;
    use crate::live::test_env::{NOW_MS, Reply, StubClient, TestEnv, settle};

    const DAY_MS: i64 = 86_400_000;

    struct Rig {
        client: Arc<StubClient>,
        env: Arc<TestEnv>,
        challenges: Arc<ChallengeTracker>,
    }

    fn rig(name: &str) -> Rig {
        let client = StubClient::new();
        let env = TestEnv::new(&format!("challenges-{name}"));
        let challenges = ChallengeTracker::new(client.clone(), env.clone(), Handle::current());
        challenges.start_tracking();
        Rig {
            client,
            env,
            challenges,
        }
    }

    fn challenge(
        id: i64,
        level: &str,
        next: &str,
        value: f64,
        current: f64,
        next_threshold: f64,
    ) -> Value {
        json!({
            "id": id, "name": format!("C{id}"), "descriptionShort": format!("short {id}"),
            "currentLevel": level, "nextLevel": next, "currentValue": value,
            "currentThreshold": current, "nextThreshold": next_threshold,
            "levelToIconPath": { "IRON": format!("/iron/{id}.png"), "GOLD": format!("/gold/{id}.png") },
            "thresholds": { "PLATINUM": { "rewards": [{ "category": "TITLE", "name": "Champ", "quantity": 1 }] } },
            "gameModes": [],
        })
    }

    /// The capstone, one group with three children, two seasonal ARAM
    /// challenges, one that isn't ARAM, a retired one, and an id twice.
    fn tree() -> Value {
        let mut all = serde_json::Map::new();
        let mut put = |value: Value| {
            all.insert(value["id"].to_string(), value);
        };
        put(challenge(
            101000, "GOLD", "PLATINUM", 1820.0, 1200.0, 2400.0,
        ));
        let mut group = challenge(101100, "SILVER", "GOLD", 50.0, 0.0, 100.0);
        group["childrenIds"] = json!([101101, 101102, "101103", 999]);
        put(group);
        put(challenge(101101, "IRON", "BRONZE", 1.0, 0.0, 10.0));
        put(challenge(101102, "GOLD", "PLATINUM", 9.0, 0.0, 10.0));
        put(challenge(101103, "CHALLENGER", "", 99.0, 90.0, 1.0));
        let mut seasonal = challenge(202001, "NONE", "IRON", 0.0, 0.0, 5.0);
        seasonal["gameModes"] = json!(["KIWI"]);
        seasonal["description"] = json!("long");
        put(seasonal);
        let mut retired = challenge(202005, "GOLD", "", 3.0, 0.0, 0.0);
        retired["gameModes"] = json!(["ARAM"]);
        retired["retireTimestamp"] = json!(1);
        retired["idListType"] = json!("CHAMPION");
        retired["completedIds"] = json!([1, "2"]);
        put(retired);
        put(challenge(303001, "GOLD", "PLATINUM", 1.0, 0.0, 2.0));
        Value::Object(all)
    }

    fn summary() -> Value {
        json!({
            "overallChallengeLevel": "GOLD",
            "categoryProgress": [{ "current": 900 }, { "current": "70" }, { "current": "x" }],
            "pointsUntilNextRank": 580,
            "positionPercentile": 0.18,
            "title": { "name": "Mayhem Veteran" },
            "selectedChallengesString": "303001,,abc,101101,404",
        })
    }

    fn serve(rig: &Rig) {
        rig.client.route(CHALLENGES_PATH, vec![Reply::Json(tree())]);
        rig.client.route(SUMMARY_PATH, vec![Reply::Json(summary())]);
    }

    fn ids(list: &[ChallengeProgress]) -> Vec<i64> {
        list.iter().map(|c| c.id.0 as i64).collect()
    }

    #[tokio::test]
    async fn the_aram_tree_is_shaped_stored_and_sent() {
        let rig = rig("tree");
        serve(&rig);
        let data = rig.challenges.refresh_and_broadcast().await.expect("data");

        assert_eq!(data.capstone.as_ref().map(|c| c.id.0), Some(101000.0));
        assert_eq!(data.groups.len(), 1);
        // Closest to a new tier first, finished last
        assert_eq!(
            ids(&data.groups[0].challenges),
            vec![101102, 101101, 101103]
        );
        assert_eq!(ids(&data.seasonal), vec![202005, 202001]);
        assert_eq!(ids(&data.equipped), vec![303001, 101101]);
        assert_eq!(data.player.points, 970.0);
        assert_eq!((data.fetched_at, data.since.as_deref()), (NOW_MS, None));

        let maxed = &data.groups[0].challenges[2];
        assert_eq!(
            (
                maxed.next_level,
                maxed.next_threshold,
                maxed.next_rewards.len()
            ),
            (None, None, 0)
        );
        let unstarted = &data.seasonal[1];
        assert_eq!(
            (
                unstarted.level,
                unstarted.icon_path.as_str(),
                unstarted.description.as_str()
            ),
            (ChallengeLevel::None, "/iron/202001.png", "long")
        );
        let capstone = data.capstone.as_ref().unwrap();
        assert_eq!(
            capstone.next_rewards,
            vec![ChallengeReward {
                category: "TITLE".into(),
                name: "Champ".into(),
                quantity: 1.0
            }]
        );
        assert_eq!(
            (
                capstone.description.as_str(),
                capstone.percentile,
                capstone.delta
            ),
            ("short 101000", 100.0, None)
        );
        let retired = &data.seasonal[0];
        assert_eq!(
            (retired.retired, retired.completed_champion_ids.clone()),
            (true, Some(vec![Some(JsNumber(1.0)), Some(JsNumber(2.0))]))
        );

        // Everything but the retired one and the equipped-only one gets a row
        assert_eq!(
            rig.env.query::<String>("SELECT group_concat(challenge_id || '=' || value || '@' || level, ' ') FROM (SELECT * FROM challenge_history ORDER BY challenge_id)"),
            "101000=1820.0@GOLD 101100=50.0@SILVER 101101=1.0@IRON 101102=9.0@GOLD 101103=99.0@CHALLENGER 202001=0.0@NONE"
        );
        let stored: String = rig.env.query("SELECT payload FROM challenge_state");
        assert_eq!(stored, stringify(&data).unwrap());
        assert!(
            stored.contains(r#""value":1820,"currentThreshold":1200"#),
            "numbers as JavaScript prints them: {stored}"
        );
        assert_eq!(
            rig.env
                .query::<i64>("SELECT fetched_at FROM challenge_state"),
            NOW_MS
        );
        assert_eq!(
            rig.env.events("challenges:changed"),
            vec![json!({ "data": serde_json::to_value(&data).unwrap(), "pending": false })]
        );
    }

    #[tokio::test]
    async fn one_snapshot_a_day_and_deltas_from_a_week_ago() {
        let rig = rig("days");
        serve(&rig);
        rig.challenges.refresh_and_broadcast().await;
        rig.challenges.refresh_and_broadcast().await;
        let today = challenge_day(NOW_MS);
        assert_eq!(
            rig.env
                .query::<i64>("SELECT COUNT(DISTINCT day) FROM challenge_history"),
            1
        );
        assert_eq!(
            rig.env
                .query::<String>("SELECT day FROM challenge_history LIMIT 1"),
            today
        );

        *rig.env.now.lock().unwrap() = NOW_MS + DAY_MS;
        let mut tree = tree();
        tree["101000"]["currentValue"] = json!(1900);
        rig.client.route(CHALLENGES_PATH, vec![Reply::Json(tree)]);
        let next = rig.challenges.refresh_and_broadcast().await.expect("data");
        assert_eq!(
            rig.env
                .query::<i64>("SELECT COUNT(DISTINCT day) FROM challenge_history"),
            2
        );
        // A week of history is not there yet, so the oldest day stands in
        assert_eq!(next.since.as_deref(), Some(today.as_str()));
        assert_eq!(next.capstone.unwrap().delta, Some(80.0));
        assert_eq!(
            next.seasonal[0].delta, None,
            "a retired challenge has no row to measure from"
        );
    }

    #[tokio::test]
    async fn an_empty_answer_keeps_the_stored_snapshot() {
        let rig = rig("empty");
        serve(&rig);
        rig.challenges.refresh_and_broadcast().await;
        for empty in [json!({}), json!([]), json!("x"), json!({"a": {"id": "n"}})] {
            rig.client.route(CHALLENGES_PATH, vec![Reply::Json(empty)]);
            assert_eq!(rig.challenges.refresh_and_broadcast().await, None);
        }
        rig.client.route(CHALLENGES_PATH, vec![Reply::Fail]);
        assert_eq!(rig.challenges.refresh_and_broadcast().await, None);
        assert_eq!(
            rig.env.query::<i64>("SELECT COUNT(*) FROM challenge_state"),
            1
        );
        assert_eq!(rig.env.events("challenges:changed").len(), 1);
    }

    #[tokio::test]
    async fn a_tree_that_cannot_be_walked_is_a_failed_fetch() {
        let rig = rig("not-iterable");
        let mut tree = tree();
        tree["101100"]["childrenIds"] = json!({"a": 1});
        rig.client.route(CHALLENGES_PATH, vec![Reply::Json(tree)]);
        assert_eq!(rig.challenges.refresh_and_broadcast().await, None);
        assert_eq!(
            rig.env.query::<i64>("SELECT COUNT(*) FROM challenge_state"),
            0
        );
    }

    #[tokio::test]
    async fn one_refresh_at_a_time() {
        let rig = rig("single");
        let gate = Arc::new(Notify::new());
        rig.client
            .route(CHALLENGES_PATH, vec![Reply::Held(gate.clone(), tree())]);
        rig.client.route(SUMMARY_PATH, vec![Reply::Json(summary())]);
        let first = rig.challenges.refresh_and_broadcast();
        let second = rig.challenges.refresh_and_broadcast();
        settle().await;
        gate.notify_one();
        assert_eq!(first.await, second.await);
        assert_eq!(rig.client.times(CHALLENGES_PATH).len(), 1);
        rig.client.route(CHALLENGES_PATH, vec![Reply::Json(tree())]);
        rig.challenges.refresh_and_broadcast().await;
        assert_eq!(
            rig.client.times(CHALLENGES_PATH).len(),
            2,
            "a settled refresh frees the slot"
        );
    }

    #[tokio::test]
    async fn the_tab_gets_the_stored_snapshot_at_once() {
        let rig = rig("get");
        serve(&rig);
        rig.client.connected.store(false, Ordering::SeqCst);
        assert_eq!(
            rig.challenges.get_challenges().unwrap(),
            ChallengesResult {
                data: None,
                pending: false
            }
        );
        assert!(rig.client.paths().is_empty(), "offline asks nothing");

        rig.client.connected.store(true, Ordering::SeqCst);
        let first = rig.challenges.get_challenges().unwrap();
        assert_eq!(
            first,
            ChallengesResult {
                data: None,
                pending: true
            }
        );
        settle().await;
        let sent = rig.env.events("challenges:changed");
        assert_eq!(sent.len(), 1, "the refresh arrives as an event");

        rig.env.exec("UPDATE challenge_state SET fetched_at = 42");
        rig.client.connected.store(false, Ordering::SeqCst);
        let stored = rig.challenges.get_challenges().unwrap();
        assert_eq!(
            stored.data.as_ref().map(|d| d.fetched_at),
            Some(42),
            "fetchedAt comes off the row"
        );
        assert_eq!(
            stored.data.map(|d| d.player.title).as_deref(),
            Some("Mayhem Veteran")
        );

        rig.env
            .exec("UPDATE challenge_state SET payload = 'not json'");
        assert_eq!(rig.challenges.get_challenges().unwrap().data, None);
        rig.env.db.close();
        let closed = rig.challenges.get_challenges().unwrap_err();
        assert_eq!(
            (closed.name.as_str(), closed.message.as_str()),
            ("TypeError", "The database connection is not open")
        );
    }

    /// T21's hostile scenario: `completedIds.map(Number)` sends the page NaN
    /// and a fraction as they are, JSON.stringify stores the NaN as `null`, and
    /// `readStored` hands the stored ids back as JSON.parse read them.
    #[tokio::test]
    async fn champion_ids_are_javascript_numbers_fresh_and_stored() {
        let rig = rig("hostile-ids");
        let mut hostile = tree();
        hostile["202005"]["completedIds"] = json!(["x", 1.5, 22]);
        rig.client
            .route(CHALLENGES_PATH, vec![Reply::Json(hostile)]);
        rig.client.route(SUMMARY_PATH, vec![Reply::Json(summary())]);
        let seasonal = |result: Value| result["data"]["seasonal"][0].clone();

        rig.challenges.refresh_and_broadcast().await.expect("data");
        let sent = seasonal(rig.env.events("challenges:changed")[0].clone());
        assert_eq!(
            sent["completedChampionIds"],
            json!([{"$bmtNum": "NaN"}, 1.5, 22])
        );
        let stored: String = rig.env.query("SELECT payload FROM challenge_state");
        assert!(
            stored.contains(r#""completedChampionIds":[null,1.5,22]"#),
            "{stored}"
        );

        // An Electron-written row, a fractional challenge id included
        rig.env.exec(
            r#"UPDATE challenge_state SET payload = replace(payload, '"id":202005,', '"id":202005.5,')"#,
        );
        rig.client.connected.store(false, Ordering::SeqCst);
        let read =
            seasonal(serde_json::to_value(rig.challenges.get_challenges().unwrap()).unwrap());
        assert_eq!(read["completedChampionIds"], json!([null, 1.5, 22]));
        assert_eq!(read["id"], json!(202005.5));
    }

    fn updated(id: i64) -> Value {
        json!({
            "x": { "id": id, "name": null, "currentLevel": "GOLD", "previousLevel": "SILVER", "nextLevel": "PLATINUM",
                   "previousValue": 1, "currentValue": 5, "nextThreshold": 10, "levelToIconPath": { "GOLD": "/g.png" } },
            "y": { "id": "nope" },
        })
    }

    #[tokio::test(start_paused = true)]
    async fn a_game_is_asked_about_at_zero_five_twenty_and_sixty_seconds() {
        let rig = rig("capture-delays");
        let path = "/lol-challenges/v1/my-updated-challenges/7000000000";
        rig.client.route(path, vec![Reply::Fail]);
        rig.challenges.start_game_capture(7_000_000_000.0).unwrap();
        rig.challenges.start_game_capture(7_000_000_000.0).unwrap();
        tokio::time::sleep(Duration::from_secs(200)).await;
        assert_eq!(rig.client.times(path), vec![0, 5_000, 25_000, 85_000]);
        assert_eq!(rig.challenges.pending_captures(), 0);
        assert_eq!(
            rig.env
                .query::<i64>("SELECT COUNT(*) FROM challenge_game_progress"),
            0
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_capture_stops_once_the_client_answers() {
        let rig = rig("capture-hit");
        let path = "/lol-challenges/v1/my-updated-challenges/77";
        rig.client.route(
            path,
            vec![Reply::Json(json!({})), Reply::Json(updated(101101))],
        );
        rig.challenges.start_game_capture(77.0).unwrap();
        tokio::time::sleep(Duration::from_secs(200)).await;
        assert_eq!(rig.client.times(path), vec![0, 5_000]);
        assert_eq!(
            rig.env.query::<String>("SELECT game_id || '|' || challenge_id || '|' || name || '|' || description || '|' || previous_value || '|' || current_value || '|' || previous_level || '|' || current_level || '|' || next_level || '|' || next_threshold || '|' || icon_path FROM challenge_game_progress"),
            "77|101101|Challenge 101101||1.0|5.0|SILVER|GOLD|PLATINUM|10.0|/g.png"
        );
        // A game already captured costs nothing
        rig.challenges.start_game_capture(77.0).unwrap();
        settle().await;
        assert_eq!(rig.client.times(path).len(), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn leaving_a_match_refreshes_then_captures_the_game_just_played() {
        let rig = rig("on-connected");
        serve(&rig);
        *rig.client.live.lock().unwrap() = Some(LiveGameRef {
            game_id: 88.0,
            queue_id: 2400.0,
        });
        rig.challenges.on_status(LcuStatus::Ingame);
        settle().await;
        assert!(
            rig.client.paths().is_empty(),
            "only connected starts anything"
        );
        rig.challenges.on_status(LcuStatus::Connected);
        settle().await;
        assert_eq!(
            rig.client.paths(),
            vec![
                CHALLENGES_PATH,
                SUMMARY_PATH,
                "/lol-challenges/v1/my-updated-challenges/88"
            ]
        );

        // Started after the game: the gameflow session names it
        let rig = super::tests::rig("on-connected-session");
        serve(&rig);
        rig.client.route(
            SESSION_PATH,
            vec![Reply::Json(json!({ "gameData": { "gameId": 99 } }))],
        );
        rig.challenges.on_status(LcuStatus::Connected);
        settle().await;
        assert_eq!(
            rig.client.paths().last().map(String::as_str),
            Some("/lol-challenges/v1/my-updated-challenges/99")
        );
    }

    #[test]
    fn days_roll_over_the_calendar() {
        assert_eq!(days_before("2026-11-23", 7), "2026-11-16");
        assert_eq!(days_before("2026-03-03", 7), "2026-02-24");
        assert_eq!(days_before("2024-03-03", 7), "2024-02-25");
        assert_eq!(days_before("2027-01-02", 7), "2026-12-26");
        assert_eq!(challenge_fraction(5.0, 0.0, None), 1.0);
        assert_eq!(challenge_fraction(5.0, 10.0, Some(10.0)), 0.0);
        assert_eq!(challenge_fraction(50.0, 0.0, Some(10.0)), 1.0);
        assert_eq!(challenge_fraction(-5.0, 0.0, Some(10.0)), 0.0);
    }
}
