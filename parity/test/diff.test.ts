import { describe, expect, test } from "bun:test";
import { PNG } from "pngjs";
import { diffPngs, type GeometryRow } from "../diff.ts";

const WIDTH = 2560;
const HEIGHT = 1600;

function page(): PNG {
  const png = new PNG({ width: WIDTH, height: HEIGHT });
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const i = (y * WIDTH + x) * 4;
      png.data[i] = 20 + ((x * 7 + y * 3) % 200);
      png.data[i + 1] = 30 + ((x * 5) % 180);
      png.data[i + 2] = 60 + ((y * 11) % 160);
      png.data[i + 3] = 255;
    }
  }
  return png;
}

const copy = (png: PNG) => {
  const out = new PNG({ width: png.width, height: png.height });
  png.data.copy(out.data);
  return out;
};

const boxes = (shift = 0): GeometryRow[] => [
  ["b", "BODY", 0, 0, 1280, 800],
  ["b/0", "DIV", 10, 10, 200, 100],
  ["b/0/0", "IMG", 20 + shift, 20, 46, 46],
];

describe("same-engine policy", () => {
  test("two identical images pass", () => {
    const a = page();
    const result = diffPngs(a, copy(a), { policy: "same-engine" });
    expect(result.pass).toBe(true);
    expect(result.differing).toBe(0);
  });

  test("11 pixels off by one level still pass at threshold 0.03", () => {
    const a = page();
    const b = copy(a);
    for (let k = 0; k < 11; k++) b.data[(100 * WIDTH + 200 + k * 13) * 4] += 1;
    const result = diffPngs(a, b, { policy: "same-engine" });
    expect(result.differing).toBe(0);
    expect(result.pass).toBe(true);
  });

  test("a visible change fails with a count", () => {
    const a = page();
    const b = copy(a);
    for (let x = 0; x < 20; x++)
      b.data[(300 * WIDTH + x) * 4 + 1] = 255 - b.data[(300 * WIDTH + x) * 4 + 1]!;
    const result = diffPngs(a, b, { policy: "same-engine" });
    expect(result.pass).toBe(false);
    expect(result.differing).toBeGreaterThan(0);
  });

  test("different sizes fail", () => {
    const small = new PNG({ width: 10, height: 10 });
    expect(diffPngs(page(), small, { policy: "same-engine" }).pass).toBe(false);
  });
});

describe("cross-engine policy", () => {
  test("identical images with identical geometry pass", () => {
    const a = page();
    const result = diffPngs(a, copy(a), {
      policy: "cross-engine",
      geometryA: boxes(),
      geometryB: boxes(),
    });
    expect(result.pass).toBe(true);
    expect(result.layout?.identical).toBe(3);
  });

  test("a 2 px layout shift fails the layout gate, and a 0.5 px shift does not", () => {
    const a = page();
    const shifted = diffPngs(a, copy(a), {
      policy: "cross-engine",
      geometryA: boxes(),
      geometryB: boxes(2),
    });
    expect(shifted.pass).toBe(false);
    expect(shifted.layout?.pass).toBe(false);
    expect(shifted.layout?.worst?.shiftCss).toBe(2);
    expect(shifted.reasons[0]).toContain("layout gate");

    const nudged = diffPngs(a, copy(a), {
      policy: "cross-engine",
      geometryA: boxes(),
      geometryB: boxes(0.5),
    });
    expect(nudged.layout?.within05).toBe(1);
    expect(nudged.pass).toBe(true);
  });

  test("a different element count fails the layout gate", () => {
    const a = page();
    const result = diffPngs(a, copy(a), {
      policy: "cross-engine",
      geometryA: boxes(),
      geometryB: boxes().slice(0, 2),
    });
    expect(result.layout?.pass).toBe(false);
  });

  test("a missing icon crop passes the page budget and fails the tile rule", () => {
    const a = page();
    const b = copy(a);
    const scale = 2;
    const [x0, y0, size] = [400 * scale, 300 * scale, 46 * scale];
    for (let y = y0; y < y0 + size; y++) {
      for (let x = x0; x < x0 + size; x++) {
        const i = (y * WIDTH + x) * 4;
        b.data[i] = 255 - a.data[i]!;
        b.data[i + 1] = 255 - a.data[i + 1]!;
        b.data[i + 2] = 255 - a.data[i + 2]!;
      }
    }
    const result = diffPngs(a, b, {
      policy: "cross-engine",
      geometryA: boxes(),
      geometryB: boxes(),
    });
    expect(result.differingPct).toBeLessThan(0.3);
    expect(result.pass).toBe(false);
    expect(result.reasons.some((reason) => reason.startsWith("tile rule"))).toBe(true);
    expect(result.reasons.some((reason) => reason.startsWith("page budget"))).toBe(false);
  });

  test("a declared blur region is judged by the tile rule at threshold 0.2 and left out of the page budget", () => {
    const a = page();
    const b = copy(a);
    for (let y = 200; y < 264; y++) {
      for (let x = 200; x < 264; x++) {
        const i = (y * WIDTH + x) * 4;
        b.data[i] = 255 - a.data[i]!;
      }
    }
    const region = { x: 90, y: 90, w: 60, h: 60 };
    const declared = diffPngs(a, b, {
      policy: "cross-engine",
      geometryA: boxes(),
      geometryB: boxes(),
      blurRegions: [region],
    });
    expect(declared.blurRegions[0]?.region).toEqual(region);
    expect(declared.differing).toBe(0);
  });

  test("missing geometry fails the layout gate", () => {
    const a = page();
    expect(diffPngs(a, copy(a), { policy: "cross-engine" }).pass).toBe(false);
  });
});
