import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const SOURCE = fs.readFileSync(path.join(import.meta.dir, "..", "geometry.js"), "utf8");

interface FakeElement {
  tagName: string;
  children: FakeElement[];
  firstElementChild: FakeElement | null;
  hasAttribute(name: string): boolean;
  getBoundingClientRect(): { x: number; y: number; width: number; height: number };
}

function el(
  tagName: string,
  [x, y, width, height]: number[],
  children: FakeElement[] = [],
  attrs: string[] = [],
): FakeElement {
  return {
    tagName,
    children,
    firstElementChild: children[0] ?? null,
    hasAttribute: (name) => attrs.includes(name),
    getBoundingClientRect: () => ({ x: x!, y: y!, width: width!, height: height! }),
  };
}

function dump(body: FakeElement) {
  // The page globals geometry.js reads: no element here is SVG or clips its text
  const page = { document: { body }, SVGElement: class {}, getComputedStyle: () => ({}) };
  return JSON.parse(vm.runInNewContext(SOURCE, page));
}

test("a data-parity-skip wrapper is recorded as its first child, with its own box", () => {
  // ChampionIcon: a 32 px clipping span around the art drawn 1/0.88 larger
  const art = el("IMG", [7.82, 17.82, 36.36, 36.36]);
  const body = el(
    "BODY",
    [0, 0, 1280, 800],
    [el("DIV", [0, 0, 100, 100], [el("SPAN", [10, 20, 32, 32], [art], ["data-parity-skip"])])],
  );
  expect(dump(body)).toEqual([
    ["b", "BODY", 0, 0, 1280, 800],
    ["b/0", "DIV", 0, 0, 100, 100],
    ["b/0/0", "IMG", 10, 20, 32, 32],
  ]);
});

test("an unmarked wrapper is recorded as itself, with its children", () => {
  const body = el(
    "BODY",
    [0, 0, 1280, 800],
    [el("SPAN", [10, 20, 32, 32], [el("IMG", [7.82, 17.82, 36.36, 36.36])])],
  );
  expect(dump(body)).toEqual([
    ["b", "BODY", 0, 0, 1280, 800],
    ["b/0", "SPAN", 10, 20, 32, 32],
    ["b/0/0", "IMG", 7.82, 17.82, 36.36, 36.36],
  ]);
});
