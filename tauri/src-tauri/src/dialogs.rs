//! The save and open dialogs export and import show: the OS's, through
//! tauri-plugin-dialog, or answers set ahead, so golden replay and parity
//! lanes never open one. A scripted dialog records what it was asked to
//! show in the shape Electron's seam records `dialog.showSaveDialog` and
//! `dialog.showOpenDialog`.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{Runtime, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FileFilter {
    pub name: String,
    pub extensions: Vec<String>,
}

/// Electron's `showSaveDialog` options, as the handler passes them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveDialog {
    pub title: String,
    pub default_path: String,
    pub filters: Vec<FileFilter>,
}

/// Electron's `showOpenDialog` options, as the handler passes them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct OpenDialog {
    pub title: String,
    pub filters: Vec<FileFilter>,
    pub properties: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Shown {
    Save(SaveDialog),
    Open(OpenDialog),
}

impl Shown {
    /// The seam's effect record, `{ api, args }`.
    pub fn seam_record(&self) -> Value {
        match self {
            Shown::Save(options) => json!({ "api": "dialog.showSaveDialog", "args": [options] }),
            Shown::Open(options) => json!({ "api": "dialog.showOpenDialog", "args": [options] }),
        }
    }
}

/// What the next dialog answers. `None` is the user cancelling it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
pub struct Answers {
    pub save: Option<PathBuf>,
    pub open: Option<PathBuf>,
}

#[derive(Debug, Default)]
pub struct Script {
    answers: Answers,
    shown: Vec<Shown>,
}

#[derive(Debug)]
pub enum Dialogs {
    System,
    Scripted(Mutex<Script>),
    /// Answers read from a JSON file before every dialog, and each dialog's
    /// seam record appended to `<file>.shown.jsonl`, for parity lanes that
    /// drive a running app from outside.
    File(PathBuf),
}

impl Dialogs {
    pub fn scripted() -> Self {
        Dialogs::Scripted(Mutex::default())
    }

    /// Sets what the following dialogs answer.
    pub fn answer(&self, answers: Answers) {
        if let Dialogs::Scripted(script) = self {
            lock(script).answers = answers;
        }
    }

    /// What dialogs were shown since the last call.
    pub fn take(&self) -> Vec<Shown> {
        match self {
            Dialogs::Scripted(script) => std::mem::take(&mut lock(script).shown),
            _ => Vec::new(),
        }
    }

    pub async fn save<R: Runtime>(
        &self,
        window: &WebviewWindow<R>,
        options: SaveDialog,
    ) -> Option<PathBuf> {
        match self {
            Dialogs::System => {
                let (tx, rx) = tokio::sync::oneshot::channel();
                let mut dialog = window
                    .dialog()
                    .file()
                    .set_parent(window)
                    .set_title(&options.title)
                    .set_file_name(&options.default_path);
                for filter in &options.filters {
                    let extensions: Vec<&str> =
                        filter.extensions.iter().map(String::as_str).collect();
                    dialog = dialog.add_filter(&filter.name, &extensions);
                }
                dialog.save_file(move |path| {
                    let _ = tx.send(path);
                });
                rx.await.ok().flatten()?.into_path().ok()
            }
            _ => self.scripted_answer(Shown::Save(options), |a| a.save),
        }
    }

    pub async fn open<R: Runtime>(
        &self,
        window: &WebviewWindow<R>,
        options: OpenDialog,
    ) -> Option<PathBuf> {
        match self {
            Dialogs::System => {
                let (tx, rx) = tokio::sync::oneshot::channel();
                let mut dialog = window
                    .dialog()
                    .file()
                    .set_parent(window)
                    .set_title(&options.title);
                for filter in &options.filters {
                    let extensions: Vec<&str> =
                        filter.extensions.iter().map(String::as_str).collect();
                    dialog = dialog.add_filter(&filter.name, &extensions);
                }
                dialog.pick_file(move |path| {
                    let _ = tx.send(path);
                });
                rx.await.ok().flatten()?.into_path().ok()
            }
            _ => self.scripted_answer(Shown::Open(options), |a| a.open),
        }
    }

    fn scripted_answer(
        &self,
        shown: Shown,
        pick: impl FnOnce(Answers) -> Option<PathBuf>,
    ) -> Option<PathBuf> {
        match self {
            Dialogs::System => None,
            Dialogs::Scripted(script) => {
                let mut script = lock(script);
                script.shown.push(shown);
                pick(script.answers.clone())
            }
            Dialogs::File(file) => {
                append_shown(file, &shown);
                let answers = std::fs::read_to_string(file)
                    .ok()
                    .and_then(|text| serde_json::from_str::<Answers>(&text).ok())
                    .unwrap_or_default();
                pick(answers)
            }
        }
    }
}

fn append_shown(file: &Path, shown: &Shown) {
    use std::io::Write;
    let mut log = file.as_os_str().to_owned();
    log.push(".shown.jsonl");
    let line = format!("{}\n", shown.seam_record());
    let written = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(PathBuf::from(log))
        .and_then(|mut log| log.write_all(line.as_bytes()));
    if let Err(err) = written {
        eprintln!("Failed to record a dialog: {err}");
    }
}

fn lock(script: &Mutex<Script>) -> std::sync::MutexGuard<'_, Script> {
    script
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The JSON filter both of Electron's data dialogs carry.
pub fn json_filter() -> Vec<FileFilter> {
    vec![FileFilter {
        name: "JSON".into(),
        extensions: vec!["json".into()],
    }]
}
