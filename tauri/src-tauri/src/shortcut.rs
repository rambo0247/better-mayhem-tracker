//! `src/main/shortcut.ts`: the app's AppUserModelID and the Start Menu
//! shortcut that carries it.
//!
//! Windows groups taskbar entries and attributes notifications by this id,
//! and resolves a pinned taskbar icon against the Start Menu shortcut that
//! carries the same one, so the process and the shortcut must agree.

use std::path::{Path, PathBuf};

use crate::install_location::{self, APP_DISPLAY_NAME};

/// `appId` in package.json's `build`, which Tauri's identifier also is.
#[cfg(not(feature = "parity-driver"))]
pub const APP_USER_MODEL_ID: &str = "com.better-mayhem-tracker.app";
/// A driver build takes the parity identifier, as its Tauri identifier does
/// (build.rs), so it never claims the app's taskbar entries or shortcut, and
/// `run-tauri.ts` finds no production identifier in it.
#[cfg(feature = "parity-driver")]
pub const APP_USER_MODEL_ID: &str = "com.better-mayhem-tracker.parity";

/// `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Better Mayhem Tracker.lnk`
/// for `app_data`, Electron's `app.getPath("appData")`.
pub fn shortcut_path(app_data: &Path) -> PathBuf {
    app_data
        .join("Microsoft")
        .join("Windows")
        .join("Start Menu")
        .join("Programs")
        .join(format!("{APP_DISPLAY_NAME}.lnk"))
}

/// `app.setAppUserModelId`. Without it Windows names the app after its exe.
pub fn set_process_app_id() {
    #[cfg(windows)]
    if let Err(err) = win::set_process_app_id(APP_USER_MODEL_ID) {
        crate::log::error(format!("Failed to set the AppUserModelID: {err}"));
    }
}

/// `ensureStartMenuShortcut`, for the exe this run keeps. A debug build has
/// none, and on macOS there is nothing to do.
pub fn ensure_start_menu_shortcut() {
    if !cfg!(windows) {
        return;
    }
    let (Some(exe), Some(app_data)) = (install_location::portable_exe(), dirs::config_dir()) else {
        return;
    };
    ensure_at(&shortcut_path(&app_data), &exe);
}

/// The shortcut at `link`, rewritten unless it already points at `exe` with
/// this app's id. A missing shortcut only costs pinning, so nothing here
/// fails startup.
pub fn ensure_at(link: &Path, exe: &Path) {
    #[cfg(windows)]
    {
        if let Ok((target, app_id)) = win::read(link)
            && target == exe.to_string_lossy()
            && app_id == APP_USER_MODEL_ID
        {
            return;
        }
        // A fresh profile may not have its Programs folder yet
        if let Some(dir) = link.parent()
            && let Err(err) = std::fs::create_dir_all(dir)
        {
            crate::log::error(format!("Failed to write Start Menu shortcut: {err}"));
            return;
        }
        let cwd = exe.parent().unwrap_or(exe);
        match win::write(link, exe, cwd, APP_DISPLAY_NAME, APP_USER_MODEL_ID) {
            Ok(()) => crate::log::info(format!("Wrote Start Menu shortcut at {}", link.display())),
            Err(_) => crate::log::error(format!(
                "Failed to write Start Menu shortcut at {}",
                link.display()
            )),
        }
    }
    #[cfg(not(windows))]
    let _ = (link, exe);
}

/// What `shell.readShortcutLink` returns of a shortcut: its target and its
/// AppUserModelID.
#[cfg(windows)]
pub fn read_shortcut(link: &Path) -> windows::core::Result<(String, String)> {
    win::read(link)
}

#[cfg(windows)]
mod win {
    use std::mem::ManuallyDrop;
    use std::path::Path;

    use windows::Win32::Foundation::MAX_PATH;
    use windows::Win32::Storage::EnhancedStorage::PKEY_AppUserModel_ID;
    use windows::Win32::System::Com::StructuredStorage::{
        PROPVARIANT, PROPVARIANT_0, PROPVARIANT_0_0, PROPVARIANT_0_0_0,
    };
    use windows::Win32::System::Com::{
        CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx,
        CoUninitialize, IPersistFile, STGM_READ,
    };
    use windows::Win32::System::Variant::VT_LPWSTR;
    use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;
    use windows::Win32::UI::Shell::{
        IShellLinkW, SHCNE_CREATE, SHCNE_UPDATEITEM, SHCNF_FLUSH, SHCNF_PATH, SHChangeNotify,
        SHStrDupW, SLGP_UNCPRIORITY, SetCurrentProcessExplicitAppUserModelID, ShellLink,
    };
    use windows::core::{BSTR, HSTRING, Interface, Result};

    /// `base::win::ScopedCOMInitializer`: balanced only when it took.
    struct Com(bool);

    impl Com {
        fn init() -> Com {
            // SAFETY: no reserved pointer, and the guard balances the call
            Com(unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }.is_ok())
        }
    }

    impl Drop for Com {
        fn drop(&mut self) {
            if self.0 {
                // SAFETY: pairs with the CoInitializeEx that succeeded
                unsafe { CoUninitialize() };
            }
        }
    }

    pub fn set_process_app_id(id: &str) -> Result<()> {
        // SAFETY: the string outlives the call
        unsafe { SetCurrentProcessExplicitAppUserModelID(&HSTRING::from(id)) }
    }

    fn shell_link() -> Result<IShellLinkW> {
        // SAFETY: COM is initialized on this thread by the caller's guard
        unsafe { CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER) }
    }

    /// `ResolveShortcutProperties` for the target and the app id.
    pub fn read(link: &Path) -> Result<(String, String)> {
        let _com = Com::init();
        let shell_link = shell_link()?;
        let mut target = [0u16; MAX_PATH as usize];
        // SAFETY: the buffer and the strings outlive each call
        let app_id = unsafe {
            shell_link
                .cast::<IPersistFile>()?
                .Load(&HSTRING::from(link), STGM_READ)?;
            shell_link.GetPath(&mut target, std::ptr::null_mut(), SLGP_UNCPRIORITY.0 as u32)?;
            shell_link
                .cast::<IPropertyStore>()?
                .GetValue(&PKEY_AppUserModel_ID)?
        };
        let len = target.iter().position(|&c| c == 0).unwrap_or(target.len());
        let app_id = BSTR::try_from(&app_id)
            .map(|id| id.to_string())
            .unwrap_or_default();
        Ok((String::from_utf16_lossy(&target[..len]), app_id))
    }

    /// `InitPropVariantFromString`: the shell reads the id as `VT_LPWSTR`.
    fn string_variant(text: &str) -> Result<PROPVARIANT> {
        // SAFETY: the copy is CoTaskMemAlloc'd, which PROPVARIANT's drop frees
        let copy = unsafe { SHStrDupW(&HSTRING::from(text))? };
        Ok(PROPVARIANT {
            Anonymous: PROPVARIANT_0 {
                Anonymous: ManuallyDrop::new(PROPVARIANT_0_0 {
                    vt: VT_LPWSTR,
                    wReserved1: 0,
                    wReserved2: 0,
                    wReserved3: 0,
                    Anonymous: PROPVARIANT_0_0_0 { pwszVal: copy },
                }),
            },
        })
    }

    /// `CreateOrUpdateShortcutLink` with `kCreateAlways`, as
    /// `shell.writeShortcutLink(link, "create", ...)` calls it.
    pub fn write(
        link: &Path,
        exe: &Path,
        cwd: &Path,
        description: &str,
        app_id: &str,
    ) -> Result<()> {
        let _com = Com::init();
        let existed = link.exists();
        let path = HSTRING::from(link);
        {
            let shell_link = shell_link()?;
            let app_id = string_variant(app_id)?;
            // SAFETY: every string and the variant outlive the calls
            unsafe {
                shell_link.SetPath(&HSTRING::from(exe))?;
                shell_link.SetWorkingDirectory(&HSTRING::from(cwd))?;
                shell_link.SetDescription(&HSTRING::from(description))?;
                let store = shell_link.cast::<IPropertyStore>()?;
                store.SetValue(&PKEY_AppUserModel_ID, &app_id)?;
                store.Commit()?;
                shell_link.cast::<IPersistFile>()?.Save(&path, true)?;
            }
        }
        // Chromium releases the link first, in case the shell reads the file
        // the moment it hears of it
        let event = if existed {
            SHCNE_UPDATEITEM
        } else {
            SHCNE_CREATE
        };
        // SAFETY: HSTRING keeps a terminating null, as SHCNF_PATHW reads, and
        // the path outlives the call, which SHCNF_FLUSH makes synchronous
        unsafe {
            SHChangeNotify(
                event,
                SHCNF_PATH | SHCNF_FLUSH,
                Some(path.as_ptr().cast()),
                None,
            );
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_shortcut_sits_in_the_start_menu_programs_folder() {
        let link = shortcut_path(Path::new("AppData"));
        let parts: Vec<_> = link
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            parts,
            [
                "AppData",
                "Microsoft",
                "Windows",
                "Start Menu",
                "Programs",
                "Better Mayhem Tracker.lnk"
            ]
        );
    }

    /// Writes a real shortcut in a scratch folder and reads it back.
    #[cfg(windows)]
    #[test]
    fn a_written_shortcut_carries_the_target_and_the_id() {
        let dir = std::env::temp_dir().join(format!("bmt-shortcut-{}", std::process::id()));
        let link = shortcut_path(&dir);
        let exe = std::env::current_exe().expect("the test exe");
        ensure_at(&link, &exe);
        let (target, app_id) = read_shortcut(&link).expect("read the shortcut");
        assert_eq!(target, exe.to_string_lossy());
        assert_eq!(app_id, APP_USER_MODEL_ID);
        let written = std::fs::metadata(&link)
            .expect("the shortcut")
            .modified()
            .ok();
        ensure_at(&link, &exe);
        let again = std::fs::metadata(&link)
            .expect("the shortcut")
            .modified()
            .ok();
        assert_eq!(written, again, "a current shortcut is left alone");
        std::fs::remove_dir_all(&dir).expect("remove the scratch folder");
    }
}
