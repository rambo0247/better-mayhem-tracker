import { createMemo, For } from "solid-js";
import { addDays, daysIntoWeek } from "@shared/session";
import { LOCALE, WEEK_START } from "../lib/format";

export interface CalendarDay {
  games: number;
  wins: number;
}

// Each step up from an empty day, the busiest day on show at full strength.
// A blue ramp mixed into the panel's navy: it stays clean at every step, where
// gold dimmed toward navy passes through olive greys on the way down.
const LEVELS = [
  "color-mix(in srgb, var(--color-sky-500) 30%, #141d42)",
  "color-mix(in srgb, var(--color-sky-500) 55%, #141d42)",
  "color-mix(in srgb, var(--color-sky-400) 85%, #141d42)",
  "#b4dcff",
];
// Every row gets its weekday's name, 0 = Sunday. They keep their names
// wherever the regional week puts them.
const LABELLED_WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];
const GAP = 3;
const DAY_MS = 86_400_000;

const DAY_FORMAT = new Intl.DateTimeFormat(LOCALE, {
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
});
const MONTH_FORMAT = new Intl.DateTimeFormat(LOCALE, { month: "short" });
const WEEKDAY_FORMAT = new Intl.DateTimeFormat(LOCALE, { weekday: "short" });

function describe(day: number, played: CalendarDay | undefined): string {
  const date = DAY_FORMAT.format(day);
  if (!played) return `${date} · no games`;
  const { games, wins } = played;
  return `${date} · ${games} ${games === 1 ? "game" : "games"} · ${wins}W ${games - wins}L`;
}

/**
 * Days from `first` to `last` as a GitHub-style grid, a column per week with
 * the regional first day of the week at the top, each day shaded by its games
 * against the busiest day on show. Days are keyed by their local midnight. Those after `through` haven't
 * happened yet and are drawn as outlines, so a span still in progress shows
 * how much of it is left.
 *
 * Columns are `cell` pixels wide where there is room and narrower where there
 * isn't, so a long span shrinks to fit rather than scrolling. With `fill` they
 * share out the whole width instead, for a calendar that is its panel's only
 * content and would otherwise leave half of it empty.
 */
type MonthLabel = { week: number; text: string };
type Cell = {
  day: number;
  week: number;
  row: number;
  future: boolean;
  level: number;
  title: string;
};

function place(week: number, row: number) {
  return { "grid-column": String(week + 2), "grid-row": String(row + 2) };
}

export default function ActivityCalendar(props: {
  days: ReadonlyMap<number, CalendarDay>;
  first: number;
  last: number;
  through?: number;
  cell: number;
  fill?: boolean;
}) {
  const grid = createMemo(() => {
    const days = props.days;
    const first = props.first;
    const last = props.last;
    const through = props.through ?? last;
    // The week's opening day on or before the first day, which starts the first column
    const start = addDays(first, -daysIntoWeek(new Date(first).getDay(), WEEK_START));
    const weeks = Math.floor(Math.round((last - start) / DAY_MS) / 7) + 1;

    let busiest = 1;
    for (const [day, played] of days) {
      if (day >= first && day <= through) busiest = Math.max(busiest, played.games);
    }

    const months: MonthLabel[] = [];
    const cells: Cell[] = [];
    let month = -1;
    for (let week = 0; week < weeks; week++) {
      const opening = addDays(start, week * 7);
      // A column goes by the month of the first day it shows
      const shown = Math.max(opening, first);
      if (new Date(shown).getMonth() !== month) {
        month = new Date(shown).getMonth();
        // A first column the next one already starts a new month beside has no
        // room for a label of its own
        const next = new Date(addDays(opening, 7)).getMonth();
        if (week > 0 || next === month || weeks === 1) {
          months.push({ week, text: MONTH_FORMAT.format(shown) });
        }
      }

      for (let row = 0; row < 7; row++) {
        const day = addDays(opening, row);
        if (day < first || day > last) continue;
        if (day > through) {
          cells.push({ day, week, row, future: true, level: 0, title: "" });
          continue;
        }
        const played = days.get(day);
        const games = played?.games ?? 0;
        const level = games === 0 ? 0 : Math.ceil((games / busiest) * LEVELS.length);
        cells.push({ day, week, row, future: false, level, title: describe(day, played) });
      }
    }
    return { weeks, months, cells };
  });

  return (
    <div class={props.fill ? "w-full" : "w-fit max-w-full"}>
      <div
        class="grid"
        style={{
          "grid-template-columns": `auto repeat(${grid().weeks}, minmax(0, ${props.fill ? "1fr" : `${props.cell}px`}))`,
          gap: `${GAP}px`,
        }}
      >
        <For each={grid().months}>
          {(label) => (
            <div
              style={{ "grid-column": String(label.week + 2), "grid-row": "1" }}
              class="w-0 whitespace-nowrap pb-0.5 font-display text-[11px] font-semibold uppercase leading-none tracking-[0.08em] text-lol-text"
            >
              {label.text}
            </div>
          )}
        </For>
        <For each={LABELLED_WEEKDAYS}>
          {(weekday) => (
            // No height of its own, so a label never makes its row taller than
            // the cells beside it
            <div
              style={{
                "grid-column": "1",
                "grid-row": String(daysIntoWeek(weekday, WEEK_START) + 2),
              }}
              class="flex h-0 items-center self-center pr-2 font-display text-[11px] font-semibold uppercase leading-none tracking-[0.06em] text-lol-text"
            >
              {/* January 2, 2000 was a Sunday */}
              {WEEKDAY_FORMAT.format(new Date(2000, 0, 2 + weekday))}
            </div>
          )}
        </For>
        <For each={grid().cells}>
          {(cell) =>
            cell.future ? (
              <div
                style={place(cell.week, cell.row)}
                class="aspect-square rounded-[2px] border border-white/[0.07]"
              />
            ) : (
              <div
                title={cell.title}
                style={
                  cell.level > 0
                    ? { ...place(cell.week, cell.row), background: LEVELS[cell.level - 1] }
                    : place(cell.week, cell.row)
                }
                class={["aspect-square rounded-[2px]", { "bg-white/[0.045]": cell.level === 0 }]}
              />
            )
          }
        </For>
      </div>
      <div class="mt-3 flex items-center justify-end gap-1 font-display text-[11px] font-semibold uppercase tracking-[0.08em] text-lol-text">
        <span class="mr-1.5">Less</span>
        <span class="h-3.5 w-3.5 rounded-[2px] bg-white/[0.045]" />
        <For each={LEVELS}>
          {(background) => <span class="h-3.5 w-3.5 rounded-[2px]" style={{ background }} />}
        </For>
        <span class="ml-1.5">More</span>
      </div>
    </div>
  );
}
