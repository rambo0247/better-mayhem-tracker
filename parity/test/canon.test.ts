import { describe, expect, test } from "bun:test";
import { CLOCK_MARK, canonEqual, canonicalize } from "../canon.ts";

describe("canonicalize", () => {
  test("key order does not matter at any depth", () => {
    const a = { b: 1, a: { y: [1, { q: 1, p: 2 }], x: null } };
    const b = { a: { x: null, y: [1, { p: 2, q: 1 }] }, b: 1 };
    expect(canonicalize(a)).toBe(canonicalize(b));
  });

  test("0.1 + 0.2 keeps its JavaScript digits", () => {
    expect(canonicalize({ n: 0.1 + 0.2 })).toBe('{"n":0.30000000000000004}');
    expect(canonEqual({ n: 0.1 + 0.2 }, { n: 0.3 })).toBe(false);
  });

  test("3 and 3.0 are the same number", () => {
    expect(canonEqual(JSON.parse('{"n":3.0}'), { n: 3 })).toBe(true);
  });

  test("a listed clock field is masked and an unlisted one is not", () => {
    const clockFields = new Set(["lastSeen"]);
    const a = { lastSeen: 1, games: 4 };
    const b = { lastSeen: 2, games: 4 };
    expect(canonicalize(a, { clockFields })).toBe(`{"games":4,"lastSeen":"${CLOCK_MARK}"}`);
    expect(canonEqual(a, b, { clockFields })).toBe(true);
    expect(canonEqual({ games: 4 }, { games: 5 }, { clockFields })).toBe(false);
  });

  test("a clock field nested in an array is masked", () => {
    const clockFields = new Set(["at"]);
    expect(canonEqual([{ at: 1 }], [{ at: 2 }], { clockFields })).toBe(true);
  });

  test("a void result equals null", () => {
    expect(canonEqual(undefined, null)).toBe(true);
  });
});
