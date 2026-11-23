import { describe, expect, test } from "bun:test";
import type { LcuStatus, LiveGameSnapshot } from "../lib/types";
import {
  isResolved,
  nextRecapGameId,
  pageView,
  recapScreen,
  standbyKind,
  type PageView,
  type RecapInput,
  type Standby,
  type WatchedGame,
} from "./liveGameState";

const MAYHEM = 2400;
const SUMMONERS_RIFT = 420;

function snapshot(patch: Partial<LiveGameSnapshot> = {}): LiveGameSnapshot {
  return {
    inGame: false,
    starting: false,
    gameId: null,
    queueId: null,
    mapId: null,
    mapName: null,
    mapSkin: null,
    gameTime: 0,
    players: [],
    events: [],
    ...patch,
  };
}

const loadingScreen = snapshot({ starting: true, gameId: 77, queueId: MAYHEM });
const running = snapshot({ inGame: true, gameId: 77, queueId: MAYHEM, gameTime: 12 });
const over = snapshot({ gameId: 77, queueId: MAYHEM });
const idle = snapshot();

// What main process pushes across one game, and what the hook keeps beside it:
// the last game seen running, which outlives the snapshot that describes it
function replay(sequence: LiveGameSnapshot[]): PageView[] {
  let lastGame: WatchedGame | null = null;
  return sequence.map((snap) => {
    if (snap.inGame && snap.gameId) lastGame = { gameId: snap.gameId, queueId: snap.queueId };
    return pageView(snap, lastGame);
  });
}

describe("page view across a game", () => {
  test("nothing asked yet is loading, not standby", () => {
    expect(pageView(null, null)).toEqual({ kind: "loading" });
  });

  test("a fresh launch with no game recaps the newest recorded one", () => {
    expect(pageView(idle, null)).toEqual({ kind: "recap", target: null });
  });

  test("loading screen, play, then the wait for that game's results", () => {
    expect(replay([idle, loadingScreen, running, running, over])).toEqual([
      { kind: "recap", target: null },
      { kind: "live" },
      { kind: "live" },
      { kind: "live" },
      { kind: "recap", target: 77 },
    ]);
  });

  test("coming back to the tab after the game ended still waits for it", () => {
    expect(pageView(over, { gameId: 77, queueId: MAYHEM })).toEqual({ kind: "recap", target: 77 });
  });

  test("the snapshot's own game is the target when the page never saw it run", () => {
    expect(pageView(over, null)).toEqual({ kind: "recap", target: 77 });
  });

  test("a game in an untracked queue is never waited for", () => {
    const other = snapshot({ gameId: 9, queueId: SUMMONERS_RIFT });
    expect(pageView(other, { gameId: 9, queueId: SUMMONERS_RIFT })).toEqual({
      kind: "recap",
      target: null,
    });
  });

  test("a game with no queue is never waited for", () => {
    expect(pageView(snapshot({ gameId: 9 }), null)).toEqual({ kind: "recap", target: null });
  });
});

function screen(input: Partial<RecapInput>): string {
  return recapScreen({ target: null, recapGameId: null, loading: true, gaveUp: false, ...input });
}

describe("recap screen", () => {
  test("loading until the first answer, with nothing to wait for", () => {
    expect(screen({})).toBe("loading");
  });

  test("an answer with no games leaves standby", () => {
    expect(screen({ loading: false })).toBe("standby");
  });

  test("results-late: waiting while the game is missing, then the recap", () => {
    expect(screen({ target: 77 })).toBe("waiting");
    expect(screen({ target: 77, loading: false })).toBe("waiting");
    expect(screen({ target: 77, loading: false, recapGameId: 70 })).toBe("waiting");
    expect(screen({ target: 77, loading: false, recapGameId: 77 })).toBe("standby");
  });

  test("giving up shows the older game instead of waiting", () => {
    expect(screen({ target: 77, loading: false, recapGameId: 70, gaveUp: true })).toBe("standby");
  });

  test("a new target waits again with the older recap kept on screen", () => {
    const shown = { recapGameId: 77, loading: false };
    expect(screen({ ...shown, target: 77 })).toBe("standby");
    expect(screen({ ...shown, target: 78 })).toBe("waiting");
  });

  test("a recap that landed for no target counts as resolved", () => {
    expect(isResolved({ target: null, recapGameId: 5, loading: false, gaveUp: false })).toBe(true);
  });
});

describe("older game standing in", () => {
  test("an older game is kept only until the real one arrives", () => {
    expect(nextRecapGameId(77, 70, 60)).toBe(70);
    expect(nextRecapGameId(77, 70, 77)).toBe(77);
  });

  test("with nothing on screen an older game is better than none", () => {
    expect(nextRecapGameId(77, null, 60)).toBe(60);
  });

  test("with no target the newest game always wins", () => {
    expect(nextRecapGameId(null, 70, 80)).toBe(80);
  });
});

describe("standby text", () => {
  const cases: [LcuStatus, boolean, Standby][] = [
    ["disconnected", false, "offline"],
    ["disconnected", true, "offline"],
    ["connecting", true, "next-game"],
    ["connected", true, "next-game"],
    ["connected", false, "no-games"],
    ["connecting", false, "no-games"],
  ];
  test.each(cases)("%s with recap %p says %s", (status, hasRecap, expected) => {
    expect(standbyKind(status, hasRecap)).toBe(expected);
  });
});
