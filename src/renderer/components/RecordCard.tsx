import type { ReactNode } from "react";
import type {
  ChampionData,
  RecordMatchRef,
  RecordsData,
  StatRecord,
  StreakRecord,
} from "../lib/types";
import { getChampionName } from "../hooks/useChampions";
import {
  LOCALE,
  formatDecimal,
  formatDuration,
  formatShortDate,
  kdaRatio,
  scoreColor,
} from "../lib/format";
import ChampionIcon from "./ChampionIcon";
import Kda from "./Kda";
import { ACCENTS, type StatAccent } from "./StatCard";
import {
  ChevronRightIcon,
  CoinsIcon,
  CrosshairIcon,
  FlameIcon,
  HeartIcon,
  HourglassIcon,
  ShieldIcon,
  SkullIcon,
  StarIcon,
  SwordsIcon,
  TimerIcon,
  TrendingDownIcon,
  TrendingUpIcon,
  UsersIcon,
  ZapIcon,
} from "./icons";

// Records are moments, not recency — "3 months ago" undersells a trophy, so
// they get a real date.
export function recordDate(ts: number): string {
  return formatShortDate(ts);
}

// The same tile treatment as StatCard, the record itself set large, with the
// game it was set in along the bottom. A button when there is somewhere to
// open that game, as on the Records page; a plain tile on a card that is only
// ever looked at.
export function RecordCard({
  label,
  icon,
  accent,
  value,
  sub,
  match,
  champData,
  onOpen,
}: Omit<RecordCardDef, "key"> & {
  champData: ChampionData;
  onOpen?: (match: RecordMatchRef) => void;
}) {
  const a = ACCENTS[accent];
  const accentText = a.chip.split(" ").find((c) => c.startsWith("text-"));
  const body = (
    <>
      <span
        className={`pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r ${a.bar} to-transparent`}
      />
      {/* The category's icon again, large and faint, so a wall of cards reads
          as distinct trophies at a glance. Inset and fading out toward the
          card's middle, rather than cut off by its corner. */}
      <span
        className={`pointer-events-none absolute right-4 top-4 opacity-[0.09] [mask-image:linear-gradient(225deg,black_25%,transparent_80%)] [&>svg]:h-[72px] [&>svg]:w-[72px] ${accentText}`}
      >
        {icon}
      </span>
      <div className="relative flex flex-1 flex-col px-4 pt-4 pb-3.5">
        <div className="flex items-center gap-2">
          <span
            className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md [&>svg]:h-3.5 [&>svg]:w-3.5 ${a.chip}`}
          >
            {icon}
          </span>
          <span className="label truncate">{label}</span>
        </div>
        <div className="font-num mt-3.5 text-[40px] font-semibold leading-none text-lol-text-bright">
          {value}
        </div>
        {/* The line is held on every card, so cards in a row stay the same
            height whether or not theirs has something to say */}
        <div className="mt-2 min-h-5 truncate text-[13px] leading-5 text-lol-text">{sub}</div>
      </div>
      <div className="relative mt-auto flex items-center gap-2.5 border-t border-lol-line bg-black/15 px-4 py-2.5">
        <ChampionIcon championId={match.champion_id} size={32} />
        <div className="min-w-0 flex-1">
          <div className="truncate font-display text-[15px] font-semibold leading-5 text-lol-text-bright">
            {getChampionName(champData, match.champion_id)}
          </div>
          <div className="flex items-center gap-1.5 truncate text-[12px] leading-4 text-lol-text">
            <span
              className={`font-display text-[12px] font-bold tracking-[0.06em] ${match.win ? "text-lol-win" : "text-lol-loss"}`}
            >
              {match.win ? "W" : "L"}
            </span>
            <span className="font-num text-[13px] text-lol-text-bright/80">
              <Kda kills={match.kills} deaths={match.deaths} assists={match.assists} />
            </span>
            <span className="text-lol-text/40">·</span>
            <span className="font-num text-[13px]">{recordDate(match.game_creation)}</span>
          </div>
        </div>
        {onOpen && (
          <ChevronRightIcon className="h-4 w-4 shrink-0 text-lol-text/40 transition-colors group-hover:text-lol-gold" />
        )}
      </div>
    </>
  );
  const tile = "panel group flex flex-col overflow-hidden text-left";

  if (!onOpen) return <div className={tile}>{body}</div>;
  return (
    <button
      onClick={() => onOpen(match)}
      title="View match"
      className={`${tile} cursor-pointer transition-colors hover:border-lol-gold/45 hover:bg-lol-card-hover`}
    >
      {body}
    </button>
  );
}

export interface RecordCardDef {
  key: string;
  label: string;
  icon: ReactNode;
  accent: StatAccent;
  value: ReactNode;
  sub?: ReactNode;
  match: RecordMatchRef;
}

// One card per single-game best that has been set, in the Records page's order
export function recordCards(bests: RecordsData["bests"]): RecordCardDef[] {
  const cards: RecordCardDef[] = [];
  const add = (
    record: StatRecord | null,
    def: Omit<RecordCardDef, "match" | "value"> & {
      value: (r: StatRecord) => ReactNode;
    },
  ) => {
    if (record) cards.push({ ...def, value: def.value(record), match: record.match });
  };
  const n = (v: number) => Math.round(v).toLocaleString(LOCALE);

  add(bests.kills, {
    key: "kills",
    label: "Most Kills",
    icon: <SwordsIcon className="w-3 h-3" />,
    accent: "gold",
    value: (r) => r.value,
  });
  add(bests.kda, {
    key: "kda",
    label: "Best KDA",
    icon: <ZapIcon className="w-3 h-3" />,
    accent: "sky",
    // kdaRatio turns a deathless game into "Perfect" — better than the raw
    // rank value, which pretends one death happened
    value: (r) => kdaRatio(r.match.kills, r.match.deaths, r.match.assists),
  });
  add(bests.score, {
    key: "score",
    label: "Highest Score",
    icon: <StarIcon className="w-3 h-3" />,
    accent: "gold",
    // The raw score, which runs past the 10 every other score stops at: a best
    // is the one place telling the 10s apart matters
    value: (r) => <span className={scoreColor(r.value)}>{formatDecimal(r.value)}</span>,
  });
  add(bests.killingSpree, {
    key: "spree",
    label: "Longest Killing Spree",
    icon: <FlameIcon className="w-3 h-3" />,
    accent: "purple",
    value: (r) => r.value,
  });
  add(bests.damage, {
    key: "damage",
    label: "Most Damage Dealt",
    icon: <CrosshairIcon className="w-3 h-3" />,
    accent: "sky",
    value: (r) => n(r.value),
  });
  add(bests.damageTaken, {
    key: "taken",
    label: "Most Damage Taken",
    icon: <ShieldIcon className="w-3 h-3" />,
    accent: "win",
    value: (r) => n(r.value),
  });
  add(bests.healing, {
    key: "healing",
    label: "Most Healing",
    icon: <HeartIcon className="w-3 h-3" />,
    accent: "win",
    value: (r) => n(r.value),
  });
  add(bests.gold, {
    key: "gold",
    label: "Most Gold Earned",
    icon: <CoinsIcon className="w-3 h-3" />,
    accent: "gold",
    value: (r) => n(r.value),
  });
  add(bests.assists, {
    key: "assists",
    label: "Most Assists",
    icon: <UsersIcon className="w-3 h-3" />,
    accent: "sky",
    value: (r) => r.value,
  });
  add(bests.deaths, {
    key: "deaths",
    label: "Most Deaths",
    icon: <SkullIcon className="w-3 h-3" />,
    accent: "purple",
    value: (r) => r.value,
    sub: "we don't talk about this one",
  });
  add(bests.fastestWin, {
    key: "fastestWin",
    label: "Fastest Win",
    icon: <TimerIcon className="w-3 h-3" />,
    accent: "win",
    value: (r) => formatDuration(r.value),
  });
  add(bests.longestGame, {
    key: "longestGame",
    label: "Longest Game",
    icon: <HourglassIcon className="w-3 h-3" />,
    accent: "purple",
    value: (r) => formatDuration(r.value),
  });
  return cards;
}

export function streakCard(streak: StreakRecord, win: boolean): RecordCardDef {
  const range =
    recordDate(streak.start) === recordDate(streak.end)
      ? recordDate(streak.start)
      : `${recordDate(streak.start)} – ${recordDate(streak.end)}`;
  return {
    key: win ? "winStreak" : "lossStreak",
    label: win ? "Longest Win Streak" : "Longest Loss Streak",
    icon: win ? <TrendingUpIcon className="w-3 h-3" /> : <TrendingDownIcon className="w-3 h-3" />,
    accent: win ? "win" : "purple",
    value: (
      <>
        {streak.length}
        <span className="ml-1.5 text-[20px] font-medium text-lol-text">
          {win ? "wins" : "losses"}
        </span>
      </>
    ),
    sub: range,
    match: streak.match,
  };
}
