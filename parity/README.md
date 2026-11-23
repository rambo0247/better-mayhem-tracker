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

## The fake League client

`fake-lcu.ts` stands in for the League client so the client-dependent states can be captured. It listens only on 127.0.0.1, makes a CA and a leaf at run time (`fake-lcu/ca.ts`, never Riot's), and answers the routes the app calls from a scenario in `fake-lcu/scenarios/`. `fake-live-client.ts` is the in-game API the app expects on port 2999, on a port of its own.

Electron reaches the fake only through the seam. With `SEAM_FAKE_DIR` set, `seam.cjs` maps the default League install folder to `<fake dir>/league`, adds the fake CA to every explicit TLS trust list (the real Riot root stays in the app), rewrites port 2999 and Riot's match-history hosts to the fake's ports, and refuses every other loopback connection. Port 2999 is rewritten in every run, to a port that refuses when no fake runs, so a real game is never asked. `seam.log` lists each redirect and connection. The real client's lockfile is never read, and nothing here talks to the real client.

| Command                                                                  | What it does                                                                                                                                                                                           |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `bun parity/fake-lcu.ts --scenario connected-idle --data fixture`        | Starts the fake, prints `ready dir=<folder> ...`, and plays the scenario's timeline from the first subscribe. `--set key=value` sets a scenario option.                                                |
| `bun parity/run-electron.ts --data fixture --state <id> --fake <folder>` | Runs the app against a fake started separately. Either can start first.                                                                                                                                |
| `bun parity/capture.ts --app electron --data fixture --states client`    | One app and one fake per state, since the connect loop, the socket, and the database carry what the client did before. Writes the PNG, geometry, `<state>.seam.log`, and `<state>.fake-requests.json`. |
| `bun parity/capture.ts --all --with-client`                              | The default states and the client states. Plain `--all` skips the client states.                                                                                                                       |

Scenarios: `connected-idle`, `champ-select`, `in-game-loading`, `in-game`, `end-of-game`, `results-late` (the post-game stats answer 404 until the fourth request, `--set misses=n`), `challenges-loaded`, `backfill-running` (`served`, `total`), `backfill-walking`, `backfill-done`, `backfill-error`. Frame delays in a timeline are milliseconds from the first subscribe.

Client states live in `states-client.ts`. Rows with `empty` run on a copy of the data with every game removed. Rows with `hold` keep the status on "Connecting..." by holding the connect loop's first tick. The connect time of a row is printed as `connect <ms>`, and the perf probe is `for i in 1 2 3 4 5 6 7 8 9 10; do bun parity/capture.ts --states status-connected --timing --out parity/out/connect-$i; done`.

## Policies (Appendix A)

- Same engine: pixelmatch `threshold` 0.03, `includeAA` on, zero differing pixels.
- Cross engine: the layout gate (same element count, every box within 1 CSS px), then pixelmatch `threshold` 0.1, `includeAA` off, at most 0.3% of the page, and no 64 by 64 CSS px tile above 8%. A declared blur region is judged by the tile rule at threshold 0.2 and left out of the page count.

## Determinism

`run-electron.ts` passes `--force-device-scale-factor=2`, `--force-color-profile=srgb`, `--lang=en-US`, `TZ=America/New_York`, freezes the renderer clock with `context.clock.setFixedTime` and the main-process clock in the seam, aborts renderer `http` and `https`, and blocks main-process network except loopback. `settle.ts` waits for fonts, decoded images, a client status past "Connecting...", and 1.2 s of unchanged DOM, then kills animation and parks the mouse. Each state starts from cleared `localStorage` and a reload, and restores any setting it changed.

## Windows

`.github/workflows/parity.yml` runs the baseline on `windows-latest` once the anonymized fixture is committed under `parity/snapshots/fixture` (decision E2). Until then the Windows job skips with a notice, and lane 9 stays open. Nothing publishes the fixture as an artifact.

Electron runs with `--disable-gpu` by default, because GPU compositing repeats less between runs (waiver W1). `PARITY_GPU=on` turns the GPU back on, and any other value but `off` is an error. Electron also runs with `--disable-partial-raster`, since partial raster made the antialiased edges of icons depend on invalidation order. `PARITY_ELECTRON_ARGS` adds Chromium flags, such as `--disable-renderer-backgrounding`. `SEAM_DOCK=show` keeps the Dock icon for a comparison run.

Opt-in seam modes, all off by default so no baseline changes. `SEAM_WEB_FAKE=<loopback http url>` sends `https://<host>/<path>` for `ddragon.leagueoflegends.com`, `raw.communitydragon.org` and `cdn.communitydragon.org` to `<url>/<host>/<path>` and keeps blocking every other host, and a value that is not a loopback http URL stops the process. `SEAM_CLOCK_LIVE=1` leaves `Date.now` running so a backoff can end, while `new Date()` stays fixed. `startElectron({ quit: "graceful" })` and `run-electron.ts --quit graceful` end the app with `app.quit()`, so `before-quit` and its final fetch run, and fall back to `app.exit(0)` after `quitTimeoutMs` (20 s). The default stays `app.exit(0)`. The seam refuses every socket to port 2999, the live client's API, whatever the host or API used. `SEAM_LIVE_PORT` and `SEAM_FORK_DEPTH` are pinned by `run-electron.ts`.

The `view:` localStorage keys in `states.ts` only take effect while the `remember_filters` setting is on, so `applyState` turns it on for every state that seeds one. Each of those states asserts that its view applied.

Every spawning command runs under `lib/capped.sh <headroom>`, which caps processes at the user's current count plus the headroom and exits 99 if anything was refused a process. `bun run test` and `bun run capture` use a headroom of 200. A bare `ulimit -u 200` would refuse the first fork on macOS, which counts every process the user owns.

## Known limits

- `bun lint --flavor eslint` is what lints parity. Without the flavor, Bun walks up to the root `.oxlintrc.json`, whose ignore patterns name `parity`, and lints nothing.
- Overlays and menus belong to T04.
