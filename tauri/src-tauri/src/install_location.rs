//! `src/main/install-location.ts`: where the copy of the program the user
//! keeps lives, the thing to register at sign-in and to replace with a new
//! version. `None` means there is no durable copy to point at: a debug build,
//! or a copy the OS runs from somewhere temporary.

use std::path::{Path, PathBuf};

/// What the user sees in the Start Menu. The data folder keeps package.json's
/// `name` instead ([`crate::paths::DATA_FOLDER`]).
pub const APP_DISPLAY_NAME: &str = "Better Mayhem Tracker";
/// The release artifact's name, `build.win.artifactName` in package.json.
pub const WINDOWS_EXE_NAME: &str = "BetterMayhemTracker.exe";

/// Electron's `app.isPackaged`: only a release-profile build is installed;
/// any other runs out of a build folder.
fn is_packaged() -> bool {
    cfg!(bmt_release_profile)
}

/// The exe on Windows. Electron's portable launcher ran a temp copy, so it
/// read `PORTABLE_EXECUTABLE_FILE`; the Tauri exe runs in place.
pub fn portable_exe() -> Option<PathBuf> {
    if !cfg!(windows) || !is_packaged() {
        return None;
    }
    std::env::current_exe().ok()
}

/// The `.app` bundle the running executable sits in on macOS.
pub fn mac_app_bundle() -> Option<PathBuf> {
    if !cfg!(target_os = "macos") || !is_packaged() {
        return None;
    }
    bundle_of(&exec_path()?)
}

/// Electron's `process.execPath`, which libuv's `uv_exepath` gives. On macOS
/// and Linux it resolves symlinks (`realpath`), so a launch through a
/// symlinked folder names the real one. On Windows it is
/// `GetModuleFileNameW` as is, which is what `current_exe` returns there.
pub fn exec_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    if cfg!(windows) {
        return Some(exe);
    }
    std::fs::canonicalize(exe).ok()
}

/// `<bundle>.app/Contents/MacOS/<executable>`. A quarantined app opened from
/// Downloads or a disk image runs from a randomised read-only copy (App
/// Translocation), neither stable enough to register nor writable enough to
/// update, so it does not count, and neither does a mounted volume.
fn bundle_of(exe: &Path) -> Option<PathBuf> {
    let bundle = exe.parent()?.parent()?.parent()?;
    let text = bundle.to_str()?;
    if !text.ends_with(".app")
        || text.contains("/AppTranslocation/")
        || text.starts_with("/Volumes/")
    {
        return None;
    }
    Some(bundle.to_path_buf())
}

/// Whether this run has a durable copy of itself at all.
pub fn has_durable_install() -> bool {
    portable_exe().is_some() || mac_app_bundle().is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_bundle_in_applications_is_durable() {
        let exe = Path::new(
            "/Applications/Better Mayhem Tracker.app/Contents/MacOS/Better Mayhem Tracker",
        );
        assert_eq!(
            bundle_of(exe),
            Some(PathBuf::from("/Applications/Better Mayhem Tracker.app"))
        );
    }

    #[test]
    fn translocated_mounted_and_bare_runs_are_not() {
        for exe in [
            "/private/var/folders/x/AppTranslocation/1234/d/Better Mayhem Tracker.app/Contents/MacOS/Better Mayhem Tracker",
            "/Volumes/Better Mayhem Tracker/Better Mayhem Tracker.app/Contents/MacOS/Better Mayhem Tracker",
            "/Users/me/dev/tauri/src-tauri/target/debug/better-mayhem-tracker-tauri",
        ] {
            assert_eq!(bundle_of(Path::new(exe)), None, "{exe}");
        }
    }

    #[cfg(not(bmt_release_profile))]
    #[test]
    fn a_debug_build_has_no_durable_install() {
        assert!(!has_durable_install());
    }
}
