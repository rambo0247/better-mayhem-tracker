/**
 * T24 lane 1 on macOS: Electron 1.2.1's own updater installs a Tauri 1.3.0 build and hands
 * over to it on the same data.
 *
 * Usage: bun parity/updater-handoff.ts --work <scratch dir> --fixture <fixture data root>
 *   --installed <a packaged 1.2.1 Better Mayhem Tracker.app to copy>
 *   --asset <dir holding the Tauri 1.3.0 BetterMayhemTracker-mac-arm64.zip> --evidence <dir>
 *   [--runs 1]
 *
 * Electron runs through run-electron.ts, as every lane's does, with updater-handoff-seam.cjs
 * ahead of seam.cjs: the unpacked 1.2.1 build believes it is a packaged install at a copy of
 * the real 1.2.1 bundle under --work, launched hidden as the login item does. Its launch
 * install finds the release on fake-github.ts, downloads and verifies the zip, writes
 * update.sh, and quits. The script swaps the bundle and calls `open`, a stub that only records
 * its arguments. The lane then starts the swapped bundle's own executable, named by its
 * Info.plist, with those arguments on the data Electron ran on.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { startFakeGithub } from "./fake-github.ts";
import { PARITY_DIR } from "./lib/data.ts";
import { refuseRealFolder } from "./lib/real-folder.ts";
import { startElectron } from "./run-electron.ts";
import { startTauri } from "./run-tauri.ts";

const APP = "Better Mayhem Tracker.app";
const ZIP = "BetterMayhemTracker-mac-arm64.zip";

const args = process.argv.slice(2);
const value = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const need = (flag: string) => {
  const found = value(flag);
  if (!found) throw new Error(`missing ${flag}`);
  return path.resolve(found);
};
const work = need("--work");
const fixture = need("--fixture");
const installed = need("--installed");
const asset = path.join(need("--asset"), ZIP);
const evidence = need("--evidence");
const runs = Number(value("--runs") ?? "1");
// Offers Electron's own 1.2.1 zip instead and stops at the relaunch call: the Electron to
// Electron install time the perf rule compares against
const baseline = args.includes("--baseline");
for (const dir of [work, evidence]) refuseRealFolder(dir, "lane folder");

function plist(bundle: string, key: string): string {
  return spawnSync("plutil", ["-extract", key, "raw", path.join(bundle, "Contents", "Info.plist")])
    .stdout.toString()
    .trim();
}

async function until<T>(what: string, cap: number, probe: () => T | undefined): Promise<T> {
  const deadline = Date.now() + cap;
  for (;;) {
    const found = probe();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`no ${what} within ${cap} ms`);
    await Bun.sleep(50);
  }
}

/** Read from a copy: the app leaves the database in WAL mode, which `-readonly` cannot open here. */
function sql(db: string, query: string): string {
  const copy = `${db}.read-${process.pid}`;
  for (const suffix of ["", "-wal"]) {
    if (fs.existsSync(db + suffix)) fs.copyFileSync(db + suffix, copy + suffix);
  }
  try {
    return spawnSync("sqlite3", [copy, query]).stdout.toString().trim();
  } finally {
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(copy + suffix, { force: true });
  }
}

const GAMES = "select count(*) || ' games, newest ' || max(game_id) from games";

async function handoff(run: number) {
  const dir = path.join(work, `handoff-${run}`);
  fs.rmSync(dir, { recursive: true, force: true });
  const apps = path.join(dir, "apps");
  const stub = path.join(dir, "bin");
  const home = path.join(dir, "home");
  for (const d of [apps, stub, home]) fs.mkdirSync(d, { recursive: true });
  const bundle = path.join(apps, APP);
  spawnSync("cp", ["-cR", installed, bundle]);
  const before = plist(bundle, "CFBundleShortVersionString");
  const openLog = path.join(dir, "open.log");
  fs.writeFileSync(path.join(stub, "open"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${openLog}'\n`, {
    mode: 0o755,
  });
  const fake = startFakeGithub({
    release: { latest: "1.3.0", assets: [{ name: ZIP, file: asset }] },
  });
  const electronRun = path.join(dir, "electron");
  Object.assign(process.env, {
    HANDOFF_EXEC_PATH: path.join(bundle, "Contents", "MacOS", "Better Mayhem Tracker"),
    HANDOFF_GITHUB: fake.url,
    HANDOFF_STUB_BIN: stub,
    HANDOFF_HOME: home,
    PARITY_ELECTRON_ARGS: `-r ${path.join(PARITY_DIR, "updater-handoff-seam.cjs")} --hidden`,
  });
  const lines: string[] = [`installed bundle before: ${before} (${installed})`];
  try {
    const started = Date.now();
    // The launch install quits Electron, often before the harness has its page
    const electron = startElectron({ data: fixture, runDir: electronRun }).then(
      (running) => running,
      (error: Error) => {
        lines.push(`run-electron: ${error.message.split("\n")[0]}`);
        return undefined;
      },
    );
    const opened = await until("open call", 300_000, () =>
      fs.existsSync(openLog) ? Date.now() : undefined,
    );
    const running = await electron;
    await running?.close();
    // The packaged layout: the data root is userData
    const electronRoot = path.join(electronRun, "userdata");
    const mainLog = path.join(electronRoot, "logs", "main.log");
    const electronLines = fs.existsSync(mainLog)
      ? fs
          .readFileSync(mainLog, "utf8")
          .split("\n")
          .filter((l) => /[Uu]pdate|Shutting down/.test(l))
      : [`no ${mainLog}`];
    const openArgs = fs.readFileSync(openLog, "utf8").trim();
    const executable = plist(bundle, "CFBundleExecutable");
    const signed = spawnSync("codesign", ["--verify", "--deep", "--strict", bundle]).status;
    const archs = spawnSync("lipo", ["-archs", path.join(bundle, "Contents", "MacOS", executable)])
      .stdout.toString()
      .trim();
    lines.push(
      ...electronLines.map((l) => `electron: ${l}`),
      `requests: ${JSON.stringify(fake.requests)}`,
      `open ${openArgs} after ${opened - started} ms`,
      `bundle after: ${plist(bundle, "CFBundleShortVersionString")} ${plist(bundle, "CFBundleIdentifier")} executable ${executable} ${archs}`,
      `codesign --verify --deep --strict: ${signed}`,
      `beside the bundle: ${JSON.stringify(fs.readdirSync(apps).filter((n) => n !== APP))}`,
      `scratch home: ${JSON.stringify(fs.readdirSync(home))}`,
    );
    if (baseline) return { lines, pass: true, installToRelaunchMs: opened - started };
    for (const key of ["HANDOFF_EXEC_PATH", "HANDOFF_GITHUB", "HANDOFF_STUB_BIN", "HANDOFF_HOME"]) {
      delete process.env[key];
    }
    delete process.env.PARITY_ELECTRON_ARGS;

    const relaunch = await startTauri({
      binary: path.join(bundle, "Contents", "MacOS", executable),
      data: electronRoot,
      renderer: "electron",
      api: "tauri",
      runDir: path.join(dir, "tauri"),
      args: openArgs.split(" --args ")[1]?.split(" ") ?? [],
      env: { BMT_PARITY_PACKAGED: "1", BMT_PARITY_GITHUB: fake.url },
    });
    try {
      const facts = await relaunch.engine.evaluate(async () => ({
        version: await (window as any).api.getVersion(),
        notes: await (window as any).api.getUpdateNotes(),
      }));
      await relaunch.engine.waitForFunction(
        () => [...document.querySelectorAll("h2,h1")].some((h) => h.textContent === "What's New"),
        15_000,
      );
      const electronDb = path.join(electronRoot, "data", "matches.db");
      const tauriDb = path.join(relaunch.runDir, "data-root", "data", "matches.db");
      const electronGames = sql(electronDb, GAMES);
      const tauriGames = sql(tauriDb, GAMES);
      const lastRun = sql(tauriDb, "select value from settings where key='last_run_version'");
      const tauriLog = fs.readFileSync(path.join(relaunch.runDir, "tauri.log"), "utf8");
      const built = /window main .* built (\d+) ms after process start/.exec(tauriLog)?.[1];
      lines.push(
        `Electron's data: ${electronGames}; the relaunched app's copy of it: ${tauriGames}`,
        `last_run_version after the relaunch: ${lastRun}`,
        `relaunched: version ${facts.version}, notes ${JSON.stringify(facts.notes)}`,
        `relaunch window built ${built} ms after process start`,
      );
      return {
        lines,
        pass:
          electronGames === tauriGames &&
          electronGames === sql(path.join(fixture, "data", "matches.db"), GAMES) &&
          lastRun === "1.3.0" &&
          before === "1.2.1" &&
          electronLines.some((l) => l.includes("Installing update 1.3.0 on launch")) &&
          openArgs === `${bundle} --args --hidden` &&
          plist(bundle, "CFBundleShortVersionString") === "1.3.0" &&
          executable === "Better Mayhem Tracker" &&
          signed === 0 &&
          facts.version === "1.3.0" &&
          facts.notes?.from === "1.2.1" &&
          facts.notes?.to === "1.3.0" &&
          fs.readdirSync(home).length === 0,
        installToRelaunchMs: opened - started + Number(built),
      };
    } finally {
      await relaunch.close();
    }
  } finally {
    fake.close();
  }
}

if (spawnSync("pgrep", ["-x", "LeagueofLegends"]).status === 0) {
  throw new Error("a League game is running; run through wait-no-game.sh");
}
fs.mkdirSync(evidence, { recursive: true });
const results = [];
for (let run = 1; run <= runs; run++) {
  const outcome = await handoff(run);
  const name = baseline ? "handoff-baseline-electron" : "handoff-mac";
  if (run === 1)
    fs.writeFileSync(path.join(evidence, `${name}.log`), outcome.lines.join("\n") + "\n");
  results.push({ run, pass: outcome.pass, installToRelaunchMs: outcome.installToRelaunchMs });
  console.log(`${outcome.pass ? "PASS" : "FAIL"} lane 1 run ${run}`);
}
fs.writeFileSync(
  path.join(evidence, baseline ? "handoff-baseline-electron.json" : "handoff-mac.json"),
  JSON.stringify(results, null, 1) + "\n",
);
process.exit(results.every((r) => r.pass) ? 0 : 1);
