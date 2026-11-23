//! `src/main/autostart.ts`: the login item that starts the app hidden in the
//! tray at sign-in. Ported by hand rather than with `tauri-plugin-autostart`
//! (decision E7), so the LaunchAgent and the Run value keep Electron 1.2.1's
//! names and the update leaves a player one entry, not two.

use std::io;
use std::path::{Path, PathBuf};

use rusqlite::Connection;

use crate::db::settings;
use crate::shell::HIDDEN_FLAG;
use crate::{install_location, log};

/// `auto_start` holds the player's answer. This holds the target last
/// registered, so a launch can tell whether the entry still points at where
/// the program lives now.
pub const AUTO_START_PATH_SETTING: &str = "auto_start_path";

/// macOS login items can't carry arguments, so the hidden launch would be
/// lost. A per-user LaunchAgent can, and launchd starts it at every sign-in.
pub const LAUNCH_AGENT_LABEL: &str = "com.better-mayhem-tracker.app.autostart";

/// The Run value's name: Electron's `app.getName()`, package.json's `name`.
pub const RUN_VALUE_NAME: &str = "better-mayhem-tracker";

/// Under HKEY_CURRENT_USER, as Electron's `setLoginItemSettings` writes them.
pub const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
pub const STARTUP_APPROVED_KEY: &str =
    r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";

/// Where login items are written.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LoginItems {
    /// The signed-in user's: `~/Library/LaunchAgents` under `HOME`, which is
    /// where Node's `os.homedir()` looks first, and HKCU's Run key.
    System,
    /// Stand-ins for tests: a folder for the LaunchAgent, and HKCU subkeys
    /// for the Run value and its StartupApproved twin.
    At {
        launch_agents: PathBuf,
        run_key: String,
        approved_key: String,
    },
}

impl LoginItems {
    pub fn launch_agent_path(&self) -> io::Result<PathBuf> {
        let dir = match self {
            LoginItems::System => dirs::home_dir()
                .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "no home folder"))?
                .join("Library")
                .join("LaunchAgents"),
            LoginItems::At { launch_agents, .. } => launch_agents.clone(),
        };
        Ok(dir.join(format!("{LAUNCH_AGENT_LABEL}.plist")))
    }

    pub fn run_keys(&self) -> (&str, &str) {
        match self {
            LoginItems::System => (RUN_KEY, STARTUP_APPROVED_KEY),
            LoginItems::At {
                run_key,
                approved_key,
                ..
            } => (run_key, approved_key),
        }
    }

    /// `writeLoginItem`.
    pub fn write(&self, enabled: bool, target: &str) -> io::Result<()> {
        if cfg!(target_os = "macos") {
            let file = self.launch_agent_path()?;
            if !enabled {
                return match std::fs::remove_file(&file) {
                    Err(err) if err.kind() != io::ErrorKind::NotFound => Err(err),
                    _ => Ok(()),
                };
            }
            if let Some(dir) = file.parent() {
                std::fs::create_dir_all(dir)?;
            }
            return std::fs::write(file, launch_agent_plist(target));
        }
        #[cfg(windows)]
        {
            let (run_key, approved_key) = self.run_keys();
            run_value::write(run_key, approved_key, enabled, &run_value_data(target));
        }
        Ok(())
    }
}

/// `xmlEscape`: quotes are left alone, as Electron leaves them.
fn xml_escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// The LaunchAgent, byte for byte as `writeLoginItem` writes it.
pub fn launch_agent_plist(target: &str) -> String {
    [
        r#"<?xml version="1.0" encoding="UTF-8"?>"#,
        r#"<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">"#,
        r#"<plist version="1.0">"#,
        "<dict>",
        "  <key>Label</key>",
        &format!("  <string>{LAUNCH_AGENT_LABEL}</string>"),
        "  <key>ProgramArguments</key>",
        "  <array>",
        &format!("    <string>{}</string>", xml_escape(target)),
        &format!("    <string>{HIDDEN_FLAG}</string>"),
        "  </array>",
        "  <key>RunAtLoad</key>",
        "  <true/>",
        "</dict>",
        "</plist>",
        "",
    ]
    .join("\n")
}

/// Electron's `AddQuoteForArg`, which follows `CommandLineToArgvW`'s rules.
fn quote_for_arg(arg: &str) -> String {
    if !arg.contains([' ', '\\', '"']) {
        return arg.to_owned();
    }
    let chars: Vec<char> = arg.chars().collect();
    let mut out = String::from('"');
    let mut i = 0;
    while i < chars.len() {
        match chars[i] {
            '\\' => {
                let end = chars[i..]
                    .iter()
                    .position(|&c| c != '\\')
                    .map_or(chars.len(), |n| i + n);
                // Backslashes escape only when a quote follows, and the
                // closing quote counts
                let count = if end == chars.len() || chars[end] == '"' {
                    (end - i) * 2
                } else {
                    end - i
                };
                out.extend(std::iter::repeat_n('\\', count));
                i = end;
                continue;
            }
            '"' => out.push_str("\\\""),
            c => out.push(c),
        }
        i += 1;
    }
    out.push('"');
    out
}

/// The Run value's data: Electron's `FormatCommandLineString` over the
/// target and `--hidden`.
pub fn run_value_data(target: &str) -> String {
    let exe = target
        .strip_prefix('"')
        .and_then(|rest| rest.strip_suffix('"'))
        .unwrap_or(target);
    format!("{} {}", quote_for_arg(exe), quote_for_arg(HIDDEN_FLAG))
}

/// What gets registered: the exe on Windows, the executable inside the app
/// bundle on macOS. `None` in a debug build and in any run with no durable
/// copy.
pub fn registered_target() -> Option<PathBuf> {
    if let Some(exe) = install_location::portable_exe() {
        return Some(exe);
    }
    let bundle = install_location::mac_app_bundle()?;
    let exe = std::env::current_exe().ok()?;
    Some(bundle.join("Contents").join("MacOS").join(exe.file_name()?))
}

/// `isAutoStartSupported`: false in a debug build and any run with no
/// durable copy, so Settings says so rather than offering a switch that
/// would quietly do nothing.
pub fn is_supported() -> bool {
    install_location::has_durable_install()
}

/// `applyAutoStart`. Only a read of `auto_start_path` can fail it; a write
/// that fails costs the login item, never the launch, and leaves the
/// recorded path stale so the next start tries again.
pub fn apply(
    conn: &Connection,
    items: &LoginItems,
    target: Option<&Path>,
    enabled: bool,
) -> rusqlite::Result<()> {
    let Some(target) = target else {
        return Ok(());
    };
    let target = target.to_string_lossy();
    let registered = settings::get_setting(conn, AUTO_START_PATH_SETTING)?;
    // Deliberately narrow. On Windows the write also resets the
    // startup-approved value, so rewriting an entry that is already correct
    // would undo a player who switched the app off in Task Manager.
    let current = if enabled {
        registered.as_deref() == Some(&*target)
    } else {
        registered.as_deref().is_none_or(str::is_empty)
    };
    if current {
        return Ok(());
    }
    let written = items.write(enabled, &target).map_err(|err| err.to_string());
    let recorded = written.and_then(|()| {
        let value = if enabled { &*target } else { "" };
        settings::set_setting(conn, AUTO_START_PATH_SETTING, value).map_err(|err| err.to_string())
    });
    if let Err(err) = recorded {
        log::error(format!("Failed to update the login item: {err}"));
    }
    Ok(())
}

/// `syncAutoStart`: a portable exe or an app bundle gets moved and renamed,
/// which leaves the registered path pointing at nothing, so each launch
/// registers it again.
pub fn sync(conn: &Connection, items: &LoginItems, target: Option<&Path>) -> rusqlite::Result<()> {
    let enabled = settings::get_setting(conn, "auto_start")?.as_deref() == Some("true");
    apply(conn, items, target, enabled)
}

#[cfg(windows)]
mod run_value {
    use windows::Win32::Foundation::ERROR_SUCCESS;
    use windows::Win32::System::Registry::{
        HKEY, HKEY_CURRENT_USER, KEY_ALL_ACCESS, REG_OPTION_NON_VOLATILE, REG_SZ, RegCloseKey,
        RegCreateKeyExW, RegDeleteValueW, RegSetValueExW,
    };
    use windows::core::{HSTRING, PCWSTR};

    /// `base::win::RegKey` with `KEY_ALL_ACCESS` creates the key when it is
    /// missing.
    struct Key(HKEY);

    impl Key {
        fn create(path: &str) -> Option<Key> {
            let mut key = HKEY::default();
            // SAFETY: every pointer is to a local that outlives the call
            let status = unsafe {
                RegCreateKeyExW(
                    HKEY_CURRENT_USER,
                    &HSTRING::from(path),
                    None,
                    PCWSTR::null(),
                    REG_OPTION_NON_VOLATILE,
                    KEY_ALL_ACCESS,
                    None,
                    &mut key,
                    None,
                )
            };
            (status == ERROR_SUCCESS).then_some(Key(key))
        }

        fn set_string(&self, name: &str, data: &str) {
            let bytes: Vec<u8> = data
                .encode_utf16()
                .chain(std::iter::once(0))
                .flat_map(u16::to_le_bytes)
                .collect();
            // SAFETY: the key is open and the data outlives the call
            let _ =
                unsafe { RegSetValueExW(self.0, &HSTRING::from(name), None, REG_SZ, Some(&bytes)) };
        }

        fn delete(&self, name: &str) {
            // SAFETY: the key is open
            let _ = unsafe { RegDeleteValueW(self.0, &HSTRING::from(name)) };
        }
    }

    impl Drop for Key {
        fn drop(&mut self) {
            // SAFETY: opened by `create` and closed only here
            let _ = unsafe { RegCloseKey(self.0) };
        }
    }

    /// `Browser::SetLoginItemSettings` with `enabled` left true. It reports
    /// nothing, so a failed write here fails nothing either.
    pub fn write(run_key: &str, approved_key: &str, enabled: bool, data: &str) {
        let run = Key::create(run_key);
        let approved = Key::create(approved_key);
        let name = super::RUN_VALUE_NAME;
        if enabled {
            if let Some(run) = &run {
                run.set_string(name, data);
            }
            if let Some(approved) = &approved {
                approved.delete(name);
            }
        } else {
            if let Some(approved) = &approved {
                approved.delete(name);
            }
            if let Some(run) = &run {
                run.delete(name);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quoting_follows_command_line_to_argv() {
        assert_eq!(quote_for_arg("--hidden"), "--hidden");
        assert_eq!(quote_for_arg(r"C:\a b\x.exe"), r#""C:\a b\x.exe""#);
        assert_eq!(quote_for_arg(r"C:\dir\"), r#""C:\dir\\""#);
        assert_eq!(quote_for_arg(r#"a"b"#), r#""a\"b""#);
        assert_eq!(quote_for_arg(r#"a\"b"#), r#""a\\\"b""#);
        assert_eq!(quote_for_arg(r"a\\b"), r#""a\\b""#);
    }

    #[test]
    fn a_quoted_target_is_quoted_once() {
        assert_eq!(
            run_value_data(r#""C:\Games\BMT.exe""#),
            r#""C:\Games\BMT.exe" --hidden"#
        );
        assert_eq!(
            run_value_data(r"C:\Games\BMT.exe"),
            r#""C:\Games\BMT.exe" --hidden"#
        );
    }

    #[cfg(debug_assertions)]
    #[test]
    fn a_debug_build_registers_nothing() {
        assert_eq!(registered_target(), None);
        assert!(!is_supported());
    }
}
