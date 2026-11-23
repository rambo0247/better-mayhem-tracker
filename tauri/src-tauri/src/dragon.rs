//! Champion, augment, item and summoner spell data: `src/main/dragon.ts`.
//! Champions come from Data Dragon and are kept in `data/champion-cache.json`
//! for offline starts. The rest is CommunityDragon game data, read through
//! [`GameAssets`] so it shares the disk copies, the client fallback and the
//! outage backoff with the art.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, LazyLock, Mutex};

use futures_util::FutureExt;
use futures_util::future::{BoxFuture, Shared};
use regex::Regex;
use serde::de::{DeserializeOwned, MapAccess, Visitor};
use serde::ser::SerializeMap;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;
use tokio::sync::Semaphore;

use crate::asset_cache::by_newest_patch;
use crate::assets::{
    Fetched, Flights, GameAssets, Web, WebAnswer, game_asset_url, game_data_path, js_string,
    js_truthy, log, log_error,
};

const VERSIONS: &str = "https://ddragon.leagueoflegends.com/api/versions.json";
const DDRAGON_CDN: &str = "https://ddragon.leagueoflegends.com/cdn";
const ARCHIVED_BRANCHES: &str = "https://raw.communitydragon.org/json/";

// Game data, as paths under /lol-game-data/assets/
const CHERRY_AUGMENTS: &str = "v1/cherry-augments.json";
const ITEMS: &str = "v1/items.json";
const SUMMONER_SPELLS: &str = "v1/summoner-spells.json";

/// How far back to walk before giving up. Retired augments were in the game
/// recently enough to be in someone's match history, so hits come early; the
/// cap stops a permanently-missing icon from pulling down a year of manifests.
const MAX_ICON_BRANCH_LOOKBACK: usize = 12;
/// A stats page renders hundreds of icons at once and CommunityDragon
/// throttles bursts, so several images can fail at the same moment. Resolving
/// those in parallel would aim the same burst at the same host.
const ICON_LOOKUP_CONCURRENCY: usize = 4;

const CHAMPION_CACHE_FILE: &str = "champion-cache.json";
const AUGMENT_ICON_CACHE_FILE: &str = "augment-icon-cache.json";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChampionInfo {
    pub name: String,
    pub key: String,
    /// `champ.tags?.[0]`: whatever the first tag is, a string from Data Dragon.
    /// Absent when there is none, as `undefined` is left out of JSON.
    #[serde(
        skip_serializing_if = "Option::is_none",
        default,
        deserialize_with = "present"
    )]
    pub class: Option<Value>,
}

/// A field that is there, `null` included, as JavaScript reads one back.
fn present<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<Value>, D::Error> {
    Value::deserialize(deserializer).map(Some)
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AugmentInfo {
    pub name: String,
    pub desc: String,
    pub icon_path: String,
    pub rarity: String,
    pub branch: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemInfo {
    pub name: String,
    pub description: String,
    pub icon_path: String,
    pub branch: String,
    pub boots: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SummonerSpellInfo {
    pub name: String,
    pub icon_path: String,
}

/// Keyed by `String(parseInt(champ.key))`, in JavaScript's key order.
pub type ChampionData = JsObject<ChampionInfo>;
/// Keyed by id. JSON writes the keys as strings in ascending order, as
/// JavaScript writes an object's integer keys.
pub type AugmentData = BTreeMap<i64, AugmentInfo>;
pub type ItemData = BTreeMap<i64, ItemInfo>;
pub type SummonerSpellData = BTreeMap<i64, SummonerSpellInfo>;

/// What scoring reads: `getChampionClasses()` and `getChampionDataVersion()`.
#[derive(Debug, Clone, PartialEq)]
pub struct ChampionClasses {
    pub version: String,
    pub classes: HashMap<i64, String>,
}

/// Tooltip text, bundled rather than fetched: cherry-augments.json carries an
/// augment's name, rarity and art but no description, and the game data that
/// does is 44 MB per patch.
static DESCRIPTIONS: LazyLock<HashMap<String, String>> = LazyLock::new(|| {
    #[derive(Deserialize)]
    struct Bundled {
        descriptions: HashMap<String, String>,
    }
    serde_json::from_str::<Bundled>(include_str!("../resources/augment-descriptions.json"))
        .expect("the bundled augment descriptions parse")
        .descriptions
});

struct Champions {
    data: ChampionData,
    /// Data Dragon version the data came from, "none" until any loads. Folded
    /// into the score-backfill key so stored scores recompute when champion
    /// class data changes.
    version: String,
}

/// A JavaScript object as `JSON.parse` builds it and `JSON.stringify` writes
/// it: a key set twice keeps its first place and its last value, and keys come
/// out array indices first, ascending, then the rest in the order first set.
#[derive(Debug, Clone, PartialEq)]
pub struct JsObject<V>(Vec<(String, V)>);

impl<V> Default for JsObject<V> {
    fn default() -> Self {
        Self(Vec::new())
    }
}

impl<V> JsObject<V> {
    pub fn get(&self, key: &str) -> Option<&V> {
        self.0
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, value)| value)
    }

    pub fn set(&mut self, key: String, value: V) {
        match self.0.iter_mut().find(|(k, _)| *k == key) {
            Some(entry) => entry.1 = value,
            None => self.0.push((key, value)),
        }
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// `Object.entries`: the own keys in property order.
    pub fn entries(&self) -> impl Iterator<Item = (&str, &V)> {
        let mut entries: Vec<&(String, V)> = self.0.iter().collect();
        entries.sort_by_key(|(key, _)| array_index(key).map_or((1, 0), |i| (0, i)));
        entries
            .into_iter()
            .map(|(key, value)| (key.as_str(), value))
    }
}

impl<V: Serialize> Serialize for JsObject<V> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(self.len()))?;
        for (key, value) in self.entries() {
            map.serialize_entry(key, value)?;
        }
        map.end()
    }
}

impl<'de, V: Deserialize<'de>> Deserialize<'de> for JsObject<V> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Entries<V>(std::marker::PhantomData<V>);
        impl<'de, V: Deserialize<'de>> Visitor<'de> for Entries<V> {
            type Value = JsObject<V>;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("an object")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                let mut object = JsObject::default();
                while let Some((key, value)) = map.next_entry::<String, V>()? {
                    object.set(key, value);
                }
                Ok(object)
            }
        }
        deserializer.deserialize_map(Entries(std::marker::PhantomData))
    }
}

/// An augment icon resolution kept on disk: an asset URL, or `None` for "no
/// branch the walk reached has it".
type IconCacheFile = JsObject<Option<String>>;

/// The keys JavaScript orders first: canonical integers below 2^32 - 1.
fn array_index(key: &str) -> Option<u64> {
    let index: u64 = key.parse().ok()?;
    (index < u64::from(u32::MAX) && index.to_string() == key).then_some(index)
}

/// Hits from before art was served under the asset: scheme name the same file
/// by its CommunityDragon URL.
fn as_asset_url(url: Option<String>) -> Option<String> {
    // JavaScript's `.` stops at every line terminator, not only `\n`
    static CDRAGON_HIT: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^https://raw\.communitydragon\.org/([^/]+)/game/([^\n\r\x{2028}\x{2029}]+)$")
            .expect("a valid pattern")
    });
    let url = url?;
    match CDRAGON_HIT.captures(&url) {
        Some(found) => Some(game_asset_url(&found[1], &found[2])),
        None => Some(url),
    }
}

/// `Number(text)` for the strings a patch or an id arrives as.
fn js_number_str(text: &str) -> f64 {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return 0.0;
    }
    match trimmed {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    if let Some(hex) = trimmed
        .strip_prefix("0x")
        .or_else(|| trimmed.strip_prefix("0X"))
    {
        return u64::from_str_radix(hex, 16).map_or(f64::NAN, |n| n as f64);
    }
    if trimmed
        .bytes()
        .all(|b| b.is_ascii_digit() || matches!(b, b'+' | b'-' | b'.' | b'e' | b'E'))
    {
        trimmed.parse().unwrap_or(f64::NAN)
    } else {
        f64::NAN
    }
}

/// `Number(value)`.
fn js_number(value: Option<&Value>) -> f64 {
    match value {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => js_number_str(s),
        Some(Value::Array(items)) => match items.as_slice() {
            [] => 0.0,
            [one] => js_number(Some(one)),
            _ => f64::NAN,
        },
        Some(Value::Object(_)) => f64::NAN,
    }
}

/// An object key for a numeric id. Ids are integers; one that isn't has no
/// slot in an integer-keyed map and is dropped.
fn id_key(id: f64) -> Option<i64> {
    (id.is_finite() && id.fract() == 0.0 && id.abs() < 9_007_199_254_740_992.0).then_some(id as i64)
}

/// `parseInt(text)`: leading whitespace, a sign, a `0x` for hex, then digits
/// up to the first that isn't. NaN when there are none.
fn js_parse_int(text: &str) -> f64 {
    let text = text.trim_start();
    let (sign, rest) = match text.as_bytes().first() {
        Some(b'-') => (-1.0, &text[1..]),
        Some(b'+') => (1.0, &text[1..]),
        _ => (1.0, text),
    };
    let (radix, rest) = match rest.get(..2) {
        Some("0x" | "0X") => (16, &rest[2..]),
        _ => (10, rest),
    };
    let digits: Vec<f64> = rest
        .chars()
        .map_while(|c| c.to_digit(radix))
        .map(f64::from)
        .collect();
    if digits.is_empty() {
        return f64::NAN;
    }
    let value = if radix == 10 {
        rest[..digits.len()].parse().unwrap_or(f64::NAN)
    } else {
        digits.iter().fold(0.0, |n, d| n * 16.0 + d)
    };
    sign * value
}

/// `String(n)` for the numbers `parseInt` returns, as an object key.
fn js_number_key(n: f64) -> String {
    if n.is_nan() {
        "NaN".into()
    } else if n.is_infinite() {
        if n > 0.0 { "Infinity" } else { "-Infinity" }.into()
    } else if n == 0.0 {
        "0".into()
    } else if n.abs() >= 1e21 {
        format!("{n:e}").replace('e', "e+").replace("e+-", "e-")
    } else {
        n.to_string()
    }
}

/// `champ.tags?.[0]`.
fn first_tag(tags: Option<&Value>) -> Option<Value> {
    match tags? {
        Value::Array(tags) => tags.first().cloned(),
        Value::Object(tags) => tags.get("0").cloned(),
        // A string indexes to its first UTF-16 unit; a lone surrogate has no
        // Rust string, so astral text is left out where JavaScript keeps half
        Value::String(text) => text
            .encode_utf16()
            .next()
            .and_then(|unit| char::from_u32(u32::from(unit)))
            .map(|c| Value::String(c.into())),
        _ => None,
    }
}

/// `a || b || ...` over JSON values, for the fields Riot names more than one
/// way. Only strings are kept, which is what every one of them holds.
fn first_text<'a>(values: impl IntoIterator<Item = Option<&'a Value>>) -> Option<String> {
    values
        .into_iter()
        .find(|value| js_truthy(*value))
        .flatten()
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// The entries of data served as an array, or as an object keyed by id.
fn entries(data: &Value) -> Vec<&Value> {
    match data {
        Value::Array(items) => items.iter().collect(),
        Value::Object(map) => map.values().collect(),
        _ => Vec::new(),
    }
}

fn parse_augments(data: &Value, branch: &str) -> AugmentData {
    let mut augments = AugmentData::new();
    for aug in entries(data) {
        let id = js_number(aug.get("id"));
        if !id.is_finite() {
            continue;
        }
        let Some(key) = id_key(id) else { continue };
        augments.insert(
            key,
            AugmentInfo {
                name: first_text([aug.get("name"), aug.get("nameTRA")])
                    .unwrap_or_else(|| format!("Augment {key}")),
                desc: DESCRIPTIONS
                    .get(&key.to_string())
                    .cloned()
                    .unwrap_or_default(),
                icon_path: first_text([
                    aug.get("augmentSmallIconPath"),
                    aug.get("iconSmall"),
                    aug.get("iconLarge"),
                ])
                .unwrap_or_default(),
                rarity: first_text([aug.get("rarity")]).unwrap_or_default(),
                branch: branch.to_string(),
            },
        );
    }
    augments
}

/// The UI prefers the large art; the data names the small path, and a few
/// augments only ever shipped the one the data names.
fn icon_variants(icon_path: &str) -> Vec<String> {
    let large = icon_path.replacen("small", "large", 1);
    if large == icon_path {
        vec![large]
    } else {
        vec![large, icon_path.to_string()]
    }
}

/// `conclusive` is false when a variant failed for a reason other than
/// absence, so the caller can tell "this branch doesn't have it" from "we
/// couldn't look". Keeping the two apart is what stops a throttled request
/// passing for a retired augment.
struct BranchIcon {
    url: Option<String>,
    conclusive: bool,
}

type Loaded<T> = Result<Arc<T>, String>;

/// One kind of patch-keyed data: what has loaded, and the loads under way.
struct PatchData<T> {
    done: Mutex<HashMap<String, Arc<T>>>,
    loads: Arc<Flights<Loaded<T>>>,
}

impl<T: Send + Sync + 'static> PatchData<T> {
    fn new() -> Self {
        Self {
            done: Mutex::new(HashMap::new()),
            loads: Flights::new(),
        }
    }

    fn get(&self, key: &str) -> Option<Arc<T>> {
        self.done.lock().expect("data lock").get(key).cloned()
    }

    fn keep(&self, key: &str, value: Arc<T>) {
        self.done
            .lock()
            .expect("data lock")
            .insert(key.to_string(), value);
    }
}

struct Inner {
    web: Arc<dyn Web>,
    assets: GameAssets,
    data_dir: PathBuf,
    champions: Mutex<Champions>,
    champion_ready: Mutex<Option<Shared<BoxFuture<'static, ()>>>>,
    augments: PatchData<AugmentData>,
    items: PatchData<ItemData>,
    spells: PatchData<SummonerSpellData>,
    spell_keys: PatchData<HashMap<String, i64>>,
    latest_live_patch: Mutex<Option<String>>,
    icon_cache: Mutex<Option<IconCacheFile>>,
    icon_lookups: Arc<Flights<Result<Option<String>, String>>>,
    icon_slots: Semaphore,
    branch_icons: Mutex<HashMap<String, Arc<HashMap<i64, String>>>>,
    /// Branches whose manifest couldn't be read. The empty result is still
    /// memoized so the walk doesn't retry them for every augment, but a branch
    /// that failed to read is not evidence that the art isn't on it.
    branch_failures: Mutex<HashSet<String>>,
    archived_branches: Mutex<Option<Arc<Vec<String>>>>,
}

#[derive(Clone)]
pub struct Dragon(Arc<Inner>);

impl Dragon {
    /// `data_dir` is the app's `data/`, which holds `champion-cache.json` and
    /// `augment-icon-cache.json`.
    pub fn new(web: Arc<dyn Web>, assets: GameAssets, data_dir: PathBuf) -> Self {
        Self(Arc::new(Inner {
            web,
            assets,
            data_dir,
            champions: Mutex::new(Champions {
                data: ChampionData::default(),
                version: "none".into(),
            }),
            champion_ready: Mutex::new(None),
            augments: PatchData::new(),
            items: PatchData::new(),
            spells: PatchData::new(),
            spell_keys: PatchData::new(),
            latest_live_patch: Mutex::new(None),
            icon_cache: Mutex::new(None),
            icon_lookups: Flights::new(),
            icon_slots: Semaphore::new(ICON_LOOKUP_CONCURRENCY),
            branch_icons: Mutex::new(HashMap::new()),
            branch_failures: Mutex::new(HashSet::new()),
            archived_branches: Mutex::new(None),
        }))
    }

    /// What startup runs in the background: champions, then the live augments.
    /// Champions start loading here unless [`Dragon::load_champion_data`]
    /// already started them.
    pub fn start(&self) {
        let ready = self.0.champion_ready.lock().expect("ready lock").clone();
        let dragon = self.clone();
        tokio::spawn(async move {
            let ready = match ready {
                Some(ready) => ready,
                // Reads the disk copy, so not on an async worker
                None => {
                    match tokio::task::spawn_blocking(move || dragon.load_champion_data()).await {
                        Ok(ready) => ready,
                        Err(_) => return,
                    }
                }
            };
            ready.await;
        });
        let dragon = self.clone();
        tokio::spawn(async move {
            if let Err(err) = dragon.augments(None).await {
                log_error(format!("Failed to load augment data: {err}"));
            }
        });
    }

    async fn fetch_json<T: DeserializeOwned>(&self, url: &str) -> Result<T, String> {
        match self.0.web.get(url).await {
            WebAnswer::Status(status, body) if (200..300).contains(&status) => {
                serde_json::from_slice(&body).map_err(|err| err.to_string())
            }
            WebAnswer::Status(status, _) => Err(format!("Request failed: {status} {url}")),
            WebAnswer::Failed(reason) => Err(reason),
        }
    }

    // -----------------------------------------------------------------------
    // Champions

    fn champion_cache_file(&self) -> PathBuf {
        self.0.data_dir.join(CHAMPION_CACHE_FILE)
    }

    /// Last successfully fetched champion data, so offline startups still have
    /// names and classes, and scoring stays consistent with the previous run.
    /// An entry that isn't a champion's shape is dropped.
    fn hydrate_champions_from_disk(&self) {
        #[derive(Deserialize)]
        struct Cached {
            champions: Option<JsObject<Value>>,
            version: Option<Value>,
        }
        let Ok(text) = std::fs::read_to_string(self.champion_cache_file()) else {
            return;
        };
        let Ok(Cached {
            champions: Some(listed),
            version,
        }) = serde_json::from_str::<Cached>(&text)
        else {
            return;
        };
        let Some(version) = version.filter(|v| js_truthy(Some(v))) else {
            return;
        };
        let mut data = ChampionData::default();
        for (id, champion) in listed.0 {
            if let Ok(info) = serde_json::from_value::<ChampionInfo>(champion) {
                data.set(id, info);
            }
        }
        let mut champions = self.0.champions.lock().expect("champions lock");
        champions.data = data;
        champions.version = js_string(&version);
    }

    async fn fetch_champions(&self) -> Result<(), String> {
        #[derive(Deserialize)]
        struct Listed {
            data: Option<JsObject<Value>>,
        }
        let versions: Value = self.fetch_json(VERSIONS).await?;
        let version = versions.get(0).map_or("undefined".into(), js_string);
        let listed: Listed = self
            .fetch_json(&format!("{DDRAGON_CDN}/{version}/data/en_US/champion.json"))
            .await?;
        let Some(listed) = listed.data else {
            return Err("TypeError: Cannot convert undefined or null to object".into());
        };
        let mut champions = ChampionData::default();
        for (key, champion) in listed.entries() {
            let id = js_parse_int(&champion.get("key").map_or("undefined".into(), js_string));
            champions.set(
                js_number_key(id),
                ChampionInfo {
                    name: champion.get("name").map(js_string).unwrap_or_default(),
                    key: key.to_string(),
                    class: first_tag(champion.get("tags")),
                },
            );
        }
        let count = champions.len();
        #[derive(Serialize)]
        struct CacheFile<'a> {
            version: &'a str,
            champions: &'a ChampionData,
        }
        let json = serde_json::to_string(&CacheFile {
            version: &version,
            champions: &champions,
        })
        .expect("strings and JSON values serialize");
        {
            let mut current = self.0.champions.lock().expect("champions lock");
            current.data = champions;
            current.version = version.clone();
        }
        let file = self.champion_cache_file();
        let written = tokio::task::spawn_blocking(move || std::fs::write(file, json))
            .await
            .unwrap_or_else(|err| Err(std::io::Error::other(err)));
        if let Err(err) = written {
            log_error(format!("Failed to persist champion cache: {err}"));
        }
        log(format!(
            "Loaded {count} champions from Data Dragon v{version}"
        ));
        Ok(())
    }

    /// `loadChampionData`: the disk copy, then Data Dragon. The disk copy is
    /// read here, on the caller's thread, before anything awaits, as
    /// dragon.ts reads it synchronously, so [`Dragon::champion_classes`] has it
    /// as soon as this returns. The app calls this from setup on the main
    /// thread, not on an async worker. Needs no runtime: the load is
    /// registered at once, so a [`Dragon::wait_for_champion_data`] from then on
    /// waits for it, as `waitForChampionData` does after `loadChampionData()`
    /// in Electron's startup. The Data Dragon half runs when [`Dragon::start`]
    /// spawns it or a waiter polls it, whichever is first.
    pub fn load_champion_data(&self) -> Shared<BoxFuture<'static, ()>> {
        self.hydrate_champions_from_disk();
        let dragon = self.clone();
        let ready = async move {
            if let Err(err) = dragon.fetch_champions().await {
                log_error(format!("Failed to load champion data: {err}"));
            }
        }
        .boxed()
        .shared();
        *self.0.champion_ready.lock().expect("ready lock") = Some(ready.clone());
        ready
    }

    pub async fn wait_for_champion_data(&self) {
        let ready = self.0.champion_ready.lock().expect("ready lock").clone();
        if let Some(ready) = ready {
            ready.await;
        }
    }

    /// `dragon:champions`, after the load settles.
    pub async fn champion_data(&self) -> ChampionData {
        self.wait_for_champion_data().await;
        self.0
            .champions
            .lock()
            .expect("champions lock")
            .data
            .clone()
    }

    /// `getChampionClasses()`: truthy classes by numeric id. A class that
    /// isn't a string reads as `String()` of it; an id that isn't an integer
    /// names no champion and is left out.
    pub fn champion_classes(&self) -> ChampionClasses {
        let champions = self.0.champions.lock().expect("champions lock");
        ChampionClasses {
            version: champions.version.clone(),
            classes: champions
                .data
                .entries()
                .filter(|(_, champion)| js_truthy(champion.class.as_ref()))
                .filter_map(|(id, champion)| {
                    Some((
                        id_key(js_number_str(id))?,
                        js_string(champion.class.as_ref()?),
                    ))
                })
                .collect(),
        }
    }

    // -----------------------------------------------------------------------
    // CommunityDragon game data

    /// Maps a game's major.minor patch to the branch that has its data: live
    /// patches have their own branch, the current patch is "latest", and a
    /// patch newer than live only exists on "pbe".
    async fn resolve_data_branch(&self, patch: Option<&str>) -> String {
        let Some(patch) = patch.filter(|p| !p.is_empty()) else {
            return "latest".into();
        };
        let known = self.0.latest_live_patch.lock().expect("live lock").clone();
        let live = match known {
            Some(live) => Some(live),
            None => match self.fetch_json::<Value>(VERSIONS).await {
                Ok(versions) => {
                    static LIVE: LazyLock<Regex> = LazyLock::new(|| {
                        Regex::new(r"^([0-9]+)\.([0-9]+)").expect("a valid pattern")
                    });
                    let first = versions.get(0).map_or("undefined".into(), js_string);
                    let live = LIVE
                        .captures(&first)
                        .map(|m| format!("{}.{}", &m[1], &m[2]));
                    if live.is_some() {
                        *self.0.latest_live_patch.lock().expect("live lock") = live.clone();
                    }
                    live
                }
                Err(_) => None,
            },
        };
        if let Some(live) = live {
            let (live_major, live_minor) = split_patch(&live);
            let (major, minor) = split_patch(patch);
            if major > live_major || (major == live_major && minor > live_minor) {
                return "pbe".into();
            }
            if major == live_major && minor == live_minor {
                return "latest".into();
            }
        }
        patch.to_string()
    }

    /// `dragon:augments`. Augment names, rarities and icon paths as of a
    /// patch, or of the live game. Riot reworks augments in place, so a
    /// historical game reads its own branch. A branch that won't load is
    /// answered with current data once, and not remembered.
    pub async fn augments(&self, patch: Option<&str>) -> Loaded<AugmentData> {
        let key = patch.unwrap_or("latest").to_string();
        if let Some(done) = self.0.augments.get(&key) {
            return Ok(done);
        }
        let dragon = self.clone();
        let patch = patch.map(str::to_string);
        let flight_key = key.clone();
        self.0
            .augments
            .loads
            .join(&flight_key, move || async move {
                let branch = dragon.resolve_data_branch(patch.as_deref()).await;
                let assets = &dragon.0.assets;
                let (resolved, data) = match assets.load_game_data(&branch, CHERRY_AUGMENTS).await {
                    Ok(data) => (branch.clone(), data),
                    Err(err) if branch == "latest" => return Err(err),
                    Err(_) => (
                        "latest".to_string(),
                        assets.load_game_data("latest", CHERRY_AUGMENTS).await?,
                    ),
                };
                let augments = Arc::new(parse_augments(&data, &resolved));
                if resolved == branch {
                    dragon.0.augments.keep(&key, augments.clone());
                }
                log(format!("Loaded {} augments ({resolved})", augments.len()));
                Ok(augments)
            })
            .await
    }

    /// `dragon:items`. A branch that won't load is answered with current data,
    /// remembered under the patch and labelled with the patch's branch, as
    /// Electron does.
    pub async fn items(&self, patch: Option<&str>) -> Loaded<ItemData> {
        let key = patch.unwrap_or("latest").to_string();
        if let Some(done) = self.0.items.get(&key) {
            return Ok(done);
        }
        let dragon = self.clone();
        let patch = patch.map(str::to_string);
        let flight_key = key.clone();
        self.0
            .items
            .loads
            .join(&flight_key, move || async move {
                let branch = dragon.resolve_data_branch(patch.as_deref()).await;
                let assets = &dragon.0.assets;
                let data = match assets.load_game_data(&branch, ITEMS).await {
                    Ok(data) => data,
                    Err(err) if branch == "latest" => return Err(err),
                    Err(_) => assets.load_game_data("latest", ITEMS).await?,
                };
                let mut items = ItemData::new();
                for item in data.as_array().into_iter().flatten() {
                    let Some(id) = id_key(js_number(item.get("id"))) else {
                        continue;
                    };
                    let boots = item
                        .get("categories")
                        .and_then(Value::as_array)
                        .is_some_and(|c| c.iter().any(|c| c == "Boots"));
                    items.insert(
                        id,
                        ItemInfo {
                            name: first_text([item.get("name")]).unwrap_or_default(),
                            // Riot ships this already resolved, unlike the
                            // augment tooltips
                            description: first_text([item.get("description")]).unwrap_or_default(),
                            icon_path: first_text([item.get("iconPath")]).unwrap_or_default(),
                            branch: branch.clone(),
                            boots,
                        },
                    );
                }
                let items = Arc::new(items);
                dragon.0.items.keep(&key, items.clone());
                log(format!("Loaded {} items ({branch})", items.len()));
                Ok(items)
            })
            .await
    }

    /// `dragon:summoner-spells`. Spell art doesn't change patch to patch, so
    /// one "latest" fetch serves every game.
    pub async fn summoner_spells(&self) -> Loaded<SummonerSpellData> {
        if let Some(done) = self.0.spells.get("latest") {
            return Ok(done);
        }
        let dragon = self.clone();
        self.0
            .spells
            .loads
            .join("latest", move || async move {
                let data = dragon
                    .0
                    .assets
                    .load_game_data("latest", SUMMONER_SPELLS)
                    .await?;
                let mut spells = SummonerSpellData::new();
                for spell in data.as_array().into_iter().flatten() {
                    let Some(id) = id_key(js_number(spell.get("id"))) else {
                        continue;
                    };
                    spells.insert(
                        id,
                        SummonerSpellInfo {
                            name: first_text([spell.get("name")]).unwrap_or_default(),
                            icon_path: first_text([spell.get("iconPath")]).unwrap_or_default(),
                        },
                    );
                }
                let spells = Arc::new(spells);
                dragon.0.spells.keep("latest", spells.clone());
                log(format!("Loaded {} summoner spells", spells.len()));
                Ok(spells)
            })
            .await
    }

    /// Spell ids by the internal name the in-game API reports a spell under,
    /// lowercased ("summonerflash" is 4). Only Data Dragon carries those names.
    #[allow(dead_code)]
    pub async fn summoner_spell_keys(&self) -> Loaded<HashMap<String, i64>> {
        if let Some(done) = self.0.spell_keys.get("") {
            return Ok(done);
        }
        let dragon = self.clone();
        self.0
            .spell_keys
            .loads
            .join("", move || async move {
                let versions: Value = dragon.fetch_json(VERSIONS).await?;
                let version = versions.get(0).map_or("undefined".into(), js_string);
                let data: Value = dragon
                    .fetch_json(&format!("{DDRAGON_CDN}/{version}/data/en_US/summoner.json"))
                    .await?;
                let mut keys = HashMap::new();
                let listed = data.get("data").map(entries).unwrap_or_default();
                for spell in listed {
                    let id = js_number(spell.get("key"));
                    if js_truthy(spell.get("id"))
                        && id != 0.0
                        && !id.is_nan()
                        && let Some(id) = id_key(id)
                    {
                        keys.insert(js_string(&spell["id"]).to_lowercase(), id);
                    }
                }
                let keys = Arc::new(keys);
                dragon.0.spell_keys.keep("", keys.clone());
                Ok(keys)
            })
            .await
    }

    // -----------------------------------------------------------------------
    // Retired augment icons
    //
    // cherry-augments.json on "latest" still names augments Riot has cut, but
    // their art is gone from the latest export, so the icon 404s while the
    // tooltip still works. The art survives on archived patch branches, and an
    // augment's iconPath can differ between branches, so resolving one means
    // reading that branch's own cherry-augments.json.

    fn icon_cache_file(&self) -> PathBuf {
        self.0.data_dir.join(AUGMENT_ICON_CACHE_FILE)
    }

    /// Runs `f` on the cache, read from its file on first use. On a blocking
    /// thread, since both the read and the writes that follow are file work.
    async fn with_icon_cache<T: Send + 'static>(
        &self,
        f: impl FnOnce(&Dragon, &mut IconCacheFile) -> T + Send + 'static,
    ) -> T {
        let dragon = self.clone();
        tokio::task::spawn_blocking(move || dragon.with_icon_cache_now(f))
            .await
            .expect("the icon cache task ran")
    }

    fn with_icon_cache_now<T>(&self, f: impl FnOnce(&Dragon, &mut IconCacheFile) -> T) -> T {
        let mut cache = self.0.icon_cache.lock().expect("icon cache lock");
        let cache = cache.get_or_insert_with(|| {
            let parsed = std::fs::read_to_string(self.icon_cache_file())
                .ok()
                .and_then(|text| serde_json::from_str::<IconCacheFile>(&text).ok())
                .unwrap_or_default();
            // Misses written before they carried a patch claimed to be the
            // last word on an augment for every patch
            JsObject(
                parsed
                    .0
                    .into_iter()
                    .filter(|(key, url)| url.is_some() || key.contains('|'))
                    .map(|(key, url)| (key, as_asset_url(url)))
                    .collect(),
            )
        });
        f(self, cache)
    }

    /// Written while the cache is held, so the file always ends as the last
    /// change left it, as Electron's synchronous writes do.
    async fn write_icon_cache(&self, key: String, url: Option<String>) {
        self.with_icon_cache(move |dragon, cache| {
            cache.set(key, url);
            let json = serde_json::to_string(cache).expect("URLs serialize");
            if let Err(err) = std::fs::write(dragon.icon_cache_file(), json) {
                log_error(format!("Failed to persist augment icon cache: {err}"));
            }
        })
        .await;
    }

    /// Patch branches newest first. Only numeric ones: "latest" and "pbe" are
    /// covered by the live data, and the rest are per-locale mirrors.
    async fn archived_branches(&self) -> Result<Arc<Vec<String>>, String> {
        let known = self
            .0
            .archived_branches
            .lock()
            .expect("branches lock")
            .clone();
        if let Some(known) = known {
            return Ok(known);
        }
        static PATCH: LazyLock<Regex> =
            LazyLock::new(|| Regex::new(r"^[0-9]+\.[0-9]+$").expect("a valid pattern"));
        let listing = self.0.assets.fetch_cdragon_json(ARCHIVED_BRANCHES).await?;
        let mut branches: Vec<String> = listing
            .as_array()
            .into_iter()
            .flatten()
            .map(|entry| match entry.get("name") {
                None | Some(Value::Null) => String::new(),
                Some(name) => js_string(name),
            })
            .filter(|name| PATCH.is_match(name))
            .collect();
        branches.sort_by(|a, b| by_newest_patch(a, b));
        let branches = Arc::new(branches);
        *self.0.archived_branches.lock().expect("branches lock") = Some(branches.clone());
        Ok(branches)
    }

    async fn branch_augment_icons(&self, branch: &str) -> Arc<HashMap<i64, String>> {
        let known = self
            .0
            .branch_icons
            .lock()
            .expect("branch icons lock")
            .get(branch)
            .cloned();
        if let Some(known) = known {
            return known;
        }
        let mut icons = HashMap::new();
        match self.0.assets.load_game_data(branch, CHERRY_AUGMENTS).await {
            Ok(data) => {
                for aug in entries(&data) {
                    let icon = first_text([
                        aug.get("augmentSmallIconPath"),
                        aug.get("iconSmall"),
                        aug.get("iconLarge"),
                    ]);
                    let has_id = !matches!(aug.get("id"), None | Some(Value::Null));
                    if let (true, Some(icon), Some(id)) =
                        (has_id, icon, id_key(js_number(aug.get("id"))))
                    {
                        icons.insert(id, icon);
                    }
                }
            }
            Err(_) => {
                self.0
                    .branch_failures
                    .lock()
                    .expect("failures lock")
                    .insert(branch.to_string());
            }
        }
        let icons = Arc::new(icons);
        self.0
            .branch_icons
            .lock()
            .expect("branch icons lock")
            .insert(branch.to_string(), icons.clone());
        icons
    }

    /// Fetches the art rather than only asking whether it's there, so the
    /// renderer's request for the URL this hands back usually finds it on disk.
    async fn find_icon_on_branch(&self, branch: &str, icon_path: &str) -> BranchIcon {
        let mut conclusive = true;
        for variant in icon_variants(icon_path) {
            match self
                .0
                .assets
                .load_game_image(branch, &game_data_path(&variant))
                .await
            {
                Fetched::Ok(_) => {
                    return BranchIcon {
                        url: Some(game_asset_url(branch, &variant)),
                        conclusive: true,
                    };
                }
                Fetched::Error => conclusive = false,
                Fetched::Missing => {}
            }
        }
        BranchIcon {
            url: None,
            conclusive,
        }
    }

    /// `dragon:augment-icon`: the asset URL for an augment whose icon failed to
    /// load from the latest export, or `None` if no recent patch branch has
    /// it. A retired augment's branch, and a miss the whole walk agreed on,
    /// are kept in `augment-icon-cache.json`. Nothing is kept unless the walk
    /// established that the live export lacks the art: under a burst
    /// CommunityDragon throttles rather than 404s.
    pub async fn resolve_augment_icon(
        &self,
        id: i64,
        patch: Option<&str>,
    ) -> Result<Option<String>, String> {
        let hit_key = id.to_string();
        let miss_key = format!("{id}|{}", patch.unwrap_or("latest"));
        let cached = {
            let (hit_key, miss_key) = (hit_key.clone(), miss_key.clone());
            self.with_icon_cache(move |_, cache| {
                cache
                    .get(&hit_key)
                    .or_else(|| cache.get(&miss_key))
                    .cloned()
            })
            .await
        };
        if let Some(url) = cached {
            return Ok(url);
        }
        let dragon = self.clone();
        let patch = patch.map(str::to_string);
        let key = miss_key.clone();
        self.0
            .icon_lookups
            .join(&miss_key, move || async move {
                let _slot = dragon
                    .0
                    .icon_slots
                    .acquire()
                    .await
                    .map_err(|err| err.to_string())?;
                dragon
                    .walk_for_icon(id, patch.as_deref(), hit_key, key)
                    .await
            })
            .await
    }

    async fn walk_for_icon(
        &self,
        id: i64,
        patch: Option<&str>,
        hit_key: String,
        miss_key: String,
    ) -> Result<Option<String>, String> {
        let live = self.0.augments.get("latest");
        let live_path = live
            .as_ref()
            .and_then(|live| live.get(&id))
            .map(|augment| augment.icon_path.clone())
            .filter(|path| !path.is_empty());
        // An empty augment cache means the latest export never loaded, not
        // that the augment is absent from it
        let mut live_is_gone = live.is_some_and(|live| !live.is_empty());
        if let Some(live_path) = live_path {
            let on_latest = self.find_icon_on_branch("latest", &live_path).await;
            if on_latest.url.is_some() {
                return Ok(on_latest.url);
            }
            live_is_gone = on_latest.conclusive;
        }
        let branches = self.archived_branches().await?;
        // The game's own patch is the branch most likely to have the art, so
        // try it first; otherwise walk back from the newest archived patch
        let mut ordered: Vec<&str> = Vec::new();
        if let Some(patch) = patch.filter(|p| !p.is_empty() && branches.iter().any(|b| b == p)) {
            ordered.push(patch);
        }
        for branch in branches.iter().take(MAX_ICON_BRANCH_LOOKBACK) {
            if !ordered.contains(&branch.as_str()) {
                ordered.push(branch);
            }
        }
        let mut walk_complete = true;
        for branch in ordered {
            let icons = self.branch_augment_icons(branch).await;
            if self
                .0
                .branch_failures
                .lock()
                .expect("failures lock")
                .contains(branch)
            {
                walk_complete = false;
            }
            let Some(icon_path) = icons.get(&id) else {
                continue;
            };
            let found = self.find_icon_on_branch(branch, icon_path).await;
            if let Some(url) = found.url {
                log(format!("Resolved augment {id} icon from branch {branch}"));
                if live_is_gone {
                    self.write_icon_cache(hit_key, Some(url.clone())).await;
                }
                return Ok(Some(url));
            }
            if !found.conclusive {
                walk_complete = false;
            }
        }
        // Only remember "no art anywhere" if every branch actually said so.
        // The walk stops at the lookback cap, so it speaks for the patch it
        // started from and no other.
        if live_is_gone && walk_complete {
            self.write_icon_cache(miss_key, None).await;
        }
        Ok(None)
    }
}

/// `patch.split(".").map(Number)`, where a missing minor compares as nothing.
fn split_patch(patch: &str) -> (f64, f64) {
    let mut parts = patch.split('.').map(js_number_str);
    (
        parts.next().unwrap_or(f64::NAN),
        parts.next().unwrap_or(f64::NAN),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::assets::tests::{FakeWeb, METADATA, Rig, game_url, png};
    use serde_json::json;
    use std::sync::atomic::Ordering;

    fn dragon(rig: &Rig) -> Dragon {
        let data = rig.root.join("data");
        std::fs::create_dir_all(&data).unwrap();
        Dragon::new(rig.web.clone(), rig.assets.clone(), data)
    }

    fn serve_champions(web: &FakeWeb, version: &str) {
        web.serve_json(VERSIONS, &json!([version, "16.22.1"]));
        web.serve_json(
            &format!("{DDRAGON_CDN}/{version}/data/en_US/champion.json"),
            &json!({ "data": {
                "Annie": { "key": "1", "name": "Annie", "tags": ["Mage", "Support"] },
                "MonkeyKing": { "key": "62", "name": "Wukong", "tags": ["Fighter"] },
                "Zed": { "key": "238", "name": "Zed", "tags": [] },
                "Olaf": { "key": "2", "name": "Olaf", "tags": ["Fighter", "Tank"] },
            }}),
        );
    }

    #[tokio::test]
    async fn champions_load_and_persist_in_electrons_format() {
        let rig = Rig::new("champions");
        serve_champions(&rig.web, "16.23.1");
        let dragon = dragon(&rig);
        dragon.load_champion_data().await;
        let data = dragon.champion_data().await;
        assert_eq!(data.len(), 4);
        assert_eq!(data.get("62").unwrap().name, "Wukong");
        assert_eq!(data.get("62").unwrap().key, "MonkeyKing");
        assert_eq!(data.get("238").unwrap().class, None);
        let file = std::fs::read_to_string(rig.root.join("data/champion-cache.json")).unwrap();
        assert_eq!(
            file,
            r#"{"version":"16.23.1","champions":{"1":{"name":"Annie","key":"Annie","class":"Mage"},"2":{"name":"Olaf","key":"Olaf","class":"Fighter"},"62":{"name":"Wukong","key":"MonkeyKing","class":"Fighter"},"238":{"name":"Zed","key":"Zed"}}}"#
        );
        let classes = dragon.champion_classes();
        assert_eq!(classes.version, "16.23.1");
        assert_eq!(classes.classes.len(), 3);
        assert_eq!(classes.classes[&1], "Mage");
        assert!(file.contains(&serde_json::to_string(&data).unwrap()));
    }

    #[tokio::test]
    async fn a_wait_registered_before_start_waits_for_the_load() {
        let rig = Rig::new("champions-order");
        serve_champions(&rig.web, "16.23.1");
        let dragon = dragon(&rig);
        // Startup's order: register the load, then wait, then start
        drop(dragon.load_champion_data());
        let waiter = {
            let dragon = dragon.clone();
            tokio::spawn(async move {
                dragon.wait_for_champion_data().await;
                dragon.champion_classes()
            })
        };
        dragon.start();
        let classes = waiter.await.unwrap();
        assert_eq!(classes.version, "16.23.1");
        assert_eq!(classes.classes.len(), 3);
        assert_eq!(rig.web.asked(VERSIONS), 1);
    }

    #[tokio::test]
    async fn champions_come_from_disk_when_data_dragon_is_down() {
        let rig = Rig::new("champions-offline");
        rig.web.down.store(true, Ordering::SeqCst);
        let dragon = dragon(&rig);
        std::fs::write(
            rig.root.join("data/champion-cache.json"),
            r#"{"version":"16.20.1","champions":{"1":{"name":"Annie","key":"Annie","class":"Mage"}}}"#,
        )
        .unwrap();
        dragon.load_champion_data().await;
        assert_eq!(dragon.champion_data().await.get("1").unwrap().name, "Annie");
        assert_eq!(dragon.champion_classes().version, "16.20.1");
        assert_eq!(rig.web.asked(VERSIONS), 1);
        // Without a disk copy the data is empty and the version "none"
        let rig = Rig::new("champions-none");
        rig.web.down.store(true, Ordering::SeqCst);
        let dragon = super::Dragon::new(rig.web.clone(), rig.assets.clone(), rig.root.join("data"));
        dragon.load_champion_data().await;
        assert!(dragon.champion_data().await.is_empty());
        assert_eq!(dragon.champion_classes().version, "none");
    }

    fn cherry(icon: &str) -> Value {
        json!([
            { "id": 1341, "name": "Hat on a Hat", "rarity": "kSilver",
              "augmentSmallIconPath": icon },
            { "id": "1002", "nameTRA": "Tra name", "iconLarge": "/x_large.png", "rarity": "" },
            { "id": "x", "name": "dropped" },
            { "name": "no id" },
        ])
    }

    #[tokio::test]
    async fn augments_read_the_games_branch_and_fall_back_once() {
        let rig = Rig::new("augments");
        rig.web.serve_json(VERSIONS, &json!(["16.23.1"]));
        rig.web
            .serve_json(METADATA, &json!({ "version": "16.23.1.0" }));
        rig.web.serve_json(
            &game_url("latest", CHERRY_AUGMENTS),
            &cherry("/latest_small.png"),
        );
        rig.web.serve_json(
            &game_url("16.1", CHERRY_AUGMENTS),
            &cherry("/old_small.png"),
        );
        let dragon = dragon(&rig);

        let latest = dragon.augments(None).await.unwrap();
        assert_eq!(latest.len(), 2);
        assert_eq!(latest[&1341].icon_path, "/latest_small.png");
        assert_eq!(latest[&1341].branch, "latest");
        assert_eq!(latest[&1002].name, "Tra name");
        assert_eq!(latest[&1002].icon_path, "/x_large.png");
        assert!(latest[&1002].desc.contains("Item Haste"));
        assert_eq!(
            serde_json::to_value(&latest[&1341]).unwrap(),
            json!({ "name": "Hat on a Hat", "desc": DESCRIPTIONS["1341"], "iconPath": "/latest_small.png",
                    "rarity": "kSilver", "branch": "latest" })
        );
        // The live patch reads "latest", a newer one "pbe", an older its own
        assert_eq!(dragon.resolve_data_branch(Some("16.23")).await, "latest");
        assert_eq!(dragon.resolve_data_branch(Some("16.24")).await, "pbe");
        assert_eq!(dragon.resolve_data_branch(Some("17.1")).await, "pbe");
        assert_eq!(dragon.resolve_data_branch(Some("16.1")).await, "16.1");
        assert_eq!(dragon.resolve_data_branch(Some("")).await, "latest");
        assert_eq!(dragon.resolve_data_branch(Some("junk")).await, "junk");
        assert_eq!(rig.web.asked(VERSIONS), 1);

        let old = dragon.augments(Some("16.1")).await.unwrap();
        assert_eq!(old[&1341].icon_path, "/old_small.png");
        assert_eq!(old[&1341].branch, "16.1");
        // A branch that isn't there answers with "latest" and is not kept, so
        // the next ask loads again (and finds the 404 remembered)
        let missing = dragon.augments(Some("16.2")).await.unwrap();
        assert_eq!(missing[&1341].branch, "latest");
        assert!(dragon.0.augments.get("16.2").is_none());
        assert!(dragon.0.augments.get("16.1").is_some());
        dragon.augments(Some("16.2")).await.unwrap();
        assert_eq!(rig.web.asked(&game_url("16.2", CHERRY_AUGMENTS)), 1);
        dragon.augments(Some("16.1")).await.unwrap();
        assert_eq!(rig.web.asked(&game_url("16.1", CHERRY_AUGMENTS)), 1);
    }

    #[tokio::test]
    async fn items_fall_back_to_latest_under_the_patchs_label() {
        let rig = Rig::new("items");
        rig.web.serve_json(VERSIONS, &json!(["16.23.1"]));
        rig.web.serve_json(
            &game_url("latest", ITEMS),
            &json!([
                { "id": 3006, "name": "Berserker's Greaves", "description": "<p>x</p>",
                  "iconPath": "/i.png", "categories": ["Boots", "AttackSpeed"] },
                { "id": 1001, "name": "Boots" },
            ]),
        );
        let dragon = dragon(&rig);
        let items = dragon.items(Some("16.5")).await.unwrap();
        assert_eq!(items[&3006].branch, "16.5");
        assert!(items[&3006].boots);
        assert!(!items[&1001].boots);
        assert_eq!(items[&1001].icon_path, "");
        dragon.items(Some("16.5")).await.unwrap();
        assert_eq!(rig.web.asked(&game_url("16.5", ITEMS)), 1);
        assert_eq!(
            serde_json::to_value(&*items).unwrap()["3006"],
            json!({ "name": "Berserker's Greaves", "description": "<p>x</p>",
                    "iconPath": "/i.png", "branch": "16.5", "boots": true })
        );
    }

    #[tokio::test]
    async fn a_failed_load_is_retried() {
        let rig = Rig::new("retry");
        rig.web.down.store(true, Ordering::SeqCst);
        let dragon = dragon(&rig);
        assert_eq!(
            dragon.summoner_spells().await.unwrap_err(),
            "No v1/summoner-spells.json on latest (error)"
        );
        rig.web.down.store(false, Ordering::SeqCst);
        tokio::time::pause();
        tokio::time::advance(crate::assets::OUTAGE_BACKOFF).await;
        tokio::time::resume();
        rig.web.serve_json(
            &game_url("latest", SUMMONER_SPELLS),
            &json!([{ "id": 4, "name": "Flash", "iconPath": "/f.png" }]),
        );
        let spells = dragon.summoner_spells().await.unwrap();
        assert_eq!(spells[&4].name, "Flash");
    }

    #[tokio::test]
    async fn spell_keys_come_from_data_dragon() {
        let rig = Rig::new("spell-keys");
        rig.web.serve_json(VERSIONS, &json!(["16.23.1"]));
        rig.web.serve_json(
            &format!("{DDRAGON_CDN}/16.23.1/data/en_US/summoner.json"),
            &json!({ "data": { "SummonerFlash": { "id": "SummonerFlash", "key": "4" },
                               "Bad": { "id": "Bad", "key": "x" } } }),
        );
        let keys = dragon(&rig).summoner_spell_keys().await.unwrap();
        assert_eq!(keys.len(), 1);
        assert_eq!(keys["summonerflash"], 4);
    }

    /// A retired augment: named on "latest" with art that's gone, and art on
    /// an archived branch under a different texture name.
    fn retired(rig: &Rig) {
        rig.web.serve_json(VERSIONS, &json!(["16.23.1"]));
        rig.web
            .serve_json(METADATA, &json!({ "version": "16.23.1.0" }));
        rig.web.serve_json(
            &game_url("latest", CHERRY_AUGMENTS),
            &json!([{ "id": 1341, "name": "Hat on a Hat",
                      "augmentSmallIconPath": "/lol-game-data/assets/ASSETS/UX/Kiwi/Augments/Icons/HatOnAHat_small.png" }]),
        );
        rig.web.serve_json(
            ARCHIVED_BRANCHES,
            &json!([{ "name": "16.1" }, { "name": "latest" }, { "name": "15.24" },
                    { "name": "16.2" }, { "name": "pbe" }, { "name": "16.1-en_gb" }]),
        );
        for branch in ["16.2", "15.24"] {
            rig.web
                .serve_json(&game_url(branch, CHERRY_AUGMENTS), &json!([]));
        }
        rig.web.serve_json(
            &game_url("16.1", CHERRY_AUGMENTS),
            &json!([{ "id": 1341,
                      "augmentSmallIconPath": "/lol-game-data/assets/ASSETS/UX/Kiwi/Augments/Icons/HatOnAHat_small.png" }]),
        );
        rig.web.serve(
            &game_url("16.1", "assets/ux/kiwi/augments/icons/hatonahat_large.png"),
            200,
            &png(41),
        );
    }

    #[tokio::test]
    async fn a_retired_augment_resolves_to_its_archived_branch_and_is_kept() {
        let rig = Rig::new("retired");
        retired(&rig);
        let dragon = dragon(&rig);
        dragon.augments(None).await.unwrap();
        let url = dragon.resolve_augment_icon(1341, None).await.unwrap();
        assert_eq!(
            url.as_deref(),
            Some("asset://game-data/16.1/assets/ux/kiwi/augments/icons/hatonahat_large.png")
        );
        // The same file the fixture's Electron cache holds, in the same words
        let file = std::fs::read_to_string(rig.root.join("data/augment-icon-cache.json")).unwrap();
        assert_eq!(
            file,
            r#"{"1341":"asset://game-data/16.1/assets/ux/kiwi/augments/icons/hatonahat_large.png"}"#
        );
        // The art it fetched is on disk where the renderer's request finds it
        rig.assets.settle().await;
        assert_eq!(
            rig.on_disk("16.1", "assets/ux/kiwi/augments/icons/hatonahat_large.png"),
            Some(png(41))
        );
        // Answered from the file afterwards, in a later session too
        let asked = rig.web.total_asked();
        let later = super::Dragon::new(rig.web.clone(), rig.assets.clone(), rig.root.join("data"));
        assert_eq!(
            later
                .resolve_augment_icon(1341, Some("16.5"))
                .await
                .unwrap(),
            url
        );
        assert_eq!(rig.web.total_asked(), asked);
    }

    #[tokio::test]
    async fn a_miss_is_kept_per_patch_only_when_every_branch_said_so() {
        let rig = Rig::new("icon-miss");
        retired(&rig);
        rig.web
            .serve_json(&game_url("16.1", CHERRY_AUGMENTS), &json!([]));
        let dragon = dragon(&rig);
        dragon.augments(None).await.unwrap();
        assert_eq!(
            dragon
                .resolve_augment_icon(1341, Some("16.2"))
                .await
                .unwrap(),
            None
        );
        let file = std::fs::read_to_string(rig.root.join("data/augment-icon-cache.json")).unwrap();
        assert_eq!(file, r#"{"1341|16.2":null}"#);

        // A branch whose manifest is throttled makes the walk inconclusive
        let rig = Rig::new("icon-inconclusive");
        retired(&rig);
        rig.web
            .serve_json(&game_url("16.1", CHERRY_AUGMENTS), &json!([]));
        rig.web.serve(&game_url("15.24", CHERRY_AUGMENTS), 429, b"");
        let inconclusive = super::tests::dragon(&rig);
        inconclusive.augments(None).await.unwrap();
        assert_eq!(
            inconclusive.resolve_augment_icon(1341, None).await.unwrap(),
            None
        );
        assert!(rig.root.join("data").is_dir());
        assert!(!rig.root.join("data/augment-icon-cache.json").exists());
    }

    #[tokio::test]
    async fn art_still_on_latest_is_served_and_never_pinned() {
        let rig = Rig::new("icon-live");
        retired(&rig);
        rig.web.serve(
            &game_url(
                "latest",
                "assets/ux/kiwi/augments/icons/hatonahat_large.png",
            ),
            200,
            &png(1),
        );
        let dragon = dragon(&rig);
        dragon.augments(None).await.unwrap();
        let url = dragon.resolve_augment_icon(1341, None).await.unwrap();
        assert_eq!(
            url.as_deref(),
            Some("asset://game-data/latest/assets/ux/kiwi/augments/icons/hatonahat_large.png")
        );
        assert!(!rig.root.join("data/augment-icon-cache.json").exists());
    }

    #[tokio::test]
    async fn the_icon_cache_reads_and_writes_as_electron_does() {
        let text = r#"{"1341":"https://raw.communitydragon.org/16.1/game/assets/ux/a_large.png","9":null,"2002|latest":null,"1391|16.2":null,"77":"asset://game-data/16.3/x.png"}"#;
        let parsed: IconCacheFile = serde_json::from_str(text).unwrap();
        assert_eq!(parsed.len(), 5);
        let dir = crate::asset_cache::tests::temp_dir("icon-cache");
        std::fs::write(dir.join(AUGMENT_ICON_CACHE_FILE), text).unwrap();
        let rig = Rig::new("icon-cache-rig");
        let dragon = Dragon::new(rig.web.clone(), rig.assets.clone(), dir.clone());
        dragon.write_icon_cache("5|latest".into(), None).await;
        dragon
            .write_icon_cache("3".into(), Some("asset://game-data/16.4/y.png".into()))
            .await;
        let written = std::fs::read_to_string(dir.join(AUGMENT_ICON_CACHE_FILE)).unwrap();
        // The old CommunityDragon hit reads as an asset URL, the patchless miss
        // is dropped, integer keys go first ascending, the rest keep order
        assert_eq!(
            written,
            r#"{"3":"asset://game-data/16.4/y.png","77":"asset://game-data/16.3/x.png","1341":"asset://game-data/16.1/assets/ux/a_large.png","2002|latest":null,"1391|16.2":null,"5|latest":null}"#
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// dragon.ts:54-56 reads champion-cache.json before its first await, so
    /// getChampionClasses() has the disk copy the moment loadChampionData()
    /// returns.
    #[test]
    fn the_disk_copy_is_there_as_soon_as_the_load_is_registered() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let rig = Rig::new("champions-sync");
        rig.web.down.store(true, Ordering::SeqCst);
        let dragon = dragon(&rig);
        std::fs::write(
            rig.root.join("data/champion-cache.json"),
            r#"{"version":"16.20.1","champions":{"1":{"name":"Annie","key":"Annie","class":"Mage"}}}"#,
        )
        .unwrap();
        let load = dragon.load_champion_data();
        let classes = dragon.champion_classes();
        assert_eq!(classes.version, "16.20.1");
        assert_eq!(classes.classes[&1], "Mage");
        runtime.block_on(load);
        assert_eq!(dragon.champion_classes().version, "16.20.1");
    }

    /// Electron's file for this input, from `cache[parseInt(champ.key)] = {
    /// name, key, class: champ.tags?.[0] }` and `JSON.stringify`, run in Node:
    /// integer keys ascending, then the others in the order first set; the
    /// later of two champions on one id wins; a class is whatever tags[0] is.
    #[tokio::test]
    async fn champions_are_keyed_and_ordered_as_javascript_does() {
        let rig = Rig::new("champions-js");
        rig.web.serve_json(VERSIONS, &json!(["16.23.1"]));
        rig.web.serve(
            &format!("{DDRAGON_CDN}/16.23.1/data/en_US/champion.json"),
            200,
            br#"{"data":{"Zed2":{"key":"-7","name":"Negative","tags":["Tank"]},"Annie":{"key":"1","name":"Annie","tags":["Mage","Support"]},"Bad":{"key":"abc","name":"Bad","tags":["Mage"]},"ZDup":{"key":"9006","name":"First","tags":["Tank"]},"ADup":{"key":"9006","name":"Second","tags":["Mage"]},"NoTags":{"key":"9002","name":"No Tags"},"EmptyTag":{"key":"9003","name":"Empty","tags":[""]},"Spaced":{"key":" 9004","name":"Spaced","tags":["Tank"]},"Padded":{"key":"009005x","name":"Padded","tags":["Tank"]},"NumTag":{"key":"9007","name":"NumTag","tags":[5]},"NullTags":{"key":"9008","name":"NullTags","tags":null},"NullTag":{"key":"9009","name":"NullTag","tags":[null]},"StrTags":{"key":"9010","name":"StrTags","tags":"Mage"},"Big":{"key":"4294967295","name":"Big","tags":["Tank"]},"Idx":{"key":"4294967294","name":"Idx","tags":["Tank"]}}}"#,
        );
        let dragon = dragon(&rig);
        dragon.load_champion_data().await;
        let file = std::fs::read_to_string(rig.root.join("data/champion-cache.json")).unwrap();
        assert_eq!(
            file,
            r#"{"version":"16.23.1","champions":{"1":{"name":"Annie","key":"Annie","class":"Mage"},"9002":{"name":"No Tags","key":"NoTags"},"9003":{"name":"Empty","key":"EmptyTag","class":""},"9004":{"name":"Spaced","key":"Spaced","class":"Tank"},"9005":{"name":"Padded","key":"Padded","class":"Tank"},"9006":{"name":"Second","key":"ADup","class":"Mage"},"9007":{"name":"NumTag","key":"NumTag","class":5},"9008":{"name":"NullTags","key":"NullTags"},"9009":{"name":"NullTag","key":"NullTag","class":null},"9010":{"name":"StrTags","key":"StrTags","class":"M"},"4294967294":{"name":"Idx","key":"Idx","class":"Tank"},"-7":{"name":"Negative","key":"Zed2","class":"Tank"},"NaN":{"name":"Bad","key":"Bad","class":"Mage"},"4294967295":{"name":"Big","key":"Big","class":"Tank"}}}"#
        );
        // getChampionClasses() keeps truthy classes only, by numeric id
        let classes = dragon.champion_classes().classes;
        let mut ids: Vec<i64> = classes.keys().copied().collect();
        ids.sort_unstable();
        assert_eq!(
            ids,
            [
                -7,
                1,
                9004,
                9005,
                9006,
                9007,
                9010,
                4_294_967_294,
                4_294_967_295
            ]
        );
        assert_eq!(classes[&9006], "Mage");
        assert_eq!(classes[&9007], "5");
        // The renderer's copy is the same object
        let served = serde_json::to_string(&dragon.champion_data().await).unwrap();
        assert!(file.contains(&served), "{served}");
        // And a later start reads the file back as it was written
        let later = Dragon::new(rig.web.clone(), rig.assets.clone(), rig.root.join("data"));
        rig.web.down.store(true, Ordering::SeqCst);
        later.load_champion_data().await;
        assert_eq!(
            serde_json::to_string(&later.champion_data().await).unwrap(),
            served
        );
    }

    /// JavaScript's `\d` is ASCII. A version in other digits names no live
    /// patch, so each lookup asks again, and a branch so named is not walked.
    #[tokio::test]
    async fn only_ascii_digits_name_a_patch() {
        let rig = Rig::new("digits");
        rig.web
            .serve_json(VERSIONS, &json!(["\u{0661}\u{0666}.\u{0662}\u{0663}.1"]));
        let dragon = dragon(&rig);
        assert_eq!(dragon.resolve_data_branch(Some("16.23")).await, "16.23");
        assert_eq!(dragon.resolve_data_branch(Some("16.22")).await, "16.22");
        assert_eq!(rig.web.asked(VERSIONS), 2);

        let rig = Rig::new("digits-branches");
        retired(&rig);
        rig.web.serve_json(
            ARCHIVED_BRANCHES,
            &json!([{ "name": "\u{0661}\u{0666}.\u{0661}" }, { "name": "16.1" }]),
        );
        let dragon = super::tests::dragon(&rig);
        dragon.augments(None).await.unwrap();
        assert!(
            dragon
                .resolve_augment_icon(1341, None)
                .await
                .unwrap()
                .is_some()
        );
        let asked = rig.web.asked.lock().unwrap().clone();
        assert!(
            !asked.iter().any(|url| url.contains('\u{0661}')),
            "{asked:?}"
        );
    }

    #[test]
    fn javascript_number_rules() {
        assert_eq!(js_parse_int("266"), 266.0);
        assert_eq!(js_parse_int(" 12abc"), 12.0);
        assert_eq!(js_parse_int("0x1A"), 26.0);
        assert!(js_parse_int("abc").is_nan());
        assert_eq!(js_number_key(js_parse_int("-0")), "0");
        assert_eq!(
            js_number_key(js_parse_int("1000000000000000000000")),
            "1e+21"
        );
        assert_eq!(
            js_number_key(js_parse_int("123456789012345678901")),
            "123456789012345680000"
        );
        // `.` in JavaScript stops at U+2028, so this old hit is left as it is
        let odd = "https://raw.communitydragon.org/16.1/game/a\u{2028}.png".to_string();
        assert_eq!(as_asset_url(Some(odd.clone())), Some(odd));
        assert_eq!(js_number_str(""), 0.0);
        assert_eq!(js_number_str(" 16 "), 16.0);
        assert!(js_number_str("16a").is_nan());
        assert_eq!(js_number(Some(&Value::Null)), 0.0);
        assert!(js_number(None).is_nan());
        assert_eq!(id_key(js_number(Some(&json!("1002")))), Some(1002));
        assert_eq!(id_key(1.5), None);
        assert_eq!(split_patch("16.4"), (16.0, 4.0));
        assert!(split_patch("16").1.is_nan());
        assert_eq!(
            icon_variants("/a_small.png"),
            ["/a_large.png", "/a_small.png"]
        );
        assert_eq!(icon_variants("/a.png"), ["/a.png"]);
        assert_eq!(array_index("4294967294"), Some(4_294_967_294));
        assert_eq!(array_index("4294967295"), None);
        assert_eq!(array_index("01"), None);
    }
}
