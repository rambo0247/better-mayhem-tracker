//! One running app per user, as Electron's `app.requestSingleInstanceLock()`.
//!
//! The lock is taken before Tauri builds anything. On macOS and Linux it is
//! an `flock` on a file in the user's own temporary folder, and later launches
//! hand their arguments over a socket beside it. On Windows it is a named
//! mutex in the session namespace, and later launches hand their arguments to
//! the window that `tauri-plugin-single-instance` listens on. In both, the
//! kernel drops the lock when the process ends, however it ends.

use std::io;
use std::path::Path;
use std::time::{Duration, Instant};

use tauri::AppHandle;

pub use imp::First;

/// How long a later launch waits for the first to take its arguments, as
/// Chromium's process singleton waits.
pub const HANDOVER_TIMEOUT: Duration = Duration::from_secs(20);

const RETRY: Duration = Duration::from_millis(20);

pub type OnLaunch<R> = fn(&AppHandle<R>, Vec<String>, String) -> Answer;

/// The first instance's answer to a later launch.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Answer {
    /// The later launch exits 0.
    Taken,
    /// This process is on its way out: the later launch waits for the lock
    /// and starts fresh. Windows has no such answer, since the plugin's
    /// window takes every message.
    ShuttingDown,
}

pub enum Claim {
    /// This process holds the lock for the rest of its life.
    First(First),
    /// The first instance took this launch's arguments.
    HandedOver,
    /// Another process holds the lock but took no arguments in time.
    NoAnswer(io::Error),
    /// The lock could not be taken at all, so the launch runs unguarded.
    Unguarded(io::Error),
}

/// Takes the lock named `name`, or hands this launch's arguments to the
/// process that holds it.
pub fn claim(name: &str) -> Claim {
    imp::claim(name, HANDOVER_TIMEOUT)
}

/// Retries `attempt` every 20 ms until it settles the claim or the timeout
/// passes, so a launch that loses the lock in the same instant as the first
/// waits for the first to start listening.
fn retry_until(timeout: Duration, mut attempt: impl FnMut(Instant) -> Option<Claim>) -> Claim {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(claim) = attempt(deadline) {
            return claim;
        }
        if Instant::now() >= deadline {
            return Claim::NoAnswer(io::Error::new(
                io::ErrorKind::TimedOut,
                "the running instance took no arguments",
            ));
        }
        std::thread::sleep(RETRY);
    }
}

/// Electron 1.2.1 opens the same data folder and never sees this lock. Its
/// own is Chromium's process singleton: a `SingletonLock` symlink in its user
/// data folder whose target is `<hostname>-<pid>`. This returns that pid when
/// it names this host and a live process. It only reads the link, which
/// Electron owns.
#[cfg(unix)]
pub fn electron_holder(user_data: &Path) -> Option<i32> {
    let target = std::fs::read_link(user_data.join("SingletonLock")).ok()?;
    let pid = holder_pid(target.to_str()?, &host_name()?)?;
    // SAFETY: signal 0 only checks that the process exists
    let alive = unsafe { libc::kill(pid, 0) } == 0
        || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM);
    alive.then_some(pid)
}

/// Chromium's lock on Windows is a named mutex and an open `lockfile`, not
/// this link, so nothing is read there.
#[cfg(not(unix))]
pub fn electron_holder(_user_data: &Path) -> Option<i32> {
    None
}

/// Chromium splits the target at its last `-`, since a host name may hold one.
#[cfg(unix)]
fn holder_pid(target: &str, host: &str) -> Option<i32> {
    let (name, pid) = target.rsplit_once('-')?;
    let pid: i32 = pid.parse().ok()?;
    (name == host && pid > 0).then_some(pid)
}

#[cfg(unix)]
fn host_name() -> Option<String> {
    let mut buf = [0u8; 256];
    // SAFETY: buf is writable for buf.len() bytes
    if unsafe { libc::gethostname(buf.as_mut_ptr().cast(), buf.len()) } != 0 {
        return None;
    }
    let len = buf.iter().position(|&b| b == 0)?;
    String::from_utf8(buf[..len].to_vec()).ok()
}

#[cfg(unix)]
mod imp {
    use std::fs::{File, OpenOptions, TryLockError};
    use std::io::{self, Read, Write};
    use std::net::Shutdown;
    use std::os::unix::fs::OpenOptionsExt;
    use std::os::unix::net::{UnixListener, UnixStream};
    use std::path::{Path, PathBuf};
    use std::sync::Mutex;
    use std::time::{Duration, Instant};

    use tauri::plugin::{Builder, TauriPlugin};
    use tauri::{AppHandle, RunEvent, Runtime};

    use super::{Claim, OnLaunch, retry_until};

    use super::Answer;

    /// The first instance's answers once it has run the callback. Any answer
    /// but `taken` sends the later launch back to the lock.
    const TAKEN: &[u8] = b"taken";
    const SHUTTING_DOWN: &[u8] = b"shutting down";

    fn answer_bytes(answer: Answer) -> &'static [u8] {
        match answer {
            Answer::Taken => TAKEN,
            Answer::ShuttingDown => SHUTTING_DOWN,
        }
    }

    pub struct First {
        // Never read: holding the file holds the lock
        _lock: File,
        listener: UnixListener,
    }

    pub fn claim(name: &str, timeout: Duration) -> Claim {
        match user_dir() {
            Ok(dir) => claim_in(&dir, name, &handover_message(), timeout),
            Err(error) => Claim::Unguarded(error),
        }
    }

    pub(super) fn claim_in(dir: &Path, name: &str, message: &[u8], timeout: Duration) -> Claim {
        let lock = match OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .open(dir.join(format!("{name}.lock")))
        {
            Ok(lock) => lock,
            Err(error) => return Claim::Unguarded(error),
        };
        let socket = dir.join(format!("{name}.sock"));
        let mut lock = Some(lock);
        retry_until(timeout, |deadline| {
            match lock
                .as_ref()
                .expect("the lock is taken only once")
                .try_lock()
            {
                Ok(()) => Some(listen_on(
                    lock.take().expect("the lock is taken only once"),
                    &socket,
                )),
                Err(TryLockError::Error(error)) => Some(Claim::Unguarded(error)),
                Err(TryLockError::WouldBlock) => hand_over(&socket, message, deadline)
                    .ok()
                    .map(|()| Claim::HandedOver),
            }
        })
    }

    /// Only the lock's holder removes or binds the socket, so a socket left by
    /// a crash is safe to replace.
    fn listen_on(lock: File, socket: &Path) -> Claim {
        if let Err(error) = std::fs::remove_file(socket)
            && error.kind() != io::ErrorKind::NotFound
        {
            return Claim::Unguarded(error);
        }
        match UnixListener::bind(socket) {
            Ok(listener) => Claim::First(First {
                _lock: lock,
                listener,
            }),
            Err(error) => Claim::Unguarded(error),
        }
    }

    fn hand_over(socket: &Path, message: &[u8], deadline: Instant) -> io::Result<()> {
        let mut stream = UnixStream::connect(socket)?;
        let left = deadline.saturating_duration_since(Instant::now());
        stream.set_read_timeout(Some(left.max(Duration::from_millis(1))))?;
        stream.write_all(message)?;
        stream.shutdown(Shutdown::Write)?;
        let mut answer = Vec::new();
        stream.read_to_end(&mut answer)?;
        if answer == TAKEN {
            Ok(())
        } else {
            Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "the running instance closed without taking the arguments",
            ))
        }
    }

    /// `tauri-plugin-single-instance`'s message: the working directory, two
    /// NULs, then the arguments separated by NULs.
    fn handover_message() -> Vec<u8> {
        let cwd = std::env::current_dir().unwrap_or_default();
        let args: Vec<String> = std::env::args_os()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        format!("{}\0\0{}", cwd.to_string_lossy(), args.join("\0")).into_bytes()
    }

    pub(super) fn read_handover(message: &[u8]) -> (Vec<String>, String) {
        let message = String::from_utf8_lossy(message);
        let (cwd, args) = message.split_once("\0\0").unwrap_or_default();
        (args.split('\0').map(String::from).collect(), cwd.to_owned())
    }

    impl First {
        /// Takes later launches' arguments once the event loop runs, so the
        /// main window exists by the time a later launch asks for it. Until
        /// then they wait in the socket's backlog.
        pub fn plugin<R: Runtime>(self, on_launch: OnLaunch<R>) -> TauriPlugin<R> {
            let first = Mutex::new(Some(self));
            Builder::new("single-instance")
                .on_event(move |app, event| {
                    if let RunEvent::Ready = event
                        && let Some(first) = first.lock().expect("single instance").take()
                    {
                        first.serve(app.clone(), on_launch);
                    }
                })
                .build()
        }

        fn serve<R: Runtime>(self, app: AppHandle<R>, on_launch: OnLaunch<R>) {
            std::thread::spawn(move || {
                let _lock = self._lock;
                for stream in self.listener.incoming() {
                    let Ok(mut stream) = stream else { continue };
                    let mut message = Vec::new();
                    let read = stream
                        .set_read_timeout(Some(Duration::from_secs(2)))
                        .and_then(|()| stream.read_to_end(&mut message));
                    if read.is_err() {
                        continue;
                    }
                    let (args, cwd) = read_handover(&message);
                    let answer = on_launch(&app, args, cwd);
                    let _ = stream.write_all(answer_bytes(answer));
                }
            });
        }

        #[cfg(test)]
        pub(super) fn next_handover(&self, answer: Answer) -> (Vec<String>, String) {
            let (mut stream, _) = self.listener.accept().expect("a later launch connects");
            let mut message = Vec::new();
            stream.read_to_end(&mut message).expect("the message");
            stream.write_all(answer_bytes(answer)).expect("the answer");
            read_handover(&message)
        }
    }

    /// The per-user temporary folder, which only this user can write. macOS
    /// gives every user their own under `/var/folders`.
    #[cfg(target_os = "macos")]
    pub(super) fn user_dir() -> io::Result<PathBuf> {
        use std::ffi::OsString;
        use std::os::unix::ffi::OsStringExt;
        let mut buf = vec![0u8; libc::PATH_MAX as usize];
        // SAFETY: buf is writable for buf.len() bytes, and confstr writes at most that many
        let len = unsafe {
            libc::confstr(
                libc::_CS_DARWIN_USER_TEMP_DIR,
                buf.as_mut_ptr().cast(),
                buf.len(),
            )
        };
        if len == 0 || len > buf.len() {
            return Err(io::Error::last_os_error());
        }
        buf.truncate(len - 1);
        Ok(PathBuf::from(OsString::from_vec(buf)))
    }

    #[cfg(not(target_os = "macos"))]
    pub(super) fn user_dir() -> io::Result<PathBuf> {
        std::env::var_os("XDG_RUNTIME_DIR")
            .map(PathBuf::from)
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "XDG_RUNTIME_DIR is not set"))
    }
}

#[cfg(windows)]
mod imp {
    use std::io;
    use std::os::windows::ffi::OsStrExt;
    use std::time::{Duration, Instant};

    use tauri::Runtime;
    use tauri::plugin::TauriPlugin;
    use windows_sys::Win32::Foundation::{CloseHandle, ERROR_ALREADY_EXISTS, GetLastError, HANDLE};
    use windows_sys::Win32::System::DataExchange::COPYDATASTRUCT;
    use windows_sys::Win32::System::Threading::CreateMutexW;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        AllowSetForegroundWindow, FindWindowW, GetWindowThreadProcessId, SMTO_NORMAL,
        SendMessageTimeoutW, WM_COPYDATA,
    };

    use super::{Claim, OnLaunch, retry_until};

    /// The plugin's `WMCOPYDATA_SINGLE_INSTANCE_DATA_NUL`: the working
    /// directory and the arguments, separated by NULs.
    const HANDOVER_DATA: usize = 1543;

    pub struct First {
        // Never closed: the kernel closes it when the process ends
        _mutex: HANDLE,
    }

    pub fn claim(name: &str, timeout: Duration) -> Claim {
        // Local\ is the session namespace, so another signed-in user's
        // instance never holds this one
        let mutex = wide(&format!("Local\\{name}-lock"));
        // The plugin's names for the window it listens on, without its semver feature
        let class = wide(&format!("{name}-sic"));
        let window = wide(&format!("{name}-siw"));
        retry_until(timeout, |deadline| {
            // SAFETY: mutex is a NUL-terminated UTF-16 name
            let handle = unsafe { CreateMutexW(std::ptr::null(), 0, mutex.as_ptr()) };
            if handle.is_null() {
                return Some(Claim::Unguarded(io::Error::last_os_error()));
            }
            // SAFETY: read straight after the call that set it
            if unsafe { GetLastError() } != ERROR_ALREADY_EXISTS {
                return Some(Claim::First(First { _mutex: handle }));
            }
            // SAFETY: handle is the open handle CreateMutexW just returned
            unsafe { CloseHandle(handle) };
            hand_over(&class, &window, deadline).then_some(Claim::HandedOver)
        })
    }

    /// Sends this launch's arguments to the plugin's window, once the first
    /// instance has made it.
    fn hand_over(class: &[u16], window: &[u16], deadline: Instant) -> bool {
        let mut data = std::env::current_dir()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
        for arg in std::env::args_os() {
            data.push('\0');
            data.push_str(&arg.to_string_lossy());
        }
        let message = COPYDATASTRUCT {
            dwData: HANDOVER_DATA,
            cbData: data.len() as u32,
            lpData: data.as_ptr() as _,
        };
        let wait = deadline
            .saturating_duration_since(Instant::now())
            .as_millis()
            .clamp(1, u32::MAX as u128) as u32;
        // SAFETY: class and window are NUL-terminated UTF-16 names, and message
        // and data outlive the synchronous send
        unsafe {
            let hwnd = FindWindowW(class.as_ptr(), window.as_ptr());
            if hwnd.is_null() {
                return false;
            }
            // Windows lets the first instance take the foreground only if
            // this launch, which has it, hands it over
            let mut pid = 0;
            GetWindowThreadProcessId(hwnd, &mut pid);
            if pid != 0 {
                AllowSetForegroundWindow(pid);
            }
            SendMessageTimeoutW(
                hwnd,
                WM_COPYDATA,
                0,
                &message as *const COPYDATASTRUCT as _,
                SMTO_NORMAL,
                wait,
                std::ptr::null_mut(),
            ) != 0
        }
    }

    fn wide(name: &str) -> Vec<u16> {
        std::ffi::OsStr::new(name)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    impl First {
        /// The plugin makes the window later launches send to. Its own mutex
        /// is new here, since this process holds the lock.
        pub fn plugin<R: Runtime>(self, on_launch: OnLaunch<R>) -> TauriPlugin<R> {
            tauri_plugin_single_instance::init(move |app, args, cwd| {
                on_launch(app, args, cwd);
            })
        }
    }
}

#[cfg(test)]
#[cfg(unix)]
mod tests {
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;
    use std::sync::{Arc, Barrier};

    use super::imp::{claim_in, read_handover, user_dir};
    use super::*;

    // Short, so the scratch folder's socket path stays under the 103-byte limit
    const NAME: &str = "bmt";

    fn scratch(test: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("bmt-si-{test}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch folder");
        dir
    }

    fn message(args: &[&str]) -> Vec<u8> {
        format!("/work\0\0{}", args.join("\0")).into_bytes()
    }

    #[test]
    fn a_later_launch_hands_its_arguments_to_the_first() {
        let dir = scratch("handover");
        let Claim::First(first) = claim_in(&dir, NAME, &message(&["bmt"]), HANDOVER_TIMEOUT) else {
            panic!("the first launch takes the lock");
        };
        let server = std::thread::spawn(move || first.next_handover(Answer::Taken));
        let later = claim_in(&dir, NAME, &message(&["bmt", "--hidden"]), HANDOVER_TIMEOUT);
        assert!(matches!(later, Claim::HandedOver));
        assert_eq!(
            server.join().unwrap(),
            (
                vec!["bmt".to_owned(), "--hidden".to_owned()],
                "/work".to_owned()
            )
        );
    }

    #[test]
    fn a_launch_turned_away_while_the_first_shuts_down_starts_fresh() {
        let dir = scratch("shutting-down");
        let Claim::First(first) = claim_in(&dir, NAME, &message(&["bmt"]), HANDOVER_TIMEOUT) else {
            panic!("the first launch takes the lock");
        };
        let server = std::thread::spawn(move || {
            first.next_handover(Answer::ShuttingDown);
            std::thread::sleep(Duration::from_millis(200));
            drop(first);
        });
        let later = claim_in(&dir, NAME, &message(&["bmt"]), HANDOVER_TIMEOUT);
        server.join().unwrap();
        assert!(matches!(later, Claim::First(_)), "the later launch runs");
    }

    #[test]
    fn launches_in_the_same_instant_leave_one_first() {
        let dir = scratch("race");
        let launches = 16;
        let barrier = Arc::new(Barrier::new(launches));
        let claims: Vec<_> = (0..launches)
            .map(|_| {
                let (dir, barrier) = (dir.clone(), barrier.clone());
                std::thread::spawn(move || {
                    barrier.wait();
                    match claim_in(&dir, NAME, &message(&["bmt"]), Duration::from_millis(300)) {
                        Claim::First(first) => {
                            // Hold the lock past every other launch's wait
                            std::thread::sleep(Duration::from_millis(600));
                            drop(first);
                            "first"
                        }
                        Claim::NoAnswer(_) => "no answer",
                        Claim::HandedOver => "handed over",
                        Claim::Unguarded(error) => panic!("unguarded: {error}"),
                    }
                })
            })
            .collect();
        let mut outcomes: Vec<_> = claims.into_iter().map(|c| c.join().unwrap()).collect();
        outcomes.sort();
        assert_eq!(
            outcomes.iter().filter(|o| **o == "first").count(),
            1,
            "{outcomes:?}"
        );
    }

    #[test]
    fn a_socket_left_by_a_crash_does_not_hold_the_lock() {
        let dir = scratch("stale");
        let stale = std::os::unix::net::UnixListener::bind(dir.join(format!("{NAME}.sock")));
        drop(stale.expect("a stale socket"));
        let claim = claim_in(&dir, NAME, &message(&["bmt"]), Duration::from_millis(100));
        assert!(matches!(claim, Claim::First(_)));
    }

    #[test]
    fn the_lock_frees_when_the_first_ends() {
        let dir = scratch("release");
        let first = claim_in(&dir, NAME, &message(&["bmt"]), HANDOVER_TIMEOUT);
        assert!(matches!(first, Claim::First(_)));
        drop(first);
        let next = claim_in(&dir, NAME, &message(&["bmt"]), Duration::from_millis(100));
        assert!(matches!(next, Claim::First(_)));
    }

    #[test]
    fn a_held_lock_with_no_listener_gives_no_answer() {
        let dir = scratch("silent");
        let Claim::First(first) = claim_in(&dir, NAME, &message(&["bmt"]), HANDOVER_TIMEOUT) else {
            panic!("the first launch takes the lock");
        };
        let started = Instant::now();
        let later = claim_in(&dir, NAME, &message(&["bmt"]), Duration::from_millis(200));
        assert!(matches!(later, Claim::NoAnswer(_)));
        assert!(started.elapsed() >= Duration::from_millis(200));
        drop(first);
    }

    #[test]
    fn a_lock_file_this_user_cannot_open_runs_unguarded() {
        let dir = scratch("unreadable");
        let lock = dir.join(format!("{NAME}.lock"));
        std::fs::write(&lock, "").unwrap();
        std::fs::set_permissions(&lock, std::fs::Permissions::from_mode(0o000)).unwrap();
        let claim = claim_in(&dir, NAME, &message(&["bmt"]), Duration::from_millis(100));
        assert!(matches!(claim, Claim::Unguarded(_)));
    }

    #[test]
    fn the_message_reads_back_as_the_plugin_sends_it() {
        assert_eq!(
            read_handover(b"/w\0\0bmt\0--hidden\0"),
            (
                vec!["bmt".into(), "--hidden".into(), String::new()],
                "/w".to_owned()
            )
        );
    }

    #[test]
    fn electrons_lock_names_this_host_and_a_pid() {
        let host = "mac-mini.local";
        assert_eq!(holder_pid("mac-mini.local-4242", host), Some(4242));
        assert_eq!(holder_pid("other-mac.local-4242", host), None);
        assert_eq!(holder_pid("mac-mini.local-0", host), None);
        assert_eq!(holder_pid("mac-mini.local--7", host), None);
        assert_eq!(holder_pid("mac-mini.local", host), None);
        assert_eq!(holder_pid("mac-mini.local-42x", host), None);
    }

    #[test]
    fn a_live_electron_on_the_data_folder_is_found_and_a_dead_one_is_not() {
        let dir = scratch("electron-lock");
        let host = host_name().expect("a host name");
        let link = dir.join("SingletonLock");
        assert_eq!(electron_holder(&dir), None, "no lock");
        std::os::unix::fs::symlink(format!("{host}-{}", std::process::id()), &link).unwrap();
        assert_eq!(electron_holder(&dir), Some(std::process::id() as i32));
        std::fs::remove_file(&link).unwrap();
        let mut ended = std::process::Command::new("true").spawn().unwrap();
        let pid = ended.id();
        ended.wait().unwrap();
        let target = format!("{host}-{pid}");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert_eq!(electron_holder(&dir), None, "a pid that has exited");
        assert_eq!(std::fs::read_link(&link).unwrap(), PathBuf::from(target));
    }

    /// macOS limits a socket path to 103 bytes, which the widest lane name must fit.
    #[test]
    fn the_widest_lane_socket_fits_in_the_user_folder() {
        let dir = user_dir().expect("a per-user folder");
        let widest = format!("com.better-mayhem-tracker.app.{:016x}", u64::MAX);
        assert!(dir.join(format!("{widest}.sock")).as_os_str().len() <= 103);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_lock_lives_in_a_folder_only_this_user_owns() {
        use std::os::unix::fs::MetadataExt;
        let dir = user_dir().expect("a per-user folder");
        assert!(!dir.starts_with("/tmp") && !dir.starts_with("/private/tmp"));
        let meta = std::fs::metadata(&dir).expect("the folder exists");
        // SAFETY: getuid has no preconditions and cannot fail
        assert_eq!(meta.uid(), unsafe { libc::getuid() });
        assert_eq!(meta.mode() & 0o077, 0, "only its owner can enter it");
    }
}
