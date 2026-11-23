//! Replays every T05 IPC golden (`parity/goldens/FORMAT.md`) against the Rust
//! commands through Tauri's real IPC path, and prints one row per channel:
//! `pass`, `fail`, or `not ported`. It fails only on `fail`, so each porting
//! unit moves its channels from `not ported` to `pass`.
//!
//! The goldens are recorded locally and never committed. `BMT_GOLDEN_DIR`
//! names them, defaulting to `parity/out/golden`. `BMT_GOLDEN_DATA` names a
//! data folder from `parity/fixture.ts`, copied fresh for each group of cases.
//! Without goldens every row reads `no golden` and only the self-check runs.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use bmt_lib::commands::{self, Clock, CommandSpec};
use serde_json::{Map, Number, Value};
use tauri::test::{INVOKE_KEY, MockRuntime, mock_builder, mock_context, noop_assets};
use tauri::webview::InvokeRequest;
use tauri::{WebviewWindow, WebviewWindowBuilder};

/// `CLOCK_FIELDS` in `parity/canon.ts`, which the self-check keeps in step.
const CLOCK_FIELDS: &[&str] = &[];
const CLOCK_MARK: &str = "<clock>";
const UNREGISTERED_CHANNEL: &str = "bmt:unregistered-channel";

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
}

impl Golden {
    fn parse(value: Value) -> Result<Self, String> {
        let field = |name: &str| value.get(name).cloned().ok_or(format!("no `{name}`"));
        let text = |name: &str| field(name)?.as_str().map(str::to_owned).ok_or(format!("`{name}` is not text"));
        Ok(Self {
            channel: text("channel")?,
            case: text("case")?,
            group: text("group")?,
            seq: field("seq")?.as_i64().ok_or("`seq` is not a number")?,
            args: field("args")?.as_array().cloned().ok_or("`args` is not a list")?,
            outcome: field("outcome")?,
        })
    }
}

/// `canon.ts`: keys sorted at every depth, numbers as the values they parse to,
/// clock fields masked. `serde_json` writes `3.0` where JavaScript writes `3`,
/// so every number becomes its f64 before printing.
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
            Value::Object(sorted.into_iter().map(|(k, v)| (k.clone(), v)).collect::<Map<_, _>>())
        }
        Value::Array(items) => Value::Array(items.iter().map(canonical).collect()),
        Value::Number(n) => n
            .as_f64()
            .and_then(Number::from_f64)
            .map_or_else(|| value.clone(), Value::Number),
        other => other.clone(),
    }
}

fn same(a: &Value, b: &Value) -> bool {
    canonical(a) == canonical(b)
}

/// What the command answered: its JSON, or what it rejected with.
type Answer = Result<Value, Value>;

fn is_not_ported(rejection: &Value) -> bool {
    rejection.get("code").and_then(Value::as_str) == Some("NOT_PORTED")
}

fn classify(outcome: &Value, answer: &Answer) -> Verdict {
    if let Err(rejection) = answer {
        if is_not_ported(rejection) {
            return Verdict::NotPorted;
        }
    }
    let kind = outcome.get("kind").and_then(Value::as_str);
    let matched = match (kind, answer) {
        (Some("value"), Ok(value)) => outcome.get("result").is_some_and(|r| same(r, value)),
        // Electron resolves a void handler with undefined, Tauri with null
        (Some("void"), Ok(value)) => value.is_null(),
        (Some("error"), Err(rejection)) => {
            rejection.get("name") == outcome.get("name") && rejection.get("message") == outcome.get("message")
        }
        _ => false,
    };
    if matched { Verdict::Pass } else { Verdict::Fail }
}

fn mock_window(builder: tauri::Builder<MockRuntime>) -> (tauri::App<MockRuntime>, WebviewWindow<MockRuntime>) {
    let app = builder.build(mock_context(noop_assets())).expect("build the mock app");
    let window = WebviewWindowBuilder::new(&app, bmt_lib::WINDOW_LABEL, Default::default())
        .build()
        .expect("build the mock main window");
    (app, window)
}

fn call(window: &WebviewWindow<MockRuntime>, channel: &str, body: Map<String, Value>) -> Answer {
    let request = InvokeRequest {
        cmd: channel.into(),
        callback: tauri::ipc::CallbackFn(0),
        error: tauri::ipc::CallbackFn(1),
        url: "tauri://localhost".parse().expect("a valid URL"),
        body: tauri::ipc::InvokeBody::Json(Value::Object(body)),
        headers: Default::default(),
        invoke_key: INVOKE_KEY.to_string(),
    };
    tauri::test::get_ipc_response(window, request).map(|body| {
        body.deserialize::<Value>().expect("a JSON response")
    })
}

fn replay(window: &WebviewWindow<MockRuntime>, spec: &CommandSpec, golden: &Golden) -> (Verdict, Answer) {
    let answer = call(window, spec.channel, spec.named_args(&golden.args));
    (classify(&golden.outcome, &answer), answer)
}

fn read_goldens(dir: &Path) -> Vec<Golden> {
    let mut out = Vec::new();
    let Ok(channels) = std::fs::read_dir(dir.join("ipc")) else {
        return out;
    };
    for channel in channels.flatten() {
        for file in std::fs::read_dir(channel.path()).into_iter().flatten().flatten() {
            if file.path().extension().is_none_or(|e| e != "json") {
                continue;
            }
            let text = std::fs::read_to_string(file.path()).expect("read a golden");
            let value: Value = serde_json::from_str(&text).expect("a golden is JSON");
            out.push(Golden::parse(value).unwrap_or_else(|e| panic!("{}: {e}", file.path().display())));
        }
    }
    out.sort_by(|a, b| (&a.group, a.seq, &a.channel).cmp(&(&b.group, b.seq, &b.channel)));
    out
}

/// `fixedTime` from the manifest, `YYYY-MM-DDTHH:MM:SS.mmmZ`, in epoch ms.
fn parse_fixed_time(text: &str) -> Option<i64> {
    let num = |range: std::ops::Range<usize>| text.get(range)?.parse::<i64>().ok();
    let (y, m, d) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (hh, mm, ss) = (num(11..13)?, num(14..16)?, num(17..19)?);
    let ms = if text.get(19..20) == Some(".") { num(20..23)? } else { 0 };
    // Days from the civil date, Howard Hinnant's algorithm
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(((days * 24 + hh) * 60 + mm) * 60_000 + ss * 1000 + ms)
}

fn fixed_clock(dir: &Path) -> Clock {
    let manifest = std::fs::read_to_string(dir.join("manifest.json")).ok();
    let fixed = manifest
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|m| m.get("fixedTime").and_then(Value::as_str).and_then(parse_fixed_time));
    fixed.map_or(Clock::System, Clock::Fixed)
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

/// A fresh data folder for one group of cases, and the app built over it.
fn group_app(scratch: &Path, group: &str, data: Option<&Path>, clock: Clock) -> (tauri::App<MockRuntime>, WebviewWindow<MockRuntime>) {
    let root = scratch.join(group);
    match data {
        Some(data) => copy_dir(data, &root),
        None => std::fs::create_dir_all(&root).expect("create the data folder"),
    }
    // SAFETY: only this thread runs code that reads the environment here: the
    // previous group's app is dropped and the next is not built yet
    unsafe { std::env::set_var("BMT_DATA_ROOT", &root) };
    mock_window(bmt_lib::app_builder(mock_builder(), clock))
}

fn self_check() -> Result<(), String> {
    let expect = |label: &str, got: Verdict, want: Verdict| {
        if got == want { Ok(()) } else { Err(format!("self-check {label}: {} where {} was expected", got.label(), want.label())) }
    };
    let version = Golden::parse(serde_json::json!({
        "channel": "app:version", "case": "hand-made", "group": "read", "seq": 0, "args": [],
        "outcome": { "kind": "value", "result": "1.2.1" }
    }))?;
    let registry = commands::registry();
    let spec = registry.iter().find(|c| c.channel == "app:version").ok_or("app:version is not registered")?;

    // The real stub answers not ported
    let (_app, window) = mock_window(bmt_lib::app_builder(mock_builder(), Clock::System));
    expect("stub", replay(&window, spec, &version).0, Verdict::NotPorted)?;

    // The same stub answering wrong is a failure, not "not ported"
    #[tauri::command(rename = "app:version")]
    async fn wrong_version() -> Result<String, ()> {
        Ok("0.0.0".into())
    }
    let (_wrong_app, wrong) = mock_window(mock_builder().invoke_handler(tauri::generate_handler![wrong_version]));
    expect("wrong answer", replay(&wrong, spec, &version).0, Verdict::Fail)?;

    expect("equal value", classify(&version.outcome, &Ok(Value::from("1.2.1"))), Verdict::Pass)?;
    let number = serde_json::json!({ "kind": "value", "result": { "b": 3, "a": [0.30000000000000004] } });
    let answer = serde_json::from_str::<Value>(r#"{ "a": [0.30000000000000004], "b": 3.0 }"#).map_err(|e| e.to_string())?;
    expect("3 against 3.0, keys unordered", classify(&number, &Ok(answer)), Verdict::Pass)?;
    expect("void against null", classify(&serde_json::json!({ "kind": "void" }), &Ok(Value::Null)), Verdict::Pass)?;
    expect("void against a value", classify(&serde_json::json!({ "kind": "void" }), &Ok(Value::from(1))), Verdict::Fail)?;
    let thrown = serde_json::json!({ "kind": "error", "name": "Error", "message": "boom", "invokeMessage": "" });
    expect("same error", classify(&thrown, &Err(serde_json::json!({ "name": "Error", "message": "boom" }))), Verdict::Pass)?;
    expect("other error", classify(&thrown, &Err(serde_json::json!({ "name": "Error", "message": "bang" }))), Verdict::Fail)?;

    if parse_fixed_time("2026-11-23T02:00:00.000Z") != Some(1_795_399_200_000) {
        return Err("self-check fixedTime: wrong epoch".into());
    }
    let canon = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../parity/canon.ts");
    if let Ok(source) = std::fs::read_to_string(&canon) {
        let start = source.find("CLOCK_FIELDS").and_then(|i| source[i..].find("new Set<string>([").map(|j| i + j));
        if let Some(start) = start {
            let rest = &source[start + "new Set<string>([".len()..];
            let list = &rest[..rest.find("])").unwrap_or(0)];
            let names: Vec<&str> = list.split(',').map(|s| s.trim().trim_matches('"')).filter(|s| !s.is_empty()).collect();
            if names != CLOCK_FIELDS {
                return Err(format!("self-check: canon.ts CLOCK_FIELDS is {names:?}, golden.rs has {CLOCK_FIELDS:?}"));
            }
        }
    }
    Ok(())
}

fn main() -> ExitCode {
    if let Err(problem) = self_check() {
        eprintln!("{problem}");
        return ExitCode::FAILURE;
    }
    println!("self-check: a wrong answer reads fail, a stub reads not ported");

    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let dir = std::env::var_os("BMT_GOLDEN_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| manifest_dir.join("../../parity/out/golden"));
    let data = std::env::var_os("BMT_GOLDEN_DATA").map(PathBuf::from);
    let goldens = read_goldens(&dir);
    let registry = commands::registry();
    let mut verdicts: BTreeMap<&str, Vec<(String, Verdict)>> = BTreeMap::new();
    let mut failures = Vec::new();

    if goldens.is_empty() {
        println!("no goldens at {}; set BMT_GOLDEN_DIR to replay them", dir.display());
    } else {
        let clock = fixed_clock(&dir);
        let scratch = std::env::temp_dir().join(format!("bmt-golden-{}", std::process::id()));
        let mut groups: BTreeMap<&str, Vec<&Golden>> = BTreeMap::new();
        for golden in &goldens {
            groups.entry(golden.group.as_str()).or_default().push(golden);
        }
        for (group, cases) in groups {
            let (app, window) = group_app(&scratch, group, data.as_deref(), clock);
            for golden in cases {
                if golden.channel == UNREGISTERED_CHANNEL {
                    let answer = call(&window, &golden.channel, Map::new());
                    println!("{UNREGISTERED_CHANNEL}: rejected with {answer:?}; src/api.ts maps it to Electron's message");
                    continue;
                }
                let Some(spec) = registry.iter().find(|c| c.channel == golden.channel) else {
                    failures.push(format!("{} {}: a golden for a channel the contract lacks", golden.channel, golden.case));
                    continue;
                };
                let (verdict, answer) = replay(&window, spec, golden);
                if verdict == Verdict::Fail {
                    failures.push(format!("{} {}: expected {}, got {answer:?}", golden.channel, golden.case, golden.outcome));
                }
                verdicts.entry(spec.channel).or_default().push((golden.case.clone(), verdict));
            }
            drop(window);
            drop(app);
        }
        std::fs::remove_dir_all(&scratch).ok();
    }

    let mut counts: BTreeMap<Verdict, usize> = BTreeMap::new();
    println!("{:<30} {:<26} {:>5}  result", "channel", "method", "cases");
    for spec in &registry {
        let cases = verdicts.get(spec.channel).map(Vec::as_slice).unwrap_or_default();
        // A channel passes only when every case does, and any unported case leaves it unported
        let verdict = if cases.is_empty() {
            Verdict::NoGolden
        } else if cases.iter().any(|(_, v)| *v == Verdict::Fail) {
            Verdict::Fail
        } else if cases.iter().any(|(_, v)| *v == Verdict::NotPorted) {
            Verdict::NotPorted
        } else {
            Verdict::Pass
        };
        *counts.entry(verdict).or_default() += 1;
        println!("{:<30} {:<26} {:>5}  {}", spec.channel, spec.method, cases.len(), verdict.label());
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
    for failure in &failures {
        eprintln!("fail: {failure}");
    }
    if failures.is_empty() { ExitCode::SUCCESS } else { ExitCode::FAILURE }
}
