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

**Verify, unit.** @@RULE@@

- [ ] `tauri/src/components/*.test.tsx` render each tier 0 and tier 1 component with `@solidjs/web` in happy-dom under `bun test`, and assert the DOM text and classes of each prop combination against a snapshot taken from the React component with the same props.
- [ ] `tauri/scripts/react-isms.test.ts` asserts each pattern is found in a fixture file.

**Verify, live.** @@LIVE@@

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

**Verify, perf.** @@RULE@@

- [ ] Metric. Launch to the shell's first paint, and idle memory with the shell on screen.
- [ ] Probe. `bun parity/perf.ts --app tauri --scenario shell --runs 10` interleaved with Electron.
- [ ] Baseline. Record Electron's launch to first paint and idle memory first.
- [ ] Rule. Fail when Tauri's launch median is slower than Electron's or its memory exceeds 60% of Electron's.

@@GATE T27 1,2,3,6@@

@@MERGE@@

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

**Verify, unit.** @@RULE@@

- [ ] `tauri/src/pages/Records.test.tsx` and `Augments.test.tsx` render each page on replayed goldens and assert the text of the loading, empty, and loaded states.

**Verify, live.** @@LIVE@@

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

**Verify, perf.** @@RULE@@

- [ ] Metric. Time from clicking the nav link to the page's first row painted, for each page.
- [ ] Probe. Navigate to each page 10 times per app alternately.
- [ ] Baseline. Record Electron's medians first.
- [ ] Rule. Fail when Tauri's median is slower than Electron's by more than 10%.

@@GATE T28 1,4,6,9@@

@@MERGE@@

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

**Verify, unit.** @@RULE@@

- [ ] `tauri/src/pages/SeasonRecap.test.tsx` asserts the loading, empty, and loaded text, and `useCardCapture.test.ts` asserts the status moves to `ready` only after images settle.

**Verify, live.** @@LIVE@@

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

**Verify, perf.** @@RULE@@

- [ ] Metric. Time from the nav click to the preview card painted.
- [ ] Probe. Navigate 10 times per app alternately.
- [ ] Baseline. Record Electron's median first.
- [ ] Rule. Fail when Tauri's median is slower than Electron's by more than 10%.

@@GATE T29 1,4,5,6@@

@@MERGE@@

## Port the Challenges page (T30)

**Depends on.** T27.

**Files.**

- [ ] Create `tauri/src/pages/Challenges.tsx`.

**Build.**

- [ ] Port `Challenges.tsx` with the capstone card, the player card, the category cards with tiers, the offline state, and the dependency on the client status.

**You see.**

- [ ] Challenges passes the pixel diff against the Electron baseline loaded, without a capstone, loading, and offline.

**Verify, unit.** @@RULE@@

- [ ] `tauri/src/pages/Challenges.test.tsx` asserts the text of the loading, offline, and loaded states, and that a `challenges:changed` event updates the page.

**Verify, live.** @@LIVE@@

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

**Verify, perf.** @@RULE@@

- [ ] Metric. Time from the nav click to the category cards painted.
- [ ] Probe. Navigate 10 times per app alternately.
- [ ] Baseline. Record Electron's median first.
- [ ] Rule. Fail when Tauri's median is slower than Electron's by more than 10%.

@@GATE T30 1,2,5@@

@@MERGE@@

## Port the Champions page (T31)

**Depends on.** T27.

**Files.**

- [ ] Create `tauri/src/pages/Champions.tsx`.

**Build.**

- [ ] Port `Champions.tsx` with the cycling sort headers, the filter menu for season, patch, queue, and minimum games, search, the expanded row with top augments, top items, and recent games, and the link to Match History with `location.state`.

**You see.**

- [ ] Champions passes the pixel diff against the Electron baseline in every state Appendix F lists.

**Verify, unit.** @@RULE@@

- [ ] `tauri/src/pages/Champions.test.tsx` asserts the row order for each sort state and that search uses `onInput` per keystroke.

**Verify, live.** @@LIVE@@

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

**Verify, perf.** @@RULE@@

- [ ] Metric. Time from the nav click to the table painted, and from a sort click to the new order painted.
- [ ] Probe. Navigate and sort 10 times per app alternately.
- [ ] Baseline. Record Electron's medians first.
- [ ] Rule. Fail when either Tauri median is slower than Electron's by more than 10%.

@@GATE T31 1,4,5,6@@

@@MERGE@@

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

**Verify, unit.** @@RULE@@

- [ ] `tauri/src/pages/Friends.test.tsx`, `FriendDetail.test.tsx`, and `GroupDetail.test.tsx` assert loading, empty, and loaded text, and the encoded key in each link.

**Verify, live.** @@LIVE@@

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

**Verify, perf.** @@RULE@@

- [ ] Metric. Time from a row click to the detail page painted.
- [ ] Probe. Open the top friend and the top group 10 times per app alternately.
- [ ] Baseline. Record Electron's medians first.
- [ ] Rule. Fail when Tauri's median is slower than Electron's by more than 10%.

@@GATE T32 1,4,5,8@@

@@MERGE@@

## Port Global Stats and the champion detail page (T33)

**Depends on.** T27.

**Files.**

- [ ] Create `tauri/src/pages/GlobalStats.tsx` and `tauri/src/pages/GlobalChampionDetail.tsx`.
- [ ] Create `tauri/src/hooks/useQueryFilters.ts`.

**Build.**

- [ ] Port both pages with the `?tab`, `?patch`, and `?queue` parameters, the leader cards, three tabs with their own search and the rarity filter, the splash header with its floating filter panel, and the back link that keeps the query.

**You see.**

- [ ] Both pages pass the pixel diff against the Electron baseline in every state Appendix F lists.

**Verify, unit.** @@RULE@@

- [ ] `tauri/src/hooks/useQueryFilters.test.ts` asserts reading and writing each parameter, and the page tests assert each tab's loaded text.

**Verify, live.** @@LIVE@@

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

**Verify, perf.** @@RULE@@

- [ ] Metric. Time from the nav click to the champions table painted, and from a tab click to the new table.
- [ ] Probe. Navigate and switch tabs 10 times per app alternately.
- [ ] Baseline. Record Electron's medians first.
- [ ] Rule. Fail when either Tauri median is slower than Electron's by more than 10%.

@@GATE T33 1,4,6@@

@@MERGE@@
