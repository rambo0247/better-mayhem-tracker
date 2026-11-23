import type { Json, Outcome } from "./golden-format.ts";

/** Ids and keys read from the fixture, so cases name rows that exist in whichever data they run on. */
export interface Vars {
  gameId: number;
  olderGameId: number;
  championId: number;
  otherChampionId: number;
  patch: string;
  olderPatch: string;
  queue: number;
  season: string;
  olderSeason: string;
  account: string;
  teammateKey: string;
  groupKey: string;
}

/** Outcomes of earlier cases in the same group, by case id. */
export type Prior = Record<string, Outcome>;

export interface Dialogs {
  /** Path the save dialog answers with, `$RUN` standing for the run folder. Null cancels it. */
  save?: string | null;
  open?: string | null;
}

export interface IpcCase {
  id: string;
  method: string;
  description: string;
  /** `read` cases run together and change nothing. Any other value is one fresh launch on a fresh data copy. */
  group: string;
  args: (vars: Vars, prior: Prior) => (Json | undefined)[];
  dialogs?: Dialogs;
  /** Files to read back after the call, `$RUN` standing for the run folder. */
  files?: (vars: Vars, outcome: Outcome) => string[];
  /** Runs before the call, with the run folder. */
  prepare?: (run: string) => void;
}

const READ = "read";
const list: IpcCase[] = [];

function add(
  method: string,
  id: string,
  description: string,
  args: IpcCase["args"] = () => [],
  extra: Partial<IpcCase> = {},
) {
  list.push({ id, method, description, group: READ, args, ...extra });
}

const defaults = (method: string, description: string) => add(method, "default", description);

// --- Match history and the match list ---
add("getMatchHistory", "default", "first 50 rows, no filters", () => [50, 0]);
add("getMatchHistory", "page-2", "second page of 10", () => [10, 10]);
add("getMatchHistory", "filter-queue", "one queue", (v) => [50, 0, { queue: v.queue }]);
add("getMatchHistory", "filter-champion", "one champion", (v) => [
  50,
  0,
  { championId: v.championId },
]);
add("getMatchHistory", "filter-patch", "one patch", (v) => [50, 0, { patch: v.patch }]);
add("getMatchHistory", "filter-season", "one season", (v) => [50, 0, { season: v.olderSeason }]);
add("getMatchHistory", "filter-account", "one account", (v) => [50, 0, { account: v.account }]);
add("getMatchHistory", "sort-kda-asc", "sorted by kda ascending", () => [
  20,
  0,
  { sort: "kda", sortDir: "asc" },
]);
add("getMatchHistory", "sort-damage-desc", "sorted by damage dealt descending", () => [
  20,
  0,
  { sort: "damageDealt", sortDir: "desc" },
]);
add("getMatchHistory", "filter-multikills", "pentas and quadras only", () => [
  50,
  0,
  { multikills: ["pentas", "quadras"] },
]);
add("getMatchHistory", "filter-favorites", "favorites only", () => [50, 0, { favorites: true }]);
add("getMatchHistory", "filter-combined", "season, queue and champion together", (v) => [
  50,
  0,
  { season: v.season, queue: v.queue, championId: v.championId },
]);
add("getMatchHistory", "empty", "a champion with no games", () => [50, 0, { championId: -1 }]);

add("getMatchSessions", "default", "no filters");
add("getMatchSessions", "filter-queue", "one queue", (v) => [{ queue: v.queue }]);
add("getMatchSessions", "filter-season", "one season", (v) => [{ season: v.olderSeason }]);

add("getMatchFilterOptions", "default", "no filters");
add("getMatchFilterOptions", "filter-champion", "options under one champion", (v) => [
  { championId: v.championId },
]);
add("getMatchFilterOptions", "filter-season", "options under one season", (v) => [
  { season: v.season },
]);

defaults("getStoredQueues", "every stored queue");
add("getMatchDetail", "newest", "newest game", (v) => [v.gameId]);
add("getMatchDetail", "older", "oldest game on the first page", (v) => [v.olderGameId]);
add("getMatchDetail", "missing", "a game id that does not exist", () => [-1]);
add("getChampionMatchHistory", "default", "one champion, first page", (v) => [v.championId, 50, 0]);
add("getChampionMatchHistory", "page-2", "second page of 5", (v) => [v.championId, 5, 5]);
add("getChampionMatchHistory", "filters", "patch, queue and season together", (v) => [
  v.championId,
  50,
  0,
  v.patch,
  v.queue,
  v.season,
]);
add("getChampionMatchHistory", "missing", "a champion with no games", () => [-1, 50, 0]);
defaults("getAllSummonerPuuids", "every tracked account");
defaults("getProfile", "the profile card");

// --- Stats ---
add("getChampionStats", "default", "all games");
add("getChampionStats", "patch", "one patch", (v) => [v.patch]);
add("getChampionStats", "queue", "one queue", (v) => [undefined, v.queue]);
add("getChampionStats", "season", "one season", (v) => [undefined, undefined, v.olderSeason]);
add("getAugmentStats", "default", "all games");
add("getAugmentStats", "champion", "one champion", (v) => [v.championId]);
add("getAugmentStats", "filters", "patch and queue", (v) => [undefined, v.patch, v.queue]);
add("getAugmentStatsDetailed", "default", "all games");
add("getAugmentStatsDetailed", "queue", "one queue", (v) => [undefined, v.queue]);
add("getAugmentStatsDetailed", "season", "one season", (v) => [
  undefined,
  undefined,
  v.olderSeason,
]);
add("getDashboard", "default", "no filters");
add("getDashboard", "queue", "one queue", (v) => [{ queue: v.queue }]);
add("getDashboard", "season", "one season", (v) => [{ season: v.season }]);
add("getDashboard", "account", "one account", (v) => [{ account: v.account }]);
add("getChampionItemStats", "default", "one champion", (v) => [v.championId]);
add("getChampionItemStats", "filters", "patch and queue", (v) => [v.championId, v.patch, v.queue]);
add("getGlobalStats", "default", "all games");
add("getGlobalStats", "patch", "one patch", (v) => [v.patch]);
add("getGlobalStats", "queue", "one queue", (v) => [undefined, v.queue]);
add("getGlobalChampionDetail", "default", "one champion", (v) => [v.championId]);
add("getGlobalChampionDetail", "filters", "patch and queue", (v) => [
  v.otherChampionId,
  v.patch,
  v.queue,
]);
add("getTrends", "default", "all queues");
add("getTrends", "queue", "one queue", (v) => [v.queue]);
add("getRecords", "default", "all games");
add("getRecords", "queue", "one queue", (v) => [v.queue]);
add("getRecords", "account", "one account", (v) => [undefined, v.account]);

// --- Teammates ---
add("getTeammateStats", "default", "all seasons");
add("getTeammateStats", "season", "one season", (v) => [v.season]);
add("getTeammateGroups", "default", "all seasons");
add("getTeammateGroups", "season", "one season", (v) => [v.season]);
add("getTeammateDetail", "default", "one teammate", (v) => [v.teammateKey]);
add("getTeammateDetail", "missing", "an unknown key", () => ["no-such-teammate"]);
add("getTeammateGroupDetail", "default", "one group", (v) => [v.groupKey]);
add("getTeammateGroupDetail", "missing", "an unknown key", () => ["no-such-group"]);

// --- Recaps ---
add("getGameRecap", "default", "latest game");
add("getGameRecap", "game", "a named game", (v) => [v.olderGameId]);
add("getGameRecap", "missing", "a game id that does not exist", () => [-1]);
add("getGameCard", "default", "one game", (v) => [v.gameId]);
add("getGameCard", "missing", "a game id that does not exist", () => [-1]);
add("getSeasonRecap", "default", "latest season");
add("getSeasonRecap", "season", "a named season", (v) => [v.olderSeason]);
add("getSeasonRecap", "filters", "season, queue and account", (v) => [
  v.season,
  v.queue,
  v.account,
]);
add("getSeasonRecap", "unknown-season", "a season that is not on offer", () => ["no-such-season"]);
defaults("getSeasons", "every season");

// --- Backups and the recovery report (reads) ---
defaults("listBackups", "the backups folder as copied into the run");
defaults("getRecoveryReport", "no recovery happened at startup");
defaults("openBackupFolder", "asks the OS to open the folder");

// --- Client, live game, challenges (no client running) ---
defaults("getLcuStatus", "status with no client");
defaults("isBackfillRunning", "nothing running");
defaults("cancelBackfill", "nothing to cancel");
defaults("backfillHistory", "backfill with no client");
defaults("getLiveGame", "no game");
defaults("getChallenges", "with no client");

// --- Dragon data ---
defaults("getChampionData", "champion table");
add("getAugmentData", "default", "current patch");
add("getAugmentData", "patch", "a named patch", (v) => [v.patch]);
add("resolveAugmentIcon", "default", "an augment id", () => [1077]);
add("resolveAugmentIcon", "missing", "an augment id that does not exist", () => [-1]);
add("getItemData", "default", "current patch");
add("getItemData", "patch", "a named patch", (v) => [v.patch]);
defaults("getSummonerSpellData", "spell table");

// --- Settings (reads) ---
for (const key of [
  "auto_start",
  "auto_update",
  "show_release_notes",
  "minimize_to_tray",
  "hidden_queues",
  "hide_remakes",
  "auto_backup",
  "remember_filters",
  "hidden_nav_links",
  "session_grouping",
]) {
  add("getSetting", `allowed-${key.replaceAll("_", "-")}`, `allowed key ${key}`, () => [key]);
}
add("getSetting", "denied", "a key outside the 10-key allow list that exists in the table", () => [
  "last_run_version",
]);
add("getSetting", "unknown", "a key that does not exist", () => ["no_such_setting"]);
defaults("isAutoStartSupported", "unpackaged run");

// --- App ---
defaults("getVersion", "package version");
defaults("checkForUpdate", "network blocked by the seam");
defaults("getLaunchInstall", "nothing pending");
defaults("getUpdateNotes", "nothing recorded");
add("openUrl", "https", "an https url reaches the OS", () => ["https://example.com/"]);
add("openUrl", "refused", "a file: url is refused", () => ["file:///etc/passwd"]);
defaults("openLogsFolder", "asks the OS to open the folder");
add("downloadUpdate", "unpackaged", "an unpackaged run cannot install", () => [
  "https://github.com/rambo0247/better-mayhem-tracker/releases/download/v9.9.9/x.zip",
]);
defaults("isWindowMaximized", "fresh window");

// --- Write groups. Each one is a fresh launch on a fresh copy of the data. ---
function write(
  group: string,
  method: string,
  id: string,
  description: string,
  args: IpcCase["args"] = () => [],
  extra: Partial<IpcCase> = {},
) {
  list.push({ id, method, description, group, args, ...extra });
}

const FAV = "favorite";
write(FAV, "getMatchDetail", "before", "favorite flag before toggling", (v) => [v.gameId]);
write(FAV, "toggleFavorite", "first", "first toggle sets the flag", (v) => [v.gameId]);
write(
  FAV,
  "getMatchHistory",
  "favorites-after-first",
  "favorites list after the first toggle",
  () => [50, 0, { favorites: true }],
);
write(FAV, "toggleFavorite", "second", "second toggle restores the first state", (v) => [v.gameId]);
write(
  FAV,
  "getMatchHistory",
  "favorites-after-second",
  "favorites list after the second toggle",
  () => [50, 0, { favorites: true }],
);
write(FAV, "toggleFavorite", "missing", "a game id that does not exist", () => [-1]);

const SET = "settings-write";
write(SET, "setSetting", "denied", "a key outside the allow list is refused", () => [
  "score_formula_version",
  "999",
]);
write(SET, "getSetting", "after-denied", "the refused key keeps its value", () => [
  "score_formula_version",
]);
write(SET, "setSetting", "hide-remakes", "an allowed key", () => ["hide_remakes", "true"]);
write(SET, "getSetting", "after-hide-remakes", "reads back what was written", () => [
  "hide_remakes",
]);
write(SET, "getMatchHistory", "remakes-hidden", "the list under the new setting", () => [50, 0]);
write(SET, "setSetting", "auto-start", "auto_start reaches the login item code", () => [
  "auto_start",
  "true",
]);
write(SET, "getSetting", "after-auto-start", "reads back auto_start", () => ["auto_start"]);
write(SET, "setSetting", "hidden-queues", "a list value", (v) => [
  "hidden_queues",
  String(v.queue),
]);
write(
  SET,
  "getMatchFilterOptions",
  "queues-hidden",
  "the filter options with a queue hidden",
  () => [],
);
write(SET, "getStoredQueues", "queues-stored", "stored queues ignore the hidden list", () => []);

const BAK = "backup";
write(BAK, "listBackups", "before", "backups before creating one");
write(BAK, "createBackup", "create", "a manual backup", () => [], {
  files: (_v, outcome) =>
    outcome.kind === "value" && (outcome.result as { backup?: { file?: string } }).backup?.file
      ? [`$RUN/backups/${(outcome.result as { backup: { file: string } }).backup.file}`]
      : [],
});
write(BAK, "listBackups", "after", "the new backup is listed");
write(BAK, "getMatchDetail", "pre-restore", "a game before the restore", (v) => [v.gameId]);
write(BAK, "restoreBackup", "restore", "restore the backup just made", (_v, prior) => {
  const created = prior.create;
  const file =
    created?.kind === "value"
      ? (created.result as { backup?: { file?: string } }).backup?.file
      : "";
  return [file ?? ""];
});
write(BAK, "listBackups", "after-restore", "restore adds a pre-restore snapshot");
write(BAK, "restoreBackup", "missing", "a backup file that does not exist", () => [
  "no-such-backup.db",
]);
write(BAK, "restoreBackup", "traversal", "a path outside the backups folder", () => [
  "../matches.db",
]);
write(BAK, "getRecoveryReport", "after", "no recovery report after a restore");

const DATA = "data-transfer";
write(DATA, "exportData", "cancelled", "the save dialog is dismissed", () => [], {
  dialogs: { save: null },
});
write(DATA, "exportData", "export", "export to a file", () => [], {
  dialogs: { save: "$RUN/export.json" },
  files: () => ["$RUN/export.json"],
});
write(DATA, "importData", "cancelled", "the open dialog is dismissed", () => [], {
  dialogs: { open: null },
});
write(DATA, "importData", "same-file", "import the file just exported", () => [], {
  dialogs: { open: "$RUN/export.json" },
});
write(DATA, "importData", "not-json", "a file that is not JSON", () => [], {
  dialogs: { open: "$RUN/not-json.json" },
  prepare: (run) => Bun.write(`${run}/not-json.json`, "this is not json"),
});
write(DATA, "importData", "wrong-shape", "JSON that is not a backup", () => [], {
  dialogs: { open: "$RUN/wrong-shape.json" },
  prepare: (run) => Bun.write(`${run}/wrong-shape.json`, '{"hello":"world"}'),
});
write(DATA, "getMatchHistory", "after-imports", "the list after the imports", () => [5, 0]);

const REPAIR = "repair";
write(REPAIR, "getAllSummonerPuuids", "before", "accounts before the repair");
write(REPAIR, "repairPuuids", "run", "repair on the fixture");
write(REPAIR, "getAllSummonerPuuids", "after", "accounts after the repair");
write(REPAIR, "listBackups", "after", "the repair takes a pre-repair snapshot");

const CARD = "export-card";
write(
  CARD,
  "exportCardImage",
  "cancelled",
  "the save dialog is dismissed",
  (v) => [{ kind: "game", gameId: v.gameId }],
  { dialogs: { save: null } },
);
write(
  CARD,
  "exportCardImage",
  "game",
  "a game card to a file",
  (v) => [{ kind: "game", gameId: v.gameId }],
  {
    dialogs: { save: "$RUN/game-card.png" },
    files: () => ["$RUN/game-card.png"],
  },
);
write(
  CARD,
  "exportCardImage",
  "season",
  "a season card to a file",
  (v) => [
    {
      kind: "season",
      seasonId: v.olderSeason,
      queue: v.queue,
      account: v.account,
      hideFriends: true,
    },
  ],
  {
    dialogs: { save: "$RUN/season-card.png" },
    files: () => ["$RUN/season-card.png"],
  },
);
write(CARD, "copyCardImage", "game", "a game card to the clipboard", (v) => [
  { kind: "game", gameId: v.gameId },
]);

const WINDOW = "window";
write(WINDOW, "isWindowMaximized", "before", "window starts unmaximized");
write(WINDOW, "toggleMaximizeWindow", "maximize", "maximize");
write(WINDOW, "isWindowMaximized", "maximized", "reports maximized");
write(WINDOW, "toggleMaximizeWindow", "restore", "restore");
write(WINDOW, "isWindowMaximized", "restored", "reports restored");
write(WINDOW, "minimizeWindow", "minimize", "minimize");

const CLOSE = "window-close";
write(CLOSE, "closeWindow", "close", "close hides to tray or quits");

export const IPC_CASES: readonly IpcCase[] = list;

export const WRITE_GROUPS = [...new Set(list.map((c) => c.group).filter((g) => g !== READ))];
export { READ as READ_GROUP };
