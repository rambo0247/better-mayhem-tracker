// Writes the leveldb fixture the local_storage tests read: trunk Electron sets
// the keys through the page, flushes, and quits, then its store is copied.
// Run from the repo root, under capture-slot.sh, after wait-no-game.sh:
//   bun tauri/src-tauri/tests/fixtures/local-storage/generate.ts [--repo <checkout>]
import fs from "node:fs";
import path from "node:path";
import { startElectron } from "../../../../../parity/run-electron.ts";

const here = import.meta.dir;
const repoFlag = process.argv.indexOf("--repo");
const repo = repoFlag > 0 ? process.argv[repoFlag + 1] : undefined;
const fixture = path.resolve(here, "../../../../../parity/snapshots/fixture");

const VIEW_KEYS = [
  ...[
    "champion",
    "season",
    "patch",
    "queue",
    "account",
    "multikills",
    "sort",
    "sortDir",
    "favorites",
  ].map((k) => `matches.${k}`),
  ...["patch", "queue", "season", "search", "minGames", "sortKey", "sortDir"].map(
    (k) => `champions.${k}`,
  ),
  ...[
    "season",
    "view",
    "search",
    "minGames",
    "groupSize",
    "sortKey",
    "sortDir",
    "groups.sortKey",
    "groups.sortDir",
  ].map((k) => `friends.${k}`),
  ...["patch", "queue", "season", "search", "minPicks", "rarity", "sortKey", "sortDir"].map(
    (k) => `augments.${k}`,
  ),
  ...["params", "champSearch", "augSearch", "augRarity", "itemSearch"].map((k) => `global.${k}`),
  ...["champ", "aug", "item"].flatMap((g) => ["sortKey", "sortDir"].map((k) => `global.${g}.${k}`)),
  "globalChampion.augRarity",
  ...["items", "augments"].flatMap((g) =>
    ["sortKey", "sortDir"].map((k) => `globalChampion.${g}.${k}`),
  ),
  ...["id", "queue", "account", "hideFriends"].map((k) => `season.${k}`),
  ...["queue", "granularity"].map((k) => `trends.${k}`),
  ...["queue", "account"].map((k) => `records.${k}`),
];

// What the pages store: JSON, with a few values that need UTF-16 or the top of latin1
const OVERRIDES: Record<string, unknown> = {
  "matches.account": "Ünïcödé 日本語#EUW",
  "matches.champion": "Zoë",
  "matches.favorites": ["a1", "b2"],
  "matches.sortDir": "desc",
  "friends.search": "Łódź",
  "global.params": { queue: 2400, region: "all" },
};

const entries: Record<string, string> = {
  "recap-badge-seen": "2026-s4",
};
for (const key of VIEW_KEYS) {
  entries[`view:${key}`] = JSON.stringify(OVERRIDES[key] ?? `value of ${key}`);
}

const running = await startElectron({ data: fixture, repo });
try {
  await running.page.evaluate(
    ({ entries, tombstone, ignored }) => {
      localStorage.clear();
      for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value);
      localStorage.setItem(tombstone, '"removed"');
      localStorage.removeItem(tombstone);
      localStorage.setItem(ignored, "not a view key");
    },
    { entries, tombstone: "view:matches.removed", ignored: "unrelated-key" },
  );
  await running.app.evaluate(({ session }) => session.defaultSession.flushStorageData());
  const userData = running.userData;
  await running.close();
  const source = path.join(userData, "Local Storage", "leveldb");
  const target = path.join(here, "leveldb");
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target);
  for (const name of fs.readdirSync(source)) {
    if (name === "LOCK" || name.startsWith("LOG")) continue;
    fs.copyFileSync(path.join(source, name), path.join(target, name));
  }
  fs.writeFileSync(path.join(here, "expected.json"), `${JSON.stringify(entries, null, 2)}\n`);
  console.log(`wrote ${Object.keys(entries).length} keys to ${target}`);
} catch (error) {
  await running.close();
  throw error;
}
