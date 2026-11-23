import { beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildReplayBundle, readEventMethods, readInvokeChannels } from "../run-tauri.ts";
import "../replay-api.js";

type Api = Record<string, (...args: unknown[]) => any>;
const create = (globalThis as any).createBmtReplayApi as (
  bundle: unknown,
  storage?: Storage,
) => Api;

const golden = (fields: Record<string, unknown>) => ({
  format: 1,
  registered: true,
  description: "hand-written for the replay test",
  group: "read",
  seq: 0,
  events: [],
  effects: [],
  files: [],
  nonFinite: [],
  ...fields,
});

const HISTORY = { matches: [{ game_id: 7 }], total: 1 };
const QUEUE_ONLY = { matches: [], total: 0 };

function writeGoldens(dir: string) {
  const put = (channel: string, value: ReturnType<typeof golden>) => {
    const folder = path.join(dir, "ipc", channel.replace(/:/g, "."));
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, `${value.case}.json`), JSON.stringify(value, null, 2));
  };
  const history = { channel: "db:match-history", method: "getMatchHistory" };
  put(
    "db:match-history",
    golden({
      ...history,
      case: "default",
      args: [1, 0],
      outcome: { kind: "value", result: HISTORY },
    }),
  );
  put(
    "db:match-history",
    golden({
      ...history,
      case: "filter-queue",
      args: [1, 0, { queue: 2400 }],
      outcome: { kind: "value", result: QUEUE_ONLY },
    }),
  );
  const get = { channel: "settings:get", method: "getSetting" };
  put(
    "settings:get",
    golden({
      ...get,
      case: "allowed-hide-remakes",
      args: ["hide_remakes"],
      outcome: { kind: "value", result: "false" },
    }),
  );
  const set = { channel: "settings:set", method: "setSetting", group: "settings-write" };
  put(
    "settings:set",
    golden({
      ...set,
      case: "hide-remakes",
      args: ["hide_remakes", "true"],
      outcome: { kind: "void" },
    }),
  );
  put(
    "settings:set",
    golden({
      ...set,
      case: "denied",
      seq: 1,
      args: ["score_formula_version", "9"],
      outcome: {
        kind: "error",
        name: "Error",
        message: "Setting not allowed: score_formula_version",
        invokeMessage:
          "Error invoking remote method 'settings:set': Error: Setting not allowed: score_formula_version",
      },
    }),
  );
  const toggle = { channel: "db:toggle-favorite", method: "toggleFavorite", group: "favorites" };
  put(
    "db:toggle-favorite",
    golden({ ...toggle, case: "first", args: [7], outcome: { kind: "value", result: true } }),
  );
  put(
    "db:toggle-favorite",
    golden({
      ...toggle,
      case: "second",
      seq: 1,
      args: [7],
      outcome: { kind: "value", result: false },
    }),
  );
  fs.mkdirSync(path.join(dir, "events"));
  fs.writeFileSync(
    path.join(dir, "events", "startup.jsonl"),
    [
      { seq: 1, event: "lcu:status-changed", payload: { state: "closed" }, cause: "scenario" },
      { seq: 0, event: "lcu:status-changed", payload: { state: "connecting" }, cause: "scenario" },
    ]
      .map((line) => JSON.stringify(line))
      .join("\n") + "\n",
  );
}

class MemoryStorage {
  private items = new Map<string, string>();
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.items.set(key, value);
  }
}

let bundle: ReturnType<typeof buildReplayBundle>;

beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bmt-replay-"));
  writeGoldens(dir);
  bundle = buildReplayBundle({
    goldenDir: dir,
    methods: readInvokeChannels(),
    events: readEventMethods(),
    platform: "darwin",
    locale: "en-US",
    scenario: "startup",
  });
});

describe("replay api", () => {
  test("it has every method the preload exposes", () => {
    const api = create(bundle);
    expect(Object.keys(readInvokeChannels()).length).toBeGreaterThan(50);
    for (const method of Object.keys(readInvokeChannels()))
      expect(typeof api[method]).toBe("function");
    expect(Object.keys(readEventMethods())).toHaveLength(11);
    for (const method of Object.keys(readEventMethods()))
      expect(typeof api[method]).toBe("function");
    expect(api.platform as unknown).toBe("darwin");
    expect(api.locale as unknown).toBe("en-US");
  });

  test("a known call returns its golden", async () => {
    const api = create(bundle);
    expect(await api.getMatchHistory!(1, 0)).toEqual(HISTORY);
    expect(await api.getMatchHistory!(1, 0, { queue: 2400 })).toEqual(QUEUE_ONLY);
    // A trailing undefined is not recorded, and key order does not matter
    expect(await api.getMatchHistory!(1, 0, undefined)).toEqual(HISTORY);
  });

  test("unmatched arguments fall back to the default case", async () => {
    expect(await create(bundle).getMatchHistory!(1, 50)).toEqual(HISTORY);
  });

  test("an unknown call throws a named error", async () => {
    const api = create(bundle);
    const miss = api.getSeasons!("x").catch((error: Error) => error);
    expect(await miss).toBeInstanceOf(Error);
    expect((await miss).name).toBe("ReplayMiss");
    expect((await miss).message).toBe('ReplayMiss: getSeasons(["x"])');
    expect((api as any).__misses).toEqual(['ReplayMiss: getSeasons(["x"])']);
  });

  test("a recorded error rejects with the message the renderer saw", async () => {
    const api = create(bundle);
    await expect(api.setSetting!("score_formula_version", "9")).rejects.toThrow(
      "Error invoking remote method 'settings:set': Error: Setting not allowed: score_formula_version",
    );
  });

  test("a setting written is read back, across a reload", async () => {
    const storage = new MemoryStorage() as unknown as Storage;
    const api = create(bundle, storage);
    expect(await api.getSetting!("hide_remakes")).toBe("false");
    expect(await api.setSetting!("hide_remakes", "true")).toBeUndefined();
    expect(await api.getSetting!("hide_remakes")).toBe("true");
    expect(await create(bundle, storage).getSetting!("hide_remakes")).toBe("true");
    expect(await create(bundle).getSetting!("hide_remakes")).toBe("false");
  });

  test("a write group answers in order", async () => {
    const api = create(bundle, new MemoryStorage() as unknown as Storage);
    expect(await api.toggleFavorite!(7)).toBe(true);
    expect(await api.toggleFavorite!(7)).toBe(false);
  });

  test("subscriptions get the scenario's events in order and can stop", async () => {
    const api = create(bundle);
    const seen: unknown[] = [];
    const stop = api.onStatusChanged!((status: unknown) => seen.push(status));
    expect(typeof stop).toBe("function");
    await Bun.sleep(5);
    expect(seen).toEqual([{ state: "connecting" }, { state: "closed" }]);
    stop();
    const other = api.onGamesUpdated!(() => seen.push("games"));
    await Bun.sleep(5);
    expect(seen).toHaveLength(2);
    other();
  });

  test("a golden in another format is refused", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bmt-replay-bad-"));
    fs.mkdirSync(path.join(dir, "ipc", "app.version"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "ipc", "app.version", "default.json"),
      JSON.stringify({ format: 2 }),
    );
    expect(() => buildReplayBundle({ goldenDir: dir, methods: {}, events: {} })).toThrow(
      "format 2",
    );
  });
});
