//! Where the app keeps its files: `src/main/paths.ts`. The root is the folder
//! Electron 1.2.1 uses, named for package.json's `name` and never for the
//! Tauri identifier, so an updated install opens the same matches.
//! `BMT_DATA_ROOT` moves it, which is how lanes point the app at a snapshot.

use std::ffi::OsString;
use std::io;
use std::path::{Path, PathBuf};

use crate::data_guard;

pub const DATA_FOLDER: &str = "better-mayhem-tracker";
pub const ROOT_OVERRIDE: &str = "BMT_DATA_ROOT";

/// The data root, checked by [`data_guard`] before anything can use it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Paths {
    root: PathBuf,
}

impl Paths {
    /// This launch's root: `BMT_DATA_ROOT`, else the real folder.
    pub fn resolve() -> Self {
        match root_from(std::env::var_os(ROOT_OVERRIDE), dirs::config_dir()) {
            Some(root) => Self::at(root),
            None => {
                eprintln!("Better Mayhem Tracker cannot find the folder this system keeps application data in");
                std::process::exit(data_guard::EXIT_CODE);
            }
        }
    }

    /// `root`, once the guard passes it. A debug build exits here when it is
    /// the real folder.
    pub fn at(root: impl Into<PathBuf>) -> Self {
        let root = root.into();
        data_guard::enforce(&root);
        Self { root: absolute(root) }
    }

    /// [`Paths::at`] against stand-ins for the real folder's parent.
    #[cfg(test)]
    pub(crate) fn at_with(root: PathBuf, config_dirs: &[PathBuf]) -> Self {
        data_guard::enforce_against(&root, config_dirs);
        Self { root: absolute(root) }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn data_dir(&self) -> io::Result<PathBuf> {
        self.ensure("data")
    }

    /// A sibling of the data folder, never inside it, so whatever wipes the
    /// data folder leaves the backups.
    pub fn backup_dir(&self) -> io::Result<PathBuf> {
        self.ensure("backups")
    }

    pub fn log_dir(&self) -> io::Result<PathBuf> {
        self.ensure("logs")
    }

    /// Not `cache`: Chromium keeps `Cache` in the same folder, and on Windows
    /// the two names are one folder.
    pub fn asset_cache_dir(&self) -> io::Result<PathBuf> {
        self.ensure("asset-cache")
    }

    fn ensure(&self, name: &str) -> io::Result<PathBuf> {
        let dir = self.root.join(name);
        std::fs::create_dir_all(&dir)?;
        Ok(dir)
    }
}

/// The override when it is set and not empty, else `better-mayhem-tracker`
/// in the config folder: `~/Library/Application Support` on macOS and
/// `%APPDATA%` on Windows, as Electron's `app.getPath("userData")`.
fn root_from(override_root: Option<OsString>, config_dir: Option<PathBuf>) -> Option<PathBuf> {
    match override_root.filter(|value| !value.is_empty()) {
        Some(root) => Some(PathBuf::from(root)),
        None => config_dir.map(|dir| dir.join(DATA_FOLDER)),
    }
}

fn absolute(root: PathBuf) -> PathBuf {
    std::path::absolute(&root).unwrap_or(root)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_override_wins_and_an_empty_one_is_unset() {
        let config = Some(PathBuf::from("/config"));
        assert_eq!(root_from(Some("/run/data".into()), config.clone()), Some(PathBuf::from("/run/data")));
        assert_eq!(root_from(Some("".into()), config.clone()), Some(PathBuf::from("/config").join(DATA_FOLDER)));
        assert_eq!(root_from(None, config), Some(PathBuf::from("/config").join(DATA_FOLDER)));
        assert_eq!(root_from(None, None), None);
    }

    /// Only the path's text: nothing here stats or opens it.
    #[cfg(target_os = "macos")]
    #[test]
    fn the_macos_root_is_in_application_support() {
        let home = dirs::home_dir().expect("a home folder");
        let root = root_from(None, dirs::config_dir()).expect("a root");
        assert_eq!(root, home.join("Library/Application Support/better-mayhem-tracker"));
    }

    #[cfg(windows)]
    #[test]
    fn the_windows_root_is_in_roaming_appdata() {
        let appdata = PathBuf::from(std::env::var_os("APPDATA").expect("APPDATA"));
        let root = root_from(None, dirs::config_dir()).expect("a root");
        assert_eq!(root, appdata.join("better-mayhem-tracker"));
    }

    #[test]
    fn subfolders_are_made_on_first_use() {
        let run = std::env::temp_dir().join(format!("bmt-paths-{}", std::process::id()));
        std::fs::remove_dir_all(&run).ok();
        let paths = Paths::at(&run);
        assert!(!run.exists(), "resolving creates nothing");
        assert_eq!(paths.data_dir().unwrap(), run.join("data"));
        assert_eq!(paths.backup_dir().unwrap(), run.join("backups"));
        assert_eq!(paths.log_dir().unwrap(), run.join("logs"));
        assert_eq!(paths.asset_cache_dir().unwrap(), run.join("asset-cache"));
        for name in ["data", "backups", "logs", "asset-cache"] {
            assert!(run.join(name).is_dir(), "{name}");
        }
        std::fs::remove_dir_all(&run).ok();
    }
}
