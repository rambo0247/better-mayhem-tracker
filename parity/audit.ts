import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { identitiesOf } from "./anonymize.ts";
import { UUID_SOURCE } from "./lib/uuid.ts";

export interface AuditResult {
  searched: { names: number; tags: number; puuids: number };
  /** A real name or tag line in an identity field, or a real PUUID anywhere. These fail the audit. */
  failures: string[];
  /** A real name that is also a plain word in game text. Counted and not printed, since it is a coincidence. */
  wordCoincidences: number;
}

const UUID = new RegExp(UUID_SOURCE, "g");
const IDENTITY_COLUMN = /game_name|tag_line|summoner_name/;
const IDENTITY_KEYS = new Set([
  "gameName",
  "summonerName",
  "riotIdGameName",
  "internalName",
  "tagLine",
  "riotIdTagline",
  "riotIdTagLine",
]);

function* textValues(db: Database): Generator<{ where: string; column: string; text: string }> {
  const tables = db
    .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  for (const { name } of tables) {
    const columns = (db.query(`PRAGMA table_info("${name}")`).all() as { name: string }[]).map(
      (c) => c.name,
    );
    for (const row of db.query(`SELECT * FROM "${name}"`).iterate() as Iterable<
      Record<string, unknown>
    >) {
      for (const column of columns) {
        const value = row[column];
        if (typeof value === "string") yield { where: `${name}.${column}`, column, text: value };
        else if (value instanceof Uint8Array) {
          const text = zlibText(value);
          yield { where: `${name}.${column} (decoded)`, column: "", text };
        }
      }
    }
  }
}

function zlibText(blob: Uint8Array): string {
  try {
    return zlib.gunzipSync(blob).toString();
  } catch {
    return Buffer.from(blob).toString("latin1");
  }
}

export function auditFixture(fixtureDb: string, snapshotDb: string): AuditResult {
  const real = identitiesOf(snapshotDb);
  const names = new Set(real.names);
  const tags = new Set(real.tags);
  const puuids = new Set(real.puuids);
  const db = new Database(fixtureDb, { readonly: true });
  const result: AuditResult = {
    searched: { names: names.size, tags: tags.size, puuids: puuids.size },
    failures: [],
    wordCoincidences: 0,
  };
  const fail = (where: string, what: string) => {
    const line = `${where}: ${what}`;
    if (result.failures.length < 50 && !result.failures.includes(line)) result.failures.push(line);
  };
  const checkPuuids = (where: string, text: string) => {
    for (const match of text.toLowerCase().match(UUID) ?? []) {
      if (puuids.has(match)) fail(where, "a real PUUID");
    }
  };

  for (const { where, column, text } of textValues(db)) {
    checkPuuids(where, text);
    if (IDENTITY_COLUMN.test(column)) {
      const folded = text.toLowerCase();
      if (names.has(folded) || tags.has(folded)) fail(where, "a real name or tag line");
      continue;
    }
    if (where.includes("(decoded)")) {
      try {
        const walk = (node: unknown, key = "") => {
          if (typeof node === "string") {
            const folded = node.toLowerCase();
            if (IDENTITY_KEYS.has(key) && (names.has(folded) || tags.has(folded))) {
              fail(where, `a real name or tag line under ${key}`);
            }
          } else if (Array.isArray(node)) node.forEach((item) => walk(item, key));
          else if (node && typeof node === "object") {
            for (const [k, v] of Object.entries(node)) walk(v, k);
          }
        };
        walk(JSON.parse(text));
      } catch {
        // not JSON, nothing to walk
      }
    }
    for (const token of text.toLowerCase().split(/[^a-z0-9]+/)) {
      if (token.length >= 4 && names.has(token)) result.wordCoincidences++;
    }
  }
  checkPuuids("file bytes", fs.readFileSync(fixtureDb).toString("latin1"));
  db.close();
  return result;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const value = (flag: string) => args[args.indexOf(flag) + 1];
  const fixture = value("--fixture");
  const snapshot = value("--snapshot");
  if (!fixture || !snapshot) {
    console.error(
      "usage: bun parity/audit.ts --fixture <fixture folder> --snapshot <snapshot folder>",
    );
    process.exit(2);
  }
  const result = auditFixture(
    path.join(fixture, "data", "matches.db"),
    path.join(snapshot, "data", "matches.db"),
  );
  console.log(
    `searched ${result.searched.names} names, ${result.searched.tags} tag lines, ${result.searched.puuids} PUUIDs`,
  );
  console.log(`failures: ${result.failures.length}`);
  for (const line of result.failures) console.log(`  ${line}`);
  console.log(
    `real names that are also plain words in game text (not failures): ${result.wordCoincidences}`,
  );
  const failed = result.failures.length > 0;
  console.log(failed ? "FAIL" : "PASS");
  process.exit(failed ? 1 : 0);
}
