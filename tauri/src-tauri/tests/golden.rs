//! Replays every T05 IPC golden (`parity/goldens/FORMAT.md`) against the Rust
//! commands through Tauri's real IPC path, and prints one row per channel:
//! `pass`, `fail`, or `not ported`. A case passes when its outcome, the events
//! it pushed, the files it wrote, and the OS calls it made all match.
//!
//! `tests/ported.txt` is the ratchet: the channels expected to pass. A listed
//! channel that reads anything else fails the run, and so does a channel that
//! passes without being listed.
//!
//! The goldens are recorded locally and never committed. `BMT_GOLDEN_DIR`
//! names them, defaulting to `parity/out/golden`; when it is set the folder
//! must exist. `BMT_GOLDEN_DATA` names the fixture data folder, whose
//! `matches.db` must have the manifest's `dbSha256`, copied fresh for each
//! group of cases. Without goldens only the self-check runs.
//!
//! A porting unit seeds state per case through `commands::Domain`, not by
//! editing this file.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use bmt_lib::Host;
use bmt_lib::commands::{self, Clock, CommandError, CommandSpec, EffectRecorder, GoldenCase};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use tauri::test::{INVOKE_KEY, MockRuntime, mock_builder, mock_context, noop_assets};
use tauri::webview::InvokeRequest;
use tauri::{Builder, Listener, Manager, WebviewWindow, WebviewWindowBuilder};

/// `CLOCK_FIELDS` in `parity/canon.ts`, which the self-check keeps in step.
const CLOCK_FIELDS: &[&str] = &[];
const CLOCK_MARK: &str = "<clock>";
const UNREGISTERED_CHANNEL: &str = "bmt:unregistered-channel";
/// The run folder Electron's seam writes as `$RUN` is the data root.
const RUN: &str = "$RUN";
const CALL_TIMEOUT: Duration = Duration::from_secs(30);
/// JavaScript holds integers exactly only up to here.
const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;
/// What `parity/run-electron.ts` records under when the manifest does not say.
const DEFAULT_TIME_ZONE: &str = "America/New_York";
const DEFAULT_LOCALE: &str = "en-US";
/// SQLite's own files, which a write changes but the seam never lists.
const DATABASE_FILES: &[&str] = &[
    "matches.db",
    "matches.db-wal",
    "matches.db-shm",
    "matches.db-journal",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Verdict {
    Pass,
    NotPorted,
    Fail,
    NoGolden,
}

impl Verdict {
    fn label(self) -> &'static str {
        match self {
            Verdict::Pass => "pass",
            Verdict::NotPorted => "not ported",
            Verdict::Fail => "fail",
            Verdict::NoGolden => "no golden",
        }
    }
}

#[derive(Debug, Clone)]
struct Golden {
    channel: String,
    case: String,
    group: String,
    seq: i64,
    args: Vec<Value>,
    outcome: Value,
    events: Vec<Value>,
    files: Vec<Value>,
    effects: Vec<Value>,
}

impl Golden {
    fn parse(value: Value) -> Result<Self, String> {
        let field = |name: &str| value.get(name).cloned().ok_or(format!("no `{name}`"));
        let text = |name: &str| {
            field(name)?
                .as_str()
                .map(str::to_owned)
                .ok_or(format!("`{name}` is not text"))
        };
        let list = |name: &str| match value.get(name) {
            None => Ok(Vec::new()),
            Some(Value::Array(items)) => Ok(items.clone()),
            Some(_) => Err(format!("`{name}` is not a list")),
        };
        Ok(Self {
            channel: text("channel")?,
            case: text("case")?,
            group: text("group")?,
            seq: field("seq")?.as_i64().ok_or("`seq` is not a number")?,
            args: list("args")?,
            outcome: field("outcome")?,
            events: list("events")?,
            files: list("files")?,
            effects: list("effects")?,
        })
    }
}

/// `canon.ts`: keys sorted at every depth, clock fields masked, and a whole
/// number written as a float (`3.0`) read as the integer JavaScript printed.
fn canonical(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let sorted: BTreeMap<&String, Value> = map
                .iter()
                .map(|(k, v)| {
                    let v = if CLOCK_FIELDS.contains(&k.as_str()) {
                        Value::String(CLOCK_MARK.into())
                    } else {
                        canonical(v)
                    };
                    (k, v)
                })
                .collect();
            Value::Object(sorted.into_iter().map(|(k, v)| (k.clone(), v)).collect())
        }
        Value::Array(items) => Value::Array(items.iter().map(canonical).collect()),
        Value::Number(n) => match n.as_f64() {
            Some(f) if n.is_f64() && f.fract() == 0.0 && f.abs() <= MAX_SAFE_INTEGER as f64 => {
                Value::from(f as i64)
            }
            _ => value.clone(),
        },
        other => other.clone(),
    }
}

/// Numbers compare exactly: integers as integers, fractions by their bits,
/// so two neighbouring doubles differ.
fn same_number(a: &serde_json::Number, b: &serde_json::Number) -> bool {
    if a.is_f64() || b.is_f64() {
        a.is_f64() && b.is_f64() && a.as_f64().map(f64::to_bits) == b.as_f64().map(f64::to_bits)
    } else {
        a.as_i64() == b.as_i64() && a.as_u64() == b.as_u64()
    }
}

fn same_canonical(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len()
                && x.iter()
                    .all(|(k, v)| y.get(k).is_some_and(|w| same_canonical(v, w)))
        }
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(v, w)| same_canonical(v, w))
        }
        (Value::Number(x), Value::Number(y)) => same_number(x, y),
        _ => a == b,
    }
}

fn same(a: &Value, b: &Value) -> bool {
    same_canonical(&canonical(a), &canonical(b))
}

/// Paths to integers JavaScript cannot hold exactly.
fn unsafe_integers(path: &str, value: &Value, out: &mut Vec<String>) {
    match value {
        Value::Object(map) => {
            for (k, v) in map {
                unsafe_integers(&format!("{path}.{k}"), v, out);
            }
        }
        Value::Array(items) => {
            for (i, v) in items.iter().enumerate() {
                unsafe_integers(&format!("{path}[{i}]"), v, out);
            }
        }
        Value::Number(n) => {
            let big = n.as_u64().is_some_and(|u| u > MAX_SAFE_INTEGER)
                || n.as_i64()
                    .is_some_and(|i| i.unsigned_abs() > MAX_SAFE_INTEGER);
            if big {
                out.push(format!("{path}: {n} is beyond 2^53"));
            }
        }
        _ => {}
    }
}

/// What the command answered: its JSON, or what it rejected with.
type Answer = Result<Value, Value>;

fn is_not_ported(rejection: &Value) -> bool {
    rejection.get("code").and_then(Value::as_str) == Some("NOT_PORTED")
}

/// `Error.prototype.toString`: the name alone when the message is empty.
fn error_text(name: &str, message: &str) -> String {
    match (name.is_empty(), message.is_empty()) {
        (true, _) => message.to_owned(),
        (false, true) => name.to_owned(),
        (false, false) => format!("{name}: {message}"),
    }
}

/// The message the page reads, by `src/api.ts`'s `invokeError`: a command's
/// own error keeps its name; Tauri's text for a channel it does not have, or
/// one the ACL refuses, reads as Electron's unregistered handler.
fn renderer_message(channel: &str, rejection: &Value) -> String {
    let field = |key: &str| rejection.get(key).and_then(Value::as_str);
    let text = match (field("name"), field("message"), rejection.as_str()) {
        (Some(name), Some(message), _) => error_text(name, message),
        (_, _, Some(text))
            if text == format!("Command {channel} not found")
                || text == format!("Command {channel} not allowed by ACL")
                || text.starts_with(&format!("{channel} not allowed")) =>
        {
            error_text("Error", &format!("No handler registered for '{channel}'"))
        }
        (_, _, Some(text)) => error_text("Error", text),
        _ => error_text("Error", &rejection.to_string()),
    };
    format!("Error invoking remote method '{channel}': {text}")
}

fn classify(channel: &str, outcome: &Value, answer: &Answer) -> Verdict {
    if let Err(rejection) = answer
        && is_not_ported(rejection)
    {
        return Verdict::NotPorted;
    }
    let kind = outcome.get("kind").and_then(Value::as_str);
    let matched = match (kind, answer) {
        (Some("value"), Ok(value)) => outcome.get("result").is_some_and(|r| same(r, value)),
        // Electron resolves a void handler with undefined, Tauri with null
        (Some("void"), Ok(value)) => value.is_null(),
        (Some("error"), Err(rejection)) => {
            rejection.get("name") == outcome.get("name")
                && rejection.get("message") == outcome.get("message")
                && outcome
                    .get("invokeMessage")
                    .and_then(Value::as_str)
                    .is_none_or(|m| m == renderer_message(channel, rejection))
        }
        _ => false,
    };
    if matched {
        Verdict::Pass
    } else {
        Verdict::Fail
    }
}

type MockApp = tauri::App<MockRuntime>;
type MockWindow = WebviewWindow<MockRuntime>;
/// Builds the app a replay runs against from its host. Golden replay passes
/// `bmt_lib::app_builder`; the self-check passes hand-made handlers.
type BuildApp<'a> = &'a dyn Fn(Host) -> Builder<MockRuntime>;

/// Every event the app pushed, in order, `(name, payload)`.
#[derive(Clone, Default)]
struct EventLog(Arc<Mutex<Vec<(String, Value)>>>);

impl EventLog {
    fn take(&self) -> Vec<(String, Value)> {
        std::mem::take(&mut *self.0.lock().expect("the event log"))
    }
}

struct Replay {
    app: MockApp,
    window: MockWindow,
    events: EventLog,
}

fn build(build_app: BuildApp<'_>, clock: Clock) -> Replay {
    let app = build_app(Host { clock })
        .manage(EffectRecorder::default())
        .build(mock_context(noop_assets()))
        .expect("build the mock app");
    let window = WebviewWindowBuilder::new(&app, bmt_lib::WINDOW_LABEL, Default::default())
        .build()
        .expect("build the mock main window");
    let events = EventLog::default();
    for spec in bmt_lib::events::event_specs() {
        let log = events.clone();
        app.listen_any(spec.name, move |event| {
            let payload = serde_json::from_str(event.payload()).unwrap_or(Value::Null);
            let entry = (spec.name.to_owned(), payload);
            log.0.lock().expect("the event log").push(entry);
        });
    }
    Replay {
        app,
        window,
        events,
    }
}

fn call(window: &MockWindow, channel: &str, body: Map<String, Value>) -> Answer {
    let request = InvokeRequest {
        cmd: channel.into(),
        callback: tauri::ipc::CallbackFn(0),
        error: tauri::ipc::CallbackFn(1),
        url: "tauri://localhost".parse().expect("a valid URL"),
        body: tauri::ipc::InvokeBody::Json(Value::Object(body)),
        headers: Default::default(),
        invoke_key: INVOKE_KEY.to_string(),
    };
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    window.as_ref().clone().on_message(
        request,
        Box::new(move |_webview, _cmd, response, _callback, _error| {
            tx.send(response).ok();
        }),
    );
    match rx.recv_timeout(CALL_TIMEOUT) {
        Ok(tauri::ipc::InvokeResponse::Ok(body)) => {
            Ok(body.deserialize::<Value>().expect("a JSON response"))
        }
        Ok(tauri::ipc::InvokeResponse::Err(tauri::ipc::InvokeError(rejection))) => Err(rejection),
        Err(_) => Err(Value::from(format!(
            "{channel} did not answer within {} s",
            CALL_TIMEOUT.as_secs()
        ))),
    }
}

type Listing = BTreeMap<String, (u64, SystemTime)>;

/// Size and modification time per file under the data root, to find what a
/// call wrote without hashing the database on every case.
fn listing(root: &Path) -> Listing {
    fn walk(root: &Path, dir: &Path, out: &mut Listing) {
        for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
            let path = entry.path();
            let meta = entry.metadata().expect("read file metadata");
            if meta.is_dir() {
                walk(root, &path, out);
            } else {
                let relative = path.strip_prefix(root).expect("under the root");
                let key = relative.to_string_lossy().replace('\\', "/");
                out.insert(key, (meta.len(), meta.modified().expect("a modified time")));
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(root, root, &mut out);
    out
}

fn sha256(path: &Path) -> String {
    let bytes = std::fs::read(path).expect("read a file to hash");
    format!("{:x}", Sha256::digest(bytes))
}

/// The files the golden says were written against those this call wrote,
/// compared as `path size sha256`.
fn file_differences(golden: &Golden, root: &Path, before: &Listing) -> Vec<String> {
    let expected: BTreeSet<String> = golden
        .files
        .iter()
        .map(|f| {
            let path = f.get("path").and_then(Value::as_str).unwrap_or_default();
            let size = f.get("size").map(Value::to_string).unwrap_or_default();
            let sha = f.get("sha256").and_then(Value::as_str).unwrap_or_default();
            format!("{path} {size} {sha}")
        })
        .collect();
    let listed: BTreeSet<&str> = golden
        .files
        .iter()
        .filter_map(|f| f.get("path").and_then(Value::as_str))
        .collect();
    let written: BTreeSet<String> = listing(root)
        .into_iter()
        .filter(|(name, stamp)| before.get(name) != Some(stamp))
        .filter(|(name, _)| {
            listed.contains(format!("{RUN}/{name}").as_str())
                || !DATABASE_FILES.contains(&name.as_str())
        })
        .map(|(name, (size, _))| format!("{RUN}/{name} {size} {}", sha256(&root.join(&name))))
        .collect();
    let mut out: Vec<String> = expected
        .difference(&written)
        .map(|f| format!("Electron wrote {f}, Rust did not"))
        .collect();
    out.extend(
        written
            .difference(&expected)
            .map(|f| format!("Rust wrote {f}, Electron did not")),
    );
    out
}

/// The events Electron pushed during the call against those Rust pushed. The
/// client poller's `lcu:status-changed` fires on a timer and T05 leaves it out,
/// so Rust's counts only when the golden lists one.
fn event_differences(golden: &Golden, pushed: Vec<(String, Value)>) -> Option<String> {
    let expected: Vec<(String, Value)> = golden
        .events
        .iter()
        .map(|e| {
            let name = e.get("event").and_then(Value::as_str).unwrap_or_default();
            let payload = e.get("payload").cloned().unwrap_or(Value::Null);
            (name.to_owned(), payload)
        })
        .collect();
    let keep_status = expected
        .iter()
        .any(|(name, _)| name == "lcu:status-changed");
    let pushed: Vec<(String, Value)> = pushed
        .into_iter()
        .filter(|(name, _)| keep_status || name != "lcu:status-changed")
        .collect();
    let matches = expected.len() == pushed.len()
        && expected
            .iter()
            .zip(&pushed)
            .all(|((a, p), (b, q))| a == b && same(p, q));
    (!matches).then(|| format!("Electron pushed {expected:?}, Rust pushed {pushed:?}"))
}

/// The OS calls the golden recorded against those the bodies recorded, with
/// the data root written as `$RUN`. The seam's `seq` is the list's order.
fn effect_differences(golden: &Golden, recorded: Vec<Value>, root: &Path) -> Option<String> {
    let root = root.to_string_lossy().into_owned();
    let redact = |value: &Value| match value {
        Value::String(s) => Value::String(s.replace(&root, RUN)),
        other => other.clone(),
    };
    let shape = |e: &Value| {
        let args = e
            .get("args")
            .and_then(Value::as_array)
            .map(|args| args.iter().map(redact).collect())
            .unwrap_or_default();
        serde_json::json!({ "api": e.get("api"), "args": Value::Array(args) })
    };
    let expected: Vec<Value> = golden.effects.iter().map(shape).collect();
    let recorded: Vec<Value> = recorded.iter().map(shape).collect();
    let matches =
        expected.len() == recorded.len() && expected.iter().zip(&recorded).all(|(a, b)| same(a, b));
    (!matches).then(|| {
        format!(
            "Electron's effects {}, Rust's {}",
            Value::Array(expected),
            Value::Array(recorded)
        )
    })
}

/// Replays one case: its outcome, and once that passes, its events, files
/// and effects. Returns the verdict and every difference found.
fn replay_case(
    replay: &Replay,
    spec: &CommandSpec,
    golden: &Golden,
    root: &Path,
) -> (Verdict, Vec<String>) {
    commands::before_golden_case(
        replay.app.handle(),
        &GoldenCase {
            channel: &golden.channel,
            case: &golden.case,
            group: &golden.group,
            args: &golden.args,
            root,
        },
    );
    replay.events.take();
    replay.app.state::<EffectRecorder>().take();
    let before = listing(root);
    let answer = call(&replay.window, spec.channel, spec.named_args(&golden.args));
    let pushed = replay.events.take();
    let effects = replay.app.state::<EffectRecorder>().take();
    let verdict = classify(spec.channel, &golden.outcome, &answer);
    let label = format!("{} {}", golden.channel, golden.case);
    let mut problems = Vec::new();
    if let Ok(value) = &answer {
        unsafe_integers(&format!("{label} result"), value, &mut problems);
    }
    match verdict {
        Verdict::Fail => problems.push(format!(
            "{label}: expected {}, got {answer:?}",
            golden.outcome
        )),
        Verdict::Pass => {
            let found = event_differences(golden, pushed)
                .into_iter()
                .chain(file_differences(golden, root, &before))
                .chain(effect_differences(golden, effects, root));
            problems.extend(found.map(|p| format!("{label}: {p}")));
        }
        Verdict::NotPorted | Verdict::NoGolden => {}
    }
    let verdict = if problems.is_empty() || verdict == Verdict::NotPorted {
        verdict
    } else {
        Verdict::Fail
    };
    (verdict, problems)
}

/// The first JSON path where two canonical values differ, or None when equal.
fn first_difference(path: &str, a: &Value, b: &Value) -> Option<String> {
    match (a, b) {
        (Value::Object(x), Value::Object(y)) => {
            for key in x.keys().chain(y.keys()) {
                let here = format!("{path}.{key}");
                match (x.get(key), y.get(key)) {
                    (Some(l), Some(r)) => {
                        if let Some(found) = first_difference(&here, l, r) {
                            return Some(found);
                        }
                    }
                    (Some(_), None) => return Some(format!("{here}: dropped by the Rust type")),
                    (None, Some(_)) => return Some(format!("{here}: added by the Rust type")),
                    (None, None) => {}
                }
            }
            None
        }
        (Value::Array(x), Value::Array(y)) if x.len() == y.len() => x
            .iter()
            .zip(y)
            .enumerate()
            .find_map(|(i, (l, r))| first_difference(&format!("{path}[{i}]"), l, r)),
        (Value::Number(x), Value::Number(y)) if !same_number(x, y) => {
            let class = |n: &serde_json::Number| if n.is_f64() { "fraction" } else { "integer" };
            Some(format!(
                "{path}: Electron sent the {} {x}, the Rust type writes the {} {y}",
                class(x),
                class(y)
            ))
        }
        _ if same_canonical(a, b) => None,
        _ => Some(format!(
            "{path}: Electron sent {a}, the Rust type writes {b}"
        )),
    }
}

/// Reads each value Electron sent, arguments, results and event payloads, as
/// its Rust type and writes it back. Any change is a contract defect: a field
/// renamed, an absent key turned null, a fraction in an integer field.
fn wire_shapes(dir: &Path, goldens: &[Golden], registry: &[CommandSpec]) -> (usize, Vec<String>) {
    let mut checked = 0;
    let mut problems = Vec::new();
    let mut check = |label: String, roundtrip: fn(Value) -> Result<Value, String>, sent: &Value| {
        checked += 1;
        unsafe_integers(&label, sent, &mut problems);
        match roundtrip(sent.clone()) {
            Ok(written) => {
                if let Some(found) = first_difference("", &canonical(sent), &canonical(&written)) {
                    problems.push(format!("{label}{found}"));
                }
            }
            Err(error) => {
                problems.push(format!("{label}: does not read as its Rust type: {error}"))
            }
        }
    };
    for golden in goldens {
        let Some(spec) = registry.iter().find(|c| c.channel == golden.channel) else {
            continue;
        };
        for (arg, value) in spec.args.iter().zip(&golden.args) {
            check(
                format!("{} {} argument {}", golden.channel, golden.case, arg.name),
                arg.ty.roundtrip,
                value,
            );
        }
        if golden.outcome.get("kind").and_then(Value::as_str) == Some("value") {
            let result = golden.outcome.get("result").cloned().unwrap_or(Value::Null);
            check(
                format!("{} {} result", golden.channel, golden.case),
                spec.ret.roundtrip,
                &result,
            );
        }
    }
    let events = bmt_lib::events::event_specs();
    let mut unknown_events = Vec::new();
    for file in std::fs::read_dir(dir.join("events"))
        .into_iter()
        .flatten()
        .flatten()
    {
        let text = std::fs::read_to_string(file.path()).expect("read an event file");
        for line in text.lines().filter(|l| !l.trim().is_empty()) {
            let record: Value = serde_json::from_str(line).expect("an event line is JSON");
            let name = record
                .get("event")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let Some(payload) = record.get("payload") else {
                continue;
            };
            match events.iter().find(|e| e.name == name) {
                Some(spec) => check(format!("event {name}"), spec.payload.roundtrip, payload),
                None => unknown_events.push(format!("event {name}: not in the contract")),
            }
        }
    }
    problems.extend(unknown_events);
    (checked, problems)
}

fn read_goldens(dir: &Path) -> Result<Vec<Golden>, String> {
    let ipc = dir.join("ipc");
    let channels = std::fs::read_dir(&ipc).map_err(|e| format!("{}: {e}", ipc.display()))?;
    let mut out = Vec::new();
    for channel in channels.flatten() {
        for file in std::fs::read_dir(channel.path())
            .into_iter()
            .flatten()
            .flatten()
        {
            let path = file.path();
            if path.extension().is_none_or(|e| e != "json") {
                continue;
            }
            let read = std::fs::read_to_string(&path)
                .map_err(|e| e.to_string())
                .and_then(|text| serde_json::from_str(&text).map_err(|e| e.to_string()))
                .and_then(Golden::parse);
            out.push(read.map_err(|e| format!("{}: {e}", path.display()))?);
        }
    }
    out.sort_by(|a, b| (&a.group, a.seq, &a.channel).cmp(&(&b.group, b.seq, &b.channel)));
    Ok(out)
}

/// `fixedTime` from the manifest, `YYYY-MM-DDTHH:MM:SS[.mmm]Z`, in epoch ms.
/// Only UTC is accepted: an offset would be read as UTC and shift every date.
fn parse_fixed_time(text: &str) -> Option<i64> {
    let body = text.strip_suffix('Z')?;
    if !(body.len() == 19 || (body.len() == 23 && body.get(19..20) == Some("."))) {
        return None;
    }
    let num = |range: std::ops::Range<usize>| body.get(range)?.parse::<i64>().ok();
    let (y, m, d) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (hh, mm, ss) = (num(11..13)?, num(14..16)?, num(17..19)?);
    let ms = if body.len() == 23 { num(20..23)? } else { 0 };
    // Days from the civil date, Howard Hinnant's algorithm
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(((days * 24 + hh) * 60 + mm) * 60_000 + ss * 1000 + ms)
}

struct Manifest {
    clock: Clock,
    time_zone: String,
    locale: String,
    db_sha256: Option<String>,
}

fn read_manifest(dir: &Path) -> Result<Manifest, String> {
    let path = dir.join("manifest.json");
    let at = |e: &dyn std::fmt::Display| format!("{}: {e}", path.display());
    let text = std::fs::read_to_string(&path).map_err(|e| at(&e))?;
    let manifest: Value = serde_json::from_str(&text).map_err(|e| at(&e))?;
    let text_field = |key: &str| manifest.get(key).and_then(Value::as_str).map(str::to_owned);
    let fixed =
        text_field("fixedTime").ok_or_else(|| at(&"no fixedTime to freeze the clock at"))?;
    let ms = parse_fixed_time(&fixed).ok_or_else(|| {
        at(&format!(
            "fixedTime {fixed:?} is not a UTC time ending in Z"
        ))
    })?;
    Ok(Manifest {
        clock: Clock::Fixed(ms),
        time_zone: text_field("timeZone").unwrap_or_else(|| DEFAULT_TIME_ZONE.into()),
        locale: text_field("locale").unwrap_or_else(|| DEFAULT_LOCALE.into()),
        db_sha256: text_field("dbSha256"),
    })
}

/// Electron's main process reads the process zone (SQLite `'localtime'`, JS
/// `Date`), and so does the port, so replay runs in the recording's zone.
fn pin_zone_and_locale(manifest: &Manifest) -> Result<(), String> {
    if cfg!(windows) {
        // SQLite's 'localtime' asks the C runtime, which reads only a POSIX TZ
        // such as EST5EDT, never an IANA name, so the zone cannot be pinned
        return Err("golden replay runs on macOS and Linux only: on Windows SQLite's zone cannot be pinned to the manifest's".into());
    }
    let lang = format!("{}.UTF-8", manifest.locale.replace('-', "_"));
    // SAFETY: called before any thread is started or app is built
    unsafe {
        std::env::set_var("TZ", &manifest.time_zone);
        std::env::set_var("LANG", &lang);
        std::env::set_var("LC_ALL", &lang);
    }
    println!("replaying in {} with {lang}", manifest.time_zone);
    Ok(())
}

/// Refuses a fixture other than the one the goldens were recorded on.
fn check_fixture(manifest: &Manifest, data: Option<&Path>) -> Result<(), String> {
    let Some(expected) = &manifest.db_sha256 else {
        return Ok(());
    };
    let data = data.ok_or(format!(
        "set BMT_GOLDEN_DATA to the fixture folder whose matches.db has sha256 {expected}"
    ))?;
    let db = data.join("matches.db");
    if !db.is_file() {
        return Err(format!("{}: no matches.db", data.display()));
    }
    let actual = sha256(&db);
    if &actual != expected {
        return Err(format!(
            "{} has sha256 {actual}, but the goldens were recorded on {expected}; replay over another fixture fails a correct port",
            db.display()
        ));
    }
    Ok(())
}

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).expect("create the data copy");
    for entry in std::fs::read_dir(from).expect("read the fixture").flatten() {
        let target = to.join(entry.file_name());
        if entry.file_type().expect("a file type").is_dir() {
            copy_dir(&entry.path(), &target);
        } else {
            std::fs::copy(entry.path(), target).expect("copy a fixture file");
        }
    }
}

/// Points the next app built at `root`. Each app reads it when it is built.
fn use_data_root(root: &Path) {
    // SAFETY: only this thread runs code that reads the environment here: the
    // previous app is dropped and the next is not built yet
    unsafe { std::env::set_var("BMT_DATA_ROOT", root) };
}

/// The channels `tests/ported.txt` expects to pass.
fn read_ported(registry: &[CommandSpec]) -> Result<BTreeSet<String>, String> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/ported.txt");
    let text = std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    let ported: BTreeSet<String> = text
        .lines()
        .map(|line| line.split('#').next().unwrap_or_default().trim())
        .filter(|line| !line.is_empty())
        .map(str::to_owned)
        .collect();
    if let Some(unknown) = ported
        .iter()
        .find(|p| !registry.iter().any(|c| c.channel == p.as_str()))
    {
        return Err(format!(
            "tests/ported.txt: {unknown} is not a channel of the contract"
        ));
    }
    Ok(ported)
}

/// One verdict per channel: pass only when every case passes, not ported when
/// any case is, fail otherwise.
fn channel_verdict(cases: &[(String, Verdict)]) -> Verdict {
    if cases.is_empty() {
        Verdict::NoGolden
    } else if cases.iter().any(|(_, v)| *v == Verdict::Fail) {
        Verdict::Fail
    } else if cases.iter().any(|(_, v)| *v == Verdict::NotPorted) {
        Verdict::NotPorted
    } else {
        Verdict::Pass
    }
}

/// The ratchet: a listed channel must pass, and a passing one must be listed.
fn ratchet(verdicts: &BTreeMap<&str, Verdict>, ported: &BTreeSet<String>) -> Vec<String> {
    let mut out: Vec<String> = ported
        .iter()
        .map(|channel| {
            let verdict = verdicts
                .get(channel.as_str())
                .copied()
                .unwrap_or(Verdict::NoGolden);
            (channel, verdict)
        })
        .filter(|(_, verdict)| *verdict != Verdict::Pass)
        .map(|(channel, verdict)| {
            format!(
                "{channel} is in tests/ported.txt but reads {}",
                verdict.label()
            )
        })
        .collect();
    out.extend(
        verdicts
            .iter()
            .filter(|(channel, verdict)| **verdict == Verdict::Pass && !ported.contains(**channel))
            .map(|(channel, _)| format!("{channel} passes; add it to tests/ported.txt")),
    );
    out
}

/// A value of each argument type, to call every channel with.
fn sample(ts: &str) -> Result<Value, String> {
    Ok(match ts {
        "number" => Value::from(1),
        "string" => Value::from("probe"),
        "boolean" => Value::from(false),
        "MatchFilters" | "MatchScope" => serde_json::json!({}),
        "CardSpec" => serde_json::json!({ "kind": "game", "gameId": 1 }),
        other => {
            return Err(format!(
                "no sample argument for `{other}`; add one to golden.rs's sample"
            ));
        }
    })
}

#[tauri::command(rename = "app:version")]
async fn canary() -> Result<String, CommandError> {
    Err(CommandError::not_ported())
}

#[tauri::command(rename = "app:version")]
async fn wrong_version() -> Result<String, CommandError> {
    Ok("0.0.0".into())
}

#[tauri::command(rename = "app:version")]
async fn panicking() -> Result<String, CommandError> {
    commands::guarded(async { panic!("index out of bounds") }).await
}

#[tauri::command(rename = "app:version")]
async fn version_and_event(app: tauri::AppHandle<MockRuntime>) -> Result<String, CommandError> {
    bmt_lib::events::games_updated(&app);
    Ok("1.2.1".into())
}

#[tauri::command(rename = "app:version")]
async fn version_and_file() -> Result<String, CommandError> {
    let root = std::env::var("BMT_DATA_ROOT").map_err(|e| CommandError::thrown(e.to_string()))?;
    std::fs::write(Path::new(&root).join("stray.txt"), "x")
        .map_err(|e| CommandError::thrown(e.to_string()))?;
    Ok("1.2.1".into())
}

fn expect(label: &str, got: Verdict, want: Verdict) -> Result<(), String> {
    if got == want {
        Ok(())
    } else {
        Err(format!(
            "self-check {label}: {} where {} was expected",
            got.label(),
            want.label()
        ))
    }
}

/// The harness against hand-made commands, so it outlives every real stub.
fn check_harness(root: &Path) -> Result<(), String> {
    let version = Golden::parse(serde_json::json!({
        "channel": "app:version", "case": "hand-made", "group": "read", "seq": 0, "args": [],
        "outcome": { "kind": "value", "result": "1.2.1" }
    }))?;
    let registry = commands::registry();
    let spec = registry
        .iter()
        .find(|c| c.channel == "app:version")
        .ok_or("app:version is not registered")?;
    let stub = |host: Host| {
        mock_builder()
            .manage(host.clock)
            .invoke_handler(tauri::generate_handler![canary])
    };
    let wrong = |host: Host| {
        mock_builder()
            .manage(host.clock)
            .invoke_handler(tauri::generate_handler![wrong_version])
    };
    let panics = |host: Host| {
        mock_builder()
            .manage(host.clock)
            .invoke_handler(tauri::generate_handler![panicking])
    };
    let handlers: [(&str, BuildApp<'_>, Verdict); 3] = [
        ("stub canary", &stub, Verdict::NotPorted),
        ("wrong answer", &wrong, Verdict::Fail),
        ("panicking body", &panics, Verdict::Fail),
    ];
    // The panic is expected; keep its report out of the log
    let hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(|_| {}));
    let verdicts: Vec<_> = handlers
        .iter()
        .map(|(_, handler, _)| replay_case(&build(*handler, Clock::System), spec, &version, root).0)
        .collect();
    let replay = build(&panics, Clock::System);
    let rejection = call(&replay.window, "app:version", Map::new());
    std::panic::set_hook(hook);
    for ((label, _, want), got) in handlers.iter().zip(verdicts) {
        expect(label, got, *want)?;
    }
    let rejected = serde_json::json!({ "name": "Error", "message": "index out of bounds" });
    if rejection != Err(rejected) {
        return Err(format!(
            "self-check panicking body: answered {rejection:?}, not a rejection"
        ));
    }
    Ok(())
}

/// A right answer with a wrong event or a stray file is a failure, and the
/// ratchet holds both ways.
fn check_side_effects(root: &Path) -> Result<(), String> {
    let registry = commands::registry();
    let spec = registry
        .iter()
        .find(|c| c.channel == "app:version")
        .ok_or("app:version is not registered")?;
    let golden = |events: Value| {
        Golden::parse(serde_json::json!({
            "channel": "app:version", "case": "hand-made", "group": "read", "seq": 0, "args": [],
            "outcome": { "kind": "value", "result": "1.2.1" }, "events": events
        }))
    };
    let quiet = golden(serde_json::json!([]))?;
    let pushed = golden(serde_json::json!([{ "seq": 0, "event": "lcu:games-updated" }]))?;
    let emits = |host: Host| {
        mock_builder()
            .manage(host.clock)
            .invoke_handler(tauri::generate_handler![version_and_event])
    };
    let writes = |host: Host| {
        mock_builder()
            .manage(host.clock)
            .invoke_handler(tauri::generate_handler![version_and_file])
    };
    let replay = build(&emits, Clock::System);
    expect(
        "an event Electron did not push",
        replay_case(&replay, spec, &quiet, root).0,
        Verdict::Fail,
    )?;
    expect(
        "the event Electron pushed",
        replay_case(&replay, spec, &pushed, root).0,
        Verdict::Pass,
    )?;
    let replay = build(&writes, Clock::System);
    expect(
        "a file Electron did not write",
        replay_case(&replay, spec, &quiet, root).0,
        Verdict::Fail,
    )?;
    std::fs::remove_file(root.join("stray.txt")).ok();

    let verdicts = BTreeMap::from([
        ("app:version", Verdict::Pass),
        ("db:profile", Verdict::NotPorted),
    ]);
    let unlisted = ratchet(&verdicts, &BTreeSet::new());
    let listed = ratchet(
        &verdicts,
        &BTreeSet::from(["db:profile".to_owned(), "app:version".to_owned()]),
    );
    if unlisted != ["app:version passes; add it to tests/ported.txt"]
        || listed != ["db:profile is in tests/ported.txt but reads not ported"]
    {
        return Err(format!("self-check ratchet: {unlisted:?} and {listed:?}"));
    }
    Ok(())
}

/// Every channel is reachable under its name and reads its arguments by their
/// keys: only a body may answer, never Tauri's own refusal, which is a string.
fn check_every_channel(build_app: BuildApp<'_>) -> Result<(), String> {
    let cfg = ts_rs::Config::new().with_large_int("number");
    let replay = build(build_app, Clock::System);
    for command in commands::registry() {
        let mut full = Map::new();
        for arg in &command.args {
            full.insert(arg.key(), sample(&(arg.ty.inner_ts)(&cfg))?);
        }
        let required: Map<String, Value> = command
            .args
            .iter()
            .filter(|a| !a.ty.optional)
            .map(|a| (a.key(), full[&a.key()].clone()))
            .collect();
        for body in [full, required] {
            if let Err(Value::String(refusal)) = call(&replay.window, command.channel, body.clone())
            {
                return Err(format!(
                    "self-check {} with {body:?}: Tauri refused it: {refusal}",
                    command.channel
                ));
            }
        }
    }
    let unknown = call(&replay.window, UNREGISTERED_CHANNEL, Map::new())
        .err()
        .unwrap_or_default();
    let electron = format!(
        "Error invoking remote method '{UNREGISTERED_CHANNEL}': Error: No handler registered for '{UNREGISTERED_CHANNEL}'"
    );
    if renderer_message(UNREGISTERED_CHANNEL, &unknown) != electron {
        return Err(format!(
            "self-check unregistered channel: rejected with {unknown}"
        ));
    }
    Ok(())
}

fn check_comparison() -> Result<(), String> {
    let json = |text: &str| serde_json::from_str::<Value>(text).map_err(|e| e.to_string());
    let value = |result: Value| serde_json::json!({ "kind": "value", "result": result });
    let void = serde_json::json!({ "kind": "void" });
    let cases = [
        (
            "equal value",
            value("1.2.1".into()),
            Ok(Value::from("1.2.1")),
            Verdict::Pass,
        ),
        (
            "3 against 3.0, keys unordered",
            value(json(r#"{ "b": 3, "a": [0.30000000000000004] }"#)?),
            Ok(json(r#"{ "a": [0.30000000000000004], "b": 3.0 }"#)?),
            Verdict::Pass,
        ),
        (
            "0.1 against the next double",
            value(json("0.1")?),
            Ok(json("0.10000000000000002")?),
            Verdict::Fail,
        ),
        (
            "void against null",
            void.clone(),
            Ok(Value::Null),
            Verdict::Pass,
        ),
        (
            "void against a value",
            void,
            Ok(Value::from(1)),
            Verdict::Fail,
        ),
    ];
    for (label, outcome, answer, want) in cases {
        expect(label, classify("app:version", &outcome, &answer), want)?;
    }
    let thrown = |message: &str, invoke: &str| {
        serde_json::json!({ "kind": "error", "name": "Error", "message": message,
            "invokeMessage": format!("Error invoking remote method 'app:version': {invoke}") })
    };
    let rejection = |message: &str| Err(serde_json::json!({ "name": "Error", "message": message }));
    let errors = [
        (
            "same error",
            thrown("boom", "Error: boom"),
            rejection("boom"),
            Verdict::Pass,
        ),
        (
            "other error",
            thrown("bang", "Error: bang"),
            rejection("boom"),
            Verdict::Fail,
        ),
        (
            "empty message, as toString",
            thrown("", "Error"),
            rejection(""),
            Verdict::Pass,
        ),
        (
            "invoke message",
            thrown("boom", "Error: bang"),
            rejection("boom"),
            Verdict::Fail,
        ),
    ];
    for (label, outcome, answer, want) in errors {
        expect(label, classify("app:version", &outcome, &answer), want)?;
    }

    let mut big = Vec::new();
    let ids =
        serde_json::json!({ "id": 9_007_199_254_740_993_u64, "ok": 9_007_199_254_740_991_u64 });
    unsafe_integers("", &ids, &mut big);
    if big != [".id: 9007199254740993 is beyond 2^53"] {
        return Err(format!("self-check 2^53: {big:?}"));
    }
    // Each double reads back as its own bits, as golden.rs needs to tell
    // neighbouring doubles apart
    for i in 0..20_000_u64 {
        let bits =
            0x3f50_0000_0000_0000 + i.wrapping_mul(0x9e37_79b9_7f4a_7c15) % 0x0090_0000_0000_0000;
        let x = f64::from_bits(bits);
        let read: f64 = serde_json::from_str(&format!("{x:?}")).map_err(|e| e.to_string())?;
        if read.to_bits() != bits {
            return Err(format!(
                "self-check float parse: {x:?} read back as {read:?}"
            ));
        }
    }

    let fixed = |text| parse_fixed_time(text);
    if fixed("2026-11-23T02:00:00.000Z") != Some(1_795_399_200_000)
        || fixed("2026-11-23T02:00:00Z") != Some(1_795_399_200_000)
        || fixed("2026-11-22T21:00:00.000-05:00").is_some()
        || fixed("2026-11-23T02:00:00.000").is_some()
    {
        return Err("self-check fixedTime: only a UTC time ending in Z reads".into());
    }
    Ok(())
}

/// `CLOCK_FIELDS` here must equal `parity/canon.ts`'s. Without canon.ts, which
/// T05 adds, no clock field could be masked: that fails a replay, but not a
/// run with no goldens, where nothing is compared.
fn check_clock_fields(replaying: bool) -> Result<(), String> {
    let canon = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../parity/canon.ts");
    let source = match std::fs::read_to_string(&canon) {
        Ok(source) => source,
        Err(error) if replaying => {
            return Err(format!(
                "self-check: {} masks the clock fields replay needs: {error}",
                canon.display()
            ));
        }
        Err(_) => {
            println!("self-check: CLOCK_FIELDS not compared: parity/canon.ts is not in this tree");
            return Ok(());
        }
    };
    const OPEN: &str = "new Set<string>([";
    let list = source
        .find("CLOCK_FIELDS")
        .and_then(|i| source[i..].find(OPEN).map(|j| i + j + OPEN.len()))
        .and_then(|start| {
            source[start..]
                .find("])")
                .map(|end| &source[start..start + end])
        })
        .ok_or(format!(
            "self-check: no CLOCK_FIELDS `{OPEN}...])` in {}",
            canon.display()
        ))?;
    let names: Vec<&str> = list
        .split(',')
        .map(|s| s.trim().trim_matches('"'))
        .filter(|s| !s.is_empty())
        .collect();
    if names != CLOCK_FIELDS {
        return Err(format!(
            "self-check: canon.ts CLOCK_FIELDS is {names:?}, golden.rs has {CLOCK_FIELDS:?}"
        ));
    }
    Ok(())
}

/// Where the goldens are, if anywhere: `BMT_GOLDEN_DIR` must name a folder
/// that holds them; the default may be absent.
fn golden_dir() -> Result<Option<PathBuf>, String> {
    match std::env::var_os("BMT_GOLDEN_DIR") {
        Some(dir) => {
            let dir = PathBuf::from(dir);
            if dir.join("ipc").is_dir() {
                Ok(Some(dir))
            } else {
                Err(format!(
                    "BMT_GOLDEN_DIR={} holds no ipc/ folder of goldens",
                    dir.display()
                ))
            }
        }
        None => {
            let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../parity/out/golden");
            Ok(dir.join("ipc").is_dir().then_some(dir))
        }
    }
}

fn run() -> Result<Vec<String>, String> {
    let registry = commands::registry();
    let ported = read_ported(&registry)?;
    let dir = golden_dir()?;
    let manifest = dir.as_deref().map(read_manifest).transpose()?;
    if let Some(manifest) = &manifest {
        pin_zone_and_locale(manifest)?;
    }
    let build_app = |host: Host| bmt_lib::app_builder(mock_builder(), host);

    let root = std::env::temp_dir().join(format!("bmt-golden-self-check-{}", std::process::id()));
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    use_data_root(&root);
    check_harness(&root)?;
    check_side_effects(&root)?;
    check_every_channel(&build_app)?;
    check_comparison()?;
    check_clock_fields(dir.is_some())?;
    std::fs::remove_dir_all(&root).ok();
    println!(
        "self-check: a stub reads not ported, a wrong answer and a panic read fail, every channel takes its arguments"
    );

    let (Some(dir), Some(manifest)) = (dir, manifest) else {
        println!(
            "behavior replay skipped: no goldens here. They are recorded locally on the fixture, whose release waits on the operator's decision E2, so this run checked the harness and the contract only. Set BMT_GOLDEN_DIR and BMT_GOLDEN_DATA to replay."
        );
        if !ported.is_empty() {
            println!(
                "tests/ported.txt lists {} channels, not replayed here",
                ported.len()
            );
        }
        return Ok(Vec::new());
    };
    let data = std::env::var_os("BMT_GOLDEN_DATA").map(PathBuf::from);
    check_fixture(&manifest, data.as_deref())?;
    let goldens = read_goldens(&dir)?;
    let mut failures = Vec::new();

    let (checked, problems) = wire_shapes(&dir, &goldens, &registry);
    let cases_read = goldens.len();
    println!(
        "wire shapes: {checked} values Electron sent in {cases_read} cases read and write back {}",
        if problems.is_empty() {
            "unchanged".to_string()
        } else {
            format!("with {} differences", problems.len())
        }
    );
    failures.extend(problems.into_iter().map(|p| format!("wire shape: {p}")));

    let scratch = std::env::temp_dir().join(format!("bmt-golden-{}", std::process::id()));
    let mut groups: BTreeMap<&str, Vec<&Golden>> = BTreeMap::new();
    for golden in &goldens {
        groups
            .entry(golden.group.as_str())
            .or_default()
            .push(golden);
    }
    let mut cases: BTreeMap<&str, Vec<(String, Verdict)>> = BTreeMap::new();
    for (group, group_cases) in groups {
        let root = scratch.join(group);
        match &data {
            Some(data) => copy_dir(data, &root),
            None => std::fs::create_dir_all(&root).expect("create the data folder"),
        }
        use_data_root(&root);
        let replay = build(&build_app, manifest.clock);
        for golden in group_cases {
            if golden.channel == UNREGISTERED_CHANNEL {
                let answer = call(&replay.window, &golden.channel, Map::new());
                let expected = golden.outcome.get("invokeMessage").and_then(Value::as_str);
                let got = answer
                    .as_ref()
                    .err()
                    .map(|r| renderer_message(&golden.channel, r));
                if got.as_deref() != expected {
                    failures.push(format!(
                        "{UNREGISTERED_CHANNEL}: the page would read {got:?}, Electron's read {expected:?}"
                    ));
                }
                continue;
            }
            let Some(spec) = registry.iter().find(|c| c.channel == golden.channel) else {
                failures.push(format!(
                    "{} {}: a golden for a channel the contract lacks",
                    golden.channel, golden.case
                ));
                continue;
            };
            let (verdict, problems) = replay_case(&replay, spec, golden, &root);
            failures.extend(problems);
            cases
                .entry(spec.channel)
                .or_default()
                .push((golden.case.clone(), verdict));
        }
    }
    std::fs::remove_dir_all(&scratch).ok();

    let verdicts: BTreeMap<&str, Verdict> = registry
        .iter()
        .map(|spec| {
            let channel_cases = cases
                .get(spec.channel)
                .map(Vec::as_slice)
                .unwrap_or_default();
            (spec.channel, channel_verdict(channel_cases))
        })
        .collect();
    let mut counts: BTreeMap<Verdict, usize> = BTreeMap::new();
    println!("{:<30} {:<26} {:>5}  result", "channel", "method", "cases");
    for spec in &registry {
        let verdict = verdicts[spec.channel];
        *counts.entry(verdict).or_default() += 1;
        let n = cases.get(spec.channel).map_or(0, Vec::len);
        println!(
            "{:<30} {:<26} {:>5}  {}",
            spec.channel,
            spec.method,
            n,
            verdict.label()
        );
    }
    let count = |v| counts.get(&v).copied().unwrap_or(0);
    let mut summary = format!(
        "{} pass, {} fail, {} not ported",
        count(Verdict::Pass),
        count(Verdict::Fail),
        count(Verdict::NotPorted)
    );
    if count(Verdict::NoGolden) > 0 {
        summary.push_str(&format!(", {} no golden", count(Verdict::NoGolden)));
    }
    println!("{summary}");
    failures.extend(ratchet(&verdicts, &ported));
    Ok(failures)
}

fn main() -> ExitCode {
    match run() {
        Ok(failures) if failures.is_empty() => ExitCode::SUCCESS,
        Ok(failures) => {
            for failure in &failures {
                eprintln!("fail: {failure}");
            }
            ExitCode::FAILURE
        }
        Err(problem) => {
            eprintln!("{problem}");
            ExitCode::FAILURE
        }
    }
}
