#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    bmt_lib::webview2::require();
    bmt_lib::run()
}
