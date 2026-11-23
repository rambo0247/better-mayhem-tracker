// What trunk Electron answers for the stats, trends and records queries when
// `INTEGER` columns hold fractions, for the `hostile_fixture` test in
// tauri/src-tauri/src/db/stats.rs. better-sqlite3 returns an INTEGER and a
// REAL as the same kind of number, so Electron sums them without complaint.
// The data is a copy of the fixture with SQL applied before either app opens it.
//
//   bun parity/t14/record-hostile.ts --data <fixture folder> --out <hostile.json>
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startElectron } from "../run-electron.ts";

const args = process.argv.slice(2);
const value = (flag: string) => args[args.indexOf(flag) + 1];
const data = value("--data");
const out = value("--out");
if (!data || !out) throw new Error("usage: record-hostile.ts --data <fixture folder> --out <file>");

// Each column lands on a different slice of games, so a sum mixes integers and fractions
const HOSTILE_SQL = `
  UPDATE games SET game_duration = game_duration + 0.25 WHERE game_id % 11 = 0;
  UPDATE games SET game_duration = 1500.25 WHERE game_id IN (SELECT game_id FROM games ORDER BY game_creation DESC LIMIT 1 OFFSET 3);
  UPDATE player_stats SET win = win - 0.5 WHERE game_id % 19 = 0 AND win = 1;
  UPDATE player_stats SET kills = kills + 0.5 WHERE game_id % 13 = 0;
  UPDATE player_stats SET deaths = deaths + 0.25 WHERE game_id % 17 = 0;
  UPDATE player_stats SET assists = assists + 0.75 WHERE game_id % 23 = 0;
  UPDATE player_stats SET double_kills = double_kills + 0.5 WHERE game_id % 29 = 0;
  UPDATE player_stats SET triple_kills = triple_kills + 0.5 WHERE game_id % 31 = 0;
  UPDATE player_stats SET quadra_kills = quadra_kills + 0.5 WHERE game_id % 37 = 0;
  UPDATE player_stats SET penta_kills = penta_kills + 0.5 WHERE game_id % 41 = 0;
  UPDATE player_stats SET total_damage_dealt = total_damage_dealt + 0.5 WHERE game_id % 7 = 0;
  UPDATE player_stats SET total_damage_taken = total_damage_taken + 0.5 WHERE game_id % 5 = 0;
  UPDATE player_stats SET gold_earned = gold_earned + 0.5 WHERE game_id % 3 = 0;
  UPDATE player_stats SET total_heal = total_heal + 0.5 WHERE game_id % 2 = 0;
  UPDATE player_stats SET largest_killing_spree = largest_killing_spree + 0.5 WHERE game_id % 43 = 0;
  UPDATE match_participants SET win = win - 0.5 WHERE game_id % 19 = 0 AND win = 1;
  UPDATE match_participants SET kills = kills + 0.5 WHERE game_id % 13 = 0;
  UPDATE match_participants SET deaths = deaths + 0.25 WHERE game_id % 17 = 0;
  UPDATE match_participants SET assists = assists + 0.75 WHERE game_id % 23 = 0;
  UPDATE match_participants SET double_kills = double_kills + 0.5 WHERE game_id % 29 = 0;
  UPDATE match_participants SET triple_kills = triple_kills + 0.5 WHERE game_id % 31 = 0;
  UPDATE match_participants SET quadra_kills = quadra_kills + 0.5 WHERE game_id % 37 = 0;
  UPDATE match_participants SET penta_kills = penta_kills + 0.5 WHERE game_id % 41 = 0;
  UPDATE match_participants SET total_damage_dealt = total_damage_dealt + 0.5 WHERE game_id % 7 = 0;
  UPDATE match_participants SET total_damage_taken = total_damage_taken + 0.5 WHERE game_id % 5 = 0;
  UPDATE match_participants SET gold_earned = gold_earned + 0.5 WHERE game_id % 3 = 0;
  UPDATE match_participants SET total_heal = total_heal + 0.5 WHERE game_id % 2 = 0;
`;

const copy = fs.mkdtempSync(path.join(os.tmpdir(), "bmt-t14-hostile-"));
fs.cpSync(data, copy, { recursive: true });
const db = new Database(path.join(copy, "data", "matches.db"));
db.exec(HOSTILE_SQL);
const reals = (
  db
    .query(
      `SELECT (SELECT COUNT(*) FROM games WHERE typeof(game_duration) = 'real')
            + (SELECT COUNT(*) FROM player_stats WHERE typeof(kills) = 'real' OR typeof(win) = 'real')
            + (SELECT COUNT(*) FROM match_participants WHERE typeof(kills) = 'real' OR typeof(win) = 'real') AS n`,
    )
    .get() as { n: number }
).n;
if (reals === 0) throw new Error("the SQL stored no fractions");
db.close();

const run = await startElectron({ data: copy });

/** One `window.api` call, answered as JSON text so no double loses a digit in transit. */
async function call(method: string, callArgs: unknown[]): Promise<string> {
  return (await run.page.evaluate(
    async ([m, a]) => {
      try {
        return "ok:" + JSON.stringify(await (window as any).api[m as string](...(a as unknown[])));
      } catch (e) {
        return "error:" + String(e);
      }
    },
    [method, callArgs] as const,
  )) as string;
}

interface Case {
  method: string;
  args: unknown[];
  result: string;
}
const cases: Case[] = [];
const record = async (method: string, callArgs: unknown[]) => {
  cases.push({ method, args: callArgs, result: await call(method, callArgs) });
};

try {
  const filters = JSON.parse((await call("getMatchFilterOptions", [])).slice(3)) as {
    patches: string[];
    accounts: { puuid: string }[];
  };
  const owner = JSON.parse((await call("getChampionStats", [])).slice(3)) as {
    champion_id: number;
  }[];
  const global = JSON.parse((await call("getGlobalStats", [])).slice(3)) as {
    champions: { champion_id: number }[];
  };
  const patch = filters.patches[0]!;
  const account = filters.accounts[0]!.puuid;
  const scopes = [undefined, patch, ""];
  const queues = [undefined, 2400, 2450];
  for (const p of scopes)
    for (const q of queues) {
      await record("getChampionStats", [p, q]);
      await record("getAugmentStatsDetailed", [p, q]);
      await record("getGlobalStats", [p, q]);
    }
  for (const champion of [undefined, ...owner.map((c) => c.champion_id)]) {
    await record("getAugmentStats", [champion]);
    await record("getAugmentStats", [champion, patch, 2400]);
  }
  await record("getDashboard", []);
  for (const scope of [{ queue: 2400 }, { patch }, { account }, { season: "set-3" }]) {
    await record("getDashboard", [scope]);
  }
  for (const champion of owner) {
    await record("getDashboard", [{ championId: champion.champion_id }]);
    await record("getChampionItemStats", [champion.champion_id]);
    await record("getChampionItemStats", [champion.champion_id, patch, 2400]);
  }
  for (const champion of global.champions) {
    await record("getGlobalChampionDetail", [champion.champion_id]);
  }
  for (const q of queues) {
    await record("getTrends", [q]);
    for (const a of [undefined, account, ""]) await record("getRecords", [q, a]);
  }
} finally {
  await run.close();
}
fs.rmSync(copy, { recursive: true, force: true });
fs.writeFileSync(out, JSON.stringify({ sql: HOSTILE_SQL, reals, cases }));
console.log(`recorded ${cases.length} calls over ${reals} fractional rows`);
