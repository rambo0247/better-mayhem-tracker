# Tauri and Solid 2 port plan

This plan moves Better Mayhem Tracker from Electron 44 and React 19 to Tauri 3 and Solid 2 in 41 small units. Each unit is one local branch of commits, stacked on its parent's branch. Nothing opens a GitHub pull request.
Players see no change. Every page, dialog, toast, tray menu, IPC call, and background job behaves as Electron 1.2.1 does, bugs included, on macOS and Windows.
The Tauri app opens the current `better-mayhem-tracker` data folder as it is, and 1.2.1 installs update into it through their own updater.
The rule is that no unit lands until its golden diff or pixel diff against the Electron app passes. Electron keeps shipping until T41.
T01 to T07 set up the toolchain and the proof tools and capture the Electron baseline before any port work.
T08 to T26 port the main process to Rust. T27 to T38 port the UI to Solid 2.
T39 to T41 build the release artifacts, prove parity end to end with before and after numbers, and cut over.

## How to read this

One box is one unit of work. Every box names the evidence that checks it. A nested box is a sub-step of the box above it. Check a box only when its evidence exists, a file, a log line, a screenshot, a test run, or a SHA. The body is a how-to. The appendices explain and record.

The program runs `/Users/leinierperez/.claude/plugins/cache/cursor-plugins/pstack/0.15.25/skills/poteto-mode/playbooks/autopilot-stack.md`, because the operator reviews every unit before landing and the units form one dependency chain. This program opens no GitHub pull requests. Wherever that playbook or another pstack skill says PR, read the unit's branch. Wherever it names a `gh pr` or `origin pr` command, skip it. Owners report STACK-READY with the branch name and tip SHA. The root keeps the chain of branches. The operator lands the chain bottom-up into `main` with `git merge --ff-only`. T39 and T41 are the operator's items, because they change how releases reach players, and they stop at ready-to-land.

A unit's branch is `port/<id>-<slug>`, such as `port/T01-toolchain`, cut from its parent unit's branch. Its record lives in `docs/tauri-port/units/<id>.md` on the branch, in place of a pull request body. The record holds the evidence paths, the verdict, and the tip SHA it applies to. The verification rule below says PR because the plan checker requires that wording. There it means the unit's branch.

Trunk means `main` with Electron 1.2.1 in it. Electron stays in the tree and unchanged until T41, so every lane can run the trunk Electron app beside the head Tauri app on the same machine.

Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

Appendix E lists the decisions only the operator can make, each with the default this plan applies until told otherwise.

## Program checklist

### Arm the program

- [ ] State the protocol and this plan to the operator, then stop. Start execution only on the operator's explicit go.
- [ ] Confirm the Appendix E defaults with the operator, or record each change the operator makes.
- [ ] Read these from trunk at program start. Re-read them at every tick.
  - [ ] `git show origin/main:docs/tauri-port/plan.md`
  - [ ] `git show origin/main:.github/workflows/ci.yml`
  - [ ] `git show origin/main:.github/workflows/release.yml`
  - [ ] `git show origin/main:parity/README.md`, once T02 has landed.
  - [ ] The execution playbook, `playbooks/autopilot-stack.md` and `playbooks/autopilot-full.md` under the poteto-mode skill folder named above.
  - [ ] `skills/swarm/SKILL.md`, `skills/poteto-mode/playbooks/opening-a-pr.md`, `skills/poteto-mode/playbooks/visual-parity.md`, and `skills/benchmark-checklist/SKILL.md` in the same pstack folder.
  - [ ] `tauri/node_modules/solid-js/skills/solid-2.0`, `solid-2.0-cheatsheet`, and `reactivity-diagnostics`, plus https://docs.solidjs.com/migration/from-react/, before any Solid code.
- [ ] On the operator's go, arm the audit tick as `/loop 1h` with the tick prompt below. Never leave the cadence to memory.
- [ ] Use this tick prompt, verbatim. "Re-read the execution playbook from trunk. Audit the operation against it and fix drift in this tick. Probe every active lane and judge progress by side effects only. Stand down a stuck lane and dispatch its replacement now. Then post a short status message to the operator in chat only when the audit found a tracked change that no earlier status message reported, such as a unit branch cut, a code-ready head, a round launched or closed, a verdict, a merge, a stuck agent and the action taken, a blocker added or cleared, or a decision only the operator can make. Name every such change and nothing else. Do not repeat a table, the merged list, or an unchanged blocker. If the audit found none, end the turn with no reply text. Either way, log this tick's row in your decision trail. The row names the items reported, or none."
- [ ] On the operator's hold or stand-down, send every owner a zero-writes order at once.
- [ ] Ask the operator to grant Screen Recording and Accessibility to the terminal that runs macOS lanes, or record that lanes use the parity driver's in-process snapshots and frame-sequence videos instead.

### Spawn owners

- [ ] Spawn one owner per unit with the full lifecycle the execution playbook names, minus every pull request step. Owners are `pstack:poteto-agent` on the model each unit's playbook line names in the pstack model rule, with the hardest units (T07, T19, T20, T24, T25) on `opus` at `high`.
- [ ] Follow this dependency graph. Each owner branches from its parent's branch, because the program stacks.
  - [ ] T01 is first and branches from `main`.
  - [ ] T02 after T01. T03, T04, T05, and T06 after T02, independent of each other.
  - [ ] T07 after T02.
  - [ ] T08 after T05 and T07.
  - [ ] T09 after T08. T10, T11, T19, and T26 after T09.
  - [ ] T12 after T11. T13, T14, T15, and T16 after T12. T17 after T11.
  - [ ] T18 after T10, T12, and T17.
  - [ ] T20 after T12 and T19. T22 after T19. T21 after T20 and T22.
  - [ ] T23 after T10 and T11. T24 after T21 and T23.
  - [ ] T27 after T08. T28 to T38 after T27, independent of each other, because each page runs on replayed goldens until its commands land.
  - [ ] T25 after T22 and T29.
  - [ ] T39 after T24, T37, and T38, because its lanes run the finished app.
  - [ ] T40 after every unit from T01 to T39.
  - [ ] T41 after T40, and only on the operator's go.
- [ ] Hold the file boundaries.
  - [ ] T01 to T40 never edit `src/`, `package.json`, `package-lock.json`, `electron.vite.config.ts`, or `.github/workflows/release.yml`. Only T41 does.
  - [ ] Parity tooling lives only in `parity/`. Tauri code lives only in `tauri/`.
  - [ ] Each backend unit touches only the Rust modules and the `tauri/src-tauri/src/commands/` files its section names.
  - [ ] Each UI unit touches only `tauri/src/pages/<its pages>.tsx` and the components its section names. Shared components land in T27 only. A later unit changes one only where its section names the file, as T38 does for `Header.tsx` and `Layout.tsx`. Any other change stops and goes to the root.
- [ ] Hold the review gate. T10, T23, T24, T25, T27 to T38, T39, and T41 change an interaction. They wait for the operator's review in chat with screenshots and a video before merge.
- [ ] Hold the data rule. No lane, test, or script opens the real `better-mayhem-tracker` folder for writing. Lanes work on a snapshot from `parity/snapshot.ts` or on the anonymized fixture. The guard from T09 aborts any debug build that resolves to the real folder.

### PR mechanics, for every unit, with branches and commits only

- [ ] Open no GitHub pull request, draft or ready, for any unit. Run no `gh pr` or `origin pr` command.
- [ ] Create the unit's branch `port/<id>-<slug>` from its parent unit's branch, or from `main` for T01, in its own git worktree.
- [ ] Commit in small steps, each with a message that says what changed and why. Write the message per `skills/technical-writing/SKILL.md`. Messages carry no Claude attribution lines, per the operator's standing rule for this repo.
- [ ] Run the lint and typecheck once before each push. That is `bun run lint`, `bun run fmt:check`, `bun run typecheck`, `cargo fmt --check`, and `cargo clippy --all-targets -- -D warnings` in `tauri/`, plus `npm run lint` at the root. Commit and push with hooks on.
- [ ] Push the unit's branch to `origin` so `tauri-ci.yml` and the Windows lanes in `parity.yml` run on it. A push of a `port/*` branch is the only remote write a unit makes. Never push to `main`, never force-push a branch another unit is based on, and never create a tag, except as T39 and T41 say on the operator's go.
- [ ] Run `/deslop` before each commit and `/no-comments` before the verdict. Both come from plugins that are not installed in this Claude Code setup, so record that and apply their rules by hand from the poteto-mode Comments section.
- [ ] Write `docs/tauri-port/units/<id>.md` on the branch with the evidence paths, the lane results, the perf numbers, and the tip SHA they apply to.
- [ ] Apply the version rule at each unit that adds a dependency. Run `bun run deps:report` in `tauri/`, take the newest prerelease only when it is semver-newer than `latest`, and pin it exactly in `bun.lock` and `Cargo.lock`.
- [ ] Rebase onto the parent branch's current tip before the code-ready report. Keep that base in fix rounds. Rebase again only when the parent changes, on a `git merge-tree` conflict, or on a CI failure that comes from the parent.

### Verdict and merge, for every unit

- [ ] A full swarm runs once, at the code-ready head. Another full swarm runs only for new behavior, a redesign, or a large new diff. A rebase, a merge-conflict resolution, or a minor fix gets a single verifier at the new head. Run each full swarm per `skills/swarm/SKILL.md`. One gates lane. The ten live lanes from the unit's **Verify, live** block. The perf lane from its **Verify, perf** block. Two or more audit lanes, each with its own focus, that read the diff and the receipts and distrust the unit record. The root audits the receipts in the merge-ready report before the verdict.
- [ ] Clean only when every lane is `PASS`. Findings go back to the owner, including a defect that a lane filed as a note. A new head gets a fresh verdict, except for results that stay valid under the patch-id rule in `playbooks/shipping.md`.
- [ ] Mark each clean unit STACK-READY in its record, in dependency order, with its branch based on its parent's tip. Results stay valid across a rebase only when `git patch-id --stable` of the unit's own commits is unchanged, per `playbooks/shipping.md`. The operator lands the chain bottom-up with `git merge --ff-only` into `main`, and pushes `main` when the operator chooses.

### Boot recipe, for every live lane

Each live lane runs in its own git worktree on the operator's Mac, or on a GitHub Actions `windows-latest` runner for Windows lanes. Claude Code has no `control-ui` skill, so lanes drive Electron through Playwright's `_electron.launch` and Tauri through the parity driver from T07, both wrapped by `parity/` scripts.

- [ ] `git fetch origin <unit-branch> && git worktree add <lane-dir> <tip SHA>`.
- [ ] Install. Run `npm ci` at the root for trunk Electron. Run `bun install --frozen-lockfile` in `parity/` and in `tauri/`.
- [ ] Build trunk Electron with `npm run build`. Build the head Tauri app with `bun run tauri build --debug --features parity-driver` in `tauri/`.
- [ ] Prepare data. Run `bun parity/snapshot.ts --out <run>/data` for a private snapshot, or `bun parity/fixture.ts --out <run>/data` for the anonymized fixture. Never point either app at the real folder.
- [ ] Start the surface. Run `bun parity/run-electron.ts --data <run>/data --state <state-id>` for trunk and `bun parity/run-tauri.ts --data <run>/data --state <state-id>` for head. Start `bun parity/fake-lcu.ts --scenario <name>` first for any client-dependent state. Wait for the script's `ready` line.
- [ ] For a Windows lane, run `gh workflow run parity.yml --ref <unit-branch> -f lanes=<lane-ids>` and download the run's artifacts with `gh run download`.
- [ ] Deliver input only through `parity/` commands (`click`, `hover`, `type`, `key`, `scroll`, `resize`, `navigate`). Read-only diagnostics are `<run>/data/../logs/main.log`, `<run>/seam.log`, the parity driver's `dom` and `geometry` dumps, and `sqlite3 -readonly <run>/data/matches.db`.
- [ ] Compare with `bun parity/diff.ts <trunk.png> <head.png> --geometry <trunk.json> <head.json>`. It prints `PASS` or `FAIL` per the policy in Appendix A and writes the side-by-side image.
- [ ] Save every screenshot to `/tmp/swarm-<pr-id>/worker-<n>/<slug>.png` and return the paths with the report.

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

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `tauri/lint/solid-input-events.test.ts` asserts the rule fails `<input onChange={f} />` and passes `<input onInput={f} />` and `<select onChange={f}>`. Run `bun test` in `tauri/`.
- [ ] A fixture file with a destructured prop fails `bun run lint` with `solid(no-destructure)`, and a fixture that reads a signal outside a tracked scope fails it with `solid(reactivity)`.
- [ ] Run `cargo clippy --all-targets -- -D warnings` and `cargo fmt --check` in `tauri/src-tauri`. Both exit 0.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `opus` at the PR head, per the boot recipe.

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

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Trunk has no Tauri app, so this unit measures absolute numbers for the empty shell. They are the size of the release `.app` and `.dmg`, idle memory across all processes 60 s after launch, and time from process start to the window's first paint.
- [ ] Probe. Run `bun parity/perf.ts --app tauri --runs 10` once T06 lands. Until then, `du -sk` on the bundle, the T06 memory method by hand, and the first-paint log line.
- [ ] Baseline. Record the Electron 1.2.1 numbers from the spike README first. They are 110 MB `.dmg`, 245 MB `.app`, and about 328 MB memory.
- [ ] Rule. Fail when the empty shell's `.dmg` exceeds 8 MB or its idle memory exceeds 120 MB.

**Review gate.** None. T01 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact tip SHA, recorded in `docs/tauri-port/units/<id>.md`.
- [ ] The branch sits on its parent's tip with the patch-id unchanged since the verdict.
- [ ] No GitHub pull request exists for the branch.
- [ ] The operator lands the chain bottom-up with `git merge --ff-only` into `main`.

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

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `parity/test/diff.test.ts` feeds two identical PNGs, a PNG with 11 pixels off by one level, a 2 px layout shift, and a missing icon crop, and asserts `PASS`, `PASS`, `FAIL` on the layout gate, and `FAIL` on the tile rule. Run `bun test` in `parity/`.
- [ ] `parity/test/anonymize.test.ts` builds a three-game database with known names, anonymizes it, and asserts no original name or PUUID remains in any table or decoded payload, and that the same input name maps to the same fake name in both places.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `opus` at the PR head, per the boot recipe.

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

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Trunk has no capture tool, so this unit sets absolute budgets for the work it adds. That is wall time for one full baseline run and wall time per state.
- [ ] Probe. Run `time bun parity/capture.ts --app electron --all` three times on the operator's Mac and once on `windows-latest`.
- [ ] Baseline. Record the first macOS run's wall time and state count first.
- [ ] Rule. Fail when one state takes more than 15 s on macOS or a full run takes more than 20 minutes.

**Review gate.** None. T02 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact tip SHA, recorded in `docs/tauri-port/units/<id>.md`.
- [ ] The branch sits on its parent's tip with the patch-id unchanged since the verdict.
- [ ] No GitHub pull request exists for the branch.
- [ ] The operator lands the chain bottom-up with `git merge --ff-only` into `main`.

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

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `parity/test/fake-lcu.test.ts` connects with Node's `https` using only the fake CA, subscribes over WebSocket, and asserts each scenario's frames arrive in order with the recorded delays.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `opus` at the PR head, per the boot recipe.

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

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Trunk has no fake client, so this unit sets an absolute budget for the work it adds, the time from fake-client start to the app's `connected` status.
- [ ] Probe. Run `bun parity/capture.ts --states status-connected --timing` 10 times.
- [ ] Baseline. Record the first run's connect time first.
- [ ] Rule. Fail when the median exceeds 7 s, since the app's connect loop runs every 5 s.

**Review gate.** None. T03 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact tip SHA, recorded in `docs/tauri-port/units/<id>.md`.
- [ ] The branch sits on its parent's tip with the patch-id unchanged since the verdict.
- [ ] No GitHub pull request exists for the branch.
- [ ] The operator lands the chain bottom-up with `git merge --ff-only` into `main`.

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

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `parity/test/menus.test.ts` asserts the tray dump lists `Show Window`, a separator, and `Quit`, in that order.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `opus` at the PR head, per the boot recipe.

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

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Trunk has no overlay states, so this unit sets an absolute budget for its added work, wall time per overlay state.
- [ ] Probe. Run `time bun parity/capture.ts --states overlays` three times.
- [ ] Baseline. Record the first run's per-state time first.
- [ ] Rule. Fail when any overlay state takes more than 20 s.

**Review gate.** None. T04 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact tip SHA, recorded in `docs/tauri-port/units/<id>.md`.
- [ ] The branch sits on its parent's tip with the patch-id unchanged since the verdict.
- [ ] No GitHub pull request exists for the branch.
- [ ] The operator lands the chain bottom-up with `git merge --ff-only` into `main`.

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

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `parity/test/canon.test.ts` asserts that key order does not matter, that `0.1 + 0.2` keeps its JavaScript digits, and that a listed clock field is masked while an unlisted one is not.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `opus` at the PR head, per the boot recipe.

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

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Electron invoke round-trip time per channel, recorded with the goldens as the trunk numbers the Rust units compare against.
- [ ] Probe. Run `bun parity/record-ipc.ts --timing --repeat 50`, which calls each read-only case 50 times interleaved across channels.
- [ ] Baseline. This unit is the baseline. Record the median and p95 per channel into `parity/out/golden/timing.json`.
- [ ] Rule. Fail when two consecutive timing runs disagree on any channel's median by more than 20%, since a noisy baseline cannot gate later units.

**Review gate.** None. T05 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact tip SHA, recorded in `docs/tauri-port/units/<id>.md`.
- [ ] The branch sits on its parent's tip with the patch-id unchanged since the verdict.
- [ ] No GitHub pull request exists for the branch.
- [ ] The operator lands the chain bottom-up with `git merge --ff-only` into `main`.

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

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `parity/test/perf.test.ts` feeds a recorded `footprint` and `ps` sample and asserts the helper attribution and the median.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `opus` at the PR head, per the boot recipe.

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

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Electron 1.2.1 download size, installed size, idle memory across all processes, and launch to first content, on macOS arm64 and Windows x64.
- [ ] Probe. `bun parity/perf.ts --app electron-1.2.1 --runs 10`, with cold starts interleaved, on the operator's Mac and on `windows-latest`.
- [ ] Baseline. This unit is the baseline. Commit the medians into `parity/out/perf/electron-1.2.1.json` and copy them into Appendix A.
- [ ] Rule. Fail when the spread of any metric exceeds 15% of its median, since T40 compares against these numbers.

**Review gate.** None. T06 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact tip SHA, recorded in `docs/tauri-port/units/<id>.md`.
- [ ] The branch sits on its parent's tip with the patch-id unchanged since the verdict.
- [ ] No GitHub pull request exists for the branch.
- [ ] The operator lands the chain bottom-up with `git merge --ff-only` into `main`.

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

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `cargo test -p better-mayhem-tracker --features parity-driver driver` asserts the driver refuses a request without the token and refuses a non-loopback peer.
- [ ] `parity/test/replay.test.ts` asserts the replay API returns the golden for a known call and throws a named error for an unknown one.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `opus` at the PR head, per the boot recipe.

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

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Time to capture one state, Electron through Playwright against Tauri through the driver.
- [ ] Probe. Capture the same 10 states alternately in each app, three rounds.
- [ ] Baseline. Record the Electron per-state median first.
- [ ] Rule. Fail when the Tauri per-state median exceeds twice the Electron median.

**Review gate.** None. T07 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact tip SHA, recorded in `docs/tauri-port/units/<id>.md`.
- [ ] The branch sits on its parent's tip with the patch-id unchanged since the verdict.
- [ ] No GitHub pull request exists for the branch.
- [ ] The operator lands the chain bottom-up with `git merge --ff-only` into `main`.

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

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `tauri/scripts/contract-check.test.ts` renames one field in a copy of the bindings and asserts the check fails and names the field.
- [ ] `cargo test --test golden` asserts a hand-made wrong answer for one stub reports `fail`, not `not ported`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `opus` at the PR head, per the boot recipe.

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

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Invoke round-trip for a stub command against Electron's round-trip for its cheapest channel, `getVersion`.
- [ ] Probe. Call each 1,000 times from its renderer, alternating apps every 100 calls.
- [ ] Baseline. Record Electron's `getVersion` median from the T05 timing file first.
- [ ] Rule. Fail when the Tauri stub's median exceeds Electron's by more than 0.5 ms.

**Review gate.** None. T08 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact tip SHA, recorded in `docs/tauri-port/units/<id>.md`.
- [ ] The branch sits on its parent's tip with the patch-id unchanged since the verdict.
- [ ] No GitHub pull request exists for the branch.
- [ ] The operator lands the chain bottom-up with `git merge --ff-only` into `main`.

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

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `tauri/src-tauri/src/log.rs` tests assert the line format against a line copied from a real Electron log, and the rollover at 2 MiB.
- [ ] `paths.rs` tests assert both platform roots and the override.
- [ ] `data_guard.rs` tests assert the guard fires on the real path in debug.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `opus` at the PR head, per the boot recipe.

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

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Time from process start to the first log line, in both apps.
- [ ] Probe. Launch each app 10 times alternately on the same snapshot.
- [ ] Baseline. Record Electron's median first.
- [ ] Rule. Fail when Tauri's median is slower than Electron's.

**Review gate.** None. T09 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact tip SHA, recorded in `docs/tauri-port/units/<id>.md`.
- [ ] The branch sits on its parent's tip with the patch-id unchanged since the verdict.
- [ ] No GitHub pull request exists for the branch.
- [ ] The operator lands the chain bottom-up with `git merge --ff-only` into `main`.

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

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `shell.rs` tests assert the close decision for each `minimize_to_tray` value and for quitting.
- [ ] `tray.rs` tests assert the menu items match `parity/out/baseline/tray-menu.json`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `opus` at the PR head, per the boot recipe.

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

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Idle memory across all processes with the window hidden to the tray, in both apps.
- [ ] Probe. `bun parity/perf.ts --scenario hidden-idle --runs 10`, alternating apps.
- [ ] Baseline. Record Electron's median first.
- [ ] Rule. Fail when Tauri's median exceeds 60% of Electron's.

**Review gate.** The operator reviews before merge.

- [ ] Copy the lane 1,2,4,8 screenshots into `parity/out/review/T10-review-<slug>.png`, with the side-by-side image for each.
- [ ] Record a 30 to 60 second video of the change on a lane machine. Save it as `parity/out/review/T10-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at STACK-READY. Wait for the operator's go before the unit lands.

**Merge.**

- [ ] Root's clean verdict at the exact tip SHA, recorded in `docs/tauri-port/units/<id>.md`.
- [ ] The branch sits on its parent's tip with the patch-id unchanged since the verdict.
- [ ] No GitHub pull request exists for the branch.
- [ ] The operator lands the chain bottom-up with `git merge --ff-only` into `main`.

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

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `tests/db_compat.rs` creates a fresh database in Rust and asserts `sqlite_master` text equals the one Electron creates, read from a T05 golden.
- [ ] It upgrades a V1 database from a fixture and asserts the result equals a fresh V4 database.
- [ ] It packs a payload and asserts the bytes equal Node's `zlib.gzipSync` output stored in the golden.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `opus` at the PR head, per the boot recipe.

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

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Time to open the database and run migrations on the 669-game snapshot, in both apps.
- [ ] Probe. Open and close 20 times alternately with a cold page cache before each pair.
- [ ] Baseline. Record Electron's median first.
- [ ] Rule. Fail when Tauri's median exceeds Electron's by more than 20%.

**Review gate.** None. T11 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact tip SHA, recorded in `docs/tauri-port/units/<id>.md`.
- [ ] The branch sits on its parent's tip with the patch-id unchanged since the verdict.
- [ ] No GitHub pull request exists for the branch.
- [ ] The operator lands the chain bottom-up with `git merge --ff-only` into `main`.

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

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `tests/score_golden.rs` asserts every fixture game's score equals the TypeScript score exactly.
- [ ] `db/ingest.rs` tests insert one recorded game payload and assert every row equals the row Electron wrote, read from a golden.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `opus` at the PR head, per the boot recipe.

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

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Time to score all 669 fixture games, TypeScript in Node against Rust.
- [ ] Probe. Run each 10 times alternately.
- [ ] Baseline. Record the TypeScript median first.
- [ ] Rule. Fail when Rust's median is slower than TypeScript's.

**Review gate.** None. T12 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact tip SHA, recorded in `docs/tauri-port/units/<id>.md`.
- [ ] The branch sits on its parent's tip with the patch-id unchanged since the verdict.
- [ ] No GitHub pull request exists for the branch.
- [ ] The operator lands the chain bottom-up with `git merge --ff-only` into `main`.

## Port the match queries (T13)

**Depends on.** T12.

**Files.**

- [ ] Create `tauri/src-tauri/src/db/matches.rs`. Move the spike's `db.rs` query from `d3f2ed0` into it.
- [ ] Edit `tauri/src-tauri/src/commands/matches.rs`.

**Build.**

- [ ] Port `src/main/db/matches.ts` for `db:match-history`, `db:match-sessions`, `db:match-filters`, `db:stored-queues`, `db:match-detail`, `db:toggle-favorite`, `db:champion-match-history`, `db:all-summoner-puuids`, and `db:profile`, with the same SQL text, the hidden-queue and remake settings, and paging.
- [ ] Read rows through `stmt.rs`, never by column name per row.

**You see.**

- [ ] Golden replay moves those 9 channels to `pass`, and the Electron renderer in the Tauri webview on the real Rust commands shows Match History identical to the T07 run on replayed goldens.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `db/matches.rs` tests run each query on the fixture with each filter and sort and assert row counts and the first and last row against the goldens.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `opus` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run the Electron renderer on trunk Electron and on head Tauri's real commands for Match History loaded. Save `mh-real.png`. Pass when the cross-engine policy passes with the `object-view-box` portraits as the only tile failures.
- [ ] Lane 2. Scroll Match History to the end through infinite scroll. Save `mh-end.png`. Pass when the last row equals Electron's last row.
- [ ] Lane 3. Apply each filter in turn. Save `mh-filtered.png`. Pass when each row count matches Electron's.
- [ ] Lane 4. Group sessions by week. Save `mh-week.png`. Pass when the session headers and totals match Electron's.
- [ ] Lane 5. Expand a match. Save `mh-expanded.png`. Pass when the scoreboard matches Electron's.
- [ ] Lane 6. Toggle a favorite and turn on favorites only. Save `mh-favorites.png`. Pass when the list matches Electron's after the same steps.
- [ ] Lane 7. Turn on `hide_remakes`. Save `mh-no-remakes.png`. Pass when remakes disappear as in Electron.
- [ ] Lane 8. Open a champion's match history from Champions. Save `champion-history.png`. Pass when it matches Electron's.
- [ ] Lane 9. Run golden replay on `windows-latest`. Save `win-golden.log`. Pass when the 9 channels pass.
- [ ] Lane 10. Run golden replay. Save `golden-table.log`. Pass when no row fails.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Round-trip time for `db:match-history` with a 50-game page and with all games, against the T05 Electron timings.
- [ ] Probe. Call each 50 times from the renderer, alternating apps every 10 calls.
- [ ] Baseline. Electron's medians from `parity/out/golden/timing.json`. The spike measured 0.44 ms and 3.7 ms in Node.
- [ ] Rule. Fail when Tauri's median exceeds Electron's by more than 25% or by more than 2 ms, whichever is larger.

**Review gate.** None. T13 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact tip SHA, recorded in `docs/tauri-port/units/<id>.md`.
- [ ] The branch sits on its parent's tip with the patch-id unchanged since the verdict.
- [ ] No GitHub pull request exists for the branch.
- [ ] The operator lands the chain bottom-up with `git merge --ff-only` into `main`.

## Port the stats, trends, and records queries (T14)

**Depends on.** T12.

**Files.**

- [ ] Create `tauri/src-tauri/src/db/stats.rs` and `db/records.rs`.
- [ ] Edit `tauri/src-tauri/src/commands/stats.rs`.

**Build.**

- [ ] Port `db/stats.ts` and `db/records.ts` for `db:dashboard`, `db:champion-stats`, `db:augment-stats`, `db:augment-stats-detailed`, `db:champion-item-stats`, `db:global-stats`, `db:global-champion-detail`, `db:trends`, and `db:records`.
- [ ] Keep every aggregate in SQL where Electron computes it in SQL, and in Rust with the same float order where Electron computes it in JavaScript.

**You see.**

- [ ] Golden replay moves those 9 channels to `pass`, and Champions, Augments, Trends, Records, and Global Stats render on the real commands.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `db/stats.rs` and `db/records.rs` tests assert each channel's goldens for every argument variant in `parity/ipc-cases.ts`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `opus` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run the Electron renderer on both apps' real commands for Champions. Save `champions-real.png`. Pass when the cross-engine policy passes.
- [ ] Lane 2. Trends by month and by week. Save `trends-week.png`. Pass when the chart points match Electron's.
- [ ] Lane 3. Records with each queue. Save `records.png`. Pass when every record card matches.
- [ ] Lane 4. Augments with each rarity. Save `augments-prismatic.png`. Pass when the table matches.
- [ ] Lane 5. Global Stats on each tab. Save `global-tabs.png`. Pass when each table matches.
- [ ] Lane 6. Global champion detail for the most played champion. Save `champion-detail.png`. Pass when the stat cards match.
- [ ] Lane 7. The dashboard header on Match History. Save `dashboard.png`. Pass when Avg Score, Avg KDA, and the badge counts match.
- [ ] Lane 8. Champions with a minimum games filter of 10. Save `champions-min10.png`. Pass when the row set matches.
- [ ] Lane 9. Golden replay on `windows-latest`. Save `win-golden.log`. Pass when the 9 channels pass.
- [ ] Lane 10. Golden replay. Save `golden-table.log`. Pass when no row fails.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Round-trip time for `db:global-stats` and `db:trends`, the two heaviest stats channels.
- [ ] Probe. Call each 50 times, alternating apps every 10 calls.
- [ ] Baseline. Electron's medians from the T05 timing file.
- [ ] Rule. Fail when Tauri's median exceeds Electron's by more than 25% or 2 ms, whichever is larger.

**Review gate.** None. T14 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact tip SHA, recorded in `docs/tauri-port/units/<id>.md`.
- [ ] The branch sits on its parent's tip with the patch-id unchanged since the verdict.
- [ ] No GitHub pull request exists for the branch.
- [ ] The operator lands the chain bottom-up with `git merge --ff-only` into `main`.

## Port the teammate and group queries (T15)

**Depends on.** T12.

**Files.**

- [ ] Create `tauri/src-tauri/src/db/teammates.rs`.
- [ ] Edit `tauri/src-tauri/src/commands/teammates.rs`.

**Build.**

- [ ] Port `db/teammates.ts` for `db:teammate-stats`, `db:teammate-groups`, `db:teammate-detail`, and `db:teammate-group-detail`, including group keys and the encoding of teammate keys in URLs.

**You see.**

- [ ] Golden replay moves those 4 channels to `pass`, and Friends, friend detail, and group detail render on the real commands.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `db/teammates.rs` tests assert the goldens for each season and group size, and that a key with a `#` in the tag line round-trips.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `opus` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run the Electron renderer on both apps' real commands for Friends. Save `friends-real.png`. Pass when the cross-engine policy passes.
- [ ] Lane 2. Switch to the Groups view. Save `groups.png`. Pass when the table matches.
- [ ] Lane 3. Open the top friend. Save `friend-detail.png`. Pass when shared stats and the champion grid match.
- [ ] Lane 4. Open a group of 5. Save `group-5.png`. Pass when the five-column layout matches.
- [ ] Lane 5. Open a friend key that no longer exists. Save `friend-missing.png`. Pass when "No games found with this player." shows.
- [ ] Lane 6. Filter Friends by group size 3. Save `friends-size3.png`. Pass when the row set matches.
- [ ] Lane 7. Expand a shared game. Save `shared-game.png`. Pass when the scoreboard matches.
- [ ] Lane 8. Click "Show all" on the champion grid. Save `champions-all.png`. Pass when the grid matches.
- [ ] Lane 9. Golden replay on `windows-latest`. Save `win-golden.log`. Pass when the 4 channels pass.
- [ ] Lane 10. Golden replay. Save `golden-table.log`. Pass when no row fails.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Round-trip time for `db:teammate-stats` and `db:teammate-groups`.
- [ ] Probe. Call each 50 times, alternating apps every 10 calls.
- [ ] Baseline. Electron's medians from the T05 timing file.
- [ ] Rule. Fail when Tauri's median exceeds Electron's by more than 25% or 2 ms, whichever is larger.

**Review gate.** None. T15 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact tip SHA, recorded in `docs/tauri-port/units/<id>.md`.
- [ ] The branch sits on its parent's tip with the patch-id unchanged since the verdict.
- [ ] No GitHub pull request exists for the branch.
- [ ] The operator lands the chain bottom-up with `git merge --ff-only` into `main`.

## Port the recap, card, and season queries (T16)

**Depends on.** T12.

**Files.**

- [ ] Create `tauri/src-tauri/src/db/recap.rs`, `db/season.rs`, `seasons.rs`, `session.rs`, and `text.rs`.
- [ ] Edit `tauri/src-tauri/src/commands/recap.rs`.

**Build.**

- [ ] Port `db/recap.ts`, `db/season.ts`, `shared/seasons.ts`, `shared/session.ts`, and `shared/text.ts` for `db:game-recap`, `db:game-card`, `db:season-recap`, and `db:seasons`, including the locale-dependent text.
- [ ] Take the challenge pieces `db:season-recap` needs from `db/challenges.ts` here, and leave the tracker to T21.

**You see.**

- [ ] Golden replay moves those 4 channels to `pass`, and Season Recap and both card routes render on the real commands.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `db/recap.rs` and `db/season.rs` tests assert the goldens for every season and queue, and the recap of the first and the newest game.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `opus` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run the Electron renderer on both apps' real commands for Season Recap. Save `season-real.png`. Pass when the cross-engine policy passes.
- [ ] Lane 2. Season Recap with friends hidden. Save `season-hide-friends.png`. Pass when it matches.
- [ ] Lane 3. A season with no games. Save `season-empty.png`. Pass when "No games in this season." shows.
- [ ] Lane 4. `/card/<id>` for the newest game. Save `game-card.png`. Pass when the card reaches `ready` and matches.
- [ ] Lane 5. `/card/<id>` for an id not in the database. Save `card-missing.png`. Pass when "That game isn't in the database" shows.
- [ ] Lane 6. The Live Game standby recap of the last game. Save `last-recap.png`. Pass when placements and streaks match.
- [ ] Lane 7. A recap with three or more games in the session. Save `session-strip.png`. Pass when the session strip shows.
- [ ] Lane 8. The recap badge on the nav for an unseen season. Save `recap-badge.png`. Pass when the badge shows.
- [ ] Lane 9. Golden replay on `windows-latest`. Save `win-golden.log`. Pass when the 4 channels pass.
- [ ] Lane 10. Golden replay. Save `golden-table.log`. Pass when no row fails.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Round-trip time for `db:season-recap` on the largest season.
- [ ] Probe. Call it 50 times, alternating apps every 10 calls.
- [ ] Baseline. Electron's median from the T05 timing file.
- [ ] Rule. Fail when Tauri's median exceeds Electron's by more than 25% or 2 ms, whichever is larger.

**Review gate.** None. T16 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact tip SHA, recorded in `docs/tauri-port/units/<id>.md`.
- [ ] The branch sits on its parent's tip with the patch-id unchanged since the verdict.
- [ ] No GitHub pull request exists for the branch.
- [ ] The operator lands the chain bottom-up with `git merge --ff-only` into `main`.

## Port backup, recovery, and the backup schedule (T17)

**Depends on.** T11.

**Files.**

- [ ] Create `tauri/src-tauri/src/backup.rs`.
- [ ] Edit `tauri/src-tauri/src/commands/backup.rs` and `lib.rs`.

**Build.**

- [ ] Port `src/main/backup.ts`. That covers `initDatabaseWithRecovery` before anything reads the database, the hourly check with the 24 h age threshold, pruning, quarantine of a corrupt file, and the recovery report.
- [ ] Port `backup:list`, `backup:create`, `backup:restore`, `backup:recovery-report`, and `backup:open-folder`, with rusqlite's online backup API and the `matches-<ISO>-auto.db` names.

**You see.**

- [ ] A Tauri backup opens in Electron, an Electron backup restores in Tauri, and the recovery banner states match the T04 baseline.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `backup.rs` tests assert the prune keeps the same set Electron keeps for a fixed list of names and dates, and that a corrupt database is quarantined with Electron's file name.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `opus` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Delete `matches.db` in a snapshot and launch each app. Save `recovered-missing.png`. Pass when both restore the newest backup and show the same banner.
- [ ] Lane 2. Corrupt `matches.db` in a snapshot and launch each app. Save `recovered-corrupt.png`. Pass when both quarantine it and show the same banner.
- [ ] Lane 3. Create a backup in Tauri and open it in Electron. Save `cross-backup.log`. Pass when Electron opens it unchanged.
- [ ] Lane 4. Restore an Electron backup in Tauri. Save `restore.log`. Pass when the Match History screenshot matches the source.
- [ ] Lane 5. Advance the frozen clock 25 h. Save `scheduled-backup.log`. Pass when one scheduled backup appears, as in Electron.
- [ ] Lane 6. Fill the folder past the keep count. Save `prune.log`. Pass when the same files remain as in Electron.
- [ ] Lane 7. Click Open backup folder. Save `open-folder.log`. Pass when Finder or Explorer opens the snapshot's backup folder.
- [ ] Lane 8. Run lanes 1 and 2 on `windows-latest`. Save `win-recovery.png`. Pass when both match.
- [ ] Lane 9. Back up during a write. Save `backup-during-write.log`. Pass when the backup passes `integrity_check`.
- [ ] Lane 10. Golden replay. Save `golden-table.log`. Pass when the `backup:*` rows pass and no row fails.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Time for `backup:create` on the 669-game snapshot.
- [ ] Probe. Create 10 backups in each app alternately.
- [ ] Baseline. Record Electron's median first.
- [ ] Rule. Fail when Tauri's median exceeds Electron's by more than 25%.

**Review gate.** None. T17 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact tip SHA, recorded in `docs/tauri-port/units/<id>.md`.
- [ ] The branch sits on its parent's tip with the patch-id unchanged since the verdict.
- [ ] No GitHub pull request exists for the branch.
- [ ] The operator lands the chain bottom-up with `git merge --ff-only` into `main`.

## Port export, import, and repair (T18)

**Depends on.** T10, T12, and T17.

**Files.**

- [ ] Create `tauri/src-tauri/src/transfer.rs`, `import.rs`, and `db/repair.rs`.
- [ ] Edit `tauri/src-tauri/src/commands/data.rs` and `capabilities/default.json` for `tauri-plugin-dialog`.

**Build.**

- [ ] Port the streaming JSON export at format version 3, the streaming import scanner, and `data:repair-puuids`, for `data:export`, `data:import`, and `data:repair-puuids`, with the `data:import-progress` event.
- [ ] Use `tauri-plugin-dialog` for the save and open dialogs with Electron's titles, default file names, and filters.

**You see.**

- [ ] A Tauri export imports into Electron and an Electron export imports into Tauri, with the same progress toasts.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `transfer.rs` tests export the fixture and assert the bytes equal the T05 export golden.
- [ ] `import.rs` tests import the golden export into an empty database and assert a dump equal to the fixture's.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `opus` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Export from both apps on the same snapshot. Save `export-diff.log`. Pass when the two files are byte-identical.
- [ ] Lane 2. Import an Electron export into an empty Tauri data folder. Save `import-progress.png`. Pass when the progress toast matches Electron's and the counts match.
- [ ] Lane 3. Import a file that is not an export. Save `import-bad.png`. Pass when the error matches Electron's.
- [ ] Lane 4. Cancel the save dialog. Save `export-cancel.log`. Pass when nothing is written and no error shows, as in Electron.
- [ ] Lane 5. Run repair on a copy with broken PUUIDs. Save `repair.log`. Pass when the result equals Electron's repair of the same copy.
- [ ] Lane 6. Import a format version 2 file, if Electron accepts one. Save `import-v2.log`. Pass when the result matches Electron's.
- [ ] Lane 7. Show the save dialog on macOS. Save `save-dialog.png`. Pass when the default file name matches Electron's.
- [ ] Lane 8. Run lanes 1 and 2 on `windows-latest`. Save `win-transfer.log`. Pass when both match.
- [ ] Lane 9. Import a 50 MB export. Save `import-large.log`. Pass when memory stays under 200 MB during the import.
- [ ] Lane 10. Golden replay. Save `golden-table.log`. Pass when the `data:*` rows pass and no row fails.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Time to export and to import the 669-game snapshot.
- [ ] Probe. Run each 5 times in each app alternately.
- [ ] Baseline. Record Electron's medians first.
- [ ] Rule. Fail when either Tauri median exceeds Electron's by more than 25%.

**Review gate.** None. T18 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact tip SHA, recorded in `docs/tauri-port/units/<id>.md`.
- [ ] The branch sits on its parent's tip with the patch-id unchanged since the verdict.
- [ ] No GitHub pull request exists for the branch.
- [ ] The operator lands the chain bottom-up with `git merge --ff-only` into `main`.

## Port the League client transport with the pinned Riot root (T19)

**Depends on.** T09.

**Files.**

- [ ] Create `tauri/src-tauri/src/lcu/mod.rs`, `lockfile.rs`, `tls.rs`, `http.rs`, `socket.rs`, `status.rs`, and `process_lookup.rs`.
- [ ] Move the spike's `lcu.rs` from `d3f2ed0` into `lockfile.rs` and `status.rs` as a start.
- [ ] Edit `tauri/src-tauri/src/commands/lcu.rs` and `Cargo.toml`.

**Build.**

- [ ] Write `tls.rs` with rustls 0.23.46, the `ring` provider, and the stock webpki verifier over a root store that holds only `RIOT_ROOT_CA`, as the T19 prototype proved. Hostname checks stay on. No custom verifier and no `danger` option.
- [ ] Use `reqwest` with `rustls-no-provider` and `use_preconfigured_tls`, and `tokio-tungstenite` with `Connector::Rustls` over the same config. Drop `native-tls`.
- [ ] Port `lockfile.ts` with the same candidate folders, the stale-lockfile port probe, and the `league_install_dir` setting.
- [ ] Port the process lookup fallback, PowerShell `Get-CimInstance` on Windows with `CREATE_NO_WINDOW` and `ps` on macOS, rate-limited to once per 30 s.
- [ ] Port the status machine. `lcu:status-changed` is sent on every `setStatus` call even when the value is unchanged, because Electron does that, while internal listeners fire only on change.
- [ ] Send `[5,"OnJsonApiEvent"]` on socket open, as `league-connect` does.
- [ ] Add a `parity-ca` feature, test builds only, that adds the T03 fake CA as a second anchor. `tauri-ci.yml` fails a release build that has it.

**You see.**

- [ ] The Tauri app shows connected against the real League client with certificate checks on, and against the fake client in lanes.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `tls.rs` tests assert the verifier rejects a self-signed localhost certificate, a leaf from an impostor CA with Riot's subject name, and a certificate for the wrong host, using the prototype's test certificates.
- [ ] `lockfile.rs` tests parse the lockfile format and the stale case.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `opus` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run both apps against the fake client in `connected-idle`. Save `status-connected.png`. Pass when the sidebar matches the T03 baseline.
- [ ] Lane 2. Run the head app against the real League client on the operator's Mac, GET requests only. Save `real-client.log`. Pass when it connects with checks on and the log shows the summoner request returned 200.
- [ ] Lane 3. Run against a fake server with a self-signed certificate. Save `tls-reject.log`. Pass when the connection fails and the status stays disconnected.
- [ ] Lane 4. Leave a stale lockfile with a dead port. Save `stale-lockfile.log`. Pass when the status shows disconnected and no process lookup runs, as in Electron.
- [ ] Lane 5. Remove the lockfile with the process running. Save `process-lookup.log`. Pass when the fallback runs at most once per 30 s.
- [ ] Lane 6. Run lane 1 on `windows-latest`. Save `win-status.png`. Pass when it matches and no console window flashes.
- [ ] Lane 7. Stop the fake client mid-session. Save `client-gone.png`. Pass when the status changes to disconnected within the same time as Electron.
- [ ] Lane 8. Subscribe to the socket and receive 10 events. Save `socket.log`. Pass when the frames match the scenario.
- [ ] Lane 9. Build release and search it for the fake CA. Save `release-no-parity-ca.log`. Pass when it is absent.
- [ ] Lane 10. Golden replay with the event scenarios. Save `golden-table.log`. Pass when the `lcu:status` row and the status event sequence pass.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Time from fake-client start to `connected`, and memory with the client connected for 5 minutes.
- [ ] Probe. Start and stop the fake client 10 times per app alternately, then idle 5 minutes connected.
- [ ] Baseline. Record Electron's numbers first.
- [ ] Rule. Fail when Tauri connects slower than Electron's median plus 1 s, or its memory grows more than 5 MB over the 5 minutes.

**Review gate.** None. T19 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact tip SHA, recorded in `docs/tauri-port/units/<id>.md`.
- [ ] The branch sits on its parent's tip with the patch-id unchanged since the verdict.
- [ ] No GitHub pull request exists for the branch.
- [ ] The operator lands the chain bottom-up with `git merge --ff-only` into `main`.

## Port polling, backfill, and end-of-game capture (T20)

**Depends on.** T12 and T19.

**Files.**

- [ ] Create `tauri/src-tauri/src/lcu/sync.rs`, `lcu/backfill.rs`, and `lcu/eog.rs`.
- [ ] Edit `tauri/src-tauri/src/commands/lcu.rs`, `shell.rs`, and `lib.rs`.

**Build.**

- [ ] Port the 5 s connect loop, the 60 s poll, and the recent-games sync from `lcu.ts`.
- [ ] Port the SGP deep-history backfill with shard probing and cancel, for `lcu:backfill`, `lcu:cancel-backfill`, and `lcu:backfill-running`, with the `lcu:backfill-progress` and `lcu:backfill-done` events.
- [ ] Port end-of-game capture over the socket with the retries at 2, 5, 15, 60, 120, and 120 s, and the `lcu:games-updated` event.
- [ ] Wire the quit hook from T10 to the final fetch with the 5 s cap.

**You see.**

- [ ] A game that ends in the fake client appears in Tauri's Match History at the same moment it appears in Electron's.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `lcu/eog.rs` tests drive a fake clock through the retry list and assert each attempt's time.
- [ ] `lcu/backfill.rs` tests assert the shard probe order and that cancel stops within one request.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `opus` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run `end-of-game` against both apps on fresh fixture copies. Save `eog-row.png`. Pass when the new row matches and the event sequence equals the golden.
- [ ] Lane 2. Run `results-late`. Save `eog-late.log`. Pass when the capture succeeds on the fourth attempt at Electron's times.
- [ ] Lane 3. Run `backfill-running` to the end. Save `backfill-done.png`. Pass when the toast and the inserted rows match Electron's.
- [ ] Lane 4. Cancel a backfill midway. Save `backfill-cancel.png`. Pass when the cancelled toast shows and the row count matches Electron's after the same cancel.
- [ ] Lane 5. Run `backfill-error`. Save `backfill-error.png`. Pass when the error toast matches.
- [ ] Lane 6. Quit with the client connected and one unsynced game. Save `final-fetch.log`. Pass when the game is in the database after exit.
- [ ] Lane 7. Quit with a fake client that never answers. Save `final-fetch-timeout.log`. Pass when the process exits within 5 s.
- [ ] Lane 8. Run lanes 1 and 3 on `windows-latest`. Save `win-sync.log`. Pass when both match.
- [ ] Lane 9. Leave the app connected for 10 minutes. Save `poll.log`. Pass when it polls every 60 s as Electron does.
- [ ] Lane 10. Golden replay with the event scenarios. Save `golden-table.log`. Pass when the `lcu:*` rows pass and no row fails.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Time from the fake client's end-of-game event to the new row painted.
- [ ] Probe. Run `end-of-game` 10 times per app alternately.
- [ ] Baseline. Record Electron's median first.
- [ ] Rule. Fail when Tauri's median is slower than Electron's by more than 200 ms.

**Review gate.** None. T20 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact tip SHA, recorded in `docs/tauri-port/units/<id>.md`.
- [ ] The branch sits on its parent's tip with the patch-id unchanged since the verdict.
- [ ] No GitHub pull request exists for the branch.
- [ ] The operator lands the chain bottom-up with `git merge --ff-only` into `main`.

## Port live game and challenge tracking (T21)

**Depends on.** T20 and T22.

**Files.**

- [ ] Create `tauri/src-tauri/src/live.rs`, `db/live.rs`, `challenges.rs`, and `db/challenges.rs`.
- [ ] Edit `tauri/src-tauri/src/commands/live.rs` and `lib.rs`.

**Build.**

- [ ] Port `live.ts` and `db/live.ts`. That is the 3 s poll of the game's port 2999 API and the map write, for `live:snapshot` and the `live:changed` event. First try the pinned Riot root on port 2999 during a real game. Keep it if it verifies. Otherwise match Electron, which turns certificate checks off there, and record that in Appendix C.
- [ ] Port `challenges.ts` and `db/challenges.ts` with the capture delays at 0, 5, 20, and 60 s, for `challenges:get` and the `challenges:changed` event.

**You see.**

- [ ] The Live Game page and Challenges page work on the real commands against the fake client, through every state of the T03 baseline.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `live.rs` tests feed recorded 2999 responses and assert the snapshots equal the goldens.
- [ ] `challenges.rs` tests assert one capture per day and the delay list.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `opus` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run `in-game` against both apps with the Electron renderer. Save `live-real.png`. Pass when the cross-engine policy passes.
- [ ] Lane 2. Run `in-game-loading`. Save `live-loading.png`. Pass when the hourglass shows.
- [ ] Lane 3. Run the game through to the end. Save `live-to-recap.png`. Pass when the page moves to waiting and then to the recap, as in Electron.
- [ ] Lane 4. Run `challenges-loaded`. Save `challenges-real.png`. Pass when it matches.
- [ ] Lane 5. Start with the client offline and open Challenges. Save `challenges-offline.png`. Pass when "isn't running" shows.
- [ ] Lane 6. Advance the clock one day with the client up. Save `challenges-day.log`. Pass when one new capture is written.
- [ ] Lane 7. Play a real game on the operator's machine with the head app open, if the operator agrees. Save `real-game.log`. Pass when the live page tracks it and the map is written.
- [ ] Lane 8. Run lanes 1 and 4 on `windows-latest`. Save `win-live.png`. Pass when both match.
- [ ] Lane 9. Watch the live poll for 2 minutes. Save `live-poll.log`. Pass when it polls every 3 s and stops when the game ends.
- [ ] Lane 10. Golden replay with the event scenarios. Save `golden-table.log`. Pass when the `live:*` and `challenges:*` rows pass and no row fails.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. CPU time and memory over 5 minutes of `in-game` polling.
- [ ] Probe. Run `in-game` 5 minutes per app, twice, alternating.
- [ ] Baseline. Record Electron's numbers first.
- [ ] Rule. Fail when Tauri uses more CPU time or more memory than Electron.

**Review gate.** None. T21 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact tip SHA, recorded in `docs/tauri-port/units/<id>.md`.
- [ ] The branch sits on its parent's tip with the patch-id unchanged since the verdict.
- [ ] No GitHub pull request exists for the branch.
- [ ] The operator lands the chain bottom-up with `git merge --ff-only` into `main`.

## Port Data Dragon loading, the asset protocol, and the asset cache (T22)

**Depends on.** T19.

**Files.**

- [ ] Create `tauri/src-tauri/src/dragon.rs`, `assets.rs`, and `asset_cache.rs`.
- [ ] Copy `src/main/augment-descriptions.json` into `tauri/src-tauri/resources/`.
- [ ] Edit `tauri/src-tauri/src/commands/dragon.rs`, `lib.rs`, and `tauri.conf.json`.
- [ ] Create `tauri/src/lib/asset-url.ts`. It wraps the builders in `src/shared/game-assets.ts` and swaps the `asset://` base per platform, so the Electron file stays unchanged.
- [ ] Edit `parity/run-tauri.ts` to apply the same swap when it runs the Electron renderer on Windows.

**Build.**

- [ ] Port `dragon.ts` for `dragon:champions`, `dragon:augments`, `dragon:augment-icon`, `dragon:items`, and `dragon:summoner-spells`, with the same hosts, the outage backoff, `champion-cache.json`, and `augment-icon-cache.json`.
- [ ] Register the `asset` scheme with `register_asynchronous_uri_scheme_protocol`. Leave Tauri's built-in `protocol-asset` feature off, so ours owns the name. Serve `game-data/<latest|pbe|NN.NN>/<path>` and `splash/<id>` from `asset-cache/` and fetch on a miss, with the 24 h prune.
- [ ] Make the URL base `asset://` on macOS and `http://asset.localhost/` on Windows in `asset-url.ts`, because WebView2 serves custom schemes as `http://<scheme>.localhost`. The cache layout on disk stays as it is.

**You see.**

- [ ] Every icon and splash in the Electron renderer inside the Tauri webview loads from the existing `asset-cache/` with no network.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `assets.rs` tests resolve each URL shape the renderer builds to the same cache path Electron uses.
- [ ] `asset_cache.rs` tests assert the prune keeps the same folders Electron keeps.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `opus` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Load Match History in both apps with the network blocked. Save `assets-offline.png`. Pass when no image is missing in either and the cross-engine policy passes.
- [ ] Lane 2. Run lane 1 on `windows-latest`. Save `win-assets.png`. Pass when every image loads through `http://asset.localhost`.
- [ ] Lane 3. Clear one patch folder and load with the network open. Save `asset-miss.log`. Pass when the files are fetched into the same paths Electron uses.
- [ ] Lane 4. Load Global champion detail. Save `splash.png`. Pass when the splash shows.
- [ ] Lane 5. Block Data Dragon and start. Save `dragon-outage.log`. Pass when the backoff matches Electron's and the cached data loads.
- [ ] Lane 6. Request a path with `..` in it. Save `asset-traversal.log`. Pass when it is refused.
- [ ] Lane 7. Hover an augment. Save `augment-icon.png`. Pass when the icon and description load.
- [ ] Lane 8. Advance the clock past the prune age. Save `asset-prune.log`. Pass when the same folders remain as in Electron.
- [ ] Lane 9. Load a PBE asset. Save `pbe-asset.png`. Pass when it matches Electron.
- [ ] Lane 10. Golden replay. Save `golden-table.log`. Pass when the `dragon:*` rows pass and no row fails.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Time to load the 145 images on Match History from a warm cache.
- [ ] Probe. Load the page 10 times per app alternately and read image load times from the page.
- [ ] Baseline. Record Electron's median first.
- [ ] Rule. Fail when Tauri's median exceeds Electron's by more than 25%.

**Review gate.** None. T22 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact tip SHA, recorded in `docs/tauri-port/units/<id>.md`.
- [ ] The branch sits on its parent's tip with the patch-id unchanged since the verdict.
- [ ] No GitHub pull request exists for the branch.
- [ ] The operator lands the chain bottom-up with `git merge --ff-only` into `main`.

## Port autostart, the Start Menu shortcut, and the app id (T23)

**Depends on.** T10 and T11.

**Files.**

- [ ] Create `tauri/src-tauri/src/autostart.rs` and `tauri/src-tauri/src/shortcut.rs`.
- [ ] Edit `tauri/src-tauri/src/commands/settings.rs`, `lib.rs`, and `tauri.conf.json`.

**Build.**

- [ ] Port `autostart.ts` directly, per decision E7, not with `tauri-plugin-autostart`. On macOS write `~/Library/LaunchAgents/com.better-mayhem-tracker.app.autostart.plist` with `<bundle>/Contents/MacOS/Better Mayhem Tracker --hidden` and RunAtLoad. On Windows write the HKCU Run value `better-mayhem-tracker` as `"<exe>" --hidden`. Keep `auto_start_path` in sync on each launch.
- [ ] Port `shortcut.ts` with the `windows` crate. Write `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Better Mayhem Tracker.lnk` with AppUserModelID `com.better-mayhem-tracker.app`, and set the same id on the process.
- [ ] Set `mainBinaryName` to `Better Mayhem Tracker` in `tauri.conf.json`, so the LaunchAgent that Electron wrote points at a binary that exists after the update.
- [ ] Port `autostart:supported`.

**You see.**

- [ ] Turning autostart on in Tauri writes the same LaunchAgent or Run value that Electron writes, and an existing Electron entry keeps working after the update.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `autostart.rs` tests render the plist and the Run value and assert byte equality with Electron's output from a golden.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `opus` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Turn autostart on in each app in turn and diff the plist. Save `plist-diff.log`. Pass when the files are identical apart from the bundle path.
- [ ] Lane 2. Do the same on `windows-latest` for the Run value. Save `win-run-value.log`. Pass when name and data match.
- [ ] Lane 3. Log out and in on the operator's Mac with autostart on, if the operator agrees. Save `login-hidden.log`. Pass when the app starts hidden in the tray.
- [ ] Lane 4. Move the app bundle and launch. Save `moved-app.log`. Pass when the plist is rewritten to the new path, as in Electron.
- [ ] Lane 5. Turn autostart off. Save `autostart-off.log`. Pass when the plist is gone.
- [ ] Lane 6. Check the Start Menu shortcut on `windows-latest`. Save `win-lnk.log`. Pass when its target and AppUserModelID match.
- [ ] Lane 7. Pin the taskbar icon on Windows and relaunch. Save `win-taskbar.png`. Pass when the pin groups with the running app.
- [ ] Lane 8. Open Settings on an unpackaged build. Save `autostart-unsupported.png`. Pass when the toggle shows unsupported, as in Electron dev.
- [ ] Lane 9. Start with an Electron-written plist present. Save `inherited-plist.log`. Pass when Tauri keeps it and no second agent appears.
- [ ] Lane 10. Golden replay. Save `golden-table.log`. Pass when the `autostart:*` row passes and no row fails.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Time from login item launch to the tray icon present with `--hidden`.
- [ ] Probe. Launch each app with `--hidden` 10 times alternately.
- [ ] Baseline. Record Electron's median first.
- [ ] Rule. Fail when Tauri is slower than Electron.

**Review gate.** The operator reviews before merge.

- [ ] Copy the lane 1,4,6,7 screenshots into `parity/out/review/T23-review-<slug>.png`, with the side-by-side image for each.
- [ ] Record a 30 to 60 second video of the change on a lane machine. Save it as `parity/out/review/T23-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at STACK-READY. Wait for the operator's go before the unit lands.

**Merge.**

- [ ] Root's clean verdict at the exact tip SHA, recorded in `docs/tauri-port/units/<id>.md`.
- [ ] The branch sits on its parent's tip with the patch-id unchanged since the verdict.
- [ ] No GitHub pull request exists for the branch.
- [ ] The operator lands the chain bottom-up with `git merge --ff-only` into `main`.

## Port the updater and the hand-off from Electron 1.2.1 (T24)

**Depends on.** T21 and T23.

**Files.**

- [ ] Create `tauri/src-tauri/src/updater.rs` and `tauri/src-tauri/src/mac_update_script.rs`.
- [ ] Edit `tauri/src-tauri/src/commands/app.rs` and `lib.rs`.
- [ ] Edit `parity/fake-github.ts` to serve real Tauri build assets.

**Build.**

- [ ] Port `updater.ts` directly, per decision E6. It calls `GET api.github.com/repos/rambo0247/better-mayhem-tracker/releases?per_page=20`, drops drafts and prereleases, compares `vX.Y.Z` as a numeric triple, and picks `BetterMayhemTracker-mac-<arch>.zip` or the first `.exe`. It checks the sha256 digest when GitHub gives one.
- [ ] Port the schedule. That is launch tries up to 3 times 60 s apart and skipped in a match, every 45 minutes, and 2 minutes after the window is hidden, installing only while the window is put away and `auto_update` is not `false`.
- [ ] Port the Windows swap. A `cmd` script waits for the exe to unlock, copies the new exe over it, and relaunches.
- [ ] Port the macOS swap from `mac-update-script.ts`. It unpacks with `ditto` and swaps the bundle at the same path.
- [ ] Port `app:check-update`, `app:download-update`, `app:launch-install`, `app:update-notes`, `recordLaunchVersion`, and the `update:*` events.

**You see.**

- [ ] Electron 1.2.1 offered a release built by this branch installs it and relaunches into the Tauri app on the same data, on macOS and on Windows.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `updater.rs` tests assert version comparison, asset choice per platform and arch, the digest check, and the schedule against a fake clock.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `opus` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Install packaged Electron 1.2.1 on a scratch path with a snapshot, point its updater at `parity/fake-github.ts` through the seam, and offer a Tauri `v1.3.0` zip. Save `handoff-mac.png`. Pass when it relaunches as the Tauri app on the same data and Match History matches the pre-update screenshot.
- [ ] Lane 2. Repeat lane 1 on `windows-latest` with the Tauri exe as `BetterMayhemTracker.exe`. Save `handoff-win.png`. Pass when the same holds.
- [ ] Lane 3. Offer a Tauri `v1.3.1` to the Tauri `v1.3.0`. Save `tauri-to-tauri.png`. Pass when it updates in place.
- [ ] Lane 4. Offer an update while the window is visible. Save `update-button.png`. Pass when the header shows "Update available" and nothing installs.
- [ ] Lane 5. Click Update in the dialog. Save `update-downloading.png`. Pass when the progress bar moves as in Electron.
- [ ] Lane 6. Serve a zip with a wrong digest. Save `digest-reject.log`. Pass when the install is refused, as in Electron.
- [ ] Lane 7. Offer an update during a game. Save `in-game-skip.log`. Pass when the launch check skips it.
- [ ] Lane 8. Relaunch after the update. Save `whats-new.png`. Pass when What's New shows the release notes, as in Electron.
- [ ] Lane 9. Run from a mounted `.dmg`. Save `not-durable.log`. Pass when auto-install is off, as in Electron.
- [ ] Lane 10. Golden replay. Save `golden-table.log`. Pass when the `app:*` update rows pass and no row fails.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Download size of the update and time from the install click to the relaunched window.
- [ ] Probe. Run lane 1 and lane 3 five times each.
- [ ] Baseline. Record Electron 1.2.1 to Electron 1.2.1 update size and time first, from the T06 asset sizes and one timed run.
- [ ] Rule. Fail when the Tauri update zip exceeds 10 MB or the relaunch takes longer than Electron's.

**Review gate.** The operator reviews before merge.

- [ ] Copy the lane 1,2,4,5,8 screenshots into `parity/out/review/T24-review-<slug>.png`, with the side-by-side image for each.
- [ ] Record a 30 to 60 second video of the change on a lane machine. Save it as `parity/out/review/T24-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at STACK-READY. Wait for the operator's go before the unit lands.

**Merge.**

- [ ] Root's clean verdict at the exact tip SHA, recorded in `docs/tauri-port/units/<id>.md`.
- [ ] The branch sits on its parent's tip with the patch-id unchanged since the verdict.
- [ ] No GitHub pull request exists for the branch.
- [ ] The operator lands the chain bottom-up with `git merge --ff-only` into `main`.

## Port card image export (T25)

**Depends on.** T22 and T29.

**Files.**

- [ ] Create `tauri/src-tauri/src/export_image.rs`.
- [ ] Edit `tauri/src-tauri/src/snapshot/mac.rs`, `snapshot/win.rs`, and `commands/export.rs`.
- [ ] Edit `tauri/src/hooks/useCardCapture.ts` from T29 only to report readiness through an event.

**Build.**

- [ ] Open a hidden capture window per export on the card route, 1200 CSS px wide, with the app's `asset` scheme. Wait for the same readiness the React hook publishes, all images complete and stable across two polls with the 10 s cap, and the 3 s name-lookup grace.
- [ ] On macOS set the webview's device scale to 1.5 with `_setOverrideDeviceScaleFactor:` behind `respondsToSelector`, then call `takeSnapshotWithConfiguration` with `snapshotWidth` 1200. Capture one extra pixel of height and crop, since WebKit truncates. If the selector is missing, use the public path at the backing scale and log it. Decision E9 covers the private call.
- [ ] On Windows set `SetShouldDetectMonitorScaleChanges(false)`, `SetRasterizationScale(1.0)`, and `SetZoomFactor(1.5)`, then call `Page.captureScreenshot` with `captureBeyondViewport`. If an invisible controller does not paint, place the window off screen and visible.
- [ ] Re-encode to RGB PNG with no metadata chunks, as `toPNG` writes. Save through the dialog with Electron's default name, or put `image/png` on the clipboard with `tauri-plugin-clipboard-manager`, for `export:card-image` and `export:copy-card-image`.

**You see.**

- [ ] Export as PNG and Copy Image produce a 1800 px wide card that matches Electron's within the cross-engine policy on macOS and the Windows policy from T07.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `export_image.rs` tests assert the PNG has no ancillary chunks and that the crop height is `ceil(h * 1.5)`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `opus` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Export the newest game's card from both apps. Save `card-side-by-side.png`. Pass when both are 1800 px wide, the heights match, and the cross-engine policy passes.
- [ ] Lane 2. Export a season card. Save `season-card-side-by-side.png`. Pass when the same holds.
- [ ] Lane 3. Copy a card and paste it into Preview. Save `clipboard.png`. Pass when the pasted image equals the exported file.
- [ ] Lane 4. Export with the main window hidden to the tray. Save `export-hidden.png`. Pass when the image equals lane 1's.
- [ ] Lane 5. Export a card whose champion data is not loaded yet. Save `export-grace.png`. Pass when it waits the grace period and matches Electron's output.
- [ ] Lane 6. Export a card for a deleted game. Save `export-missing.log`. Pass when the error matches Electron's.
- [ ] Lane 7. Run lanes 1 and 2 on `windows-latest`. Save `win-card.png`. Pass when the Windows policy passes.
- [ ] Lane 8. Export 5 cards in a row. Save `export-burst.log`. Pass when 5 files exist and memory returns within 10 MB of its start.
- [ ] Lane 9. Cancel the save dialog. Save `export-cancel.log`. Pass when nothing is written, as in Electron.
- [ ] Lane 10. Check the export message pill after save and after failure. Save `export-pill.png`. Pass when both match the T04 baseline.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Time from the click to the PNG on disk for one game card.
- [ ] Probe. Export the same card 10 times per app alternately.
- [ ] Baseline. Electron measured 715 ms median in the prototype. Record it again here first.
- [ ] Rule. Fail when Tauri's median exceeds Electron's.

**Review gate.** The operator reviews before merge.

- [ ] Copy the lane 1,2,3,4,7 screenshots into `parity/out/review/T25-review-<slug>.png`, with the side-by-side image for each.
- [ ] Record a 30 to 60 second video of the change on a lane machine. Save it as `parity/out/review/T25-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at STACK-READY. Wait for the operator's go before the unit lands.

**Merge.**

- [ ] Root's clean verdict at the exact tip SHA, recorded in `docs/tauri-port/units/<id>.md`.
- [ ] The branch sits on its parent's tip with the patch-id unchanged since the verdict.
- [ ] No GitHub pull request exists for the branch.
- [ ] The operator lands the chain bottom-up with `git merge --ff-only` into `main`.

## Carry localStorage over from Electron (T26)

**Depends on.** T09.

**Files.**

- [ ] Create `tauri/src-tauri/src/local_storage.rs`.
- [ ] Edit `tauri/src-tauri/src/lib.rs` and `tauri/src/api.ts`.

**Build.**

- [ ] On first launch, copy `<root>/Local Storage/leveldb` to a temp folder and read it with `rusty-leveldb` 4.0.2. Open only the copy, because opening writes recovery files.
- [ ] Read keys of the form `_file://` + `\x00` + an encoding byte + the key. Decode each value by its first byte, `0x00` as UTF-16LE and `0x01` as latin1.
- [ ] Import `recap-badge-seen` and every `view:*` key from the list in Appendix F into the webview's localStorage before the UI's first read, then write a `local_storage_imported` setting so it runs once.

**You see.**

- [ ] After the Electron to Tauri update, remembered filters and the seen recap badge are as the player left them.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `local_storage.rs` tests read the prototype's synthetic leveldb with a latin1 value, a UTF-16 value, and bookkeeping keys, and assert the imported pairs.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `opus` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Set filters in trunk Electron with `remember_filters` on, quit, then start head Tauri on the same snapshot. Save `filters-carried.png`. Pass when Match History opens with the same filters.
- [ ] Lane 2. Mark the season recap seen in Electron, then start Tauri. Save `badge-carried.png`. Pass when no badge shows.
- [ ] Lane 3. Start Tauri on a snapshot with an empty store. Save `empty-store.log`. Pass when nothing is imported and nothing fails.
- [ ] Lane 4. Start Tauri twice. Save `import-once.log`. Pass when the second start imports nothing.
- [ ] Lane 5. Store a non-latin1 account name in a filter. Save `utf16-value.png`. Pass when it shows correctly in Tauri.
- [ ] Lane 6. Run lane 1 on `windows-latest`. Save `win-filters-carried.png`. Pass when it holds.
- [ ] Lane 7. Compare the real store's files before and after a Tauri start on a snapshot. Save `store-untouched.log`. Pass when the original files are unchanged.
- [ ] Lane 8. Corrupt the leveldb copy. Save `store-corrupt.log`. Pass when the import is skipped with a log line and the app starts.
- [ ] Lane 9. Set every listed key in Electron and start Tauri. Save `all-keys.log`. Pass when every key reads back equal.
- [ ] Lane 10. Turn `remember_filters` off in Electron and start Tauri. Save `remember-off.png`. Pass when the page shows defaults, as Electron would.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Time the import adds to the first launch.
- [ ] Probe. Launch on a store with every key 10 times, deleting the imported flag between runs.
- [ ] Baseline. Trunk has no import. Record Tauri's first launch time with the import skipped first.
- [ ] Rule. Fail when the import adds more than 50 ms.

**Review gate.** None. T26 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact tip SHA, recorded in `docs/tauri-port/units/<id>.md`.
- [ ] The branch sits on its parent's tip with the patch-id unchanged since the verdict.
- [ ] No GitHub pull request exists for the branch.
- [ ] The operator lands the chain bottom-up with `git merge --ff-only` into `main`.

## Port the UI shell, styles, router, hooks, and shared components to Solid 2 (T27)

**Depends on.** T08.

**Files.**

- [ ] Create `tauri/src/global.css` from `src/renderer/global.css`, with the `@fontsource` imports.
- [ ] Create `tauri/src/App.tsx`, `tauri/src/main.tsx`, `tauri/src/components/Layout.tsx`, and `tauri/src/components/Header.tsx`.
- [ ] Create `tauri/src/lib/` from `src/renderer/lib/` and `tauri/src/hooks/` from `src/renderer/hooks/`.
- [ ] Create the tier 0 and tier 1 components from Appendix F under `tauri/src/components/`. That is `icons`, `SettingsIcons`, `BrandMark`, `Kda`, `MultikillBadge`, `PageHeader`, `StatCard`, `RiotId`, `RiotText`, `HoverCard`, `SearchInput`, `RarityFilter`, `ScoreCell`, `StatBars`, `WinRateBar`, `Markdown`, `ActivityCalendar`, `ChampionIcon`, `SummonerIcon`, `SummonerSpellIcon`, `ChallengeToken`, `ItemIcon`, `AugmentIcon`, `FilterMenu`, `SortHeader`, `DialogFrame`, `ReleaseNotes`, the four selects, `MinGamesFilter`, `SharedStats`, `RecordCard`, `MatchScoreboard`, and `LiveScoreboard`.
- [ ] Create `tauri/scripts/react-isms.ts`.
- [ ] Edit `tauri/vite.config.ts` to add the `@shared` alias to `../src/shared`.

**Build.**

- [ ] Read the three Solid 2 skills in `tauri/node_modules/solid-js/skills/` and the migration guide before the first component. Write the port by hand. Do not use `react2solid` or `solid-reactor`.
- [ ] Write `tauri/scripts/react-isms.ts`. It counts, per file under `tauri/src/`, destructured props, `onChange` on text inputs, early `return null`, React hook names, `className`, camelCase `style` keys, and numeric `style` sizes, and fails on any count above zero. The React tree's counts it reports for reference are 178 destructured props, 53 `onChange` (16 on native elements), 26 `return null`, and 34 `useEffect` with `[]`.
- [ ] Apply the Solid 2 rules everywhere. Read props through `props.x` or `splitProps`. Use `onInput` on text inputs. Use `<Show>` for early returns. Turn `useEffect(fn, [])` into `onSettled` that returns its cleanup. Use `class`, kebab-case `style` keys, and explicit `px` units.
- [ ] Port `HashRouter` routes with `@solidjs/router` 2.0.1 under the same `#/` paths, including `location.state` for Champions to Match History and the Friends view.
- [ ] Block first render on `getSetting("remember_filters")` and `initViewState`, as `src/renderer/main.tsx` does.
- [ ] Replace `-webkit-app-region` with `data-tauri-drag-region` on the same elements in `Header.tsx`.
- [ ] Replace `objectViewBox: "inset(6%)"` in `ChampionIcon` with a wrapper that has `overflow: hidden` and an image scaled by `1 / 0.88`, which crops the same 6% on each side in WebKit and in Chromium. Add the `-webkit-` prefix to the `mask-image` in `RecordCard`.
- [ ] Log a `first-content` line when `BMT_PERF=1` and the first page's first row paints, for the T06 probe.
- [ ] Render `HoverCard` through Solid's `Portal` to `body`, measured before showing as in React.

**You see.**

- [ ] The Solid shell shows the sidebar, title bar, and status card, and pixel-matches the Electron baseline for the Layout chrome in both sidebar widths on macOS and Windows.
- [ ] `bun tauri/scripts/react-isms.ts` prints zeros for every count.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `tauri/src/components/*.test.tsx` render each tier 0 and tier 1 component with `@solidjs/web` in happy-dom under `bun test`, and assert the DOM text and classes of each prop combination against a snapshot taken from the React component with the same props.
- [ ] `tauri/scripts/react-isms.test.ts` asserts each pattern is found in a fixture file.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `opus` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Capture the Layout chrome on Match History's empty state in trunk Electron and head Tauri on macOS. Save `chrome-mac.png`. Pass when the cross-engine policy passes with no mask.
- [ ] Lane 2. Repeat lane 1 on `windows-latest`. Save `chrome-win.png`. Pass when the Windows policy passes.
- [ ] Lane 3. Capture the rail layout at 1179 px. Save `chrome-rail.png`. Pass when the cross-engine policy passes.
- [ ] Lane 4. Capture the four status dots through the fake client. Save `status-dots.png`. Pass when each passes the cross-engine policy.
- [ ] Lane 5. Drag the window by the header on macOS and Windows. Save `drag.log`. Pass when the window moves and clicks on nav items still navigate.
- [ ] Lane 6. Render a champion portrait grid. Save `portraits.png`. Pass when every portrait tile passes the 8% tile rule against Electron.
- [ ] Lane 7. Hover an item icon. Save `item-hover.png`. Pass when the hover card position and text match Electron's.
- [ ] Lane 8. Navigate every nav link. Save `nav.log`. Pass when each route renders its placeholder and the active link style matches Electron's.
- [ ] Lane 9. Hide two nav links in settings and reload. Save `hidden-links.png`. Pass when the nav matches Electron's with the same setting.
- [ ] Lane 10. Run `react-isms.ts`. Save `react-isms.log`. Pass when every count is zero.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Launch to the shell's first paint, and idle memory with the shell on screen.
- [ ] Probe. `bun parity/perf.ts --app tauri --scenario shell --runs 10` interleaved with Electron.
- [ ] Baseline. Record Electron's launch to first paint and idle memory first.
- [ ] Rule. Fail when Tauri's launch median is slower than Electron's or its memory exceeds 60% of Electron's.

**Review gate.** The operator reviews before merge.

- [ ] Copy the lane 1,2,3,6 screenshots into `parity/out/review/T27-review-<slug>.png`, with the side-by-side image for each.
- [ ] Record a 30 to 60 second video of the change on a lane machine. Save it as `parity/out/review/T27-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at STACK-READY. Wait for the operator's go before the unit lands.

**Merge.**

- [ ] Root's clean verdict at the exact tip SHA, recorded in `docs/tauri-port/units/<id>.md`.
- [ ] The branch sits on its parent's tip with the patch-id unchanged since the verdict.
- [ ] No GitHub pull request exists for the branch.
- [ ] The operator lands the chain bottom-up with `git merge --ff-only` into `main`.

## Port the Records and Augments pages (T28)

**Depends on.** T27.

**Files.**

- [ ] Create `tauri/src/pages/Records.tsx` and `tauri/src/pages/Augments.tsx`.

**Build.**

- [ ] Port `Records.tsx` with its account and queue selects, both sections, the record cards, and the match modal.
- [ ] Port `Augments.tsx` with the rarity filter, filter menu, expandable rows, and the empty state.
- [ ] Run each page on the real commands when T14 has landed, and on replayed goldens before that.

**You see.**

- [ ] Records and Augments pass the pixel diff against the Electron baseline in every state Appendix F lists for them.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `tauri/src/pages/Records.test.tsx` and `Augments.test.tsx` render each page on replayed goldens and assert the text of the loading, empty, and loaded states.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `opus` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Capture Records loaded in both apps on macOS. Save `records.png`. Pass when the cross-engine policy passes.
- [ ] Lane 2. Records with a queue that has no games. Save `records-empty.png`. Pass when "No games match this filter" shows and the policy passes.
- [ ] Lane 3. Records with two accounts and the account select open. Save `records-accounts.png`. Pass when the policy passes.
- [ ] Lane 4. Click a record card to open its match. Save `records-modal.png`. Pass when the modal and its blur region pass.
- [ ] Lane 5. Augments loaded. Save `augments.png`. Pass when the policy passes.
- [ ] Lane 6. Augments filtered to Prismatic. Save `augments-prismatic.png`. Pass when the policy passes, including the gradient text.
- [ ] Lane 7. Augments with a row expanded. Save `augments-expanded.png`. Pass when the policy passes.
- [ ] Lane 8. Hover an augment icon. Save `augments-hover.png`. Pass when the hover card passes.
- [ ] Lane 9. Records and Augments on `windows-latest`. Save `win-records.png`. Pass when the Windows policy passes.
- [ ] Lane 10. Sort Augments by each column and reload with `remember_filters` on. Save `augments-sort.png`. Pass when the sort survives the reload as in Electron.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Time from clicking the nav link to the page's first row painted, for each page.
- [ ] Probe. Navigate to each page 10 times per app alternately.
- [ ] Baseline. Record Electron's medians first.
- [ ] Rule. Fail when Tauri's median is slower than Electron's by more than 10%.

**Review gate.** The operator reviews before merge.

- [ ] Copy the lane 1,4,6,9 screenshots into `parity/out/review/T28-review-<slug>.png`, with the side-by-side image for each.
- [ ] Record a 30 to 60 second video of the change on a lane machine. Save it as `parity/out/review/T28-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at STACK-READY. Wait for the operator's go before the unit lands.

**Merge.**

- [ ] Root's clean verdict at the exact tip SHA, recorded in `docs/tauri-port/units/<id>.md`.
- [ ] The branch sits on its parent's tip with the patch-id unchanged since the verdict.
- [ ] No GitHub pull request exists for the branch.
- [ ] The operator lands the chain bottom-up with `git merge --ff-only` into `main`.

## Port Season Recap and the two card routes (T29)

**Depends on.** T27.

**Files.**

- [ ] Create `tauri/src/pages/SeasonRecap.tsx`, `tauri/src/pages/GameCard.tsx`, and `tauri/src/pages/SeasonCard.tsx`.
- [ ] Create `tauri/src/components/SeasonRecapCard.tsx`, `ExportImage.tsx`, and `tauri/src/hooks/useCardCapture.ts`.

**Build.**

- [ ] Port `SeasonRecap.tsx`, including the preview scaled with CSS `zoom` inside the resize observer frame and the one-shot `?season=` parameter.
- [ ] Port `SeasonRecapCard.tsx`, all 1,010 lines, with the activity calendar and record cards.
- [ ] Port `GameCard.tsx`, `SeasonCard.tsx`, and `useCardCapture.ts` with `body.card-window`, the `window.__mayhemCardStatus` handshake, and the 3 s lookup grace.
- [ ] Port `ExportImage.tsx` with its busy, idle, and message states. Its commands return `not ported` until T25 lands.

**You see.**

- [ ] Season Recap and both card routes pass the pixel diff against the Electron baseline in every state Appendix F lists.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `tauri/src/pages/SeasonRecap.test.tsx` asserts the loading, empty, and loaded text, and `useCardCapture.test.ts` asserts the status moves to `ready` only after images settle.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `opus` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Capture Season Recap loaded in both apps. Save `season.png`. Pass when the cross-engine policy passes.
- [ ] Lane 2. Season Recap with friends hidden. Save `season-hide-friends.png`. Pass when the policy passes.
- [ ] Lane 3. A season with no games. Save `season-empty.png`. Pass when the policy passes.
- [ ] Lane 4. Resize the window to 900 px wide. Save `season-zoomed.png`. Pass when the preview's `zoom` scale and the policy pass.
- [ ] Lane 5. Open `/card/<id>` directly. Save `game-card.png`. Pass when it reaches `ready` and the policy passes.
- [ ] Lane 6. Open `/season-card/<id>?hideFriends=1`. Save `season-card.png`. Pass when it reaches `ready` and the policy passes.
- [ ] Lane 7. Open `/card/<missing id>`. Save `card-missing.png`. Pass when the error text shows.
- [ ] Lane 8. Follow the nav recap badge. Save `season-from-badge.png`. Pass when `?season=` is consumed and stripped, as in Electron.
- [ ] Lane 9. Lanes 1 and 5 on `windows-latest`. Save `win-season.png`. Pass when the Windows policy passes.
- [ ] Lane 10. Click Export as PNG before T25 lands. Save `export-not-ported.png`. Pass when the failed pill shows the error text, which records the gap until T25.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Time from the nav click to the preview card painted.
- [ ] Probe. Navigate 10 times per app alternately.
- [ ] Baseline. Record Electron's median first.
- [ ] Rule. Fail when Tauri's median is slower than Electron's by more than 10%.

**Review gate.** The operator reviews before merge.

- [ ] Copy the lane 1,4,5,6 screenshots into `parity/out/review/T29-review-<slug>.png`, with the side-by-side image for each.
- [ ] Record a 30 to 60 second video of the change on a lane machine. Save it as `parity/out/review/T29-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at STACK-READY. Wait for the operator's go before the unit lands.

**Merge.**

- [ ] Root's clean verdict at the exact tip SHA, recorded in `docs/tauri-port/units/<id>.md`.
- [ ] The branch sits on its parent's tip with the patch-id unchanged since the verdict.
- [ ] No GitHub pull request exists for the branch.
- [ ] The operator lands the chain bottom-up with `git merge --ff-only` into `main`.

## Port the Challenges page (T30)

**Depends on.** T27.

**Files.**

- [ ] Create `tauri/src/pages/Challenges.tsx`.

**Build.**

- [ ] Port `Challenges.tsx` with the capstone card, the player card, the category cards with tiers, the offline state, and the dependency on the client status.

**You see.**

- [ ] Challenges passes the pixel diff against the Electron baseline loaded, without a capstone, loading, and offline.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `tauri/src/pages/Challenges.test.tsx` asserts the text of the loading, offline, and loaded states, and that a `challenges:changed` event updates the page.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `opus` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Capture Challenges loaded through `challenges-loaded` in both apps. Save `challenges.png`. Pass when the cross-engine policy passes.
- [ ] Lane 2. Challenges with the client offline. Save `challenges-offline.png`. Pass when the policy passes.
- [ ] Lane 3. Challenges with no capstone. Save `challenges-no-capstone.png`. Pass when the single-column grid passes.
- [ ] Lane 4. Challenges while loading. Save `challenges-loading.png`. Pass when the policy passes.
- [ ] Lane 5. Send `challenges:changed` from the fake client with a tier-up. Save `challenges-tier-up.png`. Pass when the card updates as in Electron.
- [ ] Lane 6. Disconnect the client with the page open. Save `challenges-disconnect.png`. Pass when it moves to offline as in Electron.
- [ ] Lane 7. Hover a challenge token. Save `challenge-token-hover.png`. Pass when the hover matches.
- [ ] Lane 8. Narrow the window to 900 px. Save `challenges-narrow.png`. Pass when the policy passes.
- [ ] Lane 9. Lane 1 on `windows-latest`. Save `win-challenges.png`. Pass when the Windows policy passes.
- [ ] Lane 10. Run the page on the real commands after T21. Save `challenges-real.png`. Pass when it equals lane 1, or record that T21 has not landed.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Time from the nav click to the category cards painted.
- [ ] Probe. Navigate 10 times per app alternately.
- [ ] Baseline. Record Electron's median first.
- [ ] Rule. Fail when Tauri's median is slower than Electron's by more than 10%.

**Review gate.** The operator reviews before merge.

- [ ] Copy the lane 1,2,5 screenshots into `parity/out/review/T30-review-<slug>.png`, with the side-by-side image for each.
- [ ] Record a 30 to 60 second video of the change on a lane machine. Save it as `parity/out/review/T30-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at STACK-READY. Wait for the operator's go before the unit lands.

**Merge.**

- [ ] Root's clean verdict at the exact tip SHA, recorded in `docs/tauri-port/units/<id>.md`.
- [ ] The branch sits on its parent's tip with the patch-id unchanged since the verdict.
- [ ] No GitHub pull request exists for the branch.
- [ ] The operator lands the chain bottom-up with `git merge --ff-only` into `main`.

## Port the Champions page (T31)

**Depends on.** T27.

**Files.**

- [ ] Create `tauri/src/pages/Champions.tsx`.

**Build.**

- [ ] Port `Champions.tsx` with the cycling sort headers, the filter menu for season, patch, queue, and minimum games, search, the expanded row with top augments, top items, and recent games, and the link to Match History with `location.state`.

**You see.**

- [ ] Champions passes the pixel diff against the Electron baseline in every state Appendix F lists.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `tauri/src/pages/Champions.test.tsx` asserts the row order for each sort state and that search uses `onInput` per keystroke.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `opus` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Capture Champions loaded in both apps. Save `champions.png`. Pass when the cross-engine policy passes.
- [ ] Lane 2. Cycle the sort on each header. Save `champions-sort.png`. Pass when each state passes.
- [ ] Lane 3. Open the filter menu. Save `champions-filter.png`. Pass when the policy passes.
- [ ] Lane 4. Type a search one key at a time. Save `champions-search.png`. Pass when the list narrows on each key as in Electron.
- [ ] Lane 5. Expand a row. Save `champions-expanded.png`. Pass when the policy passes.
- [ ] Lane 6. Click a recent game to go to Match History. Save `champions-to-history.png`. Pass when Match History opens filtered as in Electron.
- [ ] Lane 7. Champions while loading. Save `champions-loading.png`. Pass when the policy passes.
- [ ] Lane 8. Set minimum games to 50. Save `champions-min50.png`. Pass when the policy passes.
- [ ] Lane 9. Lane 1 on `windows-latest`. Save `win-champions.png`. Pass when the Windows policy passes.
- [ ] Lane 10. Reload with `remember_filters` on. Save `champions-remembered.png`. Pass when filters and sort survive as in Electron.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Time from the nav click to the table painted, and from a sort click to the new order painted.
- [ ] Probe. Navigate and sort 10 times per app alternately.
- [ ] Baseline. Record Electron's medians first.
- [ ] Rule. Fail when either Tauri median is slower than Electron's by more than 10%.

**Review gate.** The operator reviews before merge.

- [ ] Copy the lane 1,4,5,6 screenshots into `parity/out/review/T31-review-<slug>.png`, with the side-by-side image for each.
- [ ] Record a 30 to 60 second video of the change on a lane machine. Save it as `parity/out/review/T31-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at STACK-READY. Wait for the operator's go before the unit lands.

**Merge.**

- [ ] Root's clean verdict at the exact tip SHA, recorded in `docs/tauri-port/units/<id>.md`.
- [ ] The branch sits on its parent's tip with the patch-id unchanged since the verdict.
- [ ] No GitHub pull request exists for the branch.
- [ ] The operator lands the chain bottom-up with `git merge --ff-only` into `main`.

## Port the Friends, friend detail, and group detail pages (T32)

**Depends on.** T27.

**Files.**

- [ ] Create `tauri/src/pages/Friends.tsx`, `FriendDetail.tsx`, and `GroupDetail.tsx`.
- [ ] Create `tauri/src/components/SharedGameRow.tsx` and `BackToFriends.tsx`.

**Build.**

- [ ] Port the three pages with the players and groups views, the filter menu, both sorted tables, the champion grid with its measured "Show all", the sticky player heads with `backdrop-blur`, and the 2 to 5 member column layouts.
- [ ] Turn the `useLayoutEffect` and `ResizeObserver` measurement in `FriendDetail.tsx` into a Solid effect that measures after render, and check that the first frame matches Electron's.

**You see.**

- [ ] The three pages pass the pixel diff against the Electron baseline in every state Appendix F lists.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `tauri/src/pages/Friends.test.tsx`, `FriendDetail.test.tsx`, and `GroupDetail.test.tsx` assert loading, empty, and loaded text, and the encoded key in each link.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `opus` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Capture Friends players view in both apps. Save `friends.png`. Pass when the cross-engine policy passes.
- [ ] Lane 2. Friends groups view. Save `friends-groups.png`. Pass when the policy passes.
- [ ] Lane 3. Friend detail for the top friend. Save `friend-detail.png`. Pass when the policy passes.
- [ ] Lane 4. Click "Show all" on the champion grid. Save `friend-all-champions.png`. Pass when the policy passes.
- [ ] Lane 5. Group detail for a group of 5, scrolled so the player heads stick. Save `group-sticky.png`. Pass when the policy passes, with the blur region at threshold 0.2.
- [ ] Lane 6. Group detail for groups of 2, 3, and 4. Save `group-sizes.png`. Pass when each passes.
- [ ] Lane 7. A friend key that does not exist. Save `friend-missing.png`. Pass when the policy passes.
- [ ] Lane 8. Click a member chip. Save `member-chip.png`. Pass when it opens that friend as in Electron.
- [ ] Lane 9. Lanes 1 and 5 on `windows-latest`. Save `win-friends.png`. Pass when the Windows policy passes.
- [ ] Lane 10. Expand a shared game. Save `shared-game.png`. Pass when the policy passes.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Time from a row click to the detail page painted.
- [ ] Probe. Open the top friend and the top group 10 times per app alternately.
- [ ] Baseline. Record Electron's medians first.
- [ ] Rule. Fail when Tauri's median is slower than Electron's by more than 10%.

**Review gate.** The operator reviews before merge.

- [ ] Copy the lane 1,4,5,8 screenshots into `parity/out/review/T32-review-<slug>.png`, with the side-by-side image for each.
- [ ] Record a 30 to 60 second video of the change on a lane machine. Save it as `parity/out/review/T32-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at STACK-READY. Wait for the operator's go before the unit lands.

**Merge.**

- [ ] Root's clean verdict at the exact tip SHA, recorded in `docs/tauri-port/units/<id>.md`.
- [ ] The branch sits on its parent's tip with the patch-id unchanged since the verdict.
- [ ] No GitHub pull request exists for the branch.
- [ ] The operator lands the chain bottom-up with `git merge --ff-only` into `main`.

## Port Global Stats and the champion detail page (T33)

**Depends on.** T27.

**Files.**

- [ ] Create `tauri/src/pages/GlobalStats.tsx` and `tauri/src/pages/GlobalChampionDetail.tsx`.
- [ ] Create `tauri/src/hooks/useQueryFilters.ts`.

**Build.**

- [ ] Port both pages with the `?tab`, `?patch`, and `?queue` parameters, the leader cards, three tabs with their own search and the rarity filter, the splash header with its floating filter panel, and the back link that keeps the query.

**You see.**

- [ ] Both pages pass the pixel diff against the Electron baseline in every state Appendix F lists.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `tauri/src/hooks/useQueryFilters.test.ts` asserts reading and writing each parameter, and the page tests assert each tab's loaded text.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `opus` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Capture Global Stats champions tab in both apps. Save `global.png`. Pass when the cross-engine policy passes.
- [ ] Lane 2. The augments tab with Gold rarity. Save `global-augments.png`. Pass when the policy passes.
- [ ] Lane 3. The items tab with a search. Save `global-items.png`. Pass when the policy passes.
- [ ] Lane 4. Open a champion from the table. Save `champion-detail.png`. Pass when the splash header and stat cards pass.
- [ ] Lane 5. Champion detail for a champion with no games under the filter. Save `champion-detail-empty.png`. Pass when the policy passes.
- [ ] Lane 6. Use the back link. Save `back-link.png`. Pass when the query string is kept as in Electron.
- [ ] Lane 7. Open `#/global?tab=items&patch=16.22` directly. Save `global-deeplink.png`. Pass when the page opens on that tab and patch.
- [ ] Lane 8. Leader cards with too few games for best win rate. Save `leader-empty.png`. Pass when "No champion has enough games yet" shows.
- [ ] Lane 9. Lanes 1 and 4 on `windows-latest`. Save `win-global.png`. Pass when the Windows policy passes.
- [ ] Lane 10. Champion detail on the real commands after T14 and T22. Save `champion-detail-real.png`. Pass when it equals lane 4, or record that they have not landed.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Time from the nav click to the champions table painted, and from a tab click to the new table.
- [ ] Probe. Navigate and switch tabs 10 times per app alternately.
- [ ] Baseline. Record Electron's medians first.
- [ ] Rule. Fail when either Tauri median is slower than Electron's by more than 10%.

**Review gate.** The operator reviews before merge.

- [ ] Copy the lane 1,4,6 screenshots into `parity/out/review/T33-review-<slug>.png`, with the side-by-side image for each.
- [ ] Record a 30 to 60 second video of the change on a lane machine. Save it as `parity/out/review/T33-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at STACK-READY. Wait for the operator's go before the unit lands.

**Merge.**

- [ ] Root's clean verdict at the exact tip SHA, recorded in `docs/tauri-port/units/<id>.md`.
- [ ] The branch sits on its parent's tip with the patch-id unchanged since the verdict.
- [ ] No GitHub pull request exists for the branch.
- [ ] The operator lands the chain bottom-up with `git merge --ff-only` into `main`.

## Port the Live Game page (T34)

**Depends on.** T27.

**Files.**

- [ ] Create `tauri/src/pages/LiveGame.tsx`.
- [ ] Create `tauri/src/components/GameRecap.tsx`.

**Build.**

- [ ] Port the decision tree in `LiveGame.tsx`. That is loading, the loading screen, in game with the ticking clock, waiting for results with the optional earlier recap, standby offline, standby with the client status aside, no games ever, and the last game recap.
- [ ] Port `GameRecap.tsx`, all 720 lines, with the score hero, placements, challenge card, session strip, and streaks.
- [ ] Drive the clock from one signal updated by `setInterval` in `onSettled`, cleared in its cleanup, so the tick matches React's re-render rate.

**You see.**

- [ ] Live Game passes the pixel diff against the Electron baseline in every T03 state with the clock frozen.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `tauri/src/pages/LiveGame.test.tsx` feeds each recorded snapshot sequence and asserts which state renders after each, against the order Electron's goldens record.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `opus` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Capture `in-game` in both apps. Save `live.png`. Pass when the cross-engine policy passes.
- [ ] Lane 2. `in-game-loading`. Save `live-loading.png`. Pass when the policy passes.
- [ ] Lane 3. `results-late` while waiting. Save `live-waiting.png`. Pass when the policy passes.
- [ ] Lane 4. Standby with the client offline and a last game. Save `live-standby.png`. Pass when the policy passes.
- [ ] Lane 5. Standby with no games ever. Save `live-no-games.png`. Pass when the policy passes.
- [ ] Lane 6. The recap with three or more session games and a win streak. Save `recap-session.png`. Pass when the policy passes.
- [ ] Lane 7. The recap after the client gave up on results. Save `recap-gave-up.png`. Pass when the gave-up text shows.
- [ ] Lane 8. Let the clock run 10 s unfrozen. Save `live-clock.log`. Pass when the displayed time advances once per second as in Electron.
- [ ] Lane 9. Lanes 1 and 4 on `windows-latest`. Save `win-live.png`. Pass when the Windows policy passes.
- [ ] Lane 10. Click a player in the live scoreboard. Save `live-player-link.png`. Pass when it opens that friend as in Electron.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. CPU time over 60 s on the in-game page with the clock running.
- [ ] Probe. Run `in-game` 60 s per app, three times, alternating.
- [ ] Baseline. Record Electron's CPU time first.
- [ ] Rule. Fail when Tauri uses more CPU time than Electron.

**Review gate.** The operator reviews before merge.

- [ ] Copy the lane 1,3,4,6 screenshots into `parity/out/review/T34-review-<slug>.png`, with the side-by-side image for each.
- [ ] Record a 30 to 60 second video of the change on a lane machine. Save it as `parity/out/review/T34-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at STACK-READY. Wait for the operator's go before the unit lands.

**Merge.**

- [ ] Root's clean verdict at the exact tip SHA, recorded in `docs/tauri-port/units/<id>.md`.
- [ ] The branch sits on its parent's tip with the patch-id unchanged since the verdict.
- [ ] No GitHub pull request exists for the branch.
- [ ] The operator lands the chain bottom-up with `git merge --ff-only` into `main`.

## Port the Trends page (T35)

**Depends on.** T27.

**Files.**

- [ ] Create `tauri/src/pages/Trends.tsx`.

**Build.**

- [ ] Port `Trends.tsx`, all 1,105 lines, with the queue select, the month and week toggle and its default from the 120-day span, the hand-written SVG time series charts, and the hover tooltips.

**You see.**

- [ ] Trends passes the pixel diff against the Electron baseline loaded, empty, by month, by week, and with each chart's tooltip open.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `tauri/src/pages/Trends.test.tsx` asserts the default granularity for spans of 100 and 200 days, and the SVG path data for one chart against the React output on the same data.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `opus` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Capture Trends loaded in both apps. Save `trends.png`. Pass when the cross-engine policy passes.
- [ ] Lane 2. Trends by week. Save `trends-week.png`. Pass when the policy passes.
- [ ] Lane 3. Trends empty. Save `trends-empty.png`. Pass when the policy passes.
- [ ] Lane 4. Hover a point on the first chart. Save `trends-tooltip.png`. Pass when the tooltip text and position pass.
- [ ] Lane 5. Hover the last point on the last chart near the window edge. Save `trends-tooltip-edge.png`. Pass when the tooltip clamps as in Electron.
- [ ] Lane 6. Change the queue. Save `trends-queue.png`. Pass when the policy passes.
- [ ] Lane 7. Narrow the window to 900 px. Save `trends-narrow.png`. Pass when the policy passes.
- [ ] Lane 8. Compare SVG path strings for every chart in both apps. Save `trends-paths.log`. Pass when they are identical.
- [ ] Lane 9. Lane 1 on `windows-latest`. Save `win-trends.png`. Pass when the Windows policy passes.
- [ ] Lane 10. Reload with `remember_filters` on. Save `trends-remembered.png`. Pass when queue and granularity survive.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Time from the nav click to every chart painted.
- [ ] Probe. Navigate 10 times per app alternately.
- [ ] Baseline. Record Electron's median first.
- [ ] Rule. Fail when Tauri's median is slower than Electron's by more than 10%.

**Review gate.** The operator reviews before merge.

- [ ] Copy the lane 1,4,5 screenshots into `parity/out/review/T35-review-<slug>.png`, with the side-by-side image for each.
- [ ] Record a 30 to 60 second video of the change on a lane machine. Save it as `parity/out/review/T35-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at STACK-READY. Wait for the operator's go before the unit lands.

**Merge.**

- [ ] Root's clean verdict at the exact tip SHA, recorded in `docs/tauri-port/units/<id>.md`.
- [ ] The branch sits on its parent's tip with the patch-id unchanged since the verdict.
- [ ] No GitHub pull request exists for the branch.
- [ ] The operator lands the chain bottom-up with `git merge --ff-only` into `main`.

## Port the Settings page (T36)

**Depends on.** T27.

**Files.**

- [ ] Create `tauri/src/pages/Settings.tsx`.
- [ ] Create `tauri/src/components/SettingsIcons.tsx` only if T27 left it out.

**Build.**

- [ ] Port `Settings.tsx`, all 993 lines, with every section, the sticky section nav and its scroll spy at `xl`, the macOS and Windows copy, the unpackaged build copy, backups, export and import with progress, repair, backfill, and the about section with `v{version}`.
- [ ] Keep the page blank while settings load, as the React page returns `null`, using `<Show>`.

**You see.**

- [ ] Settings passes the pixel diff against the Electron baseline for every section on both platforms.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `tauri/src/pages/Settings.test.tsx` toggles each setting and asserts the `setSetting` call and value Electron's golden records.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `opus` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Capture Settings at the top in both apps on macOS. Save `settings-mac.png`. Pass when the cross-engine policy passes.
- [ ] Lane 2. Settings on `windows-latest`. Save `settings-win.png`. Pass when the Windows policy passes with the Windows copy.
- [ ] Lane 3. Scroll to each section at `xl` width. Save `settings-spy.png`. Pass when the active section in the nav matches Electron at each stop.
- [ ] Lane 4. The backups list with three backups. Save `settings-backups.png`. Pass when the policy passes.
- [ ] Lane 5. Toggle `minimize_to_tray`, then close the window. Save `settings-tray.log`. Pass when the close follows the new value.
- [ ] Lane 6. Toggle autostart. Save `settings-autostart.log`. Pass when the LaunchAgent appears and disappears, after T23.
- [ ] Lane 7. Start an import. Save `settings-import.png`. Pass when the progress state passes.
- [ ] Lane 8. Hide a nav link. Save `settings-hide-link.png`. Pass when the sidebar updates at once as in Electron.
- [ ] Lane 9. The unpackaged build. Save `settings-dev.png`. Pass when the dev copy shows as in Electron dev.
- [ ] Lane 10. The about section. Save `settings-about.png`. Pass when the version reads as Electron's does for the same version.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Time from the nav click to the first section painted.
- [ ] Probe. Navigate 10 times per app alternately.
- [ ] Baseline. Record Electron's median first.
- [ ] Rule. Fail when Tauri's median is slower than Electron's by more than 10%.

**Review gate.** The operator reviews before merge.

- [ ] Copy the lane 1,2,3,5 screenshots into `parity/out/review/T36-review-<slug>.png`, with the side-by-side image for each.
- [ ] Record a 30 to 60 second video of the change on a lane machine. Save it as `parity/out/review/T36-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at STACK-READY. Wait for the operator's go before the unit lands.

**Merge.**

- [ ] Root's clean verdict at the exact tip SHA, recorded in `docs/tauri-port/units/<id>.md`.
- [ ] The branch sits on its parent's tip with the patch-id unchanged since the verdict.
- [ ] No GitHub pull request exists for the branch.
- [ ] The operator lands the chain bottom-up with `git merge --ff-only` into `main`.

## Port the Match History page (T37)

**Depends on.** T27.

**Files.**

- [ ] Create `tauri/src/pages/MatchHistory.tsx`.
- [ ] Create `tauri/src/hooks/useMatches.ts` and `useExpandedMatch.ts` if T27 left them out.

**Build.**

- [ ] Port `MatchHistory.tsx`, all 1,340 lines. That covers the empty states, the dashboard header, session grouping, collapsed and expanded rows, favorites, the context menu with its clamped position, the filter menu with six fields and multikill chips, sort, the export pill, the augment grid with hover cards, and the `@container` breakpoint at 1080 px.
- [ ] Port infinite scroll with an `IntersectionObserver` created in `onSettled` and disconnected in its cleanup, with the same page size and sentinel offset.
- [ ] Render rows with `<For>` keyed by game id, so expanding a row does not rebuild the list.

**You see.**

- [ ] Match History passes the pixel diff against the Electron baseline in all 17 state groups Appendix F lists, on both platforms.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `tauri/src/pages/MatchHistory.test.tsx` asserts each empty state's text, that a second page loads when the sentinel intersects, and that expanding one row leaves the other row nodes in place.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `opus` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Capture Match History loaded in both apps. Save `mh.png`. Pass when the cross-engine policy passes.
- [ ] Lane 2. The four empty states. Save `mh-empty.png`. Pass when each passes.
- [ ] Lane 3. Sessions grouped by day and by week. Save `mh-sessions.png`. Pass when both pass.
- [ ] Lane 4. Expand a row. Save `mh-expanded.png`. Pass when the scoreboard passes, then hover a score cell and the breakdown passes.
- [ ] Lane 5. Right-click a row near the bottom right. Save `mh-context.png`. Pass when the clamped menu position matches Electron's.
- [ ] Lane 6. Open the filter menu with two accounts and press the triple kill chip. Save `mh-filter.png`. Pass when the policy passes and the list matches.
- [ ] Lane 7. Scroll to the end. Save `mh-scrolled.png`. Pass when every page loads and the last row matches Electron's.
- [ ] Lane 8. Narrow the window below 1080 px. Save `mh-narrow.png`. Pass when the container layout passes.
- [ ] Lane 9. Lanes 1 and 4 on `windows-latest`. Save `win-mh.png`. Pass when the Windows policy passes.
- [ ] Lane 10. Run `end-of-game` with the page open on the real commands. Save `mh-new-game.png`. Pass when the new row appears at the top as in Electron.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Launch to the first row painted, and time to render all 669 rows with "Load all".
- [ ] Probe. `bun parity/perf.ts --scenario first-rows --runs 10` and the load-all timer, interleaved with Electron.
- [ ] Baseline. Record Electron's medians first. The spike measured 0.52 to 0.67 s to first rows.
- [ ] Rule. Fail when either Tauri median is slower than Electron's.

**Review gate.** The operator reviews before merge.

- [ ] Copy the lane 1,4,5,6,8 screenshots into `parity/out/review/T37-review-<slug>.png`, with the side-by-side image for each.
- [ ] Record a 30 to 60 second video of the change on a lane machine. Save it as `parity/out/review/T37-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at STACK-READY. Wait for the operator's go before the unit lands.

**Merge.**

- [ ] Root's clean verdict at the exact tip SHA, recorded in `docs/tauri-port/units/<id>.md`.
- [ ] The branch sits on its parent's tip with the patch-id unchanged since the verdict.
- [ ] No GitHub pull request exists for the branch.
- [ ] The operator lands the chain bottom-up with `git merge --ff-only` into `main`.

## Port the dialogs, banners, and toasts (T38)

**Depends on.** T27.

**Files.**

- [ ] Create `tauri/src/components/UpdateDialog.tsx`, `WhatsNewDialog.tsx`, `RecoveryBanner.tsx`, and `ActivityToast.tsx`.
- [ ] Edit `tauri/src/components/Header.tsx` and `Layout.tsx` to mount them, the one change this unit makes to T27's files.

**Build.**

- [ ] Port `UpdateDialog.tsx` in its manual, downloading, launch-install, and error variants, with the keyed remount on install.
- [ ] Port `WhatsNewDialog.tsx` for one release and for several.
- [ ] Port `RecoveryBanner.tsx` in its 8 variants, and `ActivityToast.tsx` with the running bar and the done, cancelled, and error results that hide after 10 s.
- [ ] Keep `DialogFrame`'s focus trap and Escape handling from T27.

**You see.**

- [ ] Every overlay state from T04 passes the pixel diff against the Electron baseline, with blur regions at threshold 0.2.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `tauri/src/components/UpdateDialog.test.tsx` and `ActivityToast.test.tsx` assert each variant's text and that the toast hides after 10 s on a fake timer.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `opus` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Capture the Update dialog manual variant in both apps. Save `update-dialog.png`. Pass when the cross-engine policy passes.
- [ ] Lane 2. The downloading variant at 40%. Save `update-downloading.png`. Pass when the policy passes.
- [ ] Lane 3. What's New with three releases. Save `whats-new.png`. Pass when the policy passes.
- [ ] Lane 4. Each recovery banner variant. Save `recovery-banners.png`. Pass when each passes.
- [ ] Lane 5. The backfill toast running, then done. Save `toast.png`. Pass when both pass and it hides after 10 s.
- [ ] Lane 6. Press Tab through an open dialog. Save `dialog-focus.log`. Pass when focus cycles inside it as in Electron.
- [ ] Lane 7. Press Escape. Save `dialog-esc.png`. Pass when the dialog closes and focus returns.
- [ ] Lane 8. Dismiss the recovery banner and reload. Save `banner-dismissed.png`. Pass when it stays dismissed as in Electron.
- [ ] Lane 9. Lanes 1 and 4 on `windows-latest`. Save `win-dialogs.png`. Pass when the Windows policy passes.
- [ ] Lane 10. Show the Update dialog and the import toast at once. Save `stacked-overlays.png`. Pass when the stacking order matches Electron's.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Time from the trigger to the dialog painted.
- [ ] Probe. Open and close the Update dialog 10 times per app alternately.
- [ ] Baseline. Record Electron's median first.
- [ ] Rule. Fail when Tauri's median is slower than Electron's by more than 10%.

**Review gate.** The operator reviews before merge.

- [ ] Copy the lane 1,3,4,5 screenshots into `parity/out/review/T38-review-<slug>.png`, with the side-by-side image for each.
- [ ] Record a 30 to 60 second video of the change on a lane machine. Save it as `parity/out/review/T38-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at STACK-READY. Wait for the operator's go before the unit lands.

**Merge.**

- [ ] Root's clean verdict at the exact tip SHA, recorded in `docs/tauri-port/units/<id>.md`.
- [ ] The branch sits on its parent's tip with the patch-id unchanged since the verdict.
- [ ] No GitHub pull request exists for the branch.
- [ ] The operator lands the chain bottom-up with `git merge --ff-only` into `main`.

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

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `tauri/scripts/package.test.ts` asserts the asset names for each platform and arch, and that each zip holds exactly one top-level `.app`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `opus` at the PR head, per the boot recipe.

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

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Download size of each asset and installed size, against the 1.2.1 assets.
- [ ] Probe. `gh release view` on both releases, and `du -sk` on each installed app.
- [ ] Baseline. The T06 sizes for 1.2.1.
- [ ] Rule. Fail when any Tauri asset exceeds 15% of the matching Electron asset.

**Review gate.** The operator reviews before merge.

- [ ] Copy the lane 2,3,6,7 screenshots into `parity/out/review/T39-review-<slug>.png`, with the side-by-side image for each.
- [ ] Record a 30 to 60 second video of the change on a lane machine. Save it as `parity/out/review/T39-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at STACK-READY. Wait for the operator's go before the unit lands.

**Merge.**

- [ ] Root's clean verdict at the exact tip SHA, recorded in `docs/tauri-port/units/<id>.md`.
- [ ] The branch sits on its parent's tip with the patch-id unchanged since the verdict.
- [ ] No GitHub pull request exists for the branch.
- [ ] The operator lands the chain bottom-up with `git merge --ff-only` into `main`.

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

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `parity/test/report.test.ts` feeds a recorded run with one failing state and asserts the report marks the run failed and names the state.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `opus` at the PR head, per the boot recipe.

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

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Download size, installed size, idle memory across all processes, and launch to first content, Electron 1.2.1 against the Tauri build, on macOS arm64 and Windows x64.
- [ ] Probe. `bun parity/perf.ts --app electron-1.2.1 --app tauri --runs 10`, interleaved with a cold start before each pair, per `skills/benchmark-checklist/SKILL.md`.
- [ ] Baseline. The T06 numbers, measured again in this run before the Tauri runs.
- [ ] Rule. Fail when Tauri is worse than Electron on any of the four metrics on either platform.

**Review gate.** None. T40 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact tip SHA, recorded in `docs/tauri-port/units/<id>.md`.
- [ ] The branch sits on its parent's tip with the patch-id unchanged since the verdict.
- [ ] No GitHub pull request exists for the branch.
- [ ] The operator lands the chain bottom-up with `git merge --ff-only` into `main`.

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

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `bun test` at the root runs the `tauri/` and `parity/` tests, and `cargo test` runs the Rust tests. Both pass.
- [ ] `rg -l "electron|react" --glob '!parity/**' --glob '!docs/**'` prints nothing.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `opus` at the PR head, per the boot recipe.

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

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. The four T40 metrics on the release artifacts that `release.yml` builds.
- [ ] Probe. `bun parity/perf.ts --app electron-1.2.1 --app release-head --runs 10` on both platforms.
- [ ] Baseline. The T40 Tauri numbers.
- [ ] Rule. Fail when any metric is worse than T40's by more than its measured spread.

**Review gate.** The operator reviews before merge.

- [ ] Copy the lane 2,3,7 screenshots into `parity/out/review/T41-review-<slug>.png`, with the side-by-side image for each.
- [ ] Record a 30 to 60 second video of the change on a lane machine. Save it as `parity/out/review/T41-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at STACK-READY. Wait for the operator's go before the unit lands.

**Merge.**

- [ ] Root's clean verdict at the exact tip SHA, recorded in `docs/tauri-port/units/<id>.md`.
- [ ] The branch sits on its parent's tip with the patch-id unchanged since the verdict.
- [ ] No GitHub pull request exists for the branch.
- [ ] The operator lands the chain bottom-up with `git merge --ff-only` into `main`.

## Close the program

- [ ] Every box above is checked with its evidence.
- [ ] `docs/tauri-port/parity-report.md` is on trunk with every state `PASS`, 61 of 61 goldens passing, and the before and after numbers.
- [ ] Reply to the operator with the report the execution playbook names, per the ketchup skill, with the root and tip branch names and SHAs and a one-line verdict per unit.

## Appendix A. Prototype evidence

Every prototype ran on the operator's Mac (macOS 27.2, Apple silicon) on 2026-11-22 from branch `tauri-solid-spike` at `d3f2ed0`. None was committed. Each one's files, logs, and images are copied into `docs/tauri-port/evidence/`, which git ignores because some images hold the operator's own match data. Windows was not run in any prototype.

### The spike measured the size and memory gap

The spike at `d3f2ed0` measured 3.9 MB for the `.dmg` against 110 MB, 6.3 MB installed against 245 MB, about 120 MB of memory against about 328 MB, and 0.52 to 0.67 s from launch to first rows. Query times were the same in both, 0.47 ms against 0.44 ms for a 50-game page. The Electron memory number came from a 4-hour-old process, so T06 measures it again under the same conditions as Tauri.

### Tauri 3.0 alpha has every plugin this app needs

Evidence is in `evidence/proto-tauri3/`. `tauri` 3.0.0-alpha.6 with `tauri-runtime-wry` 3.0.0-alpha.6 built and ran a test app with every feature below. Each plugin is on crates.io at 3.0.0-alpha.3 or alpha.4 with a `tauri ^3.0.0-alpha.4` requirement, so no git pins are needed.

- Tray with `Show Window`, a separator, and `Quit` works. Tauri has no tray double-click event on macOS, so T04 records what Electron does there.
- `tauri-plugin-single-instance` works. A second launch exits 0 and the first window shows.
- `tauri-plugin-autostart` works but names the LaunchAgent after the product, not `com.better-mayhem-tracker.app.autostart.plist`. That is why T23 ports `autostart.ts` directly.
- `tauri-plugin-dialog`, `tauri-plugin-opener`, `tauri-plugin-updater` (compiled only), and relaunch work.
- A custom `asset` scheme served PNG files, and it takes the name over Tauri's built-in one when `protocol-asset` is off.
- Electron's traffic lights at `{x:16, y:15}` match Tauri's at `{x:16, y:24}`, because tao sizes the title bar container differently. The prototype measured this with in-process window probes.
- The changes from Tauri 2 to 3 that matter here are the explicit runtime, generic runtime types in place of `tauri::Wry`, the `devtools` feature moving to `tauri-runtime-wry`, and a few plugin renames. Global shortcuts are not used anywhere in `src/main`.
- The prototype agent recommended building on 2.12.7 because 3.0 is alpha. The operator's version rule and the plugin check both point to 3.0 alpha, so this plan takes it. The fallback to 2.12.7 costs one runtime line, one rename, and Cargo features.

### Rustls verifies the League client with only the Riot root pinned

Evidence is in `evidence/proto-tls/`. The running League client's leaf certificate is `CN=rclient`, X.509 v3, valid from 2026 to 2125, with SAN `DNS:localhost` and `IP:127.0.0.1`. It is issued by the Riot root, which is byte-identical to `RIOT_ROOT_CA` in `src/main/lockfile.ts`. The 100-year lifetime is the likely reason macOS's stack refused it (inferred).

- The stock rustls 0.23.46 webpki verifier with only that root, hostname checks on, accepted HTTPS (`GET /lol-summoner/v1/current-summoner` returned 200) and the WebSocket (101, then 49 event frames in 10 s). That is VERIFIED.
- It rejected a self-signed localhost certificate (`CaUsedAsEndEntity`), a self-signed leaf (`UnknownIssuer`), and an impostor CA with Riot's exact subject name (`UnknownIssuer`).
- Only GET requests and one subscribe frame were sent. The password was never printed.

### A native webview snapshot reproduces Electron's card export

Evidence is in `evidence/proto-export/`. Electron renders the card at 1200 CSS px with page zoom 1.5 and captures 1800 px wide in about 715 ms.

| Method | Diff against Electron | Time per image | Hidden window |
| --- | --- | --- | --- |
| WKWebView `takeSnapshotWithConfiguration` with device scale 1.5 | 1.56% | 165 ms capture, 1.2 s end to end hidden | works, 0 px diff from visible |
| The same with public API only | 7.35%, rows shift 7.5 px | 158 ms | works |
| WKWebView `pageZoom` 0.75 | 11.23%, container queries break | 168 ms | works |
| `modern-screenshot` 4.7.0 | 3.90% to 7.78%, wrong glow and ring | 0.9 s to 24.7 s | not run |
| `html-to-image` 1.11.13 | 7.88%, same defects | 1.1 s | not run |

About 40% of the 1.56% is the champion portraits, because system WKWebView ignores `object-view-box`. T27 fixes that for the whole app. WebView2 has `CallDevToolsProtocolMethod` and `SetZoomFactor` in `webview2-com` 0.39.1, so T25 uses `Page.captureScreenshot` there. That is unproven until T25 runs on Windows.

### The Electron baseline is deterministic, and engines differ by a measured amount

Evidence is in `evidence/proto-baseline/`. Electron ran through Playwright's `_electron.launch` with a `-r` seam, a snapshot user-data folder, frozen clocks, blocked network, and the League paths hidden, with no change to app code.

- Four Electron runs of the same three states differed by at most 11 pixels by one color level, a fixed set that flips between two states. At pixelmatch `threshold` 0.03 every pair was 0. WKWebView was 0 across runs.
- Turning off the GPU made runs less stable, 74 px. Lanes keep the GPU on.
- `NODE_OPTIONS=--require` did not load through `_electron.launch`. The `-r` argument did.

| Pair, Match History | Strict, threshold 0 | Tolerant, threshold 0.1, no AA |
| --- | --- | --- |
| Electron (sRGB) and WKWebView | 48.77% | 0.515% |
| The same with portraits masked | 48.0% | 0.197%, worst 64 px tile 2.78% |
| Playwright WebKit and WKWebView | 3.74% | 0.302%, all portraits |
| Electron and headless Playwright Chromium | 21.39% | 1.626% |

- Layout matched closely. Of 1,569 element boxes, 1,325 were identical, 244 moved at most 0.5 CSS px, and none moved more than 1 px.
- Backdrop blur is missing from WebKit snapshots, likely because CoreAnimation composites it outside the snapshot (inferred, not checked on screen).
- Playwright WebKit and headless Chromium are not valid stand-ins for WKWebView or Electron. Lanes capture from the real Electron app and the real Tauri webview only.

The diff policy every lane uses comes from these numbers.

- Same engine is pixelmatch `threshold` 0.03, `includeAA` on, zero differing pixels.
- Cross engine is the layout gate, then the pixel gate. The layout gate needs the same element count and every box within 1 CSS px. The pixel gate is pixelmatch `threshold` 0.1, `includeAA` off, at most 0.3% of the page, and no 64 by 64 CSS px tile above 8%.
- Declared blur regions use the tile rule at threshold 0.2.
- Masks need a reason the operator accepts. The `object-view-box` portraits are fixed, not masked.
- Windows WebView2 against Electron is Chromium against Chromium of a different version. T07 measures it and decision E1 sets its policy.

### Oxlint runs eslint-plugin-solid

Evidence is in `evidence/proto-oxlint/`. Oxlint 1.94.0 with `jsPlugins` loading `eslint-plugin-solid` 0.20.1 and `settings.solid.version` 2 reported `solid(reactivity)` and `solid(no-destructure)` on test files and exited 1, and passed the spike's `App.tsx`. It does not flag `onChange` on inputs, so T01 adds a local rule.

### Ts-rs fits the existing types better than tauri-specta

Evidence is in `evidence/proto-specta-ls/`. `tauri-specta` main at `f7ec9b0` fails to build on Tauri 3.0.0-alpha.6 for lack of `tauri::ipc::CommandMetadata`, which only an unreleased Tauri has. The last rev that builds is `7959c97`, and newer revs cannot be taken until Tauri ships that change. At `7959c97`, every `i64` needs a per-field override to export as `number`, `f64` exports as `number | null`, and every struct splits into `_Serialize` and `_Deserialize` types. `ts-rs` 12.0.1 built at once, maps every `i64` to `number` with one setting, keeps `f64` as `number`, and has no split. It writes no command wrappers, so T08 generates those from the Rust registry.

### Electron's localStorage can be read and carried over

Evidence is in `evidence/proto-specta-ls/q2/`. `rusty-leveldb` 4.0.2 read a copy of a store written by Electron 44.4.5 with `loadFile`. Keys are `_file://`, a zero byte, an encoding byte, and the key. Values start with `0x00` for UTF-16LE or `0x01` for latin1. The operator's real store held no app keys when copied, so the import matters only for players who have them.

### What stays unproven

- Every Windows behavior. That covers the frameless title bar, `http://asset.localhost` URLs, WebView2 capture, the exe swap, the Run value, the Start Menu link, and memory attribution. T02, T07, T10, T22 to T25, and T39 prove each one on `windows-latest`.
- The WebView2 against Electron pixel policy, measured in T07.
- Whether port 2999 verifies with the Riot root, tested in T21 during a real game.
- Memory attribution of WebKit's XPC processes to the app, built and cross-checked in T06.
- The Electron 1.2.1 to Tauri update on a real install, proven in T24 and again in T39 and T41.

## Appendix B. Alternatives rejected

- **Tauri 2.12.7 now and 3.0 later.** Lower risk and the prototype agent's pick. Rejected because the operator's rule takes the newest prerelease once every plugin has a matching release, and all of them do. The fallback stays cheap, as Appendix A shows.
- **A React to Solid converter.** No maintained converter supports Solid 2, and the operator ruled out `react2solid` and `solid-reactor`. T27 instead adds `react-isms.ts`, which fails the build on any leftover React pattern.
- **Running the React UI inside Tauri and porting only the backend.** It would pass the pixel diff sooner but keep React. The operator asked for Solid 2. The plan still uses the React renderer inside Tauri as a check for backend units before the Solid pages land.
- **`tauri-plugin-updater`.** It needs a minisign key in CI, a `latest.json` manifest, and a different install flow. That would not behave like 1.2.1, and the 1.2.1 updater could not install into it. Decision E6.
- **`tauri-plugin-autostart`.** It writes a differently named LaunchAgent, so updated players would get two login entries. Decision E7.
- **DOM rasterizing for card export.** Slower and visibly wrong in WebKit, per Appendix A.
- **Rendering cards in Rust.** No pixel parity and a second copy of 1,600 lines of layout to keep in step.
- **Playwright WebKit as the macOS stand-in.** It applies `object-view-box`, which the system WKWebView ignores, so it hides the largest real difference.
- **Committing baselines made from the operator's real data.** The repository is public and the data names friends. Lanes use the anonymized fixture. Decision E2.
- **rustls 0.24.0-dev.3.** It is newer than 0.23.46, but `reqwest` 0.13.5 and `tokio-tungstenite` 0.30.0 need 0.23, so it would add an unused second copy. Decision E4.
- **An NSIS or MSI installer on Windows.** It would change the data folder habits, autostart path, Start Menu link, and the updater's swap, and 1.2.1 could not install it. The raw Tauri exe runs in place, as the portable exe appears to.

## Appendix C. Risks

- **Tauri 3 alpha moves.** Seven alphas in two months, with breaking changes in three of them. T01 pins every crate and package exactly. An owner who needs a newer alpha cuts its own unit and runs every golden and baseline again. Watch it in every backend PR.
- **The private WebKit call in card export can disappear in a macOS release.** T25 checks `respondsToSelector` and falls back to the public path at 7.35% diff. Watch it in T25 and T40.
- **The traffic light offset depends on AppKit's 9 pt inset.** T10 checks it by pixel diff, and T40 checks it again on the newest macOS.
- **WebView2 may be missing on some Windows machines.** Electron's portable exe had no such dependency. T39 handles it per decision E8.
- **Players may roll back to 1.2.1.** The database stays at `user_version` 4 with the same DDL, so Electron opens it. T11 lane 2 proves it.
- **Two copies of the app could open the same database.** Electron and Tauri hold separate single-instance locks. After the update only Tauri exists, so this matters only in lanes, which use snapshots.
- **No `control-ui` skill exists in Claude Code.** Lanes drive Electron with Playwright and Tauri with the parity driver. T07 builds and tests the driver, and T07 and T19 fail release builds that contain the driver or the fake CA.
- **Screen Recording permission is missing on the operator's Mac.** The prototypes had none. Lanes use in-process snapshots, and the review videos are frame sequences until the operator grants it. The Arm the program checklist asks.
- **Float order in Rust ports.** Scores and stats computed in JavaScript must sum in the same order. T12 and T14 compare every value against goldens exactly.
- **Playwright 1.66.0-alpha-2026-11-22 was published the day of this plan.** If it breaks `_electron.launch`, T02 drops to 1.65.1 and records the waiver.
- **Vite 8.4 beta is outside two plugins' peer ranges.** T01 sets `overrides` and checks the build. If the build breaks, T01 drops to the newest 8.3 and records the waiver.
- **Hidden capture windows throttle page timers.** The prototype saw readiness slow from 376 ms to about 900 ms when hidden. T25 measures it and tries an off-screen visible window.
- **The fixture may not cover every state.** T02 to T04 add synthetic games for empty, remake, and multi-account states, and T40 lists any state with no baseline.

## Appendix D. Links and reading list

Read before editing.

- `tauri/node_modules/solid-js/skills/solid-2.0`, `solid-2.0-cheatsheet`, and `reactivity-diagnostics`, and https://docs.solidjs.com/migration/from-react/. Required before T27 to T38.
- `docs/tauri-port/evidence/inventory-main.md` for every channel, job, timer, and constant in the main process, with line numbers.
- `docs/tauri-port/evidence/inventory-renderer.md` for routes, states, components, and the React patterns to remove.
- `docs/tauri-port/evidence/inventory-release.md` for the release flow, the updater, data paths, autostart, and shortcuts.
- `docs/tauri-port/evidence/versions.md` for the registry check behind every pin.
- `tauri-spike/README.md` at `d3f2ed0` for the spike's numbers and shortcuts.

Run `skills/how/SKILL.md` before T07, T08, T19, T24, and T25. Run `skills/interrogate/SKILL.md` on T08's contract design, T24's update hand-off, and T25's capture method before they ship. Keep the decision trail per `skills/show-me-your-work/SKILL.md` in `docs/tauri-port/trail.md` and commit it with T40.

These are the pins T01 applies, checked against the registries on 2026-11-22. Rerun `bun run deps:report` when each unit is cut.

| Package | Pin | Why |
| --- | --- | --- |
| `tauri`, `tauri-runtime-wry` | 3.0.0-alpha.6 | newest prerelease |
| `tauri-build` | 3.0.0-alpha.4 | newest 3.x |
| `@tauri-apps/cli` | 3.0.0-alpha.6 | `next` is newer than `latest` |
| `@tauri-apps/api` | 3.0.0-alpha.3 | `next` is newer than `latest` |
| Tauri plugins (single-instance, dialog, opener, clipboard-manager, process) | 3.0.0-alpha.3, dialog alpha.4 | built on `tauri ^3.0.0-alpha.4` |
| `solid-js`, `@solidjs/web` | 2.0.3 | `next` is an older rc |
| `@solidjs/router` | 2.0.1 | `next` is older |
| `@solidjs/vite-plugin`, `@solidjs/babel-plugin` | 3.0.1, 2.0.2 | latest |
| `vite` | 8.4.0-beta.1 | newest prerelease |
| `typescript` | 7.1.0-dev.20261121.1 | newest prerelease |
| `tailwindcss`, `@tailwindcss/vite` | 4.3.5 | `insiders` is `0.0.0-*` |
| `oxlint`, `oxfmt` | 1.94.0, 0.79.0 | latest |
| `eslint-plugin-solid` | 0.20.1 | supports Solid 2 |
| `playwright` | 1.66.0-alpha-2026-11-22 | newest prerelease, see Appendix C |
| `pixelmatch`, `pngjs` | 8.0.0, 7.0.0 | latest |
| `ts-rs` | 12.0.1 | decision E5 |
| `rusqlite` | 0.43.0 with `bundled` and `backup` | latest |
| `reqwest` | 0.13.5 with `rustls-no-provider` | latest |
| `rustls` | 0.23.46 with `ring` | decision E4 |
| `tokio-tungstenite` | 0.30.0 | latest |
| `rusty-leveldb` | 4.0.2 | latest |
| Rust | `nightly-2026-11-23` | newest with `clippy` and `rustfmt` on both targets |
| bun | canary, 1.4.6-canary.1 locally | `bun upgrade --canary` |

## Appendix E. Decisions for the operator

Each decision has a default this plan applies until the operator says otherwise.

- **E1. What a passing pixel diff means.** Zero differing pixels between Electron's Chromium and the Tauri WKWebView is impossible. About 48% of pixels differ at threshold 0 from font rasterizing alone, while layout stays within 1 CSS px. The default is the cross-engine policy in Appendix A for macOS, and the same policy on Windows until T07 measures WebView2, then the tightest policy two Windows runs pass. The operator can ask for a stricter or looser budget, or for a person to sign off per page in place of the numbers.
- **E2. Where baselines and fixtures live.** The default is to commit only the tools and the anonymized fixture after the operator reads it, and to keep baselines made from real data under the gitignored `parity/out/`. The operator can choose to commit nothing and keep the fixture as a private CI artifact, or to commit the baseline images too.
- **E3. Tauri 3.0 alpha.** Applied per the operator's rule, since every plugin has a matching release. The operator can switch the program to 2.12.7.
- **E4. rustls 0.23.46 instead of 0.24.0-dev.3.** The newer one would sit unused beside the 0.23 that `reqwest` and `tokio-tungstenite` need. The default waives the prerelease rule for this crate. The operator can refuse the waiver.
- **E5. ts-rs instead of tauri-specta.** `tauri-specta`'s only rev that builds on Tauri 3 alpha is `7959c97`, newer revs need an unreleased Tauri, and its output differs from `api.ts`. The default is `ts-rs` 12.0.1 for types and a generated invoke wrapper per command. The operator can choose `tauri-specta` at `7959c97` with per-field overrides.
- **E6. Port the custom updater instead of using the Tauri plugin.** The default keeps the GitHub release flow, the asset names, and no signing key, and it is the only way 1.2.1 installs update into Tauri. The operator can choose the plugin after the hand-off release, which needs a minisign key in CI secrets.
- **E7. Port autostart directly instead of using the plugin.** The default keeps the existing LaunchAgent and Run value names, so no player gets a duplicate entry. The operator can choose the plugin with a one-time cleanup of the old entry.
- **E8. Windows without WebView2.** The default shows a message with Microsoft's download link and exits. The operator can choose a fixed-version WebView2 runtime in the download, which adds about 180 MB, or a bootstrapper that downloads it.
- **E9. The private WebKit call for card export.** The default uses `_setOverrideDeviceScaleFactor:` behind a `respondsToSelector` check for a 1.56% diff, with the public path as fallback at 7.35%. The app ships ad hoc signed outside the App Store, so no review rejects it. The same holds for the devtools toggle in release builds, which uses a private macOS API in Tauri. The operator can require the public path only, or devtools in debug builds only.

## Appendix F. States and keys reference

The full state list, about 130 states with their trigger and data, is in `docs/tauri-port/evidence/inventory-renderer.md` section 2. T02 to T04 turn it into rows of `parity/states.ts`. The groups are the layout and header (14 states), Match History (17 state groups), Live Game (9), Champions, Augments, Trends, Global Stats, champion detail, Friends, friend detail, group detail, Records, Season Recap, Challenges, Settings, shared overlays, and the two card routes.

Shared components in order of migration, from that inventory's section 4.

- Tier 0 has `icons`, `SettingsIcons`, `BrandMark`, `Kda`, `MultikillBadge`, `PageHeader`, `StatCard`, `RiotId`, `RiotText`, `HoverCard`, `SearchInput`, `RarityFilter`, `ScoreCell`, `StatBars`, `WinRateBar`, `Markdown`, and `ActivityCalendar`, plus `lib/` and the hooks.
- Tier 1 has `ChampionIcon`, `SummonerIcon`, `SummonerSpellIcon`, `ChallengeToken`, `ItemIcon`, `AugmentIcon`, `FilterMenu`, `SortHeader`, `DialogFrame`, and `ReleaseNotes`.
- Tier 2 has the selects, `MinGamesFilter`, `ExportImage`, `SharedStats`, `RecordCard`, the dialogs, `RecoveryBanner`, and `ActivityToast`.
- Tier 3 has `MatchScoreboard` and `LiveScoreboard`. Tier 4 has `GameRecap`, `SharedGameRow`, `SeasonRecapCard`, and `Header`.

These are the localStorage keys T26 carries over. `recap-badge-seen` holds a raw season id. Every other key holds JSON and starts with `view:`.

- Match History uses `view:matches.` with `champion`, `season`, `patch`, `queue`, `account`, `multikills`, `sort`, `sortDir`, and `favorites`.
- Champions uses `view:champions.` with `patch`, `queue`, `season`, `search`, `minGames`, `sortKey`, and `sortDir`.
- Friends uses `view:friends.` with `season`, `view`, `search`, `minGames`, `groupSize`, `sortKey`, and `sortDir`, plus `view:friends.groups.sortKey` and `.sortDir`.
- Augments uses `view:augments.` with `patch`, `queue`, `season`, `search`, `minPicks`, `rarity`, `sortKey`, and `sortDir`.
- Global Stats uses `view:global.` with `params`, `champSearch`, `augSearch`, `augRarity`, and `itemSearch`, plus `view:global.champ`, `view:global.aug`, and `view:global.item`, each with `.sortKey` and `.sortDir`.
- Champion detail uses `view:globalChampion.augRarity`, plus `view:globalChampion.items` and `view:globalChampion.augments`, each with `.sortKey` and `.sortDir`.
- Season Recap uses `view:season.` with `id`, `queue`, `account`, and `hideFriends`. Trends uses `view:trends.queue` and `.granularity`. Records uses `view:records.queue` and `.account`.
