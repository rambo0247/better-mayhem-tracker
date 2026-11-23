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
