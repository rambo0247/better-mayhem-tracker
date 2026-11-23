# IPC golden format, version 1

T05 records what Electron 1.2.1 does for every request channel and every pushed event, bugs included. T07's `replay-api.js` and T08's `golden.rs` read these files. The TypeScript types are `parity/golden-format.ts`. This document is the contract. A later change to it goes to the root.

## Layout

```
parity/out/golden/
  manifest.json
  timing.json
  ipc/<dir>/<case>.json
  events/<scenario>.jsonl
```

`<dir>` is the channel with every `:` replaced by `.`, because `:` is not a legal file name character on Windows. `db:match-history` is `db.match-history`. No channel contains a dot. `channelDirName` and `channelFromDirName` convert both ways. `<case>` is the case id from `ipc-cases.ts`, lowercase letters, digits and `-`.

The folder holds 61 channel folders plus one more, `bmt.unregistered-channel`, which records Electron's answer to a channel nobody registered. It is outside the 61. T08 lane 8 compares against it.

## An IPC golden (`ipc/<dir>/<case>.json`)

Plain JSON, two-space indent, key order exactly as Electron produced it.

| Field         | Meaning                                                                                                                                                                           |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `format`      | `1`.                                                                                                                                                                              |
| `channel`     | The Electron channel.                                                                                                                                                             |
| `method`      | The `window.api` method, or `null` for the unregistered channel.                                                                                                                  |
| `registered`  | `false` only for the unregistered channel.                                                                                                                                        |
| `case`        | The case id, equal to the file name without `.json`.                                                                                                                              |
| `description` | One line on what the case probes.                                                                                                                                                 |
| `group`       | `read` for a case that changes nothing. Any other value names a write group. A write group ran on one fresh copy of the fixture, in `seq` order, so later cases see earlier ones. |
| `seq`         | Order inside the group, from 0.                                                                                                                                                   |
| `args`        | The positional arguments exactly as passed to `ipcRenderer.invoke(channel, ...args)`. A trailing `undefined` is not recorded.                                                     |
| `outcome`     | One of the three shapes below.                                                                                                                                                    |
| `events`      | Events the main process pushed while the call ran, in order.                                                                                                                      |
| `effects`     | OS calls the handler made that the seam stubbed (`shell.openPath`, `shell.openExternal`, `clipboard.writeImage`, `dialog.showSaveDialog`, `dialog.showOpenDialog`), in order.     |
| `files`       | Files the handler wrote, read back after the call.                                                                                                                                |
| `nonFinite`   | JSON paths in `outcome.result` where Electron returned NaN or an infinity. Both are written as `null`, since JSON has no such value.                                              |

### Outcome

- `{ "kind": "value", "result": <json> }`. The handler returned a value. A handler that returned `null` is a value.
- `{ "kind": "void" }`. The handler returned `undefined`. Tauri resolves such commands with `null`, so a replay of a `void` golden must be equal to `null` for this channel only.
- `{ "kind": "error", "name", "message", "invokeMessage" }`. The handler threw, or Electron rejected the call. `name` and `message` come from the thrown error in the main process. `invokeMessage` is the message the renderer sees, `Error invoking remote method '<channel>': <name>: <message>`, read from a real renderer.

Most handlers return errors as data (`{ success: false, error }`), so `error` outcomes are rare. The unregistered channel is one: its `message` is `No handler registered for '<channel>'`.

### Values the seam normalizes

- A string that contains the run folder has it replaced by `$RUN`. Every other path stays as Electron printed it.
- Wall clock reads in the main process are frozen (`SEAM_FIXED_TIME`, `2026-11-22T21:00:00-05:00`), so dates are stable. Anything still time dependent is listed in `canon.ts` and masked at compare time. The golden file keeps the raw value.

### Files

`files[i].path` is the written path with `$RUN` in place of the run folder. `text` holds the file when it is valid UTF-8. `base64` holds it otherwise. `size` and `sha256` always match the bytes. `exportData` and `createBackup` write files, and T18 and T17 compare these bytes.

## Events (`events/<scenario>.jsonl`)

One JSON object per line, in the order the main process sent them: `{ "seq", "event", "payload"?, "cause" }`. `payload` is absent for an event with no payload (`lcu:games-updated`). `cause` is `{ "channel", "case" }` when an invoke was running, and `"scenario"` otherwise. Timestamps are not in the files, because they would differ on every run. Raw timings are in `parity/out/golden/raw/`, which no later unit reads.

A scenario file is one recording session, named for it. Files today:

- `startup.jsonl`. What the app pushes while it launches with no League client.
- `read.jsonl`, `backup.jsonl`, `data-transfer.jsonl`, `window.jsonl`. Every event pushed while that group's cases ran, with the invoke that caused it in `cause`. Events no invoke caused (the client poller's `lcu:status-changed`) have `cause` `"scenario"`.
- `update-install-failed.jsonl`. Holds only the `update:*` events. The seam makes the app believe it is installed, serves a fake GitHub on loopback, and offers a release whose digest the download cannot match. The app announces the install, reports 25, 50, 75 and 100 percent, then fails its integrity check. No process is spawned and nothing is swapped.
- The T03 scenarios (`end-of-game`, `backfill-running`) write `end-of-game.jsonl` and `backfill-running.jsonl`.

## Matching a call to a golden (replay)

1. Find `ipc/<channelDirName(channel)>/`.
2. Take the case whose `args` equals the call's arguments after `canon.ts` canonicalization. The lowest `seq` wins when two cases tie.
3. If no case matches, take the case named `default`.
4. If there is none, reject as an unrecorded call.

For a write group, a replay serves the group's cases in `seq` order and keeps a cursor per channel.

## Canonical comparison (`canon.ts`)

Both sides compare canonical JSON. Object keys are sorted. Numbers compare as parsed values, so `3` equals `3.0`. Fields named in `CLOCK_FIELDS` are replaced by the marker `"<clock>"` on both sides. A `void` outcome equals `null`. The Rust port of these rules lives in T08's `golden.rs`.

## timing.json

`{ "<channel>": { "<case>": { "n", "medianMs", "p95Ms" } } }`, written by `--timing --repeat N`. Only read-only cases appear.

## manifest.json

`format`, `appVersion`, `platform`, `fixedTime`, `data` (the data source name), `dbSha256` of the fixture database, and the sorted lists of channels and events the recording covers. It holds no wall clock time. Platform differs between macOS and Windows, so a cross-platform comparison skips this file.
