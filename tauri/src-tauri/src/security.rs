//! `src/main/security.ts`: what a page may hand the OS, and where it may go.
//! The CSP lives in `tauri.conf.json`. Nothing here asks the OS for camera,
//! microphone, geolocation or notifications, and wry grants a page none of
//! them on its own, so there is no permission handler to port.

use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, SyncSender, TrySendError};
use std::sync::{Mutex, OnceLock};

use tauri::{Manager, Runtime, Url, WebviewWindowBuilder, webview::NewWindowResponse};

use crate::log;

/// A request this app made of the OS shell.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Effect {
    OpenExternal(String),
    OpenPath(PathBuf),
}

/// Where OS shell requests go: the OS, or a list golden replay compares
/// against the effects Electron's seam recorded, so a replay never opens a
/// browser or a Finder window.
#[derive(Debug)]
pub enum Effects {
    System,
    Recorded(Mutex<Vec<Effect>>),
}

impl Effects {
    pub fn recorded() -> Self {
        Effects::Recorded(Mutex::new(Vec::new()))
    }

    fn perform(&self, effect: Effect) {
        match self {
            Effects::System => {
                system_opener().submit(effect);
            }
            Effects::Recorded(list) => list.lock().unwrap_or_else(|p| p.into_inner()).push(effect),
        }
    }

    /// `shell.openPath`.
    pub fn open_path(&self, path: &Path) {
        self.perform(Effect::OpenPath(path.to_path_buf()));
    }

    /// What was recorded since the last call. Always empty for the OS.
    pub fn take(&self) -> Vec<Effect> {
        match self {
            Effects::System => Vec::new(),
            Effects::Recorded(list) => {
                std::mem::take(&mut *list.lock().unwrap_or_else(|p| p.into_inner()))
            }
        }
    }
}

/// Opens waiting behind the one with the OS before more are dropped.
const OPEN_QUEUE: usize = 32;

/// One thread that hands effects to the OS one at a time, in the order they
/// were asked for. The opener waits for the OS (`/usr/bin/open` on macOS) to
/// finish, and a navigation handler runs on the main thread, so the OS call
/// happens here. Electron's shell calls resolve or reject with nobody waiting.
struct Opener(SyncSender<Effect>);

impl Opener {
    fn start(open: fn(&Effect) -> Result<(), String>) -> Self {
        let (queue, pending) = mpsc::sync_channel::<Effect>(OPEN_QUEUE);
        let spawned = std::thread::Builder::new()
            .name("open-external".into())
            .spawn(move || {
                for effect in pending {
                    if let Err(err) = open(&effect) {
                        log::error(format!("Failed to open {effect:?}: {err}"));
                    }
                }
            });
        if let Err(err) = spawned {
            log::error(format!("Failed to start the opener thread: {err}"));
        }
        Self(queue)
    }

    /// Queues `effect`, or logs and drops it when the queue is full.
    fn submit(&self, effect: Effect) -> bool {
        match self.0.try_send(effect) {
            Ok(()) => true,
            Err(TrySendError::Full(effect)) => {
                log::warn(format!(
                    "Dropped {effect:?}: {OPEN_QUEUE} opens are already waiting"
                ));
                false
            }
            Err(TrySendError::Disconnected(effect)) => {
                log::error(format!(
                    "Failed to open {effect:?}: the opener thread is not running"
                ));
                false
            }
        }
    }
}

fn system_opener() -> &'static Opener {
    static SYSTEM: OnceLock<Opener> = OnceLock::new();
    SYSTEM.get_or_init(|| Opener::start(open_with_os))
}

fn open_with_os(effect: &Effect) -> Result<(), String> {
    match effect {
        Effect::OpenExternal(url) => tauri_plugin_opener::open_url(url, None::<&str>),
        Effect::OpenPath(path) => tauri_plugin_opener::open_path(path, None::<&str>),
    }
    .map_err(|err| err.to_string())
}

/// A URL can name any protocol the OS will launch, `file:`, a UNC path,
/// `ms-msdt:`. Everything this app opens is a web page, so only those pass,
/// parsed the way the URL standard parses them.
fn web_page(url: &str) -> Option<Url> {
    Url::parse(url)
        .ok()
        .filter(|u| matches!(u.scheme(), "https" | "http"))
}

/// `openExternalUrl`: hands a web page to the default browser, refusing
/// anything else with Electron's warning. The browser gets the parsed URL,
/// as Electron's `shell.openExternal` hands the OS its GURL spelling, so
/// `" https://x"` or `"https:\\\\x"` opens `https://x/` and never reaches
/// the OS as a string it would read another way.
pub fn open_external_url(effects: &Effects, url: &str) -> bool {
    let Some(page) = web_page(url) else {
        log::warn(format!("Refused to open external URL: {url}"));
        return false;
    };
    effects.perform(Effect::OpenExternal(page.into()));
    true
}

/// The pages this app hosts: its own bundle on `tauri://localhost` (macOS) or
/// `http://tauri.localhost` (Windows), the dev server in a debug build, and
/// the parity driver's renderer. In-app routing changes the hash and never
/// navigates, so any other navigation is an escape.
fn is_internal_url(url: &Url, dev_url: Option<&Url>) -> bool {
    if url.as_str() == "about:blank" {
        return true;
    }
    if dev_url.is_some_and(|dev| url.origin() == dev.origin()) {
        return true;
    }
    let app = matches!(
        (url.scheme(), url.host_str()),
        ("tauri", Some("localhost")) | ("http" | "https", Some("tauri.localhost"))
    );
    let parity = matches!(
        (url.scheme(), url.host_str()),
        ("parity", Some("localhost")) | ("http", Some("parity.localhost"))
    );
    app || (parity && cfg!(feature = "parity-driver"))
}

/// Applies the policy to a window before it is built: navigation stays on
/// the app's own pages, and anything else, or a link that would open a new
/// window, goes to the default browser if it is a web page.
pub fn harden<'a, R: Runtime, M: Manager<R>>(
    builder: WebviewWindowBuilder<'a, R, M>,
    app: &tauri::AppHandle<R>,
) -> WebviewWindowBuilder<'a, R, M> {
    let dev_url = if cfg!(not(bmt_release_profile)) {
        app.config().build.dev_url.clone()
    } else {
        None
    };
    let navigating = app.clone();
    let opening = app.clone();
    builder
        .on_navigation(move |url| {
            if is_internal_url(url, dev_url.as_ref()) {
                return true;
            }
            open_external_url(&navigating.state::<Effects>(), url.as_str());
            false
        })
        .on_new_window(move |url, _features| {
            open_external_url(&opening.state::<Effects>(), url.as_str());
            NewWindowResponse::Deny
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What reaches the browser for each URL a page can send, `None` for a
    /// refusal. The expected text is the WHATWG parse Node 24 gives
    /// (`new URL(u).href`), which is what Electron's GURL hands the OS for
    /// these inputs.
    #[test]
    fn the_browser_gets_the_parsed_url() {
        let corpus: &[(&str, Option<&str>)] = &[
            (
                "https://github.com/rambo0247/better-mayhem-tracker/releases",
                Some("https://github.com/rambo0247/better-mayhem-tracker/releases"),
            ),
            ("http://example.com/", Some("http://example.com/")),
            ("HTTPS://EXAMPLE.COM", Some("https://example.com/")),
            (" https://example.com", Some("https://example.com/")),
            ("\thttps://example.com", Some("https://example.com/")),
            ("h\tttps://example.com", Some("https://example.com/")),
            ("https://example.com\n", Some("https://example.com/")),
            ("\u{0}https://example.com", Some("https://example.com/")),
            ("\u{1f}https://example.com", Some("https://example.com/")),
            ("https:example.com", Some("https://example.com/")),
            ("https:\\\\evil.com", Some("https://evil.com/")),
            ("https:/\\evil.com", Some("https://evil.com/")),
            ("https:///evil.com", Some("https://evil.com/")),
            ("https://user@evil.com", Some("https://user@evil.com/")),
            ("https://example.com/\u{0}", Some("https://example.com/")),
            (
                "https://\u{43f}\u{440}\u{438}\u{43c}\u{435}\u{440}.\u{440}\u{444}/",
                Some("https://xn--e1afmkfd.xn--p1ai/"),
            ),
            ("http://0x7f.1/", Some("http://127.0.0.1/")),
            ("https://ex\u{ad}ample.com", Some("https://example.com/")),
            ("javascript:alert(1)", None),
            ("JAVASCRIPT:alert(1)", None),
            ("file:///etc/passwd", None),
            ("FILE:///C:/Windows/System32/calc.exe", None),
            ("ms-msdt:/id", None),
            ("vscode://file/etc/passwd", None),
            ("tauri://localhost/", None),
            ("data:text/html,<script>alert(1)</script>", None),
            ("blob:https://x/uuid", None),
            ("view-source:https://x", None),
            ("about:blank", None),
            ("ftp://x", None),
            ("//server/share", None),
            ("\\\\server\\share", None),
            ("C:\\Windows\\System32\\calc.exe", None),
            ("https://", None),
            ("https://%zz", None),
            ("https://exa mple.com", None),
            ("https://example.com:99999", None),
            ("", None),
            ("not a url", None),
        ];
        for (url, expected) in corpus {
            let effects = Effects::recorded();
            let opened = open_external_url(&effects, url);
            let handed = effects.take();
            match expected {
                Some(page) => {
                    assert!(opened, "{url:?}");
                    assert_eq!(
                        handed,
                        vec![Effect::OpenExternal((*page).into())],
                        "{url:?}"
                    );
                }
                None => {
                    assert!(!opened, "{url:?}");
                    assert!(handed.is_empty(), "{url:?}");
                }
            }
        }
    }

    /// The opener blocks until the test lets it go; the call must return
    /// first, as a navigation handler on the main thread has to.
    #[test]
    fn opening_returns_before_the_os_does() {
        use std::sync::mpsc;
        use std::time::Duration;
        static RELEASE: Mutex<Option<mpsc::Receiver<()>>> = Mutex::new(None);
        static OPENED: Mutex<Option<mpsc::Sender<Effect>>> = Mutex::new(None);
        fn blocking_open(effect: &Effect) -> Result<(), String> {
            let release = RELEASE.lock().unwrap().take().expect("one open");
            release.recv().map_err(|e| e.to_string())?;
            OPENED
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .send(effect.clone())
                .unwrap();
            Ok(())
        }
        let (release, waiting) = mpsc::channel();
        let (opened_tx, opened) = mpsc::channel();
        *RELEASE.lock().unwrap() = Some(waiting);
        *OPENED.lock().unwrap() = Some(opened_tx);
        let (returned_tx, returned) = mpsc::channel();
        std::thread::spawn(move || {
            Opener::start(blocking_open)
                .submit(Effect::OpenExternal("https://example.com/".into()));
            returned_tx.send(()).unwrap();
        });
        returned
            .recv_timeout(Duration::from_secs(5))
            .expect("the call should return while the opener still waits");
        assert!(opened.try_recv().is_err(), "the opener has not finished");
        release.send(()).unwrap();
        assert_eq!(
            opened.recv_timeout(Duration::from_secs(5)).unwrap(),
            Effect::OpenExternal("https://example.com/".into())
        );
    }

    /// A page can ask for opens faster than the OS serves them. They run one
    /// at a time in the order asked, and past a full queue they are dropped.
    #[test]
    fn opens_run_in_order_and_a_burst_past_the_queue_is_dropped() {
        use std::sync::Condvar;
        use std::time::{Duration, Instant};
        static GATE: (Mutex<bool>, Condvar) = (Mutex::new(false), Condvar::new());
        static OPENED: (Mutex<Vec<String>>, Condvar) = (Mutex::new(Vec::new()), Condvar::new());
        static STARTED: (Mutex<usize>, Condvar) = (Mutex::new(0), Condvar::new());
        fn gated_open(effect: &Effect) -> Result<(), String> {
            *STARTED.0.lock().unwrap() += 1;
            STARTED.1.notify_all();
            let mut open = GATE.0.lock().unwrap();
            while !*open {
                open = GATE.1.wait(open).unwrap();
            }
            drop(open);
            let Effect::OpenExternal(url) = effect else {
                return Err("not a URL".into());
            };
            OPENED.0.lock().unwrap().push(url.clone());
            OPENED.1.notify_all();
            Ok(())
        }
        let url = |i: usize| format!("https://example.com/{i}");
        let opener = Opener::start(gated_open);
        assert!(opener.submit(Effect::OpenExternal(url(0))));
        let started = STARTED.0.lock().unwrap();
        let (started, _) = STARTED
            .1
            .wait_timeout_while(started, Duration::from_secs(5), |n| *n == 0)
            .unwrap();
        assert_eq!(*started, 1, "the first open is with the OS");
        drop(started);
        let queued: Vec<bool> = (1..100)
            .map(|i| opener.submit(Effect::OpenExternal(url(i))))
            .collect();
        assert_eq!(queued.iter().filter(|q| **q).count(), OPEN_QUEUE);
        assert!(
            queued[..OPEN_QUEUE].iter().all(|q| *q),
            "the first ones wait"
        );
        *GATE.0.lock().unwrap() = true;
        GATE.1.notify_all();
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut opened = OPENED.0.lock().unwrap();
        while opened.len() < 1 + OPEN_QUEUE && Instant::now() < deadline {
            opened = OPENED
                .1
                .wait_timeout(opened, Duration::from_millis(50))
                .unwrap()
                .0;
        }
        drop(opened);
        // Anything past the queue would open within this
        std::thread::sleep(Duration::from_millis(300));
        let expected: Vec<String> = (0..=OPEN_QUEUE).map(url).collect();
        assert_eq!(*OPENED.0.lock().unwrap(), expected);
        assert_eq!(
            *STARTED.0.lock().unwrap(),
            1 + OPEN_QUEUE,
            "the rest never ran"
        );
    }

    #[test]
    fn navigation_stays_on_the_apps_own_pages() {
        let url = |s: &str| Url::parse(s).unwrap();
        let dev = url("http://localhost:1420/");
        for inside in [
            "tauri://localhost/index.html#/matches",
            "http://tauri.localhost/",
            "about:blank",
            "http://localhost:1420/#/",
        ] {
            assert!(is_internal_url(&url(inside), Some(&dev)), "{inside}");
        }
        for outside in [
            "https://example.com/",
            "http://localhost:1421/",
            "file:///etc/passwd",
            "https://tauri.localhost.evil.com/",
        ] {
            assert!(!is_internal_url(&url(outside), Some(&dev)), "{outside}");
        }
        assert!(
            !is_internal_url(&url("http://localhost:1420/"), None),
            "no dev server in a release build"
        );
    }
}
