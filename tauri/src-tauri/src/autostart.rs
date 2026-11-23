//! `src/main/autostart.ts`: the login item that starts the app hidden in the
//! tray at sign-in. Ported by hand rather than with `tauri-plugin-autostart`
//! (decision E7), so the LaunchAgent and the Run value keep Electron 1.2.1's
//! names and the update leaves a player one entry, not two.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

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

/// One login item write: registered at `target`, or removed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoginItemWrite {
    pub enabled: bool,
    pub target: String,
}

/// Where login items are written.
#[derive(Debug)]
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
    /// A list golden replay compares against Electron's, on any OS.
    Recorded(Mutex<Vec<LoginItemWrite>>),
}

impl LoginItems {
    pub fn recorded() -> Self {
        LoginItems::Recorded(Mutex::new(Vec::new()))
    }

    /// What was recorded since the last call. Always empty for the others.
    pub fn take(&self) -> Vec<LoginItemWrite> {
        match self {
            LoginItems::Recorded(list) => {
                std::mem::take(&mut *list.lock().unwrap_or_else(|p| p.into_inner()))
            }
            _ => Vec::new(),
        }
    }

    /// `writeLoginItem`.
    pub fn write(&self, enabled: bool, target: &str) -> io::Result<()> {
        match self {
            LoginItems::System => write_os(
                || {
                    dirs::home_dir()
                        .map(|home| home.join("Library").join("LaunchAgents"))
                        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "no home folder"))
                },
                RUN_KEY,
                STARTUP_APPROVED_KEY,
                enabled,
                target,
            ),
            LoginItems::At {
                launch_agents,
                run_key,
                approved_key,
            } => write_os(
                || Ok(launch_agents.clone()),
                run_key,
                approved_key,
                enabled,
                target,
            ),
            LoginItems::Recorded(list) => {
                list.lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .push(LoginItemWrite {
                        enabled,
                        target: target.to_owned(),
                    });
                Ok(())
            }
        }
    }
}

pub fn launch_agent_file(launch_agents: &Path) -> PathBuf {
    launch_agents.join(format!("{LAUNCH_AGENT_LABEL}.plist"))
}

fn write_os(
    launch_agents: impl FnOnce() -> io::Result<PathBuf>,
    run_key: &str,
    approved_key: &str,
    enabled: bool,
    target: &str,
) -> io::Result<()> {
    if cfg!(target_os = "macos") {
        let dir = launch_agents()?;
        let file = launch_agent_file(&dir);
        if !enabled {
            return match std::fs::remove_file(&file) {
                Err(err) if err.kind() != io::ErrorKind::NotFound => Err(err),
                _ => Ok(()),
            };
        }
        std::fs::create_dir_all(&dir)?;
        return std::fs::write(file, launch_agent_plist(target));
    }
    #[cfg(windows)]
    run_value::write(run_key, approved_key, enabled, &run_value_data(target));
    #[cfg(not(windows))]
    let _ = (run_key, approved_key);
    Ok(())
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
    let exe = install_location::exec_path()?;
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
        registered.as_str() == Some(&*target)
    } else {
        registered.as_str().is_none_or(str::is_empty)
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
    let enabled = settings::get_setting(conn, "auto_start")?.as_str() == Some("true");
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

    /// The Run value `name` under `run_key`, for tests.
    #[cfg(test)]
    pub fn read(run_key: &str, name: &str) -> Option<String> {
        use windows::Win32::System::Registry::{RRF_RT_REG_SZ, RegGetValueW};
        let mut data = [0u16; 2048];
        let mut size = std::mem::size_of_val(&data) as u32;
        // SAFETY: `size` is the buffer's length in bytes
        let status = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                &HSTRING::from(run_key),
                &HSTRING::from(name),
                RRF_RT_REG_SZ,
                None,
                Some(data.as_mut_ptr().cast()),
                Some(&mut size),
            )
        };
        let len = (size as usize / 2).saturating_sub(1);
        (status == ERROR_SUCCESS).then(|| String::from_utf16_lossy(&data[..len]))
    }

    /// A value as Task Manager leaves one when the player switches the app
    /// off. The real one is binary; only its name matters here.
    #[cfg(test)]
    pub fn seed(key: &str, name: &str, data: &str) {
        Key::create(key)
            .expect("create the scratch key")
            .set_string(name, data);
    }

    #[cfg(test)]
    pub fn remove_tree(path: &str) {
        use windows::Win32::System::Registry::RegDeleteTreeW;
        // SAFETY: the string outlives the call
        let _ = unsafe { RegDeleteTreeW(HKEY_CURRENT_USER, &HSTRING::from(path)) };
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
    use serde_json::Value;

    use super::*;

    const BUNDLE_EXE: &str = "Contents/MacOS/Better Mayhem Tracker";

    fn golden(platform: &str) -> Vec<Value> {
        let golden: Value =
            serde_json::from_str(include_str!("../tests/fixtures/electron-autostart.json"))
                .expect("the golden is JSON");
        golden[platform].as_array().expect("steps").clone()
    }

    fn database() -> Connection {
        let conn = Connection::open_in_memory().expect("an in-memory database");
        crate::db::schema::init_database(&conn, 0).expect("the schema");
        conn
    }

    /// Runs one recorded step through the port and checks `auto_start_path`
    /// ends where Electron's did.
    fn replay(conn: &Connection, items: &LoginItems, platform: &str, step: &Value) {
        let name = step["name"].as_str().expect("a name");
        let target = step["install"].as_str().map(|install| match platform {
            "darwin" => PathBuf::from(format!("{install}/{BUNDLE_EXE}")),
            _ => PathBuf::from(install),
        });
        match step["call"].as_str() {
            Some("sync") => sync(conn, items, target.as_deref()),
            Some("apply") => {
                let enabled = step["enabled"].as_bool().expect("enabled");
                settings::set_setting(conn, "auto_start", &enabled.to_string())
                    .and_then(|()| apply(conn, items, target.as_deref(), enabled))
            }
            other => panic!("{name}: unknown call {other:?}"),
        }
        .expect(name);
        assert_eq!(
            settings::get_setting(conn, AUTO_START_PATH_SETTING)
                .expect("read")
                .as_str()
                .map(str::to_owned),
            step["autoStartPath"].as_str().map(str::to_owned),
            "{name}: auto_start_path"
        );
    }

    #[test]
    fn the_launch_agent_matches_electron_byte_for_byte() {
        let conn = database();
        let items = LoginItems::recorded();
        let mut plist: Option<String> = None;
        for step in golden("darwin") {
            replay(&conn, &items, "darwin", &step);
            for write in items.take() {
                plist = write.enabled.then(|| launch_agent_plist(&write.target));
            }
            assert_eq!(plist.as_deref(), step["plist"].as_str(), "{}", step["name"]);
        }
    }

    #[test]
    fn the_run_value_matches_electron() {
        let conn = database();
        let items = LoginItems::recorded();
        for step in golden("win32") {
            replay(&conn, &items, "win32", &step);
            let calls = step["setLoginItemSettings"].as_array().expect("calls");
            let expected: Vec<LoginItemWrite> = calls
                .iter()
                .map(|call| {
                    assert_eq!(call["name"], RUN_VALUE_NAME);
                    assert_eq!(call["args"], serde_json::json!([HIDDEN_FLAG]));
                    LoginItemWrite {
                        enabled: call["openAtLogin"].as_bool().expect("openAtLogin"),
                        target: call["path"].as_str().expect("path").to_owned(),
                    }
                })
                .collect();
            let writes = items.take();
            assert_eq!(writes, expected, "{}", step["name"]);
            for write in writes {
                // AddQuoteForArg quotes a path with a backslash and leaves --hidden bare
                assert_eq!(
                    run_value_data(&write.target),
                    format!("\"{}\" --hidden", write.target)
                );
            }
        }
    }

    /// The same steps against a real LaunchAgents folder, a scratch one.
    #[cfg(target_os = "macos")]
    #[test]
    fn the_launch_agent_file_follows_electron_in_a_scratch_folder() {
        let dir = std::env::temp_dir().join(format!("bmt-launch-agents-{}", std::process::id()));
        let items = LoginItems::At {
            launch_agents: dir.clone(),
            run_key: String::new(),
            approved_key: String::new(),
        };
        let conn = database();
        for step in golden("darwin") {
            replay(&conn, &items, "darwin", &step);
            let file = std::fs::read_to_string(launch_agent_file(&dir)).ok();
            assert_eq!(file.as_deref(), step["plist"].as_str(), "{}", step["name"]);
        }
        std::fs::remove_dir_all(&dir).expect("remove the scratch folder");
    }

    /// The same steps against scratch HKCU subkeys. Before each step the
    /// StartupApproved value is set, as Task Manager sets it: every write
    /// deletes it, on as well as off, and a step that writes nothing keeps it.
    #[cfg(windows)]
    #[test]
    fn the_run_value_follows_electron_in_scratch_keys() {
        let root = format!(r"Software\bmt-autostart-test-{}", std::process::id());
        let run_key = format!(r"{root}\Run");
        let approved_key = format!(r"{root}\StartupApproved\Run");
        let items = LoginItems::At {
            launch_agents: PathBuf::new(),
            run_key: run_key.clone(),
            approved_key: approved_key.clone(),
        };
        let conn = database();
        let mut expected: Option<String> = None;
        let mut wrote_on = false;
        let mut wrote_off = false;
        for step in golden("win32") {
            let name = step["name"].as_str().expect("a name");
            run_value::seed(&approved_key, RUN_VALUE_NAME, "disabled in Task Manager");
            replay(&conn, &items, "win32", &step);
            let calls = step["setLoginItemSettings"].as_array().expect("calls");
            for call in calls {
                let on = call["openAtLogin"] == true;
                wrote_on |= on;
                wrote_off |= !on;
                expected = on.then(|| run_value_data(call["path"].as_str().expect("path")));
            }
            assert_eq!(
                run_value::read(&run_key, RUN_VALUE_NAME),
                expected,
                "{name}: the Run value"
            );
            assert_eq!(
                run_value::read(&approved_key, RUN_VALUE_NAME).is_some(),
                calls.is_empty(),
                "{name}: the StartupApproved value"
            );
        }
        assert!(wrote_on && wrote_off, "the golden turns the app on and off");
        run_value::remove_tree(&root);
    }

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

    #[cfg(not(bmt_release_profile))]
    #[test]
    fn a_debug_build_registers_nothing() {
        assert_eq!(registered_target(), None);
        assert!(!is_supported());
    }
}
