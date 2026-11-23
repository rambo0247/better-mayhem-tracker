//! `src/main/security.ts`: what a page may hand the OS, and where it may go.
//! The CSP lives in `tauri.conf.json`. Nothing here asks the OS for camera,
//! microphone, geolocation or notifications, and wry grants a page none of
//! them on its own, so there is no permission handler to port.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

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
                let result = match &effect {
                    Effect::OpenExternal(url) => tauri_plugin_opener::open_url(url, None::<&str>),
                    Effect::OpenPath(path) => tauri_plugin_opener::open_path(path, None::<&str>),
                };
                // Electron's shell calls resolve or reject with nobody waiting
                if let Err(err) = result {
                    log::error(format!("Failed to open {effect:?}: {err}"));
                }
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

/// A URL can name any protocol the OS will launch, `file:`, a UNC path,
/// `ms-msdt:`. Everything this app opens is a web page, so only those pass.
pub fn is_allowed_external_url(url: &str) -> bool {
    Url::parse(url).is_ok_and(|u| matches!(u.scheme(), "https" | "http"))
}

/// `openExternalUrl`: hands a web page to the default browser, refusing
/// anything else with Electron's warning.
pub fn open_external_url(effects: &Effects, url: &str) -> bool {
    if !is_allowed_external_url(url) {
        log::warn(format!("Refused to open external URL: {url}"));
        return false;
    }
    effects.perform(Effect::OpenExternal(url.to_owned()));
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
    let dev_url = if cfg!(debug_assertions) {
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

    #[test]
    fn only_web_pages_leave_the_app() {
        for url in [
            "https://github.com/rambo0247/better-mayhem-tracker/releases",
            "http://example.com/",
            "HTTPS://EXAMPLE.COM",
        ] {
            assert!(is_allowed_external_url(url), "{url}");
        }
        for url in [
            "file:///etc/passwd",
            "ms-msdt:/id",
            "javascript:alert(1)",
            "//server/share",
            "",
            "not a url",
        ] {
            assert!(!is_allowed_external_url(url), "{url}");
        }
    }

    #[test]
    fn a_refused_url_is_never_handed_on() {
        let effects = Effects::recorded();
        assert!(!open_external_url(&effects, "file:///etc/passwd"));
        assert!(open_external_url(&effects, "https://example.com/"));
        assert_eq!(
            effects.take(),
            vec![Effect::OpenExternal("https://example.com/".into())]
        );
        assert!(effects.take().is_empty());
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
