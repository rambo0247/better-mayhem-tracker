# Vendored crates

## tauri-runtime-wry 3.0.0-alpha.6

This is a copy of the crates.io release (`src/lib.rs` sha256 `7fd848ed…7d61`, upstream commit `81bfb7ca8f1a17be1e48c9b0d167c77b2137f9d3`, `crates/tauri-runtime-wry`), with one change. `Cargo.toml` puts it in place of the registry crate through `[patch.crates-io]`. Its `Cargo.lock` and `.cargo-ok` were left out. Every changed line is marked `PATCHED` in `src/lib.rs`.

**Why.** `Context<T>` derives `Clone` and is declared `Send` and `Sync`. It held `DispatcherMainThreadContext<T>` by value, and that held tao's `EventLoopWindowTarget`. On Windows, the target holds `runner_shared: Rc<EventLoopRunner<T>>` (tao 0.37.3, `platform_impl/windows/event_loop.rs`). Every Tauri handle (`AppHandle`, `Window`, `Webview` and their dispatchers) holds a `Context`, so cloning a handle cloned that `Rc`. The app clones handles on tokio workers, for example the LCU tasks in `src/lcu/mod.rs` that clone themselves into spawned tasks. Those clones raced the main thread's non-atomic count. In a debug build, a lost update aborted the app in `Rc::inc_strong` (`alloc/src/rcs/rc.rs:3944`, "unsafe precondition(s) violated: hint::assert_unchecked must never be called when the condition is false"). The parity driver saw this as an app gone about 10 s after a capture. In a release build, the count goes wrong silently, which is undefined behaviour. macOS is not affected, because tao's macOS target holds no `Rc`.

**The change.** `Context::main_thread` is now `Arc<DispatcherMainThreadContext<T>>`. Cloning a `Context` on any thread copies an atomic count. The `Rc` inside is only reached through `run_threaded` and the event loop, both on the main thread. The event handler holds one `Arc` on the main thread until the process exits, so the last one is not dropped on a worker. A tracing-only line that moved a field out of the context now clones it.

**Test.** `tests/handle_threads.rs` clones a real runtime handle on 17 threads at once, all from one shared handle, for six rounds. Against the registry crate, three rounds aborted the test binary with the message above in three runs of four. Against this copy, six rounds passed in every run.

**Removing it.** Drop the `[patch.crates-io]` entry and this folder once an upstream release holds the main-thread context behind an `Arc`, or stops cloning it with the handle. `tests/handle_threads.rs` should keep passing on that release.
