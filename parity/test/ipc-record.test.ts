import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { channelDirName, channelFromDirName } from "../golden-format.ts";
import { IPC_CASES, SEAM_STAMP } from "../ipc-cases.ts";
import { FIXED_TIME, TIME_ZONE } from "../run-electron.ts";
import {
  channelMedians,
  checkCoverage,
  coverageLine,
  parseChannels,
  parseEvents,
  timingDisagreements,
  type Timing,
} from "../record-ipc.ts";

const API = path.resolve(import.meta.dir, "../../src/shared/api.ts");
const apiText = fs.readFileSync(API, "utf8");

describe("what api.ts declares", () => {
  test("61 request channels and 11 events, each name once", () => {
    const channels = Object.values(parseChannels(apiText));
    expect(channels).toHaveLength(61);
    expect(new Set(channels).size).toBe(61);
    expect(parseEvents(apiText)).toHaveLength(11);
  });

  test("a channel name survives the folder name round trip", () => {
    for (const channel of Object.values(parseChannels(apiText))) {
      expect(channelFromDirName(channelDirName(channel))).toBe(channel);
      expect(channelDirName(channel)).not.toContain(":");
    }
  });
});

describe("the case table", () => {
  const channels = parseChannels(apiText);

  test("every case names a method api.ts declares", () => {
    for (const testCase of IPC_CASES) expect(channels[testCase.method]).toBeDefined();
  });

  test("every channel has a case", () => {
    const covered = new Set(IPC_CASES.map((c) => channels[c.method]));
    for (const channel of Object.values(channels)) expect(covered.has(channel)).toBe(true);
  });

  test("a case id is unique within its channel and is a file name", () => {
    const seen = new Set<string>();
    for (const testCase of IPC_CASES) {
      const key = `${testCase.method}/${testCase.id}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
      expect(testCase.id).toMatch(/^[a-z0-9-]+$/);
    }
  });

  test("SEAM_STAMP is the frozen clock's backup stamp", () => {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", {
        timeZone: TIME_ZONE,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
        .formatToParts(FIXED_TIME)
        .map((p) => [p.type, p.value]),
    );
    expect(SEAM_STAMP).toBe(
      `${parts.year}-${parts.month}-${parts.day}T${parts.hour}-${parts.minute}-${parts.second}`,
    );
  });

  test("a call that takes a snapshot reads it back", () => {
    const snapshots: Record<string, string> = {
      "restoreBackup/restore": "pre-restore",
      "importData/same-file": "pre-import",
      "repairPuuids/run": "pre-repair",
    };
    for (const [key, reason] of Object.entries(snapshots)) {
      const testCase = IPC_CASES.find((c) => `${c.method}/${c.id}` === key);
      const outcome = { kind: "value", result: null } as const;
      expect(testCase?.files?.({} as never, outcome)).toEqual([
        `$RUN/backups/matches-${SEAM_STAMP}-${reason}.db`,
      ]);
    }
  });

  test("write cases never run in the read group", () => {
    const writes = new Set(["setSetting", "toggleFavorite", "createBackup", "importData"]);
    for (const testCase of IPC_CASES) {
      if (writes.has(testCase.method)) expect(testCase.group).not.toBe("read");
    }
  });
});

function fakeGoldens(channels: string[], events: string[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "golden-"));
  for (const channel of channels) {
    fs.mkdirSync(path.join(dir, "ipc", channelDirName(channel)), { recursive: true });
    fs.writeFileSync(path.join(dir, "ipc", channelDirName(channel), "default.json"), "{}");
  }
  fs.mkdirSync(path.join(dir, "events"));
  fs.writeFileSync(
    path.join(dir, "events", "all.jsonl"),
    events.map((event) => JSON.stringify({ seq: 0, event, cause: "scenario" })).join("\n"),
  );
  return dir;
}

describe("coverage", () => {
  const channels = Object.values(parseChannels(apiText));
  const events = parseEvents(apiText);

  test("complete goldens report 61/61 channels, 11/11 events", () => {
    const coverage = checkCoverage(fakeGoldens(channels, events), apiText);
    expect(coverageLine(coverage)).toBe("coverage 61/61 channels, 11/11 events");
    expect(coverage.channels.missing).toEqual([]);
  });

  test("an api.ts with one channel added names it as missing", () => {
    const added = apiText.replace(
      '  getVersion: "app:version",',
      '  getVersion: "app:version",\n  getBrandNew: "app:brand-new",',
    );
    const coverage = checkCoverage(fakeGoldens(channels, events), added);
    expect(coverage.channels.missing).toEqual(["app:brand-new"]);
  });

  test("an api.ts with one event added names it as missing", () => {
    const added = apiText.replace(
      '  "lcu:games-updated": void;',
      '  "lcu:games-updated": void;\n  "brand:new-event": number;',
    );
    const coverage = checkCoverage(fakeGoldens(channels, events), added);
    expect(coverage.events.missing).toEqual(["brand:new-event"]);
  });
});

describe("timing comparison", () => {
  const timing = (median: number): Timing => ({
    "db:profile": { default: { n: 50, medianMs: median, p95Ms: median * 2 } },
  });

  test("a channel median is the median of its case medians", () => {
    const t: Timing = {
      c: {
        a: { n: 1, medianMs: 1, p95Ms: 1 },
        b: { n: 1, medianMs: 5, p95Ms: 5 },
        d: { n: 1, medianMs: 3, p95Ms: 3 },
      },
    };
    expect(channelMedians(t)).toEqual({ c: 3 });
  });

  test("a 30% move on a slow channel fails and a 10% move passes", () => {
    expect(timingDisagreements(timing(10), timing(13))).toHaveLength(1);
    expect(timingDisagreements(timing(10), timing(11))).toHaveLength(0);
  });

  test("sub-quarter-millisecond jitter on a fast channel does not fail", () => {
    expect(timingDisagreements(timing(0.2), timing(0.35))).toHaveLength(0);
  });
});
