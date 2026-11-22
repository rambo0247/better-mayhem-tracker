import type { ReactNode } from "react";
import { LOCALE, formatDecimal, formatPercent, scoreColor } from "../lib/format";
import { ScoreBadge } from "./ScoreCell";
import WinRateBar from "./WinRateBar";
import { TrophyIcon } from "./icons";

// The pieces a friend's page and a group's page share: the head with their
// portraits, the record card, and the heading over the games list.

// A Riot ID with the tag set back from the name, so a list of them reads by
// name. Each half is isolated the way RiotId does it, for right-to-left names.
export function TaggedRiotId({
  id,
  tagClassName = "text-lol-text/60",
}: {
  id: string;
  tagClassName?: string;
}) {
  const hash = id.lastIndexOf("#");
  if (hash <= 0) return <bdi>{id}</bdi>;
  return (
    <>
      <bdi>{id.slice(0, hash)}</bdi>
      <span className={tagClassName}>
        #<bdi>{id.slice(hash + 1)}</bdi>
      </span>
    </>
  );
}

// The page head with the portrait(s) beside it, so the page opens on who it is
// about
export function ProfileHero({ portrait, children }: { portrait: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center gap-5">
      <div className="shrink-0">{portrait}</div>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

// Wins and losses together, the last few results as pips, and the win rate
export function RecordTogetherCard({
  wins,
  games,
  recent,
}: {
  wins: number;
  games: number;
  // Newest first, as the games list has them
  recent: { game_id: number; win: number }[];
}) {
  const losses = games - wins;
  // Oldest on the left so the strip reads left-to-right in time
  const pips = recent.slice(0, 10).reverse();
  // The run the latest game is part of
  const latest = recent[0];
  let streak = 0;
  while (streak < recent.length && !!recent[streak].win === !!latest?.win) streak++;
  const lastWins = pips.filter((g) => g.win).length;

  return (
    <div className="panel relative flex flex-col overflow-hidden p-4">
      {/* A wash of mint behind the record, so the card reads as the lead */}
      <span className="pointer-events-none absolute -left-16 -top-24 h-56 w-56 rounded-full bg-lol-win/[0.06] blur-3xl" />
      <span className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-lol-win/70 to-transparent" />
      <div className="relative mb-2 flex items-center gap-2">
        <span className="flex h-6 w-6 items-center justify-center rounded-md bg-lol-win/12 text-lol-win">
          <TrophyIcon className="h-3.5 w-3.5" />
        </span>
        <span className="label">Record Together</span>
      </div>

      <div className="relative flex items-end justify-between gap-3">
        <div className="font-num text-[30px] font-semibold leading-none">
          {/* A zero is nothing to cheer or worry about, so it goes uncoloured */}
          <span className={wins > 0 ? "text-lol-win" : "text-lol-text-bright"}>
            {wins.toLocaleString(LOCALE)}
          </span>
          <span className={`ml-0.5 text-[17px] ${wins > 0 ? "text-lol-win/70" : "text-lol-text"}`}>
            W
          </span>
          <span className={`ml-2.5 ${losses > 0 ? "text-lol-loss/85" : "text-lol-text-bright"}`}>
            {losses.toLocaleString(LOCALE)}
          </span>
          <span
            className={`ml-0.5 text-[17px] ${losses > 0 ? "text-lol-loss/60" : "text-lol-text"}`}
          >
            L
          </span>
        </div>
        {pips.length > 0 && (
          <div className="text-right">
            <div className="label mb-1 text-[11px] leading-3 text-lol-text/70">
              Last {pips.length}
            </div>
            <div
              className="flex items-end gap-[3px]"
              title={`Last ${pips.length} ${pips.length === 1 ? "game" : "games"} together`}
            >
              {pips.map((g) => (
                <span
                  key={g.game_id}
                  className={`slant-sm h-4 w-[9px] ${g.win ? "bg-lol-win" : "bg-lol-loss/75"}`}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="relative mt-3">
        <WinRateBar wins={wins} total={games} />
      </div>

      <div className="relative mt-auto pt-3">
        <StatTiles
          tiles={[
            { label: "Games", value: games.toLocaleString(LOCALE) },
            {
              label: `Last ${pips.length}`,
              value: `${lastWins}-${pips.length - lastWins}`,
            },
            {
              label: "Streak",
              value: latest ? `${latest.win ? "W" : "L"}${streak}` : "—",
              className: latest ? (latest.win ? "text-lol-win" : "text-lol-loss") : "",
            },
          ]}
        />
      </div>
    </div>
  );
}

// 0-10 track for an average score. The fill is the score ramp itself, laid
// over the whole track in hard steps (dim, then bright from 5, blue from 7,
// gold from 9) and uncovered up to the score, so the colour the bar ends on is
// the colour the score is printed in.
export function ScoreMeter({ score }: { score: number | null }) {
  const pct = Math.min(100, Math.max(0, (score ?? 0) * 10));
  return (
    <div className="relative h-1.5 overflow-hidden rounded-[2px] bg-white/[0.06]">
      <div
        className="absolute inset-0 transition-[clip-path]"
        style={{
          clipPath: `inset(0 ${100 - pct}% 0 0)`,
          background:
            "linear-gradient(90deg, var(--color-lol-text) 0 50%, var(--color-lol-text-bright) 50% 70%, var(--color-sky-400) 70% 90%, var(--color-amber-400) 90%)",
        }}
      />
    </div>
  );
}

// MVP is the best player on the winning team and ACE the best on the losing
// one, so each rate is out of the games that could have produced it
export function BadgeCounts({
  mvps,
  aces,
  scoredWins,
  scoredLosses,
}: {
  mvps: number;
  aces: number;
  scoredWins: number;
  scoredLosses: number;
}) {
  const rate = (n: number, of: number) => (of > 0 ? formatPercent(n / of) : "—");

  return (
    <div className="grid grid-cols-[auto_1fr_auto] items-center gap-x-2.5 gap-y-1.5">
      <ScoreBadge badge="MVP" />
      <span className="font-num text-[15px] font-semibold text-lol-text-bright">{mvps}</span>
      <span className="font-num text-[13px] text-lol-text" title="Share of wins">
        {rate(mvps, scoredWins)}
      </span>

      <ScoreBadge badge="ACE" />
      <span className="font-num text-[15px] font-semibold text-lol-text-bright">{aces}</span>
      <span className="font-num text-[13px] text-lol-text" title="Share of losses">
        {rate(aces, scoredLosses)}
      </span>
    </div>
  );
}

// An average score as a stat card value, out of ten
export function ScoreValue({ score, color }: { score: number | null; color: string }) {
  if (score == null) return <>—</>;
  return (
    <span className={color}>
      {formatDecimal(score)}
      <span className="text-[17px] font-medium text-lol-text/60"> / 10</span>
    </span>
  );
}

// The heading over the games list, in the style of Match History's day heads
export function GamesHeading({ games }: { games: number }) {
  return (
    <div className="mb-3 flex items-center gap-4 px-0.5">
      <h2 className="font-display text-[17px] font-bold uppercase italic tracking-[0.04em] text-lol-text-bright">
        Games Played Together
      </h2>
      <span className="text-[13px] text-lol-text">
        <span className="font-num text-[14px] font-semibold text-lol-text-bright">
          {games.toLocaleString(LOCALE)}
        </span>{" "}
        {games === 1 ? "game" : "games"}
      </span>
      <span className="h-px flex-1 bg-gradient-to-r from-lol-border to-transparent" />
    </div>
  );
}

// A game's score with its badge or caption under it, for the shared-game rows.
// ScoreCell's caption is set too small to read across a row this busy.
// Without the caption (a list with "Score" over its columns once), the number
// centres on the row like the numbers beside it, and a badge hangs below it.
export function RowScore({
  score,
  badge,
  caption = true,
}: {
  score: number | null;
  badge: "MVP" | "ACE" | null;
  caption?: boolean;
}) {
  if (score == null) return <div className="w-12 shrink-0" />;
  const number = (
    <div className={`font-num text-[20px] font-semibold leading-none ${scoreColor(score)}`}>
      {formatDecimal(score)}
    </div>
  );

  if (!caption) {
    return (
      <div className="relative w-12 shrink-0 text-center">
        {number}
        {badge && (
          <div className="absolute inset-x-0 top-full mt-1 flex justify-center">
            <ScoreBadge badge={badge} />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="w-12 shrink-0 text-center">
      {number}
      <div className="mt-1 flex h-[14px] justify-center">
        {badge ? (
          <ScoreBadge badge={badge} />
        ) : (
          <span className="label text-[11px] leading-[14px] text-lol-text/70">Score</span>
        )}
      </div>
    </div>
  );
}

// A player's name over their champion, the way the shared-game rows lead
// each line: ours picked out in gold
export function RowPlayer({
  name,
  you = false,
  children,
}: {
  name: string;
  you?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="min-w-0 leading-tight">
      <div
        title={name}
        className={`truncate font-display text-[13px] font-semibold ${
          you ? "text-lol-gold" : "text-lol-text"
        }`}
      >
        <bdi>{name}</bdi>
      </div>
      {children}
    </div>
  );
}

// A row of small totals under a card's headline, built like Match History's
// multikill and career-total tiles
export function StatTiles({
  tiles,
}: {
  tiles: { label: string; value: ReactNode; className?: string }[];
}) {
  return (
    <div className="grid grid-cols-3 gap-1">
      {tiles.map((t) => (
        <div
          key={t.label}
          className="rounded-[3px] border border-lol-line bg-black/15 px-1 py-1 text-center"
        >
          <div
            className={`font-num text-[16px] font-semibold leading-tight ${
              t.className || "text-lol-text-bright"
            }`}
          >
            {t.value}
          </div>
          <div className="label text-[11px] leading-3 text-lol-text">{t.label}</div>
        </div>
      ))}
    </div>
  );
}

// Kills, deaths and assists added up, as tiles
export function KdaTotals({
  kills,
  deaths,
  assists,
}: {
  kills: number;
  deaths: number;
  assists: number;
}) {
  return (
    <StatTiles
      tiles={[
        { label: "Kills", value: kills.toLocaleString(LOCALE) },
        { label: "Deaths", value: deaths.toLocaleString(LOCALE) },
        { label: "Assists", value: assists.toLocaleString(LOCALE) },
      ]}
    />
  );
}
