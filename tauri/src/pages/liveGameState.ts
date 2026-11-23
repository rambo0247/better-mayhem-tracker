import { MAYHEM_QUEUE_IDS } from "../shared/queues";
import type { LcuStatus, LiveGameSnapshot } from "../lib/types";

// How long to keep waiting for a finished game's results before giving up and
// showing the most recent recorded one instead. The post-game capture normally
// lands within seconds; this only matters when the client never publishes the
// game at all, which a dodged or unfinished match manages.
export const RESULT_WAIT_MS = 90_000;
export const RESULT_RETRY_MS = 4_000;

export interface WatchedGame {
  gameId: number;
  queueId: number | null;
}

// Whether a finished game is one the app would have stored, so the page knows
// whether to wait for results at all. A game in some other queue is recorded
// nowhere and would leave the page waiting forever.
export function isTrackedQueue(queueId: number | null): boolean {
  return queueId != null && MAYHEM_QUEUE_IDS.includes(queueId);
}

export type PageView =
  | { kind: "loading" }
  | { kind: "live" }
  | { kind: "recap"; target: number | null };

// Nothing has been asked yet, as opposed to asked and answered with no game.
// Otherwise the page is the live scoreboard while a match runs and the recap
// of one specific game, or of the newest recorded game, once it is over.
export function pageView(
  snapshot: LiveGameSnapshot | null,
  lastGame: WatchedGame | null,
): PageView {
  if (!snapshot) return { kind: "loading" };
  if (snapshot.inGame || snapshot.starting) return { kind: "live" };

  // Null means "whatever the newest recorded game is", which is what the page
  // falls back to on a fresh launch and after a game that was never stored.
  // The snapshot carries the last game the main process saw, which is what
  // covers leaving the tab and coming back before the results have landed.
  const watching =
    lastGame ??
    (snapshot.gameId != null ? { gameId: snapshot.gameId, queueId: snapshot.queueId } : null);
  return {
    kind: "recap",
    target: watching && isTrackedQueue(watching.queueId) ? watching.gameId : null,
  };
}

export type RecapScreen = "loading" | "waiting" | "standby";

export interface RecapInput {
  target: number | null;
  // The game id of the recap on screen, null when there is none
  recapGameId: number | null;
  loading: boolean;
  gaveUp: boolean;
}

// Whether the game the page asked about is the one on screen
export function isResolved({ target, recapGameId }: RecapInput): boolean {
  return target == null ? recapGameId != null : recapGameId === target;
}

export function isWaiting(input: RecapInput): boolean {
  return input.target != null && !isResolved(input) && !input.gaveUp;
}

export function recapScreen(input: RecapInput): RecapScreen {
  const waiting = isWaiting(input);
  if (input.loading && input.recapGameId == null && !waiting) return "loading";
  return waiting ? "waiting" : "standby";
}

export type Standby = "offline" | "next-game" | "no-games";

// What the standby panel says: what the page waits for, given whether the
// client it waits on is there and whether there is a game to look back on
export function standbyKind(status: LcuStatus, hasRecap: boolean): Standby {
  if (status === "disconnected") return "offline";
  return hasRecap ? "next-game" : "no-games";
}

// Keeps an older game on screen only until the real answer arrives, never in
// place of it
export function nextRecapGameId(
  target: number | null,
  previous: number | null,
  incoming: number,
): number {
  return target != null && incoming !== target && previous != null ? previous : incoming;
}
