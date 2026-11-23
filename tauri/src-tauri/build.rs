fn main() {
    // The context macro embeds ../dist, which only exists after a frontend build
    std::fs::create_dir_all("../dist").expect("create the frontend output folder");
    // parity_driver.rs refuses to compile under it. Cargo names the profile a build
    // inherits from, which no profile setting changes, unlike debug_assertions.
    println!("cargo::rustc-check-cfg=cfg(bmt_release_profile)");
    if std::env::var("PROFILE").as_deref() == Ok("release") {
        println!("cargo::rustc-cfg=bmt_release_profile");
    }
    if std::env::var_os("CARGO_FEATURE_PARITY_DRIVER").is_some() {
        use_parity_identifier();
    }
    tauri_build::build()
}

/// WebKit keeps a webview's storage under `~/Library/WebKit/<bundle id>` and
/// `~/Library/Caches/<bundle id>` whatever HOME says, so a driver build under the
/// app's own identifier would fill the real app's folders. Tauri's build and its
/// context macro both merge TAURI_CONFIG over tauri.conf.json.
fn use_parity_identifier() {
    let mut overlay: serde_json::Value = match std::env::var("TAURI_CONFIG") {
        Ok(text) if !text.trim().is_empty() => {
            serde_json::from_str(&text).expect("TAURI_CONFIG holds JSON")
        }
        _ => serde_json::json!({}),
    };
    overlay["identifier"] = "com.better-mayhem-tracker.parity".into();
    let text = overlay.to_string();
    // SAFETY: the build script sets it before any thread starts
    unsafe { std::env::set_var("TAURI_CONFIG", &text) };
    println!("cargo::rustc-env=TAURI_CONFIG={text}");
}
