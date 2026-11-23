import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { compareLayout, CROSS_ENGINE, type GeometryRow } from "../diff.ts";

const tolerance = CROSS_ENGINE.layoutToleranceCss;

type Style = { textOverflow: string; overflowX: string };

class FakeElement {
  scrollWidth = 0;
  clientWidth = 0;
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
