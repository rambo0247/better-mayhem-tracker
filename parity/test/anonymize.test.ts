import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { anonymizeDatabase } from "../anonymize.ts";
import { auditFixture } from "../audit.ts";

const ME = { name: "Quillfeather", tag: "NA1", puuid: "11111111-aaaa-4bbb-8ccc-222222222222" };
const FRIEND = { name: "Marrowbone", tag: "0042", puuid: "33333333-aaaa-4bbb-8ccc-444444444444" };
const RIVAL = { name: "Sundial Kid", tag: "EUW", puuid: "55555555-aaaa-4bbb-8ccc-666666666666" };
const BOT = "00000000-0000-0000-0000-000000000000";

const people = [ME, FRIEND, RIVAL];

function payload(gameId: number, order: typeof people) {
  return {
    gameId,
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
        matchHistoryUri: `/v1/stats/${8000 + i}`,
      },
    })),
    note: `Played with ${FRIEND.name}`,
  };
}

function build(file: string) {
  const db = new Database(file);
  db.run(`CREATE TABLE games (game_id INTEGER PRIMARY KEY, queue_id INTEGER, game_creation INTEGER,
    is_remake INTEGER DEFAULT 0, puuid TEXT, favorite INTEGER DEFAULT 0, raw_gz BLOB)`);
  db.run(`CREATE TABLE match_participants (game_id INTEGER, participant_id INTEGER, puuid TEXT,
    game_name TEXT, tag_line TEXT)`);
  db.run(`CREATE TABLE summoner (puuid TEXT PRIMARY KEY, game_name TEXT, tag_line TEXT,
    summoner_id INTEGER, account_id INTEGER)`);
  db.run("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const orders = [people, [FRIEND, ME, RIVAL], [ME, RIVAL, { ...FRIEND, puuid: BOT }]];
  orders.forEach((order, index) => {
    const gameId = 100 + index;
    db.run("INSERT INTO games VALUES (?, 2400, ?, 0, ?, 0, ?)", [
      gameId,
      1_700_000_000 + index,
      ME.puuid,
      zlib.gzipSync(JSON.stringify(payload(gameId, order as typeof people))),
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
  db.close();
}

function scratchDb(name: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bmt-anon-"));
  return path.join(dir, name);
}

function allText(file: string): string[] {
  const db = new Database(file, { readonly: true });
  const out: string[] = [];
  const tables = db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as any[];
  for (const { name } of tables) {
    for (const row of db.query(`SELECT * FROM ${name}`).all() as Record<string, unknown>[]) {
      for (const value of Object.values(row)) {
        if (typeof value === "string") out.push(value);
        else if (value instanceof Uint8Array) out.push(zlib.gunzipSync(value).toString());
      }
    }
  }
  db.close();
  return out;
}

test("no original name or PUUID remains in a table, a payload, or the file", () => {
  const original = scratchDb("original.db");
  build(original);
  const anonymized = scratchDb("anonymized.db");
  fs.copyFileSync(original, anonymized);
  anonymizeDatabase(anonymized);

  const text = allText(anonymized).join("\n");
  const bytes = fs.readFileSync(anonymized).toString("latin1");
  for (const person of people) {
    for (const needle of [person.name, person.puuid]) {
      expect(text).not.toContain(needle);
      expect(bytes).not.toContain(needle);
    }
  }
  expect(text).not.toContain("someone");
  expect(text).not.toContain("1.9.9");
  expect(text).not.toContain("/v1/stats/");
  expect(text).toContain(BOT);
  expect(auditFixture(anonymized, original).failures).toEqual([]);
});

test("the same input name maps to the same fake name in tables and payloads", () => {
  const file = scratchDb("same.db");
  build(file);
  anonymizeDatabase(file);
  const db = new Database(file, { readonly: true });

  const tableName = (
    db
      .query(
        "SELECT game_name n FROM match_participants WHERE game_id = 100 AND participant_id = 2",
      )
      .get() as any
  ).n;
  expect(tableName).not.toBe(FRIEND.name);
  const friendFake = (
    db
      .query(
        "SELECT game_name n FROM match_participants WHERE game_id = 101 AND participant_id = 1",
      )
      .get() as any
  ).n;

  for (const { game_id, raw_gz } of db.query("SELECT game_id, raw_gz FROM games").all() as any[]) {
    const raw = JSON.parse(zlib.gunzipSync(raw_gz).toString());
    const rows = db
      .query(
        "SELECT participant_id, game_name, tag_line, puuid FROM match_participants WHERE game_id = ?",
      )
      .all(game_id) as any[];
    for (const row of rows) {
      const identity = raw.participantIdentities[row.participant_id - 1].player;
      expect(identity.gameName).toBe(row.game_name);
      expect(identity.tagLine).toBe(row.tag_line);
      expect(identity.puuid).toBe(row.puuid);
    }
    expect(raw.note).toBe(`Played with ${friendFake}`);
  }

  expect(friendFake).toBe(tableName);
  const summoner = db.query("SELECT game_name, puuid FROM summoner").get() as any;
  const gamePuuid = (db.query("SELECT puuid FROM games LIMIT 1").get() as any).puuid;
  expect(summoner.puuid).toBe(gamePuuid);
  const version = (
    db.query("SELECT value FROM settings WHERE key = 'last_run_version'").get() as any
  ).value;
  expect(version).toBe("1.2.1");
  db.close();
});

test("two runs on the same input produce the same fixture", () => {
  const a = scratchDb("a.db");
  const b = scratchDb("b.db");
  build(a);
  fs.copyFileSync(a, b);
  anonymizeDatabase(a);
  anonymizeDatabase(b);
  expect(allText(a)).toEqual(allText(b));
});
