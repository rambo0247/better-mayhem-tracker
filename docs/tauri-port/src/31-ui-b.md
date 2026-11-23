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

**Verify, unit.** @@RULE@@

- [ ] `tauri/src/pages/LiveGame.test.tsx` feeds each recorded snapshot sequence and asserts which state renders after each, against the order Electron's goldens record.

**Verify, live.** @@LIVE@@

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

**Verify, perf.** @@RULE@@

- [ ] Metric. CPU time over 60 s on the in-game page with the clock running.
- [ ] Probe. Run `in-game` 60 s per app, three times, alternating.
- [ ] Baseline. Record Electron's CPU time first.
- [ ] Rule. Fail when Tauri uses more CPU time than Electron.

@@GATE T34 1,3,4,6@@

@@MERGE@@

## Port the Trends page (T35)

**Depends on.** T27.

**Files.**

- [ ] Create `tauri/src/pages/Trends.tsx`.

**Build.**

- [ ] Port `Trends.tsx`, all 1,105 lines, with the queue select, the month and week toggle and its default from the 120-day span, the hand-written SVG time series charts, and the hover tooltips.

**You see.**

- [ ] Trends passes the pixel diff against the Electron baseline loaded, empty, by month, by week, and with each chart's tooltip open.

**Verify, unit.** @@RULE@@

- [ ] `tauri/src/pages/Trends.test.tsx` asserts the default granularity for spans of 100 and 200 days, and the SVG path data for one chart against the React output on the same data.

**Verify, live.** @@LIVE@@

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

**Verify, perf.** @@RULE@@

- [ ] Metric. Time from the nav click to every chart painted.
- [ ] Probe. Navigate 10 times per app alternately.
- [ ] Baseline. Record Electron's median first.
- [ ] Rule. Fail when Tauri's median is slower than Electron's by more than 10%.

@@GATE T35 1,4,5@@

@@MERGE@@

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

**Verify, unit.** @@RULE@@

- [ ] `tauri/src/pages/Settings.test.tsx` toggles each setting and asserts the `setSetting` call and value Electron's golden records.

**Verify, live.** @@LIVE@@

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

**Verify, perf.** @@RULE@@

- [ ] Metric. Time from the nav click to the first section painted.
- [ ] Probe. Navigate 10 times per app alternately.
- [ ] Baseline. Record Electron's median first.
- [ ] Rule. Fail when Tauri's median is slower than Electron's by more than 10%.

@@GATE T36 1,2,3,5@@

@@MERGE@@

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

**Verify, unit.** @@RULE@@

- [ ] `tauri/src/pages/MatchHistory.test.tsx` asserts each empty state's text, that a second page loads when the sentinel intersects, and that expanding one row leaves the other row nodes in place.

**Verify, live.** @@LIVE@@

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

**Verify, perf.** @@RULE@@

- [ ] Metric. Launch to the first row painted, and time to render all 669 rows with "Load all".
- [ ] Probe. `bun parity/perf.ts --scenario first-rows --runs 10` and the load-all timer, interleaved with Electron.
- [ ] Baseline. Record Electron's medians first. The spike measured 0.52 to 0.67 s to first rows.
- [ ] Rule. Fail when either Tauri median is slower than Electron's.

@@GATE T37 1,4,5,6,8@@

@@MERGE@@

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

**Verify, unit.** @@RULE@@

- [ ] `tauri/src/components/UpdateDialog.test.tsx` and `ActivityToast.test.tsx` assert each variant's text and that the toast hides after 10 s on a fake timer.

**Verify, live.** @@LIVE@@

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

**Verify, perf.** @@RULE@@

- [ ] Metric. Time from the trigger to the dialog painted.
- [ ] Probe. Open and close the Update dialog 10 times per app alternately.
- [ ] Baseline. Record Electron's median first.
- [ ] Rule. Fail when Tauri's median is slower than Electron's by more than 10%.

@@GATE T38 1,3,4,5@@

@@MERGE@@
