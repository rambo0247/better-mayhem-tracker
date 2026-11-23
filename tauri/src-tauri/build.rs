fn main() {
    // The context macro embeds ../dist, which only exists after a frontend build
    std::fs::create_dir_all("../dist").expect("create the frontend output folder");
    tauri_build::build()
}
