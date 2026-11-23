import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { columnRole, identitiesOf, keyRole, type Role } from "./anonymize.ts";
import { IdentityMatcher, type Match } from "./lib/anonymize-match.ts";
import { refuseRealFolder } from "./lib/real-folder.ts";

export type HitKind =
  | "real PUUID"
  | "real name"
  | "real tag line in a name#tag form"
  | "real name or tag line in an identity field"
  | "real account or summoner id in an identity field"
  | "blob that does not decode"
  | "identity field in a Riot static file"
  | "Riot static file that differs from the snapshot"
  | "journal file or free pages beside a database";

export interface AuditResult {
  searched: {
    names: number;
    tags: number;
    puuids: number;
    numericIds: number;
    files: number;
    strings: number;
    /** Names found among other words, which are game text and not identities. Never a failure. */
    bareNames: number;
  };
  /** Every hit, counted by kind. Any hit fails the audit. */
  hits: Partial<Record<HitKind, number>>;
  /** `location: kind` for each distinct place a hit was found. Never the value. */
  locations: string[];
}

export const auditFailed = (result: AuditResult) => Object.keys(result.hits).length > 0;

const MATCH_KIND: Record<Match["kind"], HitKind> = {
  puuid: "real PUUID",
  name: "real name",
  tag: "real tag line in a name#tag form",
};
const SQLITE_MAGIC = "SQLite format 3\u0000";
const JOURNAL = /-(wal|shm|journal)$/;

/**
 * Files the app downloads from Riot's public game data (`src/main/dragon.ts`,
 * `src/main/game-assets.ts`). Champion and augment names in them coincide with thousands of
 * real player names, and rewriting them would break the icons both apps load, so their
 * strings are not searched for bare names. Each must instead be byte-identical to the
 * snapshot's copy and hold no identity field, PUUID, or `name#tag` form.
 */
const isRiotStatic = (relative: string) =>
  relative === path.join("data", "champion-cache.json") ||
  relative === path.join("data", "augment-icon-cache.json") ||
  relative.split(path.sep)[0] === "asset-cache";

export function auditFixture(
  fixtureDir: string,
  snapshotDir: string,
  realRoots?: string[],
): AuditResult {
  refuseRealFolder(path.resolve(fixtureDir), "audit fixture", realRoots);
  refuseRealFolder(path.resolve(snapshotDir), "audit snapshot", realRoots);
  const real = identitiesOf(path.join(snapshotDir, "data", "matches.db"));
  const matcher = new IdentityMatcher(real);
  const nameOrTag = new Set([...real.names, ...real.tags]);
  const puuids = new Set(real.puuids);
  const numericIds = new Set(real.numericIds);
  const result: AuditResult = {
    searched: {
      names: real.names.length,
      tags: real.tags.length,
      puuids: real.puuids.length,
      numericIds: real.numericIds.length,
      files: 0,
      strings: 0,
      bareNames: 0,
    },
    hits: {},
    locations: [],
  };
  const hit = (where: string, kind: HitKind) => {
    result.hits[kind] = (result.hits[kind] ?? 0) + 1;
    const line = `${matcher.redact(where, "<redacted>")}: ${kind}`;
    if (result.locations.length < 200 && !result.locations.includes(line)) {
      result.locations.push(line);
    }
  };
  const searchText = (where: string, text: string) => {
    result.searched.strings++;
    result.searched.bareNames += matcher.countBareNames(text);
    for (const match of matcher.find(text)) hit(where, MATCH_KIND[match.kind]);
  };
  const searchStructure = (where: string, text: string) => {
    result.searched.strings++;
    for (const match of matcher.findInKey(text)) hit(where, MATCH_KIND[match.kind]);
  };
  const checkIdentity = (where: string, role: Role | undefined, value: unknown) => {
    if (typeof value === "string" && (role === "name" || role === "tag")) {
      if (nameOrTag.has(value.toLowerCase())) {
        hit(where, "real name or tag line in an identity field");
      }
    } else if (typeof value === "string" && role === "puuid") {
      if (puuids.has(value.toLowerCase())) hit(where, "real PUUID");
    } else if (typeof value === "number" && role === "numericId") {
      if (numericIds.has(String(value))) {
        hit(where, "real account or summoner id in an identity field");
      }
    }
  };
  const walk = (node: unknown, where: string, riotStatic: boolean) => {
    if (typeof node === "string") (riotStatic ? searchStructure : searchText)(where, node);
    else if (Array.isArray(node)) node.forEach((item) => walk(item, `${where}[]`, riotStatic));
    else if (node && typeof node === "object") {
      for (const [key, value] of Object.entries(node)) {
        searchStructure(`${where} (key)`, key);
        const role = keyRole(key);
        if (riotStatic && role) hit(`${where}.${key}`, "identity field in a Riot static file");
        checkIdentity(`${where}.${key}`, role, value);
        walk(value, `${where}.${key}`, riotStatic);
      }
    }
  };
  const searchJsonOrText = (where: string, text: string, riotStatic = false) => {
    let json: unknown;
    try {
      json = /^\s*[[{]/.test(text) ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    if (json !== undefined) walk(json, `${where}$`, riotStatic);
    else (riotStatic ? searchStructure : searchText)(where, text);
  };

  const auditDatabase = (file: string, label: string) => {
    const db = new Database(file, { readonly: true });
    if ((db.query("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count) {
      hit(label, "journal file or free pages beside a database");
    }
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[];
    for (const { name: table } of tables) {
      for (const row of db.query(`SELECT * FROM "${table}"`).iterate() as Iterable<
        Record<string, unknown>
      >) {
        for (const [column, value] of Object.entries(row)) {
          const where = `${label} ${table}.${column}`;
          checkIdentity(where, columnRole(column), value);
          if (typeof value === "string") searchJsonOrText(where, value);
          else if (value instanceof Uint8Array) {
            let text: string | null = null;
            try {
              text = zlib.gunzipSync(value).toString("utf8");
            } catch {
              hit(where, "blob that does not decode");
            }
            if (text !== null) searchJsonOrText(`${where} (gunzipped)`, text);
          }
        }
      }
    }
    db.close();
  };

  const files = fs.readdirSync(fixtureDir, { recursive: true, encoding: "utf8" }).sort();
  for (const relative of files) {
    for (const segment of relative.split(path.sep)) {
      searchText(`file path ${relative}`, segment);
      searchText(`file path ${relative}`, segment.replace(/\.[^.]*$/, ""));
    }
    const file = path.join(fixtureDir, relative);
    if (!fs.statSync(file).isFile()) continue;
    result.searched.files++;
    const bytes = fs.readFileSync(file);
    for (const _ of matcher.findPuuids(bytes.toString("latin1"))) hit(relative, "real PUUID");
    if (JOURNAL.test(relative)) {
      hit(relative, "journal file or free pages beside a database");
    } else if (bytes.subarray(0, 16).toString("latin1") === SQLITE_MAGIC) {
      auditDatabase(file, relative);
    } else if (isRiotStatic(relative)) {
      const twin = path.join(snapshotDir, relative);
      if (!fs.existsSync(twin) || !fs.readFileSync(twin).equals(bytes)) {
        hit(relative, "Riot static file that differs from the snapshot");
      }
      if (relative.endsWith(".json")) searchJsonOrText(relative, bytes.toString("utf8"), true);
    } else {
      searchJsonOrText(relative, bytes.toString("utf8"));
    }
  }
  return result;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const value = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
  const fixture = value("--fixture");
  const snapshot = value("--snapshot");
  if (!fixture || !snapshot) {
    console.error(
      "usage: bun parity/audit.ts --fixture <fixture folder> --snapshot <snapshot folder>",
    );
    process.exit(2);
  }
  const result = auditFixture(fixture, snapshot);
  const s = result.searched;
  console.log(
    `searched ${s.files} files and ${s.strings} strings for ${s.names} names, ${s.tags} tag lines, ${s.puuids} PUUIDs, ${s.numericIds} account and summoner ids. ${s.bareNames} names sit among other words in game text and are not identities`,
  );
  for (const [kind, count] of Object.entries(result.hits)) console.log(`${count}\t${kind}`);
  for (const line of result.locations) console.log(`  ${line}`);
  const failed = auditFailed(result);
  console.log(failed ? "FAIL" : "PASS");
  process.exit(failed ? 1 : 0);
}
