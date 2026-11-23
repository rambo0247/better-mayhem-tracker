## Generate the command contract from Rust and stub every channel (T08)

**Depends on.** T05 and T07.

**Files.**

- [ ] Create `tauri/src-tauri/src/commands/mod.rs`, one file per domain under `commands/`, and `tauri/src-tauri/src/events.rs`.
- [ ] Create `tauri/src-tauri/src/bin/export_bindings.rs`.
- [ ] Create `tauri/src/bindings.ts` (generated) and `tauri/src/api.ts`.
- [ ] Create `tauri/src-tauri/tests/golden.rs` and `tauri/scripts/contract-check.ts`.
- [ ] Edit `tauri/src-tauri/Cargo.toml` and `tauri/src-tauri/src/lib.rs`.

**Build.**

- [ ] Define every request and response type once, in Rust, with the field names and casing `src/shared/api.ts` uses per struct. About 80 database row fields stay snake_case and about 288 fields are camelCase, so each struct picks its own `rename_all`, and tagged enums add `rename_all_fields`. Use `#[ts(optional)]` where `api.ts` writes `?:` and plain `Option` where it writes `| null`.
- [ ] Generate the types into `tauri/src/bindings.ts` with `ts-rs` 12.0.1 and `TS_RS_LARGE_INT=number`, per decision E5, from `bin/export_bindings.rs`. The same binary writes the 61 command names and argument lists from the Rust registry into `bindings.ts` as one typed `invoke` wrapper each. The generated file is committed, and CI fails when regenerating it changes it.
- [ ] Register all 61 commands under their Electron channel names and all 11 events under their Electron event names. Each command body returns the error `not ported` until its unit lands.
- [ ] Write `tauri/src/api.ts`. It exposes the same `window.api` shape the preload exposes today, including `platform` and `locale`, built on the generated bindings, so the Solid UI calls the same method names as the React UI.
- [ ] Write `tauri/scripts/contract-check.ts`. It parses `INVOKE_CHANNELS` and `RendererEvents` from `src/shared/api.ts` and the generated bindings, and fails on any name, argument, or field that differs. It runs in `tauri-ci.yml` until T41 deletes `src/shared/api.ts`.
- [ ] Write `tauri/src-tauri/tests/golden.rs`. It replays every T05 golden against the Rust commands over a fresh copy of the fixture, compares canonical JSON with `parity/canon.ts` rules ported to Rust, and prints a table of channels as `pass`, `fail`, or `not ported`. CI fails only on `fail`, so each later unit moves its channels from `not ported` to `pass`.

**You see.**

- [ ] `cargo test --test golden` prints `0 pass, 0 fail, 61 not ported`.
- [ ] `bun tauri/scripts/contract-check.ts` prints `contract matches, 61 commands, 11 events`.

**Verify, unit.** @@RULE@@

- [ ] `tauri/scripts/contract-check.test.ts` renames one field in a copy of the bindings and asserts the check fails and names the field.
- [ ] `cargo test --test golden` asserts a hand-made wrong answer for one stub reports `fail`, not `not ported`.

**Verify, live.** @@LIVE@@

- [ ] Lane 1. Regression lane against trunk. Load the Electron renderer in the head Tauri webview with `tauri/src/api.ts` in place of the replay API. Save `stub-errors.png`. Pass when every page's first call fails with `not ported` and nothing else throws.
- [ ] Lane 2. Diff the generated bindings against `src/shared/api.ts` by hand for `MatchSummary`, `LcuStatus`, and `GameRecap`. Save `types-sample.log`. Pass when field names, optionality, and number types match.
- [ ] Lane 3. Check how `i64` ids and `f64` stats are typed in the bindings. Save `ids.log`. Pass when both are plain `number`, as in `api.ts`.
- [ ] Lane 4. Check how `Option` fields serialize. Save `optional-fields.log`. Pass when the JSON matches Electron's goldens, `null` where Electron sends `null` and absent where Electron omits the key.
- [ ] Lane 5. Emit each of the 11 events from a debug command. Save `events.log`. Pass when the UI shim's listeners receive each under its Electron name.
- [ ] Lane 6. Regenerate the bindings and run `git diff --exit-code tauri/src/bindings.ts`. Save `bindings-fresh.log`. Pass when nothing changed.
- [ ] Lane 7. Run `contract-check.ts` on `windows-latest`. Save `win-contract.log`. Pass when it matches.
- [ ] Lane 8. Call a command that does not exist from the webview. Save `unknown-command.log`. Pass when it fails the same way Electron's `invoke` fails for an unknown channel, per the golden.
- [ ] Lane 9. Run `cargo test --test golden` and read the table. Save `golden-table.log`. Pass when it lists 61 rows, all `not ported`.
- [ ] Lane 10. Run `cargo clippy --all-targets -- -D warnings`. Save `clippy.log`. Pass when it exits 0.

**Verify, perf.** @@RULE@@

- [ ] Metric. Invoke round-trip for a stub command against Electron's round-trip for its cheapest channel, `getVersion`.
- [ ] Probe. Call each 1,000 times from its renderer, alternating apps every 100 calls.
- [ ] Baseline. Record Electron's `getVersion` median from the T05 timing file first.
- [ ] Rule. Fail when the Tauri stub's median exceeds Electron's by more than 0.5 ms.

@@NOGATE T08@@

@@MERGE@@

## Port paths, logging, locale, install location, and the security policy (T09)

**Depends on.** T08.

**Files.**

- [ ] Create `tauri/src-tauri/src/paths.rs`, `log.rs`, `locale.rs`, `install_location.rs`, and `security.rs`.
- [ ] Create `tauri/src-tauri/src/data_guard.rs`.
- [ ] Edit `tauri/src-tauri/src/commands/app.rs`, `lib.rs`, and `tauri.conf.json`.

**Build.**

- [ ] Port `src/main/paths.ts`. The data root is `better-mayhem-tracker` under `~/Library/Application Support` or `%APPDATA%`, never the Tauri identifier folder. Subfolders are `data/`, `backups/`, `logs/`, and `asset-cache/`. `BMT_DATA_ROOT` overrides the root for lanes.
- [ ] Write `data_guard.rs`. A debug build that resolves the root to the real folder without `BMT_ALLOW_REAL_DATA=1` exits at startup with a message. Release builds skip the guard.
- [ ] Port `src/main/log.ts` byte for byte. Lines are local time `YYYY-MM-DD HH:MM:SS.mmm LEVEL msg`, the version line comes first, and rollover happens at 2 MiB. The `ci.yml` greps keep working against the Tauri log.
- [ ] Port `locale.ts` with `sys-locale`. Port `install-location.ts`. On Windows the durable exe is `current_exe()`, because the Tauri exe runs in place. On macOS the translocation and `/Volumes` checks stay.
- [ ] Port `security.ts` as the CSP in `tauri.conf.json`, a navigation handler that blocks every non-app URL, and the `openExternal` allow list.
- [ ] Port `getVersion`, `getPlatform`-style values, and the `app:*` channels this module owns.

**You see.**

- [ ] The Tauri log at `<root>/logs/main.log` starts with the same version line as Electron's, and `cargo test --test golden` moves the `app:*` channels to `pass`.

**Verify, unit.** @@RULE@@

- [ ] `tauri/src-tauri/src/log.rs` tests assert the line format against a line copied from a real Electron log, and the rollover at 2 MiB.
- [ ] `paths.rs` tests assert both platform roots and the override.
- [ ] `data_guard.rs` tests assert the guard fires on the real path in debug.

**Verify, live.** @@LIVE@@

- [ ] Lane 1. Regression lane against trunk. Start trunk Electron and head Tauri on the same snapshot and diff the first 5 log lines after stripping timestamps. Save `log-diff.log`. Pass when they match.
- [ ] Lane 2. Start a debug build with no override on the operator's Mac. Save `guard.log`. Pass when it exits before opening any file in the real folder.
- [ ] Lane 3. Read the data root on `windows-latest`. Save `win-root.log`. Pass when it is `%APPDATA%\better-mayhem-tracker`.
- [ ] Lane 4. Click an external link to a host outside the allow list from the webview. Save `blocked-nav.log`. Pass when nothing opens and the log line matches Electron's.
- [ ] Lane 5. Click a GitHub release link. Save `allowed-open.log`. Pass when the default browser opens it.
- [ ] Lane 6. Run with `LANG=de_DE.UTF-8`. Save `locale.log`. Pass when `window.api.locale` equals Electron's under the same setting.
- [ ] Lane 7. Fill the log past 2 MiB with a debug command. Save `rollover.log`. Pass when the old file rolls over with Electron's name.
- [ ] Lane 8. Run the `ci.yml` log greps against the Tauri log. Save `ci-greps.log`. Pass when each grep finds its line.
- [ ] Lane 9. Launch the macOS build from a mounted `.dmg`. Save `translocated.log`. Pass when install location reports not durable, as Electron does.
- [ ] Lane 10. Run golden replay. Save `golden-table.log`. Pass when the `app:*` rows pass and no row fails.

**Verify, perf.** @@RULE@@

- [ ] Metric. Time from process start to the first log line, in both apps.
- [ ] Probe. Launch each app 10 times alternately on the same snapshot.
- [ ] Baseline. Record Electron's median first.
- [ ] Rule. Fail when Tauri's median is slower than Electron's.

@@NOGATE T09@@

@@MERGE@@

## Port the window, tray, single instance, and quit flow (T10)

**Depends on.** T09.

**Files.**

- [ ] Create `tauri/src-tauri/src/shell.rs`, `tray.rs`, and `app_menu.rs`.
- [ ] Edit `tauri/src-tauri/src/lib.rs`, `tauri.conf.json`, `capabilities/default.json`, and `commands/window.rs`.
- [ ] Add `assets/tray.png` and `assets/tray@2x.png` to the bundle resources.

**Build.**

- [ ] Set the macOS window to `titleBarStyle` Overlay with `trafficLightPosition` `{x:16, y:24}`, which the T01 prototype measured as matching Electron's `{x:16, y:15}`. Set the Windows window to `decorations` false.
- [ ] Port the tray with `Show Window`, a separator, and `Quit`, the tooltip `Better Mayhem Tracker`, and the same `tray.png` and `tray@2x.png`. Match the click and double-click behavior T04 recorded on each platform.
- [ ] Add `tauri-plugin-single-instance`. A second launch shows, restores, and focuses the first window, then exits 0.
- [ ] Port close-to-tray with the `minimize_to_tray` setting, the `--hidden` launch, the macOS `Reopen` event, and the window controls with the `window:maximized-changed` event.
- [ ] Port quit. Tray Quit and Cmd+Q run the final fetch hook with the 5 s cap from `FINAL_FETCH_TIMEOUT_MS`, then stop polling and exit. The hook calls into T20's sync once it lands.
- [ ] Add a macOS app menu so Cmd+C, Cmd+V, and Cmd+Q work, matching T04's `app-menu.json`.
- [ ] Bind F12 and Ctrl+Shift+I to toggle devtools in every build, as Electron does. That needs the `devtools` feature on `tauri-runtime-wry`.

**You see.**

- [ ] The Tauri window has the traffic lights where Electron's are, the tray menu matches the baseline dump, closing the window hides it, and a second launch brings it back.

**Verify, unit.** @@RULE@@

- [ ] `shell.rs` tests assert the close decision for each `minimize_to_tray` value and for quitting.
- [ ] `tray.rs` tests assert the menu items match `parity/out/baseline/tray-menu.json`.

**Verify, live.** @@LIVE@@

- [ ] Lane 1. Regression lane against trunk. Capture the title bar region in both apps on macOS. Save `traffic-lights.png`. Pass when the same-engine policy passes on the traffic light crop.
- [ ] Lane 2. Capture the Windows title bar in both apps. Save `win-title-bar.png`. Pass when the min, max, and close buttons line up within 1 px.
- [ ] Lane 3. Dump the tray menu. Save `tray-menu.json`. Pass when it equals the Electron dump.
- [ ] Lane 4. Close the window with `minimize_to_tray` on, then click Show Window. Save `close-to-tray.png`. Pass when the window hides and comes back.
- [ ] Lane 5. Close the window with `minimize_to_tray` set to `false`. Save `close-quits.log`. Pass when the process exits and the log ends with `Shutting down`.
- [ ] Lane 6. Launch a second instance. Save `second-instance.log`. Pass when it exits 0 and the first window shows.
- [ ] Lane 7. Launch with `--hidden`. Save `hidden-launch.log`. Pass when no window shows and the tray icon is present.
- [ ] Lane 8. Maximize and restore on Windows. Save `win-maximize.png`. Pass when the max button icon swaps as in Electron.
- [ ] Lane 9. Press F12. Save `devtools.png`. Pass when devtools open.
- [ ] Lane 10. Quit from the tray with the fake client connected. Save `quit-final-fetch.log`. Pass when the final fetch runs and the process exits within 5 s.

**Verify, perf.** @@RULE@@

- [ ] Metric. Idle memory across all processes with the window hidden to the tray, in both apps.
- [ ] Probe. `bun parity/perf.ts --scenario hidden-idle --runs 10`, alternating apps.
- [ ] Baseline. Record Electron's median first.
- [ ] Rule. Fail when Tauri's median exceeds 60% of Electron's.

@@GATE T10 1,2,4,8@@

@@MERGE@@

## Port the database core and prove the data opens unchanged (T11)

**Depends on.** T09.

**Files.**

- [ ] Create `tauri/src-tauri/src/db/mod.rs`, `connection.rs`, `schema.rs`, `migrations.rs`, `settings.rs`, `payloads.rs`, `summoner.rs`, `filters.rs`, and `stmt.rs`.
- [ ] Edit `tauri/src-tauri/src/commands/settings.rs` and `lib.rs`.
- [ ] Create `tauri/src-tauri/tests/db_compat.rs`.

**Build.**

- [ ] Open the database with `journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON`, and `busy_timeout(5000)`, the better-sqlite3 default.
- [ ] Port `schema.ts` and `migrations.ts` with the same DDL text, the 12 tables, 10 indexes, and 1 trigger, and `user_version` 4. Port every migration from V1, so an old backup restored later still upgrades.
- [ ] Write `stmt.rs`. It resolves column names to indexes once per prepared statement and reads rows by index, because reading by name per row tripled query time in the spike.
- [ ] Port settings get and set with the 10-key `getSetting` allow list as a boundary in Rust.
- [ ] Port payload pack and unpack for the gzipped `raw_gz` blob with the same gzip level, so bytes Rust writes equal bytes Node writes.
- [ ] Port summoner and filter helpers.

**You see.**

- [ ] Opening a snapshot that is already at version 4 leaves `matches.db` byte-identical after a clean quit, and the settings channels pass golden replay.

**Verify, unit.** @@RULE@@

- [ ] `tests/db_compat.rs` creates a fresh database in Rust and asserts `sqlite_master` text equals the one Electron creates, read from a T05 golden.
- [ ] It upgrades a V1 database from a fixture and asserts the result equals a fresh V4 database.
- [ ] It packs a payload and asserts the bytes equal Node's `zlib.gzipSync` output stored in the golden.

**Verify, live.** @@LIVE@@

- [ ] Lane 1. Regression lane against trunk. Open the same snapshot in trunk Electron and in head Tauri, then quit both. Save `open-unchanged.log`. Pass when `sqlite3 -readonly` dumps of both copies are identical and `PRAGMA user_version` is 4 in both.
- [ ] Lane 2. Open a snapshot in Tauri, then open the result in trunk Electron. Save `roundtrip.log`. Pass when Electron opens it without migration and shows the same Match History screenshot.
- [ ] Lane 3. Run `PRAGMA integrity_check` after a Tauri session. Save `integrity.log`. Pass when it prints `ok`.
- [ ] Lane 4. Call `getSetting` with a key outside the allow list. Save `setting-denied.log`. Pass when the error equals the golden.
- [ ] Lane 5. Write a setting in Tauri and read it in Electron. Save `setting-cross.log`. Pass when Electron reads the value.
- [ ] Lane 6. Lock the database from a second `sqlite3` process for 3 s during a write. Save `busy.log`. Pass when the write waits and succeeds, as in Electron.
- [ ] Lane 7. Open a V1 database. Save `migrate-v1.log`. Pass when it reaches version 4 and its dump equals Electron's migration of the same file.
- [ ] Lane 8. Run the same checks on `windows-latest`. Save `win-db-compat.log`. Pass when every check passes.
- [ ] Lane 9. Run golden replay. Save `golden-table.log`. Pass when the settings rows pass and no row fails.
- [ ] Lane 10. Kill the Tauri process mid-write and reopen. Save `crash-reopen.log`. Pass when the WAL recovers and `integrity_check` prints `ok`.

**Verify, perf.** @@RULE@@

- [ ] Metric. Time to open the database and run migrations on the 669-game snapshot, in both apps.
- [ ] Probe. Open and close 20 times alternately with a cold page cache before each pair.
- [ ] Baseline. Record Electron's median first.
- [ ] Rule. Fail when Tauri's median exceeds Electron's by more than 20%.

@@NOGATE T11@@

@@MERGE@@

## Port scoring and ingest (T12)

**Depends on.** T11.

**Files.**

- [ ] Create `tauri/src-tauri/src/op_score.rs`, `db/scoring.rs`, and `db/ingest.rs`.
- [ ] Create `parity/score-golden.ts` and `tauri/src-tauri/tests/score_golden.rs`.

**Build.**

- [ ] Port `src/shared/opScore.ts`, `db/scoring.ts`, and `db/ingest.ts`, including `insertGameFull`, the ignored and known id sets, and the score backfill that waits for champion class data.
- [ ] Write `parity/score-golden.ts`. It runs the TypeScript `opScore` over every game in the fixture and writes each score with its inputs.
- [ ] Match JavaScript float behavior. Use `f64` throughout, the same operation order, and the same rounding calls, since a reordered sum changes the last digit.

**You see.**

- [ ] `cargo test --test score_golden` prints `669/669 games match` on the fixture.

**Verify, unit.** @@RULE@@

- [ ] `tests/score_golden.rs` asserts every fixture game's score equals the TypeScript score exactly.
- [ ] `db/ingest.rs` tests insert one recorded game payload and assert every row equals the row Electron wrote, read from a golden.

**Verify, live.** @@LIVE@@

- [ ] Lane 1. Regression lane against trunk. Ingest the `end-of-game` payload in both apps on fresh fixture copies. Save `ingest-diff.log`. Pass when a `sqlite3 -readonly` dump of the new rows is identical.
- [ ] Lane 2. Run the score backfill on a copy with scores cleared. Save `backfill-scores.log`. Pass when every score equals Electron's backfill.
- [ ] Lane 3. Ingest the same game twice. Save `ingest-twice.log`. Pass when the second insert is a no-op, as in Electron.
- [ ] Lane 4. Ingest a remake. Save `remake.log`. Pass when its flags match Electron's.
- [ ] Lane 5. Ingest a game with an ignored queue. Save `ignored-queue.log`. Pass when it lands in the ignored set as in Electron.
- [ ] Lane 6. Ingest before champion data loads. Save `scores-wait.log`. Pass when scoring waits and the result equals Electron's.
- [ ] Lane 7. Compare score golden output on `windows-latest`. Save `win-scores.log`. Pass when all games match.
- [ ] Lane 8. Compare MVP and ACE flags for every fixture game. Save `badges.log`. Pass when every flag matches.
- [ ] Lane 9. Run golden replay. Save `golden-table.log`. Pass when no row fails.
- [ ] Lane 10. Ingest 50 games in one transaction and kill the process midway. Save `ingest-atomic.log`. Pass when either all or none are present after reopen.

**Verify, perf.** @@RULE@@

- [ ] Metric. Time to score all 669 fixture games, TypeScript in Node against Rust.
- [ ] Probe. Run each 10 times alternately.
- [ ] Baseline. Record the TypeScript median first.
- [ ] Rule. Fail when Rust's median is slower than TypeScript's.

@@NOGATE T12@@

@@MERGE@@
