import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { anonymizeDatabase } from "../anonymize.ts";
import { auditFailed, auditFixture } from "../audit.ts";
import {
  BLOOM,
  BOT,
  buildDatabase,
  buildSnapshot,
  FRIEND,
  HANGUL,
  LOOKALIKE,
  ME,
  PEOPLE,
  RIVAL,
  scratchDir,
  SHORT,
} from "./anonymize-fixture.ts";

function anonymizedCopy(label: string) {
  const dir = scratchDir(label);
  const original = path.join(dir, "original.db");
  buildDatabase(original);
  const anonymized = path.join(dir, "anonymized.db");
  fs.copyFileSync(original, anonymized);
  return { original, anonymized, summary: anonymizeDatabase(anonymized) };
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

const payloadOf = (file: string, gameId: number) => {
  const db = new Database(file, { readonly: true });
  const row = db.query("SELECT raw_gz FROM games WHERE game_id = ?").get(gameId) as any;
  db.close();
  return JSON.parse(zlib.gunzipSync(row.raw_gz).toString());
};
const one = (file: string, sql: string) => {
  const db = new Database(file, { readonly: true });
  const row = db.query(sql).get() as Record<string, unknown>;
  db.close();
  return Object.values(row)[0];
};

test("no real name, tag line or PUUID survives in a table, a payload, a setting, or the file", () => {
  const { anonymized } = anonymizedCopy("anon");
  const text = allText(anonymized).join("\n");
  const bytes = fs.readFileSync(anonymized).toString("latin1");
  const words = text.toLowerCase().replaceAll("mapskin_map12_bloom", "");
  for (const person of PEOPLE) {
    if (person !== SHORT) expect(words).not.toContain(person.name.toLowerCase());
    expect(text).not.toContain(person.puuid);
    expect(bytes).not.toContain(person.puuid);
    expect(text).not.toContain(`#${person.tag}`);
  }
  expect(text).not.toMatch(/\bal\b/i);
  expect(text).not.toContain("someone");
  expect(text).not.toContain("1.9.9");
  expect(text).not.toContain("/v1/stats/");
  expect(text).toContain(BOT);
});

test("names are scrubbed where they are names and kept where they are game words", () => {
  const { anonymized } = anonymizedCopy("words");
  const raw = payloadOf(anonymized, 100);
  expect(raw.note).toMatch(/^Played with \w+, gg \w+, also \w+님 and \w+#Z\d{3}$/);
  expect(raw.platformId).toBe("NA1");
  expect(raw.participantIdentities[0].player.platformId).toBe("NA1");
  expect(raw.gameVersion).toBe("16.23.4321.0042");
  expect(raw.gameModeMutators).toEqual(["mapskin_map12_bloom"]);
  expect(one(anonymized, "SELECT game_version FROM games WHERE game_id = 100")).toBe(
    "16.23.4321.0042",
  );
  const progress = one(anonymized, "SELECT name FROM challenge_game_progress") as string;
  expect(progress).toMatch(/^\w+ Where Planted$/);
  expect(progress).not.toContain(BLOOM.name);
  expect(one(anonymized, "SELECT description FROM challenge_game_progress")).toMatch(
    /^Win with \w+ on your team$/,
  );
});

test("the same input name maps to the same fake in tables, payloads, settings and text", () => {
  const { anonymized } = anonymizedCopy("same");
  const db = new Database(anonymized, { readonly: true });
  const fakeOf = (gameId: number, participant: number) =>
    db
      .query(
        "SELECT game_name, tag_line FROM match_participants WHERE game_id = ? AND participant_id = ?",
      )
      .get(gameId, participant) as { game_name: string; tag_line: string };
  const friend = fakeOf(100, 2);
  const rival = fakeOf(100, 3);
  expect(friend.game_name).not.toBe(FRIEND.name);
  expect(fakeOf(101, 1)).toEqual(friend);

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
    expect(raw.note).toStartWith(`Played with ${friend.game_name}, `);
    expect(raw.note).toEndWith(` and ${rival.game_name}#${rival.tag_line}`);
  }

  const pinned = db.query("SELECT value FROM settings WHERE key = 'pinned_friend'").get() as any;
  expect(pinned.value).toBe(`${friend.game_name}#${friend.tag_line}`);
  const summoner = db.query("SELECT game_name, puuid FROM summoner").get() as any;
  const gamePuuid = (db.query("SELECT puuid FROM games LIMIT 1").get() as any).puuid;
  expect(summoner.puuid).toBe(gamePuuid);
  const challenge = JSON.parse(
    (db.query("SELECT payload FROM challenge_state").get() as any).payload,
  );
  expect(challenge.player.puuid).toBe(summoner.puuid);
  expect(challenge.player.title).toBe(`${summoner.game_name}'s title`);
  expect(Object.keys(payloadOf(anonymized, 100).scores)).toEqual([summoner.puuid]);
  const version = db
    .query("SELECT value FROM settings WHERE key = 'last_run_version'")
    .get() as any;
  expect(version.value).toBe("1.2.1");
  db.close();
});

test("a name matched through Unicode case folding still finds its fake", () => {
  const dir = scratchDir("fold");
  const file = path.join(dir, "fold.db");
  buildDatabase(file);
  const db = new Database(file);
  db.run("INSERT INTO settings VALUES ('long_s', ?)", [`gg ${RIVAL.name.replace("S", "\u017f")}`]);
  db.close();
  anonymizeDatabase(file);
  const rival = one(
    file,
    "SELECT game_name FROM match_participants WHERE game_id = 100 AND participant_id = 3",
  ) as string;
  expect(one(file, "SELECT value FROM settings WHERE key = 'long_s'")).toBe(`gg ${rival}`);
});

test("no fake value is itself a real name or tag line", () => {
  const { anonymized } = anonymizedCopy("lookalike");
  const db = new Database(anonymized, { readonly: true });
  const fakes = db.query("SELECT DISTINCT game_name n FROM match_participants").all() as any[];
  db.close();
  const real = new Set(PEOPLE.flatMap((p) => [p.name.toLowerCase(), p.tag.toLowerCase()]));
  for (const { n } of fakes) expect(real.has(n.toLowerCase())).toBe(false);
  expect(fakes.map((r) => r.n)).not.toContain(LOOKALIKE.name);
});

test("two runs on the same input produce the same fixture", () => {
  const dir = scratchDir("twice");
  const a = path.join(dir, "a.db");
  const b = path.join(dir, "b.db");
  buildDatabase(a);
  fs.copyFileSync(a, b);
  anonymizeDatabase(a);
  anonymizeDatabase(b);
  expect(allText(a)).toEqual(allText(b));
});

test("a payload that will not decode is counted, logged, and emptied", () => {
  const dir = scratchDir("corrupt");
  const file = path.join(dir, "corrupt.db");
  buildDatabase(file);
  const db = new Database(file);
  db.run("UPDATE games SET raw_gz = ? WHERE game_id = 101", [Buffer.from(`not gzip ${ME.name}`)]);
  db.close();
  const errors = spyOn(console, "error").mockImplementation(() => {});
  const summary = anonymizeDatabase(file);
  const logged = errors.mock.calls.map((call) => String(call[0]));
  errors.mockRestore();
  expect(summary.corruptPayloads).toBe(1);
  expect(logged).toEqual([
    "anonymize: games.raw_gz row 101 would not decode (Z_DATA_ERROR) and is emptied",
  ]);
  const after = new Database(file, { readonly: true });
  const rows = after.query("SELECT game_id, raw_gz FROM games ORDER BY game_id").all() as any[];
  after.close();
  expect(rows.map((r) => r.raw_gz === null)).toEqual([false, true, false]);
  expect(fs.readFileSync(file).toString("latin1")).not.toContain(ME.name);
});

test("the audit passes on an anonymized fixture and fails on its source without printing a value", () => {
  const snapshot = buildSnapshot(scratchDir("snap"));
  const fixture = scratchDir("fix");
  fs.cpSync(snapshot, fixture, { recursive: true });
  anonymizeDatabase(path.join(fixture, "data", "matches.db"));
  const clean = auditFixture(fixture, snapshot, []);
  expect(clean.hits).toEqual({});
  expect(clean.searched.names).toBe(PEOPLE.length);

  const leaked = auditFixture(snapshot, snapshot, []);
  expect(auditFailed(leaked)).toBe(true);
  expect(Object.keys(leaked.hits).sort()).toEqual([
    "real PUUID",
    "real account or summoner id in an identity field",
    "real name",
    "real name or tag line in an identity field",
    "real tag line in a name#tag form",
  ]);
  for (const line of leaked.locations) {
    for (const person of PEOPLE) expect(line).not.toContain(person.puuid);
    for (const person of [ME, FRIEND, RIVAL, HANGUL, BLOOM, LOOKALIKE]) {
      expect(line.toLowerCase()).not.toContain(person.name.toLowerCase());
    }
  }
});
