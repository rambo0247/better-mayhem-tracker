//! Keeps debug and parity builds out of the folder Electron 1.2.1 keeps a
//! player's matches in. [`crate::paths::Paths`] runs [`enforce`] before it
//! hands out a single path, so nothing is created or opened under a root
//! that fails it. Release builds skip it and open that folder, as 1.2.1 does.
//!
//! A root fails when it is the real folder or inside it, however it is
//! spelled. The check walks the root the way the kernel will: symlinks are
//! followed even when they dangle, `..` steps out of the folder actually
//! reached, names compare case-insensitively, and a folder is matched by
//! identity as well as by name, which catches aliases such as macOS firmlinks
//! (`/System/Volumes/Data/Users/...`). It never reads the real folder itself.
//! There is no override: a debug build that fails it exits.

use std::ffi::OsStr;
use std::fmt;
use std::path::{Component, Path, PathBuf};

use crate::paths::DATA_FOLDER;

/// `EX_CONFIG` from sysexits.h.
pub const EXIT_CODE: i32 = 78;

/// Symlinks followed before the walk gives up, as `MAXSYMLINKS` on macOS.
const MAX_LINKS: usize = 32;

/// Why a root was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tripped {
    pub root: PathBuf,
    pub reason: String,
}

impl fmt::Display for Tripped {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "Better Mayhem Tracker refused to start: the data root {} {}. Debug and parity builds never \
             open the real {DATA_FOLDER} folder. Set BMT_DATA_ROOT to a copy made by \
             `bun parity/snapshot.ts` or `bun parity/fixture.ts`.",
            self.root.display(),
            self.reason
        )
    }
}

/// Exits the process when `root` is the real folder, in debug and parity
/// builds. Release builds return at once.
pub fn enforce(root: &Path) {
    if cfg!(any(debug_assertions, feature = "parity-driver")) {
        enforce_against(root, &real_config_dirs());
    }
}

/// [`enforce`] against the given folders that the real folder sits in.
pub fn enforce_against(root: &Path, config_dirs: &[PathBuf]) {
    if let Err(tripped) = check(root, config_dirs) {
        eprintln!("{tripped}");
        std::process::exit(EXIT_CODE);
    }
}

/// Every spelling of the folder 1.2.1's data folder sits in that this process
/// can see. Several, because an environment variable can move one of them.
pub fn real_config_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    dirs.extend(dirs::config_dir());
    #[cfg(target_os = "macos")]
    dirs.extend(passwd_home().map(|home| home.join("Library").join("Application Support")));
    #[cfg(all(unix, not(target_os = "macos")))]
    dirs.extend(passwd_home().map(|home| home.join(".config")));
    #[cfg(windows)]
    dirs.extend(
        std::env::var_os("APPDATA")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from),
    );
    dirs
}

/// The home folder the user database names, which `$HOME` cannot move.
#[cfg(unix)]
fn passwd_home() -> Option<PathBuf> {
    use std::ffi::CStr;
    use std::os::unix::ffi::OsStrExt;

    let mut buf = vec![0 as libc::c_char; 16 * 1024];
    let mut pwd: libc::passwd = unsafe { std::mem::zeroed() };
    let mut result: *mut libc::passwd = std::ptr::null_mut();
    // SAFETY: every pointer is valid for the call, and `buf` outlives the
    // strings `pwd` points into, which are copied out before it drops
    let status = unsafe {
        libc::getpwuid_r(
            libc::getuid(),
            &mut pwd,
            buf.as_mut_ptr(),
            buf.len(),
            &mut result,
        )
    };
    if status != 0 || result.is_null() || pwd.pw_dir.is_null() {
        return None;
    }
    let dir = unsafe { CStr::from_ptr(pwd.pw_dir) };
    Some(PathBuf::from(OsStr::from_bytes(dir.to_bytes())))
}

/// Passes when `root` is neither the real folder under any of `config_dirs`
/// nor inside it.
pub fn check(root: &Path, config_dirs: &[PathBuf]) -> Result<(), Tripped> {
    let trip = |reason: String| {
        Err(Tripped {
            root: root.to_path_buf(),
            reason,
        })
    };
    if config_dirs.is_empty() {
        return trip(
            "could not be checked, because this process cannot tell where the real folder is"
                .into(),
        );
    }
    let Ok(absolute) = std::path::absolute(root) else {
        return trip("could not be made absolute".into());
    };
    let Some(physical) = walk(&absolute) else {
        return trip(format!("follows more than {MAX_LINKS} symlinks"));
    };
    for config in config_dirs {
        let real = config.join(DATA_FOLDER);
        let config_physical = walk(config).unwrap_or_else(|| config.clone());
        let real_physical = config_physical.join(DATA_FOLDER);
        if starts_with(&lexical(&absolute), &lexical(&real))
            || starts_with(&physical, &real_physical)
        {
            return trip(format!("is {} or inside it", real.display()));
        }
        // The same folder under another name: an ancestor called
        // better-mayhem-tracker whose parent is the config folder itself
        for ancestor in physical.ancestors() {
            let named = ancestor
                .file_name()
                .is_some_and(|name| fold(name) == fold(OsStr::new(DATA_FOLDER)));
            if named
                && ancestor
                    .parent()
                    .is_some_and(|parent| same_dir(parent, config))
            {
                return trip(format!(
                    "reaches {} through {}",
                    real.display(),
                    ancestor.display()
                ));
            }
        }
    }
    Ok(())
}

/// The path the kernel reaches by `path`: symlinks expanded, dangling ones
/// included, and `..` taken from the folder actually reached. `None` past
/// [`MAX_LINKS`] symlinks.
fn walk(path: &Path) -> Option<PathBuf> {
    let mut pending: Vec<PathBuf> = path
        .components()
        .rev()
        .map(|c| PathBuf::from(c.as_os_str()))
        .collect();
    let mut out = PathBuf::new();
    let mut links = 0;
    while let Some(part) = pending.pop() {
        let Some(component) = part.components().next() else {
            continue;
        };
        match component {
            Component::Prefix(_) => out = part,
            Component::RootDir => out.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            Component::Normal(name) => {
                let next = out.join(name);
                let is_link =
                    std::fs::symlink_metadata(&next).is_ok_and(|m| m.file_type().is_symlink());
                if !is_link {
                    out = next;
                    continue;
                }
                links += 1;
                if links > MAX_LINKS {
                    return None;
                }
                let target = std::fs::read_link(&next).ok()?;
                // A relative target continues from the link's folder, which
                // `out` still is; an absolute one starts over at its root
                pending.extend(
                    target
                        .components()
                        .rev()
                        .map(|c| PathBuf::from(c.as_os_str())),
                );
            }
        }
    }
    Some(out)
}

/// `path` with `.` dropped and `..` applied to the text, for a root whose
/// folders do not exist yet.
fn lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Component-wise and case-folded, with Windows' `\\?\` prefixes dropped, so
/// `C:\Users` and `\\?\c:\users` compare equal.
fn starts_with(path: &Path, prefix: &Path) -> bool {
    let key = |p: &Path| -> Vec<String> {
        p.components()
            .map(|c| match c {
                Component::Prefix(prefix) => {
                    let text = prefix.as_os_str().to_string_lossy().to_lowercase();
                    let text = text.trim_start_matches(r"\\?\").trim_start_matches(r"\\.\");
                    text.strip_prefix(r"unc\")
                        .map_or_else(|| text.to_owned(), |rest| format!(r"\\{rest}"))
                }
                other => fold(other.as_os_str()),
            })
            .collect()
    };
    let (path, prefix) = (key(path), key(prefix));
    path.len() >= prefix.len() && path[..prefix.len()] == prefix[..]
}

/// A name as a case-insensitive file system compares it. Upper then lower
/// folds the Kelvin sign to `k` and the long s to `s`, as APFS and NTFS do.
fn fold(name: &OsStr) -> String {
    name.to_string_lossy().to_uppercase().to_lowercase()
}

/// Whether two paths name the same existing folder.
fn same_dir(a: &Path, b: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        match (std::fs::metadata(a), std::fs::metadata(b)) {
            (Ok(a), Ok(b)) => a.dev() == b.dev() && a.ino() == b.ino(),
            _ => false,
        }
    }
    #[cfg(not(unix))]
    {
        match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
            (Ok(a), Ok(b)) => starts_with(&a, &b) && starts_with(&b, &a),
            _ => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A scratch folder standing in for `~/Library/Application Support`, so
    /// no test goes near the real one.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("bmt-guard-{}-{name}", std::process::id()));
            std::fs::remove_dir_all(&dir).ok();
            std::fs::create_dir_all(dir.join("Application Support"))
                .expect("create the scratch folder");
            Self(std::fs::canonicalize(dir).expect("canonical scratch"))
        }
        fn config(&self) -> PathBuf {
            self.0.join("Application Support")
        }
        fn real(&self) -> PathBuf {
            self.config().join(DATA_FOLDER)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.0).ok();
        }
    }

    fn trips(scratch: &Scratch, root: &Path) -> bool {
        check(root, &[scratch.config()]).is_err()
    }

    #[test]
    fn refuses_the_real_folder_before_it_exists() {
        let s = Scratch::new("absent");
        assert!(trips(&s, &s.real()));
        assert!(trips(&s, &s.real().join("data")));
        assert!(!s.real().exists(), "the check created nothing");
    }

    #[test]
    fn refuses_the_real_folder_and_everything_in_it() {
        let s = Scratch::new("present");
        std::fs::create_dir_all(s.real().join("data")).unwrap();
        assert!(trips(&s, &s.real()));
        assert!(trips(&s, &s.real().join("data")));
        assert!(trips(&s, &s.real().join("not-yet").join("deeper")));
    }

    #[test]
    fn refuses_other_spellings_of_the_name() {
        let s = Scratch::new("case");
        for name in [
            "Better-Mayhem-Tracker",
            "BETTER-MAYHEM-TRACKER",
            "better-mayhem-trac\u{212A}er",
        ] {
            assert!(trips(&s, &s.config().join(name)), "{name}");
        }
        assert!(trips(&s, &s.config().join(".").join(DATA_FOLDER).join(".")));
    }

    #[test]
    fn refuses_a_way_back_in_through_dot_dot() {
        let s = Scratch::new("dotdot");
        std::fs::create_dir_all(s.0.join("elsewhere")).unwrap();
        assert!(trips(
            &s,
            &s.0.join("elsewhere")
                .join("..")
                .join("Application Support")
                .join(DATA_FOLDER)
        ));
        assert!(trips(
            &s,
            &s.0.join("missing")
                .join("..")
                .join("Application Support")
                .join(DATA_FOLDER)
        ));
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlinks_into_the_real_folder() {
        use std::os::unix::fs::symlink;
        let s = Scratch::new("links");
        // Dangling: the real folder does not exist yet
        symlink(s.real(), s.0.join("dangling")).unwrap();
        assert!(trips(&s, &s.0.join("dangling")));
        assert!(trips(&s, &s.0.join("dangling").join("data")));
        // A link to the folder it sits in, then the name
        symlink(s.config(), s.0.join("support")).unwrap();
        assert!(trips(&s, &s.0.join("support").join(DATA_FOLDER)));
        // A relative link, and a chain of two
        symlink(
            Path::new("Application Support").join(DATA_FOLDER),
            s.0.join("relative"),
        )
        .unwrap();
        assert!(trips(&s, &s.0.join("relative")));
        symlink(s.0.join("relative"), s.0.join("chain")).unwrap();
        assert!(trips(&s, &s.0.join("chain").join("logs")));
        // Once it exists, a link to a folder inside it
        std::fs::create_dir_all(s.real().join("logs")).unwrap();
        symlink(s.real().join("logs"), s.0.join("logs-link")).unwrap();
        assert!(trips(&s, &s.0.join("logs-link")));
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_symlink_loop() {
        use std::os::unix::fs::symlink;
        let s = Scratch::new("loop");
        symlink(s.0.join("b"), s.0.join("a")).unwrap();
        symlink(s.0.join("a"), s.0.join("b")).unwrap();
        assert!(trips(&s, &s.0.join("a")));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn refuses_the_real_folder_through_a_firmlink() {
        // `/private` is a firmlink of `/System/Volumes/Data/private`, the same
        // folder under a path that no symlink explains
        let s = Scratch::new("firmlink");
        let config = s.config();
        let Ok(inside) = config.strip_prefix("/") else {
            return;
        };
        let alias = Path::new("/System/Volumes/Data").join(inside);
        if !alias.exists() {
            return;
        }
        assert!(trips(&s, &alias.join(DATA_FOLDER)));
    }

    #[test]
    fn passes_folders_beside_it() {
        let s = Scratch::new("beside");
        assert!(!trips(&s, &s.config()));
        assert!(!trips(
            &s,
            &s.config().join(format!("{DATA_FOLDER}-snapshot"))
        ));
        assert!(!trips(&s, &s.0.join("run").join(DATA_FOLDER)));
        assert!(!trips(&s, &s.0.join("run").join("data")));
    }

    #[test]
    fn refuses_when_it_cannot_tell_where_the_real_folder_is() {
        let s = Scratch::new("unknown");
        assert!(check(&s.0.join("run"), &[]).is_err());
    }

    #[test]
    fn checks_every_spelling_of_the_config_folder() {
        let s = Scratch::new("several");
        let other = s.0.join("moved-home");
        std::fs::create_dir_all(&other).unwrap();
        assert!(check(&s.real(), &[other, s.config()]).is_err());
    }

    /// The child half of [`exits_before_creating_anything`].
    #[test]
    fn guard_child() {
        let (Some(root), Some(config)) = (
            std::env::var_os("BMT_GUARD_CHILD_ROOT"),
            std::env::var_os("BMT_GUARD_CHILD_CONFIG"),
        ) else {
            return;
        };
        let paths = crate::paths::Paths::at_with(PathBuf::from(root), &[PathBuf::from(config)]);
        // Unreachable when the guard works: this would create the folder
        paths.data_dir().ok();
        println!("guard-child: passed the guard");
    }

    #[test]
    fn exits_before_creating_anything() {
        let s = Scratch::new("exit");
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "data_guard::tests::guard_child",
                "--nocapture",
                "--test-threads=1",
            ])
            .env("BMT_GUARD_CHILD_ROOT", s.real())
            .env("BMT_GUARD_CHILD_CONFIG", s.config())
            .output()
            .expect("run the child");
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert_eq!(output.status.code(), Some(EXIT_CODE), "stderr: {stderr}");
        assert!(stderr.contains("refused to start"), "stderr: {stderr}");
        assert!(stderr.contains("BMT_DATA_ROOT"), "stderr: {stderr}");
        assert!(!String::from_utf8_lossy(&output.stdout).contains("passed the guard"));
        assert!(!s.real().exists(), "nothing was created");
    }
}
