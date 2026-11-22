import type { CSSProperties, ReactNode } from "react";
import { LOCALE, WEEK_START } from "../lib/format";
import { addDays, daysIntoWeek } from "../../shared/session";

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
export default function ActivityCalendar({
  days,
  first,
  last,
  through = last,
  cell,
  fill = false,
}: {
  days: ReadonlyMap<number, CalendarDay>;
  first: number;
  last: number;
  through?: number;
  cell: number;
  fill?: boolean;
}) {
  // The week's opening day on or before the first day, which starts the first column
  const start = addDays(first, -daysIntoWeek(new Date(first).getDay(), WEEK_START));
  const weeks = Math.floor(Math.round((last - start) / DAY_MS) / 7) + 1;

  let busiest = 1;
  for (const [day, played] of days) {
    if (day >= first && day <= through) busiest = Math.max(busiest, played.games);
  }

  const months: ReactNode[] = [];
  const cells: ReactNode[] = [];
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
        months.push(
          <div
            key={week}
            style={{ gridColumn: week + 2, gridRow: 1 }}
            className="w-0 whitespace-nowrap pb-0.5 font-display text-[11px] font-semibold uppercase leading-none tracking-[0.08em] text-lol-text"
          >
            {MONTH_FORMAT.format(shown)}
          </div>,
        );
      }
    }

    for (let row = 0; row < 7; row++) {
      const day = addDays(opening, row);
      if (day < first || day > last) continue;
      const place: CSSProperties = { gridColumn: week + 2, gridRow: row + 2 };

      if (day > through) {
        cells.push(
          <div
            key={day}
            style={place}
            className="aspect-square rounded-[2px] border border-white/[0.07]"
          />,
        );
        continue;
      }

      const played = days.get(day);
      const games = played?.games ?? 0;
      const level = games === 0 ? 0 : Math.ceil((games / busiest) * LEVELS.length);
      cells.push(
        <div
          key={day}
          title={describe(day, played)}
          style={level > 0 ? { ...place, background: LEVELS[level - 1] } : place}
          className={`aspect-square rounded-[2px] ${level > 0 ? "" : "bg-white/[0.045]"}`}
        />,
      );
    }
  }

  return (
    <div className={fill ? "w-full" : "w-fit max-w-full"}>
      <div
        className="grid"
        style={{
          gridTemplateColumns: `auto repeat(${weeks}, minmax(0, ${fill ? "1fr" : `${cell}px`}))`,
          gap: GAP,
        }}
      >
        {months}
        {LABELLED_WEEKDAYS.map((weekday) => (
          // No height of its own, so a label never makes its row taller than
          // the cells beside it
          <div
            key={weekday}
            style={{
              gridColumn: 1,
              gridRow: daysIntoWeek(weekday, WEEK_START) + 2,
            }}
            className="flex h-0 items-center self-center pr-2 font-display text-[11px] font-semibold uppercase leading-none tracking-[0.06em] text-lol-text"
          >
            {/* January 2, 2000 was a Sunday */}
            {WEEKDAY_FORMAT.format(new Date(2000, 0, 2 + weekday))}
          </div>
        ))}
        {cells}
      </div>
      <div className="mt-3 flex items-center justify-end gap-1 font-display text-[11px] font-semibold uppercase tracking-[0.08em] text-lol-text">
        <span className="mr-1.5">Less</span>
        <span className="h-3.5 w-3.5 rounded-[2px] bg-white/[0.045]" />
        {LEVELS.map((background) => (
          <span key={background} className="h-3.5 w-3.5 rounded-[2px]" style={{ background }} />
        ))}
        <span className="ml-1.5">More</span>
      </div>
    </div>
  );
}
