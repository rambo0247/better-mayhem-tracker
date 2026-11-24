import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { PNG } from "pngjs";
import {
  compareLayout,
  CROSS_ENGINE,
  diffPngs,
  type FocusMeta,
  type GeometryRow,
} from "../diff.ts";
import { applyRuleH, attributeLayout, type StateLine } from "../report.ts";

const tolerance = CROSS_ENGINE.layoutToleranceCss;

type Style = { textOverflow: string; overflowX: string };

class FakeElement {
  scrollWidth = 0;
  clientWidth = 0;
  naturalWidth = 0;
  naturalHeight = 0;
  style: Style = { textOverflow: "clip", overflowX: "visible" };
  attributes = new Set<string>();
  constructor(
    readonly tagName: string,
    readonly box: [number, number, number, number],
    readonly children: FakeElement[] = [],
  ) {}
  hasAttribute(name: string) {
    return this.attributes.has(name);
  }
  getBoundingClientRect() {
    const [x, y, width, height] = this.box;
    return { x, y, width, height };
  }
}
class FakeSvgElement extends FakeElement {}

const source = fs.readFileSync(path.join(import.meta.dir, "..", "geometry.js"), "utf8");

/** Runs geometry.js as drive.ts sends it, against a page of fake elements. */
function geometryOf(body: FakeElement): GeometryRow[] {
  const page = {
    document: { body },
    SVGElement: FakeSvgElement,
    getComputedStyle: (el: FakeElement) => el.style,
  };
  return JSON.parse(vm.runInNewContext(source, page) as string) as GeometryRow[];
}

function truncating(width: number, contentWidth: number, children: FakeElement[]) {
  const el = new FakeElement("DIV", [187, 192.25, width, 27.5], children);
  el.style = { textOverflow: "ellipsis", overflowX: "hidden" };
  el.clientWidth = width;
  el.scrollWidth = contentWidth;
  return el;
}

const set = (rows: GeometryRow[], at: string, k: 2 | 3 | 4 | 5, by: number) =>
  rows.map((row) => {
    if (row[0] !== at) return row;
    const copy = [...row] as GeometryRow;
    copy[k] = row[k] + by;
    return copy;
  });

describe("rule A: SVG paint-server content", () => {
  // The trends chart: a bar filled from a <pattern> whose <rect> WebKit gives a 2 by 6 box
  const chart = () =>
    new FakeElement(
      "BODY",
      [0, 0, 1280, 820],
      [
        new FakeSvgElement(
          "svg",
          [263, 507, 968, 192],
          [
            new FakeSvgElement(
              "defs",
              [0, 0, 0, 0],
              [
                new FakeSvgElement(
                  "pattern",
                  [0, 0, 0, 0],
                  [new FakeSvgElement("rect", [263, 507, 2, 6])],
                ),
                new FakeSvgElement(
                  "linearGradient",
                  [0, 0, 0, 0],
                  [new FakeSvgElement("stop", [263, 507, 1, 1])],
                ),
              ],
            ),
            new FakeSvgElement("rect", [563.32, 647, 31.36, 12]),
          ],
        ),
      ],
    );

  test("geometry.js leaves out what defs hold and keeps the shapes that use it", () => {
    const rows = geometryOf(chart());
    expect(rows.map((row) => [row[0], row[1]])).toEqual([
      ["b", "BODY"],
      ["b/0", "svg"],
      ["b/0/1", "rect"],
    ]);
  });

  test("the chart passes once the pattern's rect is left out", () => {
    const webkit = geometryOf(chart());
    const chromium = set(set(webkit, "b/0/1", 3, -0.05), "b/0", 3, -0.05);
    expect(compareLayout(chromium, webkit, tolerance).pass).toBe(true);
  });

  test("negative control: the patterned bar shifted 2 px still fails", () => {
    const webkit = geometryOf(chart());
    const result = compareLayout(webkit, set(webkit, "b/0/1", 2, 2), tolerance);
    expect(result.pass).toBe(false);
    expect(result.worst).toEqual({ path: "b/0/1", shiftCss: 2 });
  });

  test("a non-SVG element named like a paint server is kept", () => {
    const body = new FakeElement(
      "BODY",
      [0, 0, 100, 100],
      [new FakeElement("filter", [0, 0, 10, 10], [new FakeElement("DIV", [0, 0, 5, 5])])],
    );
    expect(geometryOf(body)).toHaveLength(3);
  });
});

describe("rule B: inline boxes inside an overflowing ellipsis container", () => {
  // match-history-narrow-900: the friend name truncates, Chromium's bdi box spans the
  // ellipsis and WebKit's the text run. Measured boxes from both engines (README.md).
  const page = (engine: "chromium" | "webkit") => {
    const [width, name, tag, y, h] =
      engine === "chromium"
        ? [126.6, 124.44, [320.04, 40.62], 192.75, 26.5]
        : [126.59, 119.48, [320.03, 40.61], 192.8, 26.4];
    return new FakeElement(
      "BODY",
      [0, 0, 900, 820],
      [
        truncating(width, 175, [
          new FakeElement("BDI", [187, y, name, h]),
          new FakeElement("BDI", [tag[0]!, y, tag[1]!, h]),
        ]),
      ],
    );
  };

  test("geometry.js marks the container's descendants and not the container", () => {
    const rows = geometryOf(page("webkit"));
    expect(rows.map((row) => row[6])).toEqual([undefined, undefined, "ellipsis", "ellipsis"]);
  });

  test("an ellipsis container whose text fits marks nothing", () => {
    const body = new FakeElement(
      "BODY",
      [0, 0, 900, 820],
      [truncating(126.6, 126.6, [new FakeElement("BDI", [187, 192.8, 119.48, 26.4])])],
    );
    expect(geometryOf(body).some((row) => row[6] === "ellipsis")).toBe(false);
  });

  test("the bdi's 4.96 px width difference passes, compared on x, y and height", () => {
    const result = compareLayout(
      geometryOf(page("chromium")),
      geometryOf(page("webkit")),
      tolerance,
    );
    expect(result.pass).toBe(true);
    expect(result.widthExempt).toBe(2);
  });

  test("the same width difference fails without the rule", () => {
    const strip = (rows: GeometryRow[]) => rows.map((row) => row.slice(0, 6) as GeometryRow);
    const result = compareLayout(
      strip(geometryOf(page("chromium"))),
      strip(geometryOf(page("webkit"))),
      tolerance,
    );
    expect(result.pass).toBe(false);
    expect(result.worst).toEqual({ path: "b/0/0", shiftCss: 4.96 });
  });

  const controls: [string, string, 2 | 3 | 4 | 5, number, number][] = [
    ["bdi x +2", "b/0/0", 2, 2, 2],
    ["bdi y +2", "b/0/0", 3, 2, 2.05],
    ["bdi height +2", "b/0/0", 5, 2, 1.9],
    ["ellipsis container width -2", "b/0", 4, -2, 2.01],
  ];
  for (const [name, at, k, by, shiftCss] of controls) {
    test(`negative control: ${name} fails`, () => {
      const chromium = geometryOf(page("chromium"));
      const webkit = set(geometryOf(page("webkit")), at, k, by);
      const result = compareLayout(chromium, webkit, tolerance);
      expect(result.pass).toBe(false);
      expect(result.beyond).toBe(1);
      expect(result.worst).toEqual({ path: at, shiftCss });
    });
  }

  test("a row only one engine marks is still compared on width", () => {
    const chromium = geometryOf(page("chromium")).map((row) => row.slice(0, 6) as GeometryRow);
    const result = compareLayout(chromium, geometryOf(page("webkit")), tolerance);
    expect(result.pass).toBe(false);
    expect(result.widthExempt).toBe(0);
  });
});

describe("elements the port marks data-parity-skip", () => {
  // global-champion-detail-default: Electron draws the portrait as one img with
  // object-view-box. The port draws a clipping span at the same box with a larger img inside.
  const electron = () =>
    new FakeElement(
      "BODY",
      [0, 0, 1280, 820],
      [
        new FakeElement("DIV", [289, 73, 116, 116], [new FakeElement("IMG", [291, 75, 112, 112])]),
        new FakeElement("DIV", [429, 81, 790, 108]),
      ],
    );
  const port = (marked: boolean) => {
    const span = new FakeElement(
      "SPAN",
      [291, 75, 112, 112],
      [new FakeElement("IMG", [285.64, 69.64, 122.72, 122.72])],
    );
    if (marked) span.attributes.add("data-parity-skip");
    return new FakeElement(
      "BODY",
      [0, 0, 1280, 820],
      [
        new FakeElement("DIV", [289, 73, 116, 116], [span]),
        new FakeElement("DIV", [429, 81.2, 790, 107.8]),
      ],
    );
  };

  test("a marked element keeps its own box and leaves out what it wraps", () => {
    expect(geometryOf(port(true)).map((row) => [row[0], row[1]])).toEqual([
      ["b", "BODY"],
      ["b/0", "DIV"],
      ["b/0/0", "IMG"],
      ["b/1", "DIV"],
    ]);
  });

  test("the marked crop span compares with Electron's img, every path aligned", () => {
    const result = compareLayout(geometryOf(electron()), geometryOf(port(true)), tolerance);
    expect(result.pathMismatches).toBe(0);
    expect(result.beyond).toBe(0);
    expect(result.pass).toBe(true);
  });

  test("negative control: the same extra element without the mark still fails", () => {
    const result = compareLayout(geometryOf(electron()), geometryOf(port(false)), tolerance);
    expect(result.elementsB).toBe(result.elementsA + 1);
    expect(result.pathMismatches).toBeGreaterThan(0);
    expect(result.pass).toBe(false);
  });

  test("negative control: a marked element moved 2 px still fails", () => {
    const moved = port(true);
    moved.children[0]!.children[0]!.box[0] += 2;
    const result = compareLayout(geometryOf(electron()), geometryOf(moved), tolerance);
    expect(result.beyond).toBe(1);
    expect(result.pass).toBe(false);
  });
});

describe("rule E: images both engines draw scaled at the same box", () => {
  // season-recap-default: a 300 px portrait drawn 92.02 CSS px wide under CSS zoom. Chromium
  // ends its box on device row 626 and WebKit on 625, so each resamples it into its own rows.
  const width = 2560;
  const height = 1600;
  const image = { x: 200, y: 150, size: 92 };
  const text = { x: 294, y: 200, w: 60, h: 20 };

  const paint = (png: PNG, x: number, y: number, rgb: number[]) => {
    const i = (y * width + x) * 4;
    png.data.set([...rgb, 255], i);
  };
  // Hard edges, so one row of resampling phase moves them: the case the tile rule trips on
  const portrait = (u: number, v: number, seed: number) => [
    Math.sin(u / 3 + seed) * Math.cos(v / 3.9) > 0 ? 220 : 40,
    Math.sin((u + v) / 5.1 + seed) > 0 ? 200 : 60,
    Math.cos(u / 2.7 - v / 6.3 + seed) > 0 ? 180 : 50,
  ];
  /** The page with the portrait resampled into `rows` device rows, as an engine draws it. */
  const page = (rows: number, opts: { seed?: number; dx?: number; strokes?: "v" | "h" } = {}) => {
    const png = new PNG({ width, height });
    for (let i = 0; i < width * height; i++) png.data.set([24, 26, 32, 255], i * 4);
    const cols = image.size * 2;
    const [x0, y0] = [image.x * 2 + (opts.dx ?? 0), image.y * 2];
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const sum = [0, 0, 0];
        for (let j = 0; j < 4; j++) {
          for (let i = 0; i < 4; i++) {
            const c = portrait(
              ((x + (i + 0.5) / 4) * 300) / cols,
              ((y + (j + 0.5) / 4) * 300) / rows,
              opts.seed ?? 0,
            );
            for (let k = 0; k < 3; k++) sum[k]! += c[k]! / 16;
          }
        }
        paint(png, x0 + x, y0 + y, sum.map(Math.round));
      }
    }
    for (let y = text.y * 2; y < (text.y + text.h) * 2; y++) {
      for (let x = text.x * 2; x < (text.x + text.w) * 2; x++) {
        const stroke = (opts.strokes ?? "v") === "v" ? x % 4 < 2 : y % 4 < 2;
        if (stroke) paint(png, x, y, [230, 230, 230]);
      }
    }
    return png;
  };
  const rows = (imageHeight: number, opts: { dx?: number; marked?: boolean } = {}) =>
    [
      ["b", "BODY", 0, 0, width / 2, height / 2],
      [
        "b/0",
        "IMG",
        image.x + (opts.dx ?? 0),
        image.y,
        image.size,
        imageHeight,
        ...(opts.marked === false ? [] : [{ image: [300, 300] as [number, number] }]),
      ],
      ["b/1", "SPAN", text.x, text.y, text.w, text.h],
    ] as GeometryRow[];
  const chromium = () => page(184);
  const diff = (b: PNG, geometryB: GeometryRow[], geometryA = rows(92)) =>
    diffPngs(chromium(), b, { policy: "cross-engine", geometryA, geometryB });
  const tileFails = (result: ReturnType<typeof diff>) =>
    result.reasons.some((reason) => reason.startsWith("tile rule"));

  test("geometry.js gives a decoded img its natural size and an undecoded one none", () => {
    const decoded = new FakeElement("IMG", [200, 150, 92.02, 92.02]);
    decoded.naturalWidth = 300;
    decoded.naturalHeight = 300;
    const pending = new FakeElement("IMG", [300, 150, 92.02, 92.02]);
    const rows = geometryOf(new FakeElement("BODY", [0, 0, 1280, 820], [decoded, pending]));
    expect(rows.map((row) => row.slice(6))).toEqual([[], [{ image: [300, 300] }], []]);
  });

  test("a wrapper marked data-parity-skip does not take its img's natural size", () => {
    const img = new FakeElement("IMG", [285.64, 69.64, 122.72, 122.72]);
    img.naturalWidth = 300;
    img.naturalHeight = 300;
    const span = new FakeElement("SPAN", [291, 75, 112, 112], [img]);
    span.attributes.add("data-parity-skip");
    const rows = geometryOf(new FakeElement("BODY", [0, 0, 1280, 820], [span]));
    expect(rows[1]?.slice(1, 2)).toEqual(["IMG"]);
    expect(rows[1]?.slice(6)).toEqual([]);
  });

  test("the portrait resampled one row apart fails the tile rule without the rule", () => {
    const result = diff(page(185), rows(92.5, { marked: false }), rows(92, { marked: false }));
    expect(result.layout?.pass).toBe(true);
    expect(result.worstTile!.pct).toBeGreaterThan(CROSS_ENGINE.tileBudget * 100);
    expect(tileFails(result)).toBe(true);
  });

  test("with the rule the tile passes and the page still counts the portrait's pixels", () => {
    const without = diff(page(185), rows(92.5, { marked: false }), rows(92, { marked: false }));
    const result = diff(page(185), rows(92.5));
    expect(result.scaledImages).toEqual([expect.objectContaining({ path: "b/0", exempt: true })]);
    expect(tileFails(result)).toBe(false);
    expect(result.differing).toBe(without.differing);
    expect(result.differing).toBeGreaterThan(0);
    expect(result.pass).toBe(true);
  });

  test("an image drawn one device px per natural px is not scaled, so not exempt", () => {
    const natural = rows(92.5).map((row) =>
      row[0] === "b/0" ? ([...row.slice(0, 6), { image: [184, 185] }] as GeometryRow) : row,
    );
    const result = diff(page(185), natural, natural);
    expect(result.scaledImages).toEqual([]);
    expect(tileFails(result)).toBe(true);
  });

  test("an image outside the snapshot is skipped", () => {
    const below = rows(92.5).map((row) =>
      row[0] === "b/0" ? ([row[0], row[1], row[2], height, ...row.slice(4)] as GeometryRow) : row,
    );
    const result = diff(page(184), below, below);
    expect(result.scaledImages).toEqual([]);
    expect(result.pass).toBe(true);
  });

  test("negative control: a different image in that box fails the tile rule", () => {
    const result = diff(page(185, { seed: 1.7 }), rows(92.5));
    expect(result.scaledImages).toEqual([expect.objectContaining({ path: "b/0", exempt: false })]);
    expect(tileFails(result)).toBe(true);
    expect(result.pass).toBe(false);
  });

  test("negative control: the same image moved 2 px fails the tile rule", () => {
    const result = diff(page(185, { dx: 4 }), rows(92.5, { dx: 2 }));
    expect(result.scaledImages).toEqual([]);
    expect(tileFails(result)).toBe(true);
    expect(result.pass).toBe(false);
  });

  test("negative control: changed text beside the image, inside an exempted tile, fails", () => {
    const result = diff(page(185, { strokes: "h" }), rows(92.5));
    expect(result.scaledImages).toEqual([expect.objectContaining({ path: "b/0", exempt: true })]);
    expect(tileFails(result)).toBe(true);
    expect(result.pass).toBe(false);
  });
});

describe("rule F: a focus ring Tauri's never-active window cannot draw", () => {
  // overlay-dialog-escape: Escape hands focus back to the update button, and Electron rings it.
  // WebKit matches :focus-visible only in the active window, which the driver never makes it.
  const width = 2560;
  const height = 1600;
  const button = { x: 12, y: 656.75, w: 40, h: 24 };
  const outline = { width: 4, offset: -4 };
  const text = { x: 56, y: 658, w: 40, h: 24 };

  const page = (opts: { ring?: boolean; strokes?: "v" | "h" } = {}) => {
    const png = new PNG({ width, height });
    for (let i = 0; i < width * height; i++) png.data.set([24, 26, 32, 255], i * 4);
    const fill = (
      r: { x: number; y: number; w: number; h: number },
      keep: (x: number, y: number) => boolean,
      rgb: number[],
    ) => {
      for (let y = Math.round(r.y * 2); y < Math.round((r.y + r.h) * 2); y++)
        for (let x = Math.round(r.x * 2); x < Math.round((r.x + r.w) * 2); x++)
          if (keep(x, y)) png.data.set([...rgb, 255], (y * width + x) * 4);
    };
    fill(button, () => true, [60, 52, 30]);
    if (opts.ring) {
      const band = -outline.offset * 2;
      const [x0, y0] = [Math.round(button.x * 2), Math.round(button.y * 2)];
      const [x1, y1] = [
        Math.round((button.x + button.w) * 2),
        Math.round((button.y + button.h) * 2),
      ];
      fill(
        button,
        (x, y) => x < x0 + band || x >= x1 - band || y < y0 + band || y >= y1 - band,
        [240, 210, 140],
      );
    }
    fill(text, (x, y) => ((opts.strokes ?? "v") === "v" ? x % 4 < 2 : y % 4 < 2), [230, 230, 230]);
    return png;
  };
  const rows = [
    ["b", "BODY", 0, 0, width / 2, height / 2],
    ["b/0", "BUTTON", button.x, button.y, button.w, button.h],
    ["b/1", "SPAN", text.x, text.y, text.w, text.h],
  ] as GeometryRow[];
  const electron: FocusMeta = {
    path: "b/0",
    box: { ...button },
    outline,
    focusVisible: true,
    focusMatches: true,
    documentHasFocus: true,
  };
  const tauri: FocusMeta = {
    path: "b/0",
    box: { ...button },
    outline: null,
    focusVisible: false,
    focusMatches: false,
    documentHasFocus: false,
  };
  const diff = (b: PNG, focus?: [FocusMeta | null, FocusMeta | null]) =>
    diffPngs(page({ ring: true }), b, {
      policy: "cross-engine",
      geometryA: rows,
      geometryB: rows,
      ...(focus ? { focus } : {}),
    });
  const tileFails = (result: ReturnType<typeof diff>) =>
    result.reasons.some((reason) => reason.startsWith("tile rule"));

  test("the ring alone fails the tile rule without the rule", () => {
    const result = diff(page());
    expect(result.layout?.pass).toBe(true);
    expect(result.unfocusedRing).toBeUndefined();
    expect(tileFails(result)).toBe(true);
  });

  test("with the rule the tile passes and the page still counts the ring's pixels", () => {
    const without = diff(page());
    const result = diff(page(), [electron, tauri]);
    expect(result.unfocusedRing).toEqual({ path: "b/0", region: button });
    expect(tileFails(result)).toBe(false);
    expect(result.differing).toBe(without.differing);
    expect(result.differing).toBeGreaterThan(0);
    expect(result.pass).toBe(true);
  });

  test("the left-out box is grown by an outline drawn outside the element", () => {
    const outside = { ...electron, outline: { width: 2, offset: 1 } };
    expect(diff(page(), [outside, tauri]).unfocusedRing?.region).toEqual({
      x: button.x - 3,
      y: button.y - 3,
      w: button.w + 6,
      h: button.h + 6,
    });
  });

  test("negative control: a different element focused in Tauri fails the tile rule", () => {
    const result = diff(page(), [electron, { ...tauri, path: "b/1", box: { ...text } }]);
    expect(result.unfocusedRing).toBeUndefined();
    expect(tileFails(result)).toBe(true);
  });

  test("negative control: no element focused in Tauri fails the tile rule", () => {
    const result = diff(page(), [electron, null]);
    expect(result.unfocusedRing).toBeUndefined();
    expect(tileFails(result)).toBe(true);
  });

  test("negative control: a focused Tauri window that draws no ring fails the tile rule", () => {
    const result = diff(page(), [electron, { ...tauri, documentHasFocus: true }]);
    expect(result.unfocusedRing).toBeUndefined();
    expect(tileFails(result)).toBe(true);
  });

  test("negative control: Electron's focus without a ring exempts nothing", () => {
    const result = diff(page(), [{ ...electron, focusVisible: false }, tauri]);
    expect(result.unfocusedRing).toBeUndefined();
    expect(tileFails(result)).toBe(true);
  });

  test("negative control: the focused element moved 2 px fails the tile rule", () => {
    const moved = { ...tauri, box: { ...button, x: button.x + 2 } };
    const result = diff(page(), [electron, moved]);
    expect(result.unfocusedRing).toBeUndefined();
    expect(tileFails(result)).toBe(true);
  });

  test("negative control: changed text beside the ring, inside the same tile, fails", () => {
    const result = diff(page({ strokes: "h" }), [electron, tauri]);
    expect(result.unfocusedRing?.path).toBe("b/0");
    expect(tileFails(result)).toBe(true);
    expect(result.pass).toBe(false);
  });
});

describe("rule H: Chromium versions on Windows, judged against Electron's renderer in WebView2", () => {
  const dirs = { electron: "/e", tauri: "/t", reference: "/r" };
  const at = (dir: string, ext: string) => path.join(dir, `a.${ext}`);
  // The match-history header: a subtitle Edge 157 lays out taller than Chromium 152
  const app: GeometryRow[] = [
    ["b/0", "DIV", 260, 40, 988, 104],
    ["b/0/0", "DIV", 260, 103, 191.87, 21],
    ["b/1", "DIV", 260, 168, 988, 199],
  ];
  const moved = (rows: GeometryRow[], where: string, dy: number) => set(rows, where, 3, dy);
  const image = (width = 40, height = 40, changed = 0) => {
    const png = new PNG({ width, height });
    png.data.fill(30);
    for (let i = 0; i < changed; i++) {
      png.data[i * 4] = 250;
      png.data[i * 4 + 3] = 255;
    }
    for (let i = 3; i < png.data.length; i += 4) png.data[i] = 255;
    return png;
  };
  const crossFailed = (reasons: string[]): StateLine => ({
    id: "a",
    pass: false,
    cause: "page-budget",
    differingPct: 2.1,
    reasons,
  });
  const layoutReason = "layout gate: 3 against 3 elements, 1 boxes moved more than 1 CSS px";
  const judge = (options: {
    tauri?: GeometryRow[];
    reference?: GeometryRow[];
    tauriPng?: PNG;
    referencePng?: PNG;
    reasons?: string[];
    platform?: "win" | "mac";
    referenceOk?: boolean;
  }) => {
    const geometry: Record<string, GeometryRow[]> = {
      [at(dirs.electron, "geometry.json")]: app,
      [at(dirs.tauri, "geometry.json")]: options.tauri ?? app,
      [at(dirs.reference, "geometry.json")]: options.reference ?? options.tauri ?? app,
    };
    const pngs: Record<string, PNG> = {
      [at(dirs.tauri, "png")]: options.tauriPng ?? image(),
      [at(dirs.reference, "png")]: options.referencePng ?? image(),
    };
    const timing = JSON.stringify({
      timings: [{ id: "a", ok: options.referenceOk ?? true, error: "Error: boom" }],
    });
    const [state] = applyRuleH(
      options.platform ?? "win",
      [crossFailed(options.reasons ?? [layoutReason, "page budget: 2.1% of pixels differ"])],
      dirs,
      {
        text: (f) => (f === path.join(dirs.reference, "timing.json") ? timing : undefined),
        png: (f) => pngs[f],
        geometry: (f) => geometry[f],
      },
    );
    return state!;
  };
  const engineShift = moved(moved(app, "b/0/0", 1.5), "b/1", 1.5);

  test("a shift Electron's renderer in WebView2 makes the same way passes, page budget and all", () => {
    const state = judge({ tauri: engineShift, reference: engineShift });
    expect(state.pass).toBe(true);
    expect(state.ruleH?.crossGates).toEqual([
      expect.objectContaining({ reason: layoutReason, attributed: true }),
    ]);
    expect(state.ruleH?.crossReasons).toContain(layoutReason);
    expect(state.differingPct).toBe(2.1);
    expect(state.ruleH?.sameEngine.differingPct).toBe(0);
  });

  test("within 1 CSS px of the renderer's own move still counts as the same way", () => {
    const state = judge({ tauri: engineShift, reference: moved(engineShift, "b/1", 0.75) });
    expect(state.pass).toBe(true);
  });

  test("negative control: a port shift in WebView2 the renderer does not make fails", () => {
    const state = judge({ tauri: moved(app, "b/1", 2), reference: app });
    expect(state.pass).toBe(false);
    expect(state.cause).toBe("layout");
    expect(state.reasons[0]).toContain("not reproduced: b/1");
  });

  test("negative control: a box the renderer moves the other way fails", () => {
    const state = judge({ tauri: moved(app, "b/1", 2), reference: moved(app, "b/1", -2) });
    expect(state.pass).toBe(false);
    expect(state.cause).toBe("layout");
  });

  test("negative control: an extra element only the port has fails", () => {
    const extra: GeometryRow[] = [...app, ["b/2", "SPAN", 260, 380, 10, 10]];
    const state = judge({ tauri: extra, reference: app });
    expect(state.pass).toBe(false);
    expect(state.reasons[0]).toContain("from Electron's renderer in WebView2");
  });

  test("negative control: pixels over 0.3% against the renderer fail, with no E1", () => {
    // 40 by 40 is 1600 pixels: 8 is 0.5%, 4 is 0.25%
    const over = judge({ tauriPng: image(40, 40, 8), reasons: ["page budget: 0.5% of pixels"] });
    expect(over.pass).toBe(false);
    expect(over.cause).toBe("same-engine");
    expect(over.ruleH?.sameEngine.differingPct).toBe(0.5);
    const within = judge({ tauriPng: image(40, 40, 4), reasons: ["page budget: 0.25%"] });
    expect(within.pass).toBe(true);
  });

  test("a size the renderer shares passes, and negative control: one it does not share fails", () => {
    const sizeReason = "image sizes differ: 40x40 against 40x41";
    const shared = judge({
      tauriPng: image(40, 41),
      referencePng: image(40, 41),
      reasons: [sizeReason],
    });
    expect(shared.pass).toBe(true);
    const own = judge({
      tauriPng: image(40, 41),
      referencePng: image(40, 40),
      reasons: [sizeReason],
    });
    expect(own.pass).toBe(false);
    expect(own.cause).toBe("same-engine");
    expect(own.reasons.join(" ")).toContain("image sizes differ");
  });

  test("a state whose reference did not capture fails as a capture", () => {
    const state = judge({ referenceOk: false });
    expect(state.pass).toBe(false);
    expect(state.cause).toBe("capture");
  });

  test("negative control: rule H never applies on macOS", () => {
    const state = judge({ platform: "mac", tauri: engineShift, reference: engineShift });
    expect(state.pass).toBe(false);
    expect(state.cause).toBe("page-budget");
    expect(state.ruleH).toBeUndefined();
  });

  test("attribution compares boxes by path, so the renderer's element list may differ only if the port's does too", () => {
    expect(attributeLayout(app, engineShift, engineShift).attributed).toBe(true);
    expect(attributeLayout(app, engineShift, app).attributed).toBe(false);
  });
});
