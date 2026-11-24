# parity

Tools that capture the Electron 1.2.1 baseline and compare the Tauri port against it. The same states, settle, and capture code drive both apps through one `Engine` (`drive.ts`): `PlaywrightEngine` for Electron, `TauriEngine` for the Tauri webview through its parity driver. Everything runs under bun. Nothing here edits `src/` or opens the installed app's data folder for writing.

## The data rule

The installed app keeps its data in `~/Library/Application Support/better-mayhem-tracker` (macOS) or `%APPDATA%\better-mayhem-tracker` (Windows). Only `snapshot.ts` reads it, with plain file reads. It copies `matches.db`, `-wal` and `-shm` until no file moved during the copy, then runs SQLite on the copy only: `sqlite3 -readonly` still writes the `-shm` file of a WAL database. It refuses every output path inside that folder before it reads anything.

Electron only ever launches through `run-electron.ts`. It runs a stub `package.json` named `bmt-parity-electron` with `--user-data-dir` inside a fresh run folder, and loads `seam.cjs`, which aborts any write under the real folder (including through `better-sqlite3`) and logs it as `blocked-write` in `seam.log`. Lanes show zero blocked writes.

Never commit anything made from real data. `out/` and `snapshots/` are gitignored. The anonymized fixture is committed only after the operator has read it (decision E2).

## Setup

```sh
npm ci                                      # repo root: trunk Electron
npm run rebuild                             # better-sqlite3 for Electron's ABI
node node_modules/electron/install.js       # npm skips Electron's download script
npm run build                               # out/ for run-electron.ts
cd parity && bun install --frozen-lockfile
```

## Commands

Run from the repository root.

| Command                                                                                                                                                  | What it does                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun parity/snapshot.ts --out parity/snapshots/private`                                                                                                  | Private copy of the real data (database, caches, asset cache).                                                                                                                                                                                                                                |
| `bun parity/snapshot.ts --out <folder> --verify <log>`                                                                                                   | The same snapshot, with a sha256 and mtime of every app-owned file in the real folder before and after, written to `<log>` (lane 2).                                                                                                                                                          |
| `bun parity/fixture.ts --out parity/snapshots/fixture`                                                                                                   | Anonymized fixture from the private snapshot. Add `--from <snapshot>` for another source.                                                                                                                                                                                                     |
| `bun parity/audit.ts --fixture parity/snapshots/fixture --snapshot parity/snapshots/private`                                                             | Fails when a real name or PUUID survives in the fixture.                                                                                                                                                                                                                                      |
| `bun parity/capture.ts --app electron --data fixture --all`                                                                                              | One PNG, one `.geometry.json`, one `.meta.json` per state in `parity/out/baseline/electron-mac/` (`electron-win/` on Windows), plus `timing.json` and `seam.log`.                                                                                                                             |
| `bun parity/capture.ts --app electron --data fixture --states rail,champions-expanded`                                                                   | A subset, by group or state id.                                                                                                                                                                                                                                                               |
| `bun parity/run-electron.ts --data fixture --state match-history-default`                                                                                | Starts the app in one state, prints `ready run=<folder> control=...`, and waits for input.                                                                                                                                                                                                    |
| `bun parity/drive.ts --run <folder> click "button.group" `                                                                                               | Delivers `click`, `hover`, `type`, `key`, `scroll`, `resize`, `navigate`, `wait`, `waitFor`, `settle`, `shot`, `dom`, `geometry`, or `quit` to a running `run-electron.ts`.                                                                                                                   |
| `bun parity/diff.ts <trunk.png> <head.png> [--policy same-engine\|cross-engine] [--geometry <trunk.json> <head.json>] [--blur x,y,w,h] [--out <prefix>]` | Prints `PASS` or `FAIL`, writes `<prefix>.diff.png` and `<prefix>.side-by-side.png` (trunk, head, diff).                                                                                                                                                                                      |
| `bun parity/determinism.ts <run folder> <run folder>`                                                                                                    | Compares every state two capture runs share under the same-engine policy.                                                                                                                                                                                                                     |
| `bun parity/run-tauri.ts --renderer electron --state match-history-default`                                                                              | Starts the Tauri driver build with Electron's built renderer and `window.api` replayed from the T05 goldens, applies the state, writes `<state>.png` and `<state>.geometry.json` into the run folder, and serves the same `control.json` and `drive.ts` ops as `run-electron.ts`.             |
| `bun parity/run-tauri.ts --renderer electron --api tauri --state match-history-default`                                                                  | The same, with `window.api` built by `tauri/src/api.ts` over the Rust commands in place of the replay, so each call reaches the real command, ported or not.                                                                                                                                  |
| `bun parity/capture.ts --app tauri --data fixture --states default --compare parity/out/baseline/electron-mac`                                           | Captures into `parity/out/baseline/tauri-mac/` and writes `cross-engine-report.json`: every state's cross-engine numbers, the gate's worst tile with where it sits, and failures grouped by cause: `replay-data` for a state the goldens did not fully answer, else the first gate it failed. |
| `bun parity/run-tauri.ts --smoke`                                                                                                                        | Checks the driver on this machine with no data: eval, trusted native mouse and key events, `fill` and `scrollBy` on text targets, resize, a 2x snapshot, and refused tokens. CI runs it on both platforms.                                                                                    |
| `bun test`, `bun run lint`, `bun run fmt:check`                                                                                                          | Unit tests, Bun's linter and formatter.                                                                                                                                                                                                                                                       |

`--data` takes `fixture`, `snapshot`, `empty`, or a folder holding `data/matches.db`. The app runs on a copy inside the run folder, so the source is never changed. `empty` starts the app on an empty data folder, as on a fresh install, and states marked `data: "empty"` in `states.ts` always run on it.

## The fake League client

`fake-lcu.ts` stands in for the League client so the client-dependent states can be captured. It listens only on 127.0.0.1, makes a CA and a leaf at run time (`fake-lcu/ca.ts`, never Riot's), and answers the routes the app calls from a scenario in `fake-lcu/scenarios/`. `fake-live-client.ts` is the in-game API the app expects on port 2999, on a port of its own.

Electron reaches the fake only through the seam. With `SEAM_FAKE_DIR` set, `seam.cjs` maps the default League install folder to `<fake dir>/league`, adds the fake CA to every explicit TLS trust list (the real Riot root stays in the app), rewrites port 2999 and Riot's match-history hosts to the fake's ports, and refuses every other loopback connection. Object-form requests to port 2999 are rewritten in every run, to a port that refuses when no fake runs, so a real game is never asked. A request given as a URL string is not rewritten, and the loopback guard refuses it under a fake. `seam.log` lists each redirect and connection. The real client's lockfile is never read, and nothing here talks to the real client.

| Command                                                                  | What it does                                                                                                                                                                                           |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `bun parity/fake-lcu.ts --scenario connected-idle --data fixture`        | Starts the fake, prints `ready dir=<folder> ...`, and plays the scenario's timeline from the first subscribe. `--set key=value` sets a scenario option.                                                |
| `bun parity/run-electron.ts --data fixture --state <id> --fake <folder>` | Runs the app against a fake started separately. Either can start first.                                                                                                                                |
| `bun parity/capture.ts --app electron --data fixture --states client`    | One app and one fake per state, since the connect loop, the socket, and the database carry what the client did before. Writes the PNG, geometry, `<state>.seam.log`, and `<state>.fake-requests.json`. |
| `bun parity/capture.ts --all --with-client`                              | The default states and the client states. Plain `--all` skips the client states.                                                                                                                       |

Scenarios: `connected-idle`, `champ-select`, `in-game-loading`, `in-game`, `end-of-game`, `results-late` (the post-game stats answer 404 until the fourth request, `--set misses=n`), `challenges-loaded`, `backfill-running` (`served`, `total`), `backfill-walking`, `backfill-done`, `backfill-error`. Frame delays in a timeline are milliseconds from the first subscribe.

Client states live in `states-client.ts`. Rows with `empty` run on a copy of the data with every game removed. Rows with `hold` keep the status on "Connecting..." by holding the connect loop's first tick. A client state's line ends with its connect time, from the fake's start to the app reading "Connected" (`ok   status-connected 9712 ms connect 4624 ms`), and `timing.json` keeps it as `connectMs`. The perf probe is `for i in 1 2 3 4 5 6 7 8 9 10; do bun run capture --states status-connected --out out/connect-$i; done`, run from `parity/`.

## Policies (Appendix A)

- Same engine: pixelmatch `threshold` 0.03, `includeAA` on, zero differing pixels.
- Cross engine: the layout gate (same element count, every box within 1 CSS px), then pixelmatch `threshold` 0.1, `includeAA` off, at most 0.3% of the page, and no 64 by 64 CSS px tile above 8%. A declared blur region is judged by the tile rule at threshold 0.2 and left out of the page count, except a dialog panel (`[role="dialog"]`) inside it, which draws no blur and stays in the page count. The tile rule leaves out a scaled image's box under register rule E.

## Engine-difference register

Differences between Chromium and WebKit that the cross-engine layout gate or tile rule leaves out. Each is invisible on the page, the root approved it, and `test/register.test.ts` holds negative controls showing that a real shift or change of the same boxes still fails.

### A. SVG paint-server content

- Where: `trends-default` and `trends-weekly`, the `<rect>` inside the chart's `<pattern>` in `<defs>`.
- Measured: WebKit gives it a box at 263, 507, 2 by 6 CSS px. Chromium gives it none. So WebKit's walk has 926 elements against Chromium's 925, and every later path is off by one.
- Rule: `geometry.js` skips SVG `defs`, `pattern`, `clipPath`, `mask`, `symbol`, `marker`, `linearGradient`, `radialGradient` and `filter`, with their descendants. They paint nothing where they sit. An HTML element with one of those names is kept.
- Controls: a bar the chart fills from that `<pattern>` (563.32, 647, 31.36 by 12), and one it fills from a gradient, each moved 2 px in x or y still fail. They sit outside `<defs>`, so the walk keeps them.

### B. Inline boxes inside an overflowing ellipsis container

- Where: `match-history-narrow-900`, the truncated friend name's `bdi`.
- Measured: Chromium's box is 187, 192.75, 124.44 by 26.5, covering the text and the ellipsis. WebKit's is 187, 192.8, 119.48 by 26.4, the width of the text run (a `Range` over it measures 119.48 in both engines). The `.truncate` container is 126.6 wide in Chromium and 126.59 in WebKit.
- Rule: `geometry.js` marks a row `"ellipsis"` when an ancestor has `text-overflow: ellipsis`, an `overflow-x` other than `visible`, and `scrollWidth > clientWidth`. When both engines mark a row, the gate compares its x, y and height and not its width, and counts it in `widthExempt`. The container itself is compared in full.
- Controls: the `bdi` moved 2 px in x, in y, or grown 2 px in height each fail. The container 2 px narrower fails. A row that only one engine marks is compared on width.

### E. Scaled images each engine resamples on its own pixel grid

- Where: `season-recap-default`, the 300 by 300 px profile `img`, drawn 92.02 CSS px square at 316.54, 221.23 inside the card's CSS `zoom` of 0.8217.
- Measured: Chromium lays out in 1/64 device px and WebKit in 1/64 CSS px. The image's border box ends on device row 626 in Chromium and 625 in WebKit, so each resamples the image into 177 rows against 176. The boxes agree within 0.02 CSS px, yet the 64 px tile over the image differs by 12.01%. Growing the Tauri image by 0.05 px, so both end on the same row, drops that tile to 0.36%.
- Rule: `geometry.js` adds `{ image: [naturalWidth, naturalHeight] }` to the row of a decoded `img`, and not to an element marked `data-parity-skip`. The tile rule leaves out the pixels inside an image's box when both engines give it the same natural size, its x, y, width and height agree within 1 device px, it is drawn at other than one device px per natural px, and its two crops agree up to a 1 device px displacement: each channel of each pixel lies within 8 levels of the range the other crop holds within 1 device px of it, both ways, and no 64 px window has more than 8% of its pixels outside that. The page budget still counts those pixels, and pixels outside the box still count in the tile rule. No raster background image appears in the app, so background images are not covered.
- Controls: a different image in the box, the same image moved 2 px, and changed text beside the image inside a tile the rule exempts each fail the tile rule. On the captured page the profile image measures 0.68% on the displacement check and 99.79% with another image pasted into its box. The tile drops from 12.01% to 3.33%, and the page stays at 0.3879%.

### F. A focus ring in a window that is never active

- Where: `overlay-dialog-escape`, the sidebar's update button at 12, 656.75, 203 by 48 CSS px, which Escape hands focus back to.
- Measured: in the Tauri capture window `document.hasFocus()` is false, and WebKit matches neither `:focus` nor `:focus-visible` in a window that is not active, so it draws no ring. The driver never activates a window, so the operator's focus is never taken. Electron's element matches both and draws the 2 px ring at a -2 px offset, and the 64 px tile over it differs by 8.76% against the 8% budget. In a focused page, Playwright WebKit 27.2 and Chromium 158 agree on where the ring shows: the restored update button matches `:focus-visible` after Escape and after Enter on Not Now, and not after a click on Not Now or on the scrim.
- Rule: `capture.ts` records the focused element in each `.meta.json` as `focused`: its `geometry.js` path, its box, its outline width and offset, whether it matches `:focus-visible` and `:focus`, and `document.hasFocus()`. The tile rule leaves out the element's box, grown by outline width plus offset when that sum is positive, when Electron's element matches `:focus-visible` with an outline, Tauri's capture focuses the element at the same path in a document without focus, and the two boxes agree within 1 device px. The page budget still counts those pixels.
- Controls: a different element focused in Tauri, no element focused in Tauri, a Tauri document that has focus and draws no ring, Electron's element focused without a ring, the element moved 2 px, and changed text beside the ring inside the same tile each fail the tile rule. On the captured page the tile drops from 8.76% to 2.94%, and the page stays at 0.3415%. A local control state that closes the dialog by a click on Not Now passes with nothing left out, because Electron draws no ring there.

### G. Two golden answers that are the platform's own on Windows

- Where: golden replay on Windows of the goldens recorded on macOS. `dragon:augment-icon` answers `http://asset.localhost/<path>` where the golden holds `asset://<path>`, and `app:download-update` on an unpackaged app answers "In-app update only works in the portable exe build" where the golden holds "In-app update only works once the app is in your Applications folder". Windows report run 45245943821 replayed 59 of 61 on these two.
- Measured: WebView2 serves a custom protocol at `http://<scheme>.localhost/`, and the page loads the icon from that URL as it loads `asset://` on macOS. The update text is Electron's own Windows branch, `updater.ts:190` at v1.2.1.
- Rule: On Windows only, `golden.rs` turns those two expected answers into Windows' form before comparing: an `asset://<path>` result of `dragon:augment-icon` becomes `http://asset.localhost/<path>`, and the darwin text in `app:download-update`'s `error` becomes the Windows text. Nothing else in either answer changes, and no other channel is touched.
- Controls, in golden.rs's self-check on every OS: another icon path, the `asset://` form on Windows, the mapping on macOS, another channel, the darwin text on Windows, and a changed `success` each fail.

### H. Chromium versions on Windows: Electron 1.2.1's against WebView2's

- Where: every Windows state. Trunk Electron 44.4.5 runs Chromium 152, and the WebView2 Evergreen runtime ran Edge 157 on the operator's laptop.
- Measured: on `match-history-default`, 1289 of 1584 boxes sit exactly 0.5 CSS px lower in WebView2. The shift starts at the page header's subtitle: a `13px/19.5px Barlow` block that holds `14px/21px "Barlow Condensed"` spans. The spans' boxes are identical in both engines (17 px tall at y=105), but the block is 21 px tall in Chromium 152 and 21.5 px in Edge 157, with the same CSS and the same loaded faces. The half pixel moves every glyph and image edge below it, so about 2.1% of the page and a 21.56% tile differ. Electron's own built renderer in the WebView2 driver differs from the Solid port by 0.15% at threshold 0.1, so the gap is the engine version, not the port.
- Rule: on Windows, `report.ts` judges a state's pixels by comparing the Tauri capture with Electron's built renderer in the same WebView2, on the Rust commands the port reads (`capture.ts --app tauri --renderer electron --api tauri`). The reference does not replay the goldens. On Windows their day-bucketed answers differ from what the Electron app shows: 90 days played against 79 on `trends-default`, and 2 games today against 12 on `match-history-narrow-900`. The port shows what the app shows. The goldens (61 of 61) and the cross-engine layout gate hold the port's data to the app. It uses pixelmatch at threshold 0.03 with anti-aliasing counted, within 0.3% of the page, with no E1. The cross-engine layout and size gates against the Electron app still run. A failure of either counts as the engine version's only when Electron's renderer in WebView2 fails it the same way: the same elements, and every box the Tauri capture moves beyond 1 CSS px moved in the same direction within 1 CSS px, or the same image size. Anything else is a port bug. Each state records both numbers (`ruleH` in `report-win.json`). On Windows the replay also accepts `isWindowMaximized` answered by its `default` golden, a call Electron's renderer makes only there, for its own window controls (`WINDOWS_RENDERER_CALLS` in `capture.ts`).
- Controls: a port shift in WebView2 that Electron's renderer does not make fails the layout gate. So does a box Electron's renderer moves the other way, and so does an extra element. A pixel change against Electron's renderer over 0.3% fails. A size the renderer does not share fails. Rule H never applies on macOS. Another unlisted call, any call missing on macOS, and `isWindowMaximized` answered by no golden all still fail the capture.

### Port elements marked `data-parity-skip`

Not an engine difference but a deliberate one in the port's markup. Where Electron drew one element and the port needs a wrapper to draw the same thing in WebKit, the port marks the outer element `data-parity-skip`, and `geometry.js` records its box and leaves out what it wraps. T27's `ChampionIcon` is the case: Electron draws the portrait as one `img` with `object-view-box`, which WKWebView ignores, and the port draws a clipping span at that box with a larger `img` inside. An unmarked extra element still fails the gate.

## Determinism

`run-electron.ts` passes `--force-device-scale-factor=2`, `--force-color-profile=srgb`, `--lang=en-US`, `TZ=America/New_York`, freezes the renderer clock with `context.clock.setFixedTime` and the main-process clock in the seam, aborts renderer `http` and `https`, and blocks main-process network except loopback. `settle.ts` waits for fonts, decoded images, a client status past "Connecting...", and 1.2 s of unchanged DOM, then kills animation and parks the mouse. Each state starts from cleared `localStorage` and a reload, and restores any setting it changed.

## The Tauri side

Build the driver into a debug binary first. It is a Cargo feature that a release build refuses to compile:

```sh
cd tauri && CI=true bun run tauri build --debug --no-bundle --features parity-driver
```

A driver build carries its own bundle identifier, `com.better-mayhem-tracker.parity`. WebKit keeps a webview's storage in `~/Library/WebKit/<bundle id>` and `~/Library/Caches/<bundle id>` whatever `HOME` says, and Tauri names the app's data folders by the same identifier, so a driver build under `com.better-mayhem-tracker.app` would fill the real app's folders. `build.rs` merges the parity identifier into `TAURI_CONFIG` whenever the `parity-driver` feature builds, which covers `cargo` and `--no-bundle` builds. A bundled driver build also needs it in its `Info.plist`, which the CLI writes from its own config: `CI=true bun run tauri build --debug --bundles app --features parity-driver --config src-tauri/tauri.parity.conf.json`. `run-tauri.ts` refuses to launch a binary whose embedded config or enclosing `.app` names the production identifier, or that lacks the parity one.

`run-tauri.ts` launches `tauri/src-tauri/target/debug/better-mayhem-tracker-tauri` (or `$CARGO_TARGET_DIR/debug/...`, or `--binary`) with a fresh token. The driver listens on `127.0.0.1`, refuses any request without the token or from another host, and offers primitives: `eval` (awaits promises), `mouse` and `key` (native events sent to the webview, so the window is never made key and the app never activates), `wheel`, `resize`, `navigate`, `reload`, `snapshot` (the webview's own pixels, converted to sRGB), `emit` (one of the 11 events through its typed emitter in `events.rs`), `info`, `quit`. Selector rules, settle, and states stay in TypeScript, shared with Electron.

`run-tauri.ts` launches `tauri/src-tauri/target/debug/better-mayhem-tracker-tauri` (or `$CARGO_TARGET_DIR/debug/...`, or `--binary`) with a fresh token. The driver listens on `127.0.0.1`, refuses any request without the token or from another host, keeps the page on the origin it opened at, and offers primitives: `eval` (awaits promises), `mouse` and `key` (native events sent to the webview, so the window is never made key and the app never activates), `wheel`, `resize`, `page-height`, `navigate`, `reload`, `snapshot` (the webview's own pixels, converted to sRGB), `info`, `quit`. Selector rules, settle, and states stay in TypeScript, shared with Electron.

- `--renderer electron` loads `out/renderer` from a `parity:` scheme (`http://parity.localhost` on Windows), serves the data's asset cache under `asset:` the way Electron's cache files it, and installs `replay-api.js`, which answers `window.api` from `parity/out/golden` (T05's format, `goldens/FORMAT.md`). Matching follows FORMAT.md: equal canonical arguments, the lowest `seq` on a tie, write groups in `seq` order behind one cursor per channel, then the `default` case. A call answered by `default` is a miss, and a call with no golden throws `ReplayMiss`. Each state's misses and calls are in its `.meta.json`, and capture fails a state with a miss its row does not declare in `replayMisses`. A setting written with a golden is read back, across the reload each state does.
- The page clock is frozen at the same instant as Electron's, `TZ` is `America/New_York`, and macOS gets `-AppleLanguages (en-US)`. WebView2 gets the same Chromium switches as Electron: device scale 2, sRGB, `--disable-gpu`, `--lang=en-US`.
- On macOS the driver build is an accessory app: no Dock icon, never focused, never activated. Its window sits at 40,40 like Electron's and floats above other windows while the app runs, because WebKit stops painting a covered window. So the app runs only while it captures: `capture.ts` closes it before it waits out a League game and relaunches after, and `run-tauri.ts` closes it when a game starts. It holds off App Nap and idle display sleep until it exits.
- Every capture records the boxes of elements with a `backdrop-filter` as blur regions, which WebKit's snapshots do not draw, and the cross-engine report judges them by the 0.2 threshold tile rule. Each also records the dialog panels inside it, which the page count keeps.
- On macOS 26 the webview loses 32 px of its frame to the title bar, so `TauriEngine.resizeWindow` sizes the window by what the page reports, and snapshots take exactly the viewport.
- macOS keeps a window on its screen, so a card taller than the screen (the season cards are 1788 and 1742 CSS px) would lay out and snapshot short. When the window stops short of the asked height, the driver's `page-height` primitive grows the webview past the window's bottom edge until the page has the full height, and the next `resize` gives it back the window's frame. The capture records the clamp in `.meta.json`.

## Windows

`.github/workflows/parity.yml` runs the baseline on `windows-latest`. The fixture is not committed yet, so the workflow takes it from a workflow_dispatch input (`fixture_run`, the run id holding a `parity-fixture` artifact) and otherwise skips with a notice. Without the Riot asset cache, icons do not load, which affects both of two Windows runs the same way.

Electron runs with `--disable-gpu` by default, because GPU compositing repeats less between runs (waiver W1). `PARITY_GPU=on` turns the GPU back on, and any other value but `off` is an error. Electron also runs with `--disable-partial-raster`, since partial raster made the antialiased edges of icons depend on invalidation order. `PARITY_ELECTRON_ARGS` adds Chromium flags, such as `--disable-renderer-backgrounding`. `SEAM_DOCK=show` keeps the Dock icon for a comparison run.

Opt-in seam modes, all off by default so no baseline changes. `SEAM_WEB_FAKE=<loopback http url>` sends `https://<host>/<path>` for `ddragon.leagueoflegends.com`, `raw.communitydragon.org` and `cdn.communitydragon.org` to `<url>/<host>/<path>` and keeps blocking every other host, and a value that is not a loopback http URL stops the process. `SEAM_CLOCK_LIVE=1` leaves `Date.now` running so a backoff can end, while `new Date()` stays fixed. `startElectron({ quit: "graceful" })` and `run-electron.ts --quit graceful` end the app with `app.quit()`, so `before-quit` and its final fetch run, and fall back to `app.exit(0)` after `quitTimeoutMs` (20 s). The default stays `app.exit(0)`. The seam refuses every socket that does not go to loopback, whatever the API used, and any socket that brings its own `lookup`, which could answer a loopback name with another address. It also refuses every socket to port 2999, the live client's API, whatever the host. `SEAM_LIVE_PORT` and `SEAM_FORK_DEPTH` are pinned by `run-electron.ts`.

The `view:` localStorage keys in `states.ts` only take effect while the `remember_filters` setting is on, so `applyState` turns it on for every state that seeds one. Each of those states asserts that its view applied.

Every spawning command runs under `lib/capped.sh <headroom>`, which caps processes at the user's current count plus the headroom and exits 99 if anything was refused a process. `bun run test` and `bun run capture` use a headroom of 200. A bare `ulimit -u 200` would refuse the first fork on macOS, which counts every process the user owns.

## The parity report (T40)

`report.ts run` captures every state for this platform in trunk Electron and in the head Tauri driver build on its own Solid UI and Rust commands, diffs each pair (side-by-side images in `<out>/tauri-<platform>/cross-engine/`), replays the goldens with `cargo test --features parity-driver --test golden`, runs `tauri/scripts/react-isms.ts` and `export_bindings --check`, and writes `<out>/report-<platform>.json` with a contact sheet beside it. On the operator's Mac it needs `--tools <dir>` naming `wait-no-game.sh`, `capture-slot.sh` and `build-slot.sh`, which it puts in front of every app launch and cargo run. `--electron-baseline <dir>` reuses an Electron capture instead of launching Electron.

`report.ts render --run <report-mac.json> --run <report-win.json> --perf <perf.ts json> ...` writes `docs/tauri-port/parity-report.md`: the state table for both platforms, the golden count against 61, the before and after table from `perf.ts` sweeps, the checks, masks, and the entries of the Engine-difference register section of this README. It exits 1 when any state, golden, check or metric fails, or a platform is missing. It judges the page budget at E1's 1.5% (the operator's decision of 2026-11-23); every other gate is `diff.ts`'s.

Windows runs the same `report.ts run` in parity.yml's `report-windows` job: `gh workflow run parity.yml --ref <branch> -f lanes=report -f fixture_run=<id> [-f golden_run=<id>]`, then `gh run download <run> --name parity-report-windows`.

## Known limits

- `bun lint --flavor eslint` is what lints parity. Without the flavor, Bun walks up to the root `.oxlintrc.json`, whose ignore patterns name `parity`, and lints nothing.
- Overlays and menus belong to T04.

## Perf probe (T06)

`bun parity/perf.ts --app electron-1.2.1 [--app tauri --tauri <.app|.exe>] --runs 10` measures download size, installed size, idle memory across every process, and launch to first content. It downloads the v1.2.1 release with `gh release download` into `out/perf/assets/`, copies the fixture into a fresh data folder per run, and starts the packaged app as a plain child. Runs alternate between apps with a fresh profile each time. Idle memory is the median of 5 samples 10 s apart, taken 60 s after first content. Unknown flags are an error.

- `--scenario hidden-idle` launches each app with `--hidden`, as a login item does, and measures idle with no window. The default is `visible-idle`. A hidden sweep writes `<apps>-hidden-idle-<mac|win>.json`.
- Memory on macOS is footprint's de-duplicated `total footprint` for the app's whole process set from `footprint -j`, with summed RSS beside it. On Windows it is the summed private working set (`perf/memory-win.ps1`). Electron helpers are found by parent pid, Tauri's WebKit helpers by what they hold open. A run with a missing or ambiguous helper is marked invalid and records no number.
- Load is sampled every 2 s for the whole sweep: the 1-minute load average and CPU idle, from `top` on macOS. A sweep whose median CPU idle is below 30% writes `<name>.refused.json` and no numbers, and exits 1. The gate uses idle because Windows reports a load average of 0. Per-run progress prints only ok or INVALID. `--min-cpu-idle <share>` changes the threshold, and the JSON records the threshold and whether the flag set it.
- On macOS the packaged app has no seam, so it runs under a Seatbelt profile that hides the League install and `ps`, denies all access to the real data folder, and denies writes to `~/Library/LaunchAgents`, with `--no-sandbox` for Electron because a process under a profile cannot start Chromium's own. For Electron, `--isolation none` waits for no League client instead.
- `bun parity/perf/prove.ts --tauri <.app>` runs the known-case proofs for the attribution.
- The windows job is `gh workflow run parity.yml --ref <branch> -f lanes=perf -f fixture_run=<id>`.

### Tauri runs

A release build has no data-root override, so the probe moves the folder the OS reports instead. These rules hold for every Tauri run:

- Build the binary with the perf bundle id, `com.better-mayhem-tracker.perf`, because WebKit keeps `~/Library/WebKit/<bundle id>` under the real home whatever HOME says. From `tauri/`: `CI=true CARGO_TARGET_DIR=<yours> bun run tauri build --bundles app --config ../parity/perf/tauri-perf.conf.json`. The probe refuses a bundle whose `Info.plist` carries any other id.
- On macOS the app runs with HOME set to `<run>/home`, because `dirs::config_dir` is `$HOME/Library/Application Support`, so a release build opens `<run>/home/Library/Application Support/better-mayhem-tracker`. `--tauri-profile lane` is for any other Cargo profile, which also gets `BMT_DATA_ROOT=<run>/userdata`. The Seatbelt profile stays on as the backstop, and `--isolation none` is refused.
- On Windows a release build finds its folder with `SHGetKnownFolderPath`, which no environment variable moves. Tauri runs there are refused unless `CI` and `GITHUB_ACTIONS` are both `true`, and the probe clears that folder only when it holds the marker the probe left in it.
- A run counts only once the app proves it opened the copy: its log is at `<data root>/logs/main.log`, and its `first-content N ms` line ends with `row=` and the first row's text as a JSON string, which must be the fixture's newest game. `--data none` is refused for Tauri.
