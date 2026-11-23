## Build Tauri release artifacts in CI under the current asset names (T39)

**Depends on.** T24, T37, and T38.

**Files.**

- [ ] Create `.github/workflows/tauri-release.yml`.
- [ ] Create `tauri/scripts/package.ts`.
- [ ] Edit `tauri/src-tauri/tauri.conf.json` and `tauri/package.json`.

**Build.**

- [ ] Write `tauri-release.yml`, triggered by `tauri-v*` tags and `workflow_dispatch`. It never touches a `v*` tag, so `release.yml` keeps shipping Electron. It installs bun canary, runs `bun install --frozen-lockfile` and the checks, and builds on `macos-latest` for arm64 and x64 and on `windows-latest` for x64.
- [ ] Write `tauri/scripts/package.ts`. On macOS it signs ad hoc with identity `-`, as Electron does, and writes `BetterMayhemTracker-mac-<arch>.zip` with `ditto -c -k --keepParent` and `BetterMayhemTracker-mac-<arch>.dmg`. On Windows it copies the release exe to `BetterMayhemTracker.exe`.
- [ ] Upload the assets to a GitHub prerelease named after the tag, which the 1.2.1 updater skips because it drops prereleases.
- [ ] Port the launch smoke tests and the mac bundle swap test from `ci.yml` and `.github/smoke/mac-update-swap.sh` into `tauri-release.yml`, against the Tauri artifacts.
- [ ] Handle a Windows machine without the WebView2 runtime per decision E8. The default shows a native message box with Microsoft's download link and exits.

**You see.**

- [ ] Pushing `tauri-v1.3.0-rc.1` produces a prerelease with the five assets under the names the 1.2.1 updater looks for, and `release.yml` does not run.

**Verify, unit.** @@RULE@@

- [ ] `tauri/scripts/package.test.ts` asserts the asset names for each platform and arch, and that each zip holds exactly one top-level `.app`.

**Verify, live.** @@LIVE@@

- [ ] Lane 1. Regression lane against trunk. Run `release.yml` and `tauri-release.yml` with `workflow_dispatch` on a fork or a dry-run flag. Save `release-assets.log`. Pass when both asset lists have the same names and only the Tauri sizes differ.
- [ ] Lane 2. Download the macOS arm64 zip and open the app from `/Applications` on a snapshot. Save `mac-release.png`. Pass when Match History renders and the cross-engine policy passes against the baseline.
- [ ] Lane 3. Download the Windows exe on `windows-latest` and run it from a temp folder. Save `win-release.png`. Pass when Match History renders and the Windows policy passes.
- [ ] Lane 4. Run the ported mac swap smoke test. Save `mac-swap.log`. Pass when it passes.
- [ ] Lane 5. Run the 1.2.1 updater against the prerelease. Save `prerelease-skipped.log`. Pass when 1.2.1 reports no update.
- [ ] Lane 6. Point the 1.2.1 updater at a published test release on a fork through the seam. Save `fork-handoff.png`. Pass when 1.2.1 installs the Tauri build, as in T24 lane 1.
- [ ] Lane 7. Run the Windows exe with WebView2 removed in a clean VM, if one is available. Save `no-webview2.png`. Pass when the message from decision E8 shows.
- [ ] Lane 8. Check the bundle id, binary name, and version in `Info.plist`. Save `info-plist.log`. Pass when they are `com.better-mayhem-tracker.app`, `Better Mayhem Tracker`, and the tag's version.
- [ ] Lane 9. Build twice from the same SHA. Save `reproducible.log`. Pass when the dependency trees are identical and `bun.lock` and `Cargo.lock` are unchanged.
- [ ] Lane 10. Search the release binaries for the parity driver and the fake CA. Save `release-clean.log`. Pass when neither is present.

**Verify, perf.** @@RULE@@

- [ ] Metric. Download size of each asset and installed size, against the 1.2.1 assets.
- [ ] Probe. `gh release view` on both releases, and `du -sk` on each installed app.
- [ ] Baseline. The T06 sizes for 1.2.1.
- [ ] Rule. Fail when any Tauri asset exceeds 15% of the matching Electron asset.

@@GATE T39 2,3,6,7@@

@@MERGE@@

## Prove parity end to end and publish the before and after numbers (T40)

**Depends on.** T01 to T39.

**Files.**

- [ ] Create `parity/report.ts`.
- [ ] Create `docs/tauri-port/parity-report.md` (generated).
- [ ] Edit `parity/README.md`.

**Build.**

- [ ] Write `parity/report.ts`. It runs every state in `parity/states.ts` in trunk Electron and in the head Tauri app on real commands, on macOS and on `windows-latest`, and writes one side-by-side image and one diff line per state.
- [ ] It runs `cargo test --test golden` and requires `61 pass, 0 fail, 0 not ported`.
- [ ] It runs `bun parity/perf.ts` for both apps on both platforms with 10 interleaved runs and writes the before and after table for download size, installed size, idle memory across all processes, and launch to first content.
- [ ] It runs `bun tauri/scripts/react-isms.ts` and the contract check, and lists any mask with its reason.

**You see.**

- [ ] `docs/tauri-port/parity-report.md` shows every state as `PASS` on both platforms, 61 of 61 goldens passing, and the perf table with spreads.

**Verify, unit.** @@RULE@@

- [ ] `parity/test/report.test.ts` feeds a recorded run with one failing state and asserts the report marks the run failed and names the state.

**Verify, live.** @@LIVE@@

- [ ] Lane 1. Regression lane against trunk. Run the full report. Save `report-mac.png`, a contact sheet of every side-by-side image. Pass when every macOS state is `PASS`.
- [ ] Lane 2. The full report on `windows-latest`. Save `report-win.png`. Pass when every Windows state is `PASS`.
- [ ] Lane 3. Golden replay. Save `golden-final.log`. Pass when it prints `61 pass, 0 fail, 0 not ported`.
- [ ] Lane 4. Update a packaged 1.2.1 to the Tauri build on a snapshot on macOS, then use every page for 5 minutes with the fake client running a full game. Save `soak-mac.png`. Pass when no error appears in `main.log` and the game is recorded.
- [ ] Lane 5. Lane 4 on `windows-latest`. Save `soak-win.png`. Pass when the same holds.
- [ ] Lane 6. Open the operator's real data folder read-only with the Tauri app, on a copy made by `snapshot.ts`. Save `real-data.png`. Pass when every page renders and `sqlite3` dumps before and after a clean quit match.
- [ ] Lane 7. Exercise the tray, single instance, close to tray, autostart, and quit on both platforms. Save `shell-final.log`. Pass when each matches the T04 baseline.
- [ ] Lane 8. Export a game card and a season card on both platforms. Save `export-final.png`. Pass when both pass their policies.
- [ ] Lane 9. Run the updater from Tauri to a newer Tauri test release on both platforms. Save `update-final.log`. Pass when both update in place.
- [ ] Lane 10. Search the report for masks. Save `masks.log`. Pass when each mask has a reason the operator accepted.

**Verify, perf.** @@RULE@@

- [ ] Metric. Download size, installed size, idle memory across all processes, and launch to first content, Electron 1.2.1 against the Tauri build, on macOS arm64 and Windows x64.
- [ ] Probe. `bun parity/perf.ts --app electron-1.2.1 --app tauri --runs 10`, interleaved with a cold start before each pair, per `skills/benchmark-checklist/SKILL.md`.
- [ ] Baseline. The T06 numbers, measured again in this run before the Tauri runs.
- [ ] Rule. Fail when Tauri is worse than Electron on any of the four metrics on either platform.

@@NOGATE T40@@

@@MERGE@@

## Cut over releases to Tauri and delete Electron (T41)

**Depends on.** T40, and the operator's go.

**Files.**

- [ ] Edit `.github/workflows/release.yml` to build with bun from `tauri/` under the same `v*` tags and asset names.
- [ ] Edit `.github/workflows/ci.yml` to run the Tauri checks and smoke tests.
- [ ] Delete `.github/workflows/tauri-release.yml` and `tauri-ci.yml`, now folded in.
- [ ] Delete `src/main/`, `src/preload/`, `src/renderer/`, `electron.vite.config.ts`, `tsconfig.node.json`, `tsconfig.web.json`, `package-lock.json`, and the Electron fields in `package.json`.
- [ ] Move `src/shared/` pure modules into `tauri/src/shared/` and delete `src/shared/api.ts` and `tauri/scripts/contract-check.ts`.
- [ ] Edit `README.md`, `.oxlintrc.json`, and `.gitignore`.

**Build.**

- [ ] Point `release.yml` at the T39 packaging, keeping the draft, upload, then publish order, so the updater never sees a half-built release.
- [ ] Make the root `package.json` a bun workspace over `tauri/` and `parity/`, with `bun.lock` at the root, and remove npm.
- [ ] Replace the `@shared` alias with the moved folder, and delete the React lint rules from the root `.oxlintrc.json`.
- [ ] Keep `parity/` with the Electron baseline images and goldens as the regression set for later work.

**You see.**

- [ ] Tagging `v1.3.0` publishes the Tauri build, a 1.2.1 install updates into it, and the tree has no Electron, React, or npm files.

**Verify, unit.** @@RULE@@

- [ ] `bun test` at the root runs the `tauri/` and `parity/` tests, and `cargo test` runs the Rust tests. Both pass.
- [ ] `rg -l "electron|react" --glob '!parity/**' --glob '!docs/**'` prints nothing.

**Verify, live.** @@LIVE@@

- [ ] Lane 1. Regression lane against trunk. Run `release.yml` by `workflow_dispatch` on a fork at trunk and at head. Save `release-diff.log`. Pass when the asset names match and head's assets are the Tauri build.
- [ ] Lane 2. Update a packaged 1.2.1 to the fork release on macOS with a snapshot. Save `cutover-mac.png`. Pass when it relaunches as Tauri on the same data.
- [ ] Lane 3. Lane 2 on `windows-latest`. Save `cutover-win.png`. Pass when the same holds.
- [ ] Lane 4. Run the T40 report at head against the stored Electron baseline. Save `post-cutover-report.png`. Pass when every state is `PASS`.
- [ ] Lane 5. Run `ci.yml` at head. Save `ci.log`. Pass when it is green on both runners.
- [ ] Lane 6. Clone head fresh and run `bun install --frozen-lockfile && bun run build` at the root. Save `fresh-clone.log`. Pass when it succeeds with no npm.
- [ ] Lane 7. Check the release notes flow. Save `release-notes.png`. Pass when What's New shows the `v1.3.0` notes after the update.
- [ ] Lane 8. Search the tree for Electron files. Save `no-electron.log`. Pass when the `rg` check prints nothing.
- [ ] Lane 9. Confirm the published release is not a prerelease and is marked latest on the fork. Save `latest.log`. Pass when it is.
- [ ] Lane 10. Run golden replay and the perf probe at head. Save `final-numbers.json`. Pass when they equal T40's within the spread.

**Verify, perf.** @@RULE@@

- [ ] Metric. The four T40 metrics on the release artifacts that `release.yml` builds.
- [ ] Probe. `bun parity/perf.ts --app electron-1.2.1 --app release-head --runs 10` on both platforms.
- [ ] Baseline. The T40 Tauri numbers.
- [ ] Rule. Fail when any metric is worse than T40's by more than its measured spread.

@@GATE T41 2,3,7@@

@@MERGE@@

## Close the program

- [ ] Every box above is checked with its evidence.
- [ ] `docs/tauri-port/parity-report.md` is on trunk with every state `PASS`, 61 of 61 goldens passing, and the before and after numbers.
- [ ] Reply to the operator with the report the execution playbook names, per the ketchup skill, with the root and tip branch names and SHAs and a one-line verdict per unit.
