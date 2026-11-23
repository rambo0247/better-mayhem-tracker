# Windows parity on the operator's laptop: result

The report does not pass yet. Goldens and checks pass, every state captures in both apps, and the port renders the same as Electron's own renderer inside WebView2. What still fails comes from a difference between Chromium versions, which needs the root's decision. See "Open".

## Run

- Head: `ba437a2` (`port/win-laptop`), with `origin/port/integration` at `ae69caa0` merged in and the diagnostic fixups from `origin/port/fix-windows` picked onto it (`771bf93c`, `6722d6a7`, `d5f9dd21`, `ca3ed195`, `82aec10c`).
- Trunk: `origin/main` at `abe473f5`. Electron 44.4.5, Chromium 152.0.7977.130.
- Head engine: WebView2 Evergreen, Edge 157.0.0.0.
- Fixture sha256 `32f91f0a…41136`. Windows 11 Home 10.0.26200, time zone Eastern Standard Time (the laptop's own zone, so nothing was changed or restored).
- Command: `bun parity/report.ts run --data fixture --out parity/out/report --trunk origin/main --golden-dir parity/goldens/data`, then `report.ts check`. The run started 2026-11-23 22:41 UTC and finished 23:18 UTC.

## Counts

|                                                   | Result                                                                                                                 |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| States (E1: 1.5% page, 8% tile, rules A, B, E, F) | **22 of 109 pass**: 72 page-budget, 13 layout, 1 size, 1 tile                                                          |
| Golden replay                                     | **61 of 61** (rule G is on the branch)                                                                                 |
| Checks                                            | react-isms, `export_bindings --check`, contract-check: all pass                                                        |
| Captures                                          | Electron 109/109 and Tauri 109/109, 0 failed, 0 blocked writes, 0 main-process faults, 0 writes outside the run folder |

The expected list has 109 states, one more than the brief's 108, because it includes the `overlay-dialog-mouse-close` control from `2ee3367`.

## Fixes

1. **`f01513e` fixup! T22: route the components' icon URL constants through `forWebview`.** `tauri/src/lib/constants.ts` re-exported the builders from `@shared/game-assets`, so most components drew raw `asset://` URLs. WebView2 routes the scheme only as `http://asset.localhost`, so those requests never reached the handler, and 60 of 60 images failed on `match-history-default`. The `asset` log lines from `ca3ed195` showed that only augment icons, whose URLs Rust builds, arrived. WebKit routes `asset://` directly, which hid the bug on the Mac. Now 0 images fail to decode, and a test holds the constants to the routed builders.
2. **`0505d72` fixup! T07: wait for the app's WebView2 processes before a session counts as closed.** The WebView2 browser and its helpers are children of the app, run in its working directory (the run folder), and outlive it by about 100 ms. So `capture.ts` failed with EBUSY when it deleted the empty session's folder. `stopAppAndTree` waits for the process tree, then ends and fails on any process still alive after 10 s.
3. **`5c4d508` fixup! T07: rasterize the Windows driver's webview at 1.0.** WebView2 rasterizes at the monitor's scale, so at 125% an emulated viewport snapped to the display's pixel grid: 953 CSS px came out 954, and the game and season cards failed. `emulate_viewport` now turns off monitor-scale detection and sets a rasterization scale of 1.0 first, as `prepare_card_scale` does, so every size comes out as asked at a device pixel ratio of exactly 2.
4. **`ba437a2` fixup! T02: steer Electron's content size by what it reports.** With the device scale forced to 2, `setContentSize(1280, 820)` gave 1279×820 at both 125% and 100%. The runner now asks again, by the difference `getContentSize` reports, until the size matches. Before this, 105 states failed the size check (2558 against 2560).

## Leads from the CI lane

- **Quit ECONNREFUSED (T07):** this did not happen in three full runs on this laptop. The empty session quit cleanly each time, and the logs kept by `6722d6a7` show a normal shutdown. Its run-folder EBUSY was fix 2.
- **Images did not decode (T22, T27):** fix 1.
- **Electron never settled (T02):** this did not happen. The first state settled in 1.6 s, and no state timed out, with `125680f` on the branch.
- **Display scale:** the report gives the same numbers at 125% and at 100%, to four decimal places, because both sides override the monitor's scale. Fixes 3 and 4 are still needed: without them, sizes differ at 125%, and Electron's width is off at any scale.

## Open

**Line boxes differ by 0.5 CSS px between Chromium 152 and Edge 157.** On `match-history-default`, 1289 of 1584 boxes sit exactly 0.5 CSS px lower in Tauri, and 139 have not moved. The shift starts at the page header's subtitle (`b/0/0/1/1/0/0/0/0/2`). That block uses `13px/19.5px Barlow` and holds `14px/21px "Barlow Condensed"` spans. The spans' boxes are identical in both engines (17 px tall at y=105), yet the block is 21 px tall in Electron and 21.5 px in WebView2. Both engines load the same faces, Barlow 400/500/600 and Barlow Condensed 500 to 800, with no Barlow Condensed 400.

This does not come from the port. Electron's own built renderer in the WebView2 driver differs from the Solid port by 0.15% of pixels on `match-history-default` and 0.003% on `friend-detail-default`. Against Electron, both differ by about 2.1%, with the same worst tile. The half-pixel shift moves every glyph and image edge below the header, which gives the 21.56% tile on the item icons and about 2.1% of the page.

It needs the root's call, since the brief rules out masking or loosening a budget. Options: a register rule for half-pixel line-box differences, CSS that fixes those line heights in the port, or a fixed-version WebView2 runtime matching Chromium 152 for parity runs.

Not yet looked at, beyond the shift above:

- **Layout (13 states).** Examples: `season-recap-default`, with 608 boxes beyond 1 CSS px, likely the card's `zoom`; `trends-default` (22 boxes); the live game states (4 to 9 boxes). Also `SELECT` comes out 0.5 CSS px wider in WebView2.
- **Size.** `overlay-hover-flips-above` is 2560×1202 in Electron against 2560×1200 in Tauri.
- **Blur tiles.** `overlay-records-modal` has a tile at 11.96% at threshold 0.2. The update and what's-new dialogs pass E1 but sit at 8.14 to 8.19% on the blur tile, close to the 8% limit.

**Parity unit tests on Windows.** Lint and format pass. `bun run test` in `parity/` has 30 failures on Windows, the same with and without this branch's changes. Most come from symlinks, which need Developer Mode or admin on Windows; the rest from POSIX assumptions such as `sleep` and `/tmp`-style paths. CI runs that suite on Ubuntu only.

## Laptop

The operator's `%APPDATA%\better-mayhem-tracker` did not exist and was not touched. No `%LOCALAPPDATA%\com.better-mayhem-tracker.parity*` folder was created, because the driver's WebView2 profile stays inside each run folder. Python 3.13 and the GitHub CLI were installed for the build and the perf sweep.
