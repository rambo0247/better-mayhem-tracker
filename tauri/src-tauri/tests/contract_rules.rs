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

/// A piece of Rust source: one attribute, or the code between two of
/// `,` `;` `{` `}` outside brackets, with the line it starts on.
#[derive(Debug, PartialEq)]
enum Piece {
    Attr(String),
    Code(String),
}

/// Splits source into attributes and code by token rather than by line, so
/// `#[ts(optional)] pub x: T` on one line and an attribute spread over three
/// read the same as the usual layout. Comments are dropped; strings are kept
/// whole, so a `{` or `,` inside one splits nothing.
fn pieces(source: &str) -> Vec<(usize, Piece)> {
    let chars: Vec<char> = source.chars().collect();
    let mut out = Vec::new();
    let mut code = String::new();
    let mut code_line = 0;
    let (mut line, mut i) = (1, 0);
    let (mut brackets, mut angles) = (0_i32, 0_i32);
    let at = |i: usize, text: &str| {
        text.chars()
            .enumerate()
            .all(|(k, c)| chars.get(i + k) == Some(&c))
    };
    let flush = |code: &mut String, line: usize, out: &mut Vec<(usize, Piece)>| {
        if !code.trim().is_empty() {
            out.push((line, Piece::Code(code.trim().to_owned())));
        }
        code.clear();
    };
    while i < chars.len() {
        let c = chars[i];
        if at(i, "//") {
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
            }
            continue;
        }
        if at(i, "/*") {
            while i < chars.len() && !at(i, "*/") {
                line += usize::from(chars[i] == '\n');
                i += 1;
            }
            i += 2;
            continue;
        }
        if c == '"' {
            if code.trim().is_empty() {
                code_line = line;
            }
            code.push(c);
            i += 1;
            while i < chars.len() && chars[i] != '"' {
                if chars[i] == '\\' {
                    code.push(chars[i]);
                    i += 1;
                }
                line += usize::from(chars[i] == '\n');
                code.push(chars[i]);
                i += 1;
            }
            code.push('"');
            i += 1;
            continue;
        }
        if c == '#' && code.trim().is_empty() && (at(i + 1, "[") || at(i + 1, "![")) {
            let start = line;
            let mut attr = String::new();
            let mut depth = 0;
            let mut in_string = false;
            while i < chars.len() {
                let a = chars[i];
                attr.push(a);
                line += usize::from(a == '\n');
                i += 1;
                if in_string {
                    if a == '\\' && i < chars.len() {
                        attr.push(chars[i]);
                        i += 1;
                    } else if a == '"' {
                        in_string = false;
                    }
                    continue;
                }
                match a {
                    '"' => in_string = true,
                    '[' => depth += 1,
                    ']' => {
                        depth -= 1;
                        if depth == 0 {
                            break;
                        }
                    }
                    _ => {}
                }
            }
            let compact: String = attr.split_whitespace().collect::<Vec<_>>().join(" ");
            out.push((start, Piece::Attr(compact)));
            code.clear();
            continue;
        }
        match c {
            '(' | '[' => brackets += 1,
            ')' | ']' => brackets -= 1,
            '<' => angles += 1,
            '>' if !(code.ends_with('-') || code.ends_with('=')) => angles = (angles - 1).max(0),
            _ => {}
        }
        let splits = matches!(c, ';' | '{' | '}') || (c == ',' && brackets == 0 && angles == 0);
        if splits {
            flush(&mut code, code_line, &mut out);
            if c != ',' {
                angles = 0;
            }
        } else {
            if code.trim().is_empty() && !c.is_whitespace() {
                code_line = line;
            }
            code.push(c);
        }
        line += usize::from(c == '\n');
        i += 1;
    }
    flush(&mut code, code_line, &mut out);
    out
}

/// `#[ts(optional)]`, which prints `x?: T` with no `| null`. Its
/// `optional = nullable` form prints `x?: T | null`, which may send null.
fn is_optional(attrs: &str) -> bool {
    attrs.contains("ts(optional)") || attrs.contains("ts(optional,")
}

/// The type a `pub struct X` or `pub enum X` piece declares.
fn declared(code: &str) -> Option<String> {
    let rest = code
        .strip_prefix("pub struct ")
        .or_else(|| code.strip_prefix("pub enum "))?;
    Some(
        rest.split(|c: char| !c.is_alphanumeric() && c != '_')
            .next()
            .unwrap_or_default()
            .to_owned(),
    )
}

/// The field a `[pub] name: Type` piece declares.
fn field_name(code: &str) -> Option<&str> {
    let code = code.strip_prefix("pub ").unwrap_or(code);
    let (name, _) = code.split_once(':')?;
    let ident = !name.is_empty() && name.chars().all(|c| c.is_alphanumeric() || c == '_');
    (ident && !code[name.len()..].starts_with("::")).then_some(name)
}

/// Wire-shape problems in one file's source.
fn wire_problems(file: &str, source: &str) -> Vec<String> {
    let mut problems: Vec<(usize, String)> = Vec::new();
    for (n, line) in source.lines().enumerate() {
        let code = line.trim();
        if code.starts_with("//") {
            continue;
        }
        for pattern in WIRE_OVERRIDES {
            if code.contains(pattern) {
                problems.push((
                    n + 1,
                    format!(
                        "{file}:{}: `{pattern}` writes a wire shape the bindings do not show",
                        n + 1
                    ),
                ));
            }
        }
    }
    let mut owner = String::new();
    let mut attrs = String::new();
    for (line, piece) in pieces(source) {
        let code = match piece {
            Piece::Attr(attr) => {
                attrs.push_str(&attr);
                continue;
            }
            Piece::Code(code) => code,
        };
        if let Some(name) = declared(&code) {
            owner = name;
        }
        if let Some(field) = field_name(&code)
            && is_optional(&attrs)
            && !attrs.contains("skip_serializing_if")
            && !NULL_ON_THE_WIRE.contains(&format!("{owner}.{field}").as_str())
        {
            problems.push((
                line,
                format!(
                    "{file}:{line}: {owner}.{field} is `?:` in the bindings but sent as null; add skip_serializing_if or list it in NULL_ON_THE_WIRE"
                ),
            ));
        }
        attrs.clear();
    }
    problems.sort();
    problems.into_iter().map(|(_, problem)| problem).collect()
}

fn optional_owners(source: &str) -> BTreeSet<String> {
    let mut owners = BTreeSet::new();
    let mut owner = String::new();
    for (_, piece) in pieces(source) {
        match piece {
            Piece::Code(code) => {
                if let Some(name) = declared(&code) {
                    owner = name;
                }
            }
            Piece::Attr(attr) if is_optional(&attr) => {
                owners.insert(owner.clone());
            }
            Piece::Attr(_) => {}
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
pub struct Layouts {
    #[ts(optional)] pub same_line: Option<i64>,
    #[serde(
        skip_serializing_if = "Option::is_none"
    )]
    #[ts(optional)]
    pub split_attribute: Option<i64>,
    // #[ts(optional)]
    pub commented: Option<i64>,
}
"#;
    let problems = wire_problems("row.rs", source);
    let lines: Vec<&str> = problems
        .iter()
        .map(|p| p.split(": ").next().unwrap_or_default())
        .collect();
    assert_eq!(
        lines,
        [
            "row.rs:4",
            "row.rs:8",
            "row.rs:10",
            "row.rs:13",
            "row.rs:19"
        ],
        "{problems:#?}"
    );
    assert_eq!(
        optional_owners(source),
        BTreeSet::from([
            "GameRecord".to_owned(),
            "Layouts".to_owned(),
            "Row".to_owned()
        ])
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

/// The parameters of each `pub async fn` under `commands/`, by function name.
fn body_parameters() -> Vec<(String, String, Vec<String>)> {
    let mut out = Vec::new();
    for (path, source) in contract_sources() {
        let mut rest = source.as_str();
        while let Some(at) = rest.find("pub async fn ") {
            rest = &rest[at + "pub async fn ".len()..];
            let name: String = rest
                .chars()
                .take_while(|c| c.is_alphanumeric() || *c == '_')
                .collect();
            let Some(open) = rest.find('(') else { break };
            let mut depth = 0;
            let mut close = open;
            for (i, c) in rest[open..].char_indices() {
                depth += match c {
                    '(' | '<' => 1,
                    ')' | '>' => -1,
                    _ => 0,
                };
                if depth == 0 {
                    close = open + i;
                    break;
                }
            }
            let mut params = Vec::new();
            let mut depth = 0;
            let mut current = String::new();
            for c in rest[open + 1..close].chars() {
                match c {
                    '(' | '<' => depth += 1,
                    ')' | '>' => depth -= 1,
                    ',' if depth == 0 => {
                        params.push(std::mem::take(&mut current));
                        continue;
                    }
                    _ => {}
                }
                current.push(c);
            }
            params.push(current);
            let names = params
                .iter()
                .filter_map(|p| p.split_once(':').map(|(n, _)| n.trim()))
                .map(|n| {
                    n.trim_start_matches("mut ")
                        .trim_start_matches('_')
                        .to_owned()
                })
                .collect();
            out.push((path.display().to_string(), name, names));
        }
    }
    out
}

/// `contract!` hands a body its arguments by position, so a body that names
/// two same-typed parameters in the other order compiles and swaps them.
#[test]
fn each_body_names_its_parameters_as_the_contract_does() {
    let bodies = body_parameters();
    for command in bmt_lib::commands::registry() {
        let found: Vec<_> = bodies
            .iter()
            .filter(|(_, name, _)| {
                heck::ToLowerCamelCase::to_lower_camel_case(name.as_str()) == command.method
            })
            .collect();
        assert_eq!(
            found.len(),
            1,
            "{}: one body under commands/",
            command.method
        );
        let (file, name, params) = found[0];
        let mut want = vec!["ctx".to_owned()];
        want.extend(command.args.iter().map(|a| a.name.to_owned()));
        assert_eq!(
            params, &want,
            "{file}: {name}'s parameters, against its contract entry"
        );
    }
}

/// `cargo test` never builds the release profile, where lib.rs's
/// `compile_error!` would catch an aborting build, so the manifest is read.
#[test]
fn release_builds_unwind_so_a_panicking_command_rejects() {
    let manifest =
        std::fs::read_to_string(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml"))
            .expect("read Cargo.toml");
    let release = manifest
        .split("\n[")
        .find(|section| section.starts_with("profile.release]"))
        .expect("a [profile.release] section");
    let panic: Vec<&str> = release
        .lines()
        .map(str::trim)
        .filter(|line| line.starts_with("panic"))
        .collect();
    assert_eq!(panic, ["panic = \"unwind\""], "[profile.release] panic");
}
