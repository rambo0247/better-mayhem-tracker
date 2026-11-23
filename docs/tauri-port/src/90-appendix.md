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
