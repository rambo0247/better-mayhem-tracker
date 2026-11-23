// Records what trunk Electron answers for every match query over a matrix of
// filters, sorts, pages and settings, for the `electron_matrix` test in
// tauri/src-tauri/src/db/matches.rs. Each variant runs on its own fresh copy
// of the data, after the variant's SQL; the cases call `window.api` in the
// renderer, so they take the real IPC path.
//
//   bun docs/tauri-port/units/T13/record-matrix.ts --data <fixture folder> --out <matrix.json>
//
// Also records Electron's week data (week-data.js) and its system locale.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { startElectron, type RunningElectron } from "../../../../parity/run-electron.ts";

const { collectWeekData } = require("./week-data.js") as { collectWeekData: () => unknown };

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

interface Case {
  variant: string;
  settings: Record<string, string>;
  method: string;
  args: Json[];
  result: Json;
}

const SECOND = "fa4e0000-0000-4000-8000-0000000000b2";

/** SQL each variant applies to its copy before either app opens it. */
const VARIANTS: Record<string, string> = {
  fixture: "",
  // A second account with no summoner row, games whose owner never
  // resolved, and an account whose icon only a game recorded
  accounts: `
    UPDATE games SET puuid = '${SECOND}' WHERE game_id IN (SELECT game_id FROM games ORDER BY game_creation DESC LIMIT 40 OFFSET 5);
    UPDATE match_participants SET puuid = '${SECOND}', game_name = 'Second', tag_line = 'B2', profile_icon = 4321
      WHERE (game_id, participant_id) IN (
        SELECT mp.game_id, mp.participant_id FROM match_participants mp JOIN games g ON g.game_id = mp.game_id
        WHERE g.puuid = '${SECOND}' AND mp.participant_id = 1);
    UPDATE games SET puuid = '' WHERE game_id IN (SELECT game_id FROM games ORDER BY game_creation LIMIT 7);
    UPDATE summoner SET profile_icon = NULL, tag_line = NULL;
    UPDATE games SET game_version = NULL WHERE game_id IN (SELECT game_id FROM games ORDER BY game_creation LIMIT 3 OFFSET 20);
    UPDATE games SET game_version = '' WHERE game_id IN (SELECT game_id FROM games ORDER BY game_creation LIMIT 2 OFFSET 30);
    UPDATE games SET favorite = 1 WHERE game_id IN (SELECT game_id FROM games ORDER BY game_creation LIMIT 4 OFFSET 100);
  `,
};

const SORTS = [
  "date",
  "kda",
  "kills",
  "duration",
  "score",
  "damageDealt",
  "damageTaken",
  "healing",
];
const MULTIKILLS = ["doubles", "triples", "quadras", "pentas"];
const GROUPINGS = ["day", "week", "patch", "none"];

function subsets<T>(items: T[]): T[][] {
  return items.reduce<T[][]>((all, item) => all.concat(all.map((s) => [...s, item])), [[]]);
}

/**
 * One `window.api` call. The answer crosses back as JSON text, because the
 * devtools protocol prints a returned double with fewer digits than it
 * needs and so moves it off its last bit.
 */
async function call(run: RunningElectron, method: string, args: Json[]): Promise<Json> {
  const text = (await run.page.evaluate(
    async ([m, a]) => JSON.stringify(await (window as any).api[m as string](...(a as unknown[]))),
    [method, args] as const,
  )) as string | undefined;
  return text === undefined ? null : (JSON.parse(text) as Json);
}

/**
 * A fractional number as `{ "$f64": <its bits in hex> }`, because serde_json
 * parses decimals to the nearest double only within an ulp.
 */
function exactFloats(_key: string, value: unknown): unknown {
  if (typeof value !== "number" || Number.isInteger(value)) return value;
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  return { $f64: view.getBigUint64(0).toString(16).padStart(16, "0") };
}

interface Week {
  locale: Json;
  weekStart: Json;
  data: Json;
}

/** Electron's week data and system locale, read in its main process. */
async function readWeek(run: RunningElectron): Promise<Week> {
  // Self-contained, so Playwright can ship its source to the main process
  const data = (await run.app.evaluate(collectWeekData)) as Json;
  const [locale, weekStart] = (await run.app.evaluate(({ app }) => {
    let tag: string | undefined;
    try {
      tag = Intl.getCanonicalLocales(app.getSystemLocale())[0];
    } catch {
      tag = undefined;
    }
    let day = 1;
    try {
      const resolved = new Intl.DateTimeFormat(tag).resolvedOptions().locale;
      day = (new Intl.Locale(resolved) as any).getWeekInfo().firstDay % 7;
    } catch {
      day = 1;
    }
    return [tag ?? null, day];
  })) as [Json, Json];
  return { locale, weekStart, data };
}

async function recordVariant(
  dataRoot: string,
  variant: string,
  sql: string,
): Promise<{ cases: Case[]; week: Week }> {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), `bmt-t13-${variant}-`));
  fs.cpSync(dataRoot, copy, { recursive: true });
  if (sql) {
    const db = new Database(path.join(copy, "data", "matches.db"));
    db.exec(sql);
    db.close();
  }
  const run = await startElectron({ data: copy });
  const cases: Case[] = [];
  let week: Week | undefined;
  let settings: Record<string, string> = {};
  const record = async (method: string, args: Json[]) => {
    cases.push({ variant, settings: { ...settings }, method, args, result: await call(run, method, args) });
  };
  const set = async (key: string, value: string) => {
    await call(run, "setSetting", [key, value]);
    settings = { ...settings, [key]: value };
  };
  try {
    week = await readWeek(run);
    const options = (await call(run, "getMatchFilterOptions", [])) as {
      patches: string[];
      champions: number[];
      queues: number[];
      seasons: string[];
      accounts: { puuid: string }[];
    };
    const all = (await call(run, "getMatchHistory", [10000, 0])) as {
      matches: { game_id: number; champion_id: number }[];
    };
    const counts = new Map<number, number>();
    for (const m of all.matches) counts.set(m.champion_id, (counts.get(m.champion_id) ?? 0) + 1);
    const topChampions = [...counts].sort((a, b) => b[1] - a[1]).map(([id]) => id);
    const champion = topChampions[0]!;
    const patch = options.patches[0]!;
    const queue = options.queues[0]!;
    const account = options.accounts[0]!.puuid;
    const seasons = ["set-0", "set-1", "set-2", "set-3", "set-9"];

    const scopes: Record<string, Json>[] = [{}];
    for (const championId of [champion, topChampions[5]!, -1]) scopes.push({ championId });
    for (const p of [...options.patches, "", "0.0"]) scopes.push({ patch: p });
    for (const q of [queue, 2450]) scopes.push({ queue: q });
    for (const s of [...seasons, ""]) scopes.push({ season: s });
    for (const a of [...options.accounts.map((x) => x.puuid), "", "nobody"]) {
      scopes.push({ account: a });
    }
    // The cross product of one value per filter, every filter on or off
    for (const on of subsets(["championId", "patch", "queue", "season", "account"])) {
      if (on.length < 2) continue;
      const scope: Record<string, Json> = {};
      for (const key of on) {
        scope[key] = { championId: champion, patch, queue, season: "set-3", account }[key]!;
      }
      scopes.push(scope);
    }

    const historyFilters: Record<string, Json>[] = [...scopes];
    for (const multikills of subsets(MULTIKILLS)) historyFilters.push({ multikills });
    historyFilters.push({ favorites: true }, { favorites: false });
    historyFilters.push({ favorites: true, championId: champion, multikills: ["doubles"] });
    historyFilters.push({ season: "set-3", multikills: ["pentas", "quadras"], sortDir: "asc" });

    const settingsRounds: [string, string][][] = [
      [],
      [["hide_remakes", "true"]],
      [
        ["hide_remakes", "false"],
        ["hidden_queues", String(queue)],
      ],
      [["hidden_queues", "2450, abc,,0x10"]],
      [["hidden_queues", ""]],
    ];
    for (const round of settingsRounds) {
      for (const [key, value] of round) await set(key, value);
      for (const filters of historyFilters) await record("getMatchHistory", [50, 0, filters]);
      for (const sort of SORTS) {
        for (const sortDir of ["asc", "desc"]) {
          await record("getMatchHistory", [25, 0, { sort, sortDir }]);
          await record("getMatchHistory", [25, 600, { sort, sortDir }]);
        }
      }
      for (const [limit, offset] of [
        [50, 0],
        [50, 50],
        [10, 655],
        [10, 700],
        [10000, 0],
      ] as const) {
        await record("getMatchHistory", [limit, offset]);
      }
      for (const scope of scopes) await record("getMatchFilterOptions", [scope]);
      await record("getMatchFilterOptions", []);
      for (const grouping of GROUPINGS) {
        await set("session_grouping", grouping);
        for (const filters of historyFilters) await record("getMatchSessions", [filters]);
        await record("getMatchSessions", []);
      }
      await set("session_grouping", "day");
      for (const id of topChampions) await record("getChampionMatchHistory", [id, 50, 0]);
      for (const [p, q, s] of [
        [patch, undefined, undefined],
        [undefined, queue, undefined],
        [undefined, undefined, "set-3"],
        [patch, queue, "set-3"],
        ["", 2450, "set-9"],
      ] as const) {
        await record("getChampionMatchHistory", [champion, 5, 3, p ?? null, q ?? null, s ?? null]);
      }
      await record("getStoredQueues", []);
      await record("getAllSummonerPuuids", []);
      await record("getProfile", []);
    }

    for (const m of all.matches) await record("getMatchDetail", [m.game_id]);
    await record("getMatchDetail", [-1]);
    for (const id of [all.matches[0]!.game_id, all.matches[3]!.game_id, -1, all.matches[0]!.game_id]) {
      await record("toggleFavorite", [id]);
      await record("getMatchHistory", [50, 0, { favorites: true }]);
      await record("getMatchFilterOptions", [{}]);
    }
  } finally {
    await run.close();
    fs.rmSync(copy, { recursive: true, force: true });
  }
  return { cases, week: week! };
}

async function main() {
  const args = process.argv.slice(2);
  const value = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
  const data = value("--data");
  const out = value("--out");
  if (!data || !out) throw new Error("usage: record-matrix.ts --data <fixture folder> --out <file>");

  const cases: Case[] = [];
  const weeks: Week[] = [];
  for (const [variant, sql] of Object.entries(VARIANTS)) {
    console.log(`recording ${variant}`);
    const recorded = await recordVariant(data, variant, sql);
    cases.push(...recorded.cases);
    weeks.push(recorded.week);
  }
  const { locale, weekStart, data: week } = weeks[0]!;
  fs.writeFileSync(
    out,
    JSON.stringify({ locale, weekStart, variants: VARIANTS, week, cases }, exactFloats),
  );
  console.log(`wrote ${cases.length} cases to ${out}`);
}

await main();
