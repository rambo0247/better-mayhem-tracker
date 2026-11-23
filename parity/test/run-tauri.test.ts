import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { childEnv, startTauri, stopApp, TauriEngine, type TauriDriver } from "../run-tauri.ts";

const scratch = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bmt-tauri-")));

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("the Tauri child's environment", () => {
  test("is built from a short host list and the run's own values", () => {
    const env = childEnv(
      {
        PATH: "/usr/bin",
        HOME: "/Users/me",
        Path: "C:\\Windows",
        BMT_PARITY_RENDERER_DIR: "/stale/renderer",
        BMT_PARITY_WEBVIEW_DATA: "/stale/webview2",
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9222",
        NODE_OPTIONS: "-r /tmp/x.js",
        TZ: "Europe/Paris",
      },
      { TZ: "America/New_York", BMT_PARITY_TOKEN: "t".repeat(32) },
    );
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/Users/me",
      Path: "C:\\Windows",
      TZ: "America/New_York",
      BMT_PARITY_TOKEN: "t".repeat(32),
    });
  });
});

describe("stopping the app", () => {
  test("a failed quit still ends the app, then fails", async () => {
    const child = spawn("sleep", ["30"]);
    await expect(stopApp(child, () => Promise.reject(new Error("driver gone")))).rejects.toThrow(
      /quit failed.*driver gone/,
    );
    expect(child.signalCode).toBe("SIGTERM");
    expect(alive(child.pid!)).toBe(false);
  });

  test("an app that quits is not signalled", async () => {
    const child = spawn("sleep", ["30"]);
    await stopApp(child, async () => child.kill("SIGINT"));
    expect(child.signalCode).toBe("SIGINT");
  });
});

describe.skipIf(process.platform === "win32")("launching", () => {
  test("an app that never prints the ready line is killed", async () => {
    const dir = scratch();
    const pidFile = path.join(dir, "pid");
    const binary = path.join(dir, "fake-tauri");
    fs.writeFileSync(binary, `#!/bin/sh\necho $$ > "${pidFile}"\nexec sleep 300\n`, {
      mode: 0o755,
    });
    await expect(
      startTauri({
        renderer: "solid",
        binary,
        runDir: path.join(dir, "run"),
        readyTimeoutMs: 1500,
      }),
    ).rejects.toThrow(/no "bmt-parity-driver-v1 listening" line within 1500 ms/);
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    expect(pid).toBeGreaterThan(0);
    expect(alive(pid)).toBe(false);
    fs.rmSync(dir, { recursive: true });
  });

  test("a symlink deep in the asset cache is refused, not carried or followed", async () => {
    const dir = scratch();
    const standIn = path.join(dir, "stand-in-real-folder");
    fs.mkdirSync(standIn);
    fs.writeFileSync(path.join(standIn, "matches.db"), "real");
    const data = path.join(dir, "source");
    fs.mkdirSync(path.join(data, "data"), { recursive: true });
    fs.writeFileSync(path.join(data, "data", "matches.db"), "");
    fs.mkdirSync(path.join(data, "asset-cache", "champion"), { recursive: true });
    fs.writeFileSync(path.join(data, "asset-cache", "champion", "1.png"), "png");
    fs.symlinkSync(standIn, path.join(data, "asset-cache", "champion", "elsewhere"));
    const binary = path.join(dir, "fake-tauri");
    fs.writeFileSync(binary, "#!/bin/sh\nexec sleep 300\n", { mode: 0o755 });
    const run = path.join(dir, "run");
    await expect(
      startTauri({ data, renderer: "solid", binary, runDir: run, readyTimeoutMs: 500 }),
    ).rejects.toThrow(/asset-cache\/champion\/elsewhere is a symlink/);
    const carried = fs
      .readdirSync(run, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isSymbolicLink());
    expect(carried).toEqual([]);
    expect(fs.readFileSync(path.join(standIn, "matches.db"), "utf8")).toBe("real");
    fs.rmSync(dir, { recursive: true });
  });

  test("the empty data source starts with no asset cache", async () => {
    const dir = scratch();
    const binary = path.join(dir, "fake-tauri");
    fs.writeFileSync(binary, "#!/bin/sh\nexec sleep 300\n", { mode: 0o755 });
    const run = path.join(dir, "run");
    await expect(
      startTauri({ data: "empty", renderer: "solid", binary, runDir: run, readyTimeoutMs: 500 }),
    ).rejects.toThrow(/no "bmt-parity-driver-v1 listening" line/);
    expect(fs.existsSync(path.join(run, "asset-cache"))).toBe(false);
    fs.rmSync(dir, { recursive: true });
  });

  test("a run folder a parity run did not make is left alone", async () => {
    const dir = scratch();
    const run = path.join(dir, "run");
    fs.mkdirSync(run);
    fs.writeFileSync(path.join(run, "keep.txt"), "mine");
    await expect(
      startTauri({ renderer: "solid", binary: "/nonexistent", runDir: run }),
    ).rejects.toThrow(/not made by a parity run/);
    expect(fs.readFileSync(path.join(run, "keep.txt"), "utf8")).toBe("mine");
    fs.rmSync(dir, { recursive: true });
  });
});

/**
 * A window whose page loses a strip to the title bar and whose screen stops it at a
 * maximum height, answering the driver calls `resizeWindow` makes.
 */
function fakeWindow(options: { inset: number; maxWindowHeight: number; maxWindowWidth?: number }) {
  const window = { width: 1280, height: 820 };
  const resizes: [number, number][] = [];
  const page = () => [
    Math.min(window.width, options.maxWindowWidth ?? Infinity),
    Math.min(window.height, options.maxWindowHeight) - options.inset,
  ];
  const driver = {
    port: 0,
    async call(op: string, body: Record<string, unknown> = {}) {
      if (op === "resize") {
        window.width = body.width as number;
        window.height = body.height as number;
        resizes.push([window.width, window.height]);
        return Response.json({});
      }
      if (op === "eval") return Response.json(page());
      throw new Error(`unexpected ${op}`);
    },
    async json(op: string) {
      if (op === "viewport") return { emulated: false };
      throw new Error(`unexpected ${op}`);
    },
  };
  return { engine: new TauriEngine(driver as unknown as TauriDriver), resizes };
}

describe("steering the Tauri window by the page's size", () => {
  test("grows the window by the title bar strip until the page has the asked size", async () => {
    const { engine, resizes } = fakeWindow({ inset: 32, maxWindowHeight: 5000 });
    await engine.resizeWindow(1280, 820);
    expect(resizes.at(-1)).toEqual([1280, 852]);
    expect(engine.clamped).toBeUndefined();
    await engine.resizeWindow(1179, 820);
    expect(resizes.at(-1)).toEqual([1179, 852]);
  });

  test("records a screen clamp instead of failing", async () => {
    const { engine } = fakeWindow({ inset: 32, maxWindowHeight: 1410 });
    await engine.resizeWindow(1200, 1600);
    expect(engine.clamped).toEqual({ asked: [1200, 1600], seen: [1200, 1378] });
  });

  test("fails when the width cannot be reached", async () => {
    const { engine } = fakeWindow({ inset: 32, maxWindowHeight: 5000, maxWindowWidth: 900 });
    await expect(engine.resizeWindow(1280, 820)).rejects.toThrow(/the page sees 900x820/);
  });
});
