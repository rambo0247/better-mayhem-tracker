//! Where the app keeps its files: `src/main/paths.ts`. The root is the folder
//! Electron 1.2.1 uses, named for package.json's `name` and never for the
//! Tauri identifier, so an updated install opens the same matches.
//! In a lane build `BMT_DATA_ROOT` moves it, which is how lanes point the app
//! at a snapshot, and `data_guard.rs` keeps it out of the real folder. A lane
//! build is any build whose Cargo profile is not, or does not inherit from,
//! `release`. build.rs sets `bmt_release_profile` from the profile itself,
//! because profile settings can turn `debug_assertions` on in a release build
//! or off in a debug one. A release build has no override, as 1.2.1 has none,
//! so no process environment can move a player's database or backups.
//! The guard is in every lane build and every build with debug assertions,
//! so a release-profile build with debug assertions, or a debug build given
//! `--cfg bmt_release_profile`, has the guard and no override, and refuses
//! to start. No build has the override without the guard.

use std::ffi::OsString;
use std::io;
use std::path::{Path, PathBuf};

pub const DATA_FOLDER: &str = "better-mayhem-tracker";

#[cfg(not(bmt_release_profile))]
pub const ROOT_OVERRIDE: &str = "BMT_DATA_ROOT";

/// `EX_CONFIG` from sysexits.h.
pub const EXIT_CODE: i32 = 78;

/// Whether this build honors the override. Tests drive [`root_for`] with
/// either value; the build itself only ever has its own.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Build {
    Release,
    Lane,
}

const BUILD: Build = if cfg!(not(bmt_release_profile)) {
    Build::Lane
} else {
    Build::Release
};

#[cfg(not(bmt_release_profile))]
fn override_root() -> Option<OsString> {
    std::env::var_os(ROOT_OVERRIDE)
}

#[cfg(bmt_release_profile)]
fn override_root() -> Option<OsString> {
    None
}

/// The data root, checked by the guard in a lane build before anything can
/// use it, and again for every folder and file handed out under it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Paths {
    root: PathBuf,
    #[cfg(any(not(bmt_release_profile), debug_assertions))]
    guard: crate::data_guard::Guard,
}

impl Paths {
    /// This launch's root: in a lane build `BMT_DATA_ROOT` when set, else
    /// the real folder.
    pub fn resolve() -> Self {
        match root_for(BUILD, override_root(), dirs::config_dir()) {
            Some(root) => Self::at(root),
            None => {
                eprintln!(
                    "Better Mayhem Tracker cannot find the folder this system keeps application data in"
                );
                std::process::exit(EXIT_CODE);
            }
        }
    }

    /// `root`, once the guard passes it. A lane build exits here when it is
    /// the real folder.
    #[cfg(any(not(bmt_release_profile), debug_assertions))]
    pub fn at(root: impl Into<PathBuf>) -> Self {
        Self::guarded(root.into(), crate::data_guard::Guard::real())
    }

    #[cfg(all(bmt_release_profile, not(debug_assertions)))]
    pub fn at(root: impl Into<PathBuf>) -> Self {
        Self {
            root: absolute(root.into()),
        }
    }

    /// [`Paths::at`] against stand-ins for the real folder's parent.
    #[cfg(all(test, any(not(bmt_release_profile), debug_assertions)))]
    pub(crate) fn at_with(root: PathBuf, config_dirs: &[PathBuf]) -> Self {
        Self::guarded(root, crate::data_guard::Guard::against(config_dirs))
    }

    #[cfg(any(not(bmt_release_profile), debug_assertions))]
    fn guarded(root: PathBuf, guard: crate::data_guard::Guard) -> Self {
        guard.enforce(&root);
        Self {
            root: absolute(root),
            guard,
        }
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

    /// `data/<name>`. The database code takes the path it opens from here,
    /// `matches.db` and each SQLite file beside it, so a lane build refuses a
    /// file that links into the real folder, or has a second name, before it
    /// is opened.
    pub fn data_file(&self, name: &str) -> io::Result<PathBuf> {
        self.file_in("data", name)
    }

    /// `logs/<name>`, for the log writer, on the same terms as
    /// [`Paths::data_file`].
    pub fn log_file(&self, name: &str) -> io::Result<PathBuf> {
        self.file_in("logs", name)
    }

    /// A folder links can still lead out of after the root passed the guard,
    /// so a lane build checks each one before it makes or returns it.
    fn ensure(&self, name: &str) -> io::Result<PathBuf> {
        let dir = self.root.join(name);
        #[cfg(any(not(bmt_release_profile), debug_assertions))]
        self.guard.enforce(&dir);
        std::fs::create_dir_all(&dir)?;
        Ok(dir)
    }

    fn file_in(&self, folder: &str, name: &str) -> io::Result<PathBuf> {
        let file = self.ensure(folder)?.join(name);
        #[cfg(any(not(bmt_release_profile), debug_assertions))]
        self.guard.enforce_file(&file);
        Ok(file)
    }
}

/// In a lane build the override when it is set and not empty, else
/// `better-mayhem-tracker` in the config folder: `~/Library/Application
/// Support` on macOS and `%APPDATA%` on Windows, as Electron's
/// `app.getPath("userData")`.
fn root_for(
    build: Build,
    override_root: Option<OsString>,
    config_dir: Option<PathBuf>,
) -> Option<PathBuf> {
    match override_root.filter(|value| build == Build::Lane && !value.is_empty()) {
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
        assert_eq!(
            root_for(Build::Lane, Some("/run/data".into()), config.clone()),
            Some(PathBuf::from("/run/data"))
        );
        assert_eq!(
            root_for(Build::Lane, Some("".into()), config.clone()),
            Some(PathBuf::from("/config").join(DATA_FOLDER))
        );
        assert_eq!(
            root_for(Build::Lane, None, config),
            Some(PathBuf::from("/config").join(DATA_FOLDER))
        );
        assert_eq!(root_for(Build::Lane, None, None), None);
    }

    #[test]
    fn a_release_build_ignores_the_override() {
        let config = Some(PathBuf::from("/config"));
        assert_eq!(
            root_for(Build::Release, Some("/run/data".into()), config),
            Some(PathBuf::from("/config").join(DATA_FOLDER))
        );
    }

    #[test]
    fn this_test_build_is_a_lane_build() {
        assert_eq!(BUILD, Build::Lane);
    }

    /// Only the path's text: nothing here stats or opens it.
    #[cfg(target_os = "macos")]
    #[test]
    fn the_macos_root_is_in_application_support() {
        let home = dirs::home_dir().expect("a home folder");
        let root = root_for(Build::Lane, None, dirs::config_dir()).expect("a root");
        assert_eq!(
            root,
            home.join("Library/Application Support/better-mayhem-tracker")
        );
    }

    #[cfg(windows)]
    #[test]
    fn the_windows_root_is_in_roaming_appdata() {
        let appdata = PathBuf::from(std::env::var_os("APPDATA").expect("APPDATA"));
        let root = root_for(Build::Lane, None, dirs::config_dir()).expect("a root");
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
