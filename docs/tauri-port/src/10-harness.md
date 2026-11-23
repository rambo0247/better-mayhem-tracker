## Replace the spike with the tauri workspace and its toolchain (T01)

**Depends on.** None.

**Files.**

- [ ] Delete `tauri-spike/`. Its code stays reachable at `d3f2ed0`, and its measured numbers move to Appendix A.
- [ ] Create `tauri/package.json`, `tauri/bun.lock`, `tauri/tsconfig.json`, `tauri/vite.config.ts`, `tauri/index.html`, and `tauri/src/main.tsx`.
- [ ] Create `tauri/rust-toolchain.toml`.
- [ ] Create `tauri/src-tauri/Cargo.toml`, `Cargo.lock`, `build.rs`, `tauri.conf.json`, `capabilities/default.json`, `icons/`, `src/main.rs`, and `src/lib.rs`.
- [ ] Create `tauri/.oxlintrc.json`, `tauri/.oxfmtrc.json`, `tauri/lint/solid-input-events.js`, and `tauri/lint/solid-input-events.test.ts`.
- [ ] Create `tauri/scripts/deps-report.ts`.
- [ ] Create `.github/workflows/tauri-ci.yml`.
- [ ] Edit `.oxlintrc.json` so `ignorePatterns` names `tauri` and `parity` in place of `tauri-spike`.

**Build.**

- [ ] Pin `nightly-2026-11-23` with the `clippy` and `rustfmt` components in `tauri/rust-toolchain.toml`. If that date has no `clippy` for both targets when the unit is cut, take the newest date that has it on both and record it.
- [ ] Pin the Appendix D versions exactly. That is `tauri` 3.0.0-alpha.6 with `tauri-runtime-wry` 3.0.0-alpha.6 and `tauri-build` 3.0.0-alpha.4, `@tauri-apps/cli` 3.0.0-alpha.6, `@tauri-apps/api` 3.0.0-alpha.3, `solid-js` and `@solidjs/web` 2.0.3, `@solidjs/router` 2.0.1, `vite` 8.4.0-beta.1 with `overrides` for the two plugins whose `^8` peer range excludes it, `tailwindcss` 4.3.5, and `typescript` 7.1.0-dev.20261121.1.
- [ ] Write `tauri/src-tauri/src/lib.rs` as a Tauri builder on `tauri_runtime_wry::Wry` with one window, 1280 by 820, minimum 900 by 600, background `#0a1024`, product name `Better Mayhem Tracker`, and identifier `com.better-mayhem-tracker.app`.
- [ ] Write `tauri/package.json` scripts so every task runs through bun. That covers `dev`, `build`, `tauri` as `bunx tauri`, `lint` as `bunx oxlint`, `fmt` and `fmt:check` as `bunx oxfmt`, `typecheck` as `bunx tsc --noEmit`, `test` as `bun test`, and `deps:report`.
- [ ] Configure `tauri/.oxlintrc.json` with `jsPlugins` set to `eslint-plugin-solid` 0.20.1 and `./lint/solid-input-events.js`, `settings.solid.version` 2, the `solid` recommended rules as errors, and no `react` plugin.
- [ ] Write `tauri/lint/solid-input-events.js`, a rule that fails `onChange` on `input` and `textarea`, because Solid's `onChange` fires on commit where React's fires per keystroke.
- [ ] Write `tauri/scripts/deps-report.ts`. It prints every npm and crate dependency with its `latest`, its newest prerelease by semver, and the pinned version, and it marks a pin that breaks the version rule. It is a report, not a CI gate, so a new upstream release never turns CI red.
- [ ] Write `.github/workflows/tauri-ci.yml` for `macos-latest` and `windows-latest`. It installs bun canary, then runs `bun install --frozen-lockfile`, lint, fmt check, typecheck, `bun test`, `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test`, and `bun run tauri build --debug`, all in `tauri/`.

**You see.**

- [ ] `bun run tauri dev` in `tauri/` opens one empty dark window titled `Better Mayhem Tracker`.
- [ ] `tauri-ci.yml` is green on both runners. `ci.yml` and `release.yml` are unchanged and green.

**Verify, unit.** @@RULE@@

- [ ] `tauri/lint/solid-input-events.test.ts` asserts the rule fails `<input onChange={f} />` and passes `<input onInput={f} />` and `<select onChange={f}>`. Run `bun test` in `tauri/`.
- [ ] A fixture file with a destructured prop fails `bun run lint` with `solid(no-destructure)`, and a fixture that reads a signal outside a tracked scope fails it with `solid(reactivity)`.
- [ ] Run `cargo clippy --all-targets -- -D warnings` and `cargo fmt --check` in `tauri/src-tauri`. Both exit 0.

**Verify, live.** @@LIVE@@

- [ ] Lane 1. Regression lane against trunk. Run `npm ci && npm run build && npm run lint` at the root on trunk and on head. Save `electron-build.log`. Pass when both exit 0 and `git diff main -- src package.json package-lock.json .github/workflows/release.yml` is empty at head.
- [ ] Lane 2. Launch the debug build on macOS and read the window size and title from the Tauri log. Save `mac-window.log`. Pass when the log shows 1280 by 820, title `Better Mayhem Tracker`, and background `#0a1024`.
- [ ] Lane 3. Launch the debug build on `windows-latest` through `tauri-ci.yml`. Save `win-window.log`. Pass when the process stays up 10 s and logs the same window size.
- [ ] Lane 4. Run `bun install --frozen-lockfile` twice in a clean clone of head. Save `lockfile.log`. Pass when the second run changes no file and `git status` is clean.
- [ ] Lane 5. Run `bun run deps:report`. Save `deps-report.log`. Pass when it marks no pin as breaking the version rule, or every mark matches an Appendix E waiver.
- [ ] Lane 6. Add a `const { a } = props` component under `tauri/src/` in a scratch commit and run lint. Save `lint-destructure.log`. Pass when lint exits non-zero with `no-destructure`.
- [ ] Lane 7. Add `<input onChange={f} />` in a scratch commit and run lint. Save `lint-onchange.log`. Pass when lint exits non-zero with `solid-input-events`.
- [ ] Lane 8. Run `bunx oxlint` at the root. Save `root-lint.log`. Pass when it lints no file under `tauri/` and its result matches trunk.
- [ ] Lane 9. Run `rustup show active-toolchain` in `tauri/`. Save `toolchain.log`. Pass when it names the pinned nightly date.
- [ ] Lane 10. Confirm the spike is gone and still reachable. Run `git show d3f2ed0:tauri-spike/README.md`. Save `spike-history.log`. Pass when the file prints and `tauri-spike/` is absent at head.

**Verify, perf.** @@RULE@@

- [ ] Metric. Trunk has no Tauri app, so this unit measures absolute numbers for the empty shell. They are the size of the release `.app` and `.dmg`, idle memory across all processes 60 s after launch, and time from process start to the window's first paint.
- [ ] Probe. Run `bun parity/perf.ts --app tauri --runs 10` once T06 lands. Until then, `du -sk` on the bundle, the T06 memory method by hand, and the first-paint log line.
- [ ] Baseline. Record the Electron 1.2.1 numbers from the spike README first. They are 110 MB `.dmg`, 245 MB `.app`, and about 328 MB memory.
- [ ] Rule. Fail when the empty shell's `.dmg` exceeds 8 MB or its idle memory exceeds 120 MB.

@@NOGATE T01@@

@@MERGE@@

## Capture the Electron baseline for every route (T02)

**Depends on.** T01.

**Files.**

- [ ] Create `parity/package.json`, `parity/bun.lock`, `parity/README.md`, and `parity/.gitignore` ignoring `out/` and `snapshots/`.
- [ ] Create `parity/snapshot.ts`, `parity/fixture.ts`, and `parity/anonymize.ts`.
- [ ] Create `parity/seam.cjs`, `parity/run-electron.ts`, `parity/drive.ts`, and `parity/settle.ts`.
- [ ] Create `parity/states.ts` and `parity/capture.ts`.
- [ ] Create `parity/diff.ts` and `parity/geometry.js`.
- [ ] Create `parity/test/diff.test.ts` and `parity/test/anonymize.test.ts`.

**Build.**

- [ ] Write `parity/snapshot.ts`. It copies `matches.db` with `sqlite3 -readonly ... ".backup"` and copies the caches with read-only `cp` into a folder outside the real data folder. It refuses any output path under `Application Support/better-mayhem-tracker` or `%APPDATA%\better-mayhem-tracker`.
- [ ] Write `parity/anonymize.ts` and `parity/fixture.ts`. They rewrite every game name, tag line, summoner name, and PUUID in the tables and inside the gzipped `raw_gz` payloads to stable fake values, then freeze `last_run_version` at `1.2.1`. The fixture is what CI and committed baselines use, per decision E2.
- [ ] Port the prototype seam to `parity/seam.cjs`, loaded through Electron's `-r` argument. It hides League and Riot paths so the client reads as closed, blocks main-process `fetch` to Data Dragon, CommunityDragon, and GitHub, freezes main-process `Date`, and aborts on any write path under the real data folder.
- [ ] Write `parity/run-electron.ts`. It copies `out/` into the run folder, renames the app in a stub `package.json` so Electron's default user data can never be `better-mayhem-tracker`, and passes `--user-data-dir`, `--force-device-scale-factor=2`, `--force-color-profile=srgb`, `--lang=en-US`, and `TZ=America/New_York`. It sets the renderer clock with `context.clock.setFixedTime` and routes all renderer `http` and `https` to abort.
- [ ] Write `parity/settle.ts`. It waits for `document.fonts.ready`, every image decoded, a settled client status label, and 1.2 s of unchanged DOM, then injects the animation kill switch and parks the mouse.
- [ ] Write `parity/states.ts` as one table of state ids. Each row holds the route, viewport, platform, data source, and the `drive.ts` steps that reach the state. This unit fills the default state of all 15 routes and the 2 card routes, the rail layout at 1179 px, and the Match History states from Appendix F that need no client.
- [ ] Write `parity/capture.ts`. It runs each state and writes `<state>.png` plus `<state>.geometry.json`, the element boxes from `parity/geometry.js`.
- [ ] Write `parity/diff.ts` with the two policies from Appendix A. Same engine is pixelmatch `threshold` 0.03 with `includeAA` on and zero differing pixels. Cross engine is the layout gate, the 0.3% page budget, and the 8% tile rule. It writes the diff image and a side-by-side image with trunk on the left, head in the middle, and the diff on the right.

**You see.**

- [ ] `bun parity/capture.ts --app electron --data fixture --all` writes one PNG and one geometry file per state into `parity/out/baseline/electron-mac/`.
- [ ] A second run of the same command matches the first with `parity/diff.ts --policy same-engine` on every state.

**Verify, unit.** @@RULE@@

- [ ] `parity/test/diff.test.ts` feeds two identical PNGs, a PNG with 11 pixels off by one level, a 2 px layout shift, and a missing icon crop, and asserts `PASS`, `PASS`, `FAIL` on the layout gate, and `FAIL` on the tile rule. Run `bun test` in `parity/`.
- [ ] `parity/test/anonymize.test.ts` builds a three-game database with known names, anonymizes it, and asserts no original name or PUUID remains in any table or decoded payload, and that the same input name maps to the same fake name in both places.

**Verify, live.** @@LIVE@@

- [ ] Lane 1. Regression lane against trunk. Trunk has no capture tool, so run `bun parity/capture.ts --app electron --all` at head against the trunk Electron build twice. Save `determinism.log` and `match-history.png`. Pass when every state diffs `PASS` under the same-engine policy across the two runs.
- [ ] Lane 2. Run the snapshot script while the operator's packaged Electron app is open, then compare `shasum` of every file in the real data folder before and after. Save `real-folder-untouched.log`. Pass when no app-owned file changed and `seam.log` shows zero blocked writes.
- [ ] Lane 3. Capture Match History loaded with sessions grouped by day. Save `match-history.png`. Pass when the image shows the dashboard header and session headers and the geometry file lists every row.
- [ ] Lane 4. Capture Champions with a row expanded. Save `champions-expanded.png`. Pass when Top Augments, Top Items, and Recent Games show.
- [ ] Lane 5. Capture Season Recap. Save `season-recap.png`. Pass when the preview card shows at its `zoom` scale with no clipped edge.
- [ ] Lane 6. Capture the rail layout at 1179 px wide. Save `rail.png`. Pass when the sidebar shows icons only.
- [ ] Lane 7. Capture `/card/<id>` and `/season-card/<id>`. Save `game-card.png` and `season-card.png`. Pass when both reach `state` `ready` on `window.__mayhemCardStatus`.
- [ ] Lane 8. Capture Global Stats on each of its three tabs. Save `global-items.png`. Pass when each tab's table shows and the `aria-pressed` tab matches.
- [ ] Lane 9. Run the baseline on `windows-latest` with `parity.yml`. Save `win-match-history.png`. Pass when every Windows state captures and two Windows runs match under the same-engine policy.
- [ ] Lane 10. Search the fixture for each real name from a private snapshot, using `sqlite3 -readonly` and the payload decoder. Save `anonymize-audit.log`. Pass when no real name or PUUID appears.

**Verify, perf.** @@RULE@@

- [ ] Metric. Trunk has no capture tool, so this unit sets absolute budgets for the work it adds. That is wall time for one full baseline run and wall time per state.
- [ ] Probe. Run `time bun parity/capture.ts --app electron --all` three times on the operator's Mac and once on `windows-latest`.
- [ ] Baseline. Record the first macOS run's wall time and state count first.
- [ ] Rule. Fail when one state takes more than 15 s on macOS or a full run takes more than 20 minutes.

@@NOGATE T02@@

@@MERGE@@

## Capture the client-dependent states with a fake League client (T03)

**Depends on.** T02.

**Files.**

- [ ] Create `parity/fake-lcu.ts`, `parity/fake-lcu/ca.ts`, and `parity/fake-lcu/scenarios/`.
- [ ] Create `parity/fake-live-client.ts`.
- [ ] Edit `parity/seam.cjs`, `parity/states.ts`, and `parity/README.md`.
- [ ] Create `parity/test/fake-lcu.test.ts`.

**Build.**

- [ ] Write `parity/fake-lcu.ts`, an HTTPS and WebSocket server that answers the LCU routes the app calls, from scenario files in `parity/fake-lcu/scenarios/`. It writes a lockfile into a folder the seam maps the League install path to. It speaks the WAMP frames the app subscribes to with `[5,"OnJsonApiEvent"]`.
- [ ] Write `parity/fake-lcu/ca.ts`. It makes a throwaway CA and a leaf with SAN `127.0.0.1` and `localhost`. The seam adds that CA to Node's `tls` trust for the Electron process only. The real pinned Riot root stays in the app untouched.
- [ ] Write `parity/fake-live-client.ts` for the game's port 2999 API, which Electron calls with `rejectUnauthorized` off.
- [ ] Write scenarios for `connected-idle`, `champ-select`, `in-game-loading`, `in-game`, `end-of-game`, `results-late` (the EOG payload arrives after 3 retries), `challenges-loaded`, `backfill-running`, and `backfill-error`.
- [ ] Add states to `parity/states.ts` for every client-dependent row in Appendix F. That covers the four status dots, the Live Game decision tree, Challenges loaded and offline, the Match History importing and no-games states, the backfill toast, and the live pulse on the nav.

**You see.**

- [ ] `bun parity/capture.ts --app electron --states client` writes every client-dependent state into the baseline folder, and two runs match under the same-engine policy.

**Verify, unit.** @@RULE@@

- [ ] `parity/test/fake-lcu.test.ts` connects with Node's `https` using only the fake CA, subscribes over WebSocket, and asserts each scenario's frames arrive in order with the recorded delays.

**Verify, live.** @@LIVE@@

- [ ] Lane 1. Regression lane against trunk. Run trunk Electron against `connected-idle` and against no client. Save `status-connected.png` and `status-disconnected.png`. Pass when the sidebar dot is green with the profile name in the first and red in the second.
- [ ] Lane 2. Run `in-game`. Save `live-in-game.png`. Pass when the Live Game page shows the scoreboard and the nav shows the live pulse.
- [ ] Lane 3. Run `in-game-loading`. Save `live-loading.png`. Pass when the hourglass panel shows.
- [ ] Lane 4. Run `end-of-game`. Save `eog-captured.png`. Pass when a new row appears at the top of Match History and `main.log` shows the capture line.
- [ ] Lane 5. Run `results-late`. Save `live-waiting.png`. Pass when "Fetching the results" shows until the fourth attempt and then the recap shows.
- [ ] Lane 6. Run `challenges-loaded`. Save `challenges.png`. Pass when the capstone card and category cards show.
- [ ] Lane 7. Run `backfill-running`. Save `backfill-toast.png`. Pass when the activity toast shows a progress bar at the bottom right.
- [ ] Lane 8. Run `backfill-error`. Save `backfill-error.png`. Pass when the error toast shows and hides after 10 s.
- [ ] Lane 9. Run `connected-idle` on `windows-latest`. Save `win-status-connected.png`. Pass when the green dot shows and the PowerShell fallback never ran, per `seam.log`.
- [ ] Lane 10. Start the real League client, if present, alongside the fake one. Save `isolation.log`. Pass when `seam.log` shows the app reached only the fake port.

**Verify, perf.** @@RULE@@

- [ ] Metric. Trunk has no fake client, so this unit sets an absolute budget for the work it adds, the time from fake-client start to the app's `connected` status.
- [ ] Probe. Run `bun parity/capture.ts --states status-connected --timing` 10 times.
- [ ] Baseline. Record the first run's connect time first.
- [ ] Rule. Fail when the median exceeds 7 s, since the app's connect loop runs every 5 s.

@@NOGATE T03@@

@@MERGE@@

## Capture dialogs, toasts, menus, and hover states (T04)

**Depends on.** T02.

**Files.**

- [ ] Edit `parity/states.ts`, `parity/drive.ts`, and `parity/seam.cjs`.
- [ ] Create `parity/menus.ts` and `parity/fake-github.ts`.
- [ ] Create `parity/test/menus.test.ts`.

**Build.**

- [ ] Write `parity/fake-github.ts`. It serves `GET /repos/rambo0247/better-mayhem-tracker/releases?per_page=20` with scenario bodies, and the seam points the updater's `fetch` at it. Scenarios are `up-to-date`, `update-available`, `downloading`, `notes-single`, and `notes-multi`.
- [ ] Add states for every overlay row in Appendix F. That covers the Update dialog in each variant, What's New single and multiple, the recovery banner in each `problem` by `restoredFrom` by `quarantined` variant, every hover card type, the score breakdown tooltip, the filter menu open on each page, the Match History context menu, and both export message pills.
- [ ] Write `parity/menus.ts`. It dumps the tray menu and the macOS app menu as JSON with item labels, separators, enabled state, and accelerators, from Electron's `Menu` objects through the seam. Native menus do not screenshot reliably, so the JSON is the baseline. Where Screen Recording is granted, it also saves a picture of the open tray menu.
- [ ] Record the tray's click and double-click behavior on each platform into the menu baseline, since Tauri has no macOS double-click event.

**You see.**

- [ ] `bun parity/capture.ts --app electron --states overlays` writes every overlay state, and `bun parity/menus.ts --app electron` writes `tray-menu.json` and `app-menu.json`.

**Verify, unit.** @@RULE@@

- [ ] `parity/test/menus.test.ts` asserts the tray dump lists `Show Window`, a separator, and `Quit`, in that order.

**Verify, live.** @@LIVE@@

- [ ] Lane 1. Regression lane against trunk. Run trunk Electron with `update-available`. Save `update-button.png`. Pass when the header shows "Update available".
- [ ] Lane 2. Open the Update dialog in its `downloading` variant. Save `update-downloading.png`. Pass when the progress bar shows and the scrim is blurred.
- [ ] Lane 3. Run `notes-multi`. Save `whats-new-multi.png`. Pass when every release since `last_run_version` lists.
- [ ] Lane 4. Seed a `missing` recovery report restored from a backup. Save `recovery-banner.png`. Pass when the amber `role=alert` banner names the backup.
- [ ] Lane 5. Hover an augment icon in an expanded match. Save `augment-hover.png`. Pass when the hover card shows rarity and description text.
- [ ] Lane 6. Hover a score cell. Save `score-breakdown.png`. Pass when the breakdown tooltip shows.
- [ ] Lane 7. Right-click a match row. Save `context-menu.png`. Pass when Add to Favorites, Copy Image, and Export as PNG show.
- [ ] Lane 8. Dump the tray and app menus on macOS. Save `tray-menu.json`. Pass when the dump matches `Menu.buildFromTemplate` in `src/main/index.ts`.
- [ ] Lane 9. Dump the tray menu on `windows-latest`. Save `win-tray-menu.json`. Pass when it matches the macOS tray dump and records double-click as showing the window.
- [ ] Lane 10. Press Escape inside an open dialog. Save `dialog-esc.png`. Pass when the dialog closes and focus returns to the opener.

**Verify, perf.** @@RULE@@

- [ ] Metric. Trunk has no overlay states, so this unit sets an absolute budget for its added work, wall time per overlay state.
- [ ] Probe. Run `time bun parity/capture.ts --states overlays` three times.
- [ ] Baseline. Record the first run's per-state time first.
- [ ] Rule. Fail when any overlay state takes more than 20 s.

@@NOGATE T04@@

@@MERGE@@

## Record IPC goldens from Electron (T05)

**Depends on.** T02.

**Files.**

- [ ] Create `parity/record-ipc.ts`, `parity/ipc-cases.ts`, and `parity/canon.ts`.
- [ ] Create `parity/test/canon.test.ts`.
- [ ] Edit `parity/seam.cjs`.

**Build.**

- [ ] Write `parity/ipc-cases.ts`, one table of calls with arguments for each of the 61 channels in `INVOKE_CHANNELS` (`src/shared/api.ts:1183`). It includes argument variants for filters, sorts, pages, seasons, queues, and accounts, and the read-only calls first. Write calls such as `setSetting`, `toggleFavorite`, `createBackup`, and `importData` run last on a fresh fixture copy each.
- [ ] Extend the seam to wrap `ipcMain._invokeHandlers` and `webContents.send`. It records each call's arguments, result or thrown error, and every event payload in order with timestamps relative to launch.
- [ ] Write `parity/record-ipc.ts`. It runs every case against the fixture with the frozen clock, and the T03 scenarios for the event-driven channels. It writes `parity/out/golden/ipc/<channel>/<case>.json` and `parity/out/golden/events/<scenario>.jsonl`.
- [ ] Write `parity/canon.ts`, the canonical JSON form that both sides compare. Object keys are sorted. Floats compare after JSON round-trip with the exact digits JavaScript prints. Fields that depend on the wall clock are listed by name and replaced with a marker.
- [ ] Write a coverage check that fails when a channel in `INVOKE_CHANNELS` or an event in `RendererEvents` has no golden.

**You see.**

- [ ] `bun parity/record-ipc.ts --data fixture` writes goldens for 61 channels and 11 events and prints `coverage 61/61 channels, 11/11 events`.

**Verify, unit.** @@RULE@@

- [ ] `parity/test/canon.test.ts` asserts that key order does not matter, that `0.1 + 0.2` keeps its JavaScript digits, and that a listed clock field is masked while an unlisted one is not.

**Verify, live.** @@LIVE@@

- [ ] Lane 1. Regression lane against trunk. Record goldens twice from trunk Electron. Save `golden-stable.log`. Pass when every file is byte-identical across the runs.
- [ ] Lane 2. Record `getMatchHistory` with 3 filter variants. Save `match-history-golden.log`. Pass when row counts match `sqlite3 -readonly` counts for the same filters.
- [ ] Lane 3. Record `getSetting` for a key outside the 10-key allow list. Save `setting-denied.log`. Pass when the golden holds the error Electron throws.
- [ ] Lane 4. Record the `end-of-game` scenario's events. Save `eog-events.log`. Pass when `lcu:games-updated` follows the capture in the recorded order.
- [ ] Lane 5. Record `backfill-running`. Save `backfill-events.log`. Pass when the progress events increase and end with the done event.
- [ ] Lane 6. Record `toggleFavorite` twice on a fresh copy. Save `favorite.log`. Pass when the second call restores the first state.
- [ ] Lane 7. Record `createBackup` then `listBackups`. Save `backup-golden.log`. Pass when the new backup's name follows the `matches-<ISO>-auto.db` pattern with the frozen clock.
- [ ] Lane 8. Record `exportData` to a temp file. Save `export-golden.log`. Pass when the golden keeps the file's bytes and the JSON reports format version 3.
- [ ] Lane 9. Record all goldens on `windows-latest`. Save `win-golden-diff.log`. Pass when every Windows golden equals the macOS one, or the differences are only platform paths and the list of them is committed.
- [ ] Lane 10. Run the coverage check against a copy of `api.ts` with one channel added. Save `coverage-fail.log`. Pass when it fails and names the channel.

**Verify, perf.** @@RULE@@

- [ ] Metric. Electron invoke round-trip time per channel, recorded with the goldens as the trunk numbers the Rust units compare against.
- [ ] Probe. Run `bun parity/record-ipc.ts --timing --repeat 50`, which calls each read-only case 50 times interleaved across channels.
- [ ] Baseline. This unit is the baseline. Record the median and p95 per channel into `parity/out/golden/timing.json`.
- [ ] Rule. Fail when two consecutive timing runs disagree on any channel's median by more than 20%, since a noisy baseline cannot gate later units.

@@NOGATE T05@@

@@MERGE@@

## Measure Electron 1.2.1 size, memory, and launch time on both platforms (T06)

**Depends on.** T02.

**Files.**

- [ ] Create `parity/perf.ts`, `parity/perf/memory-mac.ts`, `parity/perf/memory-win.ps1`, and `parity/perf/first-content.ts`.
- [ ] Create `.github/workflows/parity.yml`.
- [ ] Create `parity/test/perf.test.ts`.

**Build.**

- [ ] Write the size probe. It reads the byte size of each 1.2.1 release asset with `gh release view v1.2.1 --json assets`, and the installed size of the unpacked `.app` and of the Windows exe.
- [ ] Write `parity/perf/memory-mac.ts`. It sums `phys_footprint` from `footprint` for the app process and every helper the app owns. For Electron that is the Helper (GPU), Helper (Renderer), and Helper processes. For Tauri it is the `com.apple.WebKit.WebContent`, `GPU`, and `Networking` XPC processes whose responsible process is the app. It also reports summed RSS from `ps` so the two methods can be compared.
- [ ] Write `parity/perf/memory-win.ps1`. It sums the private working set of the app process tree. For Tauri the tree includes the `msedgewebview2.exe` children.
- [ ] Write `parity/perf/first-content.ts`. Time runs from process spawn to the first Match History row painted. For packaged Electron 1.2.1 it connects over `--remote-debugging-port`, which the fuses allow and `ci.yml` already uses, and polls for the first row. For Tauri it reads the `first-content` line that the T27 build logs when `BMT_PERF=1`.
- [ ] Write `parity/perf.ts`. It runs launch, waits for first content, idles 60 s with the window visible and the client absent, then samples memory five times 10 s apart and reports the median. It interleaves Electron and Tauri runs, 10 each, with a cold start before each pair.
- [ ] Write `.github/workflows/parity.yml`, triggered by `workflow_dispatch` only. It runs named lanes and the perf probe on `windows-latest` and `macos-latest` and uploads `parity/out/` as an artifact.

**You see.**

- [ ] `bun parity/perf.ts --app electron-1.2.1` prints download size, installed size, idle memory, and launch to first content, with the median and spread over 10 runs, on macOS and on `windows-latest`.

**Verify, unit.** @@RULE@@

- [ ] `parity/test/perf.test.ts` feeds a recorded `footprint` and `ps` sample and asserts the helper attribution and the median.

**Verify, live.** @@LIVE@@

- [ ] Lane 1. Regression lane against trunk. Trunk has no probe. Run the probe on the packaged 1.2.1 `.app` from the release, with a snapshot user-data folder. Save `electron-mac-perf.json`. Pass when all four numbers print with a spread under 15% of the median.
- [ ] Lane 2. Run the probe on `windows-latest` with the 1.2.1 exe. Save `electron-win-perf.json`. Pass when all four numbers print.
- [ ] Lane 3. Compare the summed footprint with Activity Monitor's Memory column for the same processes. Save `memory-crosscheck.png`. Pass when they agree within 10%.
- [ ] Lane 4. Run the memory probe on the T01 empty Tauri shell. Save `tauri-shell-memory.json`. Pass when it counts the WebContent process.
- [ ] Lane 5. Kill the renderer helper during idle. Save `missing-helper.log`. Pass when the probe reports the run invalid and does not record a number.
- [ ] Lane 6. Run first content with the client absent. Save `first-content.log`. Pass when the measured row belongs to the fixture's newest game.
- [ ] Lane 7. Run the probe twice in a row. Save `repeatability.json`. Pass when medians agree within 10%.
- [ ] Lane 8. Read the 1.2.1 asset sizes. Save `release-sizes.json`. Pass when each matches `gh release view` byte for byte.
- [ ] Lane 9. Confirm the probe never writes to the real data folder by comparing `shasum` before and after. Save `perf-isolation.log`. Pass when nothing changed.
- [ ] Lane 10. Run `parity.yml` with lanes `perf` and confirm the artifact. Save `parity-artifact.log`. Pass when the artifact holds the Windows JSON.

**Verify, perf.** @@RULE@@

- [ ] Metric. Electron 1.2.1 download size, installed size, idle memory across all processes, and launch to first content, on macOS arm64 and Windows x64.
- [ ] Probe. `bun parity/perf.ts --app electron-1.2.1 --runs 10`, with cold starts interleaved, on the operator's Mac and on `windows-latest`.
- [ ] Baseline. This unit is the baseline. Commit the medians into `parity/out/perf/electron-1.2.1.json` and copy them into Appendix A.
- [ ] Rule. Fail when the spread of any metric exceeds 15% of its median, since T40 compares against these numbers.

@@NOGATE T06@@

@@MERGE@@

## Add the Tauri parity driver and the cross-engine diff gate (T07)

**Depends on.** T02.

**Files.**

- [ ] Create `tauri/src-tauri/src/parity_driver.rs`, `tauri/src-tauri/src/snapshot/mod.rs`, `snapshot/mac.rs`, and `snapshot/win.rs`.
- [ ] Edit `tauri/src-tauri/Cargo.toml` to add the `parity-driver` feature, and `tauri/src-tauri/src/lib.rs`.
- [ ] Create `parity/run-tauri.ts` and `parity/replay-api.js`.
- [ ] Edit `parity/drive.ts`, `parity/capture.ts`, and `parity/README.md`.
- [ ] Edit `.github/workflows/tauri-ci.yml` to fail a release build that contains the driver.

**Build.**

- [ ] Write `tauri/src-tauri/src/parity_driver.rs`, compiled only with the `parity-driver` feature. It listens on `127.0.0.1` with a token from the environment and accepts `eval`, `click`, `hover`, `type`, `key`, `scroll`, `resize`, `navigate`, `dom`, `geometry`, and `snapshot`.
- [ ] Write `snapshot/mac.rs` with `takeSnapshotWithConfiguration` through `with_webview` and objc2, the prototype's method. Write `snapshot/win.rs` with WebView2 `CallDevToolsProtocolMethod("Page.captureScreenshot")`, the call Playwright makes. T25 reuses both for card export.
- [ ] Write `parity/run-tauri.ts`. It starts the debug build with the data folder, clock, locale, time zone, and window size that `run-electron.ts` uses, and drives it through the driver.
- [ ] Write `parity/replay-api.js`. It answers `window.api` calls from the T05 goldens, so the built Electron renderer can run inside the Tauri webview before any Rust command exists.
- [ ] Add a `tauri-ci.yml` step that builds release and fails when `strings` finds the driver's command names in the binary.

**You see.**

- [ ] `bun parity/run-tauri.ts --renderer electron --state match-history-default` shows the Electron renderer inside the Tauri window and writes a PNG and a geometry file.
- [ ] `bun parity/diff.ts` against the Electron baseline prints the cross-engine numbers for every default state on macOS, and the same-engine numbers on Windows WebView2.

**Verify, unit.** @@RULE@@

- [ ] `cargo test -p better-mayhem-tracker --features parity-driver driver` asserts the driver refuses a request without the token and refuses a non-loopback peer.
- [ ] `parity/test/replay.test.ts` asserts the replay API returns the golden for a known call and throws a named error for an unknown one.

**Verify, live.** @@LIVE@@

- [ ] Lane 1. Regression lane against trunk. Run the Electron renderer in trunk Electron and in the head Tauri webview on macOS for Match History. Save `mh-side-by-side.png`. Pass when the layout gate passes and the only tile failures are the champion portraits from `object-view-box`.
- [ ] Lane 2. Repeat lane 1 on `windows-latest`. Save `win-mh-side-by-side.png`. Pass when the result is recorded, and decision E1's Windows policy is set from it.
- [ ] Lane 3. Take two WKWebView snapshots of the same state. Save `wk-repeat.png`. Pass when the same-engine policy passes.
- [ ] Lane 4. Drive a hover through the driver. Save `driver-hover.png`. Pass when the hover card shows, as in the Electron baseline.
- [ ] Lane 5. Resize to 1179 px through the driver. Save `driver-rail.png`. Pass when the rail layout shows.
- [ ] Lane 6. Send a driver request with a wrong token. Save `driver-token.log`. Pass when it is refused.
- [ ] Lane 7. Build release and search it for driver strings. Save `release-no-driver.log`. Pass when none are found.
- [ ] Lane 8. Capture the What's New dialog through the driver. Save `blur-region.png`. Pass when the declared blur region passes at threshold 0.2.
- [ ] Lane 9. Capture all default states cross-engine on macOS. Save `cross-engine-report.json`. Pass when every state's numbers are recorded and the failures are listed by cause.
- [ ] Lane 10. Run the driver's `geometry` on Match History in both apps. Save `geometry-diff.json`. Pass when element counts match and no box moves more than 1 CSS px.

**Verify, perf.** @@RULE@@

- [ ] Metric. Time to capture one state, Electron through Playwright against Tauri through the driver.
- [ ] Probe. Capture the same 10 states alternately in each app, three rounds.
- [ ] Baseline. Record the Electron per-state median first.
- [ ] Rule. Fail when the Tauri per-state median exceeds twice the Electron median.

@@NOGATE T07@@

@@MERGE@@
