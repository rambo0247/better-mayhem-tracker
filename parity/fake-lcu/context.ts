import { Database } from "bun:sqlite";
import path from "node:path";
import zlib from "node:zlib";
import type { FakeSummoner, RosterPlayer, ScenarioContext } from "./types.ts";

const MAYHEM = 2400;
const GAME_ID_BASE = 7_000_000_000;

function mapSkinOf(payload: any): string {
  const mutator = (payload?.gameModeMutators ?? []).find((m: string) => m.startsWith("mapskin_"));
  const skin = String(mutator ?? "").replace(/^mapskin_map12_/, "");
  return skin ? skin[0]!.toUpperCase() + skin.slice(1) : "Default";
}

function rosterOf(payload: any): RosterPlayer[] {
  return payload.participants.map((p: any, i: number): RosterPlayer => {
    const player = payload.participantIdentities[i]?.player ?? {};
    const s = p.stats ?? {};
    return {
      puuid: String(player.puuid ?? ""),
      gameName: String(player.gameName ?? ""),
      tagLine: String(player.tagLine ?? ""),
      championId: Number(p.championId),
      teamId: p.teamId === 200 ? 200 : 100,
      spell1Id: Number(p.spell1Id),
      spell2Id: Number(p.spell2Id),
      level: Number(s.champLevel) || 1,
      kills: Math.round((Number(s.kills) || 0) * 0.6),
      deaths: Math.round((Number(s.deaths) || 0) * 0.6),
      assists: Math.round((Number(s.assists) || 0) * 0.6),
      items: [0, 1, 2, 3, 4, 5, 6].map((slot) => Number(s[`item${slot}`]) || 0),
    };
  });
}

interface Source {
  summoner: FakeSummoner;
  patch: string;
  known: ScenarioContext["known"];
  detail(gameId: number): any;
  template: any;
}

function build(source: Source, options: ScenarioContext["options"], now: number): ScenarioContext {
  const oldest = source.known.at(-1)?.gameCreation ?? now;
  const duration = Number(source.template.gameDuration) * 1000;
  return {
    options,
    now,
    summoner: source.summoner,
    patch: source.patch,
    known: source.known,
    gameDetail: (gameId) => source.detail(gameId),
    newGame(n, when) {
      const payload = structuredClone(source.template);
      const gameId = GAME_ID_BASE + n;
      const creation =
        when === "recent" ? now - duration - 3 * 60_000 : oldest - (n + 1) * 26 * 3_600_000;
      payload.gameId = gameId;
      payload.gameCreation = creation;
      payload.gameCreationDate = new Date(creation).toISOString();
      payload.queueId = MAYHEM;
      const owner = payload.participantIdentities.findIndex(
        (identity: any) => identity.player?.puuid === source.summoner.puuid,
      );
      const stats = payload.participants[owner >= 0 ? owner : 0]?.stats;
      if (stats && when === "recent") {
        stats.kills += 4;
        stats.assists += 2;
      }
      return { gameId, payload };
    },
    roster: () => rosterOf(source.template),
    mapSkin: mapSkinOf(source.template),
  };
}

/** Reads the scenario inputs from a fixture or snapshot data root, read-only. */
export function loadContext(
  dataRoot: string,
  options: ScenarioContext["options"],
  now: number,
): ScenarioContext {
  const database = new Database(path.join(dataRoot, "data", "matches.db"), { readonly: true });
  try {
    const row = database
      .query(
        "SELECT puuid, game_name, tag_line, summoner_id, account_id, profile_icon FROM summoner",
      )
      .get() as any;
    if (!row) throw new Error(`no summoner row in ${dataRoot}`);
    const known = database
      .query("SELECT game_id, queue_id, game_creation FROM games ORDER BY game_creation DESC")
      .all()
      .map((r: any) => ({
        gameId: r.game_id as number,
        queueId: r.queue_id as number,
        gameCreation: r.game_creation as number,
      }));
    if (known.length === 0) throw new Error(`no games in ${dataRoot}`);
    // The database closes when this returns, and the fake answers detail requests long after, so
    // the compressed payloads are read now and unpacked on demand.
    const compressed = new Map<number, Buffer>(
      database
        .query("SELECT game_id, raw_gz FROM games WHERE raw_gz IS NOT NULL")
        .all()
        .map((r: any) => [r.game_id as number, Buffer.from(r.raw_gz)]),
    );
    const unpack = (gameId: number) => {
      const raw = compressed.get(gameId);
      return raw ? JSON.parse(zlib.gunzipSync(raw).toString("utf8")) : null;
    };
    const template = unpack(known[0]!.gameId);
    const details = new Map<number, any>();
    return build(
      {
        summoner: {
          puuid: row.puuid,
          gameName: row.game_name,
          tagLine: row.tag_line,
          summonerId: row.summoner_id,
          accountId: row.account_id,
          profileIconId: row.profile_icon ?? 0,
        },
        patch: String(template.gameVersion),
        known,
        detail: (gameId) => {
          if (!details.has(gameId)) details.set(gameId, unpack(gameId));
          return details.get(gameId);
        },
        template,
      },
      options,
      now,
    );
  } finally {
    database.close();
  }
}

/** Ten invented players and three games, for tests that must not need a fixture. */
export function syntheticContext(
  options: ScenarioContext["options"] = {},
  now = Date.UTC(2026, 10, 23, 2, 0, 0),
): ScenarioContext {
  const puuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
  const template = {
    gameId: 5_000_000_003,
    gameCreation: now - 3_600_000,
    gameCreationDate: new Date(now - 3_600_000).toISOString(),
    gameDuration: 1100,
    gameMode: "KIWI",
    gameModeMutators: ["mapskin_map12_bloom"],
    gameVersion: "16.23.840.6595",
    queueId: MAYHEM,
    participantIdentities: Array.from({ length: 10 }, (_, i) => ({
      participantId: i + 1,
      player: { puuid: puuid(i), gameName: `Player${i}`, tagLine: `T${i}`, profileIcon: 10 + i },
    })),
    participants: Array.from({ length: 10 }, (_, i) => ({
      participantId: i + 1,
      championId: 10 + i,
      teamId: i < 5 ? 100 : 200,
      spell1Id: 4,
      spell2Id: 32,
      stats: { champLevel: 15, kills: 10, deaths: 5, assists: 8, win: i < 5, item0: 3050 },
    })),
  };
  const known = [3, 2, 1].map((n) => ({
    gameId: 5_000_000_000 + n,
    queueId: MAYHEM,
    gameCreation: now - n * 3_600_000,
  }));
  return build(
    {
      summoner: {
        puuid: puuid(0),
        gameName: "Player0",
        tagLine: "T0",
        summonerId: 900000001,
        accountId: 900000002,
        profileIconId: 10,
      },
      patch: template.gameVersion,
      known,
      detail: (gameId) =>
        known.some((k) => k.gameId === gameId) ? { ...structuredClone(template), gameId } : null,
      template,
    },
    options,
    now,
  );
}
