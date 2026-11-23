//! The per-state call lists T05's `record-states.ts` writes as
//! `states/<state>.json`, planned the way they were recorded. Electron ran
//! every non-client state of `parity/states.ts`'s `STATES` in order on one
//! launch, so a setting one state wrote is what the next one read; a state
//! with its own `data` got a fresh launch on it; each client state ran alone
//! against T03's fake client. The index records neither the order nor the
//! data, so both come from the `states.ts` of the checkout that recorded the
//! goldens, `parity/states.ts` beside `parity/out/golden`.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde_json::Value;

/// `getMatchHistory(1, 0)`, `getSeasons()`, `getTeammateStats()`,
/// `getTeammateGroups()` and `getChampionStats()`: `resolveVars`' reads, which
/// run once per launch before any state and are in no state's list. Replay
/// answers them by arguments alone (FORMAT.md, per-state call lists).
pub const RESOLVE_VARS: &[(&str, &[i64])] = &[
    ("db:match-history", &[1, 0]),
    ("db:seasons", &[]),
    ("db:teammate-stats", &[]),
    ("db:teammate-groups", &[]),
    ("db:champion-stats", &[]),
];

#[derive(Debug, Clone)]
pub struct Call {
    pub seq: i64,
    pub channel: String,
    pub args: Vec<Value>,
    pub case: String,
}

#[derive(Debug, Clone)]
pub struct StateIndex {
    pub state: String,
    pub group: String,
    /// In `seq` order, whatever order the file lists them in.
    pub calls: Vec<Call>,
    pub error: Option<String>,
}

impl StateIndex {
    fn parse(value: &Value) -> Result<Self, String> {
        let text = |v: &Value, name: &str| {
            v.get(name)
                .and_then(Value::as_str)
                .map(str::to_owned)
                .ok_or(format!("no text `{name}`"))
        };
        let mut calls = value
            .get("calls")
            .and_then(Value::as_array)
            .ok_or("no `calls` list")?
            .iter()
            .map(|call| {
                Ok(Call {
                    seq: call
                        .get("seq")
                        .and_then(Value::as_i64)
                        .ok_or("a call has no `seq`")?,
                    channel: text(call, "channel")?,
                    args: call
                        .get("args")
                        .and_then(Value::as_array)
                        .cloned()
                        .ok_or("a call has no `args`")?,
                    case: text(call, "case")?,
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        calls.sort_by_key(|call| call.seq);
        Ok(Self {
            state: text(value, "state")?,
            group: text(value, "group")?,
            calls,
            error: value
                .get("error")
                .and_then(Value::as_str)
                .map(str::to_owned),
        })
    }
}

/// Every `states/<state>.json` under the goldens, none when there is no folder.
pub fn read_indexes(dir: &Path) -> Result<Vec<StateIndex>, String> {
    let folder = dir.join("states");
    if !folder.is_dir() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&folder).map_err(|e| format!("{}: {e}", folder.display()))? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.extension().is_none_or(|e| e != "json") {
            continue;
        }
        let read = std::fs::read_to_string(&path)
            .map_err(|e| e.to_string())
            .and_then(|text| serde_json::from_str::<Value>(&text).map_err(|e| e.to_string()))
            .and_then(|value| StateIndex::parse(&value));
        out.push(read.map_err(|e| format!("{}: {e}", path.display()))?);
    }
    out.sort_by(|a, b| a.state.cmp(&b.state));
    Ok(out)
}

/// A row of `STATES`, in the order Electron ran it.
#[derive(Debug, Clone, PartialEq)]
pub struct Row {
    pub id: String,
    /// The data source the row names in place of the run's, as `data: "empty"`.
    pub data: Option<String>,
}

/// The `states.ts` beside the goldens, where `record-states.ts` read it.
pub fn states_ts(dir: &Path) -> Option<PathBuf> {
    Some(dir.parent()?.parent()?.join("states.ts"))
}

/// The `row("<id>", ...)` calls of `export const STATES`, in source order,
/// each with the `data: "<name>"` its options carry. Client rows are built
/// by `clientRow` in `states-client.ts` and are not among them.
pub fn parse_rows(source: &str) -> Result<Vec<Row>, String> {
    const START: &str = "export const STATES";
    let start = source.find(START).ok_or(format!("no `{START}`"))?;
    let body = &source[start..];
    let body = &body[..body.find("\n];").ok_or("`STATES` has no closing `\\n];`")?];
    let opens: Vec<usize> = body
        .match_indices("row(")
        .map(|(i, _)| i)
        .filter(|&i| {
            !body[..i]
                .chars()
                .next_back()
                .is_some_and(|c| c.is_alphanumeric() || c == '_')
        })
        .collect();
    let mut rows: Vec<Row> = Vec::new();
    for (n, &open) in opens.iter().enumerate() {
        let span = &body[open + 4..opens.get(n + 1).copied().unwrap_or(body.len())];
        let id = span
            .trim_start()
            .strip_prefix('"')
            .and_then(|rest| rest.split_once('"'))
            .map(|(id, _)| id)
            .filter(|id| {
                !id.is_empty()
                    && id
                        .chars()
                        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
            })
            .ok_or(format!(
                "a `row(` whose first argument is not a state id: {span:.40?}"
            ))?;
        if rows.iter().any(|row| row.id == id) {
            return Err(format!("state {id} is in `STATES` twice"));
        }
        let data = span
            .find("data: \"")
            .map(|at| &span[at + 7..])
            .and_then(|rest| rest.split_once('"'))
            .map(|(name, _)| name.to_owned());
        rows.push(Row {
            id: id.to_owned(),
            data,
        });
    }
    if rows.is_empty() {
        return Err("`STATES` has no `row(` calls".into());
    }
    Ok(rows)
}

/// The data a launch runs on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Data {
    /// The fixture the manifest names, `BMT_GOLDEN_DATA`.
    Recorded,
    /// An empty data folder, in which the app makes its own database.
    Empty,
}

/// One Electron launch: its data and the states it ran, in order.
#[derive(Debug)]
pub struct Launch {
    pub data: Data,
    pub states: Vec<StateIndex>,
}

#[derive(Debug, PartialEq)]
pub struct Skipped {
    pub state: String,
    pub reason: String,
}

#[derive(Debug, Default)]
pub struct Plan {
    pub launches: Vec<Launch>,
    pub skipped: Vec<Skipped>,
}

/// Lays the recorded states out as `record-states.ts` ran them. `rows` is
/// `STATES`, or why it could not be read; `recorded` is the manifest's data
/// name. A state replay cannot reproduce is skipped with its reason.
pub fn plan(rows: Result<Vec<Row>, String>, indexes: Vec<StateIndex>, recorded: &str) -> Plan {
    let mut out = Plan::default();
    let mut skip = |state: &str, reason: String| {
        out.skipped.push(Skipped {
            state: state.to_owned(),
            reason,
        })
    };
    let mut pending: BTreeMap<String, StateIndex> = BTreeMap::new();
    for index in indexes {
        if index.group == "client" {
            skip(
                &index.state,
                "a client state: Electron ran it alone against T03's fake League client, which golden replay does not run".into(),
            );
        } else if let Some(error) = &index.error {
            skip(
                &index.state,
                format!("Electron never reached its page: {error}"),
            );
        } else {
            pending.insert(index.state.clone(), index);
        }
    }
    let rows = match rows {
        Ok(rows) => rows,
        Err(reason) => {
            for state in pending.keys() {
                skip(
                    state,
                    format!("the order and data the states ran in are unknown: {reason}"),
                );
            }
            return out;
        }
    };
    let mut launches: Vec<Launch> = Vec::new();
    let mut current: Option<String> = None;
    let mut unknown: Option<String> = None;
    for row in rows {
        let name = row.data.clone().unwrap_or_else(|| recorded.to_owned());
        if current.as_deref() != Some(name.as_str()) {
            current = Some(name.clone());
            unknown = None;
            let data = if name == recorded {
                Some(Data::Recorded)
            } else if name == "empty" {
                Some(Data::Empty)
            } else {
                None
            };
            if let Some(data) = data {
                launches.push(Launch {
                    data,
                    states: Vec::new(),
                });
            } else {
                unknown = Some(format!(
                    "it ran on data `{name}`, which replay cannot make (it makes `{recorded}` from BMT_GOLDEN_DATA and `empty`)"
                ));
            }
        }
        let Some(index) = pending.remove(&row.id) else {
            unknown.get_or_insert(format!(
                "{} ran before it on its launch and has no states/{}.json, so what it wrote is unknown",
                row.id, row.id
            ));
            continue;
        };
        match &unknown {
            Some(reason) => skip(&index.state, reason.clone()),
            None => launches
                .last_mut()
                .expect("a launch for the current data")
                .states
                .push(index),
        }
    }
    for state in pending.keys() {
        skip(
            state,
            "not a row of STATES in states.ts, so its order and data are unknown".into(),
        );
    }
    out.launches = launches
        .into_iter()
        .filter(|l| !l.states.is_empty())
        .collect();
    out
}
