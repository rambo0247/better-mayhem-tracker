//! Windows machines without the WebView2 runtime: the portable exe has no
//! installer to bring it, so say where to get it and exit (decision E8).
#![cfg_attr(not(windows), allow(dead_code))]

pub const DOWNLOAD_URL: &str = "https://developer.microsoft.com/microsoft-edge/webview2/";

const EDGE_UPDATE_CLIENT: &str =
    r"Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";

// The installer writes "0.0.0.0" for a runtime it has removed
pub fn is_usable_version(version: Option<&str>) -> bool {
    version.is_some_and(|v| !v.is_empty() && v != "0.0.0.0")
}

pub fn message() -> String {
    format!(
        "Better Mayhem Tracker needs the Microsoft Edge WebView2 Runtime, which this PC does not have.\n\nDownload it from:\n{DOWNLOAD_URL}\n\nOpen that page now?"
    )
}

#[cfg(windows)]
mod win {
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;

    type Hkey = isize;
    const HKEY_LOCAL_MACHINE: Hkey = 0x8000_0002_u32 as i32 as isize;
    const HKEY_CURRENT_USER: Hkey = 0x8000_0001_u32 as i32 as isize;
    const RRF_RT_REG_SZ: u32 = 0x0000_0002;
    const MB_YESNO: u32 = 0x4;
    const MB_ICONERROR: u32 = 0x10;
    const IDYES: i32 = 6;
    const SW_SHOWNORMAL: i32 = 1;

    #[link(name = "advapi32")]
    unsafe extern "system" {
        fn RegGetValueW(
            hkey: Hkey,
            subkey: *const u16,
            value: *const u16,
            flags: u32,
            kind: *mut u32,
            data: *mut c_void,
            len: *mut u32,
        ) -> i32;
    }

    #[link(name = "user32")]
    unsafe extern "system" {
        fn MessageBoxW(hwnd: isize, text: *const u16, caption: *const u16, kind: u32) -> i32;
    }

    #[link(name = "shell32")]
    unsafe extern "system" {
        fn ShellExecuteW(
            hwnd: isize,
            verb: *const u16,
            file: *const u16,
            params: *const u16,
            dir: *const u16,
            show: i32,
        ) -> isize;
    }

    fn wide(text: &str) -> Vec<u16> {
        std::ffi::OsStr::new(text)
            .encode_wide()
            .chain(Some(0))
            .collect()
    }

    fn read_version(root: Hkey, subkey: &str) -> Option<String> {
        let subkey = wide(subkey);
        let value = wide("pv");
        let mut buf = [0u16; 64];
        let mut len = std::mem::size_of_val(&buf) as u32;
        // SAFETY: every pointer is to a live local, and len is buf's size in bytes
        let status = unsafe {
            RegGetValueW(
                root,
                subkey.as_ptr(),
                value.as_ptr(),
                RRF_RT_REG_SZ,
                std::ptr::null_mut(),
                buf.as_mut_ptr().cast(),
                &mut len,
            )
        };
        if status != 0 {
            return None;
        }
        let chars = (len as usize / 2).saturating_sub(1).min(buf.len());
        Some(String::from_utf16_lossy(&buf[..chars]))
    }

    pub fn installed() -> bool {
        let per_machine = format!(r"SOFTWARE\WOW6432Node\{}", super::EDGE_UPDATE_CLIENT);
        let per_user = format!(r"Software\{}", super::EDGE_UPDATE_CLIENT);
        [
            (HKEY_LOCAL_MACHINE, per_machine),
            (HKEY_CURRENT_USER, per_user),
        ]
        .iter()
        .any(|(root, key)| super::is_usable_version(read_version(*root, key).as_deref()))
    }

    pub fn tell_user() {
        let text = wide(&super::message());
        let caption = wide(crate::PRODUCT_NAME);
        // SAFETY: both strings are NUL-terminated and outlive the call
        let answer =
            unsafe { MessageBoxW(0, text.as_ptr(), caption.as_ptr(), MB_YESNO | MB_ICONERROR) };
        if answer == IDYES {
            let verb = wide("open");
            let url = wide(super::DOWNLOAD_URL);
            // SAFETY: as above, and the null pointers are the optional arguments
            unsafe {
                ShellExecuteW(
                    0,
                    verb.as_ptr(),
                    url.as_ptr(),
                    std::ptr::null(),
                    std::ptr::null(),
                    SW_SHOWNORMAL,
                );
            }
        }
    }
}

/// Exits the process with a message when WebView2 is missing. Does nothing elsewhere.
pub fn require() {
    #[cfg(windows)]
    if !win::installed() {
        win::tell_user();
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_removed_or_absent_runtime_is_unusable() {
        assert!(!is_usable_version(None));
        assert!(!is_usable_version(Some("")));
        assert!(!is_usable_version(Some("0.0.0.0")));
        assert!(is_usable_version(Some("130.0.2849.80")));
    }

    #[test]
    fn the_message_carries_the_download_link() {
        assert!(message().contains(DOWNLOAD_URL));
    }
}
