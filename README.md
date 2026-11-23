# Better Mayhem Tracker

Built on [mayhem-tracker](https://github.com/Yhprum/mayhem-tracker) by [Yhprum](https://github.com/Yhprum), with macOS support added.

Desktop app for tracking ARAM Mayhem match history in League of Legends. Connects to the League Client (LCU) to automatically record matches and display stats.

## Features

- Automatic match detection via League Client API
- Supports the limited-time ARAM Mayhem Classic-ish game mode
- Match history with detailed game breakdowns
- Live scoreboard while a game is running, and a post-game recap when it ends
- Export any game as a shareable PNG from the recap or the match list
- Season recaps for each Mayhem set (or all time), shareable as an image the same way
- Champion, augment, and friend stats with win rates
- Aggregate statistics from all players in your games
- Local SQLite database

## Download

**Windows:** grab `BetterMayhemTracker.exe` from the [latest release](https://github.com/rambo0247/better-mayhem-tracker/releases/latest) and run it. It's a portable Windows build with no installer, so it can live anywhere.

**macOS:** grab `BetterMayhemTracker-mac-arm64.dmg` (Apple silicon) or `BetterMayhemTracker-mac-x64.dmg` (Intel) from the same release, open it, and drag Better Mayhem Tracker into Applications. The app is not notarized by Apple, so the first time you open it macOS will refuse. Close that dialog, open **System Settings → Privacy & Security**, scroll down to **Security**, click **Open Anyway** next to Better Mayhem Tracker, and confirm. You only do this once; updates the app installs itself open normally. If macOS instead says the app "is damaged", clear the download quarantine flag with `xattr -cr "/Applications/Better Mayhem Tracker.app"`.

## Usage

1. Start the League client and sign in. The app talks to the client's local API, so the client has to be running for it to detect your account, import history, or record new games.
2. Launch Better Mayhem Tracker. On macOS it finds the client in `/Applications/League of Legends.app` (or wherever the Riot Client recorded it). The dot beside Settings at the top of the window turns green once it finds the client.
3. The first time an account connects it automatically imports your past Mayhem games. Riot only serves an account's last 1000 matches across all queues, so that window is how far back the import can reach. A large one takes a few minutes and fills the app in as it runs.
4. After that it records each game as you finish it, so leave it running while you play.

You can re-run the import at any time from **Settings → Backfill match history**, which is also how you finish one you cancelled. Games already stored stay readable with the client closed; only importing and recording need it open.

Match data lives in `%APPDATA%\better-mayhem-tracker\data` on Windows and `~/Library/Application Support/better-mayhem-tracker/data` on macOS, with automatic backups alongside it. The app checks GitHub for new releases and offers to update itself when one lands. On macOS that needs the app to be in your Applications folder (not running from the disk image or Downloads).

## Tech Stack

Tauri 3 with a Rust backend and a Solid 2 UI in TypeScript, bundled by Vite. It uses Tailwind CSS for styling, SQLite for local storage, and the League client's local API for match detection.

## Development

You need [bun](https://bun.sh) and the Rust toolchain `tauri/rust-toolchain.toml` pins (rustup installs it on the first build). `tauri/` and `parity/` are workspaces of one `bun.lock`.

```bash
bun install
cd tauri
bun run tauri dev           # start in dev mode
```

A debug build refuses to start on the real data folder. Point `BMT_DATA_ROOT` at a copy, such as the ones `parity/snapshot.ts` and `parity/fixture.ts` make.

These run on every push and pull request, and again before a tagged release:

```bash
bun run typecheck
bun run lint
bun run fmt          # rewrites in place; fmt:check only reports
bun run test
cd tauri/src-tauri
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
```

`parity/` holds the tools that compared this app with Electron 1.2.1 before the cutover, and the recorded baseline they used. See its README.

## Build

```bash
cd tauri
CI=true bun run tauri build --bundles app   # the macOS app bundle
CI=true bun run tauri build --no-bundle     # the Windows exe, in src-tauri/target/release
bun scripts/package.ts --platform mac --arch arm64 --out ../release-assets
```

`package.ts` writes the release assets under the names the updater looks for. Pushing a tag `v<version>` runs `.github/workflows/release.yml`, which builds Windows and macOS (Apple silicon and Intel), uploads them to a draft release, and publishes it once every file is there. The tag must equal the version in `package.json`.

Mac builds are ad-hoc signed and not notarized, since that needs a paid Apple Developer ID. To sign and notarize, replace `signingIdentity` in `tauri/src-tauri/tauri.conf.json` and the ad hoc step in `tauri/scripts/package.ts`.

## Disclaimer

Better Mayhem Tracker was created under Riot Games' "Legal Jibber Jabber" policy using assets owned by Riot Games. Riot Games does not endorse or sponsor this project.
