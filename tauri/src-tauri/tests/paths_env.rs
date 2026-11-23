//! One process, two apps, two data roots: `app_builder` reads
//! `BMT_DATA_ROOT` each time it builds, as golden replay relies on per group.
//! Its own test binary, since setting the environment is only sound while no
//! other thread reads it.

use bmt_lib::paths::{Paths, ROOT_OVERRIDE};
use bmt_lib::security::Effects;
use bmt_lib::{Host, commands::Clock};
use tauri::Manager;
use tauri::test::{mock_builder, mock_context, noop_assets};

fn data_dir_of_app_built_over(root: &std::path::Path) -> std::path::PathBuf {
    // SAFETY: this binary's one test is the only thread that reads the environment
    unsafe { std::env::set_var(ROOT_OVERRIDE, root) };
    let host = Host {
        clock: Clock::System,
        effects: Effects::recorded(),
    };
    let app = bmt_lib::app_builder(mock_builder(), host)
        .build(mock_context(noop_assets()))
        .expect("build the mock app");
    app.state::<Paths>().data_dir().expect("the data folder")
}

#[test]
fn each_app_reads_the_root_when_it_is_built() {
    let scratch = std::env::temp_dir().join(format!("bmt-paths-env-{}", std::process::id()));
    let (a, b) = (scratch.join("a"), scratch.join("b"));
    assert_eq!(data_dir_of_app_built_over(&a), a.join("data"));
    assert_eq!(data_dir_of_app_built_over(&b), b.join("data"));
    assert!(a.join("data").is_dir() && b.join("data").is_dir());
    std::fs::remove_dir_all(&scratch).ok();
}
