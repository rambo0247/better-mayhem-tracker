import { For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { LOCALE, formatDecimal, formatPercent, scoreColor } from "../lib/format";
import { ScoreBadge } from "./ScoreCell";
import WinRateBar from "./WinRateBar";
import { TrophyIcon } from "./icons";

// The pieces a friend's page and a group's page share: the head with their
// portraits, the record card, and the heading over the games list.

// A Riot ID with the tag set back from the name, so a list of them reads by
// name. Each half is isolated the way RiotId does it, for right-to-left names.
export function TaggedRiotId(props: { id: string; tagClass?: string }) {
  const hash = () => props.id.lastIndexOf("#");
  return (
    <Show when={hash() > 0} fallback={<bdi>{props.id}</bdi>}>
      <bdi>{props.id.slice(0, hash())}</bdi>
      <span class={props.tagClass ?? "text-lol-text/60"}>
        #<bdi>{props.id.slice(hash() + 1)}</bdi>
      </span>
    </Show>
  );
}

// The page head with the portrait(s) beside it, so the page opens on who it is
// about
export function ProfileHero(props: { portrait: JSX.Element; children: JSX.Element }) {
  return (
    <div class="flex items-center gap-5">
      <div class="shrink-0">{props.portrait}</div>
      <div class="min-w-0 flex-1">{props.children}</div>
    </div>
  );
}

// Wins and losses together, the last few results as pips, and the win rate
export function RecordTogetherCard(props: {
  wins: number;
  games: number;
  // Newest first, as the games list has them
  recent: { game_id: number; win: number }[];
}) {
  const losses = () => props.games - props.wins;
  // Oldest on the left so the strip reads left-to-right in time
  const pips = () => props.recent.slice(0, 10).reverse();
  // The run the latest game is part of
  const latest = () => props.recent[0];
  const streak = () => {
    const recent = props.recent;
    let run = 0;
    while (run < recent.length && !!recent[run]!.win === !!latest()?.win) run++;
    return run;
  };
  const lastWins = () => pips().filter((g) => g.win).length;

  return (
    <div class="panel relative flex flex-col overflow-hidden p-4">
      {/* A wash of mint behind the record, so the card reads as the lead */}
      <span class="pointer-events-none absolute -left-16 -top-24 h-56 w-56 rounded-full bg-lol-win/[0.06] blur-3xl" />
      <span class="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-lol-win/70 to-transparent" />
      <div class="relative mb-2 flex items-center gap-2">
        <span class="flex h-6 w-6 items-center justify-center rounded-md bg-lol-win/12 text-lol-win">
          <TrophyIcon class="h-3.5 w-3.5" />
        </span>
        <span class="label">Record Together</span>
      </div>

      <div class="relative flex items-end justify-between gap-3">
        <div class="font-num text-[30px] font-semibold leading-none">
          {/* A zero is nothing to cheer or worry about, so it goes uncoloured */}
          <span class={props.wins > 0 ? "text-lol-win" : "text-lol-text-bright"}>
            {props.wins.toLocaleString(LOCALE)}
          </span>
          <span
            class={["ml-0.5 text-[17px]", props.wins > 0 ? "text-lol-win/70" : "text-lol-text"]}
          >
            W
          </span>
          <span class={["ml-2.5", losses() > 0 ? "text-lol-loss/85" : "text-lol-text-bright"]}>
            {losses().toLocaleString(LOCALE)}
          </span>
          <span class={["ml-0.5 text-[17px]", losses() > 0 ? "text-lol-loss/60" : "text-lol-text"]}>
            L
          </span>
        </div>
        <Show when={pips().length > 0}>
          <div class="text-right">
            <div class="label mb-1 text-[11px] leading-3 text-lol-text/70">
              Last {pips().length}
            </div>
            <div
              class="flex items-end gap-[3px]"
              title={`Last ${pips().length} ${pips().length === 1 ? "game" : "games"} together`}
            >
              <For each={pips()} keyed={(g) => g.game_id}>
                {(g) => (
                  <span
                    class={["slant-sm h-4 w-[9px]", g().win ? "bg-lol-win" : "bg-lol-loss/75"]}
                  />
                )}
              </For>
            </div>
          </div>
        </Show>
      </div>

      <div class="relative mt-3">
        <WinRateBar wins={props.wins} total={props.games} />
      </div>

      <div class="relative mt-auto pt-3">
        <StatTiles
          tiles={[
            { label: "Games", value: props.games.toLocaleString(LOCALE) },
            {
              label: `Last ${pips().length}`,
              value: `${lastWins()}-${pips().length - lastWins()}`,
            },
            {
              label: "Streak",
              value: latest() ? `${latest()!.win ? "W" : "L"}${streak()}` : "—",
              class: latest() ? (latest()!.win ? "text-lol-win" : "text-lol-loss") : "",
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
export function ScoreMeter(props: { score: number | null }) {
  const pct = () => Math.min(100, Math.max(0, (props.score ?? 0) * 10));
  return (
    <div class="relative h-1.5 overflow-hidden rounded-[2px] bg-white/[0.06]">
      <div
        class="absolute inset-0 transition-[clip-path]"
        style={{
          "clip-path": `inset(0 ${100 - pct()}% 0 0)`,
          background:
            "linear-gradient(90deg, var(--color-lol-text) 0 50%, var(--color-lol-text-bright) 50% 70%, var(--color-sky-400) 70% 90%, var(--color-amber-400) 90%)",
        }}
      />
    </div>
  );
}

// MVP is the best player on the winning team and ACE the best on the losing
// one, so each rate is out of the games that could have produced it
export function BadgeCounts(props: {
  mvps: number;
  aces: number;
  scoredWins: number;
  scoredLosses: number;
}) {
  const rate = (n: number, of: number) => (of > 0 ? formatPercent(n / of) : "—");

  return (
    <div class="grid grid-cols-[auto_1fr_auto] items-center gap-x-2.5 gap-y-1.5">
      <ScoreBadge badge="MVP" />
      <span class="font-num text-[15px] font-semibold text-lol-text-bright">{props.mvps}</span>
      <span class="font-num text-[13px] text-lol-text" title="Share of wins">
        {rate(props.mvps, props.scoredWins)}
      </span>

      <ScoreBadge badge="ACE" />
      <span class="font-num text-[15px] font-semibold text-lol-text-bright">{props.aces}</span>
      <span class="font-num text-[13px] text-lol-text" title="Share of losses">
        {rate(props.aces, props.scoredLosses)}
      </span>
    </div>
  );
}

// An average score as a stat card value, out of ten
export function ScoreValue(props: { score: number | null; color: string }) {
  return (
    <Show when={props.score != null} fallback="—">
      <span class={props.color}>
        {formatDecimal(props.score!)}
        <span class="text-[17px] font-medium text-lol-text/60"> / 10</span>
      </span>
    </Show>
  );
}

// The heading over the games list, in the style of Match History's day heads
export function GamesHeading(props: { games: number }) {
  return (
    <div class="mb-3 flex items-center gap-4 px-0.5">
      <h2 class="font-display text-[17px] font-bold uppercase italic tracking-[0.04em] text-lol-text-bright">
        Games Played Together
      </h2>
      <span class="text-[13px] text-lol-text">
        <span class="font-num text-[14px] font-semibold text-lol-text-bright">
          {props.games.toLocaleString(LOCALE)}
        </span>{" "}
        {props.games === 1 ? "game" : "games"}
      </span>
      <span class="h-px flex-1 bg-gradient-to-r from-lol-border to-transparent" />
    </div>
  );
}

// A game's score with its badge or caption under it, for the shared-game rows.
// ScoreCell's caption is set too small to read across a row this busy.
// Without the caption (a list with "Score" over its columns once), the number
// centres on the row like the numbers beside it, and a badge hangs below it.
export function RowScore(props: {
  score: number | null;
  badge: "MVP" | "ACE" | null;
  caption?: boolean;
}) {
  const number = () => (
    <div class={["font-num text-[20px] font-semibold leading-none", scoreColor(props.score!)]}>
      {formatDecimal(props.score!)}
    </div>
  );

  return (
    <Show when={props.score != null} fallback={<div class="w-12 shrink-0" />}>
      <Show
        when={props.caption ?? true}
        fallback={
          <div class="relative w-12 shrink-0 text-center">
            {number()}
            <Show when={props.badge}>
              {(badge) => (
                <div class="absolute inset-x-0 top-full mt-1 flex justify-center">
                  <ScoreBadge badge={badge()} />
                </div>
              )}
            </Show>
          </div>
        }
      >
        <div class="w-12 shrink-0 text-center">
          {number()}
          <div class="mt-1 flex h-[14px] justify-center">
            <Show
              when={props.badge}
              fallback={
                <span class="label text-[11px] leading-[14px] text-lol-text/70">Score</span>
              }
            >
              {(badge) => <ScoreBadge badge={badge()} />}
            </Show>
          </div>
        </div>
      </Show>
    </Show>
  );
}

// A player's name over their champion, the way the shared-game rows lead
// each line: ours picked out in gold
export function RowPlayer(props: { name: string; you?: boolean; children?: JSX.Element }) {
  return (
    <div class="min-w-0 leading-tight">
      <div
        title={props.name}
        class={[
          "truncate font-display text-[13px] font-semibold",
          props.you ? "text-lol-gold" : "text-lol-text",
        ]}
      >
        <bdi>{props.name}</bdi>
      </div>
      {props.children}
    </div>
  );
}

// A row of small totals under a card's headline, built like Match History's
// multikill and career-total tiles
export function StatTiles(props: {
  tiles: { label: string; value: JSX.Element; class?: string }[];
}) {
  return (
    <div class="grid grid-cols-3 gap-1">
      <For each={props.tiles} keyed={(t) => t.label}>
        {(t) => (
          <div class="rounded-[3px] border border-lol-line bg-black/15 px-1 py-1 text-center">
            <div
              class={[
                "font-num text-[16px] font-semibold leading-tight",
                t().class || "text-lol-text-bright",
              ]}
            >
              {t().value}
            </div>
            <div class="label text-[11px] leading-3 text-lol-text">{t().label}</div>
          </div>
        )}
      </For>
    </div>
  );
}

// Kills, deaths and assists added up, as tiles
export function KdaTotals(props: { kills: number; deaths: number; assists: number }) {
  return (
    <StatTiles
      tiles={[
        { label: "Kills", value: props.kills.toLocaleString(LOCALE) },
        { label: "Deaths", value: props.deaths.toLocaleString(LOCALE) },
        { label: "Assists", value: props.assists.toLocaleString(LOCALE) },
      ]}
    />
  );
}
