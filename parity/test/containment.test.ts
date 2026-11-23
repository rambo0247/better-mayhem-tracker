import { Database } from "bun:sqlite";
import { takeCaptureLock } from "../capture.ts";
import { beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { isUnderRealFolder, realDataRoots } from "../lib/real-folder.ts";
import { SNAPSHOT_DIRS } from "../lib/data.ts";
import { waitForNoGame } from "../lib/no-game.ts";
import {
  assertNoEscapingLinks,
  assertRunFolderPinned,
  checkoutStamp,
  gpuSwitch,
  prepareRun,
  readFaults,
  stampDiff,
  startElectron,
} from "../run-electron.ts";

const seam = path.resolve(import.meta.dir, "../seam.cjs");
const scratch = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bmt-contain-")));

test("a second capture is refused while the first runs, and a stale lock is taken over", () => {
  const lock = path.join(scratch(), "capture.lock");
  fs.writeFileSync(lock, String(process.ppid));
  expect(() => takeCaptureLock(lock)).toThrow(/one capture at a time/);
  fs.writeFileSync(lock, "999999");
  takeCaptureLock(lock);
  expect(fs.readFileSync(lock, "utf8")).toBe(String(process.pid));
});

test("PARITY_GPU is off by default, on when asked, and an error otherwise", () => {
  expect(gpuSwitch(undefined)).toBe("off");
  expect(gpuSwitch("off")).toBe("off");
  expect(gpuSwitch("on")).toBe("on");
  expect(() => gpuSwitch("true")).toThrow(/use on or off/);
});

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

  function scratchData(dir: string) {
    const data = path.join(dir, "source");
    fs.mkdirSync(path.join(data, "data"), { recursive: true });
    fs.writeFileSync(path.join(data, "data", "matches.db"), "");
    return data;
  }

  test("prepareRun refuses to clear a folder no parity run made, and leaves it as it was", () => {
    const dir = scratch();
    const data = scratchData(dir);
    const run = path.join(dir, "someone-elses");
    fs.mkdirSync(run);
    fs.writeFileSync(path.join(run, "keep.txt"), "mine");
    expect(() => prepareRun({ data, runDir: run, repo: dir })).toThrow(/not made by a parity run/);
    expect(fs.readdirSync(run)).toEqual(["keep.txt"]);
  });

  test("prepareRun refuses a run folder that contains the data folder", () => {
    const dir = scratch();
    const data = scratchData(dir);
    expect(() => prepareRun({ data, runDir: dir, repo: dir })).toThrow(/contains the data folder/);
    expect(fs.existsSync(path.join(data, "data", "matches.db"))).toBe(true);
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
        JSON.stringify({ name: "x", version: "1.2.1", main: "./out/main/index.js" }),
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
  const installed = path.resolve(import.meta.dir, "../../node_modules/electron/index.js");
  const binary = fs.existsSync(installed) ? (require(installed) as string) : "";
  const hasElectron = process.platform === "darwin" && binary !== "" && fs.existsSync(binary);

  beforeAll(
    async () => {
      if (hasElectron) await waitForNoGame();
    },
    2 * 60 * 60_000,
  );

  function fakeApp(main: string) {
    const dir = scratch();
    const repo = path.join(dir, "repo");
    fs.mkdirSync(path.join(repo, "out", "main"), { recursive: true });
    fs.writeFileSync(path.join(repo, "out", "main", "index.js"), main);
    fs.symlinkSync(
      path.resolve(import.meta.dir, "../../node_modules"),
      path.join(repo, "node_modules"),
    );
    fs.writeFileSync(
      path.join(repo, "package.json"),
      JSON.stringify({ name: "x", version: "1.2.1", main: "./out/main/index.js" }),
    );
    spawnSync("git", ["init", "-q"], { cwd: repo });
    const data = path.join(dir, "source");
    fs.mkdirSync(path.join(data, "data"), { recursive: true });
    const db = new Database(path.join(data, "data", "matches.db"));
    db.run("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)");
    db.run("INSERT INTO settings VALUES ('last_run_version', '1.2.1')");
    db.close();
    return { repo, data, runDir: path.join(dir, "run") };
  }

  test.skipIf(!hasElectron)(
    "through run-electron, a main-process throw fails the run with no dialog, and the window shows without focus or a Dock icon",
    async () => {
      const app = fakeApp(`
        const { app, dialog, BrowserWindow } = require("electron");
        app.whenReady().then(() => {
          const win = new BrowserWindow({ width: 400, height: 300 });
          win.loadURL("data:text/html,<p>fake app</p>");
          win.show();
          win.focus();
          app.focus({ steal: true });
          dialog.showErrorBox("title", "body");
          setTimeout(() => { throw new Error("main-process-throw"); }, 10);
        });
      `);
      const running = await startElectron(app);
      let report: Awaited<ReturnType<typeof running.close>>;
      try {
        await running.page.waitForTimeout(500);
        const window = await running.app.evaluate(({ app: electron, BrowserWindow }) => {
          const win = BrowserWindow.getAllWindows()[0]!;
          const dead = new BrowserWindow({ show: false });
          dead.on("visibilityChanged", () => {
            throw new TypeError("Object has been destroyed");
          });
          dead.destroy();
          dead.emit("visibilityChanged");
          return {
            visible: win.isVisible(),
            focused: win.isFocused(),
            dock: electron.dock?.isVisible(),
          };
        });
        expect(window).toEqual({ visible: true, focused: false, dock: false });
      } finally {
        report = await running.close();
      }
      const faults = report.faults.join("\n");
      expect(faults).toContain("showErrorBox title: body");
      expect(faults).toContain("uncaughtException Error: main-process-throw");
      const log = fs.readFileSync(running.seamLog, "utf8");
      expect(log).toContain("dropped-event-on-destroyed-window visibilityChanged");
      expect(log).toContain("dropped focus");
      expect(log).toContain("dropped app.focus");
      expect(fs.readFileSync(path.join(running.runDir, "logs", "main.log"), "utf8")).toContain(
        "FATAL",
      );
      expect(report.leaks).toEqual([]);
    },
    300_000,
  );
  test.skipIf(!hasElectron)(
    "run-electron pins the fork depth to 0 whatever the parent's environment holds",
    async () => {
      const app = fakeApp(`
        const { app, BrowserWindow } = require("electron");
        app.whenReady().then(() => new BrowserWindow({ show: false }).loadURL("data:text/html,<p>x</p>"));
      `);
      const before = process.env.SEAM_FORK_DEPTH;
      process.env.SEAM_FORK_DEPTH = "abc";
      let running: Awaited<ReturnType<typeof startElectron>> | undefined;
      try {
        running = await startElectron(app);
        expect(await running.app.evaluate(() => process.env.SEAM_FORK_DEPTH)).toBe("0");
      } finally {
        if (before === undefined) delete process.env.SEAM_FORK_DEPTH;
        else process.env.SEAM_FORK_DEPTH = before;
        await running?.close();
      }
    },
    300_000,
  );
});

describe("the real-folder guard, in the tools and in the seam", () => {
  function fakeReal() {
    const dir = scratch();
    const real = path.join(dir, "App Support", "better-mayhem-tracker");
    fs.mkdirSync(path.join(real, "data"), { recursive: true });
    fs.symlinkSync(real, path.join(dir, "link"));
    return { dir, real };
  }

  test("a symlink into the folder, a symlinked root, and a not-yet-created path under either are refused", () => {
    const { dir, real } = fakeReal();
    expect(isUnderRealFolder(path.join(dir, "link", "data", "new", "x"), [real])).toBe(true);
    const linkedRoot = path.join(dir, "root-link");
    fs.symlinkSync(real, linkedRoot);
    expect(isUnderRealFolder(path.join(real, "data"), [linkedRoot])).toBe(true);
    expect(isUnderRealFolder(path.join(dir, "elsewhere"), [real])).toBe(false);
  });

  function seamWrites(real: string, dir: string, body: string) {
    const log = path.join(dir, "seam.log");
    const script = `
      const fs = require("fs"); const path = require("path"); const { pathToFileURL } = require("url");
      const real = ${JSON.stringify(real)}; const link = ${JSON.stringify(path.join(dir, "link"))};
      const out = {};
      const attempt = (name, f) => { try { f(); out[name] = "written"; } catch (e) { out[name] = /seam refused/.test(e.message) ? "blocked" : e.message; } };
      ${body}
      console.log(JSON.stringify(out));
    `;
    const result = spawnSync("node", ["-r", seam, "-e", script], {
      env: { ...process.env, SEAM_LOG: log, SEAM_REAL_ROOTS: JSON.stringify([real]) },
      encoding: "utf8",
    });
    return JSON.parse(result.stdout) as Record<string, string>;
  }

  test("the seam blocks a write through a symlink into the real folder", () => {
    const { dir, real } = fakeReal();
    const out = seamWrites(
      real,
      dir,
      `attempt("symlink", () => fs.writeFileSync(path.join(link, "data", "via-symlink"), "x"));`,
    );
    expect(out.symlink).toBe("blocked");
    expect(fs.readdirSync(path.join(real, "data"))).toEqual([]);
  });

  test("the seam blocks a file: URL, with its escaped space, into the real folder", () => {
    const { dir, real } = fakeReal();
    const out = seamWrites(
      real,
      dir,
      `attempt("url", () => fs.writeFileSync(pathToFileURL(path.join(real, "data", "via-url")), "x"));`,
    );
    expect(out.url).toBe("blocked");
    expect(fs.readdirSync(path.join(real, "data"))).toEqual([]);
  });

  test("the seam blocks O_CREAT opened read-only, and still allows a plain read", () => {
    const { dir, real } = fakeReal();
    fs.writeFileSync(path.join(real, "data", "keep"), "k");
    const out = seamWrites(
      real,
      dir,
      `attempt("creat", () => fs.closeSync(fs.openSync(path.join(real, "data", "via-creat"), fs.constants.O_CREAT | fs.constants.O_RDONLY)));
       attempt("read", () => fs.readFileSync(path.join(real, "data", "keep")));`,
    );
    expect(out.creat).toBe("blocked");
    expect(out.read).toBe("written");
    expect(fs.readdirSync(path.join(real, "data"))).toEqual(["keep"]);
  });

  test("capture refuses an --out inside the real folder before it creates anything", () => {
    const home = scratch();
    const real = realDataRoots(process.platform, {}, home)[0]!;
    fs.mkdirSync(real, { recursive: true });
    const result = spawnSync(
      "bun",
      [path.resolve(import.meta.dir, "../capture.ts"), "--all", "--out", path.join(real, "x")],
      {
        env: { ...process.env, HOME: home, XDG_CONFIG_HOME: "" },
        encoding: "utf8",
        timeout: 60_000,
      },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("refused");
    expect(fs.readdirSync(real)).toEqual([]);
  });
});

describe("seam write coverage beyond plain fs calls", () => {
  function inNode(script: string) {
    const dir = scratch();
    const real = path.join(dir, "App Support", "better-mayhem-tracker");
    fs.mkdirSync(path.join(real, "data"), { recursive: true });
    fs.mkdirSync(path.join(dir, "node_modules", "better-sqlite3"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "node_modules", "better-sqlite3", "index.js"),
      `module.exports = class Database {
        constructor() {}
        backup() { return "backed up"; }
        exec() { return "ran"; }
        prepare() { return "prepared"; }
        pragma() { return "pragma"; }
      };`,
    );
    const result = spawnSync(
      "node",
      ["-r", seam, "-e", script.replaceAll("REAL", JSON.stringify(real))],
      {
        cwd: dir,
        env: {
          ...process.env,
          SEAM_LOG: path.join(dir, "seam.log"),
          SEAM_REAL_ROOTS: JSON.stringify([real]),
        },
        encoding: "utf8",
      },
    );
    return {
      out: JSON.parse(result.stdout || "{}") as Record<string, string>,
      real,
      stderr: result.stderr,
    };
  }
  const attempt = `
    const out = {};
    const attempt = (name, f) => { try { out[name] = String(f()); } catch (e) { out[name] = /seam refused/.test(e.message) ? "blocked" : e.message; } };
  `;

  test("lchown, new WriteStream and the native backup are blocked", () => {
    const { out, real } = inNode(`${attempt}
      const fs = require("fs"); const path = require("path"); const real = REAL;
      const Database = require("better-sqlite3");
      const db = new Database(":memory:");
      attempt("lchown", () => fs.lchownSync(path.join(real, "data"), 0, 0));
      attempt("stream", () => new fs.WriteStream(path.join(real, "data", "s")));
      attempt("backup", () => db.backup(path.join(real, "data", "b.db")));
      attempt("elsewhere", () => db.backup("/tmp/ok.db"));
      console.log(JSON.stringify(out));
    `);
    expect(out).toEqual({
      lchown: "blocked",
      stream: "blocked",
      backup: "blocked",
      elsewhere: "backed up",
    });
    expect(fs.readdirSync(path.join(real, "data"))).toEqual([]);
  });

  test("VACUUM INTO and ATTACH naming a file in the real folder are blocked, other SQL is not", () => {
    const { out } = inNode(`${attempt}
      const path = require("path"); const real = REAL;
      const Database = require("better-sqlite3");
      const db = new Database(":memory:");
      attempt("vacuum", () => db.exec("VACUUM INTO '" + path.join(real, "data", "v.db") + "'"));
      attempt("attach", () => db.prepare("ATTACH DATABASE '" + path.join(real, "data", "a.db") + "' AS x"));
      attempt("select", () => db.prepare("SELECT 1"));
      console.log(JSON.stringify(out));
    `);
    expect(out).toEqual({ vacuum: "blocked", attach: "blocked", select: "prepared" });
  });
});

describe("forks under the seam", () => {
  const seamArgs = (argv: string[]) =>
    argv.filter((arg, i) => arg === "-r" && argv[i + 1] === seam).length;

  function forkTree(files: Record<string, string>, parent: string) {
    const dir = scratch();
    for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
    const result = spawnSync("node", ["-r", seam, "-e", parent], {
      cwd: dir,
      env: { ...process.env, SEAM_LOG: path.join(dir, "seam.log"), SEAM_FORK_DEPTH: "" },
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(result.stderr).toBe("");
    return {
      out: JSON.parse(result.stdout),
      log: fs.readFileSync(path.join(dir, "seam.log"), "utf8"),
    };
  }

  test("an eval parent, its child and its grandchild are three processes, each with one -r seam", () => {
    const { out } = forkTree(
      {
        "child.js": `require("child_process").fork(require("path").join(__dirname, "grandchild.js"))
          .on("message", (m) => process.send({ ...m, child: process.execArgv }, () => process.exit(0)));`,
        "grandchild.js": `
          const rows = require("child_process").execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" })
            .trim().split("\\n").map((l) => l.trim().split(/\\s+/).map(Number));
          const tree = new Set([Number(process.env.TOP_PID)]);
          for (let grew = true; grew; ) {
            grew = false;
            for (const [pid, ppid] of rows) {
              if (tree.has(ppid) && !tree.has(pid) && ppid !== process.pid) { tree.add(pid); grew = true; }
            }
          }
          process.send({ processes: tree.size, grandchild: process.execArgv }, () => process.exit(0));`,
      },
      `process.env.TOP_PID = String(process.pid);
       require("child_process").fork("child.js")
         .on("message", (m) => { console.log(JSON.stringify(m)); process.exit(0); });`,
    );
    expect(out.processes).toBe(3);
    expect(seamArgs(out.child)).toBe(1);
    expect(seamArgs(out.grandchild)).toBe(1);
    expect(out.child).not.toContain("-e");
    expect(out.grandchild).not.toContain("-e");
  });

  test("a depth that is not a whole number at or above zero refuses the fork instead of switching the cap off", () => {
    const dir = scratch();
    fs.writeFileSync(path.join(dir, "child.js"), "process.exit(0)");
    for (const depth of ["abc", "NaN", "-1", "1.5", "Infinity"]) {
      const result = spawnSync(
        "node",
        [
          "-r",
          seam,
          "-e",
          `try { require("child_process").fork("child.js"); console.log("forked"); } catch (e) { console.log(e.message); }`,
        ],
        {
          cwd: dir,
          env: { ...process.env, SEAM_LOG: path.join(dir, "seam.log"), SEAM_FORK_DEPTH: depth },
          encoding: "utf8",
          timeout: 20_000,
        },
      );
      expect([depth, result.stdout.trim()]).toEqual([
        depth,
        expect.stringContaining("seam refused fork"),
      ]);
    }
  });

  test("a module that forks itself forever stops at the depth cap", () => {
    const { out, log } = forkTree(
      {
        "chain.js": `
          const reply = (m) => (process.send ? process.send(m, () => process.exit(0)) : (console.log(JSON.stringify(m)), process.exit(0)));
          let child;
          try { child = require("child_process").fork(__filename); }
          catch (e) { reply({ deepest: Number(process.env.SEAM_FORK_DEPTH), error: e.message }); }
          child?.on("message", reply);`,
      },
      `require("child_process").fork("chain.js")
         .on("message", (m) => { console.log(JSON.stringify(m)); process.exit(0); });`,
    );
    expect(out).toEqual({ deepest: 4, error: "seam refused fork: already 4 forks deep" });
    expect(log).toContain("blocked-fork depth 4");
  });
});
