import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  openClientState,
  tauriClientEnv,
  type ClientApp,
  type ClientDeps,
  type ClientLaunch,
} from "../capture-client.ts";
import type { DriveContext } from "../drive.ts";
import type { FakeLcu } from "../fake-lcu.ts";
import type { StateRow } from "../states.ts";

const folders: string[] = [];

afterEach(() => {
  for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
});

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bmt-capture-client-"));
  folders.push(root);
  fs.mkdirSync(path.join(root, "data"));
  fs.writeFileSync(path.join(root, "data", "matches.db"), "");
  const dir = path.join(root, "out", "run");
  fs.mkdirSync(dir, { recursive: true });
  return { data: root, dir };
}

const row = (client: Partial<NonNullable<StateRow["client"]>> = {}): StateRow =>
  ({
    id: "stub-state",
    group: "client",
    route: "/",
    viewport: { width: 1280, height: 820 },
    expect: "body",
    client: { scenario: "connected-idle", ready: "Connected", ...client },
  }) as StateRow;

function stubApp(calls: string[], closeError?: Error): ClientApp<string[]> {
  const engine = { evaluate: async () => "League client: Connected", count: async () => 1 };
  return {
    ctx: { engine, viewport: { width: 1280, height: 820 } } as unknown as DriveContext,
    close: async () => {
      calls.push("app.close");
      if (closeError) throw closeError;
      return calls;
    },
  };
}

function stubFake(calls: string[], stopError?: Error) {
  return {
    scenario: { name: "connected-idle", games: [] },
    requests: [],
    sent: [],
    subscribed: Promise.resolve(),
    finished: Promise.resolve(),
    play() {},
    releaseSgp() {},
    stop: async () => {
      calls.push("fake.stop");
      if (stopError) throw stopError;
    },
  } as unknown as FakeLcu;
}

const deps = (calls: string[], overrides: Partial<ClientDeps> = {}): Partial<ClientDeps> => ({
  loadContext: (() => ({})) as unknown as ClientDeps["loadContext"],
  resolveVars: async () => ({}),
  applyState: (async () => ({})) as unknown as ClientDeps["applyState"],
  settle: (async () => ({ ms: 0, timedOut: false })) as unknown as ClientDeps["settle"],
  ...overrides,
});

const startStub =
  (calls: string[], closeError?: Error) =>
  async (launch: ClientLaunch): Promise<ClientApp<string[]>> => {
    calls.push(`app.start ${launch.fake ? "with" : "without"} a fake`);
    return stubApp(calls, closeError);
  };

describe("closing a client state", () => {
  test("starts no app when the fake client fails to start", async () => {
    const { data, dir } = workspace();
    const calls: string[] = [];
    const failure = new Error("fake would not start");
    await expect(
      openClientState(row(), {
        data,
        dir,
        start: startStub(calls),
        deps: deps(calls, {
          startFakeLcu: async () => {
            throw failure;
          },
        }),
      }),
    ).rejects.toBe(failure);
    expect(calls).toEqual([]);
  });

  test("starts the app after the fake, which a Tauri build reads at launch", async () => {
    const { data, dir } = workspace();
    const calls: string[] = [];
    await openClientState(row(), {
      data,
      dir,
      start: startStub(calls),
      deps: deps(calls, {
        startFakeLcu: async () => {
          calls.push("fake.start");
          return stubFake(calls);
        },
      }),
    });
    expect(calls).toEqual(["fake.start", "app.start with a fake"]);
  });

  test("stops the fake when the app fails to start, and reports both when stopping fails too", async () => {
    const { data, dir } = workspace();
    const calls: string[] = [];
    const failure = new Error("app would not start");
    const start = async () => {
      throw failure;
    };
    await expect(
      openClientState(row(), {
        data,
        dir,
        start,
        deps: deps(calls, { startFakeLcu: async () => stubFake(calls) }),
      }),
    ).rejects.toBe(failure);
    expect(calls).toEqual(["fake.stop"]);
    const rejected = openClientState(row(), {
      data,
      dir,
      start,
      deps: deps(calls, {
        startFakeLcu: async () => stubFake(calls, new Error("stop failed")),
      }),
    });
    await expect(rejected).rejects.toBeInstanceOf(AggregateError);
  });

  test("closes the app even when stopping the fake throws", async () => {
    const { data, dir } = workspace();
    const calls: string[] = [];
    const failure = new Error("stop failed");
    const capture = await openClientState(row(), {
      data,
      dir,
      start: startStub(calls),
      deps: deps(calls, { startFakeLcu: async () => stubFake(calls, failure) }),
    });
    await expect(capture.finish(dir, 0)).rejects.toBe(failure);
    expect(calls).toEqual(["app.start with a fake", "fake.stop", "app.close"]);
  });

  test("stops the fake once when the state stops the client itself", async () => {
    const { data, dir } = workspace();
    const calls: string[] = [];
    const capture = await openClientState(row({ stopClient: true }), {
      data,
      dir,
      start: startStub(calls),
      deps: deps(calls, { startFakeLcu: async () => stubFake(calls) }),
    });
    await capture.drive();
    await capture.finish(dir, 0);
    expect(calls.filter((c) => c === "fake.stop")).toHaveLength(1);
    expect(calls).toContain("app.close");
  });
});

describe("where a Tauri build finds the fake client", () => {
  const launch = (fake: Partial<FakeLcu> | null, hold = false) =>
    ({ fake, hold }) as unknown as ClientLaunch;
  const fake = {
    dir: "/run/fake",
    lockfileDir: "/run/fake/league",
    livePort: 50123,
    sgpUrl: "http://127.0.0.1:50124",
  };

  test("names the fake's lockfile folder, CA, in-game port and match-history service", () => {
    expect(tauriClientEnv(launch(fake))).toEqual({
      BMT_PARITY_LEAGUE_DIR: "/run/fake/league",
      BMT_PARITY_CA: "/run/fake/ca.pem",
      BMT_PARITY_LIVE_PORT: "50123",
      BMT_PARITY_SGP_URL: "http://127.0.0.1:50124",
    });
  });

  test("names no client when there is no fake, and holds the connect loop when asked", () => {
    expect(tauriClientEnv(launch(null))).toEqual({});
    expect(tauriClientEnv(launch(null, true))).toEqual({ BMT_PARITY_HOLD_CONNECT: "1" });
  });

  test("refuses a fake on the real game's port", () => {
    expect(() => tauriClientEnv(launch({ ...fake, livePort: 2999 }))).toThrow("2999");
  });
});
