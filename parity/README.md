# parity

Tools that capture the Electron 1.2.1 baseline and compare the Tauri port against it. Everything runs under bun. Nothing here edits `src/` or opens the installed app's data folder for writing.

## The data rule

The installed app keeps its data in `~/Library/Application Support/better-mayhem-tracker` (macOS) or `%APPDATA%\better-mayhem-tracker` (Windows). Only `snapshot.ts` reads it, with `sqlite3 -readonly ... .backup` and read-only `cp`. It refuses an output path inside that folder.

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
| `bun parity/fixture.ts --out parity/snapshots/fixture`                                                                                                   | Anonymized fixture from the private snapshot. Add `--from <snapshot>` for another source.                                                                                   |
| `bun parity/audit.ts --fixture parity/snapshots/fixture --snapshot parity/snapshots/private`                                                             | Fails when a real name or PUUID survives in the fixture.                                                                                                                    |
| `bun parity/capture.ts --app electron --data fixture --all`                                                                                              | One PNG, one `.geometry.json`, one `.meta.json` per state in `parity/out/baseline/electron-mac/` (`electron-win/` on Windows), plus `timing.json` and `seam.log`.           |
| `bun parity/capture.ts --app electron --data fixture --states rail,champions-expanded`                                                                   | A subset, by group or state id.                                                                                                                                             |
| `bun parity/run-electron.ts --data fixture --state match-history-default`                                                                                | Starts the app in one state, prints `ready run=<folder> control=...`, and waits for input.                                                                                  |
| `bun parity/drive.ts --run <folder> click "button.group" `                                                                                               | Delivers `click`, `hover`, `type`, `key`, `scroll`, `resize`, `navigate`, `wait`, `waitFor`, `settle`, `shot`, `dom`, `geometry`, or `quit` to a running `run-electron.ts`. |
| `bun parity/diff.ts <trunk.png> <head.png> [--policy same-engine\|cross-engine] [--geometry <trunk.json> <head.json>] [--blur x,y,w,h] [--out <prefix>]` | Prints `PASS` or `FAIL`, writes `<prefix>.diff.png` and `<prefix>.side-by-side.png` (trunk, head, diff).                                                                    |
| `bun test`, `bun run lint`, `bun run fmt:check`                                                                                                          | Unit tests, Bun's linter and formatter.                                                                                                                                     |

`--data` takes `fixture`, `snapshot`, or a folder holding `data/matches.db`. The app runs on a copy inside the run folder, so the source is never changed.

## Policies (Appendix A)

- Same engine: pixelmatch `threshold` 0.03, `includeAA` on, zero differing pixels.
- Cross engine: the layout gate (same element count, every box within 1 CSS px), then pixelmatch `threshold` 0.1, `includeAA` off, at most 0.3% of the page, and no 64 by 64 CSS px tile above 8%. A declared blur region is judged by the tile rule at threshold 0.2 and left out of the page count.

## Determinism

`run-electron.ts` passes `--force-device-scale-factor=2`, `--force-color-profile=srgb`, `--lang=en-US`, `TZ=America/New_York`, freezes the renderer clock with `context.clock.setFixedTime` and the main-process clock in the seam, aborts renderer `http` and `https`, and blocks main-process network except loopback. `settle.ts` waits for fonts, decoded images, a client status past "Connecting...", and 1.2 s of unchanged DOM, then kills animation and parks the mouse. Each state starts from cleared `localStorage` and a reload, and restores any setting it changed.

## Windows

`.github/workflows/parity.yml` runs the baseline on `windows-latest`. The fixture is not committed yet, so the workflow takes it from a workflow_dispatch input (`fixture_run`, the run id holding a `parity-fixture` artifact) and otherwise skips with a notice. Without the Riot asset cache, icons do not load, which affects both of two Windows runs the same way.

## Known limits

- `bun lint` runs with `--no-config-lookup --ext .ts` because the root `.oxlintrc.json` and `.eslintignore` name `parity` and would hide every file from it.
- Client-dependent states, overlays, and menus belong to T03 and T04.
