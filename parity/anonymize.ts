import { escapeRegExp, IdentityMatcher, type Match } from "./lib/anonymize-match.ts";
import { UUID_SOURCE } from "./lib/uuid.ts";
import { Database } from "bun:sqlite";
import zlib from "node:zlib";

export const FROZEN_VERSION = "1.2.1";

const ADJECTIVES = [
  "Amber",
  "Brisk",
  "Calm",
  "Dusty",
  "Eager",
  "Frosty",
  "Gentle",
  "Hazy",
  "Icy",
  "Jolly",
  "Keen",
  "Lucky",
  "Mellow",
  "Nimble",
  "Odd",
  "Plucky",
  "Quiet",
  "Rusty",
  "Shady",
  "Tidy",
  "Upbeat",
  "Vivid",
  "Wild",
  "Zesty",
];
const NOUNS = [
  "Badger",
  "Cobalt",
  "Dragon",
  "Ember",
  "Falcon",
  "Garnet",
  "Harbor",
  "Island",
  "Juniper",
  "Kettle",
  "Lantern",
  "Meadow",
  "Nebula",
  "Otter",
  "Pebble",
  "Quartz",
  "Raven",
  "Summit",
  "Thistle",
  "Umbra",
  "Violet",
  "Willow",
  "Yonder",
  "Zephyr",
];

export const fakeName = (index: number) =>
  `${ADJECTIVES[index % ADJECTIVES.length]}${NOUNS[Math.floor(index / ADJECTIVES.length) % NOUNS.length]}${
    Math.floor(index / (ADJECTIVES.length * NOUNS.length)) || ""
  }`;
export const fakeTag = (index: number) => `Z${String(index).padStart(3, "0")}`;
export const fakePuuid = (index: number) =>
  `fa4e0000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
export const fakeNumericId = (index: number) => 900_000_000 + index;

const ZERO_PUUID = /^0+(-0+)*$/;
const SETTINGS_KEY_UUID = new RegExp(UUID_SOURCE, "i");

/** What an identity field holds. `blank` fields hold a URL built from an account id. */
export type Role = "name" | "tag" | "puuid" | "numericId" | "blank";

const KEY_ROLES = new Map<string, Role>([
  ["gameName", "name"],
  ["summonerName", "name"],
  ["riotIdGameName", "name"],
  ["internalName", "name"],
  ["tagLine", "tag"],
  ["riotIdTagline", "tag"],
  ["riotIdTagLine", "tag"],
  ["summonerId", "numericId"],
  ["accountId", "numericId"],
  ["currentAccountId", "numericId"],
  ["matchHistoryUri", "blank"],
]);
const COLUMN_ROLES = new Map<string, Role>([
  ["game_name", "name"],
  ["summoner_name", "name"],
  ["tag_line", "tag"],
  ["puuid", "puuid"],
  ["summoner_id", "numericId"],
  ["account_id", "numericId"],
]);

/** The role of a JSON key in a payload, or undefined for a key that holds no identity. */
export const keyRole = (key: string): Role | undefined =>
  KEY_ROLES.get(key) ?? (key === "puuid" || key.endsWith("Puuid") ? "puuid" : undefined);
/** The role of a database column, in any table. */
export const columnRole = (column: string): Role | undefined => COLUMN_ROLES.get(column);

const fold = (value: string) => value.toLowerCase();

/** One real value to one fake value, in a stable order that does not depend on the value. */
class Mapping {
  private readonly seen = new Set<string>();
  private readonly fakes = new Map<string, string>();
  constructor(private readonly make: (index: number) => string) {}
  add(value: unknown) {
    if (typeof value === "string" && value !== "") this.seen.add(fold(value));
  }
  /** Assigns fakes, skipping any fake that is itself a real value in `avoid`. */
  freeze(avoid: Set<string>) {
    let index = 0;
    for (const key of [...this.seen].sort()) {
      let fake = this.make(++index);
      while (avoid.has(fold(fake))) fake = this.make(++index);
      this.fakes.set(key, fake);
    }
  }
  get(value: string): string {
    if (this.fakes.size !== this.seen.size) throw new Error("mapping used before freeze");
    const fake = this.fakes.get(fold(value)) ?? this.fakes.get(this.caseFoldedKey(value));
    if (fake === undefined) throw new Error("value was never collected");
    return fake;
  }
  keys() {
    return [...this.seen];
  }
  /** The key a case-insensitive regex match stands for when toLowerCase folds it differently. */
  private caseFoldedKey(value: string) {
    return this.keys().find((key) => new RegExp(`^${escapeRegExp(key)}$`, "iu").test(value)) ?? "";
  }
}

export interface AnonymizeSummary {
  games: number;
  participants: number;
  names: number;
  puuids: number;
  accounts: number;
  sampleNames: string[];
  syntheticFavorites: number[];
  /** Blobs that would not decode. They cannot be scrubbed, so each is emptied and logged. */
  corruptPayloads: number;
}

interface Cell {
  table: string;
  rowid: number;
  column: string;
  value: unknown;
}

function* cells(db: Database): Generator<Cell> {
  const tables = db
    .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  for (const { name: table } of tables) {
    for (const row of db.query(`SELECT rowid AS "rowid:", * FROM "${table}"`).iterate() as Iterable<
      Record<string, unknown>
    >) {
      const rowid = row["rowid:"] as number;
      for (const [column, value] of Object.entries(row)) {
        if (column !== "rowid:") yield { table, rowid, column, value };
      }
    }
  }
}

class Corrupt {
  readonly reason: string;
  constructor(error: unknown) {
    // A JSON parse error quotes the text it choked on, which can be a real name.
    this.reason =
      error instanceof Error ? ((error as NodeJS.ErrnoException).code ?? error.name) : "unknown";
  }
}

/** A cell's JSON, from a gzipped blob or a text column that holds JSON. */
function decodeCell(cell: Cell): unknown {
  if (cell.value instanceof Uint8Array) {
    try {
      return JSON.parse(zlib.gunzipSync(cell.value).toString("utf8"));
    } catch (error) {
      return new Corrupt(error);
    }
  }
  if (typeof cell.value === "string" && /^\s*[[{]/.test(cell.value)) {
    try {
      return JSON.parse(cell.value);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function walkIdentity(node: unknown, visit: (key: string, value: unknown) => void) {
  if (Array.isArray(node)) node.forEach((item) => walkIdentity(item, visit));
  else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      visit(key, value);
      walkIdentity(value, visit);
    }
  }
}

interface Collected {
  names: Mapping;
  tags: Mapping;
  puuids: Mapping;
  numericIds: Mapping;
  decoded: Map<string, unknown>;
}

const cellKey = (cell: Cell) => `${cell.table}\u0000${cell.rowid}\u0000${cell.column}`;

function collect(db: Database): Collected {
  const names = new Mapping(fakeName);
  const tags = new Mapping(fakeTag);
  const puuids = new Mapping(fakePuuid);
  const numericIds = new Mapping((index) => String(fakeNumericId(index)));
  const add = (role: Role | undefined, value: unknown) => {
    if (role === "name") names.add(value);
    else if (role === "tag") tags.add(value);
    else if (role === "puuid" && typeof value === "string" && !ZERO_PUUID.test(value))
      puuids.add(value);
    else if (role === "numericId" && typeof value === "number") numericIds.add(String(value));
  };
  const decoded = new Map<string, unknown>();
  for (const cell of cells(db)) {
    add(columnRole(cell.column), cell.value);
    if (cell.table === "settings" && cell.column === "key") {
      const embedded = String(cell.value).match(SETTINGS_KEY_UUID);
      if (embedded) add("puuid", embedded[0]);
    }
    const json = decodeCell(cell);
    if (json === undefined) continue;
    decoded.set(cellKey(cell), json);
    walkIdentity(json, (key, value) => add(keyRole(key), value));
  }
  return { names, tags, puuids, numericIds, decoded };
}

export function identitiesOf(file: string) {
  const db = new Database(file, { readonly: true });
  const { names, tags, puuids, numericIds } = collect(db);
  db.close();
  return {
    names: names.keys(),
    tags: tags.keys(),
    puuids: puuids.keys(),
    numericIds: numericIds.keys(),
  };
}

export function anonymizeDatabase(file: string): AnonymizeSummary {
  const db = new Database(file);
  db.run("PRAGMA secure_delete = ON");
  db.run("PRAGMA journal_mode = DELETE");
  db.run("DELETE FROM settings WHERE key = 'auto_start_path'");

  const { names, tags, puuids, numericIds, decoded } = collect(db);
  const realText = new Set([...names.keys(), ...tags.keys()]);
  names.freeze(realText);
  tags.freeze(realText);
  puuids.freeze(new Set(puuids.keys()));
  numericIds.freeze(new Set(numericIds.keys()));

  const matcher = new IdentityMatcher({
    names: names.keys(),
    tags: tags.keys(),
    puuids: puuids.keys(),
  });
  const mappings = { name: names, tag: tags, puuid: puuids };
  const fakeOf = (match: Match) => mappings[match.kind].get(match.text);

  const identity = (role: Role | undefined, value: unknown): { value: unknown } | null => {
    if (typeof value === "string" && value !== "") {
      if (role === "name") return { value: names.get(value) };
      if (role === "tag") return { value: tags.get(value) };
      if (role === "puuid") return { value: ZERO_PUUID.test(value) ? value : puuids.get(value) };
      if (role === "blank") return { value: "" };
    }
    if (role === "numericId" && typeof value === "number") {
      return { value: Number(numericIds.get(String(value))) };
    }
    return null;
  };

  const rewrite = (node: unknown): unknown => {
    if (typeof node === "string") return matcher.replace(node, fakeOf);
    if (Array.isArray(node)) return node.map(rewrite);
    if (!node || typeof node !== "object") return node;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      const mapped = identity(keyRole(key), value);
      out[matcher.replaceInKey(key, fakeOf)] = mapped ? mapped.value : rewrite(value);
    }
    return out;
  };

  let corruptPayloads = 0;
  const newValue = (cell: Cell): unknown => {
    const mapped = identity(columnRole(cell.column), cell.value);
    if (mapped) return mapped.value;
    const json = decoded.get(cellKey(cell));
    if (json instanceof Corrupt) {
      corruptPayloads++;
      console.error(
        `anonymize: ${cell.table}.${cell.column} row ${cell.rowid} would not decode (${json.reason}) and is emptied`,
      );
      return null;
    }
    if (json !== undefined) {
      const text = JSON.stringify(rewrite(json));
      if (cell.value instanceof Uint8Array) return zlib.gzipSync(text);
      return text === JSON.stringify(json) ? cell.value : text;
    }
    return typeof cell.value === "string" ? matcher.replace(cell.value, fakeOf) : cell.value;
  };

  db.transaction(() => {
    const changed = new Map<string, { table: string; rowid: number; set: Map<string, unknown> }>();
    for (const cell of cells(db)) {
      const value = newValue(cell);
      if (value === cell.value) continue;
      const key = `${cell.table}\u0000${cell.rowid}`;
      const row = changed.get(key) ?? { table: cell.table, rowid: cell.rowid, set: new Map() };
      row.set.set(cell.column, value);
      changed.set(key, row);
    }
    for (const { table, rowid, set } of changed.values()) {
      const columns = [...set.keys()].map((column) => `"${column}" = ?`).join(", ");
      db.prepare(`UPDATE "${table}" SET ${columns} WHERE rowid = ?`).run(
        ...([...set.values(), rowid] as any[]),
      );
    }
    db.run(
      "INSERT INTO settings (key, value) VALUES ('last_run_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [FROZEN_VERSION],
    );
  })();

  const favorites = ensureFavorites(db);
  db.run("VACUUM");
  const summary: AnonymizeSummary = {
    games: (db.query("SELECT count(*) c FROM games").get() as any).c,
    participants: (db.query("SELECT count(*) c FROM match_participants").get() as any).c,
    names: names.keys().length,
    puuids: puuids.keys().length,
    accounts: (db.query("SELECT count(*) c FROM summoner").get() as any).c,
    sampleNames: [
      ...new Set(
        (
          db
            .query(
              "SELECT game_name FROM match_participants WHERE game_name IS NOT NULL ORDER BY game_name LIMIT 400",
            )
            .all() as any[]
        ).map((r) => r.game_name),
      ),
    ].slice(0, 6),
    syntheticFavorites: favorites,
    corruptPayloads,
  };
  db.close();
  return summary;
}

function ensureFavorites(db: Database): number[] {
  const existing = (db.query("SELECT count(*) c FROM games WHERE favorite = 1").get() as any).c;
  if (existing > 0) return [];
  const ids = (
    db
      .query("SELECT game_id FROM games WHERE is_remake = 0 ORDER BY game_creation DESC LIMIT 12")
      .all() as any[]
  )
    .map((r) => r.game_id)
    .filter((_, i) => i === 2 || i === 6);
  for (const id of ids) db.run("UPDATE games SET favorite = 1 WHERE game_id = ?", [id]);
  return ids;
}
