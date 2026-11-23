//! `src/main/log.ts`: every line the app logs goes to the terminal and is
//! appended to `<root>/logs/main.log`, the file a bug report attaches, as
//! `YYYY-MM-DD HH:MM:SS.mmm LEVEL message` in local time. Written a line at a
//! time and synchronously, so the line that explains a crash is on disk
//! before the crash. Past 2 MiB the file rolls over to `main.old.log`.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

use jiff::ZonedDateTime;
use jiff::civil::DateTime;

use crate::paths::Paths;

pub const MAX_BYTES: u64 = 2 * 1024 * 1024;
pub const FILE_NAME: &str = "main.log";
pub const OLD_FILE_NAME: &str = "main.old.log";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Level {
    Info,
    Warn,
    Error,
    Fatal,
}

impl Level {
    pub fn label(self) -> &'static str {
        match self {
            Level::Info => "INFO",
            Level::Warn => "WARN",
            Level::Error => "ERROR",
            Level::Fatal => "FATAL",
        }
    }
}

/// The open log. A file that cannot be opened or written is never the reason
/// the app cannot run: the line still reaches the terminal.
struct Writer {
    paths: Paths,
    file: Option<File>,
    size: u64,
    /// A rollover that fails, the old file held open by something else, is
    /// not tried again on every line; the log grows until the next launch.
    can_roll_over: bool,
}

impl Writer {
    fn open(paths: Paths) -> Self {
        let mut writer = Self {
            paths,
            file: None,
            size: 0,
            can_roll_over: true,
        };
        writer.reopen();
        writer
    }

    fn log_path(&self, name: &str) -> Option<PathBuf> {
        self.paths.log_file(name).ok()
    }

    fn reopen(&mut self) {
        let file = self
            .log_path(FILE_NAME)
            .and_then(|path| OpenOptions::new().append(true).create(true).open(path).ok());
        self.size = file
            .as_ref()
            .and_then(|f| f.metadata().ok())
            .map_or(0, |m| m.len());
        self.file = file;
    }

    fn roll_over(&mut self) {
        self.file = None;
        let renamed = match (self.log_path(FILE_NAME), self.log_path(OLD_FILE_NAME)) {
            (Some(from), Some(to)) => std::fs::rename(from, to).is_ok(),
            _ => false,
        };
        if !renamed {
            self.can_roll_over = false;
        }
        self.reopen();
    }

    fn write(&mut self, line: &str) {
        if self.file.is_none() {
            return;
        }
        let bytes = line.len() as u64;
        if self.can_roll_over && self.size + bytes > MAX_BYTES {
            self.roll_over();
        }
        if let Some(file) = self.file.as_mut()
            && file.write_all(line.as_bytes()).is_ok()
        {
            self.size += bytes;
        }
    }
}

static LOG: Mutex<Option<Writer>> = Mutex::new(None);

/// `stamp()` in log.ts.
pub fn stamp(at: DateTime) -> String {
    format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02}.{:03}",
        at.year(),
        at.month(),
        at.day(),
        at.hour(),
        at.minute(),
        at.second(),
        at.subsec_nanosecond() / 1_000_000
    )
}

/// Local time as the process sees it, `TZ` included, as `new Date()` does.
fn now() -> DateTime {
    ZonedDateTime::now().datetime()
}

pub fn line(level: Level, message: &str, at: DateTime) -> String {
    format!("{} {} {message}\n", stamp(at), level.label())
}

/// `console.log` and friends: the terminal, then the file once [`start`] ran.
pub fn write(level: Level, message: &str) {
    match level {
        Level::Info => println!("{message}"),
        _ => eprintln!("{message}"),
    }
    append(level, message);
}

fn append(level: Level, message: &str) {
    let text = line(level, message, now());
    let mut log = LOG.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(writer) = log.as_mut() {
        writer.write(&text);
    }
}

pub fn info(message: impl AsRef<str>) {
    write(Level::Info, message.as_ref());
}

pub fn warn(message: impl AsRef<str>) {
    write(Level::Warn, message.as_ref());
}

pub fn error(message: impl AsRef<str>) {
    write(Level::Error, message.as_ref());
}

/// The first line of every launch, which `ci.yml` greps for.
pub fn version_line(version: &str) -> String {
    format!(
        "Better Mayhem Tracker {version}, Tauri {}, {} {}",
        tauri::VERSION,
        os_type(),
        os_release()
    )
}

/// Call once, as early as the process is sure to be the one instance that
/// runs. Writes the version line, and a `FATAL` line for any panic, which
/// then ends the process as it would have anyway.
pub fn start(paths: Paths, version: &str) {
    *LOG.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(Writer::open(paths));
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        // try_lock: a panic inside a write must not wait on its own lock
        if let Ok(mut log) = LOG.try_lock()
            && let Some(writer) = log.as_mut()
        {
            writer.write(&line(Level::Fatal, &info.to_string(), now()));
        }
        previous(info);
    }));
    append(Level::Info, &version_line(version));
}

/// Node's `os.type()`.
fn os_type() -> &'static str {
    match std::env::consts::OS {
        "macos" => "Darwin",
        "windows" => "Windows_NT",
        "linux" => "Linux",
        other => other,
    }
}

/// Node's `os.release()`: the kernel release on Unix, `major.minor.build` on
/// Windows.
#[cfg(unix)]
fn os_release() -> String {
    // SAFETY: uname fills the zeroed struct, and its fields are NUL-terminated
    unsafe {
        let mut name: libc::utsname = std::mem::zeroed();
        if libc::uname(&mut name) != 0 {
            return String::new();
        }
        std::ffi::CStr::from_ptr(name.release.as_ptr())
            .to_string_lossy()
            .into_owned()
    }
}

#[cfg(windows)]
fn os_release() -> String {
    use windows_sys::Wdk::System::SystemServices::RtlGetVersion;
    use windows_sys::Win32::System::SystemInformation::OSVERSIONINFOW;
    // SAFETY: RtlGetVersion fills the struct whose size it is told
    unsafe {
        let mut info: OSVERSIONINFOW = std::mem::zeroed();
        info.dwOSVersionInfoSize = std::mem::size_of::<OSVERSIONINFOW>() as u32;
        if RtlGetVersion(&mut info) != 0 {
            return String::new();
        }
        format!(
            "{}.{}.{}",
            info.dwMajorVersion, info.dwMinorVersion, info.dwBuildNumber
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn at(h: i8, m: i8, s: i8, ms: i32) -> DateTime {
        jiff::civil::date(2026, 11, 22).at(h, m, s, ms * 1_000_000)
    }

    #[test]
    fn a_line_reads_as_electron_writes_it() {
        // The first line of an Electron 1.2.1 log from a T07 baseline run
        let electron = "2026-11-22 21:00:00.000 INFO Better Mayhem Tracker 1.2.1, Electron 44.4.5, Darwin 27.2.0\n";
        let message = "Better Mayhem Tracker 1.2.1, Electron 44.4.5, Darwin 27.2.0";
        assert_eq!(line(Level::Info, message, at(21, 0, 0, 0)), electron);
        assert_eq!(
            line(Level::Warn, "w", at(3, 4, 5, 6)),
            "2026-11-22 03:04:05.006 WARN w\n"
        );
        assert_eq!(
            line(Level::Error, "e", at(23, 59, 59, 999)),
            "2026-11-22 23:59:59.999 ERROR e\n"
        );
    }

    #[test]
    fn the_version_line_keeps_electrons_shape() {
        let line = version_line("1.2.1");
        assert!(
            line.starts_with("Better Mayhem Tracker 1.2.1, Tauri "),
            "{line}"
        );
        let os = line.rsplit(", ").next().unwrap();
        assert!(os.starts_with(os_type()), "{line}");
        assert!(
            os.len() > os_type().len() + 1,
            "{line} names the OS release"
        );
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("bmt-log-{}-{name}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        dir
    }

    #[test]
    fn appends_to_the_log_it_finds() {
        let root = scratch("append");
        std::fs::create_dir_all(root.join("logs")).unwrap();
        std::fs::write(root.join("logs").join(FILE_NAME), "earlier\n").unwrap();
        let mut writer = Writer::open(Paths::at(&root));
        writer.write("later\n");
        assert_eq!(
            std::fs::read_to_string(root.join("logs").join(FILE_NAME)).unwrap(),
            "earlier\nlater\n"
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn rolls_over_at_two_mebibytes() {
        let root = scratch("rollover");
        let mut writer = Writer::open(Paths::at(&root));
        let text = line(Level::Info, &"x".repeat(100), at(12, 0, 0, 0));
        let fits = MAX_BYTES / text.len() as u64;
        for _ in 0..fits {
            writer.write(&text);
        }
        let logs = root.join("logs");
        assert!(
            !logs.join(OLD_FILE_NAME).exists(),
            "{fits} lines fit under the cap"
        );
        writer.write(&text);
        let old = std::fs::metadata(logs.join(OLD_FILE_NAME))
            .expect("the old log")
            .len();
        assert_eq!(old, fits * text.len() as u64);
        assert!(old <= MAX_BYTES);
        assert_eq!(std::fs::read_to_string(logs.join(FILE_NAME)).unwrap(), text);
        std::fs::remove_dir_all(&root).ok();
    }
}
