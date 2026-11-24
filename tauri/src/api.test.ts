import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { emit } from "@tauri-apps/api/event";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { createApi, invokeError, tauriTransport, type Listen } from "./api";
import type { Transport } from "./bindings";

describe("invokeError", () => {
  test("a command's rejection reads as Electron's, with its code", () => {
    const error = invokeError("app:version", {
      name: "Error",
      message: "not ported",
      code: "NOT_PORTED",
    });
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("Error invoking remote method 'app:version': Error: not ported");
    expect(error.code).toBe("NOT_PORTED");
  });

  test("an unknown command reads as Electron's unregistered channel", () => {
    // The text Tauri rejected with in the live probe, and Electron's from the T05 golden
    const error = invokeError(
      "bmt:unregistered-channel",
      "Command bmt:unregistered-channel not found",
    );
    expect(error.message).toBe(
      "Error invoking remote method 'bmt:unregistered-channel': Error: No handler registered for 'bmt:unregistered-channel'",
    );
    expect(error.code).toBeUndefined();
  });

  test("Tauri's own argument errors keep their text", () => {
    const error = invokeError("db:match-detail", "invalid args `gameId` for command");
    expect(error.message).toBe(
      "Error invoking remote method 'db:match-detail': Error: invalid args `gameId` for command",
    );
  });
});

describe("invokeError, Tauri's refusals", () => {
  test("an ACL refusal reads as Electron's unregistered channel", () => {
    const electron =
      "Error invoking remote method 'app:version': Error: No handler registered for 'app:version'";
    expect(invokeError("app:version", "Command app:version not allowed by ACL").message).toBe(
      electron,
    );
    expect(invokeError("app:version", 'app:version not allowed on window "card"').message).toBe(
      electron,
    );
  });

  test("an empty message reads as Error.prototype.toString writes it", () => {
    const error = invokeError("app:version", { name: "Error", message: "" });
    expect(error.message).toBe("Error invoking remote method 'app:version': Error");
  });
});

interface FakeListener {
  event: string;
  handler: (payload: unknown) => void;
  resolve: () => void;
  reject: (error: unknown) => void;
  unlistened: number;
}

/** A `listen` whose promise resolves only when the test says so. */
function fakeListen() {
  const listeners: FakeListener[] = [];
  const listen: Listen = (event, handler) =>
    new Promise((resolve, reject) => {
      const listener: FakeListener = {
        event,
        handler: handler as (payload: unknown) => void,
        resolve: () => resolve(() => listener.unlistened++),
        reject,
        unlistened: 0,
      };
      listeners.push(listener);
    });
  return { listen, listeners };
}

// The DOM window test/setup.ts installs, which other files run against
const pageWindow = globalThis.window;
const noTransport: Transport = () => Promise.reject(new Error("no transport"));
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createApi events", () => {
  beforeEach(() => {
    globalThis.window = { __BMT_BOOT__: { platform: "darwin", locale: null } } as never;
  });
  afterEach(() => {
    globalThis.window = pageWindow;
  });

  test("an unsubscribe before listen resolves still removes the listener", async () => {
    const { listen, listeners } = fakeListen();
    const api = createApi(noTransport, listen);
    const unsubscribe = api.onStatusChanged(() => {});
    unsubscribe();
    listeners[0].resolve();
    await tick();
    expect(listeners[0].event).toBe("lcu:status-changed");
    expect(listeners[0].unlistened).toBe(1);
  });

  test("an unsubscribe after listen resolves removes it once", async () => {
    const { listen, listeners } = fakeListen();
    const seen: unknown[] = [];
    const unsubscribe = createApi(noTransport, listen).onUpdateProgress((p) => seen.push(p));
    listeners[0].resolve();
    await tick();
    listeners[0].handler(50);
    unsubscribe();
    unsubscribe();
    expect(seen).toEqual([50]);
    expect(listeners[0].unlistened).toBe(1);
  });

  test("onGamesUpdated calls back with no argument for the null payload", async () => {
    const { listen, listeners } = fakeListen();
    const calls: unknown[][] = [];
    createApi(noTransport, listen).onGamesUpdated((...args: unknown[]) => calls.push(args));
    listeners[0].resolve();
    await tick();
    listeners[0].handler(null);
    expect(listeners[0].event).toBe("lcu:games-updated");
    expect(calls).toEqual([[]]);
  });

  test("a rejected listen is logged, not left unhandled", async () => {
    const { listen, listeners } = fakeListen();
    const logged = spyOn(console, "error").mockImplementation(() => {});
    createApi(noTransport, listen).onLiveGame(() => {});
    listeners[0].reject(new Error("not allowed"));
    await tick();
    expect(logged).toHaveBeenCalledTimes(1);
    expect(String(logged.mock.calls[0][0])).toBe("listening for live:changed failed");
    logged.mockRestore();
  });

  test("a page without the boot script is refused", () => {
    globalThis.window = {} as never;
    expect(() => createApi(noTransport, fakeListen().listen)).toThrow("__BMT_BOOT__");
  });
});

describe("tauriTransport, answers JSON cannot carry", () => {
  const answering = (result: unknown) => {
    globalThis.window = {
      __BMT_BOOT__: { platform: "darwin", locale: null },
      __TAURI_INTERNALS__: { invoke: () => Promise.resolve(result) },
    } as never;
  };
  afterEach(() => {
    globalThis.window = pageWindow;
  });

  test("a blob setting reaches the page as the Uint8Array Electron hands it", async () => {
    answering({ $bytes: "AAEC/w==" });
    const value: unknown = await createApi(tauriTransport).getSetting("x");
    expect(value).toBeInstanceOf(Uint8Array);
    expect([...(value as Uint8Array)]).toEqual([0, 1, 2, 255]);
  });

  test("a non-finite number in an answer reads back as the number, nested ones included", async () => {
    answering({ champion_id: { $bmtNum: "NaN" }, rows: [{ $bmtNum: "-Infinity" }, 3] });
    const value = (await createApi(tauriTransport).getGlobalChampionDetail(1)) as unknown as {
      champion_id: number;
      rows: number[];
    };
    expect(value.champion_id).toBeNaN();
    expect(value.rows).toEqual([-Infinity, 3]);
  });

  test("sentinels deep in an answer are decoded and every key keeps its place", async () => {
    answering({
      season: "s1",
      groups: [
        { id: 1, members: [{ name: "a", score: { $bmtNum: "NaN" }, kills: 3 }], tags: ["x"] },
        { id: 2, members: [{ name: "b", score: 9, kills: 1 }], tags: [] },
      ],
      card: { blob: { $bytes: "AAEC/w==" }, title: "t" },
      total: { $bmtNum: "Infinity" },
    });
    const value = (await createApi(tauriTransport).getGlobalChampionDetail(1)) as unknown as {
      groups: { members: { score: number }[] }[];
      card: { blob: Uint8Array };
    };
    expect(value).toEqual({
      season: "s1",
      groups: [
        { id: 1, members: [{ name: "a", score: NaN, kills: 3 }], tags: ["x"] },
        { id: 2, members: [{ name: "b", score: 9, kills: 1 }], tags: [] },
      ],
      card: { blob: new Uint8Array([0, 1, 2, 255]), title: "t" },
      total: Infinity,
    } as never);
    expect(value.card.blob).toBeInstanceOf(Uint8Array);
    expect(Object.keys(value)).toEqual(["season", "groups", "card", "total"]);
    expect(Object.keys(value.groups[0]!.members[0]!)).toEqual(["name", "score", "kills"]);
    expect(Object.keys(value.card)).toEqual(["blob", "title"]);
  });

  test("an answer with no sentinels reads back as sent", async () => {
    const answer = { rows: [{ id: 1, name: "a", nested: { list: [1, null, "z"] } }], empty: {} };
    answering(structuredClone(answer));
    const value: unknown = await createApi(tauriTransport).getGlobalChampionDetail(1);
    expect(value).toEqual(answer as never);
  });

  test("an object with other keys beside the sentinel stays an object", async () => {
    answering({ $bytes: "AA==", other: 1 });
    const value: unknown = await createApi(tauriTransport).getSetting("x");
    expect(value).toEqual({ $bytes: "AA==", other: 1 });
  });
});

describe("windowListen, payloads JSON cannot carry", () => {
  beforeEach(() => {
    globalThis.window = {
      __BMT_BOOT__: { platform: "darwin", locale: null },
      crypto: globalThis.crypto,
    } as never;
    mockWindows("main");
    mockIPC(() => null, { shouldMockEvents: true });
  });
  afterEach(() => {
    clearMocks();
    globalThis.window = pageWindow;
  });

  test("a live game's non-finite numbers reach the page as the numbers", async () => {
    const seen: unknown[] = [];
    createApi(noTransport).onLiveGame((game) => seen.push(game));
    await tick();
    await emit("live:changed", {
      respawnTimer: { $bmtNum: "Infinity" },
      players: [{ level: { $bmtNum: "NaN" }, kills: 2 }],
    });
    const [game] = seen as [{ respawnTimer: number; players: { level: number; kills: number }[] }];
    expect(game.respawnTimer).toBe(Infinity);
    expect(game.players[0].level).toBeNaN();
    expect(game.players[0].kills).toBe(2);
  });

  test("a challenges payload's blob reaches the page as a Uint8Array", async () => {
    const seen: unknown[] = [];
    createApi(noTransport).onChallengesChanged((state) => seen.push(state));
    await tick();
    await emit("challenges:changed", { blob: { $bytes: "AAEC/w==" } });
    const [state] = seen as [{ blob: Uint8Array }];
    expect(state.blob).toBeInstanceOf(Uint8Array);
    expect([...state.blob]).toEqual([0, 1, 2, 255]);
  });
});

describe("tauriTransport, numbers JSON cannot carry", () => {
  let sent: string[];
  beforeEach(() => {
    sent = [];
    globalThis.window = {
      __BMT_BOOT__: { platform: "darwin", locale: null },
      // @tauri-apps/api's invoke hands its arguments here, and Tauri sends them as JSON
      __TAURI_INTERNALS__: {
        invoke: (_cmd: string, args: unknown) => {
          sent.push(JSON.stringify(args));
          return Promise.resolve(null);
        },
      },
    } as never;
  });
  afterEach(() => {
    globalThis.window = pageWindow;
  });

  // The wire text js_arg.rs's tests decode
  test.each([
    [Number("all"), '{"queue":{"$bmtNum":"NaN"}}'],
    [Infinity, '{"queue":{"$bmtNum":"Infinity"}}'],
    [-Infinity, '{"queue":{"$bmtNum":"-Infinity"}}'],
  ])("getGlobalStats(undefined, %p) sends the number", async (queue, json) => {
    await createApi(tauriTransport).getGlobalStats(undefined, queue);
    expect(sent).toEqual([json]);
  });

  test("a finite number, null and undefined go as before, nested ones included", async () => {
    const api = createApi(tauriTransport);
    await api.getGlobalStats("16.1", 2400);
    await api.getMatchHistory(50, 0, { queue: Number.NaN, championId: 2, patch: undefined });
    await api.getSeasonRecap("s1", -Infinity, undefined);
    expect(sent).toEqual([
      '{"patch":"16.1","queue":2400}',
      '{"limit":50,"offset":0,"filters":{"queue":{"$bmtNum":"NaN"},"championId":2}}',
      '{"seasonId":"s1","queue":{"$bmtNum":"-Infinity"}}',
    ]);
  });
});

describe("startup reads", () => {
  let sent: string[];
  let answers: (() => void)[];
  // Answers a request only when the test says so, with its channel and place in line
  const transport: Transport = <T>(channel: string) => {
    sent.push(channel);
    const n = sent.length;
    return new Promise<T>((resolve) => answers.push(() => resolve({ channel, n } as T)));
  };
  const answerAll = () => answers.splice(0).forEach((answer) => answer());
  beforeEach(() => {
    sent = [];
    answers = [];
    globalThis.window = { __BMT_BOOT__: { platform: "darwin", locale: null } } as never;
  });
  afterEach(() => {
    globalThis.window = pageWindow;
  });

  for (const [method, channel] of [
    ["getProfile", "db:profile"],
    ["isBackfillRunning", "lcu:backfill-running"],
    ["getLcuStatus", "lcu:status"],
  ] as const) {
    test(`${method} asked for twice at once sends one request, and both get its answer`, async () => {
      const api = createApi(transport);
      const both = Promise.all([api[method](), api[method]()]);
      answerAll();
      expect(await both).toEqual([
        { channel, n: 1 },
        { channel, n: 1 },
      ] as never);
      expect(sent).toEqual([channel]);
    });

    test(`${method} asked for again later sends its own request, in flight or not`, async () => {
      const api = createApi(transport);
      const first = api[method]();
      await tick();
      const second = api[method]();
      answerAll();
      expect(await Promise.all([first, second])).toEqual([
        { channel, n: 1 },
        { channel, n: 2 },
      ] as never);
      const third = api[method]();
      answerAll();
      expect(await third).toEqual({ channel, n: 3 } as never);
      expect(sent).toEqual([channel, channel, channel]);
    });
  }
});
