import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
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

const noTransport: Transport = () => Promise.reject(new Error("no transport"));
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createApi events", () => {
  beforeEach(() => {
    globalThis.window = { __BMT_BOOT__: { platform: "darwin", locale: null } } as never;
  });
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
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
    delete (globalThis as { window?: unknown }).window;
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
