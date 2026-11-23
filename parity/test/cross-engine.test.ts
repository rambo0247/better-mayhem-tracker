import { describe, expect, test } from "bun:test";
import { PNG } from "pngjs";
import { causeOf, locateWorstWindow, unexpectedMisses } from "../capture.ts";
import { diffPngs, type DiffResult, type GeometryRow } from "../diff.ts";

function solid(width: number, height: number, paint?: (x: number, y: number) => boolean) {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const on = paint?.(x, y) ?? false;
      png.data.set(on ? [250, 250, 250, 255] : [10, 16, 36, 255], i);
    }
  }
  return png;
}

const failing = (layoutPass: boolean, elementsB = 10): DiffResult => ({
  policy: "cross-engine",
  pass: false,
  reasons: ["page budget: 1% of pixels differ, budget 0.3%"],
  size: [100, 100],
  differing: 100,
  differingPct: 1,
  blurRegions: [],
  layout: {
    pass: layoutPass,
    elementsA: 10,
    elementsB,
    identical: 10,
    within05: 10,
    within1: 10,
    beyond: 0,
    pathMismatches: 0,
    widthExempt: 0,
  },
});

describe("the cause a cross-engine state is listed under", () => {
  test("is replay-data only when the replay missed", () => {
    expect(causeOf(failing(true), ["default: getMatchHistory([20,0])"])).toBe("replay-data");
    expect(causeOf(failing(false, 12), ["ReplayMiss: getSeasons([])"])).toBe("replay-data");
  });

  test("is the gate that failed when the replay answered every call", () => {
    expect(causeOf(failing(false, 12))).toBe("layout");
    expect(causeOf(failing(true))).toBe("page-budget");
    expect(causeOf({ ...failing(true), pass: true })).toBeUndefined();
  });
});

describe("locating the worst tile", () => {
  test("finds the sliding window the gate counted, not a fixed grid cell", () => {
    // A 40 px block straddling the 64 px grid lines: no grid cell holds all of it
    const block = (x: number, y: number) => x >= 50 && x < 90 && y >= 100 && y < 140;
    const a = solid(256, 256);
    const b = solid(256, 256, block);
    const rows: GeometryRow[] = [["body", "BODY", 0, 0, 256, 256]];
    const result = diffPngs(a, b, {
      policy: "cross-engine",
      geometryA: rows,
      geometryB: rows,
      scale: 1,
    });
    const at = locateWorstWindow(result.diffImage!, 1);
    expect(at.differing).toBe(result.worstTile!.differing);
    expect(at.differing).toBe(1600);
    expect(at.xCss).toBeLessThanOrEqual(50);
    expect(at.xCss + 64).toBeGreaterThanOrEqual(90);
    expect(at.yCss).toBeLessThanOrEqual(100);
    expect(at.yCss + 64).toBeGreaterThanOrEqual(140);
  });
});

describe("replay misses on Windows", () => {
  test("the replay takes isWindowMaximized from its default golden there, and nothing else", () => {
    const unlisted = "unlisted: isWindowMaximized([])";
    expect(unexpectedMisses([unlisted], [], "win32")).toEqual([]);
    expect(unexpectedMisses([unlisted], [], "darwin")).toEqual([unlisted]);
    expect(unexpectedMisses(["ReplayMiss: isWindowMaximized([])"], [], "win32")).toHaveLength(1);
    expect(unexpectedMisses(["default: isWindowMaximized([])"], [], "win32")).toHaveLength(1);
    expect(unexpectedMisses(['unlisted: getSetting(["x"])'], [], "win32")).toHaveLength(1);
    expect(unexpectedMisses(['unlisted: getSetting(["x"])'], ["getSetting"], "darwin")).toEqual([]);
  });
});
