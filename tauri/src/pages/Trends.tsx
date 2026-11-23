import {
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  For,
  onSettled,
  Show,
} from "solid-js";
import type { JSX } from "@solidjs/web";
import { daysIntoWeek } from "@shared/session";
import { api } from "../lib/api-shim";
import { reportFirstContent } from "../lib/perf";
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
import {
  areaPoints,
  buildBuckets,
  clockPoint,
  defaultGranularity,
  layoutSeries,
  linePoints,
  parseDay,
  recordDetail,
  spanDaysOf,
  winRateAxis,
  WEEKDAY_ORDER,
  type Granularity,
  type SeriesPoint,
} from "../lib/trends";
import QueueSelect from "../components/QueueSelect";
import ActivityCalendar from "../components/ActivityCalendar";
import PageHeader from "../components/PageHeader";
import { TrendingUpIcon } from "../components/icons";

// ---- Shared chart bits ----

// The width its element is laid out at, which the SVG charts size themselves to
function createContainerWidth() {
  const [width, setWidth] = createSignal(0);
  let el: HTMLElement | undefined;
  onSettled(() => {
    if (!el) return;
    const observer = new ResizeObserver((entries) => setWidth(entries[0].contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  });
  return {
    width,
    ref: (node: HTMLElement) => {
      el = node;
    },
  };
}

// A chart panel: the title strip with its legend or controls on the right,
// then the chart. Every chart on the page sits in one of these.
function Card(props: {
  title: string;
  right?: JSX.Element;
  class?: string;
  children: JSX.Element;
}) {
  return (
    <section class={["panel flex flex-col", props.class ?? ""]}>
      <div class="panel-head justify-between">
        <h2 class="section-title">{props.title}</h2>
        {props.right}
      </div>
      <div class="flex-1 px-4 pt-4 pb-3">{props.children}</div>
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
  "font-family": "var(--font-display)",
  "font-size": "12",
  "font-weight": "700",
  "letter-spacing": "0.06em",
  fill: C.axis,
} as const;

// Swatches naming what each mark in a chart stands for. They are functions
// because a DOM node can sit in one place only, and a legend is shown by
// several charts.
type Swatch = () => JSX.Element;

function Legend(props: { items: { label: string; swatch: Swatch }[] }) {
  return (
    <div class="flex items-center gap-4">
      <For each={props.items}>
        {(item) => (
          <span class="label flex items-center gap-1.5">
            {item.swatch()}
            {item.label}
          </span>
        )}
      </For>
    </div>
  );
}

const lineSwatch =
  (color: string): Swatch =>
  () => <span class="h-[3px] w-3.5 rounded-full" style={{ background: color }} />;
const barSwatch =
  (color: string, opacity = 1): Swatch =>
  () => <span class="h-2.5 w-2.5 rounded-[2px]" style={{ background: color, opacity }} />;
const dotSwatch =
  (color: string): Swatch =>
  () => <span class="h-2 w-2 rounded-full" style={{ background: color }} />;
// Diagonal stripes, the mark for a bar standing on too few games to trust
const hatchSwatch =
  (color: string): Swatch =>
  () => (
    <span
      class="h-2.5 w-2.5 rounded-[2px] opacity-70"
      style={{
        background: `repeating-linear-gradient(135deg, ${color} 0 1.5px, transparent 1.5px 3.5px)`,
      }}
    />
  );

// Floating hover readout shared by every chart on the page: a bright label
// line, muted detail line(s), and the headline value in gold. Positioned at a
// chart-space x inside a relative parent, clamped so it never clips.
function HoverTooltip(props: {
  x: number;
  width: number;
  label: string;
  detail: JSX.Element;
  value?: string | null;
}) {
  return (
    <div
      class="menu pointer-events-none absolute top-1 z-10 whitespace-nowrap px-3 py-2 text-[12px]"
      style={{
        left: `${Math.min(Math.max(props.x, 80), Math.max(props.width - 80, 80))}px`,
        transform: "translateX(-50%)",
      }}
    >
      <div class="font-display text-[13px] font-bold uppercase tracking-[0.06em] text-lol-text-bright">
        {props.label}
      </div>
      <div class="text-lol-text">{props.detail}</div>
      <Show when={props.value != null}>
        <div class="font-num mt-0.5 text-[18px] font-semibold leading-tight text-lol-gold">
          {props.value}
        </div>
      </Show>
    </div>
  );
}

// ---- Time series chart ----
//
// Faint bars carry the sample size (games per bucket) on their own hidden
// scale; the line carries the metric. Win rate over five games and fifty look
// identical on a bare line — the bars are what keep the chart honest.

function TimeSeriesChart(props: {
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
  const { ref, width } = createContainerWidth();
  const [hover, setHover] = createSignal<number | null>(null);
  const fadeId = createUniqueId();
  const height = () => props.height ?? 250;

  const L = createMemo(() =>
    layoutSeries(props.points, width(), height(), props.yMin, props.yMax, props.labelSpacing ?? 46),
  );

  const pointColor = (v: number) =>
    props.refValue == null ? C.accent : v >= props.refValue ? C.win : C.loss;

  const handleMove = (e: MouseEvent & { currentTarget: SVGSVGElement }) => {
    const { step, M } = L();
    if (step === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const i = Math.floor((e.clientX - rect.left - M.left) / step);
    setHover(i >= 0 && i < props.points.length ? i : null);
  };

  const hovered = () => {
    const i = hover();
    return i != null ? (props.points[i] ?? null) : null;
  };

  return (
    <div ref={ref} class="relative">
      <Show when={width() > 0}>
        <svg
          width={width()}
          height={height()}
          class="block"
          onMouseMove={handleMove}
          onMouseLeave={() => setHover(null)}
        >
          <defs>
            <linearGradient id={fadeId} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stop-color={C.accent} stop-opacity={0.13} />
              <stop offset="100%" stop-color={C.accent} stop-opacity={0} />
            </linearGradient>
          </defs>
          <For each={L().gaps.filter((g) => !g.bridged)}>
            {(g) => {
              const x1 = () => L().x(g.prev[2] + 1) - L().step / 2;
              const x2 = () => L().x(g.next[2] - 1) + L().step / 2;
              return (
                <g>
                  <rect
                    x={x1()}
                    y={L().M.top}
                    width={x2() - x1()}
                    height={L().ih}
                    fill="white"
                    fill-opacity={0.018}
                  />
                  <text
                    x={(x1() + x2()) / 2}
                    y={L().M.top + 16}
                    text-anchor="middle"
                    {...AXIS_TEXT}
                    fill-opacity={0.7}
                  >
                    {g.played ? "TOO FEW GAMES" : "NO GAMES"}
                  </text>
                </g>
              );
            }}
          </For>
          <For each={props.ticks}>
            {(t) => (
              <g>
                <line
                  x1={L().M.left}
                  x2={width() - L().M.right}
                  y1={L().y(t)}
                  y2={L().y(t)}
                  stroke={C.grid}
                />
                <text x={L().M.left - 8} y={L().y(t) + 4} text-anchor="end" {...AXIS_TEXT}>
                  {props.format(t)}
                </text>
              </g>
            )}
          </For>
          <Show when={hover() != null}>
            <rect
              x={L().x(hover() ?? 0) - L().step / 2}
              y={L().M.top}
              width={L().step}
              height={L().plotHeight}
              fill="white"
              fill-opacity={0.035}
            />
          </Show>
          <line
            x1={L().M.left}
            x2={width() - L().M.right}
            y1={L().volumeBase + 0.5}
            y2={L().volumeBase + 0.5}
            stroke={C.grid}
          />
          <text
            x={L().M.left - 8}
            y={L().volumeBase - L().volumeHeight + 8}
            text-anchor="end"
            {...AXIS_TEXT}
            fill-opacity={0.7}
          >
            {L().maxGames.toLocaleString(LOCALE)}
          </text>
          {/* Names the strip, so its lone top value reads as a game count */}
          <text
            x={L().M.left - 8}
            y={L().volumeBase}
            text-anchor="end"
            {...AXIS_TEXT}
            fill-opacity={0.55}
          >
            GAMES
          </text>
          <For each={props.points}>
            {(p, i) => (
              <Show when={p.games > 0}>
                <rect
                  x={L().x(i()) - L().barWidth / 2}
                  y={L().volumeBase - Math.max((p.games / L().maxGames) * L().volumeHeight, 2)}
                  width={L().barWidth}
                  height={Math.max((p.games / L().maxGames) * L().volumeHeight, 2)}
                  rx={1.5}
                  fill={C.secondary}
                  fill-opacity={hover() === i() ? 0.4 : 0.22}
                />
              </Show>
            )}
          </For>
          <Show when={props.refValue != null}>
            <line
              x1={L().M.left}
              x2={width() - L().M.right}
              y1={L().y(props.refValue ?? 0)}
              y2={L().y(props.refValue ?? 0)}
              stroke="var(--color-lol-text-bright)"
              stroke-opacity={0.28}
              stroke-dasharray="3 4"
            />
          </Show>
          <For each={L().segments}>
            {(seg) => (
              <Show when={seg.length > 1}>
                <polygon
                  points={areaPoints(seg, L().baseline)}
                  fill={`url(#${CSS.escape(fadeId)})`}
                />
              </Show>
            )}
          </For>
          {/* Periods with no games between two that had some: a dashed bridge,
              so the line reads as interrupted rather than as stray dots */}
          <For each={L().gaps.filter((g) => g.bridged)}>
            {(g) => (
              <line
                x1={g.prev[0]}
                y1={g.prev[1]}
                x2={g.next[0]}
                y2={g.next[1]}
                stroke={C.accent}
                stroke-opacity={0.5}
                stroke-width={1.5}
                stroke-dasharray="2 5"
                stroke-linecap="round"
              />
            )}
          </For>
          <For each={L().segments}>
            {(seg) => (
              <polyline
                points={linePoints(seg)}
                fill="none"
                stroke={C.accent}
                stroke-width={2.25}
                stroke-linejoin="round"
                stroke-linecap="round"
              />
            )}
          </For>
          <For each={props.points}>
            {(p, i) => (
              <Show when={p.value != null}>
                <circle
                  cx={L().x(i())}
                  cy={L().y(p.value as number)}
                  r={hover() === i() ? 5 : 3.5}
                  fill={pointColor(p.value as number)}
                  stroke="var(--color-lol-card)"
                  stroke-width={2}
                />
              </Show>
            )}
          </For>
          <For each={props.points}>
            {(p, i) => (
              <Show when={i() % L().labelEvery === 0}>
                <text
                  x={L().x(i())}
                  y={height() - 6}
                  text-anchor="middle"
                  {...AXIS_TEXT}
                  fill={hover() === i() ? "var(--color-lol-text-bright)" : C.axis}
                >
                  {p.label}
                </text>
              </Show>
            )}
          </For>
        </svg>
      </Show>
      <Show when={hover() != null ? hovered() : null}>
        {(h) => (
          <HoverTooltip
            x={L().x(hover() ?? 0)}
            width={width()}
            label={h().long ?? h().label}
            detail={h().detail}
            value={h().value != null ? props.format(h().value as number) : null}
          />
        )}
      </Show>
    </div>
  );
}

// ---- Activity heatmap ----

// The trailing 52 full weeks plus the current partial one. The cells stretch
// to the panel's width; the size is only the calendar's floor.
const HEATMAP_WEEKS = 53;
const HEATMAP_CELL = 11;

function ActivityHeatmap(props: { daily: TrendsDay[] }) {
  const days = createMemo(() => new Map(props.daily.map((d) => [parseDay(d.day).getTime(), d])));

  const range = createMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const first = new Date(today);
    first.setDate(
      first.getDate() - daysIntoWeek(first.getDay(), WEEK_START) - (HEATMAP_WEEKS - 1) * 7,
    );
    return { first: first.getTime(), last: today.getTime() };
  });

  return (
    <ActivityCalendar
      days={days()}
      first={range().first}
      last={range().last}
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

function PatchBars(props: { patches: TrendsData["patches"] }) {
  const { ref: widthRef, width } = createContainerWidth();
  const [hover, setHover] = createSignal<number | null>(null);
  const gradientId = createUniqueId();
  // Which sides have bars scrolled out of view, for the edge fades
  const [clipped, setClipped] = createSignal({ left: false, right: false });
  // The chart opens scrolled to the newest patch and stays there through
  // resizes and refetches until the user scrolls back. A different set of
  // patches (a queue switch, a new patch) returns it to the newest.
  let pinned = true;
  let pinnedFor = "";
  let scroller: HTMLDivElement | undefined;
  const patchKey = createMemo(() => props.patches.map((p) => p.patch).join());
  // Bars spread out to fill the panel when they fit, and scroll at their
  // narrowest pitch when they don't
  const minPitch = 56;
  const pad = 8;
  const chartWidth = () => Math.max(width(), props.patches.length * minPitch + pad * 2);
  const barPitch = () =>
    props.patches.length > 0 ? (chartWidth() - pad * 2) / props.patches.length : minPitch;
  const barWidth = () => Math.min(barPitch() * 0.56, 40);
  const top = 22;
  const plotHeight = 130;
  const height = top + plotHeight + 40;
  const y = (rate: number) => top + plotHeight - (rate / 100) * plotHeight;
  const barX = (i: number) => i * barPitch() + barPitch() / 2 + pad;

  const updateClipped = (el: HTMLDivElement) => {
    const left = el.scrollLeft >= 1;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setClipped((c) => (c.left === left && c.right === right ? c : { left, right }));
  };

  createEffect(
    () => ({ width: width(), chartWidth: chartWidth(), key: patchKey() }),
    ({ key }) => {
      if (!scroller) return;
      if (key !== pinnedFor) {
        pinnedFor = key;
        pinned = true;
      }
      if (pinned) scroller.scrollLeft = scroller.scrollWidth;
      updateClipped(scroller);
    },
  );

  const handleScroll = (e: Event & { currentTarget: HTMLDivElement }) => {
    const el = e.currentTarget;
    pinned = el.scrollLeft + el.clientWidth >= el.scrollWidth - 1;
    updateClipped(el);
  };

  const handleMove = (e: MouseEvent & { currentTarget: SVGSVGElement }) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const i = Math.floor((e.clientX - rect.left - pad) / barPitch());
    setHover(i >= 0 && i < props.patches.length ? i : null);
  };

  const hovered = () => {
    const i = hover();
    return i != null ? (props.patches[i] ?? null) : null;
  };

  return (
    // The fades sit outside the scroller so they stay put at its edges
    <div class="relative">
      <div
        ref={[
          widthRef,
          (el: HTMLDivElement) => {
            scroller = el;
          },
        ]}
        class="overflow-x-auto"
        onScroll={handleScroll}
      >
        <Show when={width() > 0}>
          {/* The tooltip anchors inside the scrollable content, so it tracks its
              bar when the chart is wider than the card and scrolled */}
          <div class="relative" style={{ width: `${chartWidth()}px` }}>
            <svg
              width={chartWidth()}
              height={height}
              class="block"
              onMouseMove={handleMove}
              onMouseLeave={() => setHover(null)}
            >
              <defs>
                {/* Each tier's bar fades from its colour at the value down to the
                    baseline, so the tops carry the reading */}
                <For each={PATCH_TIERS}>
                  {(t, i) => (
                    <linearGradient id={`${gradientId}-${i()}`} x1="0" x2="0" y1="0" y2="1">
                      <stop offset="0%" stop-color={t.color} stop-opacity={0.62} />
                      <stop offset="100%" stop-color={t.color} stop-opacity={0.14} />
                    </linearGradient>
                  )}
                </For>
                <pattern
                  id={`${gradientId}-ghost`}
                  width={6}
                  height={6}
                  patternUnits="userSpaceOnUse"
                  patternTransform="rotate(45)"
                >
                  <rect width={2} height={6} fill={C.axis} fill-opacity={0.45} />
                </pattern>
              </defs>
              <For each={[0, 25, 75, 100]}>
                {(t) => <line x1={0} x2={chartWidth()} y1={y(t)} y2={y(t)} stroke={C.grid} />}
              </For>
              <For each={props.patches}>
                {(p, i) => {
                  const rate = p.games > 0 ? (p.wins / p.games) * 100 : 0;
                  const cx = () => barX(i());
                  const thin = p.games < MIN_PATCH_GAMES;
                  const tier = patchTier(rate);
                  const color = PATCH_TIERS[tier].color;
                  // Too few games to read: a short colourless stub, so its rate is on
                  // record without the bar towering over the patches that count
                  const barHeight = thin ? 12 : Math.max(top + plotHeight - y(rate), 2);
                  return (
                    <g>
                      <Show when={hover() === i()}>
                        <rect
                          x={cx() - barPitch() / 2}
                          y={top - 16}
                          width={barPitch()}
                          height={plotHeight + 16}
                          fill="white"
                          fill-opacity={0.035}
                        />
                      </Show>
                      <rect
                        x={cx() - barWidth() / 2}
                        y={top + plotHeight - barHeight}
                        width={barWidth()}
                        height={barHeight}
                        rx={2}
                        fill={`url(#${CSS.escape(`${gradientId}-${thin ? "ghost" : tier}`)})`}
                        opacity={hover() === i() ? 1 : 0.85}
                      />
                      {/* A bright cap on the bar's top edge, the broadcast-graphic way of
                          marking the value */}
                      <rect
                        x={cx() - barWidth() / 2}
                        y={top + plotHeight - barHeight}
                        width={barWidth()}
                        height={Math.min(3, barHeight)}
                        rx={1}
                        fill={thin ? C.axis : color}
                        fill-opacity={thin ? 0.5 : 1}
                      />
                      <text
                        x={cx()}
                        y={top + plotHeight - barHeight - 7}
                        text-anchor="middle"
                        {...AXIS_TEXT}
                        font-size={thin ? "12" : "14"}
                        font-weight="700"
                        fill={thin ? C.axis : color}
                      >
                        {/* A stub's record, not a rate: "2–0" reads as the tiny
                            sample it is, where "100%" reads as a missing bar */}
                        {thin ? `${p.wins}–${p.games - p.wins}` : formatPercent(rate / 100, 0)}
                      </text>
                      <text
                        x={cx()}
                        y={top + plotHeight + 18}
                        text-anchor="middle"
                        {...AXIS_TEXT}
                        font-size="13"
                        font-weight="700"
                        fill="var(--color-lol-text-bright)"
                      >
                        {formatPatch(p.patch)}
                      </text>
                      <text
                        x={cx()}
                        y={top + plotHeight + 33}
                        text-anchor="middle"
                        {...AXIS_TEXT}
                        font-size="12"
                        font-weight="600"
                      >
                        {p.games.toLocaleString(LOCALE)} games
                      </text>
                    </g>
                  );
                }}
              </For>
              <line
                x1={0}
                x2={chartWidth()}
                y1={y(50)}
                y2={y(50)}
                stroke="var(--color-lol-text-bright)"
                stroke-opacity={0.28}
                stroke-dasharray="3 4"
              />
            </svg>
            <Show when={hovered()}>
              {(h) => (
                <HoverTooltip
                  x={barX(hover() ?? 0)}
                  width={chartWidth()}
                  label={`Patch ${formatPatch(h().patch)}`}
                  detail={
                    <>
                      <div>{recordDetail(h().games, h().wins)}</div>
                      <Show when={h().avg_score != null}>
                        <div>avg score {formatDecimal(h().avg_score as number)}</div>
                      </Show>
                    </>
                  }
                  value={h().games > 0 ? formatPercent(h().wins / h().games, 0) : null}
                />
              )}
            </Show>
          </div>
        </Show>
      </div>
      <div
        class={[
          "absolute top-0 left-0 w-10 pointer-events-none bg-gradient-to-r from-lol-card to-transparent transition-opacity",
          clipped().left ? "opacity-100" : "opacity-0",
        ]}
        style={{ height: `${height}px` }}
      />
      <div
        class={[
          "absolute top-0 right-0 w-10 pointer-events-none bg-gradient-to-l from-lol-card to-transparent transition-opacity",
          clipped().right ? "opacity-100" : "opacity-0",
        ]}
        style={{ height: `${height}px` }}
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

function WinRateChart(props: {
  points: SeriesPoint[];
  labelSpacing?: number;
  // Wider steps for a short plot crowded with points
  tickStep?: number;
}) {
  const axis = createMemo(() => winRateAxis(props.points, props.tickStep ?? 10));
  return (
    <TimeSeriesChart
      points={props.points}
      yMin={axis().lo}
      yMax={axis().hi}
      ticks={axis().ticks}
      refValue={50}
      format={(v) => formatPercent(v / 100, 0)}
      labelSpacing={props.labelSpacing}
    />
  );
}

function WeekdayChart(props: { weekdays: TrendsData["weekdays"] }) {
  const points = createMemo(() => {
    const byDay = new Map(props.weekdays.map((w) => [w.weekday, w]));
    return WEEKDAY_ORDER.map((dow) =>
      clockPoint(
        formatWeekday(dow, "short"),
        formatWeekday(dow, "long"),
        byDay.get(dow)?.games ?? 0,
        byDay.get(dow)?.wins ?? 0,
      ),
    );
  });
  return <WinRateChart points={points()} />;
}

function HourChart(props: { hours: TrendsData["hours"] }) {
  const points = createMemo(() => {
    const byHour = new Map(props.hours.map((h) => [h.hour, h]));
    return Array.from({ length: 24 }, (_, hour) =>
      clockPoint(
        formatHour(hour),
        `${formatHour(hour)} – ${formatHour((hour + 1) % 24)}`,
        byHour.get(hour)?.games ?? 0,
        byHour.get(hour)?.wins ?? 0,
      ),
    );
  });
  return <WinRateChart points={points()} labelSpacing={64} tickStep={20} />;
}

// ---- Page ----

const winRateLegend = () => (
  <Legend
    items={[
      { label: "Win rate", swatch: lineSwatch(C.accent) },
      { label: "50%+", swatch: dotSwatch(C.win) },
      { label: "Under 50%", swatch: dotSwatch(C.loss) },
      { label: "Games", swatch: barSwatch(C.secondary, 0.45) },
    ]}
  />
);

const scoreLegend = () => (
  <Legend
    items={[
      { label: "Avg score", swatch: lineSwatch(C.accent) },
      { label: "Games", swatch: barSwatch(C.secondary, 0.45) },
    ]}
  />
);

// A group's title with a hairline running out to its controls, as Match
// History heads its days
function SectionHead(props: { title: string; children?: JSX.Element }) {
  return (
    <div class="mb-3 flex items-center gap-3">
      <h2 class="section-title italic">{props.title}</h2>
      <span class="h-px flex-1 bg-lol-line" />
      {props.children}
    </div>
  );
}

// Whole-number ticks while the range is narrow enough to label every one,
// quarters of the range past that
function scoreAxis(values: number[]): { min: number; max: number; ticks: number[] } {
  const min = Math.floor(Math.min(...values) - 0.5);
  const max = Math.ceil(Math.max(...values) + 0.5);
  const ticks =
    max - min <= 6
      ? Array.from({ length: max - min + 1 }, (_, i) => min + i)
      : Array.from({ length: 5 }, (_, i) => min + ((max - min) * i) / 4);
  return { min, max, ticks };
}

function Loaded(props: {
  data: TrendsData;
  granularity: Granularity;
  onGranularity: (g: Granularity) => void;
  header: (subtitle?: JSX.Element) => JSX.Element;
}) {
  const buckets = createMemo(() => buildBuckets(props.data.daily, props.granularity));

  const winRatePoints = createMemo<SeriesPoint[]>(() =>
    buckets().map((b) => ({
      label: b.label,
      games: b.games,
      value: b.games > 0 ? (b.wins / b.games) * 100 : null,
      detail: b.games > 0 ? recordDetail(b.games, b.wins) : "No games",
    })),
  );

  const scorePoints = createMemo<SeriesPoint[]>(() =>
    buckets().map((b) => ({
      label: b.label,
      games: b.games,
      value: b.scoredGames > 0 ? b.scoreSum / b.scoredGames : null,
      detail:
        b.scoredGames > 0
          ? `${b.scoredGames.toLocaleString(LOCALE)} scored games`
          : "No scored games",
    })),
  );

  const scoreDomain = createMemo(() => {
    const values = scorePoints()
      .map((p) => p.value)
      .filter((v): v is number => v != null);
    return values.length === 0 ? null : scoreAxis(values);
  });

  const totalGames = () => props.data.daily.reduce((sum, d) => sum + d.games, 0);

  // The span the games actually cover, which is what the count is out of: the
  // calendar above always shows a full year whatever the history holds
  const since = () =>
    parseDay(props.data.daily[0].day).toLocaleDateString(LOCALE, {
      month: "short",
      year: "numeric",
    });
  const num = (v: number) => (
    <span class="font-num text-[14px] font-semibold text-lol-text-bright">
      {v.toLocaleString(LOCALE)}
    </span>
  );

  return (
    <div class="max-w-[1320px] space-y-6">
      {props.header(
        <>
          {num(totalGames())} {totalGames() === 1 ? "game" : "games"} across{" "}
          {num(props.data.daily.length)} {props.data.daily.length === 1 ? "day" : "days"} played
          since {since()}
        </>,
      )}

      <Card title="Activity" right={<span class="label">Last 12 months</span>}>
        <ActivityHeatmap daily={props.data.daily} />
      </Card>

      <Show when={props.data.patches.length > 1}>
        <Card title="Win Rate by Patch" right={<Legend items={PATCH_LEGEND} />}>
          <PatchBars patches={props.data.patches} />
        </Card>
      </Show>

      {/* The bucket size drives both charts below it, so its switch heads the
          pair rather than either one panel */}
      <section>
        <SectionHead title="Over time">
          <div class="seg">
            <For each={["month", "week"] as const}>
              {(g) => (
                <button
                  onClick={() => props.onGranularity(g)}
                  aria-pressed={props.granularity === g ? "true" : "false"}
                  class="seg-item"
                >
                  {g === "month" ? "Monthly" : "Weekly"}
                </button>
              )}
            </For>
          </div>
        </SectionHead>
        {/* Side by side once each chart still gets a full-size plot of its own */}
        <div class="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <Card title="Win Rate" right={winRateLegend()}>
            <WinRateChart points={winRatePoints()} />
          </Card>

          <Show when={scoreDomain()}>
            {(domain) => (
              <Card title="Average Score" right={scoreLegend()}>
                <TimeSeriesChart
                  points={scorePoints()}
                  yMin={domain().min}
                  yMax={domain().max}
                  ticks={domain().ticks}
                  format={(v) => formatDecimal(v)}
                />
              </Card>
            )}
          </Show>
        </div>
      </section>

      <section>
        <SectionHead title="When you play" />
        <div class="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <Card title="By Day of Week" right={winRateLegend()}>
            <WeekdayChart weekdays={props.data.weekdays} />
          </Card>
          <Card title="By Hour of Day" right={winRateLegend()}>
            <HourChart hours={props.data.hours} />
          </Card>
        </div>
      </section>
    </div>
  );
}

export default function Trends() {
  const [queue, setQueue] = useViewState<number | undefined>("trends.queue", undefined);

  const { data, refetch } = useIpc(
    ([q]) => api.getTrends(q),
    () => [queue()] as const,
  );

  onSettled(() => api.onGamesUpdated(() => void refetch()));

  createEffect(data, (loaded) => {
    if (loaded) reportFirstContent();
  });

  const spanDays = createMemo(() => spanDaysOf(data()?.daily ?? []));

  const [granularity, setGranularity] = useViewState<Granularity | undefined>(
    "trends.granularity",
    undefined,
  );
  const effectiveGranularity = createMemo<Granularity>(
    () => granularity() ?? defaultGranularity(spanDays()),
  );

  const header = (subtitle?: JSX.Element) => (
    <PageHeader
      kicker="Analyze"
      title="Trends"
      subtitle={subtitle}
      actions={<QueueSelect value={queue()} onChange={(q) => setQueue(q)} />}
      class="pb-0"
    />
  );

  return (
    <Show when={data()} fallback={<div class="label mt-20 text-center text-[12px]">Loading…</div>}>
      {(loaded) => (
        <Show
          when={loaded().daily.length > 0}
          fallback={
            <div class="max-w-[1320px] space-y-6">
              {header()}
              <div class="panel flex flex-col items-center gap-3 px-8 py-14 text-center">
                <TrendingUpIcon class="h-8 w-8 text-lol-gold/60" />
                <div class="max-w-md text-[14px] text-lol-text">
                  No games recorded yet — sync your match history to start tracking trends.
                </div>
              </div>
            </div>
          }
        >
          <Loaded
            data={loaded()}
            granularity={effectiveGranularity()}
            onGranularity={(g) => setGranularity(g)}
            header={header}
          />
        </Show>
      )}
    </Show>
  );
}
