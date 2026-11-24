//! The app clones Tauri handles on tokio workers (the LCU, sync and live
//! tasks each hold an `AppHandle`). On Windows a clone of tauri-runtime-wry
//! 3.0.0-alpha.6's runtime context also cloned tao's `EventLoopWindowTarget`,
//! whose `Rc<EventLoopRunner>` count is not atomic, so clones on two threads
//! raced it. A debug build aborted in `Rc::inc_strong` ("unsafe precondition(s)
//! violated"), and a release build ran on with the count corrupted. The patched
//! copy in `vendor/tauri-runtime-wry` keeps that context behind an `Arc` (see
//! `vendor/README.md`).
//!
//! This test clones a real runtime's handle on 17 threads at once, all from
//! one shared handle so the raced count starts near zero. A lost update is
//! rare per clone, so it runs rounds. Against the unpatched crate, three rounds
//! aborted the test binary in three runs of four, so six fail it in about 19 of
//! 20. Against the patched crate, no clone touches the `Rc`.
#![cfg(windows)]

use tauri_runtime::{Runtime, RuntimeInitArgs};
use tauri_runtime_wry::{Wry, WryRuntime};

const ROUNDS: usize = 6;
const THREADS: usize = 16;
const CLONES: usize = 2_000_000;

#[test]
fn a_runtime_handle_clones_on_many_threads_at_once() {
    let runtime = WryRuntime::<()>::new_any_thread(RuntimeInitArgs {
        msg_hook: None,
        identifier: "com.better-mayhem-tracker.test".into(),
        custom_schemes: Vec::new(),
        runtime_init_attrs: Wry {},
    })
    .expect("a runtime on the test thread");
    let handle = runtime.handle();
    for _ in 0..ROUNDS {
        // The workers clone from one shared handle, so the count they race starts near the
        // runtime's own few references, where a lost decrement soonest reaches zero
        std::thread::scope(|scope| {
            for _ in 0..THREADS {
                scope.spawn(|| {
                    for _ in 0..CLONES {
                        drop(std::hint::black_box(handle.clone()));
                    }
                });
            }
            // The runtime's own thread clones too, as the main thread does
            for _ in 0..CLONES {
                drop(std::hint::black_box(handle.clone()));
            }
        });
    }
    drop(handle);
    drop(runtime);
}
