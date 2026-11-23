import type { Step } from "./drive.ts";
import type { StateRow, Viewport } from "./states.ts";

export type ClientLabel = "Connected" | "In Game" | "Connecting..." | "Disconnected";

/** How the League client behaves while one state is captured. */
export interface ClientSpec {
  /** A fake client scenario, or null for a client that never starts. */
  scenario: string | null;
  options?: Record<string, string | number | boolean>;
  /** Run on a copy of the data with every game removed. */
  empty?: boolean;
  /** Keep the status on "Connecting..." by holding the connect loop's first tick. */
  hold?: boolean;
  /** The status label to wait for before the route opens. */
  ready: ClientLabel;
  /** Start the scenario's timeline once the route is open, and wait for it to end. */
  play?: boolean;
  /** The label that follows once the timeline has run. */
  after?: ClientLabel;
  /** Wait until the scenario's new game is the newest one in the database. */
  awaitGame?: boolean;
  /** Release a gated match-history service once the route is open. */
  releaseImport?: boolean;
  /** Stop the client once the route is open, then wait for the app to notice. */
  stopClient?: boolean;
}

declare module "./states.ts" {
  interface StateRow {
    client?: ClientSpec;
  }
}

const FULL: Viewport = { width: 1280, height: 820 };
const RAIL: Viewport = { width: 1179, height: 820 };
const FIRST_MATCH_ROW = "button.group.relative.flex.w-full";

const clientRow = (
  id: string,
  route: string,
  expect: string,
  client: ClientSpec,
  extra: { viewport?: Viewport; steps?: Step[] } = {},
): StateRow => ({
  id,
  group: "client",
  route,
  viewport: extra.viewport ?? FULL,
  expect,
  steps: extra.steps,
  client,
});

const idle = { scenario: "connected-idle", ready: "Connected" } as const;
const away = { scenario: null, ready: "Disconnected" } as const;
const holding = { scenario: null, hold: true, ready: "Connecting..." } as const;
const importing = {
  scenario: "backfill-running",
  ready: "Connected",
  releaseImport: true,
} as const;

export const CLIENT_STATES: StateRow[] = [
  clientRow("status-connected", "/", FIRST_MATCH_ROW, idle),
  clientRow("status-ingame", "/", FIRST_MATCH_ROW, { scenario: "in-game", ready: "In Game" }),
  clientRow("status-connecting", "/", FIRST_MATCH_ROW, holding),
  clientRow("status-disconnected", "/", FIRST_MATCH_ROW, away),
  clientRow("status-connected-rail", "/", FIRST_MATCH_ROW, idle, { viewport: RAIL }),
  clientRow(
    "status-ingame-rail",
    "/",
    FIRST_MATCH_ROW,
    { scenario: "in-game", ready: "In Game" },
    { viewport: RAIL },
  ),

  clientRow("live-champ-select", "/live", "text=Waiting for your next game", {
    scenario: "champ-select",
    ready: "Connected",
  }),
  clientRow("live-loading", "/live", "text=The game is loading", {
    scenario: "in-game-loading",
    ready: "In Game",
  }),
  clientRow("live-in-game", "/live", "text=Live Game", {
    scenario: "in-game",
    ready: "In Game",
  }),
  clientRow("live-waiting", "/live", "text=Fetching the results", {
    scenario: "results-late",
    options: { misses: 99 },
    ready: "In Game",
    play: true,
    after: "Connected",
  }),
  clientRow("live-results-late", "/live", "text=Your most recent recorded game", {
    scenario: "results-late",
    ready: "In Game",
    play: true,
    after: "Connected",
    awaitGame: true,
  }),
  clientRow("live-game-over-recorded", "/live", "text=Your most recent recorded game", {
    scenario: "end-of-game",
    ready: "In Game",
    play: true,
    after: "Connected",
    awaitGame: true,
  }),
  clientRow("live-standby-connected", "/live", "text=Waiting for your next game", idle),
  clientRow("live-standby-connecting", "/live", "text=Waiting for your next game", holding),
  clientRow("live-standby-offline-empty", "/live", "text=Start the League client", {
    ...away,
    empty: true,
  }),
  clientRow("live-standby-connected-empty", "/live", "text=No recorded games yet", {
    ...idle,
    empty: true,
  }),

  clientRow("match-history-empty-offline", "/", "text=Waiting for the League client", {
    ...away,
    empty: true,
  }),
  clientRow("match-history-empty-connecting", "/", "text=Waiting for the League client", {
    ...holding,
    empty: true,
  }),
  clientRow("match-history-empty-connected", "/", "text=No ARAM Mayhem games found yet", {
    ...idle,
    empty: true,
  }),
  clientRow("match-history-empty-importing", "/", "text=0 of 40 games checked", {
    ...importing,
    options: { served: 0 },
    empty: true,
  }),
  clientRow("match-history-empty-walking", "/", "text=Importing your match history...", {
    scenario: "backfill-walking",
    ready: "Connected",
    empty: true,
  }),
  clientRow("match-history-eog-captured", "/", FIRST_MATCH_ROW, {
    scenario: "end-of-game",
    ready: "In Game",
    play: true,
    after: "Connected",
    awaitGame: true,
  }),

  clientRow("backfill-toast-running", "/", "text=12 / 40", importing),
  clientRow("backfill-toast-done", "/", "text=Imported 3 past game(s)", {
    scenario: "backfill-done",
    ready: "Connected",
    releaseImport: true,
  }),
  clientRow("backfill-toast-error", "/", "text=Import failed", {
    scenario: "backfill-error",
    ready: "Connected",
    releaseImport: true,
  }),

  clientRow("challenges-loaded", "/challenges", "text=Parity Authority", {
    scenario: "challenges-loaded",
    ready: "Connected",
  }),
  clientRow("challenges-offline-empty", "/challenges", "text=isn't running", {
    ...away,
    empty: true,
  }),
  clientRow("challenges-offline-stored", "/challenges", "text=Parity Authority", {
    scenario: "challenges-loaded",
    ready: "Connected",
    stopClient: true,
  }),
];
