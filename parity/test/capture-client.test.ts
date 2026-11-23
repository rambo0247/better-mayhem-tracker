import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openClientState, type ClientDeps } from "../capture-client.ts";
import type { FakeLcu } from "../fake-lcu.ts";
import type { RunningElectron } from "../run-electron.ts";
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

function stubApp(calls: string[], closeError?: Error) {
  const page = {
    context: () => ({ addInitScript: async () => {} }),
    waitForFunction: async () => {},
    locator: () => ({ first: () => ({ waitFor: async () => {} }), count: async () => 1 }),
  };
  return {
    page,
    ctx: { viewport: { width: 1280, height: 820 } },
    close: async () => {
      calls.push("app.close");
      if (closeError) throw closeError;
      return { faults: [], leaks: [] };
    },
  } as unknown as RunningElectron;
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
  startElectron: async () => stubApp(calls),
  loadContext: (() => ({})) as unknown as ClientDeps["loadContext"],
  resolveVars: async () => ({}),
  applyState: (async () => ({})) as unknown as ClientDeps["applyState"],
  settle: (async () => ({ ms: 0, timedOut: false })) as unknown as ClientDeps["settle"],
  ...overrides,
});

describe("closing a client state", () => {
  test("closes the app when the fake client fails to start", async () => {
    const { data, dir } = workspace();
    const calls: string[] = [];
    const failure = new Error("fake would not start");
    await expect(
      openClientState(row(), {
        data,
        dir,
        deps: deps(calls, {
          startFakeLcu: async () => {
            throw failure;
          },
        }),
      }),
    ).rejects.toBe(failure);
    expect(calls).toEqual(["app.close"]);
  });

  test("reports both errors when the fake and the app both fail on startup", async () => {
    const { data, dir } = workspace();
    const calls: string[] = [];
    const rejected = openClientState(row(), {
      data,
      dir,
      deps: deps(calls, {
        startElectron: async () => stubApp(calls, new Error("close failed")),
        startFakeLcu: async () => {
          throw new Error("fake would not start");
        },
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
      deps: deps(calls, { startFakeLcu: async () => stubFake(calls, failure) }),
    });
    await expect(capture.finish(dir)).rejects.toBe(failure);
    expect(calls).toEqual(["fake.stop", "app.close"]);
  });

  test("stops the fake once when the state stops the client itself", async () => {
    const { data, dir } = workspace();
    const calls: string[] = [];
    const capture = await openClientState(row({ stopClient: true }), {
      data,
      dir,
      deps: deps(calls, { startFakeLcu: async () => stubFake(calls) }),
    });
    await capture.drive();
    await capture.finish(dir);
    expect(calls.filter((c) => c === "fake.stop")).toHaveLength(1);
    expect(calls).toContain("app.close");
  });
});
