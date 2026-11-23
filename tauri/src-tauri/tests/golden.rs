//! Replays every T05 IPC golden (`parity/goldens/FORMAT.md`) against the Rust
//! commands through Tauri's real IPC path, and prints one row per channel:
//! `pass`, `fail`, or `not ported`. A case passes when its outcome, the events
//! it pushed, the files it wrote, and the OS calls it made all match.
//!
//! `tests/ported.txt` is the ratchet: the channels expected to pass. A listed
//! channel that reads anything else fails the run, and so does a channel that
//! passes without being listed.
//!
//! T05's goldens are committed as `parity/goldens/data`. `BMT_GOLDEN_DIR`
//! names them, defaulting to a fresh recording in `parity/out/golden`; when it
//! is set the folder must exist. `BMT_GOLDEN_DATA` names the fixture data folder, whose
//! `matches.db` must have the manifest's `dbSha256`, copied fresh for each
//! group of cases. Without goldens only the self-check runs.
//!
//! A porting unit seeds state per case through `commands::Domain`, not by
//! editing this file.
//!
//! The `state-` cases T05 wrote for a page's calls are answers the page got in
//! one state of a run, not cases of their own: they replay through their
//! state's index, in order, on the launch that state ran on (`states.rs`).

#[path = "golden/states.rs"]
mod states;

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use bmt_lib::Host;
use bmt_lib::commands::{self, Clock, CommandError, CommandSpec, EffectRecorder, GoldenCase};
use bmt_lib::js_arg::{Js, JsValue, NON_FINITE_KEY};
use bmt_lib::replay::{Recording, require_recording_env};
use bmt_lib::security::{Effect, Effects};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use tauri::test::{INVOKE_KEY, MockRuntime, mock_builder, mock_context, noop_assets};
use tauri::webview::InvokeRequest;
use tauri::{Builder, Listener, Manager, WebviewWindow, WebviewWindowBuilder};

/// `CLOCK_FIELDS` in `parity/canon.ts`, which the self-check keeps in step.
const CLOCK_FIELDS: &[&str] = &[];
const CLOCK_MARK: &str = "<clock>";
const UNREGISTERED_CHANNEL: &str = "bmt:unregistered-channel";
/// The run folder Electron's seam writes as `$RUN` is the data root. The
/// fixture's data folder goes under it as `data/`, where `Paths` finds it.
const RUN: &str = "$RUN";
const CALL_TIMEOUT: Duration = Duration::from_secs(30);
/// JavaScript holds integers exactly only up to here.
const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;
/// SQLite's own files, which a write changes but the seam never lists.
const DATABASE_FILES: &[&str] = &[
    "data/matches.db",
    "data/matches.db-wal",
    "data/matches.db-shm",
    "data/matches.db-journal",
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

/// An argument with its `null` object fields dropped. The handlers read a
/// `null` field as they read a missing one (`!= null`, truthiness, a NULL
/// bind; the audit in the T08 record), and `Js` carries both as undefined.
fn argument_shape(value: &Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.iter()
                .filter(|(_, v)| !v.is_null())
                .map(|(k, v)| (k.clone(), argument_shape(v)))
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.iter().map(argument_shape).collect()),
        other => other.clone(),
    }
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
    let app = build_app(Host::replay(clock))
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
    call_within(window, channel, body, CALL_TIMEOUT)
}

fn call_within(
    window: &MockWindow,
    channel: &str,
    body: Map<String, Value>,
    timeout: Duration,
) -> Answer {
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
    match rx.recv_timeout(timeout) {
        Ok(tauri::ipc::InvokeResponse::Ok(body)) => {
            Ok(body.deserialize::<Value>().expect("a JSON response"))
        }
        Ok(tauri::ipc::InvokeResponse::Err(tauri::ipc::InvokeError(rejection))) => Err(rejection),
        Err(_) => Err(Value::from(format!(
            "{channel} did not answer within {} ms",
            timeout.as_millis()
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

/// SQLite's header field naming the library version that last wrote the
/// file. Electron's better-sqlite3 bundles 3.53.4 and Rust 3.54.1, which T11
/// accepted, so it is the one byte range the two apps' databases differ in.
const SQLITE_WRITER_VERSION: std::ops::Range<usize> = 96..100;

/// A written file as `path size sha256`, the form both sides compare in. A
/// SQLite file is hashed with its writer version zeroed (Appendix A, rule D).
fn file_key(path: &str, bytes: &[u8]) -> String {
    let mut hashed = bytes.to_vec();
    if hashed.starts_with(b"SQLite format 3\0") && hashed.len() >= SQLITE_WRITER_VERSION.end {
        hashed[SQLITE_WRITER_VERSION].fill(0);
    }
    format!("{path} {} {:x}", bytes.len(), Sha256::digest(&hashed))
}

/// The bytes a golden file record holds, from its `text` or its `base64`.
fn golden_bytes(file: &Value) -> Option<Vec<u8>> {
    use base64::Engine;
    if let Some(text) = file.get("text").and_then(Value::as_str) {
        return Some(text.as_bytes().to_vec());
    }
    let encoded = file.get("base64").and_then(Value::as_str)?;
    base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .ok()
}

/// The files the golden says were written against those this call wrote,
/// compared as `path size sha256`.
fn file_differences(golden: &Golden, root: &Path, before: &Listing) -> Vec<String> {
    let expected: BTreeSet<String> = golden
        .files
        .iter()
        .map(|f| {
            let path = f.get("path").and_then(Value::as_str).unwrap_or_default();
            match golden_bytes(f) {
                Some(bytes) => file_key(path, &bytes),
                None => {
                    let size = f.get("size").map(Value::to_string).unwrap_or_default();
                    let sha = f.get("sha256").and_then(Value::as_str).unwrap_or_default();
                    format!("{path} {size} {sha}")
                }
            }
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
        // A file the call made and removed again, such as a journal, was not
        // left written
        .filter(|(name, _)| root.join(name).is_file())
        .map(|(name, _)| {
            let bytes = std::fs::read(root.join(&name)).expect("read a written file");
            file_key(&format!("{RUN}/{name}"), &bytes)
        })
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

/// The OS shell calls `security::Effects` recorded since the last drain, in
/// the seam's `{ api, args }` shape. A mock app built on something other than
/// `Host::replay` has none.
fn os_effects(app: &MockApp) -> Vec<Value> {
    let Some(effects) = app.try_state::<Effects>() else {
        return Vec::new();
    };
    effects
        .take()
        .into_iter()
        .map(|effect| match effect {
            Effect::OpenExternal(url) => serde_json::json!({ "api": "shell.openExternal", "args": [url] }),
            Effect::OpenPath(path) => {
                serde_json::json!({ "api": "shell.openPath", "args": [path.to_string_lossy()] })
            }
        })
        .collect()
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
            files: &golden.files,
            root,
        },
    );
    replay.events.take();
    replay.app.state::<EffectRecorder>().take();
    os_effects(&replay.app);
    let before = listing(root);
    let answer = call(&replay.window, spec.channel, spec.named_args(&golden.args));
    let pushed = replay.events.take();
    let mut effects = replay.app.state::<EffectRecorder>().take();
    effects.extend(os_effects(&replay.app));
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
    let mut check = |label: String,
                     roundtrip: fn(Value) -> Result<Value, String>,
                     sent: &Value,
                     argument: bool| {
        checked += 1;
        // An argument is a JavaScript number as the page held it; only a
        // result's integer can be one JavaScript cannot hold
        if !argument {
            unsafe_integers(&label, sent, &mut problems);
        }
        let shape = |v: &Value| {
            canonical(&if argument {
                argument_shape(v)
            } else {
                v.clone()
            })
        };
        match roundtrip(sent.clone()) {
            Ok(written) => {
                // A key the Rust type drops is one api.ts does not declare, so
                // the handler never read it; contract-check catches a rename
                let found = first_difference("", &shape(sent), &shape(&written))
                    .filter(|f| !(argument && f.ends_with(": dropped by the Rust type")));
                if let Some(found) = found {
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
                true,
            );
        }
        if golden.outcome.get("kind").and_then(Value::as_str) == Some("value") {
            let result = golden.outcome.get("result").cloned().unwrap_or(Value::Null);
            check(
                format!("{} {} result", golden.channel, golden.case),
                spec.ret.roundtrip,
                &result,
                false,
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
                Some(spec) => check(
                    format!("event {name}"),
                    spec.payload.roundtrip,
                    payload,
                    false,
                ),
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
    recording: Recording,
    db_sha256: Option<String>,
    /// The snapshot the goldens were recorded on, `fixture` for T05's.
    data: String,
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
        recording: Recording::from_manifest(&manifest),
        db_sha256: text_field("dbSha256"),
        data: text_field("data").unwrap_or_else(|| "fixture".into()),
    })
}

/// How the golden test is run over `dir` and `data`, for a refusal to print.
fn replay_command(dir: &Path, data: &str) -> String {
    format!(
        "BMT_GOLDEN_DIR={} BMT_GOLDEN_DATA={data} cargo test --features parity-driver --test golden",
        dir.display()
    )
}

/// The snapshot folder next to the goldens, `parity/snapshots/<data>/data`
/// beside `parity/out/golden`, where `parity/snapshot.ts` writes it.
fn fixture_beside(dir: &Path, manifest: &Manifest) -> Option<PathBuf> {
    let parity = dir.parent()?.parent()?;
    Some(parity.join("snapshots").join(&manifest.data).join("data"))
}

/// Refuses a fixture other than the one the goldens were recorded on, and
/// goldens that do not say which one that was.
fn check_fixture(manifest: &Manifest, dir: &Path, data: Option<&Path>) -> Result<(), String> {
    let Some(expected) = &manifest.db_sha256 else {
        return Err(format!(
            "{} has no dbSha256, so replay cannot tell which fixture the goldens were recorded on; re-record them with parity/run-electron.ts",
            dir.join("manifest.json").display()
        ));
    };
    let matching = |folder: &Path| {
        let db = folder.join("matches.db");
        db.is_file().then(|| sha256(&db))
    };
    let found = match data {
        None => "BMT_GOLDEN_DATA is not set".to_owned(),
        Some(data) => match matching(data) {
            None => format!("{} holds no matches.db", data.display()),
            Some(actual) => {
                if &actual != expected {
                    format!(
                        "{} has sha256 {actual}, and replay over another fixture fails a correct port",
                        data.join("matches.db").display()
                    )
                } else {
                    return Ok(());
                }
            }
        },
    };
    let rerun = match fixture_beside(dir, manifest) {
        Some(beside) if matching(&beside).as_ref() == Some(expected) => format!(
            "Rerun as:\n  {}",
            manifest
                .recording
                .rerun(&replay_command(dir, &beside.display().to_string()))
        ),
        beside => format!(
            "No folder of that sha256 is at {}; point BMT_GOLDEN_DATA at the snapshot the goldens were recorded on:\n  {}",
            beside.map_or("the goldens' parity/snapshots".into(), |b| b
                .display()
                .to_string()),
            manifest.recording.rerun(&replay_command(
                dir,
                &format!("<a folder whose matches.db has sha256 {expected}>")
            ))
        ),
    };
    Err(format!(
        "the goldens were recorded on a matches.db of sha256 {expected}, but {found}. {rerun}"
    ))
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

/// Lays the snapshot out under `root` as `parity/run-electron.ts` does for
/// Electron: `data/`, and the art and game data copies in `asset-cache/`
/// beside it when the snapshot has them.
fn copy_fixture(data: &Path, root: &Path) {
    copy_dir(data, &root.join("data"));
    if let Some(cache) = data.parent().map(|snapshot| snapshot.join("asset-cache"))
        && cache.is_dir()
    {
        copy_dir(&cache, &root.join("asset-cache"));
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
async fn hanging() -> Result<String, CommandError> {
    std::future::pending().await
}

#[tauri::command(rename = "app:version")]
async fn version_and_event(app: tauri::AppHandle<MockRuntime>) -> Result<String, CommandError> {
    bmt_lib::events::games_updated(&app);
    Ok("1.2.1".into())
}

#[tauri::command(rename = "app:version")]
async fn version_only() -> Result<String, CommandError> {
    Ok("1.2.1".into())
}

#[tauri::command(rename = "app:version")]
async fn version_and_effect(app: tauri::AppHandle<MockRuntime>) -> Result<String, CommandError> {
    let root = std::env::var("BMT_DATA_ROOT").map_err(|e| CommandError::thrown(e.to_string()))?;
    let folder = Path::new(&root).join("backups");
    app.state::<EffectRecorder>().record(
        "shell.openPath",
        vec![Value::from(folder.to_string_lossy())],
    );
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
    let update = Golden::parse(serde_json::json!({
        "channel": "app:check-update", "case": "hand-made", "group": "read", "seq": 0, "args": [],
        "outcome": { "kind": "value", "result": { "hasUpdate": false } }
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
    let hangs = |host: Host| {
        mock_builder()
            .manage(host.clock)
            .invoke_handler(tauri::generate_handler![hanging])
    };
    let hung = call_within(
        &build(&hangs, Clock::System).window,
        "app:version",
        Map::new(),
        Duration::from_millis(200),
    );
    if hung != Err(Value::from("app:version did not answer within 200 ms")) {
        return Err(format!(
            "self-check timeout: a hung command answered {hung:?}"
        ));
    }
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

/// A right answer with any side effect that differs from Electron's, in
/// either direction, is a failure, and the ratchet holds both ways.
fn check_side_effects(root: &Path) -> Result<(), String> {
    let registry = commands::registry();
    let spec = registry
        .iter()
        .find(|c| c.channel == "app:version")
        .ok_or("app:version is not registered")?;
    let golden = |key: &str, items: Value| {
        let mut golden = serde_json::json!({
            "channel": "app:version", "case": "hand-made", "group": "read", "seq": 0, "args": [],
            "outcome": { "kind": "value", "result": "1.2.1" }
        });
        golden[key] = items;
        Golden::parse(golden)
    };
    let quiet = golden("events", serde_json::json!([]))?;
    let pushed = golden(
        "events",
        serde_json::json!([{ "seq": 0, "event": "lcu:games-updated" }]),
    )?;
    let other_payload = golden(
        "events",
        serde_json::json!([{ "seq": 0, "event": "lcu:games-updated", "payload": { "games": 1 } }]),
    )?;
    let stray = format!("{:x}", Sha256::digest(b"x"));
    let wrote = golden(
        "files",
        serde_json::json!([{ "path": "$RUN/stray.txt", "size": 1, "sha256": stray }]),
    )?;
    let opened = golden(
        "effects",
        serde_json::json!([{ "seq": 0, "api": "shell.openPath", "args": ["$RUN/backups"] }]),
    )?;
    let handlers =
        |handler: fn() -> Builder<MockRuntime>| move |host: Host| handler().manage(host.clock);
    let only = handlers(|| mock_builder().invoke_handler(tauri::generate_handler![version_only]));
    let emits =
        handlers(|| mock_builder().invoke_handler(tauri::generate_handler![version_and_event]));
    let writes =
        handlers(|| mock_builder().invoke_handler(tauri::generate_handler![version_and_file]));
    let records =
        handlers(|| mock_builder().invoke_handler(tauri::generate_handler![version_and_effect]));
    let cases: [(&str, BuildApp<'_>, &Golden, Verdict); 10] = [
        (
            "no side effect on either side",
            &only,
            &quiet,
            Verdict::Pass,
        ),
        (
            "an event Electron did not push",
            &emits,
            &quiet,
            Verdict::Fail,
        ),
        ("the event Electron pushed", &emits, &pushed, Verdict::Pass),
        ("an event Rust did not push", &only, &pushed, Verdict::Fail),
        (
            "an event with another payload",
            &emits,
            &other_payload,
            Verdict::Fail,
        ),
        (
            "a file Electron did not write",
            &writes,
            &quiet,
            Verdict::Fail,
        ),
        ("the file Electron wrote", &writes, &wrote, Verdict::Pass),
        ("a file Rust did not write", &only, &wrote, Verdict::Fail),
        (
            "an OS call Electron did not make",
            &records,
            &quiet,
            Verdict::Fail,
        ),
        (
            "an OS call Rust did not make",
            &only,
            &opened,
            Verdict::Fail,
        ),
    ];
    for (label, handler, golden, want) in cases {
        let verdict = replay_case(&build(handler, Clock::System), spec, golden, root).0;
        std::fs::remove_file(root.join("stray.txt")).ok();
        expect(label, verdict, want)?;
    }
    expect(
        "the OS call Electron made, under $RUN",
        replay_case(&build(&records, Clock::System), spec, &opened, root).0,
        Verdict::Pass,
    )?;

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
    let stubbed = listed_stubs(
        &BTreeSet::from(["db:profile", "db:seasons"]),
        &BTreeSet::from(["db:profile".to_owned(), "app:version".to_owned()]),
    );
    if stubbed != ["db:profile is in tests/ported.txt but its body answers not ported"] {
        return Err(format!("self-check listed stubs: {stubbed:?}"));
    }
    Ok(())
}

/// Every channel is reachable under its name and reads its arguments by their
/// keys: only a body may answer, never Tauri's own refusal, which is a string.
fn check_every_channel(build_app: BuildApp<'_>) -> Result<BTreeSet<&'static str>, String> {
    let cfg = ts_rs::Config::new().with_large_int("number");
    let replay = build(build_app, Clock::System);
    let mut stubs = BTreeSet::new();
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
        let mut stub = true;
        for body in [full, required] {
            match call(&replay.window, command.channel, body.clone()) {
                Err(Value::String(refusal)) => {
                    return Err(format!(
                        "self-check {} with {body:?}: Tauri refused it: {refusal}",
                        command.channel
                    ));
                }
                Err(rejection) if is_not_ported(&rejection) => {}
                _ => stub = false,
            }
        }
        if stub {
            stubs.insert(command.channel);
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
    Ok(stubs)
}

/// Arguments the page can send that a Rust type would refuse. The first file
/// was recorded from trunk Electron (T13's verifier) for the matches domain;
/// the second is hand-made, one or two per scalar argument of every other
/// domain, from the handler audit in the T08 record. Electron's handler
/// answers each, so Tauri must hand each to the body, never refuse it; the
/// body then answers as Electron did, SQLite's own refusals included, which a
/// replay of the recorded corpus checks.
const HOSTILE_ARGUMENTS: &[&str] = &["tests/hostile-args.json", "tests/hostile-scalar-args.json"];

fn check_hostile_arguments(build_app: BuildApp<'_>) -> Result<(), String> {
    let mut cases: Vec<Value> = Vec::new();
    for file in HOSTILE_ARGUMENTS {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(file);
        let text =
            std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        let read: Vec<Value> = serde_json::from_str(&text).map_err(|e| e.to_string())?;
        cases.extend(read);
    }
    let registry = commands::registry();
    let replay = build(build_app, Clock::System);
    for case in &cases {
        let channel = case["channel"].as_str().unwrap_or_default();
        let label = format!("{channel} {}", case["case"].as_str().unwrap_or_default());
        let spec = registry
            .iter()
            .find(|c| c.channel == channel)
            .ok_or(format!("{label}: not a channel"))?;
        let args = case["args"].as_array().cloned().unwrap_or_default();
        if let Err(Value::String(refusal)) = call(&replay.window, channel, spec.named_args(&args)) {
            return Err(format!("self-check {label}: Tauri refused it: {refusal}"));
        }
    }
    Ok(())
}

/// What a hand-made `db:global-stats` received for `queue`, through Tauri's
/// own argument decoding: whether it read as undefined, and its number.
#[tauri::command(rename = "db:global-stats")]
async fn received_queue(
    patch: Js<Option<String>>,
    queue: Js<Option<i64>>,
) -> Result<Value, CommandError> {
    let _ = patch;
    let number = queue.value().and_then(JsValue::as_f64);
    Ok(serde_json::json!({
        "undefined": queue.is_undefined(),
        "number": number.map(|n| n.to_string()),
    }))
}

/// A NaN or an infinity, as api.ts's transport sends it, reaches the body as
/// the number the page held: present, so `queue != null` holds as in
/// Electron, and a NaN, not the `null` JSON alone would carry.
fn check_non_finite_arguments() -> Result<(), String> {
    let received = |host: Host| {
        mock_builder()
            .manage(host.clock)
            .invoke_handler(tauri::generate_handler![received_queue])
    };
    let replay = build(&received, Clock::System);
    for (sent, number) in [("NaN", "NaN"), ("Infinity", "inf"), ("-Infinity", "-inf")] {
        let body = serde_json::json!({ "queue": { NON_FINITE_KEY: sent } });
        let Value::Object(body) = body else {
            unreachable!()
        };
        let answer = call(&replay.window, "db:global-stats", body);
        let want = serde_json::json!({ "undefined": false, "number": number });
        if answer != Ok(want.clone()) {
            return Err(format!(
                "self-check non-finite {sent}: the body received {answer:?}, not {want}"
            ));
        }
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
/// Two SQLite files that differ only in the writer-version header field
/// compare equal; a byte anywhere else, header or page, still differs.
fn check_sqlite_writer_version() -> Result<(), String> {
    let page = 4096;
    let mut electron = vec![0u8; 2 * page];
    electron[..16].copy_from_slice(b"SQLite format 3\0");
    electron[96..100].copy_from_slice(&3_053_004u32.to_be_bytes());
    let mut rust = electron.clone();
    rust[96..100].copy_from_slice(&3_054_001u32.to_be_bytes());
    let key = |bytes: &[u8]| file_key("$RUN/x.db", bytes);
    if key(&electron) != key(&rust) {
        return Err(
            "self-check sqlite: a writer-version difference alone reads as a different file".into(),
        );
    }
    for offset in [0, 18, 24, 28, 92, 95, 100, page - 1, page, 2 * page - 1] {
        let mut changed = rust.clone();
        changed[offset] ^= 0xff;
        if key(&electron) == key(&changed) {
            return Err(format!(
                "self-check sqlite: a change at byte {offset} reads as the same file"
            ));
        }
    }
    let mut plain = b"not a database".to_vec();
    plain.resize(200, 0);
    let mut other = plain.clone();
    other[97] ^= 0xff;
    if key(&plain) == key(&other) {
        return Err(
            "self-check sqlite: bytes 96..100 of a file that is not SQLite were ignored".into(),
        );
    }
    Ok(())
}

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

/// What replaying a set of goldens found.
struct Replayed {
    wire_values: usize,
    cases: BTreeMap<&'static str, Vec<(String, Verdict)>>,
    verdicts: BTreeMap<&'static str, Verdict>,
    states: Vec<StateReport>,
    skipped: Vec<states::Skipped>,
    /// `state` cases no index names, so nothing says which run they belong to.
    unnamed_state_cases: Vec<String>,
    failures: Vec<String>,
}

/// One state replayed: on which launch, how many calls, and their verdict.
struct StateReport {
    state: String,
    launch: usize,
    data: states::Data,
    calls: usize,
    verdict: Verdict,
}

/// The `state` group: cases `record-states.ts` wrote for a page's calls.
const STATE_GROUP: &str = "state";

type Cases = BTreeMap<&'static str, Vec<(String, Verdict)>>;

/// The case replay picks for a call by its arguments alone: the lowest `seq`
/// whose arguments are canonically equal. Two at that `seq` is an error.
fn by_arguments<'a>(
    goldens: &'a [Golden],
    channel: &str,
    args: &[Value],
) -> Result<&'a Golden, String> {
    let sent = Value::Array(args.to_vec());
    let mut matches: Vec<&Golden> = goldens
        .iter()
        .filter(|g| g.channel == channel && same(&Value::Array(g.args.clone()), &sent))
        .collect();
    matches.sort_by_key(|g| g.seq);
    match matches.as_slice() {
        [] => Err(format!("{channel} {sent}: no golden answers it")),
        [first, second, ..] if first.seq == second.seq => Err(format!(
            "{channel} {sent}: cases {} and {} tie at seq {}",
            first.case, second.case, first.seq
        )),
        [first, ..] => Ok(first),
    }
}

/// Replays each planned launch on a fresh app over its own data: first
/// `resolveVars`' reads, then every state's calls in `seq` order, each held to
/// the case its index names.
#[allow(clippy::too_many_arguments)]
fn replay_states(
    plan: states::Plan,
    goldens: &[Golden],
    clock: Clock,
    data: Option<&Path>,
    registry: &[CommandSpec],
    build_app: BuildApp<'_>,
    scratch: &Path,
    cases: &mut Cases,
    failures: &mut Vec<String>,
) -> Vec<StateReport> {
    let named: BTreeMap<(&str, &str), &Golden> = goldens
        .iter()
        .map(|g| ((g.channel.as_str(), g.case.as_str()), g))
        .collect();
    let spec_of = |channel: &str| registry.iter().find(|c| c.channel == channel);
    let mut reports = Vec::new();
    for (n, launch) in plan.launches.into_iter().enumerate() {
        let root = scratch.join(format!("launch-{n}"));
        match (launch.data, data) {
            (states::Data::Recorded, Some(data)) => copy_fixture(data, &root),
            _ => std::fs::create_dir_all(&root).expect("create the data folder"),
        }
        use_data_root(&root);
        let replay = build(build_app, clock);
        for (channel, args) in states::RESOLVE_VARS {
            let args: Vec<Value> = args.iter().copied().map(Value::from).collect();
            let Some(spec) = spec_of(channel) else {
                failures.push(format!(
                    "resolveVars reads {channel}, which the contract lacks"
                ));
                continue;
            };
            if launch.data == states::Data::Empty {
                // No golden holds Electron's answers on empty data
                let _unrecorded = call(&replay.window, spec.channel, spec.named_args(&args));
                continue;
            }
            match by_arguments(goldens, channel, &args) {
                Ok(golden) => {
                    let (verdict, problems) = replay_case(&replay, spec, golden, &root);
                    failures.extend(problems);
                    cases
                        .entry(spec.channel)
                        .or_default()
                        .push((format!("launch {n} resolveVars"), verdict));
                }
                Err(problem) => failures.push(format!("launch {n} resolveVars: {problem}")),
            }
        }
        for state in launch.states {
            let mut verdicts = Vec::new();
            for call in &state.calls {
                let label = format!("state {} #{}", state.state, call.seq);
                let (Some(golden), Some(spec)) = (
                    named.get(&(call.channel.as_str(), call.case.as_str())),
                    spec_of(&call.channel),
                ) else {
                    failures.push(format!(
                        "{label}: {} {} is not a golden of a contract channel",
                        call.channel, call.case
                    ));
                    verdicts.push((label, Verdict::Fail));
                    continue;
                };
                if !same(
                    &Value::Array(call.args.clone()),
                    &Value::Array(golden.args.clone()),
                ) {
                    failures.push(format!(
                        "{label}: the page sent {:?}, but {} {} holds {:?}",
                        call.args, call.channel, call.case, golden.args
                    ));
                } else if verdict == Verdict::Pass && !same_effects(&golden.effects, &effects) {
                    verdict = Verdict::Fail;
                    failures.push(format!(
                        "{} {}: expected effects {}, got {effects}",
                        golden.channel, golden.case, golden.effects
                    ));
                }
                let (verdict, problems) = replay_case(&replay, spec, golden, &root);
                failures.extend(problems.into_iter().map(|p| format!("{label}: {p}")));
                cases
                    .entry(spec.channel)
                    .or_default()
                    .push((label.clone(), verdict));
                verdicts.push((label, verdict));
            }
            reports.push(StateReport {
                verdict: channel_verdict(&verdicts),
                calls: state.calls.len(),
                state: state.state,
                launch: n,
                data: launch.data,
            });
        }
    }
    reports
}

/// Replays `goldens` against apps from `build_app`, each group over a fresh
/// copy of `data`, then the states as they were recorded, and holds the
/// result to the ratchet. `recorded` is the manifest's name for `data`.
#[allow(clippy::too_many_arguments)]
fn replay_goldens(
    dir: &Path,
    goldens: &[Golden],
    clock: Clock,
    data: Option<&Path>,
    recorded: &str,
    registry: &[CommandSpec],
    ported: BTreeSet<String>,
    build_app: BuildApp<'_>,
) -> Replayed {
    let mut failures = Vec::new();
    let (wire_values, problems) = wire_shapes(dir, goldens, registry);
    failures.extend(problems.into_iter().map(|p| format!("wire shape: {p}")));

    let scratch = std::env::temp_dir().join(format!("bmt-golden-{}", std::process::id()));
    let mut groups: BTreeMap<&str, Vec<&Golden>> = BTreeMap::new();
    for golden in goldens.iter().filter(|g| g.group != STATE_GROUP) {
        groups
            .entry(golden.group.as_str())
            .or_default()
            .push(golden);
    }
    let mut cases: Cases = BTreeMap::new();
    for (group, group_cases) in groups {
        let root = scratch.join(group);
        match data {
            Some(data) => copy_fixture(data, &root),
            None => std::fs::create_dir_all(&root).expect("create the data folder"),
        }
        use_data_root(&root);
        let replay = build(build_app, clock);
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
    let (mut plan, indexes) = match states::read_indexes(dir) {
        Ok(indexes) => {
            let names: BTreeSet<(String, String)> = indexes
                .iter()
                .flat_map(|i| i.calls.iter().map(|c| (c.channel.clone(), c.case.clone())))
                .collect();
            let rows = states::states_ts(dir)
                .ok_or_else(|| format!("{} has no parity/ folder above it", dir.display()))
                .and_then(|path| {
                    std::fs::read_to_string(&path)
                        .map_err(|e| format!("{}: {e}", path.display()))
                        .and_then(|source| {
                            states::parse_rows(&source)
                                .map_err(|e| format!("{}: {e}", path.display()))
                        })
                });
            (states::plan(rows, indexes, recorded), names)
        }
        Err(problem) => {
            failures.push(format!("state indexes: {problem}"));
            (states::Plan::default(), BTreeSet::new())
        }
    };
    let unnamed_state_cases = goldens
        .iter()
        .filter(|g| {
            g.group == STATE_GROUP && !indexes.contains(&(g.channel.clone(), g.case.clone()))
        })
        .map(|g| format!("{} {}", g.channel, g.case))
        .collect();
    let skipped = std::mem::take(&mut plan.skipped);
    let states = replay_states(
        plan,
        goldens,
        clock,
        data,
        registry,
        build_app,
        &scratch,
        &mut cases,
        &mut failures,
    );
    std::fs::remove_dir_all(&scratch).ok();

    let verdicts: BTreeMap<&'static str, Verdict> = registry
        .iter()
        .map(|spec| {
            let channel_cases = cases
                .get(spec.channel)
                .map(Vec::as_slice)
                .unwrap_or_default();
            (spec.channel, channel_verdict(channel_cases))
        })
        .collect();
    failures.extend(ratchet(&verdicts, &ported));
    Replayed {
        wire_values,
        cases,
        verdicts,
        states,
        skipped,
        unnamed_state_cases,
        failures,
    }
}

/// Settings a hand-made `settings:get` and `settings:set` keep, as
/// Electron's settings table does: a get reads what an earlier set wrote.
#[derive(Default)]
struct HandSettings(Mutex<BTreeMap<String, String>>);

#[tauri::command(rename = "settings:get")]
async fn hand_get(
    app: tauri::AppHandle<MockRuntime>,
    key: String,
) -> Result<Option<String>, CommandError> {
    let settings = app.state::<HandSettings>();
    Ok(settings.0.lock().expect("the settings").get(&key).cloned())
}

#[tauri::command(rename = "settings:set")]
async fn hand_set(
    app: tauri::AppHandle<MockRuntime>,
    key: String,
    value: String,
) -> Result<(), CommandError> {
    let settings = app.state::<HandSettings>();
    settings.0.lock().expect("the settings").insert(key, value);
    Ok(())
}

/// States replay in `seq` order on the launch they ran on, so a get sees an
/// earlier set, in its own state or an earlier one; a state replay cannot
/// reproduce is skipped with its reason. Each layout is written under `root`
/// as `parity/out/golden` with `parity/states.ts` beside it.
fn check_state_replay(root: &Path) -> Result<(), String> {
    let write = |path: PathBuf, value: Value| -> Result<(), String> {
        std::fs::create_dir_all(path.parent().expect("a parent")).map_err(|e| e.to_string())?;
        std::fs::write(&path, value.to_string()).map_err(|e| e.to_string())
    };
    let golden = |channel: &str, case: &str, args: Value, outcome: Value| {
        serde_json::json!({
            "channel": channel, "case": case, "group": STATE_GROUP, "seq": 1_000_000,
            "args": args, "outcome": outcome
        })
    };
    let set = || serde_json::json!({ "seq": 0, "channel": "settings:set", "args": ["k", "v"], "case": "put" });
    let get = |seq: i64| serde_json::json!({ "seq": seq, "channel": "settings:get", "args": ["k"], "case": "state-v" });
    let index = |state: &str, group: &str, calls: Value| serde_json::json!({ "format": 1, "state": state, "group": group, "calls": calls });
    let states_ts = "const row = () => ({});\nexport const STATES: StateRow[] = [\n  row(\"in-order\", \"default\", \"/\", \"x\"),\n  row(\n    \"reads-earlier\",\n    \"default\",\n    \"/\",\n    \"x\",\n  ),\n  row(\"unrecorded\", \"default\", \"/\", \"x\"),\n  row(\"after-gap\", \"default\", \"/\", \"x\"),\n  row(\"on-snapshot\", \"default\", \"/\", \"x\", { data: \"snapshot\" }),\n  ...CLIENT_STATES,\n];\n";
    let hand = |host: Host| {
        mock_builder()
            .manage(host.clock)
            .manage(HandSettings::default())
            .invoke_handler(tauri::generate_handler![hand_get, hand_set])
    };
    let run = |name: &str, first: Value| -> Result<Replayed, String> {
        let parity = root.join(name).join("parity");
        let dir = parity.join("out/golden");
        std::fs::create_dir_all(&parity).map_err(|e| e.to_string())?;
        std::fs::write(parity.join("states.ts"), states_ts).map_err(|e| e.to_string())?;
        let goldens = [
            golden(
                "settings:set",
                "put",
                serde_json::json!(["k", "v"]),
                serde_json::json!({ "kind": "void" }),
            ),
            golden(
                "settings:get",
                "state-v",
                serde_json::json!(["k"]),
                serde_json::json!({ "kind": "value", "result": "v" }),
            ),
            golden(
                "settings:get",
                "state-unnamed",
                serde_json::json!(["other"]),
                serde_json::json!({ "kind": "value", "result": null }),
            ),
        ];
        for g in &goldens {
            let file = format!(
                "{}/{}.json",
                g["channel"].as_str().unwrap_or_default().replace(':', "."),
                g["case"].as_str().unwrap_or_default()
            );
            write(dir.join("ipc").join(file), g.clone())?;
        }
        write(
            dir.join("states/in-order.json"),
            index("in-order", "default", first),
        )?;
        write(
            dir.join("states/reads-earlier.json"),
            index("reads-earlier", "default", serde_json::json!([get(0)])),
        )?;
        write(
            dir.join("states/after-gap.json"),
            index("after-gap", "default", serde_json::json!([get(0)])),
        )?;
        write(
            dir.join("states/on-snapshot.json"),
            index("on-snapshot", "default", serde_json::json!([get(0)])),
        )?;
        write(
            dir.join("states/live-in-game.json"),
            index("live-in-game", "client", serde_json::json!([get(0)])),
        )?;
        let goldens = read_goldens(&dir)?;
        Ok(replay_goldens(
            &dir,
            &goldens,
            Clock::System,
            None,
            "fixture",
            &commands::registry(),
            BTreeSet::new(),
            &hand,
        ))
    };
    let verdicts = |replayed: &Replayed| -> Vec<(String, &'static str)> {
        replayed
            .states
            .iter()
            .map(|s| (s.state.clone(), s.verdict.label()))
            .collect()
    };
    let owned = |pairs: &[(&str, &'static str)]| -> Vec<(String, &'static str)> {
        pairs.iter().map(|(s, v)| (s.to_string(), *v)).collect()
    };
    // The file lists the get first; its seq puts the set before it
    let in_order = run("states-in-order", serde_json::json!([get(1), set()]))?;
    let reordered = run(
        "states-reordered",
        serde_json::json!([set(), get(0)].map(|mut c| {
            if c["channel"] == "settings:set" {
                c["seq"] = 1.into();
            }
            c
        })),
    )?;
    std::fs::remove_dir_all(root.join("states-in-order")).ok();
    std::fs::remove_dir_all(root.join("states-reordered")).ok();

    if verdicts(&in_order) != owned(&[("in-order", "pass"), ("reads-earlier", "pass")]) {
        return Err(format!(
            "self-check states in order: {:?}, {:?}",
            verdicts(&in_order),
            in_order.failures
        ));
    }
    if verdicts(&reordered) != owned(&[("in-order", "fail"), ("reads-earlier", "pass")]) {
        return Err(format!(
            "self-check states, a get before its set: {:?}",
            verdicts(&reordered)
        ));
    }
    let reasons: Vec<(&str, &str)> = in_order
        .skipped
        .iter()
        .map(|s| (s.state.as_str(), s.reason.as_str()))
        .collect();
    let skipped_right = matches!(reasons.as_slice(),
        [(client, why_client), (gap, why_gap), (snapshot, why_snapshot)]
            if *client == "live-in-game" && why_client.contains("fake League client")
            && *gap == "after-gap" && why_gap.starts_with("unrecorded ran before it")
            && *snapshot == "on-snapshot" && why_snapshot.contains("data `snapshot`"));
    if !skipped_right {
        return Err(format!("self-check states: skipped {reasons:?}"));
    }
    if in_order.unnamed_state_cases != ["settings:get state-unnamed"] {
        return Err(format!(
            "self-check states: unnamed cases {:?}",
            in_order.unnamed_state_cases
        ));
    }
    // The fixture launch asked resolveVars' reads first, and on no real data
    // no golden answers them; the hand-made channels pass unlisted
    let read_first: Vec<&String> = in_order
        .failures
        .iter()
        .filter(|f| f.starts_with("launch 0 resolveVars: "))
        .collect();
    let asked = states::RESOLVE_VARS.iter().all(|(channel, _)| {
        read_first
            .iter()
            .any(|f| f.contains(&format!(": {channel} ")))
    });
    let others = in_order.failures.len() - read_first.len();
    let unlisted = in_order
        .failures
        .iter()
        .filter(|f| f.ends_with("passes; add it to tests/ported.txt"))
        .count();
    if !asked || read_first.len() != states::RESOLVE_VARS.len() || others != unlisted {
        return Err(format!(
            "self-check states in order: failures {:?}",
            in_order.failures
        ));
    }
    Ok(())
}

/// The replay entry with a listed stub fails on the ratchet, so the replay
/// cannot drop its verdict.
fn check_replay_ratchet(root: &Path) -> Result<(), String> {
    let golden = Golden::parse(serde_json::json!({
        "channel": "app:version", "case": "hand-made", "group": "read", "seq": 0, "args": [],
        "outcome": { "kind": "value", "result": "1.2.1" }
    }))?;
    let stub = |host: Host| {
        mock_builder()
            .manage(host.clock)
            .invoke_handler(tauri::generate_handler![canary])
    };
    let replayed = replay_goldens(
        &root.join("no-goldens"),
        &[golden],
        Clock::System,
        None,
        "fixture",
        &commands::registry(),
        BTreeSet::from(["app:version".to_owned()]),
        &stub,
    );
    if replayed.failures != ["app:version is in tests/ported.txt but reads not ported"] {
        return Err(format!(
            "self-check replay ratchet: a listed stub replayed with {:?}",
            replayed.failures
        ));
    }
    Ok(())
}

/// A listed channel whose body still answers `not ported`, which a run with
/// no goldens can see without replaying anything.
fn listed_stubs(stubs: &BTreeSet<&str>, ported: &BTreeSet<String>) -> Vec<String> {
    ported
        .iter()
        .filter(|channel| stubs.contains(channel.as_str()))
        .map(|channel| format!("{channel} is in tests/ported.txt but its body answers not ported"))
        .collect()
}

/// Both fixture refusals, over a goldens folder and snapshot made here.
fn check_fixture_refusals(root: &Path) -> Result<(), String> {
    // One segment per join, so the paths read as fixture_beside builds them on
    // Windows too, where a "/" inside a joined segment stays a "/"
    let at = |parts: &[&str]| {
        parts
            .iter()
            .fold(root.join("fixture-check"), |path, part| path.join(part))
    };
    let dir = at(&["parity", "out", "golden"]);
    let beside = at(&["parity", "snapshots", "fixture", "data"]);
    let other = at(&["other"]);
    for (folder, text) in [(&beside, "recorded"), (&other, "another")] {
        std::fs::create_dir_all(folder).map_err(|e| e.to_string())?;
        std::fs::write(folder.join("matches.db"), text).map_err(|e| e.to_string())?;
    }
    let manifest = |db_sha256: Option<String>| Manifest {
        clock: Clock::System,
        recording: Recording::from_manifest(&Value::Null),
        db_sha256,
        data: "fixture".into(),
    };
    let recorded = manifest(Some(format!("{:x}", Sha256::digest(b"recorded"))));
    let rerun = recorded
        .recording
        .rerun(&replay_command(&dir, &beside.display().to_string()));
    let refusals = [
        check_fixture(&manifest(None), &dir, Some(&beside)),
        check_fixture(&recorded, &dir, Some(&other)),
        check_fixture(&recorded, &dir, None),
    ];
    std::fs::remove_dir_all(root.join("fixture-check")).ok();
    let [unrecorded, wrong, unset] = refusals;
    if !unrecorded
        .as_ref()
        .is_err_and(|e| e.contains("has no dbSha256"))
    {
        return Err(format!(
            "self-check fixture: a manifest with no dbSha256 read {unrecorded:?}"
        ));
    }
    for (label, refusal) in [("another fixture", wrong), ("no BMT_GOLDEN_DATA", unset)] {
        if !refusal
            .as_ref()
            .is_err_and(|e| e.ends_with(&format!("Rerun as:\n  {rerun}")))
        {
            return Err(format!(
                "self-check fixture, {label}: {refusal:?} does not end in the rerun line {rerun:?}"
            ));
        }
    }
    if check_fixture(&recorded, &dir, Some(&beside)).is_ok() {
        return Err("self-check fixture: the recorded fixture was refused".into());
    }
    Ok(())
}

fn run() -> Result<Vec<String>, String> {
    let registry = commands::registry();
    let ported = read_ported(&registry)?;
    let dir = golden_dir()?;
    let manifest = dir.as_deref().map(read_manifest).transpose()?;
    let data = std::env::var_os("BMT_GOLDEN_DATA").map(PathBuf::from);
    if let (Some(dir), Some(manifest)) = (&dir, &manifest) {
        let data = data
            .as_deref()
            .map_or("<unset>".into(), |d| d.display().to_string());
        require_recording_env(&manifest.recording, &replay_command(dir, &data))?;
        println!(
            "replaying in {} with {}",
            manifest.recording.tz(),
            manifest.recording.lang()
        );
    }
    let build_app = |host: Host| bmt_lib::app_builder(mock_builder(), host);

    let root = std::env::temp_dir().join(format!("bmt-golden-self-check-{}", std::process::id()));
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    use_data_root(&root);
    check_harness(&root)?;
    check_side_effects(&root)?;
    let stubs = check_every_channel(&build_app)?;
    check_hostile_arguments(&build_app)?;
    check_non_finite_arguments()?;
    check_comparison()?;
    check_sqlite_writer_version()?;
    check_clock_fields(dir.is_some())?;
    check_fixture_refusals(&root)?;
    check_replay_ratchet(&root)?;
    check_state_replay(&root)?;
    std::fs::remove_dir_all(&root).ok();
    println!(
        "self-check: a stub reads not ported, a wrong answer and a panic read fail, every channel takes its arguments, hostile ones included, and states replay in order or are skipped with their reason"
    );
    let mut failures = listed_stubs(&stubs, &ported);

    let (Some(dir), Some(manifest)) = (dir, manifest) else {
        // CI runs this with the recording's TZ set, to show SQLite reads it on
        // each platform before any replay depends on it
        let recording = Recording::from_manifest(&Value::Null);
        if std::env::var("TZ").ok() == Some(recording.tz()) {
            require_recording_env(
                &recording,
                "cargo test --features parity-driver --test golden",
            )?;
            println!(
                "self-check: SQLite reads TZ={} as {}, the recording's zone",
                recording.tz(),
                recording.time_zone
            );
        }
        println!(
            "behavior replay skipped: no goldens here. They are recorded locally on the fixture, whose release waits on the operator's decision E2, so this run checked the harness and the contract only. Set BMT_GOLDEN_DIR and BMT_GOLDEN_DATA to replay."
        );
        if !ported.is_empty() {
            println!(
                "tests/ported.txt lists {} channels, not replayed here",
                ported.len()
            );
        }
        return Ok(failures);
    };
    check_fixture(&manifest, &dir, data.as_deref())?;
    let goldens = read_goldens(&dir)?;
    let replayed = replay_goldens(
        &dir,
        &goldens,
        manifest.clock,
        data.as_deref(),
        &manifest.data,
        &registry,
        ported,
        &build_app,
    );
    let wire_problems = replayed
        .failures
        .iter()
        .filter(|f| f.starts_with("wire shape: "))
        .count();
    println!(
        "wire shapes: {} values Electron sent in {} cases read and write back {}",
        replayed.wire_values,
        goldens.len(),
        if wire_problems == 0 {
            "unchanged".to_string()
        } else {
            format!("with {wire_problems} differences")
        }
    );
    let mut counts: BTreeMap<Verdict, usize> = BTreeMap::new();
    println!("{:<30} {:<26} {:>5}  result", "channel", "method", "cases");
    for spec in &registry {
        let verdict = replayed.verdicts[spec.channel];
        *counts.entry(verdict).or_default() += 1;
        let n = replayed.cases.get(spec.channel).map_or(0, Vec::len);
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
    print_states(&replayed);
    failures.extend(replayed.failures);
    Ok(failures)
}

/// The states table: each replayed state with its launch, then each skipped
/// one with its reason.
fn print_states(replayed: &Replayed) {
    let launches: BTreeSet<usize> = replayed.states.iter().map(|s| s.launch).collect();
    println!(
        "states: {} replayed in order on {} launches, {} skipped",
        replayed.states.len(),
        launches.len(),
        replayed.skipped.len()
    );
    if !replayed.states.is_empty() {
        println!(
            "{:<38} {:>6} {:<9} {:>5}  result",
            "state", "launch", "data", "calls"
        );
    }
    for state in &replayed.states {
        let data = match state.data {
            states::Data::Recorded => "fixture",
            states::Data::Empty => "empty",
        };
        println!(
            "{:<38} {:>6} {:<9} {:>5}  {}",
            state.state,
            state.launch,
            data,
            state.calls,
            state.verdict.label()
        );
    }
    for skipped in &replayed.skipped {
        println!("skipped {}: {}", skipped.state, skipped.reason);
    }
    if !replayed.unnamed_state_cases.is_empty() {
        println!(
            "{} state cases are named by no state index, so no run places them, and are not replayed: {}",
            replayed.unnamed_state_cases.len(),
            replayed.unnamed_state_cases.join(", ")
        );
    }
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
