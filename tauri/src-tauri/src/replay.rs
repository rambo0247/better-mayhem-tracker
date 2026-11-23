//! What a golden replay needs from the process before it builds an app.
//!
//! Electron's main process read the process zone, through SQLite's
//! `'localtime'` and JS `Date`, and the port does too. SQLite asks libc, so
//! only the process's own `TZ` reaches it, and setting `TZ` inside a test
//! process that has started threads is unsound. A replay therefore runs only
//! when the environment it was started with already matches the recording.

use std::path::Path;

/// What `parity/run-electron.ts` records under when the manifest does not say.
pub const DEFAULT_TIME_ZONE: &str = "America/New_York";
pub const DEFAULT_LOCALE: &str = "en-US";

/// The recording's zone and locale, from `manifest.json`'s `timeZone` and
/// `locale` when it has them.
pub struct Recording {
    pub time_zone: String,
    pub locale: String,
}

impl Recording {
    pub fn from_manifest(manifest: &serde_json::Value) -> Self {
        let text = |key: &str, default: &str| {
            manifest
                .get(key)
                .and_then(serde_json::Value::as_str)
                .unwrap_or(default)
                .to_owned()
        };
        Self {
            time_zone: text("timeZone", DEFAULT_TIME_ZONE),
            locale: text("locale", DEFAULT_LOCALE),
        }
    }

    /// The `TZ` this process must run with. Windows' C runtime reads only a
    /// POSIX zone such as `EST5EDT`, never an IANA name.
    pub fn tz(&self) -> String {
        if cfg!(windows) && self.time_zone == DEFAULT_TIME_ZONE {
            "EST5EDT".into()
        } else {
            self.time_zone.clone()
        }
    }

    pub fn lang(&self) -> String {
        format!("{}.UTF-8", self.locale.replace('-', "_"))
    }

    /// The command line that reruns `command` in the recording's zone.
    pub fn rerun(&self, command: &str) -> String {
        format!("TZ={} LANG={} {command}", self.tz(), self.lang())
    }
}

/// Refuses to replay unless `TZ` and `LANG` already hold the recording's, and
/// SQLite reads the zone as the recording did. Call it first in a replay
/// test's main, before any thread starts. `command` is how the test is run.
pub fn require_recording_env(recording: &Recording, command: &str) -> Result<(), String> {
    let env = |key: &str| std::env::var(key).unwrap_or_default();
    if env("TZ") != recording.tz() || env("LANG") != recording.lang() {
        return Err(format!(
            "the goldens were recorded in {} with {}, and this process has TZ={:?} LANG={:?}. Rerun as:\n  {}",
            recording.time_zone,
            recording.locale,
            env("TZ"),
            env("LANG"),
            recording.rerun(command)
        ));
    }
    if recording.time_zone == DEFAULT_TIME_ZONE {
        let wall = sqlite_local_time(SEAM_FIXED_EPOCH_S)?;
        if wall != SEAM_FIXED_WALL {
            return Err(format!(
                "TZ={} but SQLite's 'localtime' reads {SEAM_FIXED_EPOCH_S} as {wall}, not {SEAM_FIXED_WALL}",
                recording.tz()
            ));
        }
    }
    Ok(())
}

/// The seam's `SEAM_FIXED_TIME`, `2026-11-22T21:00:00-05:00`.
pub const SEAM_FIXED_EPOCH_S: i64 = 1_795_399_200;
pub const SEAM_FIXED_WALL: &str = "2026-11-22 21:00:00";

/// An instant as SQLite's `'localtime'` prints it in this process's zone.
pub fn sqlite_local_time(epoch_s: i64) -> Result<String, String> {
    let conn = rusqlite::Connection::open_in_memory().map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT datetime(?1, 'unixepoch', 'localtime')",
        [epoch_s],
        |row| row.get(0),
    )
    .map_err(|e| e.to_string())
}

/// Reads `manifest.json` in a golden folder.
pub fn read_manifest(dir: &Path) -> Result<serde_json::Value, String> {
    let path = dir.join("manifest.json");
    let text = std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_rerun_line_names_the_recording_zone() {
        let recording = Recording::from_manifest(&serde_json::json!({ "fixedTime": "x" }));
        assert_eq!(recording.time_zone, "America/New_York");
        assert_eq!(recording.lang(), "en_US.UTF-8");
        let tz = if cfg!(windows) {
            "EST5EDT"
        } else {
            "America/New_York"
        };
        assert_eq!(
            recording.rerun("cargo test"),
            format!("TZ={tz} LANG=en_US.UTF-8 cargo test")
        );
        let tokyo = Recording::from_manifest(
            &serde_json::json!({ "timeZone": "Asia/Tokyo", "locale": "ja-JP" }),
        );
        assert_eq!(tokyo.rerun("x"), "TZ=Asia/Tokyo LANG=ja_JP.UTF-8 x");
    }
}
