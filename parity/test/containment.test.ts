import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { waitForNoGame } from "../lib/no-game.ts";
import { SNAPSHOT_DIRS } from "../lib/data.ts";
import {
  assertNoEscapingLinks,
  assertRunFolderPinned,
  checkoutStamp,
  prepareRun,
  readFaults,
  stampDiff,
} from "../run-electron.ts";

const seam = path.resolve(import.meta.dir, "../seam.cjs");
const scratch = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bmt-contain-")));

describe("run folder containment", () => {
  test("a run folder that is a symlink to elsewhere is refused", () => {
    const dir = scratch();
    fs.mkdirSync(path.join(dir, "elsewhere"));
    fs.symlinkSync(path.join(dir, "elsewhere"), path.join(dir, "run"));
    expect(() => assertRunFolderPinned(path.join(dir, "run"))).toThrow(/resolves to/);
  });

  test("a plain run folder passes", () => {
    const dir = scratch();
    fs.mkdirSync(path.join(dir, "run"));
    expect(() => assertRunFolderPinned(path.join(dir, "run"))).not.toThrow();
  });

  test("a symlinked out/ inside the run folder is refused, a symlinked node_modules is not", () => {
    const dir = scratch();
    const run = path.join(dir, "run");
    const elsewhere = path.join(dir, "elsewhere");
    fs.mkdirSync(path.join(elsewhere, "main"), { recursive: true });
    fs.writeFileSync(path.join(elsewhere, "main", "index.js"), "");
    fs.mkdirSync(run);
    fs.symlinkSync(elsewhere, path.join(run, "node_modules"));
    fs.symlinkSync(elsewhere, path.join(run, "out"));
    expect(() => assertNoEscapingLinks(run)).toThrow(/outside the run folder/);
  });

  test("a stamp of the checkout shows data written beside it and nothing else", () => {
    const repo = scratch();
    spawnSync("git", ["init", "-q"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "a.txt"), "a");
    const before = checkoutStamp(repo);
    expect(stampDiff(before, checkoutStamp(repo))).toEqual([]);
    fs.mkdirSync(path.join(repo, "data"));
    fs.writeFileSync(path.join(repo, "data", "matches.db"), "x");
    fs.mkdirSync(path.join(repo, "logs"));
    const leaks = stampDiff(before, checkoutStamp(repo));
    expect(leaks.some((leak) => leak.includes("data/matches.db"))).toBe(true);
  });

  const fixture = fs.existsSync(path.join(SNAPSHOT_DIRS.fixture, "data", "matches.db"));
  test.skipIf(!fixture)(
    "a repo whose out/ is a symlink is copied, not linked, so the app's data root stays in the run folder",
    () => {
      const dir = scratch();
      const repo = path.join(dir, "repo");
      const real = path.join(dir, "built");
      fs.mkdirSync(path.join(real, "main"), { recursive: true });
      fs.writeFileSync(path.join(real, "main", "index.js"), "");
      fs.mkdirSync(path.join(repo, "node_modules"), { recursive: true });
      fs.writeFileSync(
        path.join(repo, "package.json"),
        JSON.stringify({ name: "x", version: "1.0.0", main: "./out/main/index.js" }),
      );
      fs.symlinkSync(real, path.join(repo, "out"));
      const run = path.join(dir, "run");
      prepareRun({ data: "fixture", runDir: run, repo });
      expect(fs.lstatSync(path.join(run, "out")).isSymbolicLink()).toBe(false);
      expect(fs.realpathSync(path.join(run, "out", "main", "index.js"))).toBe(
        path.join(run, "out", "main", "index.js"),
      );
    },
  );
});

describe("main-process faults under the seam", () => {
  function runNode(script: string) {
    const dir = scratch();
    fs.mkdirSync(path.join(dir, "logs"));
    const log = path.join(dir, "seam.log");
    const result = spawnSync("node", ["-r", seam, "-e", script], {
      env: { ...process.env, SEAM_LOG: log, SEAM_RUN_DIR: dir },
      encoding: "utf8",
      timeout: 30_000,
    });
    return { result, log, main: path.join(dir, "logs", "main.log") };
  }

  test("an uncaught exception and an unhandled rejection land in seam.log and main.log", () => {
    const { log, main } = runNode(`
      setTimeout(() => { throw new Error("boom-sync"); }, 0);
      setTimeout(() => { Promise.reject(new Error("boom-async")); }, 5);
      setTimeout(() => {}, 100);
    `);
    const faults = readFaults(log);
    expect(faults.length).toBe(2);
    expect(faults[0]).toContain("uncaughtException Error: boom-sync");
    expect(faults[0]).toContain("at ");
    expect(faults[1]).toContain("unhandledRejection Error: boom-async");
    expect(fs.readFileSync(main, "utf8")).toContain("FATAL uncaughtException Error: boom-sync");
  });

  const require = createRequire(import.meta.url);
  let binary = "";
  try {
    binary = require(path.resolve(import.meta.dir, "../../node_modules/electron")) as string;
  } catch {
    binary = "";
  }
  const hasElectron = process.platform === "darwin" && binary !== "" && fs.existsSync(binary);

  test.skipIf(!hasElectron)(
    "in Electron a throw is a fault, the error dialog is stubbed, and an event on a destroyed window is dropped",
    async () => {
      await waitForNoGame();
      const dir = scratch();
      fs.mkdirSync(path.join(dir, "logs"));
      fs.mkdirSync(path.join(dir, "userdata"));
      const main = path.join(dir, "main.js");
      fs.writeFileSync(
        main,
        `
        const { app, dialog, BrowserWindow } = require("electron");
        app.whenReady().then(() => {
          dialog.showErrorBox("title", "body");
          const win = new BrowserWindow({ show: false });
          let ran = false;
          win.on("visibilityChanged", () => { ran = true; throw new TypeError("Object has been destroyed"); });
          win.destroy();
          win.emit("visibilityChanged");
          setTimeout(() => { throw new Error("main-process-throw"); }, 10);
          setTimeout(() => app.exit(ran ? 4 : 0), 400);
        });
        `,
      );
      const log = path.join(dir, "seam.log");
      const result = spawnSync(
        binary,
        [`--user-data-dir=${path.join(dir, "userdata")}`, "-r", seam, main],
        {
          env: { ...process.env, SEAM_LOG: log, SEAM_RUN_DIR: dir, ELECTRON_ENABLE_LOGGING: "0" },
          encoding: "utf8",
          timeout: 60_000,
        },
      );
      expect(result.status).toBe(0);
      const faults = readFaults(log).join("\n");
      expect(faults).toContain("showErrorBox title: body");
      expect(faults).toContain("uncaughtException Error: main-process-throw");
      expect(fs.readFileSync(log, "utf8")).toContain(
        "dropped-event-on-destroyed-window visibilityChanged",
      );
      expect(fs.readFileSync(path.join(dir, "logs", "main.log"), "utf8")).toContain("FATAL");
    },
    90_000,
  );
});
