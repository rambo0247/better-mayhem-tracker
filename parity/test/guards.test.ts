import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isUnderRealFolder, realDataRoots } from "../lib/real-folder.ts";
import { takeSnapshot } from "../snapshot.ts";

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
