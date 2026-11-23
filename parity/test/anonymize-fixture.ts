import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fakeName } from "../anonymize.ts";
import { SNAPSHOT_MARKER } from "../snapshot.ts";

export interface Person {
  name: string;
  tag: string;
  puuid: string;
}

export const ME: Person = {
  name: "Quillfeather",
  tag: "NA1",
  puuid: "11111111-aaaa-4bbb-8ccc-222222222222",
};
export const FRIEND: Person = {
  name: "Marrowbone",
  tag: "0042",
  puuid: "33333333-aaaa-4bbb-8ccc-444444444444",
};
export const RIVAL: Person = {
  name: "Sundial Kid",
  tag: "EUW",
  puuid: "55555555-aaaa-4bbb-8ccc-666666666666",
};
/** A two-letter name, which is also the start of ordinary words. */
export const SHORT: Person = {
  name: "Al",
  tag: "4321",
  puuid: "77777777-aaaa-4bbb-8ccc-888888888888",
};
export const HANGUL: Person = {
  name: "홍길동",
  tag: "KR1",
  puuid: "99999999-aaaa-4bbb-8ccc-aaaaaaaaaaaa",
};
/** A real name that is also a word in game data. */
export const BLOOM: Person = {
  name: "Bloom",
  tag: "BLM",
  puuid: "bbbbbbbb-aaaa-4bbb-8ccc-cccccccccccc",
};
/** A real name that equals the first fake name the anonymizer would hand out. */
export const LOOKALIKE: Person = {
  name: fakeName(1),
  tag: "LKA",
  puuid: "dddddddd-aaaa-4bbb-8ccc-eeeeeeeeeeee",
};
export const BOT = "00000000-0000-0000-0000-000000000000";
export const PEOPLE = [ME, FRIEND, RIVAL, SHORT, HANGUL, BLOOM, LOOKALIKE];

export function scratchDir(label: string) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `bmt-${label}-`));
}

function payload(gameId: number, order: Person[]) {
  return {
    gameId,
    platformId: "NA1",
    gameVersion: "16.23.4321.0042",
    gameModeMutators: ["mapskin_map12_bloom"],
    participants: order.map((p, i) => ({ participantId: i + 1, puuid: p.puuid, teamId: 100 })),
    participantIdentities: order.map((p, i) => ({
      participantId: i + 1,
      player: {
        gameName: p.name,
        tagLine: p.tag,
        puuid: p.puuid,
        summonerName: p.name,
        summonerId: 7000 + i,
        accountId: 8000 + i,
        platformId: "NA1",
        matchHistoryUri: `/v1/stats/${8000 + i}`,
      },
    })),
    note: `Played with ${FRIEND.name}, gg al, also ${HANGUL.name}님 and ${RIVAL.name}#${RIVAL.tag}`,
    scores: { [ME.puuid]: 10 },
  };
}

/** A database shaped like the app's, holding every person above in tables, payloads and text. */
export function buildDatabase(file: string) {
  const db = new Database(file);
  db.run(`CREATE TABLE games (game_id INTEGER PRIMARY KEY, queue_id INTEGER, game_creation INTEGER,
    is_remake INTEGER DEFAULT 0, puuid TEXT, favorite INTEGER DEFAULT 0, game_version TEXT, raw_gz BLOB)`);
  db.run(`CREATE TABLE match_participants (game_id INTEGER, participant_id INTEGER, puuid TEXT,
    game_name TEXT, tag_line TEXT)`);
  db.run(`CREATE TABLE summoner (puuid TEXT PRIMARY KEY, game_name TEXT, tag_line TEXT,
    summoner_id INTEGER, account_id INTEGER)`);
  db.run("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  db.run("CREATE TABLE challenge_state (id INTEGER PRIMARY KEY, payload TEXT NOT NULL)");
  db.run("CREATE TABLE challenge_game_progress (game_id INTEGER, name TEXT, description TEXT)");
  const orders = [
    [ME, FRIEND, RIVAL, SHORT],
    [FRIEND, ME, HANGUL, BLOOM],
    [ME, RIVAL, LOOKALIKE, { ...FRIEND, puuid: BOT }],
  ];
  orders.forEach((order, index) => {
    const gameId = 100 + index;
    db.run("INSERT INTO games VALUES (?, 2400, ?, 0, ?, 0, '16.23.4321.0042', ?)", [
      gameId,
      1_700_000_000 + index,
      ME.puuid,
      zlib.gzipSync(JSON.stringify(payload(gameId, order))),
    ]);
    order.forEach((p, i) =>
      db.run("INSERT INTO match_participants VALUES (?, ?, ?, ?, ?)", [
        gameId,
        i + 1,
        p.puuid,
        p.name,
        p.tag,
      ]),
    );
  });
  db.run("INSERT INTO summoner VALUES (?, ?, ?, 7000, 8000)", [ME.puuid, ME.name, ME.tag]);
  db.run("INSERT INTO settings VALUES (?, '1')", [`backfill_complete_${ME.puuid}`]);
  db.run("INSERT INTO settings VALUES ('last_run_version', '1.9.9')");
  db.run("INSERT INTO settings VALUES ('auto_start_path', '/Users/someone/App.app')");
  db.run("INSERT INTO settings VALUES ('pinned_friend', ?)", [`${FRIEND.name}#${FRIEND.tag}`]);
  db.run("INSERT INTO challenge_state VALUES (1, ?)", [
    JSON.stringify({ player: { puuid: ME.puuid, title: `${ME.name}'s title` }, groups: [] }),
  ]);
  db.run("INSERT INTO challenge_game_progress VALUES (100, 'Bloom Where Planted', ?)", [
    `Win with ${SHORT.name} on your team`,
  ]);
  db.close();
}

export const STATIC_FILES: Record<string, string | Buffer> = {
  "data/champion-cache.json": JSON.stringify({
    version: "16.23.1",
    champions: { "1": { name: "Annie", key: "Annie" }, "2": { name: "Bloom", key: "Bloom" } },
  }),
  "data/augment-icon-cache.json": JSON.stringify({ "1341": "asset://game-data/a.png" }),
  "asset-cache/16.1/aaaa.json": JSON.stringify([{ id: 1, nameTRA: "Bloom" }]),
  "asset-cache/16.1/bbbb.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]),
};

/** A folder shaped like snapshot.ts output. */
export function buildSnapshot(dir: string) {
  fs.mkdirSync(path.join(dir, "data"), { recursive: true });
  fs.writeFileSync(path.join(dir, SNAPSHOT_MARKER), "test snapshot\n");
  buildDatabase(path.join(dir, "data", "matches.db"));
  for (const [relative, content] of Object.entries(STATIC_FILES)) {
    fs.mkdirSync(path.dirname(path.join(dir, relative)), { recursive: true });
    fs.writeFileSync(path.join(dir, relative), content);
  }
  return dir;
}
