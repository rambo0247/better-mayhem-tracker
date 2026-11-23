import { afterEach, expect, test } from "bun:test";
import { restoreSettings, runStep, type DriveContext, type Engine } from "../drive.ts";

function context(setSetting: (key: string, value: string) => Promise<void>) {
  const settings: Record<string, string> = { session_grouping: "day" };
  (globalThis as any).window = {
    api: {
      getSetting: async (key: string) => settings[key] ?? null,
      setSetting: async (key: string, value: string) => {
        await setSetting(key, value);
        settings[key] = value;
      },
    },
  };
  const engine = {
    evaluate: async (fn: (arg: unknown) => unknown, arg?: unknown) => fn(arg),
  } as unknown as Engine;
  const ctx: DriveContext = {
    engine,
    viewport: { width: 1280, height: 820 },
    touchedSettings: new Map(),
  };
  return { ctx, settings };
}

afterEach(() => {
  delete (globalThis as any).window;
});

test("a setting step that changed the setting is undone after the state", async () => {
  const { ctx, settings } = context(async () => {});
  await runStep(ctx, { op: "setting", key: "session_grouping", value: "week" });
  await runStep(ctx, { op: "setting", key: "session_grouping", value: "none" });
  expect(settings.session_grouping).toBe("none");
  await restoreSettings(ctx);
  expect(settings.session_grouping).toBe("day");
  expect(ctx.touchedSettings.size).toBe(0);
});

test("a setting write that failed leaves nothing to undo", async () => {
  const { ctx } = context(async () => {
    throw new Error("ReplayMiss");
  });
  await expect(
    runStep(ctx, { op: "setting", key: "session_grouping", value: "week" }),
  ).rejects.toThrow("ReplayMiss");
  expect(ctx.touchedSettings.size).toBe(0);
});

test("a restore that fails fails once, not for every state after it", async () => {
  let fail = false;
  const { ctx } = context(async () => {
    if (fail) throw new Error("ReplayMiss");
  });
  await runStep(ctx, { op: "setting", key: "session_grouping", value: "week" });
  fail = true;
  await expect(restoreSettings(ctx)).rejects.toThrow("ReplayMiss");
  await restoreSettings(ctx);
});
