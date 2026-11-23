/**
 * T24's macOS lanes for the Rust updater: a Tauri build updating itself through
 * fake-github.ts, on scratch bundles and fixture copies only.
 *
 * Usage: bun parity/updater-lanes.ts --work <scratch dir> --fixture <fixture data root>
 *   --v130 <dir holding Better Mayhem Tracker.app and its zip, built as 1.3.0>
 *   --v131 <the same for 1.3.1> --evidence <dir> [--runs 5]
 *
 * Every bundle lives under --work, never in an Applications folder, and every data root is a
 * copy of the fixture. `open` is a stub first on PATH, so the swap script relaunches nothing
 * and activates nothing; the lane starts the swapped bundle's own binary itself.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { startFakeGithub, type FakeGithub } from "./fake-github.ts";
import { refuseRealFolder } from "./lib/real-folder.ts";
import { TIME_ZONE } from "./run-electron.ts";
import { startTauri } from "./run-tauri.ts";

const APP = "Better Mayhem Tracker.app";
const ZIP = "BetterMayhemTracker-mac-arm64.zip";
const EXE = path.join("Contents", "MacOS", "Better Mayhem Tracker");
const NOT_DURABLE = "In-app update only works once the app is in your Applications folder";

const args = process.argv.slice(2);
const value = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const need = (flag: string) => {
  const found = value(flag);
  if (!found) throw new Error(`missing ${flag}`);
  return path.resolve(found);
};
const work = need("--work");
const fixture = need("--fixture");
const v130 = need("--v130");
const v131 = need("--v131");
const evidence = need("--evidence");
const runs = Number(value("--runs") ?? "1");
for (const dir of [work, evidence]) refuseRealFolder(dir, "lane folder");
fs.mkdirSync(work, { recursive: true });
fs.mkdirSync(evidence, { recursive: true });

const results: { lane: string; pass: boolean; detail: string }[] = [];
function record(lane: string, pass: boolean, detail: string) {
  results.push({ lane, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${lane}: ${detail}`);
}

function plist(bundle: string, key: string): string {
  const out = spawnSync("plutil", [
    "-extract",
    key,
    "raw",
    path.join(bundle, "Contents", "Info.plist"),
  ]);
  return out.stdout.toString().trim();
}

/** Read from a copy: the app leaves the database in WAL mode, which `-readonly` cannot open here. */
function sql(db: string, query: string): string {
  const copy = path.join(work, `read-${crypto.randomBytes(4).toString("hex")}.db`);
  fs.copyFileSync(db, copy);
  try {
    return spawnSync("sqlite3", [copy, query]).stdout.toString().trim();
  } finally {
    fs.rmSync(copy, { force: true });
  }
}

/** A fixture copy and a scratch bundle, under one lane folder. */
function prepare(name: string, from: string) {
  const dir = path.join(work, name);
  fs.rmSync(dir, { recursive: true, force: true });
  const apps = path.join(dir, "apps");
  fs.mkdirSync(apps, { recursive: true });
  const bundle = path.join(apps, APP);
  spawnSync("/usr/bin/ditto", [path.join(from, APP), bundle]);
  const data = path.join(dir, "data-root");
  fs.cpSync(fixture, data, { recursive: true });
  const db = path.join(data, "data", "matches.db");
  const settings = sql(db, "select key from settings where key like 'auto_start%'");
  if (settings) throw new Error(`the fixture sets ${settings}; lanes need no login item`);
  const stub = path.join(dir, "bin");
  fs.mkdirSync(stub);
  const openLog = path.join(dir, "open.log");
  fs.writeFileSync(path.join(stub, "open"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${openLog}'\n`, {
    mode: 0o755,
  });
  return { dir, bundle, data, db, openLog, path: `${stub}:${process.env.PATH}` };
}

type Lane = ReturnType<typeof prepare>;

function laneEnv(lane: Lane, fake: FakeGithub, extra: Record<string, string> = {}) {
  return {
    BMT_PARITY_PACKAGED: "1",
    BMT_PARITY_GITHUB: fake.url,
    PATH: lane.path,
    ...extra,
  };
}

function releaseOf(dir: string, badDigest = false, latest = "1.3.1") {
  return { latest, assets: [{ name: ZIP, file: path.join(dir, ZIP) }], badDigest };
}

/** Lines the process prints, each with when it arrived. */
function watch(child: ChildProcess) {
  const lines: { at: number; text: string }[] = [];
  const take = (chunk: Buffer) => {
    for (const text of chunk.toString().split("\n")) if (text) lines.push({ at: Date.now(), text });
  };
  child.stdout?.on("data", take);
  child.stderr?.on("data", take);
  return lines;
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

function exited(child: ChildProcess, cap: number) {
  return new Promise<number | null>((resolve, reject) => {
    if (child.exitCode !== null) return resolve(child.exitCode);
    const timer = setTimeout(() => reject(new Error(`pid ${child.pid} still running`)), cap);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

/**
 * Lane 3 and the perf probe: a hidden 1.3.0 launch installs 1.3.1 on its own, the script swaps
 * the bundle in place and asks `open` to relaunch it hidden, and the relaunch is 1.3.1 on the
 * same data with What's New (lane 8).
 */
async function tauriToTauri(run: number) {
  const lane = prepare(`lane3-run${run}`, v130);
  const fake = startFakeGithub({ release: releaseOf(v131) });
  const log: string[] = [];
  try {
    const exe = path.join(lane.bundle, EXE);
    const child = spawn(exe, ["--hidden"], {
      env: {
        ...process.env,
        ...laneEnv(lane, fake),
        BMT_DATA_ROOT: lane.data,
        // The driver's token also keeps the app an accessory app, so the launch takes no focus
        BMT_PARITY_TOKEN: crypto.randomBytes(16).toString("hex"),
        TZ: TIME_ZONE,
        LANG: "en_US.UTF-8",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const lines = watch(child);
    const code = await exited(child, 120_000);
    const started = lines.find((l) => l.text.includes("Installing update 1.3.1 on launch"));
    const opened = await until("open call", 130_000, () =>
      fs.existsSync(lane.openLog) ? Date.now() : undefined,
    );
    log.push(...lines.map((l) => l.text), `exit ${code}`);
    const openArgs = fs.readFileSync(lane.openLog, "utf8").trim();
    const version = plist(lane.bundle, "CFBundleShortVersionString");
    const leftovers = fs.readdirSync(path.dirname(lane.bundle)).filter((n) => n !== APP);
    const signed = spawnSync("codesign", ["--verify", "--deep", "--strict", lane.bundle]).status;
    const lastRun = sql(lane.db, "select value from settings where key='last_run_version'");
    log.push(
      `open ${openArgs}`,
      `bundle version ${version}`,
      `beside the bundle: ${JSON.stringify(leftovers)}`,
      `codesign --verify --deep --strict: ${signed}`,
      `last_run_version after 1.3.0 ran: ${lastRun}`,
      `requests ${JSON.stringify(fake.requests)}`,
    );
    const swapped =
      version === "1.3.1" &&
      openArgs === `${lane.bundle} --args --hidden` &&
      leftovers.length === 0 &&
      signed === 0 &&
      lastRun === "1.3.0" &&
      code === 0;

    // The relaunch `open` would have made: the swapped bundle's own binary, its arguments, the
    // same data root
    const relaunch = await startTauri({
      binary: path.join(lane.bundle, "Contents", "MacOS", plist(lane.bundle, "CFBundleExecutable")),
      data: lane.data,
      renderer: "electron",
      api: "tauri",
      runDir: path.join(lane.dir, "relaunch"),
      args: openArgs.split(" --args ")[1]?.split(" ") ?? [],
      env: laneEnv(lane, fake),
    });
    try {
      const facts = await relaunch.engine.evaluate(async () => ({
        version: await (window as any).api.getVersion(),
        notes: await (window as any).api.getUpdateNotes(),
        launchInstall: await (window as any).api.getLaunchInstall(),
      }));
      await relaunch.engine.waitForFunction(
        () => [...document.querySelectorAll("h2,h1")].some((h) => h.textContent === "What's New"),
        15_000,
      );
      const dialog = await relaunch.engine.evaluate(
        () => document.querySelector("[role=dialog]")?.textContent ?? "",
      );
      const tauriLog = fs.readFileSync(path.join(relaunch.runDir, "tauri.log"), "utf8");
      const built = /window main .* built (\d+) ms after process start/.exec(tauriLog);
      log.push(`relaunched ${JSON.stringify(facts)}`, `What's New dialog: ${dialog}`);
      const notes = facts.notes;
      const whatsNew =
        facts.version === "1.3.1" &&
        notes?.from === "1.3.0" &&
        notes?.to === "1.3.1" &&
        notes.releases.length === 1 &&
        dialog.includes("1.3.1");
      return {
        swapped,
        whatsNew,
        log,
        installToRelaunchMs: started ? opened - started.at + Number(built?.[1] ?? NaN) : NaN,
        openCallMs: started ? opened - started.at : NaN,
        windowMs: Number(built?.[1] ?? NaN),
      };
    } finally {
      await relaunch.close();
    }
  } finally {
    fake.close();
  }
}

/** Lane 6: a wrong digest is refused, the app keeps running, the bundle stays 1.3.0. */
async function wrongDigest() {
  const lane = prepare("lane6", v130);
  const fake = startFakeGithub({ release: releaseOf(v131, true) });
  try {
    const running = await startTauri({
      binary: path.join(lane.bundle, EXE),
      data: lane.data,
      renderer: "electron",
      api: "tauri",
      runDir: path.join(lane.dir, "run"),
      args: ["--hidden"],
      env: laneEnv(lane, fake),
    });
    try {
      const logFile = path.join(running.runDir, "tauri.log");
      await until("the refusal", 60_000, () =>
        fs.readFileSync(logFile, "utf8").includes("Launch update failed") ? true : undefined,
      );
      await Bun.sleep(1_000);
      const lines = fs
        .readFileSync(logFile, "utf8")
        .split("\n")
        .filter((l) => /update|Update/.test(l));
      const alive = running.child.exitCode === null;
      const version = plist(lane.bundle, "CFBundleShortVersionString");
      const staged = fs.readdirSync(path.dirname(lane.bundle)).filter((n) => n !== APP);
      lines.push(
        `still running: ${alive}`,
        `bundle version ${version}`,
        `beside the bundle: ${JSON.stringify(staged)}`,
        `open called: ${fs.existsSync(lane.openLog)}`,
      );
      fs.writeFileSync(path.join(evidence, "digest-reject.log"), lines.join("\n") + "\n");
      const pass =
        lines.some((l) => l.includes("Update hash mismatch: expected 0000")) &&
        lines.some(
          (l) => l === "Launch update failed: Downloaded file failed its integrity check",
        ) &&
        alive &&
        version === "1.3.0" &&
        staged.length === 0 &&
        !fs.existsSync(lane.openLog);
      record("lane 6 wrong digest", pass, "digest-reject.log");
    } finally {
      await running.close();
    }
  } finally {
    fake.close();
  }
}

/**
 * Lanes 7, 4 and 5 on one run. The game API answers (any listener on its port counts as a
 * game, as in Electron, since only a refused connection means no game), so the launch install
 * skips; the header still shows the update and nothing installs. Then the dialog's Update
 * button installs it with progress, as the manual path does even during a match.
 */
async function inGameThenManual() {
  const lane = prepare("lane457", v130);
  const fake = startFakeGithub({ release: releaseOf(v131) });
  const game = net.createServer((socket) => socket.end());
  await new Promise<void>((resolve) => game.listen(0, "127.0.0.1", resolve));
  const gamePort = String((game.address() as net.AddressInfo).port);
  try {
    const running = await startTauri({
      binary: path.join(lane.bundle, EXE),
      data: lane.data,
      renderer: "electron",
      api: "tauri",
      runDir: path.join(lane.dir, "run"),
      env: laneEnv(lane, fake, { BMT_PARITY_LIVE_PORT: gamePort }),
    });
    const logFile = path.join(running.runDir, "tauri.log");
    const updateLines = () =>
      fs
        .readFileSync(logFile, "utf8")
        .split("\n")
        .filter((l) => /[Uu]pdate/.test(l));
    try {
      await until("the in-game skip", 30_000, () =>
        updateLines().some((l) => l.includes("not installing during a match")) ? true : undefined,
      );
      fs.writeFileSync(path.join(evidence, "in-game-skip.log"), updateLines().join("\n") + "\n");
      record(
        "lane 7 in-game skip",
        updateLines().includes("Update 1.3.1 available; not installing during a match") &&
          !updateLines().some((l) => l.includes("Installing update")),
        "in-game-skip.log",
      );

      const badge = '[aria-label="Update to version 1.3.1"]';
      await running.engine.waitForFunction(
        () => !!document.querySelector('[aria-label="Update to version 1.3.1"]'),
        30_000,
      );
      await Bun.sleep(3_000);
      const visible = await running.driver.json<Record<string, unknown>>("info");
      const badgeText = await running.engine.evaluate(
        (selector: string) => document.querySelector(selector)?.textContent ?? "",
        badge,
      );
      const lane4 = [
        `window ${JSON.stringify(visible)}`,
        `badge: ${badgeText}`,
        `bundle version after 3 s: ${plist(lane.bundle, "CFBundleShortVersionString")}`,
        `downloads requested: ${fake.requests.filter((r) => r.includes("/download/")).length}`,
        ...updateLines(),
      ];
      fs.writeFileSync(path.join(evidence, "update-button.log"), lane4.join("\n") + "\n");
      record(
        "lane 4 header shows the update, nothing installs",
        badgeText.includes("Update available") &&
          badgeText.includes("1.3.1") &&
          plist(lane.bundle, "CFBundleShortVersionString") === "1.3.0" &&
          !fake.requests.some((r) => r.includes("/download/")),
        "update-button.log",
      );

      await running.engine.evaluate(() => {
        const seen: number[] = [];
        (window as any).__progress = seen;
        (window as any).api.onUpdateProgress((p: number) => seen.push(p));
        const bars: string[] = [];
        (window as any).__bars = bars;
        new MutationObserver(() => {
          const label = [...document.querySelectorAll(".label")].find(
            (l) => l.textContent === "Downloading",
          );
          const text = label?.parentElement?.textContent;
          if (text && bars.at(-1) !== text) bars.push(text);
        }).observe(document.body, { subtree: true, childList: true, characterData: true });
      });
      // DOM clicks: the window is not key, and the lane is about the install, not the input
      await running.engine.evaluate(
        (selector: string) => (document.querySelector(selector) as HTMLElement).click(),
        badge,
      );
      await running.engine.waitForFunction(
        () =>
          [...document.querySelectorAll("button")].some((b) => b.textContent?.includes("Restart")),
        10_000,
      );
      const dialogText = await running.engine.evaluate(
        () => document.querySelector("[role=dialog]")?.textContent ?? "",
      );
      await running.engine.evaluate(() =>
        [...document.querySelectorAll("button")]
          .find((b) => b.textContent?.includes("Restart"))!
          .click(),
      );
      const clicked = Date.now();
      let seen: { progress: number[]; bars: string[] } = { progress: [], bars: [] };
      while (running.child.exitCode === null && Date.now() - clicked < 60_000) {
        seen = await running.engine
          .evaluate(() => ({
            progress: (window as any).__progress as number[],
            bars: (window as any).__bars as string[],
          }))
          .catch(() => seen);
        await Bun.sleep(20);
      }
      const opened = await until("open call", 130_000, () =>
        fs.existsSync(lane.openLog) ? Date.now() : undefined,
      );
      const openArgs = fs.readFileSync(lane.openLog, "utf8").trim();
      const lines = [
        `dialog: ${dialogText}`,
        `progress events: ${seen.progress.length}, first ${seen.progress.slice(0, 5).join(",")}, last ${seen.progress.slice(-3).join(",")}`,
        `progress text seen: ${JSON.stringify(seen.bars.slice(0, 5))} ... ${JSON.stringify(seen.bars.slice(-2))}`,
        `app exited ${running.child.exitCode}`,
        `open ${openArgs} after ${opened - clicked} ms`,
        `bundle version ${plist(lane.bundle, "CFBundleShortVersionString")}`,
      ];
      fs.writeFileSync(path.join(evidence, "update-downloading.log"), lines.join("\n") + "\n");
      const increasing = seen.progress.every((p, i) => i === 0 || p >= seen.progress[i - 1]!);
      record(
        "lane 5 the dialog's Update installs with progress",
        seen.progress.length > 1 &&
          increasing &&
          seen.progress.at(-1) === 100 &&
          openArgs === lane.bundle &&
          plist(lane.bundle, "CFBundleShortVersionString") === "1.3.1",
        "update-downloading.log",
      );
    } finally {
      await running.close();
    }
  } finally {
    game.close();
    fake.close();
  }
}

/** Lane 9: a run from a mounted disk image has no durable install, so nothing installs. */
async function fromDiskImage() {
  const dir = path.join(work, "lane9");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const dmg = path.join(dir, "BetterMayhemTracker.dmg");
  const made = spawnSync("hdiutil", [
    "create",
    "-quiet",
    "-srcfolder",
    path.join(v130, APP),
    "-volname",
    "BMT T24 lane9",
    "-format",
    "UDZO",
    dmg,
  ]);
  if (made.status !== 0) throw new Error(`hdiutil create: ${made.stderr.toString()}`);
  const attached = spawnSync("hdiutil", ["attach", "-nobrowse", "-readonly", "-plist", dmg]);
  const mount = /<string>(\/Volumes\/[^<]+)<\/string>/.exec(attached.stdout.toString())?.[1];
  if (!mount) throw new Error(`hdiutil attach: ${attached.stderr.toString()}`);
  const data = path.join(dir, "data-root");
  fs.cpSync(fixture, data, { recursive: true });
  const fake = startFakeGithub({ release: releaseOf(v131) });
  try {
    const running = await startTauri({
      binary: path.join(mount, APP, EXE),
      data,
      renderer: "electron",
      api: "tauri",
      runDir: path.join(dir, "run"),
      args: ["--hidden"],
      env: { BMT_PARITY_PACKAGED: "1", BMT_PARITY_GITHUB: fake.url },
    });
    try {
      await Bun.sleep(3_000);
      const answer = await running.engine.evaluate(async () => {
        const api = (window as any).api;
        const info = await api.checkForUpdate();
        return { info, install: await api.downloadUpdate(info.assetUrl) };
      });
      const tauriLog = fs.readFileSync(path.join(running.runDir, "tauri.log"), "utf8");
      const lines = [
        `ran from ${path.join(mount, APP)}`,
        `checkForUpdate: hasUpdate ${answer.info.hasUpdate} latest ${answer.info.latest}`,
        `downloadUpdate: ${JSON.stringify(answer.install)}`,
        `launch install log lines: ${JSON.stringify(tauriLog.split("\n").filter((l) => /Installing update|Launch update/.test(l)))}`,
        `downloads requested: ${fake.requests.filter((r) => r.includes("/download/")).length}`,
      ];
      fs.writeFileSync(path.join(evidence, "not-durable.log"), lines.join("\n") + "\n");
      record(
        "lane 9 a mounted dmg does not install",
        answer.info.hasUpdate === true &&
          answer.install.error === NOT_DURABLE &&
          !/Installing update/.test(tauriLog) &&
          !fake.requests.some((r) => r.includes("/download/")),
        "not-durable.log",
      );
    } finally {
      await running.close();
    }
  } finally {
    fake.close();
    spawnSync("hdiutil", ["detach", "-quiet", mount]);
  }
}

if (spawnSync("pgrep", ["-x", "LeagueofLegends"]).status === 0) {
  throw new Error("a League game is running; run through wait-no-game.sh");
}

const perf: Record<string, number>[] = [];
for (let run = 1; run <= runs; run++) {
  const outcome = await tauriToTauri(run);
  perf.push({
    installToRelaunchMs: outcome.installToRelaunchMs,
    openCallMs: outcome.openCallMs,
    windowMs: outcome.windowMs,
  });
  if (run === 1) {
    fs.writeFileSync(path.join(evidence, "tauri-to-tauri.log"), outcome.log.join("\n") + "\n");
    record("lane 3 Tauri 1.3.0 to 1.3.1 in place", outcome.swapped, "tauri-to-tauri.log");
    record("lane 8 What's New after the relaunch", outcome.whatsNew, "tauri-to-tauri.log");
  } else if (!outcome.swapped || !outcome.whatsNew) {
    record(`lane 3 run ${run}`, false, outcome.log.join(" | "));
  }
}
fs.writeFileSync(
  path.join(evidence, "perf-tauri-to-tauri.json"),
  JSON.stringify({ zipBytes: fs.statSync(path.join(v131, ZIP)).size, runs: perf }, null, 1) + "\n",
);
await wrongDigest();
await inGameThenManual();
await fromDiskImage();
fs.writeFileSync(path.join(evidence, "lanes.json"), JSON.stringify(results, null, 1) + "\n");
process.exit(results.every((r) => r.pass) ? 0 : 1);
