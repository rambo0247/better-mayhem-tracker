//! The main window's life outside the page: closing to the tray, the hidden
//! launch, a second launch, the Dock's reopen, and quitting, as
//! `src/main/index.ts` runs them.
//!
//! Later units plug in through the hooks on [`Shell`]: T11 reads
//! `minimize_to_tray`, T20 runs the final fetch and stops polling, T11, T17,
//! and T21 close what they opened, and T24 listens for the window being put
//! away and quits through [`request_quit`].
//!
//! Every way out runs the same quit: tray Quit, Cmd+Q, a close with the
//! setting off, the Dock's Quit and logout (AppKit's `terminate:`), and
//! SIGTERM, SIGINT, and SIGHUP or the Windows console's close, as Electron's
//! `app.quit()` runs for each.

use std::ffi::{OsStr, OsString};
use std::future::Future;
use std::hash::{Hash, Hasher};
use std::pin::Pin;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::plugin::TauriPlugin;
use tauri::{AppHandle, Manager, RunEvent, Runtime, Window, WindowEvent};

use crate::WINDOW_LABEL;

/// What the login item passes, from `autostart.ts`: come up in the tray only.
pub const HIDDEN_FLAG: &str = "--hidden";

/// `FINAL_FETCH_TIMEOUT_MS` in `index.ts`.
pub const FINAL_FETCH_TIMEOUT: Duration = Duration::from_millis(5_000);

pub fn launched_hidden<S: AsRef<str>>(args: impl IntoIterator<Item = S>) -> bool {
    args.into_iter().any(|arg| arg.as_ref() == HIDDEN_FLAG)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseDecision {
    /// Keep the app running in the tray.
    HideToTray,
    /// Quit through the final fetch, as the tray's Quit does.
    Quit,
    /// A quit is under way, so the window goes with it.
    Close,
}

/// The window's `close` handler in `index.ts`. Any value but `"false"`,
/// unset included, keeps the app in the tray.
pub fn close_decision(quitting: bool, minimize_to_tray: Option<&str>) -> CloseDecision {
    if quitting {
        CloseDecision::Close
    } else if minimize_to_tray == Some("false") {
        CloseDecision::Quit
    } else {
        CloseDecision::HideToTray
    }
}

/// Where a quit stands. Electron's `isQuitting` is any phase past `Running`,
/// and its `didFinalFetch` is `FinalFetch` or later.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Running,
    FinalFetch,
    Exiting,
}

/// The last sync before exit. Ends with the error text Electron logs.
pub type FinalFetch = Pin<Box<dyn Future<Output = Result<(), String>> + Send>>;

type Setting = Box<dyn Fn() -> Option<String> + Send + Sync>;
/// Returns `None` when the client is not connected, so there is nothing to fetch.
type FinalFetchHook = Box<dyn Fn() -> Option<FinalFetch> + Send + Sync>;
type Once = Box<dyn FnOnce() + Send>;
type Listener = Box<dyn Fn() + Send + Sync>;

#[derive(Default)]
struct Hooks {
    minimize_to_tray: Option<Setting>,
    final_fetch: Option<FinalFetchHook>,
    stop_polling: Vec<Once>,
    will_quit: Vec<Once>,
    put_away: Vec<Listener>,
}

pub struct Shell {
    phase: Mutex<Phase>,
    launched_hidden: bool,
    maximized: AtomicBool,
    minimized: AtomicBool,
    /// AppKit was told `NSTerminateLater` and waits for the quit's answer.
    #[cfg(target_os = "macos")]
    appkit_waiting: AtomicBool,
    log: fn(&str),
    hooks: Mutex<Hooks>,
}

impl Shell {
    pub fn new(launched_hidden: bool, log: fn(&str)) -> Self {
        Self {
            phase: Mutex::new(Phase::Running),
            launched_hidden,
            maximized: AtomicBool::new(false),
            minimized: AtomicBool::new(false),
            #[cfg(target_os = "macos")]
            appkit_waiting: AtomicBool::new(false),
            log,
            hooks: Mutex::new(Hooks::default()),
        }
    }

    pub fn launched_hidden(&self) -> bool {
        self.launched_hidden
    }

    pub fn phase(&self) -> Phase {
        *self.phase.lock().expect("shell phase")
    }

    pub fn is_quitting(&self) -> bool {
        self.phase() != Phase::Running
    }

    fn hooks(&self) -> std::sync::MutexGuard<'_, Hooks> {
        self.hooks.lock().expect("shell hooks")
    }

    /// The `minimize_to_tray` setting, read at each close.
    pub fn read_minimize_to_tray(&self, read: impl Fn() -> Option<String> + Send + Sync + 'static) {
        self.hooks().minimize_to_tray = Some(Box::new(read));
    }

    pub fn final_fetch(&self, fetch: impl Fn() -> Option<FinalFetch> + Send + Sync + 'static) {
        self.hooks().final_fetch = Some(Box::new(fetch));
    }

    /// Runs as the quit leaves `before-quit`, whether or not it fetched.
    pub fn on_stop_polling(&self, stop: impl FnOnce() + Send + 'static) {
        self.hooks().stop_polling.push(Box::new(stop));
    }

    /// Runs after the `Shutting down` line, in the order registered.
    pub fn on_will_quit(&self, close: impl FnOnce() + Send + 'static) {
        self.hooks().will_quit.push(Box::new(close));
    }

    /// Runs when the window hides to the tray or minimizes, Electron's `hide`
    /// and `minimize`.
    pub fn on_put_away(&self, listener: impl Fn() + Send + Sync + 'static) {
        self.hooks().put_away.push(Box::new(listener));
    }

    fn minimize_to_tray(&self) -> Option<String> {
        self.hooks()
            .minimize_to_tray
            .as_ref()
            .and_then(|read| read())
    }

    fn put_away(&self) {
        for listener in &self.hooks().put_away {
            listener();
        }
    }
}

/// Tray Show Window, its double-click, and a second launch. Only the second
/// launch restores a minimized window first, as in Electron.
pub fn show_main<R: Runtime>(app: &AppHandle<R>, restore: bool) {
    let Some(window) = app.get_webview_window(WINDOW_LABEL) else {
        return;
    };
    if restore && window.is_minimized().unwrap_or(false) {
        let _ = window.unminimize();
    }
    let _ = window.show();
    let _ = window.set_focus();
}

/// Electron's `app.quit()`: the bounded final fetch, then `will-quit`, then
/// exit 0. A second call while the fetch runs skips the rest of the wait, as
/// a second `before-quit` does in Electron.
pub fn request_quit<R: Runtime>(app: &AppHandle<R>) {
    match app.state::<Shell>().begin_quit() {
        QuitStep::Nothing => {}
        QuitStep::Finish => exit(app),
        QuitStep::Fetch(fetch) => fetch_then_exit(app, fetch),
    }
}

fn fetch_then_exit<R: Runtime>(app: &AppHandle<R>, fetch: FinalFetch) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        app.state::<Shell>().settle_fetch(fetch).await;
        exit(&app);
    });
}

fn exit<R: Runtime>(app: &AppHandle<R>) {
    let shell = app.state::<Shell>();
    if !shell.finish() {
        return;
    }
    #[cfg(target_os = "macos")]
    if shell.appkit_waiting.swap(false, Ordering::SeqCst) {
        appkit::let_terminate();
        return;
    }
    app.exit(0);
}

/// The fetch has no timeout of its own, and a client that stops answering
/// would otherwise leave the app unable to exit.
async fn bounded(fetch: FinalFetch) -> Result<(), String> {
    tokio::time::timeout(FINAL_FETCH_TIMEOUT, fetch)
        .await
        .unwrap_or_else(|_| Err("timed out".into()))
}

#[must_use]
pub enum QuitStep {
    /// A quit is already leaving.
    Nothing,
    Finish,
    /// Await it with [`Shell::settle_fetch`], then finish.
    Fetch(FinalFetch),
}

impl Shell {
    /// Electron's `before-quit`.
    pub fn begin_quit(&self) -> QuitStep {
        let mut phase = self.phase.lock().expect("shell phase");
        match *phase {
            Phase::Exiting => QuitStep::Nothing,
            Phase::FinalFetch => QuitStep::Finish,
            Phase::Running => {
                let fetch = self.hooks().final_fetch.as_ref().and_then(|start| start());
                let Some(fetch) = fetch else {
                    return QuitStep::Finish;
                };
                *phase = Phase::FinalFetch;
                drop(phase);
                (self.log)("Fetching games before quit...");
                QuitStep::Fetch(fetch)
            }
        }
    }

    pub async fn settle_fetch(&self, fetch: FinalFetch) {
        if let Err(error) = bounded(fetch).await {
            (self.log)(&format!("Final fetch on quit failed: Error: {error}"));
        }
    }

    /// Electron's `will-quit`. True for the one call that should exit.
    pub fn finish(&self) -> bool {
        {
            let mut phase = self.phase.lock().expect("shell phase");
            if *phase == Phase::Exiting {
                return false;
            }
            *phase = Phase::Exiting;
        }
        let (stop_polling, will_quit) = {
            let mut hooks = self.hooks();
            (
                std::mem::take(&mut hooks.stop_polling),
                std::mem::take(&mut hooks.will_quit),
            )
        };
        stop_polling.into_iter().for_each(|stop| stop());
        // A clean exit ends the log on this line, so a log that stops anywhere
        // else stopped in a crash
        (self.log)("Shutting down");
        will_quit.into_iter().for_each(|close| close());
        true
    }
}

pub fn on_window_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    if window.label() != WINDOW_LABEL {
        return;
    }
    let app = window.app_handle();
    let shell = app.state::<Shell>();
    match event {
        WindowEvent::CloseRequested { api, .. } => {
            let setting = shell.minimize_to_tray();
            match close_decision(shell.is_quitting(), setting.as_deref()) {
                CloseDecision::HideToTray => {
                    api.prevent_close();
                    let _ = window.hide();
                    shell.put_away();
                }
                // Electron lets this close go through, so the window is gone
                // while the final fetch runs
                CloseDecision::Quit => {
                    api.prevent_close();
                    let _ = window.hide();
                    request_quit(app);
                }
                CloseDecision::Close => {}
            }
        }
        // Tauri has no maximize or minimize event, so both are read off a resize
        WindowEvent::Resized(_) => {
            let maximized = window.is_maximized().unwrap_or(false);
            if shell.maximized.swap(maximized, Ordering::SeqCst) != maximized {
                crate::events::maximized_changed(app, &maximized);
            }
            let minimized = window.is_minimized().unwrap_or(false);
            if shell.minimized.swap(minimized, Ordering::SeqCst) != minimized && minimized {
                shell.put_away();
            }
        }
        _ => {}
    }
}

pub fn on_run_event<R: Runtime>(app: &AppHandle<R>, event: RunEvent) {
    match event {
        // The window never closes outside a quit, so this is the last window
        // going some other way. Electron's empty `window-all-closed` keeps the
        // app alive then, and so does this.
        RunEvent::ExitRequested {
            code: None, api, ..
        } if app.state::<Shell>().phase() != Phase::Exiting => {
            api.prevent_exit();
        }
        // The Dock icon, Electron's `activate`
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => {
            if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
                let _ = window.show();
            }
        }
        _ => {}
    }
}

/// Registered before any other plugin, so a second launch hands over and
/// exits 0 before it opens anything.
pub fn single_instance<R: Runtime>() -> TauriPlugin<R> {
    tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app, true))
}

/// Electron's lock is per user data folder, and the plugin keys its lock on
/// the identifier. On macOS and Linux that lock is a socket in the shared
/// `/tmp`, so the identifier carries the user id: another user's lock is never
/// this user's. A lane's data root override scopes it to that root, and a
/// driver build with no root takes its own process id, so lanes never hand
/// over to each other.
pub fn scope_identifier(identifier: &str, uid: Option<u32>, data_root: Option<&OsStr>) -> String {
    let mut scoped = identifier.to_owned();
    if let Some(uid) = uid {
        scoped.push_str(&format!(".u{uid}"));
    }
    match data_root {
        Some(root) => {
            let mut hasher = std::collections::hash_map::DefaultHasher::new();
            root.hash(&mut hasher);
            scoped.push_str(&format!(".{:016x}", hasher.finish()));
        }
        None if cfg!(feature = "parity-driver") => {
            scoped.push_str(&format!(".pid{}", std::process::id()));
        }
        None => {}
    }
    scoped
}

pub fn user_id() -> Option<u32> {
    #[cfg(unix)]
    {
        // SAFETY: getuid has no preconditions and cannot fail
        Some(unsafe { libc::getuid() })
    }
    #[cfg(not(unix))]
    {
        None
    }
}

/// The lane override of the data root. Only lane builds compile the read: a
/// release build has no override, as Electron 1.2.1 has none, so no process
/// environment can move a player's lock.
#[cfg(all(
    any(debug_assertions, feature = "parity-driver"),
    not(bmt_release_profile)
))]
pub fn data_root_override() -> Option<OsString> {
    std::env::var_os("BMT_DATA_ROOT")
}

#[cfg(not(all(
    any(debug_assertions, feature = "parity-driver"),
    not(bmt_release_profile)
)))]
pub fn data_root_override() -> Option<OsString> {
    None
}

/// Electron quits through `app.quit()` on SIGTERM, SIGINT, and SIGHUP, and
/// exits 0 once `will-quit` has run, so a stopped app closes its database
/// the same way a Quit does.
pub fn quit_on_signals<R: Runtime>(app: &AppHandle<R>) {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        for kind in [
            SignalKind::terminate(),
            SignalKind::interrupt(),
            SignalKind::hangup(),
        ] {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                match signal(kind) {
                    Ok(mut signals) => {
                        while signals.recv().await.is_some() {
                            request_quit(&app);
                        }
                    }
                    Err(error) => eprintln!("Could not listen for signal {kind:?}: {error}"),
                }
            });
        }
    }
    // The console's Ctrl+C, its close button, logoff, and shutdown. Windows
    // ends the process a few seconds after a close, whatever the quit is doing.
    #[cfg(windows)]
    {
        use tokio::signal::windows;
        macro_rules! quit_on {
            ($($listen:ident),+) => {$(
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    match windows::$listen() {
                        Ok(mut events) => {
                            while events.recv().await.is_some() {
                                request_quit(&app);
                            }
                        }
                        Err(error) => {
                            eprintln!("Could not listen for {}: {error}", stringify!($listen))
                        }
                    }
                });
            )+};
        }
        quit_on!(ctrl_c, ctrl_close, ctrl_logoff, ctrl_shutdown);
    }
}

/// The Dock's Quit, the app's Quit in the Dock menu, and logout send AppKit's
/// `terminate:`, which tao's delegate answers by ending the process at once.
/// Electron runs `before-quit` for them, so this answers
/// `applicationShouldTerminate:` with the same quit, waiting with
/// `NSTerminateLater` while the final fetch runs.
#[cfg(target_os = "macos")]
pub fn quit_on_terminate<R: Runtime>(app: &AppHandle<R>) {
    use objc2_app_kit::NSApplicationTerminateReply as Reply;
    let app = app.clone();
    appkit::answer_terminate(move || {
        let shell = app.state::<Shell>();
        match shell.begin_quit() {
            QuitStep::Nothing => Reply::TerminateNow,
            QuitStep::Finish => {
                shell.finish();
                Reply::TerminateNow
            }
            QuitStep::Fetch(fetch) => {
                shell.appkit_waiting.store(true, Ordering::SeqCst);
                fetch_then_exit(&app, fetch);
                Reply::TerminateLater
            }
        }
    });
}

#[cfg(target_os = "macos")]
mod appkit {
    use std::sync::OnceLock;

    use block2::RcBlock;
    use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
    use objc2::{MainThreadMarker, sel};
    use objc2_app_kit::{NSApplication, NSApplicationTerminateReply};
    use objc2_core_foundation::{CFRunLoop, kCFRunLoopCommonModes};

    type Answer = Box<dyn Fn() -> NSApplicationTerminateReply + Send + Sync>;

    static ANSWER: OnceLock<Answer> = OnceLock::new();

    extern "C-unwind" fn should_terminate(
        _delegate: *mut AnyObject,
        _cmd: Sel,
        _sender: *mut AnyObject,
    ) -> NSApplicationTerminateReply {
        ANSWER
            .get()
            .map_or(NSApplicationTerminateReply::TerminateNow, |answer| answer())
    }

    /// Adds `applicationShouldTerminate:` to tao's delegate class, which has
    /// none, through the public Objective-C runtime.
    pub fn answer_terminate(
        answer: impl Fn() -> NSApplicationTerminateReply + Send + Sync + 'static,
    ) {
        if ANSWER.set(Box::new(answer)).is_err() {
            return;
        }
        let mtm = MainThreadMarker::new().expect("setup runs on the main thread");
        let Some(delegate) = NSApplication::sharedApplication(mtm).delegate() else {
            eprintln!("No app delegate, so the Dock's Quit skips the final fetch");
            return;
        };
        let delegate: &AnyObject = delegate.as_ref();
        let class: *const AnyClass = delegate.class();
        // SAFETY: the signature matches `- (NSApplicationTerminateReply)
        // applicationShouldTerminate:(NSApplication *)sender` ("Q@:@"), and the
        // class is the live delegate's own
        let added = unsafe {
            let imp: Imp = std::mem::transmute::<
                extern "C-unwind" fn(
                    *mut AnyObject,
                    Sel,
                    *mut AnyObject,
                ) -> NSApplicationTerminateReply,
                Imp,
            >(should_terminate);
            objc2::ffi::class_addMethod(
                class.cast_mut(),
                sel!(applicationShouldTerminate:),
                imp,
                c"Q@:@".as_ptr(),
            )
        };
        if !added.as_bool() {
            eprintln!("The app delegate already answers applicationShouldTerminate:");
        }
    }

    /// Answers the waiting `terminate:` with yes, from the main run loop but
    /// outside tao's event handler: AppKit ends the process inside the reply,
    /// through tao's `applicationWillTerminate:`, which takes the handler's
    /// lock. AppKit runs the run loop in its modal panel mode while it waits,
    /// one of the common modes.
    pub fn let_terminate() {
        let Some(main) = CFRunLoop::main() else {
            return;
        };
        let block = RcBlock::new(|| {
            let mtm = MainThreadMarker::new().expect("the main run loop runs on the main thread");
            NSApplication::sharedApplication(mtm).replyToApplicationShouldTerminate(true);
        });
        // SAFETY: CFRunLoopPerformBlock and CFRunLoopWakeUp may be called from
        // any thread, and the common modes constant is a valid mode
        unsafe {
            main.perform_block(kCFRunLoopCommonModes.map(|mode| &**mode), Some(&block));
        }
        main.wake_up();
    }
}

/// Electron's `before-input-event` toggle: F12 everywhere, and Ctrl+Shift+I.
/// The runtime already binds Ctrl+Shift+I off macOS and Cmd+Alt+I on macOS.
/// The macOS View menu owns Cmd+Alt+I, so the page never passes it on to the
/// runtime's binding, which would toggle the devtools a second time.
pub fn devtools_keys_script() -> String {
    let mac = cfg!(target_os = "macos");
    format!(
        r#"(() => {{
  const mac = {mac};
  const toggle = () => window.__TAURI_INTERNALS__.invoke("plugin:webview|internal_toggle_devtools");
  window.addEventListener("keydown", (event) => {{
    if (event.key === "F12" || (mac && event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "i")) toggle();
    else if (mac && event.metaKey && event.altKey && event.code === "KeyI") event.stopImmediatePropagation();
  }}, true);
}})();"#
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn close_hides_to_tray_unless_the_setting_is_false() {
        assert_eq!(close_decision(false, None), CloseDecision::HideToTray);
        assert_eq!(
            close_decision(false, Some("true")),
            CloseDecision::HideToTray
        );
        assert_eq!(close_decision(false, Some("")), CloseDecision::HideToTray);
        assert_eq!(close_decision(false, Some("0")), CloseDecision::HideToTray);
        assert_eq!(close_decision(false, Some("false")), CloseDecision::Quit);
    }

    #[test]
    fn close_during_a_quit_lets_the_window_go() {
        for setting in [None, Some("true"), Some("false")] {
            assert_eq!(close_decision(true, setting), CloseDecision::Close);
        }
    }

    #[test]
    fn hidden_flag_is_an_exact_argument() {
        assert!(launched_hidden([
            "/Applications/Better Mayhem Tracker.app",
            "--hidden"
        ]));
        assert!(!launched_hidden(["app", "--hidden=1", "-hidden"]));
        assert!(!launched_hidden(Vec::<String>::new()));
    }

    const BASE: &str = "com.better-mayhem-tracker.app";

    #[test]
    fn identifier_is_scoped_to_the_data_root() {
        let a = scope_identifier(BASE, Some(501), Some("/tmp/run-a".as_ref()));
        let b = scope_identifier(BASE, Some(501), Some("/tmp/run-b".as_ref()));
        assert_ne!(a, b);
        assert_eq!(
            a,
            scope_identifier(BASE, Some(501), Some("/tmp/run-a".as_ref()))
        );
        assert!(a.starts_with("com.better-mayhem-tracker.app.u501."));
        // The plugin's socket path must stay under 100 bytes, with the widest uid
        let widest = scope_identifier(BASE, Some(u32::MAX), Some("/tmp/run-a".as_ref()));
        assert!(format!("/tmp/{}_si.sock", widest.replace(['.', '-'], "_")).len() < 100);
    }

    #[test]
    fn each_user_gets_their_own_lock() {
        let root = Some("/Users/shared/run".as_ref());
        assert_ne!(
            scope_identifier(BASE, Some(501), root),
            scope_identifier(BASE, Some(502), root)
        );
    }

    #[cfg(not(feature = "parity-driver"))]
    #[test]
    fn identifier_without_a_root_is_per_user_only() {
        assert_eq!(scope_identifier(BASE, None, None), BASE);
        assert_eq!(
            scope_identifier(BASE, Some(501), None),
            "com.better-mayhem-tracker.app.u501"
        );
    }

    #[cfg(unix)]
    #[test]
    fn the_user_id_is_this_process_user() {
        let home = std::env::var_os("HOME").expect("HOME is set");
        use std::os::unix::fs::MetadataExt;
        let owner = std::fs::metadata(home).expect("home exists").uid();
        assert_eq!(user_id(), Some(owner));
    }

    static LINES: Mutex<Vec<String>> = Mutex::new(Vec::new());

    fn recording_shell() -> (Shell, std::sync::Arc<Mutex<Vec<String>>>) {
        let shell = Shell::new(false, |line| LINES.lock().unwrap().push(line.to_owned()));
        (shell, std::sync::Arc::new(Mutex::new(Vec::new())))
    }

    fn record(
        calls: &std::sync::Arc<Mutex<Vec<String>>>,
        name: &str,
    ) -> impl FnOnce() + Send + use<> {
        let calls = calls.clone();
        let name = name.to_owned();
        move || calls.lock().unwrap().push(name)
    }

    #[test]
    fn quit_without_a_client_skips_the_fetch_and_shuts_down_in_order() {
        let (shell, calls) = recording_shell();
        shell.final_fetch(|| None);
        shell.on_will_quit(record(&calls, "stop live"));
        shell.on_stop_polling(record(&calls, "stop polling"));
        shell.on_will_quit(record(&calls, "close db"));
        assert!(matches!(shell.begin_quit(), QuitStep::Finish));
        assert!(shell.finish());
        assert_eq!(shell.phase(), Phase::Exiting);
        assert_eq!(
            *calls.lock().unwrap(),
            ["stop polling", "stop live", "close db"]
        );
        assert!(matches!(shell.begin_quit(), QuitStep::Nothing));
        assert!(!shell.finish(), "a second quit runs nothing again");
        assert_eq!(calls.lock().unwrap().len(), 3);
    }

    #[tokio::test(start_paused = true)]
    async fn quit_with_a_client_runs_the_fetch_first() {
        let (shell, calls) = recording_shell();
        let fetched = calls.clone();
        shell.final_fetch(move || {
            let fetched = fetched.clone();
            Some(Box::pin(async move {
                fetched.lock().unwrap().push("fetch".into());
                Ok(())
            }))
        });
        shell.on_will_quit(record(&calls, "close db"));
        let QuitStep::Fetch(fetch) = shell.begin_quit() else {
            panic!("expected the final fetch");
        };
        assert!(shell.is_quitting());
        assert!(calls.lock().unwrap().is_empty());
        shell.settle_fetch(fetch).await;
        assert!(shell.finish());
        assert_eq!(*calls.lock().unwrap(), ["fetch", "close db"]);
    }

    #[tokio::test(start_paused = true)]
    async fn a_hung_client_is_given_up_on_after_five_seconds() {
        let (shell, _) = recording_shell();
        shell.final_fetch(|| Some(Box::pin(std::future::pending())));
        let QuitStep::Fetch(fetch) = shell.begin_quit() else {
            panic!("expected the final fetch");
        };
        let started = tokio::time::Instant::now();
        shell.settle_fetch(fetch).await;
        assert_eq!(started.elapsed(), FINAL_FETCH_TIMEOUT);
        let lines = LINES.lock().unwrap();
        assert!(lines.iter().any(|l| l == "Fetching games before quit..."));
        assert!(
            lines
                .iter()
                .any(|l| l == "Final fetch on quit failed: Error: timed out")
        );
    }

    #[test]
    fn a_second_quit_during_the_fetch_exits_at_once() {
        let (shell, _) = recording_shell();
        shell.final_fetch(|| Some(Box::pin(std::future::pending())));
        assert!(matches!(shell.begin_quit(), QuitStep::Fetch(_)));
        assert_eq!(shell.phase(), Phase::FinalFetch);
        assert!(matches!(shell.begin_quit(), QuitStep::Finish));
        assert!(shell.finish());
    }

    #[tokio::test(start_paused = true)]
    async fn the_final_fetch_gives_up_after_five_seconds() {
        let started = tokio::time::Instant::now();
        let outcome = bounded(Box::pin(std::future::pending())).await;
        assert_eq!(outcome, Err("timed out".to_owned()));
        assert_eq!(started.elapsed(), Duration::from_secs(5));
        let failed = bounded(Box::pin(async { Err("refused".to_owned()) })).await;
        assert_eq!(failed, Err("refused".to_owned()));
    }
}
