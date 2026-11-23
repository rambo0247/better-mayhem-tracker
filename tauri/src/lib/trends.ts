import { dayKey, daysIntoWeek } from "../shared/session";
import type { TrendsDay } from "./types";
import { LOCALE, WEEK_START } from "./format";

// ---- Time helpers ----

// Day strings are local-time YYYY-MM-DD from SQLite; construct the Date from
// parts so it stays the local day instead of shifting through UTC.
export function parseDay(day: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d);
}

// A bucket's games and how they went, for chart tooltips
export function recordDetail(games: number, wins: number): string {
  return `${games.toLocaleString(LOCALE)} games · ${wins.toLocaleString(LOCALE)}W–${(games - wins).toLocaleString(LOCALE)}L`;
}

// ---- Bucketing ----
//
// The main process hands over one row per played day; everything time-based on
// this page is derived from those rows here, so switching granularity never
// refetches.

export type Granularity = "month" | "week";

export interface Bucket {
  label: string;
  games: number;
  wins: number;
  scoreSum: number;
  scoredGames: number;
}

// Buckets are generated for every period between the first and last game, not
// just the played ones — a three-month break should read as a gap in the
// chart, not silently splice together.
export function buildBuckets(daily: TrendsDay[], granularity: Granularity): Bucket[] {
  if (daily.length === 0) return [];
  const buckets = new Map<string, Bucket>();

  const monthLabel = (d: Date) =>
    `${d.toLocaleDateString(LOCALE, { month: "short" })} '${String(d.getFullYear() % 100).padStart(2, "0")}`;
  const weekLabel = (d: Date) => d.toLocaleDateString(LOCALE, { month: "short", day: "numeric" });

  const first = parseDay(daily[0].day);
  const last = parseDay(daily[daily.length - 1].day);

  if (granularity === "month") {
    const cursor = new Date(first.getFullYear(), first.getMonth(), 1);
    while (cursor <= last) {
      const key = dayKey(cursor).slice(0, 7);
      buckets.set(key, {
        label: monthLabel(cursor),
        games: 0,
        wins: 0,
        scoreSum: 0,
        scoredGames: 0,
      });
      cursor.setMonth(cursor.getMonth() + 1);
    }
  } else {
    // Weeks keyed by the day that opens them
    const cursor = new Date(first);
    cursor.setDate(cursor.getDate() - daysIntoWeek(cursor.getDay(), WEEK_START));
    while (cursor <= last) {
      buckets.set(dayKey(cursor), {
        label: weekLabel(cursor),
        games: 0,
        wins: 0,
        scoreSum: 0,
        scoredGames: 0,
      });
      cursor.setDate(cursor.getDate() + 7);
    }
  }

  for (const row of daily) {
    let key: string;
    if (granularity === "month") {
      key = row.day.slice(0, 7);
    } else {
      const d = parseDay(row.day);
      d.setDate(d.getDate() - daysIntoWeek(d.getDay(), WEEK_START));
      key = dayKey(d);
    }
    const b = buckets.get(key);
    if (!b) continue;
    b.games += row.games;
    b.wins += row.wins;
    b.scoreSum += row.score_sum ?? 0;
    b.scoredGames += row.scored_games;
  }

  return [...buckets.values()];
}

// The days the games cover, first to last inclusive
export function spanDaysOf(daily: TrendsDay[]): number {
  if (daily.length === 0) return 0;
  const first = parseDay(daily[0].day);
  const last = parseDay(daily[daily.length - 1].day);
  return Math.round((last.getTime() - first.getTime()) / 86_400_000) + 1;
}

// Weekly buckets by default for short histories, monthly once months exist
// to compare
export function defaultGranularity(spanDays: number): Granularity {
  return spanDays > 120 ? "month" : "week";
}

// ---- Time series geometry ----

export interface SeriesPoint {
  label: string;
  // Tooltip title when the axis label is abbreviated ("Mon" → "Monday")
  long?: string;
  games: number;
  value: number | null;
  detail: string;
}

export type Vertex = [number, number, number];

export interface SeriesLayout {
  M: { top: number; right: number; bottom: number; left: number };
  volumeHeight: number;
  plotHeight: number;
  ih: number;
  step: number;
  maxGames: number;
  barWidth: number;
  labelEvery: number;
  baseline: number;
  volumeBase: number;
  x: (i: number) => number;
  y: (v: number) => number;
  segments: Vertex[][];
  gaps: { prev: Vertex; next: Vertex; bridged: boolean; played: boolean }[];
}

// A gap of a bucket or two is bridged with a dashed line; a longer one is a
// stretch of its own, shaded and named, since a line across it would read
// as a trend
const MAX_BRIDGED = 2;

export function layoutSeries(
  points: SeriesPoint[],
  width: number,
  height: number,
  yMin: number,
  yMax: number,
  labelSpacing: number,
): SeriesLayout {
  const M = { top: 10, right: 4, bottom: 24, left: 40 };
  // The games bars get a band of their own under the metric's plot, with
  // their own baseline, so they read as volume rather than as low values on
  // the metric's axis
  const volumeHeight = 36;
  const volumeGap = 22;
  const iw = Math.max(width - M.left - M.right, 0);
  const plotHeight = height - M.top - M.bottom;
  const ih = plotHeight - volumeHeight - volumeGap;
  const n = points.length;
  const step = n > 0 ? iw / n : 0;
  const x = (i: number) => M.left + step * (i + 0.5);
  const y = (v: number) => M.top + ih - ((v - yMin) / (yMax - yMin)) * ih;
  const maxGames = Math.max(...points.map((p) => p.games), 1);
  const barWidth = Math.max(Math.min(step * 0.5, 24), 2);
  const labelEvery = Math.max(1, Math.ceil(n / Math.max(Math.floor(iw / labelSpacing), 1)));
  const baseline = M.top + ih;
  const volumeBase = M.top + plotHeight;

  // Null values (empty buckets) break the line into segments instead of
  // interpolating across periods that were never played. Each point keeps
  // its bucket index, to measure the gaps between segments.
  const segments: Vertex[][] = [];
  let current: Vertex[] = [];
  points.forEach((p, i) => {
    if (p.value == null) {
      if (current.length > 0) segments.push(current);
      current = [];
    } else {
      current.push([x(i), y(p.value), i]);
    }
  });
  if (current.length > 0) segments.push(current);

  const gaps = segments.slice(1).map((seg, k) => {
    const prev = segments[k][segments[k].length - 1];
    const next = seg[0];
    const missing = points.slice(prev[2] + 1, next[2]);
    return {
      prev,
      next,
      bridged: missing.length <= MAX_BRIDGED,
      played: missing.some((p) => p.games > 0),
    };
  });

  return {
    M,
    volumeHeight,
    plotHeight,
    ih,
    step,
    maxGames,
    barWidth,
    labelEvery,
    baseline,
    volumeBase,
    x,
    y,
    segments,
    gaps,
  };
}

export function linePoints(seg: Vertex[]): string {
  return seg.map(([px, py]) => `${px},${py}`).join(" ");
}

export function areaPoints(seg: Vertex[], baseline: number): string {
  return [
    ...seg.map(([px, py]) => `${px},${py}`),
    `${seg[seg.length - 1][0]},${baseline}`,
    `${seg[0][0]},${baseline}`,
  ].join(" ");
}

const MIN_PLOTTED_GAMES = 3;

// getDay() numbers in the order the regional week runs
export const WEEKDAY_ORDER = Array.from({ length: 7 }, (_, i) => (WEEK_START + i) % 7);

export function clockPoint(label: string, long: string, games: number, wins: number): SeriesPoint {
  return {
    label,
    long,
    games,
    value: games >= MIN_PLOTTED_GAMES ? (wins / games) * 100 : null,
    detail: games > 0 ? recordDetail(games, wins) : "No games",
  };
}

// The axis a win rate chart is drawn on, fitted to the data in steps of ten, so
// a line that moves between 45% and 70% isn't squashed into a sliver of a
// 0–100 plot. The 50% reference always stays on the axis.
export function winRateAxis(points: SeriesPoint[], tickStep: number) {
  const values = points.map((p) => p.value).filter((v): v is number => v != null);
  let lo = 0;
  let hi = 100;
  if (values.length > 0) {
    // Ticks counted out from 50 in both directions, so the reference line
    // always lands on one
    const below = Math.max(0, 50 - (Math.min(...values) - 5));
    const above = Math.max(0, Math.max(...values) + 5 - 50);
    lo = Math.max(0, 50 - Math.ceil(below / tickStep) * tickStep);
    hi = Math.min(100, 50 + Math.ceil(above / tickStep) * tickStep);
  }
  const ticks: number[] = [];
  for (let t = lo; t <= hi; t += tickStep) ticks.push(t);
  return { lo, hi, ticks };
}
