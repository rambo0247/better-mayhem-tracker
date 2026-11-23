import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { auditFailed, auditFixture, type HitKind } from "../audit.ts";
import { buildFixture } from "../fixture.ts";
import {
  buildSnapshot,
  FRIEND,
  HANGUL,
  ME,
  PEOPLE,
  RIVAL,
  scratchDir,
  SHORT,
} from "./anonymize-fixture.ts";

const snapshot = buildSnapshot(scratchDir("audit-snap"));
const fixture = path.join(scratchDir("audit-fix"), "fixture");
const built = buildFixture({ from: snapshot, out: fixture, realRoots: [] });

function planted(plant: (dir: string, db: Database) => void) {
  const dir = path.join(scratchDir("audit-plant"), "fixture");
  fs.cpSync(fixture, dir, { recursive: true });
  const db = new Database(path.join(dir, "data", "matches.db"));
  plant(dir, db);
  db.close();
  return auditFixture(dir, snapshot, []);
}

const writeJson = (dir: string, relative: string, edit: (json: any) => void) => {
  const file = path.join(dir, relative);
  const json = JSON.parse(fs.readFileSync(file, "utf8"));
  edit(json);
  fs.writeFileSync(file, JSON.stringify(json));
};

test("the built fixture passes the audit, Riot static names included", () => {
  expect(built.audit.hits).toEqual({});
  expect(built.audit.searched.files).toBe(6);
  expect(auditFixture(fixture, snapshot, []).hits).toEqual({});
});

const PLANTS: [string, HitKind, (dir: string, db: Database) => void][] = [
  [
    "a name in payload free text",
    "real name",
    (_dir, db) => {
      const row = db.query("SELECT raw_gz FROM games WHERE game_id = 100").get() as any;
      const raw = JSON.parse(zlib.gunzipSync(row.raw_gz).toString());
      raw.note = `rematch ${RIVAL.name.toUpperCase()} soon`;
      db.run("UPDATE games SET raw_gz = ? WHERE game_id = 100", [
        zlib.gzipSync(JSON.stringify(raw)),
      ]);
    },
  ],
  [
    "a two-letter name in a table the anonymizer has never seen",
    "real name",
    (_dir, db) => {
      db.run("CREATE TABLE notes (body TEXT)");
      db.run("INSERT INTO notes VALUES (?)", [`gg ${SHORT.name}`]);
    },
  ],
  [
    "a Hangul name in a setting value",
    "real name",
    (_dir, db) => db.run("INSERT INTO settings VALUES ('greeting', ?)", [`${HANGUL.name}님`]),
  ],
  [
    "a name in another gzipped blob",
    "real name",
    (_dir, db) => {
      db.run("CREATE TABLE extra (body BLOB)");
      db.run("INSERT INTO extra VALUES (?)", [zlib.gzipSync(`with ${FRIEND.name}`)]);
    },
  ],
  [
    "a tag line in a name#tag form",
    "real tag line in a name#tag form",
    (_dir, db) => db.run("INSERT INTO settings VALUES ('pinned', ?)", [`Stranger#${FRIEND.tag}`]),
  ],
  [
    "a tag line in an identity column",
    "real name or tag line in an identity field",
    (_dir, db) => db.run("UPDATE match_participants SET tag_line = ? WHERE rowid = 1", [RIVAL.tag]),
  ],
  [
    "a summoner id in an identity column",
    "real account or summoner id in an identity field",
    (_dir, db) => db.run("UPDATE summoner SET summoner_id = 7000"),
  ],
  [
    "a PUUID in a JSON key",
    "real PUUID",
    (_dir, db) =>
      db.run("UPDATE challenge_state SET payload = ?", [JSON.stringify({ [ME.puuid]: 1 })]),
  ],
  [
    "a PUUID in a Riot static file",
    "real PUUID",
    (dir) => writeJson(dir, "data/champion-cache.json", (json) => (json.owner = ME.puuid)),
  ],
  [
    "a PUUID that breaks a Riot static file's JSON",
    "real PUUID",
    (dir) => fs.appendFileSync(path.join(dir, "asset-cache/16.1/aaaa.json"), `,"${ME.puuid}"`),
  ],
  [
    "a PUUID in image bytes",
    "real PUUID",
    (dir) => fs.appendFileSync(path.join(dir, "asset-cache/16.1/bbbb.png"), ME.puuid),
  ],
  [
    "a name in a file name",
    "real name",
    (dir) =>
      fs.writeFileSync(path.join(dir, "asset-cache/16.1", `${FRIEND.name.toLowerCase()}.png`), ""),
  ],
  [
    "a name in a text file",
    "real name",
    (dir) => fs.writeFileSync(path.join(dir, "notes.txt"), `ask ${RIVAL.name}`),
  ],
  [
    "an identity field in a Riot static file",
    "identity field in a Riot static file",
    (dir) =>
      writeJson(dir, "asset-cache/16.1/aaaa.json", (json) => json.push({ gameName: "Nobody" })),
  ],
  [
    "a Riot static file that changed",
    "Riot static file that differs from the snapshot",
    (dir) => writeJson(dir, "data/augment-icon-cache.json", (json) => (json["1"] = null)),
  ],
  [
    "a journal beside the database",
    "journal file or free pages beside a database",
    (dir) => fs.writeFileSync(path.join(dir, "data", "matches.db-wal"), ""),
  ],
  [
    "free pages in the database",
    "journal file or free pages beside a database",
    (_dir, db) => {
      db.run("PRAGMA secure_delete = OFF");
      db.run("CREATE TABLE filler (body TEXT)");
      db.run("INSERT INTO filler VALUES (?)", ["x".repeat(200_000)]);
      db.run("DROP TABLE filler");
    },
  ],
  [
    "a blob that does not decode",
    "blob that does not decode",
    (_dir, db) => db.run("UPDATE games SET raw_gz = ? WHERE game_id = 101", [Buffer.from("raw")]),
  ],
];

describe("the audit fails on a planted hit of each kind", () => {
  for (const [label, kind, plant] of PLANTS) {
    test(label, () => {
      const result = planted(plant);
      expect(auditFailed(result)).toBe(true);
      expect(result.hits[kind]).toBeGreaterThan(0);
      for (const line of result.locations) {
        for (const person of PEOPLE) {
          expect(line).not.toContain(person.puuid);
          if (person !== SHORT) expect(line.toLowerCase()).not.toContain(person.name.toLowerCase());
        }
      }
    });
  }
});

test("buildFixture deletes a fixture that fails its audit", () => {
  const source = buildSnapshot(scratchDir("audit-bad-snap"));
  writeJson(source, "asset-cache/16.1/aaaa.json", (json) => json.push({ puuid: ME.puuid }));
  const out = path.join(scratchDir("audit-bad-fix"), "fixture");
  expect(() => buildFixture({ from: source, out, realRoots: [] })).toThrow(
    /failed its audit and was deleted/,
  );
  expect(fs.existsSync(out)).toBe(false);
});
