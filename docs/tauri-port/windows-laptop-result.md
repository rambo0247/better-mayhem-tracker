# Windows parity on the operator's laptop: result

**The Windows parity report passes.** `report.ts check` exits 0: all 109 states pass under register rule H, the golden replay passes 61 of 61, and every check passes. Along the way, the work found and fixed one bug a player would see (blank icons) and one crash (undefined behaviour in the Tauri runtime on Windows). The root dropped the Windows perf sweep.

## Run

- Head: `d6fbd06` (`port/win-laptop`), with `origin/port/integration` at `ae69caa0` merged in and the diagnostic fixups from `origin/port/fix-windows` picked onto it (`771bf93c`, `6722d6a7`, `d5f9dd21`, `ca3ed195`, `82aec10c`).
- Trunk: `origin/main` at `abe473f5`. Electron 44.4.5, Chromium 152.0.7977.130.
- Head engine: WebView2 Evergreen, Edge 157.0.0.0.
- Fixture sha256 `32f91f0a…41136`. Windows 11 Home 10.0.26200, time zone Eastern Standard Time (the laptop's own zone, so nothing was changed or restored).
- Command: `bun parity/report.ts run --data fixture --out parity/out/report-final --trunk origin/main --golden-dir parity/goldens/data --electron-baseline parity/out/report/electron-win`, then `bun parity/report.ts check parity/out/report-final/report-win.json`. The run started 2026-11-24 01:47 UTC and finished 02:28 UTC.
- The Electron baseline came from the full run at `ba437a2`, the last change to anything that feeds it (trunk and `run-electron.ts`). This run captured the Tauri app and the rule H reference fresh at `d6fbd06`, and replayed the goldens.

## Counts

|                    | Result                                                                                                                                                                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| States (rule H)    | **109 of 109 pass.** Same-engine difference against Electron's renderer in WebView2: at most 0.064% of the page (0.3% allowed), 0 on 82 states. 14 states had a cross-engine layout or size failure that Electron's renderer in WebView2 shows the same way. |
| Cross-engine alone | 6 of 109 pass outright. Before rule H, with E1, 22 of 109 passed: Chromium 152 and Edge 157 lay some line boxes out half a CSS px apart.                                                                                                                     |
| Golden replay      | **61 of 61** (rule G is on the branch)                                                                                                                                                                                                                       |
| Checks             | react-isms, `export_bindings --check`, contract-check: all pass                                                                                                                                                                                              |
| Captures           | Tauri 109/109 and Electron's renderer in WebView2 109/109 (Electron 109/109 at `ba437a2`). 0 failed, 0 blocked writes, 0 main-process faults, 0 writes outside the run folder, no app aborted.                                                               |

The expected list has 109 states, one more than the brief's 108, because it includes the `overlay-dialog-mouse-close` control from `2ee3367`.

The four items that were open: `overlay-hover-flips-above` (2560×1202 against 1200) has the same size in Electron's renderer in WebView2, so rule H attributes the size gate to the engine. `overlay-records-modal`'s 11.96% blur tile was a cross-engine pixel difference, and the state is 0% against the same-engine reference. The five export states are 0% same-engine, and the busy states' 608 moved boxes (the season card's `zoom`) move the same way in Electron's renderer. The `SELECT` that renders 0.5 CSS px wider stays within the layout tolerance, and every filter-menu state is 0% same-engine. None of them is a port bug.

## Fixes

1. **`f01513e` fixup! T22: route the components' icon URL constants through `forWebview`.** `constants.ts` re-exported the shared builders, so most components drew raw `asset://` URLs, which WebView2 never routes. 60 of 60 images failed on `match-history-default`. This is the one fix a player would see.
2. **`d6fbd06` fixup! T20: stop Tauri handle clones on tokio workers racing tao's Windows `Rc`.** Shortly after the client connected, the app aborted in `Rc::inc_strong` ("unsafe precondition(s) violated", `alloc/src/rcs/rc.rs:3944`) on a tokio worker. That is the CI lane's "quit ECONNREFUSED".
   - tauri-runtime-wry 3.0.0-alpha.6's `Context` derives `Clone` and is declared `Send` and `Sync`, but it held the main thread's context by value. On Windows that includes tao's `EventLoopWindowTarget`, which holds an `Rc<EventLoopRunner>`. So every `AppHandle`, `Window` and `Webview` clone on a worker raced the main thread's non-atomic count. In a release build the corruption is silent undefined behaviour.
   - `tauri/src-tauri/vendor/tauri-runtime-wry` is that release with `Context::main_thread` behind an `Arc`, wired in through `[patch.crates-io]`. `vendor/README.md` records the provenance and when to drop it.
   - `tests/handle_threads.rs` clones a real runtime handle on 17 threads. It aborted the registry crate in three runs of four and passes on the patched copy.
3. **`0505d72` fixup! T07: wait for the app's WebView2 processes before a session counts as closed.** Without it, the run folder was still busy (EBUSY).
4. **`5c4d508` fixup! T07: rasterize the Windows driver's webview at 1.0.** At a 125% display scale, emulated viewports snapped to the screen's pixel grid.
5. **`ba437a2` fixup! T02: steer Electron's content size by what it reports.** A forced device scale of 2 gave 1279 CSS px for 1280.
6. **`467ff37` fixup! T07, `36de80c` fixup! T40, `5b6c668` fixup! T07, `0ad9868` fixup! T40: register rule H** (the root's decision).
   - Windows judges pixels against Electron's built renderer in the same WebView2, on the Rust commands the port reads.
   - The cross-engine layout and size gates are attributed to the engine only when that renderer fails them the same way.
   - The reference reads the Rust commands rather than replaying the goldens, because on Windows the goldens' day-bucketed answers differ from what the Electron app shows: 90 days played against 79, and 2 games today against 12.

## Leads from the CI lane

- **Quit ECONNREFUSED (T07):** the app aborting, fixed by fix 2. The run-folder EBUSY that followed was fix 3.
- **Images did not decode (T22, T27):** fix 1.
- **Electron never settled (T02):** this did not happen with `125680f` on the branch.
- **Display scale:** both sides override the monitor's scale, so the numbers are the same at 125% and at 100%. Fixes 4 and 5 are still needed for sizes.

## Open

- **The `tauri-runtime-wry` patch should go upstream.** Drop the vendored copy once a release holds the main-thread context behind an `Arc`. `tests/handle_threads.rs` then guards the new release.
- **Two flaky behaviours seen once each in about 150 client sessions, not in the final run.** A client state's page did not show the status within 45 s even though the app connected and exited normally. WebView2's processes once took more than 10 s to exit after the app, which fix 3's wait reports as a failure. Neither repeated.
- **Parity unit tests on Windows.** `bun run test` in `parity/` has 30 failures on Windows, the same with and without this branch's changes: symlinks that need Developer Mode or admin, and POSIX assumptions. CI runs that suite on Ubuntu only. Lint and format pass.

## Laptop

The operator's `%APPDATA%\better-mayhem-tracker` did not exist and was not touched. No `%LOCALAPPDATA%\com.better-mayhem-tracker*` folder exists. Python 3.13, the GitHub CLI and the `rust-src` component were installed. The display scale was set to 100% for one run and can go back to 125%.
