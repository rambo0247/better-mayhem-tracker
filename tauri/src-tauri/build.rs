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
    app_version();
    // tauri-build links the Common Controls v6 manifest into binaries only, so a
    // test binary that links tauri-plugin-dialog fails to load on Windows
    // (STATUS_ENTRYPOINT_NOT_FOUND). The linker embeds it into every target instead.
    let msvc = std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc");
    let windows = msvc.then(tauri_build::WindowsAttributes::new_without_app_manifest);
    if msvc {
        let manifest = std::env::current_dir()
            .expect("the build script's folder")
            .join("windows-app-manifest.xml");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    }
    let attributes = tauri_build::Attributes::new();
    let attributes = match windows {
        Some(windows) => attributes.windows_attributes(windows),
        None => attributes,
    };
    tauri_build::try_build(attributes).expect("tauri-build failed");
}

/// Electron's `app.getVersion()` is the root package.json's version. Only
/// that string reaches the binary, as `BMT_APP_VERSION`, not the whole file.
fn app_version() {
    let package = "../../package.json";
    println!("cargo::rerun-if-changed={package}");
    let text = std::fs::read_to_string(package).expect("read the root package.json");
    let json: serde_json::Value = serde_json::from_str(&text).expect("package.json is JSON");
    let version = json["version"]
        .as_str()
        .expect("package.json has a version");
    println!("cargo::rustc-env=BMT_APP_VERSION={version}");
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
