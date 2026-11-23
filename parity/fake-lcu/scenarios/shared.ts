import {
  gameflowPhaseFrame,
  gameflowSessionFrame,
  type ClientState,
  type Scenario,
  type ScenarioContext,
} from "../types.ts";

export const MAYHEM_QUEUE = { id: 2400, name: "ARAM: Mayhem", description: "ARAM: Mayhem" };

/** The in-game game is the one the post-game screen later reports. */
export const liveGameId = (context: ScenarioContext) => context.newGame(0, "recent").gameId;

/** A gameflow session as the client publishes it, for a phase in which a game exists. */
export function session(context: ScenarioContext, phase: string): unknown {
  const roster = context.roster();
  const entry = (p: (typeof roster)[number]) => ({
    championId: p.championId,
    puuid: p.puuid,
    gameName: p.gameName,
    tagLine: p.tagLine,
    summonerName: p.gameName,
    spell1Id: p.spell1Id,
    spell2Id: p.spell2Id,
  });
  return {
    phase,
    gameClient: {
      running: phase === "InProgress",
      serverIp: "",
      serverPort: 0,
      observerServerIp: "",
    },
    gameData: {
      gameId: liveGameId(context),
      isCustomGame: false,
      queue: MAYHEM_QUEUE,
      teamOne: roster.filter((p) => p.teamId === 100).map(entry),
      teamTwo: roster.filter((p) => p.teamId === 200).map(entry),
      playerChampionSelections: roster.map((p) => ({
        puuid: p.puuid,
        championId: p.championId,
        spell1Id: p.spell1Id,
        spell2Id: p.spell2Id,
      })),
    },
    map: { id: 12, name: "Random Map", gameMode: "KIWI" },
  };
}

/** What port 2999 serves while a match runs: ten players, a kill feed, the clock. */
export function liveGameData(context: ScenarioContext) {
  const roster = context.roster();
  const self = roster.find((p) => p.puuid === context.summoner.puuid) ?? roster[0]!;
  const riotId = (p: (typeof roster)[number]) => `${p.gameName}#${p.tagLine}`;
  const side = (teamId: number) => (teamId === 200 ? "CHAOS" : "ORDER");
  const spell = (id: number) => ({
    displayName: `Spell ${id}`,
    rawDescription: "",
    rawDisplayName: `GeneratedTip_SummonerSpell_Summoner${id}_DisplayName`,
  });
  return {
    activePlayer: {
      riotId: riotId(self),
      riotIdGameName: self.gameName,
      summonerName: self.gameName,
    },
    allPlayers: roster.map((p, i) => ({
      championName: "",
      rawChampionName: "",
      isBot: false,
      isDead: i === 3,
      respawnTimer: i === 3 ? 21.4 : 0,
      items: p.items
        .map((itemID, slot) => ({ itemID, slot, count: 1 }))
        .filter((item) => item.itemID > 0),
      level: p.level,
      position: "",
      riotId: riotId(p),
      riotIdGameName: p.gameName,
      riotIdTagLine: p.tagLine,
      scores: { assists: p.assists, creepScore: 0, deaths: p.deaths, kills: p.kills, wardScore: 0 },
      summonerName: p.gameName,
      summonerSpells: {
        summonerSpellOne: spell(p.spell1Id),
        summonerSpellTwo: spell(p.spell2Id),
      },
      team: side(p.teamId),
    })),
    events: {
      Events: [
        { EventID: 0, EventName: "GameStart", EventTime: 0.1 },
        {
          EventID: 1,
          EventName: "FirstBlood",
          EventTime: 142.5,
          Recorder: riotId(roster[0]!),
        },
        {
          EventID: 2,
          EventName: "ChampionKill",
          EventTime: 142.5,
          KillerName: riotId(roster[0]!),
          VictimName: riotId(roster[7]!),
          Assisters: [riotId(roster[1]!)],
        },
        {
          EventID: 3,
          EventName: "ChampionKill",
          EventTime: 388.1,
          KillerName: riotId(roster[6]!),
          VictimName: riotId(self),
          Assisters: [],
        },
        {
          EventID: 4,
          EventName: "TurretKilled",
          EventTime: 611.7,
          KillerName: riotId(roster[2]!),
          TurretKilled: "Turret_T2_L_03_A",
          Assisters: [],
        },
        {
          EventID: 5,
          EventName: "Multikill",
          EventTime: 905.2,
          KillerName: riotId(roster[4]!),
          KillStreak: 3,
        },
      ],
    },
    gameData: {
      gameMode: "KIWI",
      gameTime: 1450.4,
      mapName: "Map12",
      mapNumber: 12,
      mapTerrain: context.mapSkin,
    },
  };
}

/** The idle client every other scenario builds on. */
export function base(
  name: string,
  description: string,
  state: Partial<ClientState> = {},
): Scenario {
  return {
    name,
    description,
    state: { phase: "None", session: null, live: "off", ...state },
    timeline: [],
    sgp: { ids: [] },
    games: [],
    challenges: null,
  };
}

export const phaseFrames = (context: ScenarioContext, phase: string) => [
  gameflowPhaseFrame(phase),
  gameflowSessionFrame(session(context, phase)),
];
