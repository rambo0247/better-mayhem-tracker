// Prints the script the updater leaves behind to finish a macOS update, built by the
// updater's own code: this includes tauri/src-tauri/src/mac_update_script.rs as it is,
// so the smoke test cannot drift from what the app writes. It uses only std, so rustc
// builds it alone in a second.
//
// swap-script <pid> <bundle> <staged bundle> <staging dir> <backup> <tmp dir> [relaunch args...]
#![allow(dead_code)]

#[path = "../../tauri/src-tauri/src/mac_update_script.rs"]
mod mac_update_script;

use mac_update_script::{MacSwap, mac_swap_script};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() < 6 {
        eprintln!("usage: swap-script <pid> <bundle> <staged bundle> <staging dir> <backup> <tmp dir> [relaunch args...]");
        std::process::exit(2);
    }
    let swap = MacSwap {
        pid: args[0].parse().expect("a pid"),
        bundle: args[1].clone().into(),
        staged_bundle: args[2].clone().into(),
        staging_dir: args[3].clone().into(),
        backup: args[4].clone().into(),
        tmp_dir: args[5].clone().into(),
        relaunch_args: args[6..].to_vec(),
    };
    print!("{}", mac_swap_script(&swap));
}
