fn main() {
    // The context macro embeds ../dist, which only exists after a frontend build
    std::fs::create_dir_all("../dist").expect("create the frontend output folder");
    // parity_driver.rs refuses to compile under it. Cargo names the profile a build
    // inherits from, which no profile setting changes, unlike debug_assertions.
    println!("cargo::rustc-check-cfg=cfg(bmt_release_profile)");
    if std::env::var("PROFILE").as_deref() == Ok("release") {
        println!("cargo::rustc-cfg=bmt_release_profile");
    }
    tauri_build::build()
}
