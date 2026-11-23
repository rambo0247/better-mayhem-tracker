import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { isUnderRealFolder, realDataRoots } from "../lib/real-folder.ts";
import { diffHashes, hashAppFiles, takeSnapshot } from "../snapshot.ts";

const seam = path.resolve(import.meta.dir, "../seam.cjs");

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bmt-guard-"));
}

describe("real folder paths", () => {
  test("default roots name the installed app's folders on this platform", () => {
    const mac = realDataRoots("darwin", {}, "/Users/p");
    expect(mac).toContain("/Users/p/Library/Application Support/better-mayhem-tracker");
    const win = realDataRoots(
      "win32",
      { APPDATA: "C:\\Users\\p\\AppData\\Roaming" },
      "C:\\Users\\p",
    );
    expect(win.some((root) => root.toLowerCase().endsWith("better-mayhem-tracker"))).toBe(true);
  });

  test("a path inside, the root itself, and a case variant are all refused", () => {
    const roots = ["/x/Application Support/better-mayhem-tracker"];
    expect(
      isUnderRealFolder("/x/Application Support/better-mayhem-tracker/data/matches.db", roots),
    ).toBe(true);
    expect(isUnderRealFolder("/x/Application Support/better-mayhem-tracker", roots)).toBe(true);
    expect(isUnderRealFolder("/x/application support/BETTER-MAYHEM-TRACKER/logs", roots)).toBe(
      true,
    );
    expect(
      isUnderRealFolder("/x/Application Support/better-mayhem-tracker-spike/data", roots),
    ).toBe(false);
  });

  test("a symlink into the folder is refused", () => {
    const dir = scratch();
    const real = path.join(dir, "real");
    fs.mkdirSync(real);
    fs.symlinkSync(real, path.join(dir, "link"));
    expect(isUnderRealFolder(path.join(dir, "link", "data"), [real])).toBe(true);
  });
});

describe("snapshot", () => {
  test("refuses an output under the real folder and writes nothing", () => {
    const dir = scratch();
    const real = path.join(dir, "real");
    fs.mkdirSync(path.join(real, "data"), { recursive: true });
    const target = path.join(real, "snap");
    expect(() => takeSnapshot({ source: real, out: target, realRoots: [real] })).toThrow(
      /real data folder/,
    );
    expect(fs.existsSync(target)).toBe(false);
  });

  test("copies the database with .backup and the caches, leaving the source as it was", () => {
    const dir = scratch();
    const source = path.join(dir, "source");
    fs.mkdirSync(path.join(source, "data"), { recursive: true });
    fs.mkdirSync(path.join(source, "asset-cache", "16.1"), { recursive: true });
    spawnSync("sqlite3", [
      path.join(source, "data", "matches.db"),
      "create table t(a); insert into t values (7);",
    ]);
    fs.writeFileSync(path.join(source, "data", "champion-cache.json"), "{}");
    fs.writeFileSync(path.join(source, "asset-cache", "16.1", "a.png"), "png");
    const before = fs.readFileSync(path.join(source, "data", "matches.db"));

    const out = path.join(dir, "out");
    const result = takeSnapshot({ source, out, realRoots: [path.join(dir, "elsewhere")] });
    expect(result.caches).toEqual(["data/champion-cache.json", "asset-cache/"]);
    const rows = spawnSync("sqlite3", [
      "-readonly",
      result.database,
      "select a from t",
    ]).stdout.toString();
    expect(rows.trim()).toBe("7");
    expect(fs.existsSync(path.join(out, "asset-cache", "16.1", "a.png"))).toBe(true);
    expect(fs.readFileSync(path.join(source, "data", "matches.db")).equals(before)).toBe(true);
  });
});

test("hashing a source before and after a snapshot shows it unchanged", () => {
  const dir = scratch();
  const source = path.join(dir, "source");
  fs.mkdirSync(path.join(source, "data"), { recursive: true });
  spawnSync("sqlite3", [path.join(source, "data", "matches.db"), "create table t(a);"]);
  const before = hashAppFiles(source);
  takeSnapshot({ source, out: path.join(dir, "out"), realRoots: [path.join(dir, "elsewhere")] });
  expect(diffHashes(before, hashAppFiles(source))).toEqual({ changed: [], removed: [], added: [] });
  fs.appendFileSync(path.join(source, "data", "matches.db"), "x");
  expect(diffHashes(before, hashAppFiles(source)).changed).toEqual(["data/matches.db"]);
});

test("a snapshot of a WAL database a live writer holds open leaves every source file as it was", async () => {
  const dir = scratch();
  const source = path.join(dir, "source");
  fs.mkdirSync(path.join(source, "data"), { recursive: true });
  const db = path.join(source, "data", "matches.db");
  const holder = path.join(dir, "holder.ts");
  fs.writeFileSync(
    holder,
    `import { Database } from "bun:sqlite";
     const db = new Database(process.argv[2]);
     db.run("PRAGMA journal_mode=WAL");
     db.run("PRAGMA wal_autocheckpoint=0");
     db.run("create table x(a)");
     for (let i = 0; i < 200; i++) db.run("insert into x values (?)", [i]);
     console.log("ready");
     setTimeout(() => {}, 60_000);`,
  );
  const child = spawn("bun", [holder, db], { stdio: ["ignore", "pipe", "inherit"] });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the writer never became ready")), 15_000);
      child.on("exit", (code) => reject(new Error(`the writer exited with ${code}`)));
      child.stdout!.on("data", (chunk: Buffer) => {
        if (chunk.toString().includes("ready")) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    expect(fs.statSync(db + "-wal").size).toBeGreaterThan(0);
    expect(fs.existsSync(db + "-shm")).toBe(true);

    let before = hashAppFiles(source);
    for (let tries = 0; tries < 20; tries++) {
      await Bun.sleep(250);
      const now = hashAppFiles(source);
      const settled = diffHashes(before, now).changed.length === 0;
      before = now;
      if (settled) break;
    }
    expect([...before.keys()].sort()).toEqual(
      ["data/matches.db", "data/matches.db-shm", "data/matches.db-wal"].sort(),
    );
    const result = takeSnapshot({ source, out: path.join(dir, "out"), realRoots: [dir + "-x"] });
    expect(diffHashes(before, hashAppFiles(source))).toEqual({
      changed: [],
      removed: [],
      added: [],
    });
    const rows = spawnSync("sqlite3", ["-readonly", result.database, "select count(*) from x"]);
    expect(rows.stdout.toString().trim()).toBe("200");
    expect(fs.readdirSync(path.join(dir, "out", "data"))).toEqual(["matches.db"]);

    spawnSync("sqlite3", ["-readonly", db, "select count(*) from x"]);
    expect(diffHashes(before, hashAppFiles(source)).changed).toContain("data/matches.db-shm");
  } finally {
    child.kill();
  }
}, 30_000);

test("the snapshot CLI refuses a --verify log in the real folder before it reads or creates anything", () => {
  const home = fs.realpathSync(scratch());
  const real = realDataRoots(process.platform, {}, home)[0]!;
  fs.mkdirSync(path.join(real, "data"), { recursive: true });
  fs.writeFileSync(path.join(real, "data", "matches.db"), "not opened");
  const out = path.join(home, "snap");
  const result = spawnSync(
    "bun",
    [
      path.resolve(import.meta.dir, "../snapshot.ts"),
      "--out",
      out,
      "--verify",
      path.join(real, "verify.log"),
    ],
    { env: { ...process.env, HOME: home, XDG_CONFIG_HOME: "" }, encoding: "utf8", timeout: 30_000 },
  );
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("verify log refused");
  expect(fs.existsSync(out)).toBe(false);
  expect(fs.readdirSync(real)).toEqual(["data"]);
});

test("diff and determinism refuse an output in the real folder before they create anything", () => {
  const home = fs.realpathSync(scratch());
  const real = realDataRoots(process.platform, {}, home)[0]!;
  fs.mkdirSync(real, { recursive: true });
  const runs = path.join(home, "runs");
  fs.mkdirSync(runs);
  const png = new PNG({ width: 2, height: 2 });
  fs.writeFileSync(path.join(runs, "a.png"), PNG.sync.write(png));
  png.data[0] = 255;
  fs.writeFileSync(path.join(runs, "b.png"), PNG.sync.write(png));
  const run = (script: string, args: string[]) =>
    spawnSync("bun", [path.resolve(import.meta.dir, "..", script), ...args], {
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: "" },
      encoding: "utf8",
      timeout: 30_000,
    });
  const diff = run("diff.ts", [
    path.join(runs, "a.png"),
    path.join(runs, "b.png"),
    "--out",
    path.join(real, "new", "x"),
  ]);
  expect(diff.status).not.toBe(0);
  expect(diff.stderr).toContain("diff output refused");
  const determinism = run("determinism.ts", [runs, path.join(real, "run-2")]);
  expect(determinism.status).not.toBe(0);
  expect(determinism.stderr).toContain("diff folder refused");
  expect(fs.readdirSync(real)).toEqual([]);
});

describe("seam", () => {
  function run(script: string, env: Record<string, string> = {}) {
    const dir = scratch();
    const log = path.join(dir, "seam.log");
    const real = path.join(dir, "real");
    fs.mkdirSync(path.join(real, "data"), { recursive: true });
    const result = spawnSync(
      "node",
      ["-r", seam, "-e", script.replaceAll("REAL", JSON.stringify(real))],
      {
        env: { ...process.env, SEAM_LOG: log, SEAM_REAL_ROOTS: JSON.stringify([real]), ...env },
        encoding: "utf8",
      },
    );
    return { result, real, log: fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "" };
  }

  test("aborts a write under a folder mapped as real and logs it, whichever API writes", () => {
    const script = `
      const fs = require("fs"); const path = require("path"); const real = REAL;
      const attempts = [
        () => fs.writeFileSync(path.join(real, "data", "a"), "x"),
        () => fs.appendFileSync(path.join(real, "b"), "x"),
        () => fs.mkdirSync(path.join(real, "c")),
        () => fs.openSync(path.join(real, "d"), "w"),
        () => fs.createWriteStream(path.join(real, "e")),
        () => fs.renameSync(__filename || "/nonexistent", path.join(real, "f")),
        () => fs.copyFileSync("/etc/hosts", path.join(real, "g")),
        () => fs.rmSync(path.join(real, "data"), { recursive: true }),
      ];
      let blocked = 0;
      for (const attempt of attempts) { try { attempt(); } catch (e) { if (/seam refused/.test(e.message)) blocked++; } }
      fs.promises.writeFile(path.join(real, "h"), "x").catch((e) => { if (/seam refused/.test(e.message)) blocked++; console.log("blocked", blocked); });
    `;
    const { result, real, log } = run(script);
    expect(result.stdout.trim()).toBe("blocked 9");
    expect(fs.readdirSync(real)).toEqual(["data"]);
    expect(fs.readdirSync(path.join(real, "data"))).toEqual([]);
    expect(log.match(/blocked-write/g)?.length).toBe(9);
  });

  test("allows writes elsewhere and reads under the real folder", () => {
    const script = `
      const fs = require("fs"); const os = require("os"); const path = require("path");
      const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "seam-ok-"));
      fs.writeFileSync(path.join(elsewhere, "ok"), "fine");
      fs.readdirSync(REAL);
      console.log("ok");
    `;
    const { result, log } = run(script);
    expect(result.stdout.trim()).toBe("ok");
    expect(log).not.toContain("blocked-write");
  });

  test("hides League paths, blocks outside fetch, freezes the clock", () => {
    const script = `
      const fs = require("fs");
      (async () => {
        let hidden = false, fetched = false;
        try { fs.readdirSync("/Applications/League of Legends.app"); } catch (e) { hidden = e.code === "ENOENT"; }
        try { await fetch("https://ddragon.leagueoflegends.com/api/versions.json"); } catch (e) { fetched = /seam blocked/.test(e.message); }
        console.log(JSON.stringify({ hidden, fetched, now: Date.now(), made: new Date().toISOString(), arg: new Date(5).getTime() }));
      })();
    `;
    const { result, log } = run(script, {
      SEAM_FIXED_TIME: String(Date.UTC(2026, 10, 23, 2, 0, 0)),
    });
    expect(JSON.parse(result.stdout)).toEqual({
      hidden: true,
      fetched: true,
      now: Date.UTC(2026, 10, 23, 2, 0, 0),
      made: "2026-11-23T02:00:00.000Z",
      arg: 5,
    });
    expect(log).toContain("fetch-blocked https://ddragon.leagueoflegends.com/api/versions.json");
  });
});
