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

const UUID_ANYWHERE = new RegExp(UUID_SOURCE, "gi");
const ZERO_PUUID = /^0+(-0+)*$/;
const NAME_KEYS = new Set(["gameName", "summonerName", "riotIdGameName", "internalName"]);
const TAG_KEYS = new Set(["tagLine", "riotIdTagline", "riotIdTagLine"]);
const ID_KEYS = new Set(["summonerId", "accountId", "currentAccountId"]);
const BLANK_KEYS = new Set(["matchHistoryUri"]);

/** One real value to one fake value, in a stable order that does not depend on the value. */
class Mapping {
  private readonly real = new Map<string, number>();
  private frozen = false;
  constructor(
    private readonly make: (index: number) => string,
    private readonly fold: (value: string) => string = (v) => v.toLowerCase(),
  ) {}
  add(value: unknown) {
    if (typeof value !== "string" || value === "") return;
    this.real.set(this.fold(value), 0);
  }
  freeze() {
    [...this.real.keys()].sort().forEach((key, index) => this.real.set(key, index + 1));
    this.frozen = true;
  }
  has(value: string) {
    return this.real.has(this.fold(value));
  }
  get(value: string): string {
    if (!this.frozen) throw new Error("mapping used before freeze");
    const index = this.real.get(this.fold(value));
    if (index === undefined) throw new Error("value was never collected");
    return this.make(index);
  }
  keys() {
    return [...this.real.keys()];
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
  /** Games whose payload would not decode. It cannot be scrubbed, so it is emptied. */
  corruptPayloads: number[];
}

function unpack(blob: Uint8Array | null): any {
  if (!blob) return null;
  return JSON.parse(zlib.gunzipSync(blob).toString("utf8"));
}

function walkIdentity(node: any, visit: (key: string, value: unknown) => void) {
  if (Array.isArray(node)) node.forEach((item) => walkIdentity(item, visit));
  else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      visit(key, value);
      walkIdentity(value, visit);
    }
  }
}

const isPuuidKey = (key: string) => key === "puuid" || key.endsWith("Puuid");

interface Collected {
  names: Mapping;
  tags: Mapping;
  puuids: Mapping;
  numericIds: Mapping;
  decoded: Map<number, any>;
  corrupt: number[];
}

function collect(db: Database): Collected {
  const names = new Mapping(fakeName);
  const tags = new Mapping(fakeTag);
  const puuids = new Mapping(fakePuuid, (v) => v.toLowerCase());
  const numericIds = new Mapping(
    (index) => String(fakeNumericId(index)),
    (v) => v,
  );
  const addPuuid = (value: unknown) => {
    if (typeof value === "string" && !ZERO_PUUID.test(value)) puuids.add(value);
  };

  const payloads: { game_id: number; raw_gz: Uint8Array | null }[] = db
    .query("SELECT game_id, raw_gz FROM games")
    .all() as any;
  const decoded = new Map<number, any>();
  const corrupt: number[] = [];
  for (const { game_id, raw_gz } of payloads) {
    let raw: any = null;
    try {
      raw = unpack(raw_gz);
    } catch (error) {
      corrupt.push(game_id);
      console.error(`anonymize: game ${game_id} payload would not decode: ${String(error)}`);
    }
    decoded.set(game_id, raw);
    walkIdentity(raw, (key, value) => {
      if (NAME_KEYS.has(key)) names.add(value);
      else if (TAG_KEYS.has(key)) tags.add(value);
      else if (isPuuidKey(key)) addPuuid(value);
      else if (ID_KEYS.has(key) && typeof value === "number") numericIds.add(String(value));
    });
  }
  for (const row of db
    .query("SELECT puuid, game_name, tag_line FROM match_participants")
    .all() as any[]) {
    names.add(row.game_name);
    tags.add(row.tag_line);
    addPuuid(row.puuid);
  }
  for (const row of db
    .query("SELECT puuid, game_name, tag_line, summoner_id, account_id FROM summoner")
    .all() as any[]) {
    names.add(row.game_name);
    tags.add(row.tag_line);
    addPuuid(row.puuid);
    if (row.summoner_id != null) numericIds.add(String(row.summoner_id));
    if (row.account_id != null) numericIds.add(String(row.account_id));
  }
  for (const row of db.query("SELECT DISTINCT puuid FROM games").all() as any[])
    addPuuid(row.puuid);
  for (const row of db.query("SELECT key FROM settings").all() as any[]) {
    const embedded = String(row.key).match(new RegExp(UUID_SOURCE, "i"));
    if (embedded) addPuuid(embedded[0]);
  }
  return { names, tags, puuids, numericIds, decoded, corrupt };
}

export function identitiesOf(file: string) {
  const db = new Database(file, { readonly: true });
  const { names, tags, puuids } = collect(db);
  db.close();
  return { names: names.keys(), tags: tags.keys(), puuids: puuids.keys() };
}

export function anonymizeDatabase(file: string): AnonymizeSummary {
  const db = new Database(file);
  db.run("PRAGMA secure_delete = ON");
  db.run("PRAGMA journal_mode = DELETE");

  const { names, tags, puuids, numericIds, decoded, corrupt } = collect(db);
  for (const mapping of [names, tags, puuids, numericIds]) mapping.freeze();

  const fakeFor = (value: string | null, mapping: Mapping, passZero = false) => {
    if (value == null || value === "") return value;
    if (passZero && ZERO_PUUID.test(value)) return value;
    return mapping.has(value) ? mapping.get(value) : value;
  };
  const idFor = (value: number | null) =>
    value == null || !numericIds.has(String(value)) ? value : Number(numericIds.get(String(value)));

  const FREE_TEXT_MIN = 12;
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const nameWords = names
    .keys()
    .filter((name) => name.length >= 5)
    .sort((a, b) => b.length - a.length);
  const nameRegex = nameWords.length
    ? new RegExp(`(?<![\\p{L}\\p{N}])(${nameWords.map(escape).join("|")})(?![\\p{L}\\p{N}])`, "giu")
    : null;
  const scrubText = (text: string) => {
    let out = text.replace(UUID_ANYWHERE, (match) => fakeFor(match, puuids, true) as string);
    if (nameRegex && out.length >= FREE_TEXT_MIN) {
      out = out.replace(nameRegex, (match) => names.get(match));
    }
    return out;
  };

  function rewrite(node: any): any {
    if (Array.isArray(node)) return node.map(rewrite);
    if (!node || typeof node !== "object") return node;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if (BLANK_KEYS.has(key) && typeof value === "string") out[key] = "";
      else if (NAME_KEYS.has(key) && typeof value === "string") out[key] = fakeFor(value, names);
      else if (TAG_KEYS.has(key) && typeof value === "string") out[key] = fakeFor(value, tags);
      else if (isPuuidKey(key) && typeof value === "string")
        out[key] = fakeFor(value, puuids, true);
      else if (ID_KEYS.has(key) && typeof value === "number") out[key] = idFor(value);
      else if (typeof value === "string") out[key] = scrubText(value);
      else out[key] = rewrite(value);
    }
    return out;
  }

  db.transaction(() => {
    const setPayload = db.prepare("UPDATE games SET raw_gz = ?, puuid = ? WHERE game_id = ?");
    const gamePuuid = db.query("SELECT puuid FROM games WHERE game_id = ?");
    for (const [gameId, raw] of decoded) {
      const row = gamePuuid.get(gameId) as { puuid: string };
      const blob = raw ? zlib.gzipSync(JSON.stringify(rewrite(raw))) : null;
      setPayload.run(blob, fakeFor(row.puuid, puuids, true) as string, gameId);
    }

    const participants = db
      .query("SELECT rowid, puuid, game_name, tag_line FROM match_participants")
      .all() as any[];
    const setParticipant = db.prepare(
      "UPDATE match_participants SET puuid = ?, game_name = ?, tag_line = ? WHERE rowid = ?",
    );
    for (const p of participants) {
      setParticipant.run(
        fakeFor(p.puuid, puuids, true),
        fakeFor(p.game_name, names),
        fakeFor(p.tag_line, tags),
        p.rowid,
      );
    }

    const summoners = db
      .query("SELECT rowid, puuid, game_name, tag_line, summoner_id, account_id FROM summoner")
      .all() as any[];
    const setSummoner = db.prepare(
      "UPDATE summoner SET puuid = ?, game_name = ?, tag_line = ?, summoner_id = ?, account_id = ? WHERE rowid = ?",
    );
    for (const s of summoners) {
      setSummoner.run(
        fakeFor(s.puuid, puuids, true),
        fakeFor(s.game_name, names),
        fakeFor(s.tag_line, tags),
        idFor(s.summoner_id),
        idFor(s.account_id),
        s.rowid,
      );
    }

    const settings = db.query("SELECT key, value FROM settings").all() as any[];
    for (const { key } of settings) {
      if (key === "auto_start_path") {
        db.run("DELETE FROM settings WHERE key = ?", [key]);
        continue;
      }
      const renamed = String(key).replace(
        new RegExp(UUID_SOURCE, "i"),
        (match) => fakeFor(match, puuids, true) as string,
      );
      if (renamed !== key) db.run("UPDATE settings SET key = ? WHERE key = ?", [renamed, key]);
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
    corruptPayloads: corrupt,
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
