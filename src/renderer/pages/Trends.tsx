import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useIpc } from "../hooks/useIpc";
import { useViewState } from "../hooks/useViewState";
import type { TrendsData, TrendsDay } from "../lib/types";
import {
  LOCALE,
  WEEK_START,
  formatDecimal,
  formatHour,
  formatPatch,
  formatPercent,
  formatWeekday,
} from "../lib/format";
import QueueSelect from "../components/QueueSelect";
import ActivityCalendar from "../components/ActivityCalendar";
import PageHeader from "../components/PageHeader";
import { TrendingUpIcon } from "../components/icons";
import { dayKey, daysIntoWeek } from "../../shared/session";

// ---- Time helpers ----

// Day strings are local-time YYYY-MM-DD from SQLite; construct the Date from
// parts so it stays the local day instead of shifting through UTC.
function parseDay(day: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d);
}

// A bucket's games and how they went, for chart tooltips
function recordDetail(games: number, wins: number): string {
  return `${games.toLocaleString(LOCALE)} games · ${wins.toLocaleString(LOCALE)}W–${(games - wins).toLocaleString(LOCALE)}L`;
}

// ---- Bucketing ----
//
// The main process hands over one row per played day; everything time-based on
// this page is derived from those rows here, so switching granularity never
// refetches.

type Granularity = "month" | "week";

interface Bucket {
  label: string;
  games: number;
  wins: number;
  scoreSum: number;
  scoredGames: number;
}

// Buckets are generated for every period between the first and last game, not
// just the played ones — a three-month break should read as a gap in the
// chart, not silently splice together.
function buildBuckets(daily: TrendsDay[], granularity: Granularity): Bucket[] {
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

// ---- Shared chart bits ----

function useContainerWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => setWidth(entries[0].contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}

// A chart panel: the title strip with its legend or controls on the right,
// then the chart. Every chart on the page sits in one of these.
function Card({
  title,
  right,
  className = "",
  children,
}: {
  title: string;
  right?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={`panel flex flex-col ${className}`}>
      <div className="panel-head justify-between">
        <h2 className="section-title">{title}</h2>
        {right}
      </div>
      <div className="flex-1 px-4 pt-4 pb-3">{children}</div>
    </section>
  );
}

// The chart palette, one meaning per hue across every chart on the page
const C = {
  win: "var(--color-lol-win)",
  loss: "var(--color-lol-loss)",
  accent: "var(--color-lol-gold)",
  secondary: "var(--color-sky-400)",
  grid: "rgb(255 255 255 / 0.055)",
  axis: "var(--color-lol-text)",
} as const;

// Axis text in the condensed display face, as every other label in the app
const AXIS_TEXT = {
  fontFamily: "var(--font-display)",
  fontSize: 12,
  fontWeight: 700,
  letterSpacing: "0.06em",
  fill: C.axis,
} as const;

// Swatches naming what each mark in a chart stands for
function Legend({ items }: { items: { label: string; swatch: React.ReactNode }[] }) {
  return (
    <div className="flex items-center gap-4">
      {items.map(({ label, swatch }) => (
        <span key={label} className="label flex items-center gap-1.5">
          {swatch}
          {label}
        </span>
      ))}
    </div>
  );
}

const lineSwatch = (color: string) => (
  <span className="h-[3px] w-3.5 rounded-full" style={{ background: color }} />
);
const barSwatch = (color: string, opacity = 1) => (
  <span className="h-2.5 w-2.5 rounded-[2px]" style={{ background: color, opacity }} />
);
const dotSwatch = (color: string) => (
  <span className="h-2 w-2 rounded-full" style={{ background: color }} />
);
// Diagonal stripes, the mark for a bar standing on too few games to trust
const hatchSwatch = (color: string) => (
  <span
    className="h-2.5 w-2.5 rounded-[2px] opacity-70"
    style={{
      background: `repeating-linear-gradient(135deg, ${color} 0 1.5px, transparent 1.5px 3.5px)`,
    }}
  />
);

// Floating hover readout shared by every chart on the page: a bright label
// line, muted detail line(s), and the headline value in gold. Positioned at a
// chart-space x inside a relative parent, clamped so it never clips.
function HoverTooltip({
  x,
  width,
  label,
  detail,
  value,
}: {
  x: number;
  width: number;
  label: string;
  detail: React.ReactNode;
  value?: string | null;
}) {
  return (
    <div
      className="menu pointer-events-none absolute top-1 z-10 whitespace-nowrap px-3 py-2 text-[12px]"
      style={{
        left: Math.min(Math.max(x, 80), Math.max(width - 80, 80)),
        transform: "translateX(-50%)",
      }}
    >
      <div className="font-display text-[13px] font-bold uppercase tracking-[0.06em] text-lol-text-bright">
        {label}
      </div>
      <div className="text-lol-text">{detail}</div>
      {value != null && (
        <div className="font-num mt-0.5 text-[18px] font-semibold leading-tight text-lol-gold">
          {value}
        </div>
      )}
    </div>
  );
}

// ---- Time series chart ----
//
// Faint bars carry the sample size (games per bucket) on their own hidden
// scale; the line carries the metric. Win rate over five games and fifty look
// identical on a bare line — the bars are what keep the chart honest.

interface SeriesPoint {
  label: string;
  // Tooltip title when the axis label is abbreviated ("Mon" → "Monday")
  long?: string;
  games: number;
  value: number | null;
  detail: string;
}

function TimeSeriesChart({
  points,
  yMin,
  yMax,
  ticks,
  refValue,
  format,
  height = 250,
  labelSpacing = 46,
}: {
  points: SeriesPoint[];
  yMin: number;
  yMax: number;
  ticks: number[];
  // A reference level drawn dashed; points above it read as wins, below as losses
  refValue?: number;
  format: (v: number) => string;
  height?: number;
  // The room an axis label needs, so short labels can sit under every point
  labelSpacing?: number;
}) {
  const { ref, width } = useContainerWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const fadeId = useId();

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
  const segments: [number, number, number][][] = [];
  let current: [number, number, number][] = [];
  points.forEach((p, i) => {
    if (p.value == null) {
      if (current.length > 0) segments.push(current);
      current = [];
    } else {
      current.push([x(i), y(p.value), i]);
    }
  });
  if (current.length > 0) segments.push(current);

  // A gap of a bucket or two is bridged with a dashed line; a longer one is a
  // stretch of its own, shaded and named, since a line across it would read
  // as a trend
  const MAX_BRIDGED = 2;
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

  const pointColor = (v: number) => (refValue == null ? C.accent : v >= refValue ? C.win : C.loss);

  const handleMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (step === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const i = Math.floor((e.clientX - rect.left - M.left) / step);
    setHover(i >= 0 && i < n ? i : null);
  };

  const hovered = hover != null ? points[hover] : null;

  return (
    <div ref={ref} className="relative">
      {width > 0 && (
        <svg
          width={width}
          height={height}
          className="block"
          onMouseMove={handleMove}
          onMouseLeave={() => setHover(null)}
        >
          <defs>
            <linearGradient id={fadeId} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={C.accent} stopOpacity={0.13} />
              <stop offset="100%" stopColor={C.accent} stopOpacity={0} />
            </linearGradient>
          </defs>
          {gaps
            .filter((g) => !g.bridged)
            .map((g) => {
              const x1 = x(g.prev[2] + 1) - step / 2;
              const x2 = x(g.next[2] - 1) + step / 2;
              return (
                <g key={g.prev[2]}>
                  <rect
                    x={x1}
                    y={M.top}
                    width={x2 - x1}
                    height={ih}
                    fill="white"
                    fillOpacity={0.018}
                  />
                  <text
                    x={(x1 + x2) / 2}
                    y={M.top + 16}
                    textAnchor="middle"
                    {...AXIS_TEXT}
                    fillOpacity={0.7}
                  >
                    {g.played ? "TOO FEW GAMES" : "NO GAMES"}
                  </text>
                </g>
              );
            })}
          {ticks.map((t) => (
            <g key={t}>
              <line x1={M.left} x2={width - M.right} y1={y(t)} y2={y(t)} stroke={C.grid} />
              <text x={M.left - 8} y={y(t) + 4} textAnchor="end" {...AXIS_TEXT}>
                {format(t)}
              </text>
            </g>
          ))}
          {hover != null && (
            <rect
              x={x(hover) - step / 2}
              y={M.top}
              width={step}
              height={plotHeight}
              fill="white"
              fillOpacity={0.035}
            />
          )}
          <line
            x1={M.left}
            x2={width - M.right}
            y1={volumeBase + 0.5}
            y2={volumeBase + 0.5}
            stroke={C.grid}
          />
          <text
            x={M.left - 8}
            y={volumeBase - volumeHeight + 8}
            textAnchor="end"
            {...AXIS_TEXT}
            fillOpacity={0.7}
          >
            {maxGames.toLocaleString(LOCALE)}
          </text>
          {/* Names the strip, so its lone top value reads as a game count */}
          <text x={M.left - 8} y={volumeBase} textAnchor="end" {...AXIS_TEXT} fillOpacity={0.55}>
            GAMES
          </text>
          {points.map((p, i) =>
            p.games > 0 ? (
              <rect
                key={i}
                x={x(i) - barWidth / 2}
                y={volumeBase - Math.max((p.games / maxGames) * volumeHeight, 2)}
                width={barWidth}
                height={Math.max((p.games / maxGames) * volumeHeight, 2)}
                rx={1.5}
                fill={C.secondary}
                fillOpacity={hover === i ? 0.4 : 0.22}
              />
            ) : null,
          )}
          {refValue != null && (
            <line
              x1={M.left}
              x2={width - M.right}
              y1={y(refValue)}
              y2={y(refValue)}
              stroke="var(--color-lol-text-bright)"
              strokeOpacity={0.28}
              strokeDasharray="3 4"
            />
          )}
          {segments.map((seg, i) =>
            seg.length > 1 ? (
              <polygon
                key={i}
                points={[
                  ...seg.map(([px, py]) => `${px},${py}`),
                  `${seg[seg.length - 1][0]},${baseline}`,
                  `${seg[0][0]},${baseline}`,
                ].join(" ")}
                fill={`url(#${CSS.escape(fadeId)})`}
              />
            ) : null,
          )}
          {/* Periods with no games between two that had some: a dashed bridge,
              so the line reads as interrupted rather than as stray dots */}
          {gaps
            .filter((g) => g.bridged)
            .map(({ prev: [x1, y1, i], next: [x2, y2] }) => (
              <line
                key={i}
                x1={x1}
                y1={y1}
                x2={x2}
                y2={y2}
                stroke={C.accent}
                strokeOpacity={0.5}
                strokeWidth={1.5}
                strokeDasharray="2 5"
                strokeLinecap="round"
              />
            ))}
          {segments.map((seg, i) => (
            <polyline
              key={i}
              points={seg.map(([px, py]) => `${px},${py}`).join(" ")}
              fill="none"
              stroke={C.accent}
              strokeWidth={2.25}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ))}
          {points.map((p, i) =>
            p.value != null ? (
              <circle
                key={i}
                cx={x(i)}
                cy={y(p.value)}
                r={hover === i ? 5 : 3.5}
                fill={pointColor(p.value)}
                stroke="var(--color-lol-card)"
                strokeWidth={2}
              />
            ) : null,
          )}
          {points.map((p, i) =>
            i % labelEvery === 0 ? (
              <text
                key={i}
                x={x(i)}
                y={height - 6}
                textAnchor="middle"
                {...AXIS_TEXT}
                fill={hover === i ? "var(--color-lol-text-bright)" : C.axis}
              >
                {p.label}
              </text>
            ) : null,
          )}
        </svg>
      )}
      {hovered && hover != null && (
        <HoverTooltip
          x={x(hover)}
          width={width}
          label={hovered.long ?? hovered.label}
          detail={hovered.detail}
          value={hovered.value != null ? format(hovered.value) : null}
        />
      )}
    </div>
  );
}

// ---- Activity heatmap ----

// The trailing 52 full weeks plus the current partial one. The cells stretch
// to the panel's width; the size is only the calendar's floor.
const HEATMAP_WEEKS = 53;
const HEATMAP_CELL = 11;

function ActivityHeatmap({ daily }: { daily: TrendsDay[] }) {
  const days = useMemo(() => new Map(daily.map((d) => [parseDay(d.day).getTime(), d])), [daily]);

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const first = new Date(today);
  first.setDate(
    first.getDate() - daysIntoWeek(first.getDay(), WEEK_START) - (HEATMAP_WEEKS - 1) * 7,
  );

  return (
    <ActivityCalendar
      days={days}
      first={first.getTime()}
      last={today.getTime()}
      cell={HEATMAP_CELL}
      fill
    />
  );
}

// ---- Patch bars ----

// Win rate reads the same binary way everywhere in the app: mint at 50% and
// over, coral under
const PATCH_TIERS = [
  { min: 50, color: C.win },
  { min: -Infinity, color: C.loss },
];

// A patch with fewer games than this gets a hatched, dimmed bar: two games at
// 100% shouldn't tower over a hundred at 55%
const MIN_PATCH_GAMES = 5;

function patchTier(rate: number): number {
  return PATCH_TIERS.findIndex((t) => rate >= t.min);
}

const PATCH_LEGEND = [
  { label: "50%+", swatch: barSwatch(C.win) },
  { label: "Under 50%", swatch: barSwatch(C.loss) },
  {
    label: `Under ${MIN_PATCH_GAMES} games`,
    swatch: hatchSwatch("var(--color-lol-text)"),
  },
];

function PatchBars({ patches }: { patches: TrendsData["patches"] }) {
  const { ref, width } = useContainerWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const gradientId = useId();
  // Which sides have bars scrolled out of view, for the edge fades
  const [clipped, setClipped] = useState({ left: false, right: false });
  // The chart opens scrolled to the newest patch and stays there through
  // resizes and refetches until the user scrolls back. A different set of
  // patches (a queue switch, a new patch) returns it to the newest.
  const pinned = useRef(true);
  const patchKey = patches.map((p) => p.patch).join();
  // Bars spread out to fill the panel when they fit, and scroll at their
  // narrowest pitch when they don't
  const minPitch = 56;
  const pad = 8;
  const chartWidth = Math.max(width, patches.length * minPitch + pad * 2);
  const barPitch = patches.length > 0 ? (chartWidth - pad * 2) / patches.length : minPitch;
  const barWidth = Math.min(barPitch * 0.56, 40);
  const top = 22;
  const plotHeight = 130;
  const height = top + plotHeight + 40;
  const y = (rate: number) => top + plotHeight - (rate / 100) * plotHeight;
  const barX = (i: number) => i * barPitch + barPitch / 2 + pad;

  const updateClipped = (el: HTMLDivElement) => {
    const left = el.scrollLeft >= 1;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setClipped((c) => (c.left === left && c.right === right ? c : { left, right }));
  };

  useLayoutEffect(() => {
    pinned.current = true;
  }, [patchKey]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (pinned.current) el.scrollLeft = el.scrollWidth;
    updateClipped(el);
  }, [ref, width, chartWidth, patchKey]);

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    pinned.current = el.scrollLeft + el.clientWidth >= el.scrollWidth - 1;
    updateClipped(el);
  };

  const handleMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const i = Math.floor((e.clientX - rect.left - pad) / barPitch);
    setHover(i >= 0 && i < patches.length ? i : null);
  };

  const hovered = hover != null ? patches[hover] : null;

  return (
    // The fades sit outside the scroller so they stay put at its edges
    <div className="relative">
      <div ref={ref} className="overflow-x-auto" onScroll={handleScroll}>
        {width > 0 && (
          // The tooltip anchors inside the scrollable content, so it tracks its
          // bar when the chart is wider than the card and scrolled
          <div className="relative" style={{ width: chartWidth }}>
            <svg
              width={chartWidth}
              height={height}
              className="block"
              onMouseMove={handleMove}
              onMouseLeave={() => setHover(null)}
            >
              <defs>
                {/* Each tier's bar fades from its colour at the value down to the
                    baseline, so the tops carry the reading */}
                {PATCH_TIERS.map((t, i) => (
                  <linearGradient key={i} id={`${gradientId}-${i}`} x1="0" x2="0" y1="0" y2="1">
                    <stop offset="0%" stopColor={t.color} stopOpacity={0.62} />
                    <stop offset="100%" stopColor={t.color} stopOpacity={0.14} />
                  </linearGradient>
                ))}
                <pattern
                  id={`${gradientId}-ghost`}
                  width={6}
                  height={6}
                  patternUnits="userSpaceOnUse"
                  patternTransform="rotate(45)"
                >
                  <rect width={2} height={6} fill={C.axis} fillOpacity={0.45} />
                </pattern>
              </defs>
              {[0, 25, 75, 100].map((t) => (
                <line key={t} x1={0} x2={chartWidth} y1={y(t)} y2={y(t)} stroke={C.grid} />
              ))}
              {patches.map((p, i) => {
                const rate = p.games > 0 ? (p.wins / p.games) * 100 : 0;
                const cx = barX(i);
                const thin = p.games < MIN_PATCH_GAMES;
                const tier = patchTier(rate);
                const color = PATCH_TIERS[tier].color;
                // Too few games to read: a short colourless stub, so its rate is on
                // record without the bar towering over the patches that count
                const barHeight = thin ? 12 : Math.max(top + plotHeight - y(rate), 2);
                return (
                  <g key={p.patch}>
                    {hover === i && (
                      <rect
                        x={cx - barPitch / 2}
                        y={top - 16}
                        width={barPitch}
                        height={plotHeight + 16}
                        fill="white"
                        fillOpacity={0.035}
                      />
                    )}
                    <rect
                      x={cx - barWidth / 2}
                      y={top + plotHeight - barHeight}
                      width={barWidth}
                      height={barHeight}
                      rx={2}
                      fill={`url(#${CSS.escape(`${gradientId}-${thin ? "ghost" : tier}`)})`}
                      opacity={hover === i ? 1 : 0.85}
                    />
                    {/* A bright cap on the bar's top edge, the broadcast-graphic way of
                        marking the value */}
                    <rect
                      x={cx - barWidth / 2}
                      y={top + plotHeight - barHeight}
                      width={barWidth}
                      height={Math.min(3, barHeight)}
                      rx={1}
                      fill={thin ? C.axis : color}
                      fillOpacity={thin ? 0.5 : 1}
                    />
                    <text
                      x={cx}
                      y={top + plotHeight - barHeight - 7}
                      textAnchor="middle"
                      {...AXIS_TEXT}
                      fontSize={thin ? 12 : 14}
                      fontWeight={700}
                      fill={thin ? C.axis : color}
                    >
                      {/* A stub's record, not a rate: "2–0" reads as the tiny
                          sample it is, where "100%" reads as a missing bar */}
                      {thin ? `${p.wins}–${p.games - p.wins}` : formatPercent(rate / 100, 0)}
                    </text>
                    <text
                      x={cx}
                      y={top + plotHeight + 18}
                      textAnchor="middle"
                      {...AXIS_TEXT}
                      fontSize={13}
                      fontWeight={700}
                      fill="var(--color-lol-text-bright)"
                    >
                      {formatPatch(p.patch)}
                    </text>
                    <text
                      x={cx}
                      y={top + plotHeight + 33}
                      textAnchor="middle"
                      {...AXIS_TEXT}
                      fontSize={12}
                      fontWeight={600}
                    >
                      {p.games.toLocaleString(LOCALE)} games
                    </text>
                  </g>
                );
              })}
              <line
                x1={0}
                x2={chartWidth}
                y1={y(50)}
                y2={y(50)}
                stroke="var(--color-lol-text-bright)"
                strokeOpacity={0.28}
                strokeDasharray="3 4"
              />
            </svg>
            {hovered && hover != null && (
              <HoverTooltip
                x={barX(hover)}
                width={chartWidth}
                label={`Patch ${formatPatch(hovered.patch)}`}
                detail={
                  <>
                    <div>{recordDetail(hovered.games, hovered.wins)}</div>
                    {hovered.avg_score != null && (
                      <div>avg score {formatDecimal(hovered.avg_score)}</div>
                    )}
                  </>
                }
                value={hovered.games > 0 ? formatPercent(hovered.wins / hovered.games, 0) : null}
              />
            )}
          </div>
        )}
      </div>
      <div
        className={`absolute top-0 left-0 w-10 pointer-events-none bg-gradient-to-r from-lol-card to-transparent transition-opacity ${
          clipped.left ? "opacity-100" : "opacity-0"
        }`}
        style={{ height }}
      />
      <div
        className={`absolute top-0 right-0 w-10 pointer-events-none bg-gradient-to-l from-lol-card to-transparent transition-opacity ${
          clipped.right ? "opacity-100" : "opacity-0"
        }`}
        style={{ height }}
      />
    </div>
  );
}

// ---- When-you-play breakdowns ----
//
// Same grammar as the charts above: faint bars for how much was played, gold
// line for how well it went. A line point needs a minimal sample — one game at
// 4 AM plotting as 0% or 100% would be pure noise — but the bar and tooltip
// still show for any bucket that was played at all.

const MIN_PLOTTED_GAMES = 3;

// getDay() numbers in the order the regional week runs
const WEEKDAY_ORDER = Array.from({ length: 7 }, (_, i) => (WEEK_START + i) % 7);

function clockPoint(label: string, long: string, games: number, wins: number): SeriesPoint {
  return {
    label,
    long,
    games,
    value: games >= MIN_PLOTTED_GAMES ? (wins / games) * 100 : null,
    detail: games > 0 ? recordDetail(games, wins) : "No games",
  };
}

// Win rate on an axis fitted to the data, in steps of ten, so a line that
// moves between 45% and 70% isn't squashed into a sliver of a 0–100 plot. The
// 50% reference always stays on the axis.
function WinRateChart({
  points,
  labelSpacing,
  tickStep = 10,
}: {
  points: SeriesPoint[];
  labelSpacing?: number;
  // Wider steps for a short plot crowded with points
  tickStep?: number;
}) {
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
  return (
    <TimeSeriesChart
      points={points}
      yMin={lo}
      yMax={hi}
      ticks={ticks}
      refValue={50}
      format={(v) => formatPercent(v / 100, 0)}
      labelSpacing={labelSpacing}
    />
  );
}

function WeekdayChart({ weekdays }: { weekdays: TrendsData["weekdays"] }) {
  const byDay = new Map(weekdays.map((w) => [w.weekday, w]));
  const points = WEEKDAY_ORDER.map((dow) =>
    clockPoint(
      formatWeekday(dow, "short"),
      formatWeekday(dow, "long"),
      byDay.get(dow)?.games ?? 0,
      byDay.get(dow)?.wins ?? 0,
    ),
  );
  return <WinRateChart points={points} />;
}

function HourChart({ hours }: { hours: TrendsData["hours"] }) {
  const byHour = new Map(hours.map((h) => [h.hour, h]));
  const points = Array.from({ length: 24 }, (_, hour) =>
    clockPoint(
      formatHour(hour),
      `${formatHour(hour)} – ${formatHour((hour + 1) % 24)}`,
      byHour.get(hour)?.games ?? 0,
      byHour.get(hour)?.wins ?? 0,
    ),
  );
  return <WinRateChart points={points} labelSpacing={64} tickStep={20} />;
}

// ---- Page ----

export default function Trends() {
  const [queue, setQueue] = useViewState<number | undefined>("trends.queue", undefined);

  const { data, refetch } = useIpc<TrendsData>(() => window.api.getTrends(queue), [queue]);

  useEffect(() => {
    const unsub = window.api.onGamesUpdated(() => refetch());
    return unsub;
  }, [refetch]);

  const spanDays = useMemo(() => {
    if (!data || data.daily.length === 0) return 0;
    const first = parseDay(data.daily[0].day);
    const last = parseDay(data.daily[data.daily.length - 1].day);
    return Math.round((last.getTime() - first.getTime()) / 86_400_000) + 1;
  }, [data]);

  // Weekly buckets by default for short histories, monthly once months exist
  // to compare
  const [granularity, setGranularity] = useViewState<Granularity | undefined>(
    "trends.granularity",
    undefined,
  );
  const effectiveGranularity: Granularity = granularity ?? (spanDays > 120 ? "month" : "week");

  const buckets = useMemo(
    () => (data ? buildBuckets(data.daily, effectiveGranularity) : []),
    [data, effectiveGranularity],
  );

  const winRatePoints = useMemo(
    () =>
      buckets.map((b) => ({
        label: b.label,
        games: b.games,
        value: b.games > 0 ? (b.wins / b.games) * 100 : null,
        detail: b.games > 0 ? recordDetail(b.games, b.wins) : "No games",
      })),
    [buckets],
  );

  const scorePoints = useMemo(
    () =>
      buckets.map((b) => ({
        label: b.label,
        games: b.games,
        value: b.scoredGames > 0 ? b.scoreSum / b.scoredGames : null,
        detail:
          b.scoredGames > 0
            ? `${b.scoredGames.toLocaleString(LOCALE)} scored games`
            : "No scored games",
      })),
    [buckets],
  );

  const scoreDomain = useMemo(() => {
    const values = scorePoints.map((p) => p.value).filter((v): v is number => v != null);
    if (values.length === 0) return null;
    const min = Math.floor(Math.min(...values) - 0.5);
    const max = Math.ceil(Math.max(...values) + 0.5);
    // Whole-number ticks while the range is narrow enough to label every one,
    // quarters of the range past that
    const ticks =
      max - min <= 6
        ? Array.from({ length: max - min + 1 }, (_, i) => min + i)
        : Array.from({ length: 5 }, (_, i) => min + ((max - min) * i) / 4);
    return { min, max, ticks };
  }, [scorePoints]);

  const header = (subtitle?: React.ReactNode) => (
    <PageHeader
      kicker="Analyze"
      title="Trends"
      subtitle={subtitle}
      actions={<QueueSelect value={queue} onChange={setQueue} />}
      className="pb-0"
    />
  );

  if (!data) {
    return <div className="label mt-20 text-center text-[12px]">Loading…</div>;
  }

  if (data.daily.length === 0) {
    return (
      <div className="max-w-[1320px] space-y-6">
        {header()}
        <div className="panel flex flex-col items-center gap-3 px-8 py-14 text-center">
          <TrendingUpIcon className="h-8 w-8 text-lol-gold/60" />
          <div className="max-w-md text-[14px] text-lol-text">
            No games recorded yet — sync your match history to start tracking trends.
          </div>
        </div>
      </div>
    );
  }

  const totalGames = data.daily.reduce((sum, d) => sum + d.games, 0);

  const granularityToggle = (
    <div className="seg">
      {(["month", "week"] as const).map((g) => (
        <button
          key={g}
          onClick={() => setGranularity(g)}
          aria-pressed={effectiveGranularity === g}
          className="seg-item"
        >
          {g === "month" ? "Monthly" : "Weekly"}
        </button>
      ))}
    </div>
  );

  const winRateLegend = (
    <Legend
      items={[
        { label: "Win rate", swatch: lineSwatch(C.accent) },
        { label: "50%+", swatch: dotSwatch(C.win) },
        { label: "Under 50%", swatch: dotSwatch(C.loss) },
        { label: "Games", swatch: barSwatch(C.secondary, 0.45) },
      ]}
    />
  );

  // The span the games actually cover, which is what the count is out of: the
  // calendar above always shows a full year whatever the history holds
  const since = parseDay(data.daily[0].day).toLocaleDateString(LOCALE, {
    month: "short",
    year: "numeric",
  });
  const num = (v: number) => (
    <span className="font-num text-[14px] font-semibold text-lol-text-bright">
      {v.toLocaleString(LOCALE)}
    </span>
  );

  return (
    <div className="max-w-[1320px] space-y-6">
      {header(
        <>
          {num(totalGames)} {totalGames === 1 ? "game" : "games"} across {num(data.daily.length)}{" "}
          {data.daily.length === 1 ? "day" : "days"} played since {since}
        </>,
      )}

      <Card title="Activity" right={<span className="label">Last 12 months</span>}>
        <ActivityHeatmap daily={data.daily} />
      </Card>

      {data.patches.length > 1 && (
        <Card title="Win Rate by Patch" right={<Legend items={PATCH_LEGEND} />}>
          <PatchBars patches={data.patches} />
        </Card>
      )}

      {/* The bucket size drives both charts below it, so its switch heads the
          pair rather than either one panel */}
      <section>
        <SectionHead title="Over time">{granularityToggle}</SectionHead>
        {/* Side by side once each chart still gets a full-size plot of its own */}
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <Card title="Win Rate" right={winRateLegend}>
            <WinRateChart points={winRatePoints} />
          </Card>

          {scoreDomain && (
            <Card
              title="Average Score"
              right={
                <Legend
                  items={[
                    { label: "Avg score", swatch: lineSwatch(C.accent) },
                    { label: "Games", swatch: barSwatch(C.secondary, 0.45) },
                  ]}
                />
              }
            >
              <TimeSeriesChart
                points={scorePoints}
                yMin={scoreDomain.min}
                yMax={scoreDomain.max}
                ticks={scoreDomain.ticks}
                format={(v) => formatDecimal(v)}
              />
            </Card>
          )}
        </div>
      </section>

      <section>
        <SectionHead title="When you play" />
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <Card title="By Day of Week" right={winRateLegend}>
            <WeekdayChart weekdays={data.weekdays} />
          </Card>
          <Card title="By Hour of Day" right={winRateLegend}>
            <HourChart hours={data.hours} />
          </Card>
        </div>
      </section>
    </div>
  );
}

// A group's title with a hairline running out to its controls, as Match
// History heads its days
function SectionHead({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="mb-3 flex items-center gap-3">
      <h2 className="section-title italic">{title}</h2>
      <span className="h-px flex-1 bg-lol-line" />
      {children}
    </div>
  );
}
