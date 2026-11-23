//! Keeps lane builds, any build whose Cargo profile is not `release`, out of
//! the folder Electron 1.2.1 keeps a player's matches in.
//! [`crate::paths::Paths`] runs the [`Guard`] on the root before it stores
//! it, and again on every folder and file it hands out, so nothing is created
//! or opened under a path that fails it. Release builds do not compile it, and
//! open that folder as 1.2.1 does.
//!
//! A path fails when it is the real folder or inside it, however it is
//! spelled. The check compares the text first. Then it walks the path the
//! way the kernel will: symlinks are followed even when they dangle, `..`
//! steps out of the folder actually reached, and names compare
//! case-insensitively. Before it takes a step into a folder named like the
//! real one, it compares the folder it stands in with the config folder by
//! identity, which catches aliases such as macOS firmlinks
//! (`/System/Volumes/Data/Users/...`). It stops at the first step that would
//! enter the real folder, so the real folder is never stat-ed by a spelling
//! the check recognizes. A macOS volfs path (`/.vol/<device>/<inode>`) fails
//! by its text. A path that passes all that is compared by identity, folder
//! by folder up from its deepest existing part, with the real folder, which
//! catches a name only the file system knows, such as a Windows 8.3 short
//! name. That compare stats the real folder only when one of those folders
//! sits directly in a config folder. A file with a second name fails, since
//! a hard link can make any of the player's files a lane's database or log.
//! Nothing here reads a file's contents.
//! There is no override: a lane build that fails it exits.

use std::ffi::OsStr;
use std::fmt;
use std::path::{Component, Path, PathBuf};

use crate::paths::DATA_FOLDER;

pub use crate::paths::EXIT_CODE;

/// The names the real folder goes by: package.json's `name`, which 1.2.1
/// uses, and the display name, which the parity tools also refuse
/// (`parity/lib/real-folder.ts`).
pub const REAL_FOLDER_NAMES: [&str; 2] = [DATA_FOLDER, crate::PRODUCT_NAME];

/// Symlinks followed before the walk gives up, as `MAXSYMLINKS` on macOS.
const MAX_LINKS: usize = 32;

/// Why a path was refused.
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

/// The folders the real data folder can sit in, which every path the app
/// uses is checked against.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Guard {
    config_dirs: Vec<PathBuf>,
}

impl Guard {
    /// This process's own config folders, from [`real_config_dirs`].
    pub fn real() -> Self {
        Self::against(&real_config_dirs())
    }

    /// Stand-ins for the config folders, for tests.
    pub fn against(config_dirs: &[PathBuf]) -> Self {
        Self {
            config_dirs: config_dirs.to_vec(),
        }
    }

    pub fn check(&self, path: &Path) -> Result<(), Tripped> {
        check(path, &self.config_dirs)
    }

    /// [`Guard::check`] for a file, which also fails when the file has a
    /// second name: a hard link can make any of the player's files the
    /// lane's database or log, and no lane file needs one.
    pub fn check_file(&self, file: &Path) -> Result<(), Tripped> {
        self.check(file)?;
        match file_id(file) {
            Some(id) if id.links > 1 => Err(Tripped {
                root: file.to_path_buf(),
                reason: format!("has {} names, so it may be a hard link", id.links),
            }),
            _ => Ok(()),
        }
    }

    /// Exits the process when `path` fails [`Guard::check`].
    pub fn enforce(&self, path: &Path) {
        exit_on(self.check(path));
    }

    /// Exits the process when `file` fails [`Guard::check_file`].
    pub fn enforce_file(&self, file: &Path) {
        exit_on(self.check_file(file));
    }
}

fn exit_on(result: Result<(), Tripped>) {
    if let Err(tripped) = result {
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

/// One spelling of the real folder: as the config folder is written, and as
/// the walk reaches it.
struct Real {
    lexical: PathBuf,
    physical: PathBuf,
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
    let mut reals = Vec::new();
    for config in config_dirs {
        let config_lexical = lexical(config);
        let config_physical = walk(&config_lexical, |_, _| None).unwrap_or(config_lexical.clone());
        for name in REAL_FOLDER_NAMES {
            reals.push(Real {
                lexical: config_lexical.join(name),
                physical: config_physical.join(name),
            });
        }
    }
    let inside = |path: &Path| {
        reals
            .iter()
            .find(|real| starts_with(path, &real.lexical) || starts_with(path, &real.physical))
    };
    if let Some(real) = inside(&lexical(&absolute)) {
        return trip(format!("is {} or inside it", real.lexical.display()));
    }
    let names: Vec<String> = REAL_FOLDER_NAMES
        .iter()
        .map(|name| fold(OsStr::new(name)))
        .collect();
    let step = |folder: &Path, name: &OsStr| -> Option<String> {
        let next = folder.join(name);
        // macOS volfs, `/.vol/<device>/<inode>`, names a folder by number
        if folder == Path::new("/") && fold(name) == ".vol" {
            return Some(format!("goes through volfs, {}", next.display()));
        }
        if let Some(real) = inside(&next) {
            return Some(format!(
                "reaches {} through {}",
                real.lexical.display(),
                next.display()
            ));
        }
        // The same folder under another name: a folder named like the real
        // one in a folder that is the config folder itself
        if !names.contains(&fold(name)) {
            return None;
        }
        let config = config_dirs.iter().find(|config| same_dir(folder, config))?;
        Some(format!(
            "reaches {} through {}",
            config.join(name).display(),
            next.display()
        ))
    };
    let physical = match walk(&absolute, step) {
        Ok(physical) => physical,
        Err(reason) => return trip(reason),
    };
    match inside_by_identity(&physical, config_dirs) {
        Some(reason) => trip(reason),
        None => Ok(()),
    }
}

/// What no name shows: a folder that is the real folder under a name the
/// text checks do not know (a Windows 8.3 short name, a volume GUID path).
/// From the deepest part of `physical` that exists it climbs the folders the
/// kernel reaches, and when one sits directly in a config folder, compares
/// that one with the real folder by identity. So the real folder is looked at
/// only when the path is inside something in a config folder.
fn inside_by_identity(physical: &Path, config_dirs: &[PathBuf]) -> Option<String> {
    let configs: Vec<(&PathBuf, FileId)> = config_dirs
        .iter()
        .filter_map(|config| Some((config, file_id(config)?)))
        .collect();
    let (mut at, mut id) = physical
        .ancestors()
        .find_map(|a| Some((a.to_path_buf(), file_id(a).filter(|id| id.dir)?)))?;
    loop {
        let parent = up(&at)?;
        let parent_id = file_id(&parent)?;
        if parent_id.same_file(&id) {
            return None;
        }
        for (config, config_id) in &configs {
            if !parent_id.same_file(config_id) {
                continue;
            }
            for name in REAL_FOLDER_NAMES {
                let real = config.join(name);
                if file_id(&real).is_some_and(|real_id| real_id.same_file(&id)) {
                    return Some(format!(
                        "is {} or inside it, as {}",
                        real.display(),
                        at.display()
                    ));
                }
            }
        }
        (at, id) = (parent, parent_id);
    }
}

/// The folder the kernel reaches from `path` by `..`. On Windows that is the
/// text's parent, since Win32 applies `..` to the text.
#[cfg(unix)]
fn up(path: &Path) -> Option<PathBuf> {
    Some(path.join(".."))
}

#[cfg(windows)]
fn up(path: &Path) -> Option<PathBuf> {
    path.parent().map(Path::to_path_buf)
}

/// The path the kernel reaches by `path`: symlinks expanded, dangling ones
/// included, and `..` taken from the folder actually reached. `step` sees
/// each folder and the name about to be entered from it before anything
/// looks at that name on disk, and ends the walk with its reason.
fn walk(
    path: &Path,
    mut step: impl FnMut(&Path, &OsStr) -> Option<String>,
) -> Result<PathBuf, String> {
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
                if let Some(reason) = step(&out, name) {
                    return Err(reason);
                }
                let next = out.join(name);
                let is_link = symlink_metadata(&next).is_ok_and(|m| m.file_type().is_symlink());
                if !is_link {
                    out = next;
                    continue;
                }
                links += 1;
                if links > MAX_LINKS {
                    return Err(format!("follows more than {MAX_LINKS} symlinks"));
                }
                let target = read_link(&next).map_err(|err| {
                    format!(
                        "has a symlink {} that cannot be read: {err}",
                        next.display()
                    )
                })?;
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
    Ok(out)
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

/// Component-wise and case-folded, with every Windows spelling of a drive
/// made one (`C:`, `\\?\C:`, `\\.\C:`, `\\localhost\C$`), so `C:\Users` and
/// `\\?\c:\users` compare equal.
fn starts_with(path: &Path, prefix: &Path) -> bool {
    let key = |p: &Path| -> Vec<String> {
        p.components()
            .map(|c| match c {
                Component::Prefix(prefix) => prefix_key(prefix.kind()),
                other => fold(other.as_os_str()),
            })
            .collect()
    };
    let (path, prefix) = (key(path), key(prefix));
    path.len() >= prefix.len() && path[..prefix.len()] == prefix[..]
}

fn prefix_key(prefix: std::path::Prefix<'_>) -> String {
    use std::path::Prefix;
    let drive = |letter: u8| format!("{}:", letter.to_ascii_lowercase() as char);
    match prefix {
        Prefix::Disk(letter) | Prefix::VerbatimDisk(letter) => drive(letter),
        Prefix::DeviceNS(name) => match name.as_encoded_bytes() {
            [letter, b':'] if letter.is_ascii_alphabetic() => drive(*letter),
            _ => format!(r"\\.\{}", fold(name)),
        },
        Prefix::UNC(server, share) | Prefix::VerbatimUNC(server, share) => {
            match (is_loopback(server), share.as_encoded_bytes()) {
                (true, [letter, b'$']) if letter.is_ascii_alphabetic() => drive(*letter),
                _ => format!(r"\\{}\{}", fold(server), fold(share)),
            }
        }
        Prefix::Verbatim(name) => format!(r"\\?\{}", fold(name)),
    }
}

/// A UNC server name that is this machine, whose admin shares (`C$`) are its
/// drives.
fn is_loopback(server: &OsStr) -> bool {
    let server = fold(server);
    let this_machine = std::env::var_os("COMPUTERNAME").is_some_and(|name| fold(&name) == server);
    this_machine
        || server == "localhost"
        || server == "0--1.ipv6-literal.net"
        || server.starts_with("127.")
}

/// A name as the file system compares it. Upper then lower folds the Kelvin
/// sign to `k` and the long s to `s`, as APFS and NTFS do. On Windows a
/// stream suffix (`name::$INDEX_ALLOCATION`) names the same file, and Win32
/// drops trailing dots and spaces.
fn fold(name: &OsStr) -> String {
    let name = name.to_string_lossy();
    #[cfg(windows)]
    let name = name
        .split(':')
        .next()
        .unwrap_or_default()
        .trim_end_matches(['.', ' ']);
    name.to_uppercase().to_lowercase()
}

/// Whether two paths name the same existing folder.
fn same_dir(a: &Path, b: &Path) -> bool {
    match (file_id(a), file_id(b)) {
        (Some(a), Some(b)) => a.same_file(&b),
        _ => false,
    }
}

/// A file's identity, how many names it has, and whether it is a folder.
#[derive(Debug, Clone, Copy)]
struct FileId {
    device: u64,
    index: u64,
    links: u64,
    dir: bool,
}

impl FileId {
    fn same_file(&self, other: &FileId) -> bool {
        self.device == other.device && self.index == other.index
    }
}

#[cfg(unix)]
fn file_id(path: &Path) -> Option<FileId> {
    use std::os::unix::fs::MetadataExt;
    touched(path);
    let meta = std::fs::metadata(path).ok()?;
    Some(FileId {
        device: meta.dev(),
        index: meta.ino(),
        links: meta.nlink(),
        dir: meta.is_dir(),
    })
}

/// The volume serial number and file index, Windows' (device, inode). The
/// handle asks for no access to the contents.
#[cfg(windows)]
fn file_id(path: &Path) -> Option<FileId> {
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_DIRECTORY, FILE_FLAG_BACKUP_SEMANTICS,
        GetFileInformationByHandle,
    };
    touched(path);
    let file = std::fs::OpenOptions::new()
        .access_mode(0)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)
        .ok()?;
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    // SAFETY: the handle is open for the call and `info` is a valid out pointer
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
        return None;
    }
    Some(FileId {
        device: u64::from(info.dwVolumeSerialNumber),
        index: (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow),
        links: u64::from(info.nNumberOfLinks),
        dir: info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0,
    })
}

fn symlink_metadata(path: &Path) -> std::io::Result<std::fs::Metadata> {
    touched(path);
    std::fs::symlink_metadata(path)
}

fn read_link(path: &Path) -> std::io::Result<PathBuf> {
    touched(path);
    std::fs::read_link(path)
}

#[cfg(test)]
thread_local! {
    /// Every path this thread's checks looked at on disk, so a test can show
    /// the real folder was not one of them.
    static TOUCHED: std::cell::RefCell<Vec<PathBuf>> = const { std::cell::RefCell::new(Vec::new()) };
}

fn touched(_path: &Path) {
    #[cfg(test)]
    TOUCHED.with(|t| t.borrow_mut().push(_path.to_path_buf()));
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

    /// The child half of the tests that need the process to exit: builds
    /// `Paths` over `BMT_GUARD_CHILD_ROOT` and uses it as the app would.
    #[test]
    fn guard_child() {
        let (Some(root), Some(config)) = (
            std::env::var_os("BMT_GUARD_CHILD_ROOT"),
            std::env::var_os("BMT_GUARD_CHILD_CONFIG"),
        ) else {
            return;
        };
        let paths = crate::paths::Paths::at_with(PathBuf::from(root), &[PathBuf::from(config)]);
        // Unreachable when the guard works: each of these writes under the root
        match std::env::var("BMT_GUARD_CHILD_USE").as_deref() {
            Ok("log") => crate::log::start(paths, "9.9.9"),
            Ok("database") => {
                use std::io::Write;
                let db = paths.data_file("matches.db").expect("the database path");
                let mut file = std::fs::OpenOptions::new()
                    .append(true)
                    .create(true)
                    .open(db)
                    .unwrap();
                file.write_all(b"written by a lane").unwrap();
            }
            _ => {
                paths.data_dir().ok();
            }
        }
        println!("guard-child: passed the guard");
    }

    /// Runs [`guard_child`] in a child process and asserts the guard ended it.
    fn assert_child_refused(root: &Path, config: &Path, use_as: &str) {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "data_guard::tests::guard_child",
                "--nocapture",
                "--test-threads=1",
            ])
            .env("BMT_GUARD_CHILD_ROOT", root)
            .env("BMT_GUARD_CHILD_CONFIG", config)
            .env("BMT_GUARD_CHILD_USE", use_as)
            .output()
            .expect("run the child");
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert_eq!(
            output.status.code(),
            Some(EXIT_CODE),
            "{use_as}: stderr: {stderr}"
        );
        assert!(
            stderr.contains("refused to start"),
            "{use_as}: stderr: {stderr}"
        );
        assert!(
            stderr.contains("BMT_DATA_ROOT"),
            "{use_as}: stderr: {stderr}"
        );
        assert!(
            !String::from_utf8_lossy(&output.stdout).contains("passed the guard"),
            "{use_as}"
        );
    }

    #[test]
    fn exits_before_creating_anything() {
        let s = Scratch::new("exit");
        assert_child_refused(&s.real(), &s.config(), "data");
        assert!(!s.real().exists(), "nothing was created");
    }

    #[test]
    fn refuses_the_display_name_folder() {
        let s = Scratch::new("display");
        for name in ["Better Mayhem Tracker", "better mayhem tracker"] {
            assert!(trips(&s, &s.config().join(name)), "{name}");
            assert!(trips(&s, &s.config().join(name).join("data")), "{name}");
        }
    }

    /// The root passes, but a folder in it links into the real folder, so
    /// the log or the database would land there.
    #[cfg(unix)]
    #[test]
    fn refuses_a_root_whose_folders_link_into_the_real_folder() {
        use std::os::unix::fs::symlink;
        let s = Scratch::new("subfolders");
        for folder in ["logs", "data"] {
            std::fs::create_dir_all(s.real().join(folder)).unwrap();
        }
        for (folder, use_as) in [("logs", "log"), ("data", "data"), ("data", "database")] {
            let root = s.0.join(format!("run-{use_as}"));
            std::fs::create_dir_all(&root).unwrap();
            symlink(s.real().join(folder), root.join(folder)).unwrap();
            assert!(!trips(&s, &root), "the root itself passes");
            assert_child_refused(&root, &s.config(), use_as);
        }
        assert!(
            !s.real().join("logs").join("main.log").exists(),
            "no log line reached it"
        );
        assert!(
            !s.real().join("data").join("matches.db").exists(),
            "no database reached it"
        );
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_database_file_that_links_into_the_real_folder() {
        use std::os::unix::fs::symlink;
        let s = Scratch::new("dblink");
        std::fs::create_dir_all(s.real().join("data")).unwrap();
        let root = s.0.join("run");
        std::fs::create_dir_all(root.join("data")).unwrap();
        // Dangling: the real database does not exist yet
        symlink(
            s.real().join("data").join("matches.db"),
            root.join("data").join("matches.db"),
        )
        .unwrap();
        assert_child_refused(&root, &s.config(), "database");
        assert!(!s.real().join("data").join("matches.db").exists());
    }

    #[test]
    fn refuses_a_hard_link_to_the_real_database() {
        let s = Scratch::new("hardlink");
        let real_db = s.real().join("data").join("matches.db");
        std::fs::create_dir_all(real_db.parent().unwrap()).unwrap();
        std::fs::write(&real_db, b"the player's matches").unwrap();
        let root = s.0.join("run");
        std::fs::create_dir_all(root.join("data")).unwrap();
        std::fs::hard_link(&real_db, root.join("data").join("matches.db")).unwrap();
        assert!(!trips(&s, &root), "the root itself passes");
        assert_child_refused(&root, &s.config(), "database");
        assert_eq!(std::fs::read(&real_db).unwrap(), b"the player's matches");
    }

    #[test]
    fn passes_a_database_of_its_own() {
        let s = Scratch::new("owndb");
        std::fs::create_dir_all(s.real().join("data")).unwrap();
        std::fs::write(s.real().join("data").join("matches.db"), b"real").unwrap();
        let root = s.0.join("run");
        let paths = crate::paths::Paths::at_with(root.clone(), &[s.config()]);
        let db = paths.data_file("matches.db").unwrap();
        assert_eq!(db, root.join("data").join("matches.db"));
        std::fs::write(&db, b"lane").unwrap();
        assert_eq!(paths.data_file("matches.db").unwrap(), db);
        assert_eq!(
            paths.log_file("main.log").unwrap(),
            root.join("logs").join("main.log")
        );
    }

    /// `/.vol/<device>/<inode>` names a folder by number, so no name in it
    /// says which folder it is.
    #[cfg(target_os = "macos")]
    #[test]
    fn refuses_a_volfs_path() {
        use std::os::unix::fs::MetadataExt;
        let s = Scratch::new("volfs");
        let real_db = s.real().join("data").join("matches.db");
        std::fs::create_dir_all(real_db.parent().unwrap()).unwrap();
        std::fs::write(&real_db, b"the player's matches").unwrap();
        let volfs = |path: &Path| {
            let meta = std::fs::metadata(path).unwrap();
            PathBuf::from(format!("/.vol/{}/{}", meta.dev(), meta.ino()))
        };
        let real = volfs(&s.real());
        assert!(trips(&s, &real), "{}", real.display());
        assert!(trips(&s, &real.join("data")), "{}", real.display());
        for use_as in ["database", "log"] {
            assert_child_refused(&real, &s.config(), use_as);
        }
        assert_eq!(std::fs::read(&real_db).unwrap(), b"the player's matches");
        assert!(!s.real().join("logs").exists(), "no log reached it");
        // A lane never needs volfs, so any folder spelled that way fails
        std::fs::create_dir_all(s.0.join("run")).unwrap();
        assert!(trips(&s, &volfs(&s.0.join("run"))));
    }

    /// A second name for a lane file can be any file of the player's, the
    /// database under the log's name included, so a lane file has one name.
    #[test]
    fn refuses_a_lane_file_with_a_second_name() {
        let s = Scratch::new("second-name");
        let real_files = [
            ("data/matches.db", "the player's matches"),
            ("logs/main.old.log", "the player's old log\n"),
            ("backups/matches-2026-11-01.db", "the player's backup"),
        ];
        for (file, text) in real_files {
            let path = s.real().join(file);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        }
        let elsewhere = s.0.join("elsewhere.db");
        std::fs::write(&elsewhere, b"not the player's").unwrap();
        for (i, (lane, other, use_as)) in [
            ("logs/main.log", s.real().join("logs/main.old.log"), "log"),
            (
                "data/matches.db",
                s.real().join("backups/matches-2026-11-01.db"),
                "database",
            ),
            ("logs/main.log", s.real().join("data/matches.db"), "log"),
            ("data/matches.db", elsewhere.clone(), "database"),
        ]
        .into_iter()
        .enumerate()
        {
            let root = s.0.join(format!("run-{i}"));
            for folder in ["data", "logs"] {
                std::fs::create_dir_all(root.join(folder)).unwrap();
            }
            std::fs::hard_link(&other, root.join(lane)).unwrap();
            assert!(!trips(&s, &root), "the root itself passes");
            assert_child_refused(&root, &s.config(), use_as);
        }
        for (file, text) in real_files {
            assert_eq!(
                std::fs::read_to_string(s.real().join(file)).unwrap(),
                text,
                "{file}"
            );
        }
        assert_eq!(std::fs::read(&elsewhere).unwrap(), b"not the player's");
    }

    /// Every hostile spelling trips, and none makes the check look at the
    /// real folder or anything in it on disk.
    #[cfg(unix)]
    #[test]
    fn never_looks_inside_the_real_folder() {
        use std::os::unix::fs::{MetadataExt, symlink};
        let s = Scratch::new("untouched");
        let home = s.0.join("home-Jos\u{e9}");
        let config = home.join("Library").join("Application Support");
        let real = config.join(DATA_FOLDER);
        std::fs::create_dir_all(real.join("data")).unwrap();
        std::fs::create_dir_all(real.join("logs")).unwrap();
        std::fs::write(real.join("data").join("matches.db"), b"real").unwrap();
        std::fs::create_dir_all(config.join("sub")).unwrap();
        let text = real.to_str().unwrap().to_owned();
        symlink(config.join("sub"), s.0.join("to-sub")).unwrap();
        symlink("better-mayhem-tracker/", config.join("alias")).unwrap();
        symlink(format!("{text}/"), s.0.join("abs-trailing")).unwrap();
        symlink(
            format!(
                "{}/./../better-mayhem-tracker/./",
                config.join("sub").display()
            ),
            s.0.join("messy"),
        )
        .unwrap();
        std::fs::create_dir_all(s.0.join("run")).unwrap();
        symlink(
            "../home-Jose\u{301}/Library/APPLICATION SUPPORT",
            s.0.join("run").join("cfg"),
        )
        .unwrap();
        let meta = std::fs::metadata(&config).unwrap();
        let mut roots = vec![
            real.clone(),
            PathBuf::from(format!("{text}/")),
            PathBuf::from(format!("{text}/./")),
            PathBuf::from(text.replace("/Library/", "//Library//")),
            PathBuf::from(text.replace("Jos\u{e9}", "Jose\u{301}")),
            PathBuf::from(
                text.replace("Jos\u{e9}", "Jose\u{301}")
                    .replace(DATA_FOLDER, "BETTER-MAYHEM-TRACKER"),
            ),
            PathBuf::from(
                text.replace("Library/Application Support", "LIBRARY/APPLICATION SUPPORT"),
            ),
            config.join("better-mayhem-trac\u{212A}er"),
            real.join("data"),
            real.join("data").join("matches.db"),
            PathBuf::from(format!("/.vol/{}/{}/{DATA_FOLDER}", meta.dev(), meta.ino())),
            s.0.join("to-sub").join("..").join(DATA_FOLDER),
            config.join("alias"),
            s.0.join("abs-trailing").join("logs"),
            s.0.join("messy"),
            s.0.join("run")
                .join("cfg")
                .join("Better-Mayhem-Tracker")
                .join("data"),
        ];
        if let Some(rest) = text.strip_prefix("/private/var/") {
            roots.push(PathBuf::from(format!("/var/{rest}")));
        }
        if let Some(rest) = text.strip_prefix("/private/tmp/") {
            roots.push(PathBuf::from(format!("/tmp/{rest}")));
        }
        if Path::new("/System/Volumes/Data").exists() {
            roots.push(PathBuf::from(format!("/System/Volumes/Data{text}")));
        }
        if Path::new("/Volumes/Macintosh HD").exists() {
            roots.push(PathBuf::from(format!("/Volumes/Macintosh HD{text}")));
        }
        let real_id = std::fs::metadata(&real).unwrap();
        let is_real = |m: std::fs::Metadata| m.dev() == real_id.dev() && m.ino() == real_id.ino();
        for root in roots {
            TOUCHED.with(|t| t.borrow_mut().clear());
            assert!(
                check(&root, std::slice::from_ref(&config)).is_err(),
                "{}",
                root.display()
            );
            for path in TOUCHED.with(|t| t.take()) {
                let inside = std::fs::symlink_metadata(&path).is_ok_and(is_real)
                    || path
                        .ancestors()
                        .skip(1)
                        .any(|a| std::fs::metadata(a).is_ok_and(is_real));
                assert!(
                    !inside,
                    "checking {} looked at {} in the real folder",
                    root.display(),
                    path.display()
                );
            }
        }
        // A lane's own root passes, through the identity compare, unseen by it
        std::fs::create_dir_all(s.0.join("run").join("data")).unwrap();
        for root in [s.0.join("run"), s.0.join("run").join("data").join("x.db")] {
            TOUCHED.with(|t| t.borrow_mut().clear());
            assert!(
                check(&root, std::slice::from_ref(&config)).is_ok(),
                "{}",
                root.display()
            );
            for path in TOUCHED.with(|t| t.take()) {
                let seen = std::fs::metadata(&path).is_ok_and(is_real)
                    || path
                        .ancestors()
                        .skip(1)
                        .any(|a| std::fs::metadata(a).is_ok_and(is_real));
                assert!(
                    !seen,
                    "checking {} looked at {}",
                    root.display(),
                    path.display()
                );
            }
        }
    }

    #[cfg(windows)]
    #[test]
    fn refuses_a_stream_suffix_and_trailing_dots() {
        let s = Scratch::new("streams");
        for exists in [false, true] {
            if exists {
                std::fs::create_dir_all(s.real()).unwrap();
            }
            for name in [
                "better-mayhem-tracker::$INDEX_ALLOCATION",
                "better-mayhem-tracker:$I30:$INDEX_ALLOCATION",
                "Better-Mayhem-Tracker.",
                "better-mayhem-tracker. .",
            ] {
                assert!(trips(&s, &s.config().join(name)), "{name} exists={exists}");
            }
            assert!(trips(&s, &s.real().join("data").join("matches.db::$DATA")));
        }
    }

    /// The scratch folder's own drive through `\\localhost\C$` and the other
    /// names this machine answers to.
    #[cfg(windows)]
    #[test]
    fn refuses_an_admin_share_of_this_machine() {
        let s = Scratch::new("share");
        let real = s.real();
        let text = real.to_str().unwrap();
        let local = text.strip_prefix(r"\\?\").unwrap_or(text);
        let (drive, rest) = local.split_once(':').expect("a drive letter");
        let mut servers = vec!["localhost".to_owned(), "127.0.0.1".to_owned()];
        servers.extend(std::env::var("COMPUTERNAME").ok());
        for server in servers {
            for prefix in [r"\\", r"\\?\UNC\"] {
                let root = PathBuf::from(format!("{prefix}{server}\\{drive}${rest}"));
                assert!(trips(&s, &root), "{}", root.display());
            }
        }
    }

    /// Unproven until a Windows runner has run it: the volume must make 8.3
    /// names, which the assertion below reports.
    #[cfg(windows)]
    #[test]
    fn refuses_an_8_3_short_name() {
        use std::os::windows::ffi::{OsStrExt, OsStringExt};
        use windows_sys::Win32::Storage::FileSystem::GetShortPathNameW;
        let s = Scratch::new("short");
        std::fs::create_dir_all(s.real().join("data")).unwrap();
        let wide: Vec<u16> = s.real().as_os_str().encode_wide().chain([0]).collect();
        let mut buf = vec![0u16; 32 * 1024];
        // SAFETY: `wide` is NUL-terminated and `buf` holds `buf.len()` units
        let len = unsafe { GetShortPathNameW(wide.as_ptr(), buf.as_mut_ptr(), buf.len() as u32) };
        assert!(len > 0, "GetShortPathNameW failed");
        let short = PathBuf::from(std::ffi::OsString::from_wide(&buf[..len as usize]));
        let name = short.file_name().unwrap().to_string_lossy().into_owned();
        assert_ne!(
            name, DATA_FOLDER,
            "this volume makes no 8.3 names, so the test cannot run here"
        );
        assert!(trips(&s, &short), "{}", short.display());
        assert!(trips(&s, &short.join("data")), "{}", short.display());
        assert!(
            trips(&s, &short.join("data").join("missing")),
            "{}",
            short.display()
        );
    }
}
