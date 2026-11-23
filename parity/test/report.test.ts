import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
  EXPECTED_GOLDEN_CHANNELS,
  E1_PAGE_BUDGET_PCT,
  parseGoldenSummary,
  readDeviations,
  readPerf,
  renderReport,
  stateLines,
  verdictOf,
  type PlatformRun,
  type Report,
} from "../report.ts";

const stat = (median: number) => ({
  n: 10,
  median,
  min: median * 0.95,
  max: median * 1.05,
  spread: 0.1,
});

/** A recorded capture pair: two states, the second failing the layout gate. */
function recorded(dir: string, states: { id: string; pass: boolean; cause?: string }[]) {
  const timing = JSON.stringify({ timings: states.map((s) => ({ id: s.id, ok: true })) });
  const files: Record<string, string> = {
    [path.join(dir, "electron", "timing.json")]: timing,
    [path.join(dir, "tauri", "timing.json")]: timing,
    [path.join(dir, "tauri", "cross-engine-report.json")]: JSON.stringify({
      states: states.map((s) => ({
        id: s.id,
        pass: s.pass,
        cause: s.cause,
        reasons: s.pass ? [] : ["layout: 3 boxes moved more than 1 CSS px"],
        differingPct: 0.001,
        worstTile: { pct: 2.5 },
      })),
    }),
  };
  return stateLines(
    states.map((s) => s.id),
    { electron: path.join(dir, "electron"), tauri: path.join(dir, "tauri") },
    (file) => files[file],
  );
}

function platformRun(platform: "mac" | "win", failing?: string): PlatformRun {
  const ids = ["match-history-default", "champions-expanded"];
  const { states } = recorded(`/run/${platform}`, [
    { id: ids[0]!, pass: true },
    { id: ids[1]!, pass: failing !== ids[1], cause: failing === ids[1] ? "layout" : undefined },
  ]);
  return {
    platform,
    head: "a".repeat(40),
    trunk: "b".repeat(40),
    fixtureSha256: "32f91f0a",
    startedAt: "2026-11-23T10:00:00Z",
    finishedAt: "2026-11-23T11:00:00Z",
    expected: ids,
    states,
    golden: parseGoldenSummary(`${EXPECTED_GOLDEN_CHANNELS} pass, 0 fail, 0 not ported\n`, 0),
    checks: [{ name: "react-isms.ts", pass: true, detail: "0 findings" }],
    masks: [],
  };
}

const side = (memory: number, launch: number, download: number) => ({
  version: "x",
  downloadBytes: download,
  downloadAsset: "asset",
  installedBytes: download * 2,
  idleMemoryBytes: stat(memory),
  firstContentMs: stat(launch),
  valid: 10,
  runs: 10,
  source: "perf.json",
  medianCpuIdle: 0.4,
  medianLoad1: 6,
});

function report(runs: Report["runs"]): Report {
  const perf = { electron: side(330e6, 900, 118e6), tauri: side(120e6, 600, 5e6) };
  return { generatedAt: "now", runs, perf: { mac: perf, win: perf }, deviations: [] };
}

describe("the parity report", () => {
  test("one failing state fails the run and names the state", () => {
    const r = report({ mac: platformRun("mac", "champions-expanded"), win: platformRun("win") });
    const verdict = verdictOf(r);
    expect(verdict.pass).toBe(false);
    expect(verdict.failures).toEqual(["macOS: champions-expanded failed (layout)"]);
    const md = renderReport(r, "bun parity/report.ts render");
    expect(md).toContain("## Verdict: FAIL");
    expect(md).toContain("- macOS: champions-expanded failed (layout)");
    expect(md).toMatch(/\| champions-expanded \| FAIL layout .*\| PASS /);
  });

  test("every state passing on both platforms passes", () => {
    const r = report({ mac: platformRun("mac"), win: platformRun("win") });
    expect(verdictOf(r)).toEqual({ pass: true, failures: [] });
    expect(renderReport(r, "x")).toContain("## Verdict: PASS");
  });

  test("a state that never ran fails, and so does a missing platform", () => {
    const mac = platformRun("mac");
    mac.states = mac.states.slice(0, 1);
    const verdict = verdictOf(report({ mac }));
    expect(verdict.failures).toContain("macOS: champions-expanded did not run");
    expect(verdict.failures).toContain("Windows: no run");
  });

  test("a capture that failed on one side fails with the capture cause", () => {
    const { states } = stateLines(["a"], { electron: "/e", tauri: "/t" }, (file) =>
      file === "/e/timing.json"
        ? JSON.stringify({ timings: [{ id: "a", ok: true }] })
        : file === "/t/timing.json"
          ? JSON.stringify({ timings: [{ id: "a", ok: false, error: "expected main" }] })
          : undefined,
    );
    expect(states).toEqual([
      { id: "a", pass: false, cause: "capture", reasons: ["Tauri expected main"] },
    ]);
  });

  test("E1 passes a state over diff.ts's 0.3% and within 1.5%, the two card states included", () => {
    const budget = (pct: number) => `page budget: ${pct}% of pixels differ, budget 0.3%`;
    const read = (rows: { id: string; differingPct: number; reasons: string[] }[]) => {
      const timing = JSON.stringify({ timings: rows.map((r) => ({ id: r.id, ok: true })) });
      const files: Record<string, string> = {
        "/e/timing.json": timing,
        "/t/timing.json": timing,
        "/t/cross-engine-report.json": JSON.stringify({
          states: rows.map((r) => ({ ...r, pass: false, cause: "page-budget" })),
        }),
      };
      return stateLines(
        rows.map((r) => r.id),
        { electron: "/e", tauri: "/t" },
        (f) => files[f],
      ).states.map((s) => [s.id, s.pass, s.cause]);
    };
    expect(E1_PAGE_BUDGET_PCT).toBe(1.5);
    expect(
      read([
        { id: "game-card-default", differingPct: 1.12, reasons: [budget(1.12)] },
        { id: "season-card-default", differingPct: 0.78, reasons: [budget(0.78)] },
        { id: "over", differingPct: 1.51, reasons: [budget(1.51)] },
        { id: "tile-too", differingPct: 0.41, reasons: [budget(0.41), "tile 9% over 8%"] },
      ]),
    ).toEqual([
      ["game-card-default", true, undefined],
      ["season-card-default", true, undefined],
      ["over", false, "page-budget"],
      ["tile-too", false, "page-budget"],
    ]);
  });

  test("goldens short of 61 passing fail the run", () => {
    const mac = platformRun("mac");
    mac.golden = parseGoldenSummary(
      "60 pass, 1 fail, 0 not ported\napp:version  version  2  fail\n",
      101,
    );
    const verdict = verdictOf(report({ mac, win: platformRun("win") }));
    expect(verdict.failures).toEqual([
      `macOS: goldens 60 pass, 1 fail, 0 not ported, want ${EXPECTED_GOLDEN_CHANNELS} pass`,
    ]);
    expect(mac.golden.failing).toEqual(["app:version (fail)"]);
  });

  test("Tauri worse on a metric fails the run", () => {
    const r = report({ mac: platformRun("mac"), win: platformRun("win") });
    r.perf.win = { electron: side(330e6, 900, 94e6), tauri: side(120e6, 950, 5e6) };
    expect(verdictOf(r).failures).toEqual(["Windows: Tauri is worse on Launch to first content"]);
  });

  test("perf.ts sweeps merge per app and platform", () => {
    const json = (app: string, memory: number) => ({
      sizes: { [app]: { downloadBytes: 1, downloadAsset: "a", installedAllocatedBytes: 2 } },
      summary: {
        [app]: { runs: 10, valid: 10, idleFootprintBytes: stat(memory), firstContentMs: stat(1) },
      },
      load: { medianCpuIdle: 0.5, medianLoad1: 4 },
    });
    let table = readPerf({}, "/x/electron-1.2.1-mac.json", json("electron-1.2.1", 300));
    table = readPerf(table, "/x/tauri-mac.json", json("tauri", 100));
    table = readPerf(table, "/x/electron-1.2.1-win.json", json("electron-1.2.1", 200));
    expect(table.mac?.electron?.idleMemoryBytes?.median).toBe(300);
    expect(table.mac?.tauri?.idleMemoryBytes?.median).toBe(100);
    expect(table.win?.electron?.idleMemoryBytes?.median).toBe(200);
    expect(table.win?.tauri).toBeUndefined();
  });

  test("the deviations come from the README's register", () => {
    const readme = [
      "## Engine-difference register",
      "",
      "Intro.",
      "",
      "### A. SVG paint-server content",
      "",
      "- Where: `trends-default`.",
      "- Rule: skip defs.",
      "",
      "## Determinism",
    ].join("\n");
    expect(readDeviations(readme)).toEqual([
      {
        name: "A. SVG paint-server content",
        where: "Where: `trends-default`.",
        rule: "skip defs.",
      },
    ]);
  });
});
