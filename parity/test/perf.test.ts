import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  attributeElectron,
  attributeWebKit,
  descendants,
  median,
  MemoryProbeError,
  parseFootprint,
  parseLsofNames,
  parsePs,
  sumMembers,
  type WebKitContext,
} from "../perf/memory-mac.ts";
import { MATCH_ROW_SELECTOR, parseTauriLines } from "../perf/first-content.ts";
import { pickDownload, apparentBytes } from "../perf/size.ts";
import { rowIsNewestGame, sandboxProfile } from "../perf/app.ts";
import { parseCli, stat, UsageError } from "../perf.ts";
import {
  cpuIdleBetween,
  DEFAULT_MAX_LOAD,
  loadGate,
  summarizeLoad,
  topReader,
} from "../perf/load.ts";
import {
  checkPerfBundle,
  fixtureProof,
  PERF_BUNDLE_ID,
  PERF_CONFIG,
  prepareTauriData,
  PRODUCTION_BUNDLE_ID,
  RefusedRun,
  tauriLogFile,
  tauriPlacement,
} from "../perf/tauri.ts";
import { STATES } from "../states.ts";

const fixture = (name: string) =>
  fs.readFileSync(path.join(import.meta.dir, "fixtures", "perf", name), "utf8");

describe("electron attribution", () => {
  const rows = parsePs(fixture("electron-ps.txt"));
  const footprint = parseFootprint(
    fixture("electron-footprint.json"),
    [57998, 57999, 58000, 58006],
  );

  test("the tree is the main process and its three helpers, each with its role", () => {
    const attribution = attributeElectron(rows, 57998, "/run/userdata");
    expect(attribution.members.map((m) => [m.row.pid, m.role])).toEqual([
      [57998, "main"],
      [57999, "gpu"],
      [58000, "network"],
      [58006, "renderer"],
    ]);
    expect(attribution.missingRoles).toEqual([]);
    expect(attribution.strays).toEqual([]);
  });

  test("footprint is the recorded de-duplicated total, not the per-process sum", () => {
    const attribution = attributeElectron(rows, 57998);
    const sample = sumMembers(attribution.members, footprint, new Map());
    expect(sample.footprintBytes).toBe(299406640);
    expect(sample.footprintBytes).toBeLessThan(122258560 + 89589680 + 79447408 + 9192336);
    expect(sample.rssBytes).toBe((244528 + 103632 + 45920 + 178896) * 1024);
  });

  test("a footprint reading with no total throws", () => {
    const json = JSON.parse(fixture("electron-footprint.json"));
    delete json["total footprint"];
    const reading = parseFootprint(JSON.stringify(json), [57998, 57999, 58000, 58006]);
    expect(() => sumMembers(attributeElectron(rows, 57998).members, reading, new Map())).toThrow(
      MemoryProbeError,
    );
  });

  test("a missing renderer is reported", () => {
    const without = rows.filter((row) => row.pid !== 58006);
    expect(attributeElectron(without, 57998).missingRoles).toEqual(["renderer"]);
  });

  test("a helper that left the tree but kept the user-data-dir is a stray", () => {
    const orphan = rows.map((row) => (row.pid === 58006 ? { ...row, ppid: 1 } : row));
    const attribution = attributeElectron(orphan, 57998, "/run/userdata");
    expect(attribution.strays.map((row) => row.pid)).toEqual([58006]);
  });

  test("a footprint reading missing a pid throws", () => {
    const partial = parseFootprint(fixture("electron-footprint.json"), [57998, 1]);
    expect(partial.missing).toEqual([1]);
    expect(() => sumMembers(attributeElectron(rows, 57998).members, partial, new Map())).toThrow();
  });

  test("descendants of an unknown pid is empty", () => {
    expect(descendants(rows, 1)).toEqual([]);
  });
});

describe("webkit attribution", () => {
  const rows = parsePs(fixture("webkit-ps.txt"));
  const spawnedAtMs = new Date("Nov 23 2026 01:08:48").getTime() + 200;
  const context = (before: number[]): WebKitContext => ({
    rootPid: 38686,
    before: new Set(before),
    spawnedAtMs,
    identityTokens: ["com.better-mayhem-tracker.app", "better_mayhem_tracker_tauri"],
    expectedWebContent: 1,
  });
  const older = [80529, 80534];
  const names = new Map([
    [38691, ["/var/C/com.apple.WebKit.GPU+better_mayhem_tracker_tauri/x"]],
    [38694, ["/Users/t/Library/WebKit/com.better-mayhem-tracker.app/WebsiteData/db"]],
  ]);

  test("takes the app's own three helpers and leaves the older ones", () => {
    const attribution = attributeWebKit(rows, context(older), names);
    expect(attribution.ambiguous).toBe(false);
    expect(
      attribution.members.map((m) => [m.row.pid, m.role] as const).sort((a, b) => a[0] - b[0]),
    ).toEqual([
      [38686, "main"],
      [38691, "gpu"],
      [38692, "webcontent"],
      [38694, "networking"],
    ]);
  });

  test("another app's helpers started a minute earlier are excluded by start time", () => {
    const attribution = attributeWebKit(rows, context(older), names);
    expect(attribution.members.map((m) => m.row.pid)).not.toContain(38192);
    expect(attribution.members.map((m) => m.row.pid)).not.toContain(38194);
  });

  test("a second new content helper next to ours is ambiguous", () => {
    const extra = [
      ...rows,
      ...parsePs(
        "38693     1 Mon Nov 23 01:08:48 2026      1000 /System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent",
      ),
    ];
    expect(attributeWebKit(extra, context(older), names).ambiguous).toBe(true);
  });

  test("a foreign content helper far in pid is told apart by proximity", () => {
    const extra = [
      ...rows,
      ...parsePs(
        "39900     1 Mon Nov 23 01:08:49 2026      1000 /System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent",
      ),
    ];
    const attribution = attributeWebKit(extra, context(older), names);
    expect(attribution.ambiguous).toBe(false);
    expect(attribution.members.map((m) => m.row.pid)).toContain(38692);
    expect(attribution.members.map((m) => m.row.pid)).not.toContain(39900);
  });

  test("two new GPU helpers with no file naming this app are ambiguous", () => {
    const extra = [
      ...rows,
      ...parsePs(
        "38700     1 Mon Nov 23 01:08:49 2026      1000 /System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.GPU.xpc/Contents/MacOS/com.apple.WebKit.GPU",
      ),
    ];
    expect(attributeWebKit(extra, context(older), new Map()).ambiguous).toBe(true);
  });

  test("lsof field output parses to names per pid", () => {
    const parsed = parseLsofNames("p1\nn/a\nn/b\np2\nn/c\n");
    expect(parsed.get(1)).toEqual(["/a", "/b"]);
    expect(parsed.get(2)).toEqual(["/c"]);
  });
});

describe("statistics", () => {
  test("median of odd and even counts", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  test("spread is range over median", () => {
    const s = stat([90, 100, 110])!;
    expect(s.median).toBe(100);
    expect(s.spread).toBeCloseTo(0.2);
  });
});

describe("first content", () => {
  test("the row selector is the one the Match History state waits for", () => {
    expect(STATES.find((state) => state.id === "match-history-default")!.expect).toBe(
      MATCH_ROW_SELECTOR,
    );
  });

  test("the Tauri first-content line carries the first row's text", () => {
    const paint = { atMs: 1100, text: "[bmt pid=1] page first-paint 490 ms after process start" };
    const row = {
      atMs: 1300,
      text: '[bmt pid=1] page first-content 640 ms after process start row="DEFEAT\\n8/11/17"',
    };
    expect(parseTauriLines([paint, row], 1000)).toEqual({
      arrivedMs: 300,
      reportedMs: 640,
      rowText: "DEFEAT\n8/11/17",
    });
    const bare = { atMs: 1300, text: "[bmt pid=1] page first-content 640 ms after process start" };
    expect(parseTauriLines([bare], 1000)?.rowText).toBeNull();
    expect(parseTauriLines([paint], 1000)).toBeNull();
  });

  test("the first row must carry the newest game's kills, deaths and assists", () => {
    const newest = { kills: 8, deaths: 11, assists: 17, durationSeconds: 1102 };
    expect(rowIsNewestGame("DEFEAT\n18:22\nChampion 79\n8/11/17\n2.27 KDA", newest)).toBe(true);
    expect(rowIsNewestGame("DEFEAT\n18:22\nChampion 79\n16/13/32", newest)).toBe(false);
    expect(rowIsNewestGame("anything", null)).toBe(false);
  });
});

describe("size and isolation", () => {
  test("the macOS download is the dmg for the arch and Windows is the exe", () => {
    const assets = [
      { name: "BetterMayhemTracker-mac-arm64.dmg", size: 5 },
      { name: "BetterMayhemTracker-mac-x64.dmg", size: 6 },
      { name: "BetterMayhemTracker.exe", size: 7 },
    ];
    expect(pickDownload(assets, "darwin", "arm64").size).toBe(5);
    expect(pickDownload(assets, "darwin", "x64").size).toBe(6);
    expect(pickDownload(assets, "win32", "x64").size).toBe(7);
  });

  test("apparent bytes sums file lengths under a folder", () => {
    expect(apparentBytes(path.join(import.meta.dir, "fixtures", "perf"))).toBeGreaterThan(20_000);
  });

  test("the Seatbelt profile denies the League install, ps, the data folder and LaunchAgents", () => {
    const profile = sandboxProfile("/Users/p");
    expect(profile).toContain('(deny file* (subpath "/Applications/League of Legends.app"))');
    expect(profile).toContain('(deny process-exec (literal "/bin/ps"))');
    expect(profile).toContain(
      '(deny file* (subpath "/Users/p/Library/Application Support/better-mayhem-tracker"))',
    );
    expect(profile).toContain('(deny file-write* (subpath "/Users/p/Library/LaunchAgents"))');
    expect(profile).toContain("(allow default)");
  });
});

const mac = process.platform === "darwin";

function underProfile(profile: string, script: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bmt-sb-"));
  try {
    fs.writeFileSync(path.join(dir, "p.sb"), profile);
    return spawnSync(
      "/usr/bin/sandbox-exec",
      ["-f", path.join(dir, "p.sb"), "/bin/sh", "-c", script],
      {
        encoding: "utf8",
      },
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(!mac)("the Seatbelt profile, enforced", () => {
  test("a stand-in home's data folder and LaunchAgents refuse a sandboxed process", () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bmt-home-")));
    try {
      const data = path.join(home, "Library", "Application Support", "better-mayhem-tracker");
      const agents = path.join(home, "Library", "LaunchAgents");
      fs.mkdirSync(data, { recursive: true });
      fs.mkdirSync(agents, { recursive: true });
      fs.writeFileSync(path.join(data, "matches.db"), "real");
      const profile = sandboxProfile(home);
      expect(underProfile(profile, `cat "${data}/matches.db"`).status).not.toBe(0);
      expect(underProfile(profile, `echo x > "${data}/new"`).status).not.toBe(0);
      expect(underProfile(profile, `echo x > "${agents}/a.plist"`).status).not.toBe(0);
      expect(underProfile(profile, `echo x > "${home}/control"`).status).toBe(0);
      expect(fs.readdirSync(data)).toEqual(["matches.db"]);
      expect(fs.readdirSync(agents)).toEqual([]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("a sandboxed write to the real LaunchAgents folder fails", () => {
    const probe = path.join(
      os.userInfo().homedir,
      "Library",
      "LaunchAgents",
      `bmt-perf-sandbox-probe-${process.pid}-${Date.now()}.txt`,
    );
    const run = underProfile(sandboxProfile(), `echo x > "${probe}"`);
    const leaked = fs.existsSync(probe);
    if (leaked) fs.rmSync(probe);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("Operation not permitted");
    expect(leaked).toBe(false);
  });
});

describe("tauri runs", () => {
  const runDir = "/runs/tauri-0";

  test("a release build on macOS is moved by HOME and gets no override variable", () => {
    const placement = tauriPlacement("darwin", "release", runDir);
    expect(placement.env).toEqual({ HOME: "/runs/tauri-0/home" });
    expect(placement.dataRoot).toBe(
      "/runs/tauri-0/home/Library/Application Support/better-mayhem-tracker",
    );
    expect(tauriLogFile(placement)).toBe(`${placement.dataRoot}/logs/main.log`);
  });

  test("a lane build is moved by BMT_DATA_ROOT, with HOME moved too", () => {
    expect(tauriPlacement("darwin", "lane", runDir).env).toEqual({
      HOME: "/runs/tauri-0/home",
      BMT_DATA_ROOT: "/runs/tauri-0/userdata",
    });
    expect(tauriPlacement("win32", "lane", runDir).env).toEqual({
      BMT_DATA_ROOT: "/runs/tauri-0/userdata",
    });
  });

  test("a Windows release build opens the system folder", () => {
    const placement = tauriPlacement("win32", "release", runDir, () => "/AppData/Roaming");
    expect(placement).toEqual({
      dataRoot: "/AppData/Roaming/better-mayhem-tracker",
      env: {},
      systemFolder: true,
    });
  });

  test("the system folder is cleared only when this tool made it", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bmt-sys-"));
    try {
      const placement = {
        dataRoot: path.join(dir, "roaming", "better-mayhem-tracker"),
        env: {},
        systemFolder: true,
      };
      fs.mkdirSync(placement.dataRoot, { recursive: true });
      fs.writeFileSync(path.join(placement.dataRoot, "player.db"), "keep");
      expect(() => prepareTauriData(placement, "none", path.join(dir, "run"))).toThrow(RefusedRun);
      expect(fs.readFileSync(path.join(placement.dataRoot, "player.db"), "utf8")).toBe("keep");

      fs.rmSync(placement.dataRoot, { recursive: true });
      prepareTauriData(placement, "none", path.join(dir, "run"));
      fs.writeFileSync(path.join(placement.dataRoot, "left-by-run-1"), "");
      prepareTauriData(placement, "none", path.join(dir, "run"));
      expect(fs.readdirSync(placement.dataRoot).sort()).toEqual([".bmt-perf-made", "logs"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a run proves the fixture by its log and its first row", () => {
    const newest = { kills: 8, deaths: 11, assists: 17, durationSeconds: 1102 };
    expect(fixtureProof("1.2.1 started", "DEFEAT 8/11/17", newest)).toBeNull();
    expect(fixtureProof(null, "DEFEAT 8/11/17", newest)).toContain("no log");
    expect(fixtureProof("", "DEFEAT 8/11/17", newest)).toContain("no log");
    expect(fixtureProof("1.2.1 started", null, newest)).toContain("row=");
    expect(fixtureProof("1.2.1 started", "DEFEAT 16/13/32", newest)).toContain("newest game");
  });

  test.skipIf(!mac)("a bundle without the perf id is refused", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bmt-app-"));
    const app = path.join(dir, "Better Mayhem Tracker.app");
    const plist = (id: string) => {
      fs.mkdirSync(path.join(app, "Contents"), { recursive: true });
      fs.writeFileSync(
        path.join(app, "Contents", "Info.plist"),
        `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${id}</string></dict></plist>`,
      );
    };
    try {
      plist(PRODUCTION_BUNDLE_ID);
      expect(() => checkPerfBundle(app)).toThrow(/production bundle id/);
      plist("com.example.other");
      expect(() => checkPerfBundle(app)).toThrow(RefusedRun);
      plist(PERF_BUNDLE_ID);
      expect(checkPerfBundle(app)).toBe(PERF_BUNDLE_ID);
      fs.rmSync(path.join(app, "Contents", "Info.plist"));
      expect(() => checkPerfBundle(app)).toThrow(RefusedRun);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the perf config sets the perf bundle id", () => {
    expect(JSON.parse(fs.readFileSync(PERF_CONFIG, "utf8"))).toEqual({
      identifier: PERF_BUNDLE_ID,
    });
  });
});

describe("command line", () => {
  const tauri = ["--app", "tauri", "--tauri", "/x/Better Mayhem Tracker.app"];
  const ci = { CI: "true", GITHUB_ACTIONS: "true" };

  test("unknown flags and positionals are rejected", () => {
    expect(() => parseCli(["--app", "electron-1.2.1", "--run", "3"], "darwin", {})).toThrow(
      UsageError,
    );
    expect(() => parseCli(["--app", "electron-1.2.1", "stray"], "darwin", {})).toThrow(UsageError);
    expect(() => parseCli(["--app", "electron-1.2.1", "--hidden"], "darwin", {})).toThrow(
      UsageError,
    );
    expect(() => parseCli(["--app", "electron"], "darwin", {})).toThrow(UsageError);
    expect(() => parseCli(["--runs", "3"], "darwin", {})).toThrow(UsageError);
  });

  test("values are checked", () => {
    const electron = ["--app", "electron-1.2.1"];
    expect(() => parseCli([...electron, "--runs", "0"], "darwin", {})).toThrow(UsageError);
    expect(() => parseCli([...electron, "--scenario", "minimized"], "darwin", {})).toThrow(
      UsageError,
    );
    expect(() => parseCli([...electron, "--isolation", "sandbox"], "win32", {})).toThrow(
      UsageError,
    );
    expect(() => parseCli(["--app", "tauri"], "darwin", {})).toThrow(UsageError);
  });

  test("hidden-idle is a scenario", () => {
    const cli = parseCli(["--app", "electron-1.2.1", "--scenario", "hidden-idle"], "darwin", {});
    expect(cli.scenario).toBe("hidden-idle");
    expect(parseCli(["--app", "electron-1.2.1"], "darwin", {}).scenario).toBe("visible-idle");
  });

  test("the load threshold is 10 unless --max-load sets it, and the cli says which", () => {
    const plain = parseCli(["--app", "electron-1.2.1"], "darwin", {});
    expect([plain.maxLoad, plain.maxLoadFromFlag]).toEqual([10, false]);
    const raised = parseCli(["--app", "electron-1.2.1", "--max-load", "40"], "darwin", {});
    expect([raised.maxLoad, raised.maxLoadFromFlag]).toEqual([40, true]);
  });

  test("a Tauri run on macOS is refused without the sandbox or without data", () => {
    expect(parseCli(tauri, "darwin", {}).tauriProfile).toBe("release");
    expect(() => parseCli([...tauri, "--isolation", "none"], "darwin", {})).toThrow(RefusedRun);
    expect(() => parseCli([...tauri, "--data", "none"], "darwin", {})).toThrow(RefusedRun);
  });

  test("a Tauri run on Windows is refused off a CI runner", () => {
    expect(() => parseCli(tauri, "win32", {})).toThrow(RefusedRun);
    expect(() => parseCli(tauri, "win32", { CI: "true" })).toThrow(RefusedRun);
    expect(parseCli(tauri, "win32", ci).apps).toEqual(["tauri"]);
    expect(() => parseCli(tauri, "linux", ci)).toThrow(RefusedRun);
  });
});

describe("load", () => {
  const cpu = (idle: number, user: number) => ({
    model: "",
    speed: 0,
    times: { user, nice: 0, sys: 0, idle, irq: 0 },
  });

  test("CPU idle is the idle share of the time between two readings, over every core", () => {
    expect(cpuIdleBetween([cpu(0, 0), cpu(0, 0)], [cpu(300, 100), cpu(100, 300)])).toBe(0.5);
    expect(cpuIdleBetween([cpu(5, 5)], [cpu(5, 5)])).toBeNull();
  });

  test("top's load and CPU idle become one sample per block, without the since-boot first", () => {
    const samples: Array<{ load1: number; cpuIdle: number | null }> = [];
    const read = topReader((sample) => samples.push(sample));
    for (const line of [
      "Processes: 900 total",
      "Load Avg: 19.79, 35.76, 40.81 ",
      "CPU usage: 44.78% user, 30.82% sys, 24.39% idle ",
      "Load Avg: 19.08, 35.35, 40.63 ",
      "CPU usage: 68.30% user, 15.94% sys, 15.75% idle ",
    ])
      read(line);
    expect(samples).toEqual([
      { load1: 19.79, cpuIdle: null },
      { load1: 19.08, cpuIdle: 0.1575 },
    ]);
  });

  test("a sweep above the threshold fails the gate", () => {
    const samples = [3, 12, 14].map((load1, i) => ({ atMs: i, load1, cpuIdle: 0.5 }));
    const summary = summarizeLoad(samples);
    expect(summary).toEqual({ samples: 3, medianLoad1: 12, medianCpuIdle: 0.5 });
    expect(loadGate(summary, DEFAULT_MAX_LOAD, false).passed).toBe(false);
    expect(loadGate(summary, 40, true)).toEqual({
      maxLoad: 40,
      maxLoadFromFlag: true,
      medianLoad1: 12,
      passed: true,
    });
    expect(loadGate(summarizeLoad([]), 10, false).passed).toBe(false);
  });
});
