export type LiveMode = "off" | "loading" | "on";

export interface Frame {
  uri: string;
  eventType: "Create" | "Update" | "Delete";
  data: unknown;
}

export interface FakeSummoner {
  puuid: string;
  gameName: string;
  tagLine: string;
  summonerId: number;
  accountId: number;
  profileIconId: number;
}

export interface RosterPlayer {
  puuid: string;
  gameName: string;
  tagLine: string;
  championId: number;
  teamId: 100 | 200;
  spell1Id: number;
  spell2Id: number;
  level: number;
  kills: number;
  deaths: number;
  assists: number;
  items: number[];
}

export interface ScenarioContext {
  options: Record<string, string | number | boolean>;
  now: number;
  summoner: FakeSummoner;
  patch: string;
  /** The games the app already holds, newest first. */
  known: { gameId: number; queueId: number; gameCreation: number }[];
  gameDetail(gameId: number): unknown;
  /** A game the app has not seen. `recent` ends minutes before `now`, `past` predates every known game. */
  newGame(n: number, when: "recent" | "past"): { gameId: number; payload: any };
  roster(): RosterPlayer[];
  /** The map skin the roster's game was played on, as the in-game API names it. */
  mapSkin: string;
}

/** What the client answers at any moment. A step replaces whichever fields it names. */
export interface ClientState {
  phase: string;
  session: unknown;
  live: LiveMode;
}

export interface Step {
  /** Milliseconds after the timeline starts, before the time scale applies. */
  at: number;
  label: string;
  state?: Partial<ClientState>;
  frames?: Frame[];
}

export interface Scenario {
  name: string;
  description: string;
  state: ClientState;
  timeline: Step[];
  /**
   * What Riot's match-history service lists, newest first. `gated` holds every answer until the capture opens
   * the page, so a one-off toast is not missed.
   */
  sgp: { ids: number[]; stall?: boolean; status?: number; gated?: boolean };
  /** Games the client answers by id. Everything known to the context is answered too. */
  games: { id: number; payload: unknown }[];
  /** Detail requests for the SGP ids from this index on never answer, except for the oldest id. */
  hangDetailsFrom?: number;
  /** The first `n` detail requests for a game answer 404. */
  misses?: Record<number, number>;
  challenges: { all: Record<string, unknown>; summary: unknown } | null;
  /** What the in-game API answers on port 2999 while `live` is "on". */
  liveData?: unknown;
}

export type ScenarioFactory = (context: ScenarioContext) => Scenario;

export const gameflowPhaseFrame = (phase: string): Frame => ({
  uri: "/lol-gameflow/v1/gameflow-phase",
  eventType: "Update",
  data: phase,
});

export const gameflowSessionFrame = (session: unknown): Frame => ({
  uri: "/lol-gameflow/v1/session",
  eventType: "Update",
  data: session,
});

export const option = <T extends string | number | boolean>(
  context: ScenarioContext,
  key: string,
  fallback: T,
): T => {
  const value = context.options[key];
  if (value === undefined) return fallback;
  if (typeof fallback === "number") return Number(value) as T;
  if (typeof fallback === "boolean") return (value === true || value === "true") as T;
  return String(value) as T;
};
