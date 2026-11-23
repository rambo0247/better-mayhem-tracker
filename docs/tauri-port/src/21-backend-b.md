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

**Verify, unit.** @@RULE@@

- [ ] `db/matches.rs` tests run each query on the fixture with each filter and sort and assert row counts and the first and last row against the goldens.

**Verify, live.** @@LIVE@@

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

**Verify, perf.** @@RULE@@

- [ ] Metric. Round-trip time for `db:match-history` with a 50-game page and with all games, against the T05 Electron timings.
- [ ] Probe. Call each 50 times from the renderer, alternating apps every 10 calls.
- [ ] Baseline. Electron's medians from `parity/out/golden/timing.json`. The spike measured 0.44 ms and 3.7 ms in Node.
- [ ] Rule. Fail when Tauri's median exceeds Electron's by more than 25% or by more than 2 ms, whichever is larger.

@@NOGATE T13@@

@@MERGE@@

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

**Verify, unit.** @@RULE@@

- [ ] `db/stats.rs` and `db/records.rs` tests assert each channel's goldens for every argument variant in `parity/ipc-cases.ts`.

**Verify, live.** @@LIVE@@

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

**Verify, perf.** @@RULE@@

- [ ] Metric. Round-trip time for `db:global-stats` and `db:trends`, the two heaviest stats channels.
- [ ] Probe. Call each 50 times, alternating apps every 10 calls.
- [ ] Baseline. Electron's medians from the T05 timing file.
- [ ] Rule. Fail when Tauri's median exceeds Electron's by more than 25% or 2 ms, whichever is larger.

@@NOGATE T14@@

@@MERGE@@

## Port the teammate and group queries (T15)

**Depends on.** T12.

**Files.**

- [ ] Create `tauri/src-tauri/src/db/teammates.rs`.
- [ ] Edit `tauri/src-tauri/src/commands/teammates.rs`.

**Build.**

- [ ] Port `db/teammates.ts` for `db:teammate-stats`, `db:teammate-groups`, `db:teammate-detail`, and `db:teammate-group-detail`, including group keys and the encoding of teammate keys in URLs.

**You see.**

- [ ] Golden replay moves those 4 channels to `pass`, and Friends, friend detail, and group detail render on the real commands.

**Verify, unit.** @@RULE@@

- [ ] `db/teammates.rs` tests assert the goldens for each season and group size, and that a key with a `#` in the tag line round-trips.

**Verify, live.** @@LIVE@@

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

**Verify, perf.** @@RULE@@

- [ ] Metric. Round-trip time for `db:teammate-stats` and `db:teammate-groups`.
- [ ] Probe. Call each 50 times, alternating apps every 10 calls.
- [ ] Baseline. Electron's medians from the T05 timing file.
- [ ] Rule. Fail when Tauri's median exceeds Electron's by more than 25% or 2 ms, whichever is larger.

@@NOGATE T15@@

@@MERGE@@

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

**Verify, unit.** @@RULE@@

- [ ] `db/recap.rs` and `db/season.rs` tests assert the goldens for every season and queue, and the recap of the first and the newest game.

**Verify, live.** @@LIVE@@

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

**Verify, perf.** @@RULE@@

- [ ] Metric. Round-trip time for `db:season-recap` on the largest season.
- [ ] Probe. Call it 50 times, alternating apps every 10 calls.
- [ ] Baseline. Electron's median from the T05 timing file.
- [ ] Rule. Fail when Tauri's median exceeds Electron's by more than 25% or 2 ms, whichever is larger.

@@NOGATE T16@@

@@MERGE@@

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

**Verify, unit.** @@RULE@@

- [ ] `backup.rs` tests assert the prune keeps the same set Electron keeps for a fixed list of names and dates, and that a corrupt database is quarantined with Electron's file name.

**Verify, live.** @@LIVE@@

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

**Verify, perf.** @@RULE@@

- [ ] Metric. Time for `backup:create` on the 669-game snapshot.
- [ ] Probe. Create 10 backups in each app alternately.
- [ ] Baseline. Record Electron's median first.
- [ ] Rule. Fail when Tauri's median exceeds Electron's by more than 25%.

@@NOGATE T17@@

@@MERGE@@

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

**Verify, unit.** @@RULE@@

- [ ] `transfer.rs` tests export the fixture and assert the bytes equal the T05 export golden.
- [ ] `import.rs` tests import the golden export into an empty database and assert a dump equal to the fixture's.

**Verify, live.** @@LIVE@@

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

**Verify, perf.** @@RULE@@

- [ ] Metric. Time to export and to import the 669-game snapshot.
- [ ] Probe. Run each 5 times in each app alternately.
- [ ] Baseline. Record Electron's medians first.
- [ ] Rule. Fail when either Tauri median exceeds Electron's by more than 25%.

@@NOGATE T18@@

@@MERGE@@

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

**Verify, unit.** @@RULE@@

- [ ] `tls.rs` tests assert the verifier rejects a self-signed localhost certificate, a leaf from an impostor CA with Riot's subject name, and a certificate for the wrong host, using the prototype's test certificates.
- [ ] `lockfile.rs` tests parse the lockfile format and the stale case.

**Verify, live.** @@LIVE@@

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

**Verify, perf.** @@RULE@@

- [ ] Metric. Time from fake-client start to `connected`, and memory with the client connected for 5 minutes.
- [ ] Probe. Start and stop the fake client 10 times per app alternately, then idle 5 minutes connected.
- [ ] Baseline. Record Electron's numbers first.
- [ ] Rule. Fail when Tauri connects slower than Electron's median plus 1 s, or its memory grows more than 5 MB over the 5 minutes.

@@NOGATE T19@@

@@MERGE@@

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

**Verify, unit.** @@RULE@@

- [ ] `lcu/eog.rs` tests drive a fake clock through the retry list and assert each attempt's time.
- [ ] `lcu/backfill.rs` tests assert the shard probe order and that cancel stops within one request.

**Verify, live.** @@LIVE@@

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

**Verify, perf.** @@RULE@@

- [ ] Metric. Time from the fake client's end-of-game event to the new row painted.
- [ ] Probe. Run `end-of-game` 10 times per app alternately.
- [ ] Baseline. Record Electron's median first.
- [ ] Rule. Fail when Tauri's median is slower than Electron's by more than 200 ms.

@@NOGATE T20@@

@@MERGE@@

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

**Verify, unit.** @@RULE@@

- [ ] `live.rs` tests feed recorded 2999 responses and assert the snapshots equal the goldens.
- [ ] `challenges.rs` tests assert one capture per day and the delay list.

**Verify, live.** @@LIVE@@

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

**Verify, perf.** @@RULE@@

- [ ] Metric. CPU time and memory over 5 minutes of `in-game` polling.
- [ ] Probe. Run `in-game` 5 minutes per app, twice, alternating.
- [ ] Baseline. Record Electron's numbers first.
- [ ] Rule. Fail when Tauri uses more CPU time or more memory than Electron.

@@NOGATE T21@@

@@MERGE@@

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

**Verify, unit.** @@RULE@@

- [ ] `assets.rs` tests resolve each URL shape the renderer builds to the same cache path Electron uses.
- [ ] `asset_cache.rs` tests assert the prune keeps the same folders Electron keeps.

**Verify, live.** @@LIVE@@

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

**Verify, perf.** @@RULE@@

- [ ] Metric. Time to load the 145 images on Match History from a warm cache.
- [ ] Probe. Load the page 10 times per app alternately and read image load times from the page.
- [ ] Baseline. Record Electron's median first.
- [ ] Rule. Fail when Tauri's median exceeds Electron's by more than 25%.

@@NOGATE T22@@

@@MERGE@@

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

**Verify, unit.** @@RULE@@

- [ ] `autostart.rs` tests render the plist and the Run value and assert byte equality with Electron's output from a golden.

**Verify, live.** @@LIVE@@

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

**Verify, perf.** @@RULE@@

- [ ] Metric. Time from login item launch to the tray icon present with `--hidden`.
- [ ] Probe. Launch each app with `--hidden` 10 times alternately.
- [ ] Baseline. Record Electron's median first.
- [ ] Rule. Fail when Tauri is slower than Electron.

@@GATE T23 1,4,6,7@@

@@MERGE@@

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

**Verify, unit.** @@RULE@@

- [ ] `updater.rs` tests assert version comparison, asset choice per platform and arch, the digest check, and the schedule against a fake clock.

**Verify, live.** @@LIVE@@

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

**Verify, perf.** @@RULE@@

- [ ] Metric. Download size of the update and time from the install click to the relaunched window.
- [ ] Probe. Run lane 1 and lane 3 five times each.
- [ ] Baseline. Record Electron 1.2.1 to Electron 1.2.1 update size and time first, from the T06 asset sizes and one timed run.
- [ ] Rule. Fail when the Tauri update zip exceeds 10 MB or the relaunch takes longer than Electron's.

@@GATE T24 1,2,4,5,8@@

@@MERGE@@

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

**Verify, unit.** @@RULE@@

- [ ] `export_image.rs` tests assert the PNG has no ancillary chunks and that the crop height is `ceil(h * 1.5)`.

**Verify, live.** @@LIVE@@

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

**Verify, perf.** @@RULE@@

- [ ] Metric. Time from the click to the PNG on disk for one game card.
- [ ] Probe. Export the same card 10 times per app alternately.
- [ ] Baseline. Electron measured 715 ms median in the prototype. Record it again here first.
- [ ] Rule. Fail when Tauri's median exceeds Electron's.

@@GATE T25 1,2,3,4,7@@

@@MERGE@@

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

**Verify, unit.** @@RULE@@

- [ ] `local_storage.rs` tests read the prototype's synthetic leveldb with a latin1 value, a UTF-16 value, and bookkeeping keys, and assert the imported pairs.

**Verify, live.** @@LIVE@@

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

**Verify, perf.** @@RULE@@

- [ ] Metric. Time the import adds to the first launch.
- [ ] Probe. Launch on a store with every key 10 times, deleting the imported flag between runs.
- [ ] Baseline. Trunk has no import. Record Tauri's first launch time with the import skipped first.
- [ ] Rule. Fail when the import adds more than 50 ms.

@@NOGATE T26@@

@@MERGE@@
