# parity

Tools that capture the Electron 1.2.1 baseline and compare the Tauri port against it. Everything runs under bun. Nothing here edits `src/` or opens the installed app's data folder for writing.

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

| Command                                                                                                                                                  | What it does                                                                                                                                                                |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun parity/snapshot.ts --out parity/snapshots/private`                                                                                                  | Private copy of the real data (database, caches, asset cache).                                                                                                              |
| `bun parity/snapshot.ts --out <folder> --verify <log>`                                                                                                   | The same snapshot, with a sha256 and mtime of every app-owned file in the real folder before and after, written to `<log>` (lane 2).                                        |
| `bun parity/fixture.ts --out parity/snapshots/fixture`                                                                                                   | Anonymized fixture from the private snapshot. Add `--from <snapshot>` for another source.                                                                                   |
| `bun parity/audit.ts --fixture parity/snapshots/fixture --snapshot parity/snapshots/private`                                                             | Fails when a real name or PUUID survives in the fixture.                                                                                                                    |
| `bun parity/capture.ts --app electron --data fixture --all`                                                                                              | One PNG, one `.geometry.json`, one `.meta.json` per state in `parity/out/baseline/electron-mac/` (`electron-win/` on Windows), plus `timing.json` and `seam.log`.           |
| `bun parity/capture.ts --app electron --data fixture --states rail,champions-expanded`                                                                   | A subset, by group or state id.                                                                                                                                             |
| `bun parity/run-electron.ts --data fixture --state match-history-default`                                                                                | Starts the app in one state, prints `ready run=<folder> control=...`, and waits for input.                                                                                  |
| `bun parity/drive.ts --run <folder> click "button.group" `                                                                                               | Delivers `click`, `hover`, `type`, `key`, `scroll`, `resize`, `navigate`, `wait`, `waitFor`, `settle`, `shot`, `dom`, `geometry`, or `quit` to a running `run-electron.ts`. |
| `bun parity/diff.ts <trunk.png> <head.png> [--policy same-engine\|cross-engine] [--geometry <trunk.json> <head.json>] [--blur x,y,w,h] [--out <prefix>]` | Prints `PASS` or `FAIL`, writes `<prefix>.diff.png` and `<prefix>.side-by-side.png` (trunk, head, diff).                                                                    |
| `bun parity/determinism.ts <run folder> <run folder>`                                                                                                    | Compares every state two capture runs share under the same-engine policy.                                                                                                   |
| `bun test`, `bun run lint`, `bun run fmt:check`                                                                                                          | Unit tests, Bun's linter and formatter.                                                                                                                                     |

`--data` takes `fixture`, `snapshot`, `empty`, or a folder holding `data/matches.db`. The app runs on a copy inside the run folder, so the source is never changed. `empty` starts the app on an empty data folder, as on a fresh install, and states marked `data: "empty"` in `states.ts` always run on it.

## Policies (Appendix A)

- Same engine: pixelmatch `threshold` 0.03, `includeAA` on, zero differing pixels.
- Cross engine: the layout gate (same element count, every box within 1 CSS px), then pixelmatch `threshold` 0.1, `includeAA` off, at most 0.3% of the page, and no 64 by 64 CSS px tile above 8%. A declared blur region is judged by the tile rule at threshold 0.2 and left out of the page count.

## Determinism

`run-electron.ts` passes `--force-device-scale-factor=2`, `--force-color-profile=srgb`, `--lang=en-US`, `TZ=America/New_York`, freezes the renderer clock with `context.clock.setFixedTime` and the main-process clock in the seam, aborts renderer `http` and `https`, and blocks main-process network except loopback. `settle.ts` waits for fonts, decoded images, a client status past "Connecting...", and 1.2 s of unchanged DOM, then kills animation and parks the mouse. Each state starts from cleared `localStorage` and a reload, and restores any setting it changed.

## Windows

`.github/workflows/parity.yml` runs the baseline on `windows-latest` once the anonymized fixture is committed under `parity/snapshots/fixture` (decision E2). Until then the Windows job skips with a notice, and lane 9 stays open. Nothing publishes the fixture as an artifact.

Electron runs with `--disable-gpu` by default, because GPU compositing repeats less between runs (waiver W1). `PARITY_GPU=on` turns the GPU back on, and any other value but `off` is an error. `PARITY_ELECTRON_ARGS` adds Chromium flags, such as `--disable-renderer-backgrounding`. `SEAM_DOCK=show` keeps the Dock icon for a comparison run.

Every spawning command runs under `lib/capped.sh <headroom>`, which caps processes at the user's current count plus the headroom and exits 99 if anything was refused a process. `bun run test` and `bun run capture` use a headroom of 200. A bare `ulimit -u 200` would refuse the first fork on macOS, which counts every process the user owns.

## Known limits

- `bun lint --flavor eslint` is what lints parity. Without the flavor, Bun walks up to the root `.oxlintrc.json`, whose ignore patterns name `parity`, and lints nothing.
- Client-dependent states, overlays, and menus belong to T03 and T04.
