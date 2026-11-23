//! Rules on the contract's Rust source that the TypeScript check cannot see,
//! because they change the wire without changing the bindings.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use bmt_lib::commands::app::{DownloadUpdateResult, UpdateInfo};
use bmt_lib::commands::backup::{
    CreateBackupResult, RecoveryProblem, RecoveryReport, RestoreBackupResult,
};
use bmt_lib::commands::data::{ExportDataResult, ImportDataResult};
use bmt_lib::commands::dragon::ChampionEntry;
use bmt_lib::commands::export::{CardSpec, CopyCardResult, ExportCardResult};
use bmt_lib::commands::matches::MatchFilters;
use bmt_lib::commands::types::{GameRecord, MatchScope};
use serde::Serialize;

/// `?:` fields that are present on the wire even when empty: rows read from
/// SQLite carry every column, so Electron sends them as `null`.
const NULL_ON_THE_WIRE: &[&str] = &[
    "GameRecord.puuid",
    "GameRecord.is_remake",
    "GameRecord.favorite",
];

/// Attributes that print one type and serialize another.
const WIRE_OVERRIDES: &[&str] = &["#[ts(type", "#[ts(as", "serialize_with", "Serialize for"];

fn contract_sources() -> Vec<(PathBuf, String)> {
    fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
        for entry in std::fs::read_dir(dir)
            .expect("read a source folder")
            .flatten()
        {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, out);
            } else if path.extension().is_some_and(|e| e == "rs") {
                out.push(path);
            }
        }
    }
    let src = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = vec![src.join("events.rs")];
    walk(&src.join("commands"), &mut files);
    files.sort();
    files
        .into_iter()
        .map(|path| {
            let text = std::fs::read_to_string(&path).expect("read a source file");
            (path, text)
        })
        .collect()
}

/// Wire-shape problems in one file's source.
fn wire_problems(file: &str, source: &str) -> Vec<String> {
    let mut problems = Vec::new();
    let mut owner = String::new();
    let mut attrs = String::new();
    for (n, line) in source.lines().enumerate() {
        let code = line.trim();
        if code.starts_with("//") {
            continue;
        }
        for pattern in WIRE_OVERRIDES {
            if code.contains(pattern) {
                problems.push(format!(
                    "{file}:{}: `{pattern}` writes a wire shape the bindings do not show",
                    n + 1
                ));
            }
        }
        if let Some(rest) = code
            .strip_prefix("pub struct ")
            .or_else(|| code.strip_prefix("pub enum "))
        {
            owner = rest
                .split(|c: char| !c.is_alphanumeric() && c != '_')
                .next()
                .unwrap_or_default()
                .to_owned();
        }
        if code.starts_with("#[") {
            attrs.push_str(code);
            continue;
        }
        let field = code
            .strip_prefix("pub ")
            .unwrap_or(code)
            .split(':')
            .next()
            .unwrap_or_default();
        let is_field = code.contains(':') && !field.contains(' ') && !field.is_empty();
        if is_field
            && attrs.contains("#[ts(optional)]")
            && !attrs.contains("skip_serializing_if")
            && !NULL_ON_THE_WIRE.contains(&format!("{owner}.{field}").as_str())
        {
            problems.push(format!(
                "{file}:{}: {owner}.{field} is `?:` in the bindings but sent as null; add skip_serializing_if or list it in NULL_ON_THE_WIRE",
                n + 1
            ));
        }
        attrs.clear();
    }
    problems
}

fn optional_owners(source: &str) -> BTreeSet<String> {
    let mut owners = BTreeSet::new();
    let mut owner = String::new();
    for line in source.lines() {
        let code = line.trim();
        if let Some(rest) = code
            .strip_prefix("pub struct ")
            .or_else(|| code.strip_prefix("pub enum "))
        {
            owner = rest
                .split(|c: char| !c.is_alphanumeric() && c != '_')
                .next()
                .unwrap_or_default()
                .to_owned();
        }
        if code.starts_with("#[ts(optional)]") {
            owners.insert(owner.clone());
        }
    }
    owners
}

#[test]
fn no_attribute_writes_a_shape_the_bindings_hide() {
    let problems: Vec<String> = contract_sources()
        .iter()
        .flat_map(|(path, source)| wire_problems(&path.display().to_string(), source))
        .collect();
    assert!(problems.is_empty(), "{}", problems.join("\n"));
}

#[test]
fn the_source_rules_catch_each_override() {
    let source = r#"
pub struct Row {
    #[ts(optional)]
    pub missing_skip: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub fine: Option<i64>,
    #[ts(type = "number")]
    pub typed: String,
    #[serde(serialize_with = "as_text")]
    pub text: i64,
}
impl Serialize for Row {}
pub struct GameRecord {
    #[ts(optional)]
    pub puuid: Option<String>,
}
"#;
    let problems = wire_problems("row.rs", source);
    let lines: Vec<&str> = problems
        .iter()
        .map(|p| p.split(": ").next().unwrap_or_default())
        .collect();
    assert_eq!(
        lines,
        ["row.rs:4", "row.rs:8", "row.rs:10", "row.rs:13"],
        "{problems:#?}"
    );
}

fn keys<T: Serialize>(value: &T) -> Vec<String> {
    match serde_json::to_value(value).expect("serialize") {
        serde_json::Value::Object(map) => map.keys().cloned().collect(),
        other => panic!("not an object: {other}"),
    }
}

/// Every struct with a `?:` field, built with each one `None`, and the keys
/// Electron sends for it.
#[test]
fn optional_fields_left_empty_are_absent_from_the_wire() {
    let cases: Vec<(&str, Vec<String>, &[&str])> = vec![
        ("UpdateInfo", keys(&UpdateInfo::default()), &["hasUpdate"]),
        (
            "DownloadUpdateResult",
            keys(&DownloadUpdateResult {
                success: false,
                error: None,
            }),
            &["success"],
        ),
        (
            "ChampionEntry",
            keys(&ChampionEntry {
                name: "Ahri".into(),
                key: "103".into(),
                class: None,
            }),
            &["key", "name"],
        ),
        (
            "ExportDataResult",
            keys(&ExportDataResult {
                success: false,
                path: None,
                games: None,
                error: None,
            }),
            &["success"],
        ),
        (
            "ImportDataResult",
            keys(&ImportDataResult {
                success: false,
                imported: None,
                error: None,
            }),
            &["success"],
        ),
        (
            "CreateBackupResult",
            keys(&CreateBackupResult {
                success: false,
                backup: None,
                error: None,
            }),
            &["success"],
        ),
        (
            "RestoreBackupResult",
            keys(&RestoreBackupResult {
                success: false,
                games: None,
                error: None,
            }),
            &["success"],
        ),
        (
            "RecoveryReport",
            keys(&RecoveryReport {
                problem: RecoveryProblem::Missing,
                restored_from: None,
                quarantined: None,
                detail: None,
            }),
            &["problem", "quarantined", "restoredFrom"],
        ),
        (
            "CardSpec",
            keys(&CardSpec::Season {
                season_id: "s1".into(),
                queue: None,
                account: None,
                hide_friends: None,
            }),
            &["kind", "seasonId"],
        ),
        (
            "ExportCardResult",
            keys(&ExportCardResult {
                success: false,
                path: None,
                error: None,
            }),
            &["success"],
        ),
        (
            "CopyCardResult",
            keys(&CopyCardResult {
                success: false,
                error: None,
            }),
            &["success"],
        ),
        ("MatchFilters", keys(&MatchFilters::default()), &[]),
        ("MatchScope", keys(&MatchScope::default()), &[]),
        (
            "GameRecord",
            keys(&GameRecord {
                game_id: 1,
                queue_id: 2400,
                game_mode: "KIWI".into(),
                game_creation: 0,
                game_duration: 0,
                puuid: None,
                game_version: None,
                is_remake: None,
                favorite: None,
            }),
            &[
                "favorite",
                "game_creation",
                "game_duration",
                "game_id",
                "game_mode",
                "game_version",
                "is_remake",
                "puuid",
                "queue_id",
            ],
        ),
    ];
    for (name, mut got, want) in cases.iter().cloned() {
        got.sort();
        assert_eq!(got, want, "{name}");
    }
    let tested: BTreeSet<String> = cases
        .iter()
        .map(|(name, _, _)| (*name).to_owned())
        .collect();
    let owners: BTreeSet<String> = contract_sources()
        .iter()
        .flat_map(|(_, source)| optional_owners(source))
        .collect();
    assert_eq!(
        owners, tested,
        "every type with a `?:` field has a case here"
    );
}
