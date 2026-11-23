import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  attributeElectron,
  attributeWebKit,
  descendants,
  median,
  parseFootprint,
  parseLsofNames,
  parsePs,
  sumMembers,
  type WebKitContext,
} from "../perf/memory-mac.ts";
import { MATCH_ROW_SELECTOR, parseTauriLines } from "../perf/first-content.ts";
import { pickDownload, apparentBytes } from "../perf/size.ts";
import { rowIsNewestGame, sandboxProfile } from "../perf/app.ts";
import { stat } from "../perf.ts";
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

  test("summed footprint and rss match the recorded sample", () => {
    const attribution = attributeElectron(rows, 57998);
    const sample = sumMembers(attribution.members, footprint, new Map());
    expect(sample.footprintBytes).toBe(122258560 + 89589680 + 79447408 + 9192336);
    expect(sample.rssBytes).toBe((244528 + 103632 + 45920 + 178896) * 1024);
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
    expect(attribution.members.map((m) => [m.row.pid, m.role]).sort()).toEqual([
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

  test("a first-content line beats the first-paint line", () => {
    const lines = [
      { atMs: 1100, text: "[bmt pid=1] page first-paint 490 ms after process start" },
      { atMs: 1300, text: "[bmt pid=1] first-content 640 ms" },
    ];
    expect(parseTauriLines(lines, 1000)).toEqual({
      arrivedMs: 300,
      reportedMs: 640,
      source: "first-content",
    });
    expect(parseTauriLines(lines.slice(0, 1), 1000)?.source).toBe("first-paint");
    expect(parseTauriLines([], 1000)).toBeNull();
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

  test("the Seatbelt profile denies the League install, ps, and the real data folder", () => {
    const profile = sandboxProfile(["/Users/p/Library/Application Support/better-mayhem-tracker"]);
    expect(profile).toContain('(deny file* (subpath "/Applications/League of Legends.app"))');
    expect(profile).toContain('(deny process-exec (literal "/bin/ps"))');
    expect(profile).toContain("Application Support/better-mayhem-tracker");
    expect(profile).toContain("(allow default)");
  });
});
