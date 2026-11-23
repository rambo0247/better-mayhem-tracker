// Scores every game in a data folder with the TypeScript opScore and writes
// each player's score with the inputs it came from, for
// tauri/src-tauri/tests/score_golden.rs. Runs under Node, which runs opScore
// on V8 as Electron's main process does:
//
//   node parity/score-golden.ts --data <folder holding data/matches.db> --out <file.json>
//   node parity/score-golden.ts --data <folder> --bench 10
//
// The database is copied to a temp folder first, so the source is never
// opened. With --bench, prints the time to score every game, once per run.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  SCORE_FORMULA_VERSION,
  computeMatchScores,
  type ChampionClassMap,
  type ScoreInput,
} from "../src/shared/opScore.ts";

const SCORE_ROW_COLUMNS = `participant_id, puuid, team_id, champion_id, win,
       kills, deaths, assists, double_kills, triple_kills, quadra_kills, penta_kills,
       total_damage_dealt, total_damage_taken, gold_earned, total_heal`;

interface ScoreRow {
  game_id: number;
  participant_id: number;
  puuid: string | null;
  team_id: number;
  champion_id: number;
  win: number;
  kills: number;
  deaths: number;
  assists: number;
  double_kills: number;
  triple_kills: number;
  quadra_kills: number;
  penta_kills: number;
  total_damage_dealt: number;
  total_damage_taken: number;
  gold_earned: number;
  total_heal: number;
}

interface GameRow {
  game_id: number;
  puuid: string;
  is_remake: number;
  champion_id: number;
  kills: number;
  deaths: number;
  assists: number;
}

/** The f64's bits as 16 hex digits, so a reader compares bits and not printed decimals. */
export function bits(x: number): string {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  return view.getBigUint64(0).toString(16).padStart(16, "0");
}

function toInput(r: ScoreRow): ScoreInput & { puuid: string | null } {
  return {
    participantId: r.participant_id,
    teamId: r.team_id,
    puuid: r.puuid,
    championId: r.champion_id,
    kills: r.kills,
    deaths: r.deaths,
    assists: r.assists,
    doubleKills: r.double_kills,
    tripleKills: r.triple_kills,
    quadraKills: r.quadra_kills,
    pentaKills: r.penta_kills,
    totalDamageDealtToChampions: r.total_damage_dealt,
    totalDamageTaken: r.total_damage_taken,
    goldEarned: r.gold_earned,
    totalHeal: r.total_heal,
    win: r.win === 1,
  };
}

/** `getChampionClasses()` over `champion-cache.json`, as Electron hydrates it offline. */
export function championClasses(cacheFile: string): { version: string; classes: ChampionClassMap } {
  const cached = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
  const classes: ChampionClassMap = {};
  for (const [id, champ] of Object.entries(cached.champions) as [string, any][]) {
    if (champ.class) classes[Number(id)] = champ.class;
  }
  return { version: cached.version, classes };
}

function readData(dataRoot: string) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bmt-score-golden-"));
  try {
    const copy = path.join(tmp, "matches.db");
    fs.copyFileSync(path.join(dataRoot, "data", "matches.db"), copy);
    const db = new DatabaseSync(copy, { readOnly: true });
    const games = db
      .prepare(
        `SELECT g.game_id, g.puuid, g.is_remake, ps.champion_id, ps.kills, ps.deaths, ps.assists
         FROM games g JOIN player_stats ps ON g.game_id = ps.game_id ORDER BY g.game_id`,
      )
      .all() as unknown as GameRow[];
    const rows = db
      .prepare(`SELECT game_id, ${SCORE_ROW_COLUMNS} FROM match_participants`)
      .all() as unknown as ScoreRow[];
    db.close();
    const byGame = new Map<number, ScoreRow[]>();
    for (const row of rows) {
      const list = byGame.get(row.game_id);
      if (list) list.push(row);
      else byGame.set(row.game_id, [row]);
    }
    return { games, byGame };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** The owner by puuid, else by champion and KDA, as computeOwnerScore finds it. */
function ownerOf(game: GameRow, rows: ScoreRow[]): ScoreRow | undefined {
  const puuid = game.puuid || null;
  return (
    (puuid ? rows.find((r) => r.puuid === puuid) : undefined) ??
    rows.find(
      (r) =>
        r.champion_id === game.champion_id &&
        r.kills === game.kills &&
        r.deaths === game.deaths &&
        r.assists === game.assists,
    )
  );
}

function scoreAll(
  games: GameRow[],
  byGame: Map<number, ScoreRow[]>,
  classes: ChampionClassMap,
): number {
  let scored = 0;
  for (const game of games) {
    const rows = byGame.get(game.game_id) ?? [];
    if (game.is_remake || rows.length === 0) continue;
    scored += computeMatchScores(rows.map(toInput), classes).size;
  }
  return scored;
}

function main() {
  const args = process.argv.slice(2);
  const value = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
  const data = value("--data");
  const out = value("--out");
  const bench = value("--bench");
  if (!data || (!out && !bench)) {
    console.error(
      "usage: node parity/score-golden.ts --data <folder> (--out <file.json> | --bench <runs>)",
    );
    process.exit(2);
  }
  const { version, classes } = championClasses(path.join(data, "data", "champion-cache.json"));
  const { games, byGame } = readData(data);

  if (bench) {
    for (let run = 0; run < Number(bench); run++) {
      const start = process.hrtime.bigint();
      const scored = scoreAll(games, byGame, classes);
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      console.log(`ts run=${run} games=${games.length} players=${scored} ms=${ms.toFixed(3)}`);
    }
    return;
  }

  const result = games.map((game) => {
    const rows = byGame.get(game.game_id) ?? [];
    const scores = computeMatchScores(rows.map(toInput), classes);
    const owner = game.is_remake ? undefined : ownerOf(game, rows);
    const players = rows.map((row) => {
      const s = scores.get(row.participant_id)!;
      return { ...row, score: s.score, raw: s.raw, rawBits: bits(s.raw), badge: s.badge };
    });
    const ownerScore = owner ? scores.get(owner.participant_id) : undefined;
    return {
      game_id: game.game_id,
      is_remake: game.is_remake,
      owner: ownerScore
        ? {
            participant_id: owner!.participant_id,
            score: ownerScore.score,
            scoreBits: bits(ownerScore.score),
            raw: ownerScore.raw,
            rawBits: bits(ownerScore.raw),
            badge: ownerScore.badge,
          }
        : null,
      players,
    };
  });

  fs.writeFileSync(
    out!,
    JSON.stringify(
      {
        format: 1,
        runtime: `node ${process.version} v8 ${process.versions.v8}`,
        scoreFormulaKey: `${SCORE_FORMULA_VERSION}@${version}`,
        games: result,
      },
      null,
      1,
    ),
  );
  console.log(`wrote ${result.length} games to ${out}`);
}

main();
