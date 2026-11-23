import { beforeAll, describe, expect, test } from "bun:test";
import * as lib from "./trends";
type SeriesPoint = lib.SeriesPoint;

function days(count: number): { day: string; games: number; wins: number }[] {
  const start = new Date(2025, 0, 1);
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    return { day, games: 1, wins: 1 };
  });
}

describe("default granularity", () => {
  test("a 100 day span opens by week", () => {
    const span = lib.spanDaysOf(days(100) as never);
    expect(span).toBe(100);
    expect(lib.defaultGranularity(span)).toBe("week");
  });

  test("a 200 day span opens by month", () => {
    const span = lib.spanDaysOf(days(200) as never);
    expect(span).toBe(200);
    expect(lib.defaultGranularity(span)).toBe("month");
  });

  test("120 days is still weekly and 121 is monthly", () => {
    expect(lib.defaultGranularity(120)).toBe("week");
    expect(lib.defaultGranularity(121)).toBe("month");
  });

  test("no games is weekly", () => {
    expect(lib.defaultGranularity(lib.spanDaysOf([]))).toBe("week");
  });
});

describe("buckets", () => {
  test("an idle stretch between two played months stays a zero bucket", () => {
    const rows = [
      { day: "2025-01-10", games: 2, wins: 1, score_sum: 10, scored_games: 2 },
      { day: "2025-04-03", games: 3, wins: 3, score_sum: null, scored_games: 0 },
    ] as never;
    const months = lib.buildBuckets(rows, "month");
    expect(months.map((b) => b.games)).toEqual([2, 0, 0, 3]);
    expect(months[0].scoreSum).toBe(10);
  });
});

// The expected strings were computed from the React component's own geometry
// code on this data, run outside React
describe("time series geometry", () => {
  const values: [number, number | null][] = [
    [4, 50],
    [10, 62.5],
    [0, null],
    [0, null],
    [3, 33.333333333333336],
    [7, 71.42857142857143],
    [0, null],
    [0, null],
    [0, null],
    [2, 100],
  ];
  const points: SeriesPoint[] = values.map(([games, value]) => ({
    label: "",
    games,
    value,
    detail: "",
  }));
  let layout: lib.SeriesLayout;
  beforeAll(() => {
    layout = lib.layoutSeries(points, 640, 250, 20, 100, 46);
  });

  test("line vertices match", () => {
    expect(layout.segments.map(lib.linePoints)).toEqual([
      "69.8,108.75 129.4,84.0625",
      "308.2,141.66666666666666 367.8,66.42857142857142",
      "606.2,10",
    ]);
  });

  test("area polygons match", () => {
    expect(layout.segments.map((s) => lib.areaPoints(s, layout.baseline))).toEqual([
      "69.8,108.75 129.4,84.0625 129.4,168 69.8,168",
      "308.2,141.66666666666666 367.8,66.42857142857142 367.8,168 308.2,168",
      "606.2,10 606.2,168 606.2,168",
    ]);
  });

  test("a two bucket gap is bridged and a longer one is shaded", () => {
    expect(layout.gaps.map((g) => [g.bridged, g.played])).toEqual([
      [true, false],
      [false, false],
    ]);
  });
});

describe("win rate axis", () => {
  test("keeps the 50% line on a tick and fits the data", () => {
    const pts = [lib.clockPoint("a", "a", 10, 6), lib.clockPoint("b", "b", 10, 7)];
    const axis = lib.winRateAxis(pts, 10);
    expect(axis.ticks).toEqual([50, 60, 70, 80]);
  });

  test("a bucket under three games plots no point", () => {
    expect(lib.clockPoint("a", "a", 2, 2).value).toBeNull();
  });
});
