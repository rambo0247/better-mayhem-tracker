# Windows parity on the operator's laptop: result

`report.ts check` does not exit 0 yet, and the blocker is a crash in the Tauri app, not a rendering difference. Under register rule H, every state the reference capture reached passes: 59 of 59. The capture stopped at the 59th state because the app aborted on undefined behaviour in an `Rc` on a Tokio worker thread. That crash is also the CI lane's "quit ECONNREFUSED". See "Open". The rule H work stopped there, at the operator's call, and the root dropped the Windows perf sweep.

## Run

- Head: `0ad9868` (`port/win-laptop`), with `origin/port/integration` at `ae69caa0` merged in and the diagnostic fixups from `origin/port/fix-windows` picked onto it (`771bf93c`, `6722d6a7`, `d5f9dd21`, `ca3ed195`, `82aec10c`).
- Trunk: `origin/main` at `abe473f5`. Electron 44.4.5, Chromium 152.0.7977.130.
- Head engine: WebView2 Evergreen, Edge 157.0.0.0.
- Fixture sha256 `32f91f0a…41136`. Windows 11 Home 10.0.26200, time zone Eastern Standard Time (the laptop's own zone, so nothing was changed or restored).
- Full run, cross-engine only (before rule H), at `ba437a2`: `bun parity/report.ts run --data fixture --out parity/out/report --trunk origin/main --golden-dir parity/goldens/data`, 2026-11-23 22:41 to 23:18 UTC.
- Rule H runs: the same command with `--electron-baseline parity/out/report/electron-win --tauri-capture parity/out/report/tauri-win --skip-golden`, reusing that run's Electron and Solid captures. Nothing that feeds those captures changed after `ba437a2`, so each run captured only the reference.

## Counts

|                                                        | Result                                                                                                                                                                                                                                                               |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cross-engine only (E1: 1.5% page, 8% tile, A, B, E, F) | 22 of 109: 72 page-budget, 13 layout, 1 size, 1 tile                                                                                                                                                                                                                 |
| Rule H, reference replaying the goldens                | 49 of 109. 56 had no reference: the replay cannot drive the fake client or the main-step overlays. 4 failed for the replay's data (see `0ad9868`).                                                                                                                   |
| Rule H, reference on the Rust commands (`--api tauri`) | **59 of 59 captured states pass**, including every state the root listed: the trends states, `match-history-narrow-900`, the live and client states, and the toasts. The capture aborted at the 59th state, on the app crash below, so the other 50 were not judged. |
| Golden replay                                          | **61 of 61** (rule G is on the branch)                                                                                                                                                                                                                               |
| Checks                                                 | react-isms, `export_bindings --check`, contract-check: all pass                                                                                                                                                                                                      |
| Electron and Solid captures                            | 109/109 each, 0 failed, 0 blocked writes, 0 main-process faults, 0 writes outside the run folder                                                                                                                                                                     |

The 59-of-59 figure comes from applying `applyRuleH` to the states listed as `ok` in the aborted capture's log. The capture died before it wrote its `timing.json`, so `report.ts` itself recorded all 109 as uncaptured. The expected list has 109 states, one more than the brief's 108, because it includes the `overlay-dialog-mouse-close` control from `2ee3367`.

## Fixes

1. **`f01513e` fixup! T22: route the components' icon URL constants through `forWebview`.** `tauri/src/lib/constants.ts` re-exported the builders from `@shared/game-assets`, so most components drew raw `asset://` URLs. WebView2 routes the scheme only as `http://asset.localhost`, so those requests never reached the handler, and 60 of 60 images failed on `match-history-default`. WebKit routes `asset://` directly, which hid the bug on the Mac. Now 0 images fail to decode, and a test holds the constants to the routed builders. This is the one fix a player would see.
2. **`0505d72` fixup! T07: wait for the app's WebView2 processes before a session counts as closed.** The WebView2 browser and its helpers run in the app's working directory (the run folder) and outlive it by about 100 ms. So `capture.ts` failed with EBUSY when it deleted the empty session's folder.
3. **`5c4d508` fixup! T07: rasterize the Windows driver's webview at 1.0.** At a 125% display scale, an emulated viewport snapped to the display's pixel grid: 953 CSS px came out 954, and the cards failed.
4. **`ba437a2` fixup! T02: steer Electron's content size by what it reports.** With the device scale forced to 2, `setContentSize(1280, 820)` gave 1279×820 at any display scale, so 105 states failed on size.
5. **`467ff37` fixup! T07: answer the renderer's Windows-only `isWindowMaximized` from its default golden.** The per-state call lists come from macOS, where Electron's renderer draws no window controls.
6. **`36de80c` fixup! T40: judge Windows states by register rule H.** This adds `applyRuleH` in `report.ts`, entry H in `parity/README.md`, and negative controls in `register.test.ts`. A port shift the reference does not make, a box it moves the other way, an extra element, pixels over 0.3% and a size it does not share all fail, and rule H never applies on macOS.
7. **`5b6c668` fixup! T07 and `0ad9868` fixup! T40: take rule H's reference from the Rust commands.** On Windows, the golden replay's day-bucketed answers differ from what the Electron app shows: 90 days played against the app's 79 on `trends-default`, and 2 games today against 12 on `match-history-narrow-900`. The port shows what the app shows. The reference is now Electron's built renderer in the same WebView2 on the Rust commands (`capture.ts --api tauri`).

## Open

**The Tauri app aborts on undefined behaviour (blocker).** In the reference capture, the `backfill-toast-done` session's app logged `Listening for post-game results` and then:

```
thread 'tokio-rt-worker' panicked at library/alloc/src/rc.rs:3944:13:
unsafe precondition(s) violated: hint::assert_unchecked must never be called when the condition is false
thread caused non-unwinding panic. aborting.
```

The driver's quit then got ECONNREFUSED, which aborted the capture. That is the CI lane's lead 1: an app that has already exited, shortly after capture. The log is `parity/out/report-h2/webview2-electron-win/tauri.26.log`. `Rc` is single-threaded, and the app's own code holds no `Rc` outside `snapshot/win.rs`, where it lives on the main thread. So this is likely a value created or dropped on the wrong thread inside a dependency (tauri, wry or webview2-com), reached from the post-game listener in `lcu/mod.rs`. A debug build aborts on it. A release build would run on with the undefined behaviour. Next step: rerun that state with `RUST_BACKTRACE=1`.

**The rest of the report.** Once the crash is fixed, rerun with `--webview2-reference` unset, so the reference captures all 109 states. Judging from the 59 it reached, rule H is expected to pass the rest. These were not reached and are unconfirmed:

- `overlay-hover-flips-above` (2560×1202 against 2560×1200)
- `overlay-records-modal` (blur tile 11.96%)
- the export states
- the `SELECT` that renders 0.5 CSS px wider

**Parity unit tests on Windows.** Lint and format pass. `bun run test` in `parity/` has 30 failures on Windows, the same with and without this branch's changes: symlinks that need Developer Mode or admin, and POSIX assumptions. CI runs that suite on Ubuntu only.

## Laptop

The operator's `%APPDATA%\better-mayhem-tracker` did not exist and was not touched. The one perf run that started was stopped during its first Electron run, before any Tauri run could create that folder. No `%LOCALAPPDATA%\com.better-mayhem-tracker*` folder exists. Python 3.13 and the GitHub CLI were installed for the build. The display scale was set to 100% for one run and can go back to 125%.
