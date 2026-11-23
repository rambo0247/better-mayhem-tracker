import { createMemo, createSignal, For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import {
  computeMatchScoreBreakdowns,
  type ScoreBreakdown,
  type ScoreComponent,
  type ScoreComponentKey,
} from "@shared/opScore";
import type { ChampionData, MatchDetail, ParsedParticipant } from "../lib/types";
import { parseParticipants, groupByTeam } from "../lib/participants";
import { getChampionName } from "../hooks/useChampions";
import {
  formatCompact,
  formatDecimal,
  formatPercent,
  kdaHighlight,
  kdaRatio,
  scoreColor,
} from "../lib/format";
import ChampionIcon from "./ChampionIcon";
import AugmentIcon from "./AugmentIcon";
import ItemIcon from "./ItemIcon";
import SummonerSpellIcon from "./SummonerSpellIcon";
import MultikillBadge from "./MultikillBadge";
import { ScoreBadge } from "./ScoreCell";
import Kda from "./Kda";
import RiotId from "./RiotId";

// Two layouts, picked by the width the scoreboard is given rather than the
// window's: the same component sits in a match row, a recap, a records dialog
// and an exported card. Given the room, damage, taken and healing each get a
// column of their own, the build runs in one line and multikills get a column
// at the end, so a match row, the recap and the card all show the same table.
// At the app's default window size there is no such room, so the three bars
// fold into one column like the match row's StatBars, the build stacks into
// the row's 3x2 grid and multikills drop out (the row above shows them).
const WIDE_COLS =
  "@min-[1088px]:grid-cols-[58px_minmax(100px,1fr)_48px_84px_minmax(72px,92px)_minmax(72px,92px)_minmax(72px,92px)_52px_178px_100px_110px]";
const GRID_COLS = `grid-cols-[58px_minmax(96px,1fr)_48px_80px_150px_48px_108px_72px] ${WIDE_COLS}`;
// The card asks for multikills whatever its width: it has no match row above
// it to show them, and is always drawn wide enough for the column anyway.
const GRID_COLS_MULTIKILLS = `grid-cols-[58px_minmax(96px,1fr)_48px_80px_150px_48px_108px_72px_110px] ${WIDE_COLS}`;

// Shown only in one of the two layouts
const WIDE_ONLY = "hidden @min-[1088px]:block";
const NARROW_ONLY = "@min-[1088px]:hidden";

type MaxStats = { dmg: number; taken: number; gold: number; heal: number };

export default function MatchScoreboard(props: {
  detail: MatchDetail;
  champData: ChampionData;
  puuids: string[] | null;
  // The wide layout always has the column; this keeps it in the narrow one too
  multikills?: boolean;
}) {
  const participants = createMemo(() => parseParticipants(props.detail.participants, props.puuids));
  // The user's own team leads, so the first block under a match row reads as
  // that row's result. Display order only: team numbers stay as recorded.
  const teams = createMemo(() =>
    Array.from(groupByTeam(participants()).entries()).sort(
      ([, a], [, b]) => Number(b.some((p) => p.isSelf)) - Number(a.some((p) => p.isSelf)),
    ),
  );
  const scores = createMemo(() => {
    const classes: Record<number, string | undefined> = {};
    for (const p of participants()) classes[p.championId] = props.champData[p.championId]?.class;
    return computeMatchScoreBreakdowns(participants(), classes);
  });

  const gameMaxStats = createMemo(() => {
    let dmg = 0,
      taken = 0,
      gold = 0,
      heal = 0;
    for (const p of participants()) {
      if (p.totalDamageDealtToChampions > dmg) dmg = p.totalDamageDealtToChampions;
      if (p.totalDamageTaken > taken) taken = p.totalDamageTaken;
      if (p.goldEarned > gold) gold = p.goldEarned;
      if (p.totalHeal > heal) heal = p.totalHeal;
    }
    return {
      dmg: dmg || 1,
      taken: taken || 1,
      gold: gold || 1,
      heal: heal || 1,
    };
  });

  return (
    <Show
      when={participants().length > 0}
      fallback={
        <div class="py-6 text-center text-[13px] text-lol-text">Full game data not available.</div>
      }
    >
      <div class="@container space-y-3">
        <For each={teams()} keyed={([teamId]) => teamId}>
          {(team) => (
            <TeamScoreboard
              teamId={team()[0]}
              players={team()[1]}
              maxStats={gameMaxStats()}
              champData={props.champData}
              scores={scores()}
              patch={props.detail.game.game_version}
              multikills={props.multikills ?? false}
            />
          )}
        </For>
      </div>
    </Show>
  );
}

function TeamScoreboard(props: {
  teamId: number;
  players: ParsedParticipant[];
  maxStats: MaxStats;
  champData: ChampionData;
  scores: Map<number, ScoreBreakdown>;
  patch?: string | null;
  multikills: boolean;
}) {
  const isWin = () => props.players[0]?.win ?? false;
  const totals = createMemo(() => computeTeamTotals(props.players, props.scores));
  const grid = () => (props.multikills ? GRID_COLS_MULTIKILLS : GRID_COLS);

  // The team panel paints its own background rather than borrowing whatever is
  // behind it: inside the app that's the panel it sits in, but an exported card
  // has the page's gradient back there.
  return (
    <div class="panel overflow-hidden">
      {/* Team header: the result on the left, the team's totals on the right */}
      <div class="relative flex min-h-[68px] flex-wrap items-center gap-x-8 gap-y-3 border-b border-lol-line bg-black/20 py-3 pl-5 pr-3">
        <span
          class={["absolute inset-y-0 left-0 w-[3px]", isWin() ? "bg-lol-win" : "bg-lol-loss"]}
        />
        <span
          class={[
            "pointer-events-none absolute inset-y-0 left-0 w-1/2 bg-gradient-to-r to-transparent",
            isWin() ? "from-lol-win/[0.12]" : "from-lol-loss/[0.12]",
          ]}
        />
        <div class="relative flex items-baseline gap-3">
          <span
            class={[
              "font-display text-[24px] font-extrabold uppercase italic leading-none tracking-[0.03em]",
              isWin() ? "text-lol-win" : "text-lol-loss",
            ]}
          >
            {isWin() ? "Victory" : "Defeat"}
          </span>
          <span class="label">Team {props.teamId === 100 ? "1" : "2"}</span>
        </div>

        <div class="relative ml-auto flex items-center">
          <TeamStat label="Avg score">
            <span
              class={totals().avgScore != null ? scoreColor(totals().avgScore!) : "text-lol-text"}
            >
              {totals().avgScore != null ? formatDecimal(totals().avgScore!) : "-"}
            </span>
          </TeamStat>
          <TeamStat label="K / D / A">
            <span class="text-lol-text-bright">
              <Kda kills={totals().kills} deaths={totals().deaths} assists={totals().assists} />
            </span>
          </TeamStat>
          <TeamStat label="Damage">
            <span class="text-red-400">{formatCompact(totals().dmg)}</span>
          </TeamStat>
          <TeamStat label="Taken">
            <span class="text-sky-400">{formatCompact(totals().taken)}</span>
          </TeamStat>
          <TeamStat label="Healing">
            <span class="text-emerald-400">{formatCompact(totals().heal)}</span>
          </TeamStat>
          <TeamStat label="Gold">
            <span class="text-lol-gold">{formatCompact(totals().gold)}</span>
          </TeamStat>
        </div>
      </div>

      {/* Column heads */}
      <div
        class={["grid", grid(), "tbl-head h-9 items-center gap-2.5 bg-black/10 px-5 text-[12px]"]}
      >
        <span />
        <span>Player</span>
        <span class="text-center">Score</span>
        <span class="text-center">KDA</span>
        <span class={NARROW_ONLY}>Dmg · Taken · Heal</span>
        <span class={WIDE_ONLY}>Damage</span>
        <span class={WIDE_ONLY}>Taken</span>
        <span class={WIDE_ONLY}>Healing</span>
        <span class="text-right">Gold</span>
        <span class="pl-1">Items</span>
        <span>Augments</span>
        <span class={props.multikills ? "" : WIDE_ONLY}>Multikills</span>
      </div>

      {/* Player rows */}
      <For each={props.players} keyed={(p) => p.participantId}>
        {(p) => (
          <PlayerRow
            player={p()}
            maxStats={props.maxStats}
            champData={props.champData}
            score={props.scores.get(p().participantId)}
            patch={props.patch}
            grid={grid()}
            multikills={props.multikills}
          />
        )}
      </For>
    </div>
  );
}

function computeTeamTotals(players: ParsedParticipant[], scores: Map<number, ScoreBreakdown>) {
  const t = {
    kills: 0,
    deaths: 0,
    assists: 0,
    dmg: 0,
    taken: 0,
    gold: 0,
    heal: 0,
    avgScore: null as number | null,
  };
  let scoreSum = 0,
    scored = 0;

  for (const p of players) {
    t.kills += p.kills;
    t.deaths += p.deaths;
    t.assists += p.assists;
    t.dmg += p.totalDamageDealtToChampions;
    t.taken += p.totalDamageTaken;
    t.gold += p.goldEarned;
    t.heal += p.totalHeal;
    const s = scores.get(p.participantId);
    if (s) {
      scoreSum += s.score;
      scored++;
    }
  }
  if (scored > 0) t.avgScore = scoreSum / scored;
  return t;
}

// A team total: a small label over the number, set off from its neighbours by
// a hairline so the row reads as a broadcast stat strip.
function TeamStat(props: { label: string; children: JSX.Element }) {
  return (
    <div class="border-l border-lol-line px-4 first:border-l-0 whitespace-nowrap">
      <div class="label text-[11px] leading-none">{props.label}</div>
      <div class="font-num mt-1.5 text-[19px] font-semibold leading-none">{props.children}</div>
    </div>
  );
}

// One player's share of the lobby's best: the number over a bar in the match
// rows' StatBars palette. The number sits above rather than beside the bar so
// it can't be read as belonging to the next column. The lobby's own best gets
// its number in the bar's colour.
function ScoreboardBar(props: { value: number; max: number; color: string; text: string }) {
  const pct = () => (props.max > 0 ? Math.round((props.value / props.max) * 100) : 0);
  const top = () => props.value > 0 && props.value >= props.max;
  return (
    <div class={WIDE_ONLY}>
      <div
        class={[
          "font-num text-[14px] font-semibold leading-none",
          top() ? props.text : "text-lol-text-bright/90",
        ]}
      >
        {props.value > 0 ? formatCompact(props.value) : "—"}
      </div>
      <div class="mt-1.5 h-1.5 overflow-hidden rounded-[1px] bg-white/[0.06]">
        <div
          class={["h-full", { "opacity-75": !top() }, props.color]}
          style={{ width: `${pct()}%` }}
        />
      </div>
    </div>
  );
}

// The narrow layout's three bars in one cell: the match row's StatBars, set a
// size tighter so a scoreboard row stays near the height of its build grid.
function StackedBar(props: { label: string; value: number; max: number; color: string }) {
  const pct = () => (props.max > 0 ? Math.round((props.value / props.max) * 100) : 0);
  return (
    <div class="flex h-4 items-center gap-2">
      <span class="w-6 shrink-0 font-display text-[11px] font-bold tracking-[0.06em] text-lol-text">
        {props.label}
      </span>
      <div class="h-1 flex-1 overflow-hidden rounded-[1px] bg-white/[0.06]">
        <div class={["h-full opacity-80", props.color]} style={{ width: `${pct()}%` }} />
      </div>
      <span class="font-num w-9 shrink-0 text-right text-[12px] font-semibold leading-none text-lol-text-bright/90">
        {props.value > 0 ? formatCompact(props.value) : "—"}
      </span>
    </div>
  );
}

function PlayerRow(props: {
  player: ParsedParticipant;
  maxStats: MaxStats;
  champData: ChampionData;
  score?: ScoreBreakdown;
  patch?: string | null;
  grid: string;
  multikills: boolean;
}) {
  const p = () => props.player;

  return (
    <div
      class={[
        "relative grid",
        props.grid,
        "min-h-[54px] items-center gap-2.5 border-t border-lol-line px-5 py-2 transition-colors",
        p().isSelf
          ? "bg-gradient-to-r from-lol-gold/[0.13] via-lol-gold/[0.04] to-lol-gold/[0.02]"
          : "hover:bg-white/[0.025]",
      ]}
    >
      <Show when={p().isSelf}>
        <span class="absolute inset-y-0 left-0 w-[3px] bg-lol-gold" />
      </Show>

      {/* Champion + spells; two 18px spells and the 2px gap match the portrait */}
      <div class="flex items-center gap-1">
        <ChampionIcon championId={p().championId} size={38} />
        <div class="flex flex-col gap-0.5">
          <SummonerSpellIcon spellId={p().spell1Id} size={18} />
          <SummonerSpellIcon spellId={p().spell2Id} size={18} />
        </div>
      </div>

      {/* Player name */}
      <div class="min-w-0">
        <div
          class={[
            "truncate font-display text-[16px] font-semibold leading-tight",
            p().isSelf ? "text-lol-gold-light" : "text-lol-text-bright",
          ]}
        >
          <RiotId id={p().summonerName} />
        </div>
        <div class="truncate text-[12px] text-lol-text">
          {getChampionName(props.champData, p().championId)}
        </div>
      </div>

      {/* Score */}
      <ScoreCell score={props.score} />

      {/* KDA */}
      <div class="text-center">
        <div class="font-num text-[15px] font-semibold leading-tight text-lol-text-bright">
          <Kda kills={p().kills} deaths={p().deaths} assists={p().assists} />
        </div>
        <div
          class={[
            "font-num text-[12px] font-semibold",
            kdaHighlight(p().kills, p().deaths, p().assists),
          ]}
        >
          {kdaRatio(p().kills, p().deaths, p().assists)}
        </div>
      </div>

      <div class={["space-y-0.5", NARROW_ONLY]}>
        <StackedBar
          label="DMG"
          value={p().totalDamageDealtToChampions}
          max={props.maxStats.dmg}
          color="bg-red-400"
        />
        <StackedBar
          label="TKN"
          value={p().totalDamageTaken}
          max={props.maxStats.taken}
          color="bg-sky-400"
        />
        <StackedBar
          label="HEL"
          value={p().totalHeal}
          max={props.maxStats.heal}
          color="bg-emerald-400"
        />
      </div>
      <ScoreboardBar
        value={p().totalDamageDealtToChampions}
        max={props.maxStats.dmg}
        color="bg-red-400"
        text="text-red-400"
      />
      <ScoreboardBar
        value={p().totalDamageTaken}
        max={props.maxStats.taken}
        color="bg-sky-400"
        text="text-sky-400"
      />
      <ScoreboardBar
        value={p().totalHeal}
        max={props.maxStats.heal}
        color="bg-emerald-400"
        text="text-emerald-400"
      />

      {/* Gold */}
      <div class="font-num text-right text-[14px] font-semibold text-lol-gold">
        {formatCompact(p().goldEarned)}
      </div>

      {/* Items, with the trinket set a little apart */}
      <div class="flex items-center gap-1 pl-1">
        <div class="grid grid-cols-3 gap-[3px] @min-[1088px]:flex">
          <For each={p().items.slice(0, 6)} keyed={false}>
            {(itemId) => <ItemIcon itemId={itemId()} size={22} patch={props.patch} />}
          </For>
        </div>
        <ItemIcon itemId={p().items[6] ?? 0} size={22} patch={props.patch} />
      </div>

      {/* Augments: up to four in a line when the table is wide, otherwise two
          rows (three columns once there are more than four, as the match row
          lays them out), so a fifth or sixth never runs into the next column */}
      <div
        class={[
          "grid w-fit gap-[3px]",
          p().augments.length > 4 ? "grid-cols-3" : "grid-cols-2 @min-[1088px]:grid-cols-4",
        ]}
      >
        <For each={p().augments} keyed={false}>
          {(augId) => <AugmentIcon augmentId={augId()} size={22} patch={props.patch} />}
        </For>
      </div>

      {/* Multikills */}
      <div class={["min-w-0", props.multikills ? "flex" : "hidden @min-[1088px]:flex"]}>
        <MultikillBadge
          compact
          doubles={p().doubleKills}
          triples={p().tripleKills}
          quadras={p().quadraKills}
          pentas={p().pentaKills}
        />
      </div>
    </div>
  );
}

function ScoreCell(props: { score?: ScoreBreakdown }) {
  const [anchor, setAnchor] = createSignal<DOMRect | null>(null);

  return (
    <div
      class={["text-center", { "cursor-help": !!props.score }]}
      onMouseEnter={(e) => setAnchor(e.currentTarget.getBoundingClientRect())}
      onMouseLeave={() => setAnchor(null)}
    >
      <div
        class={[
          "font-num text-[18px] font-semibold leading-none",
          props.score ? scoreColor(props.score.score) : "text-lol-text",
        ]}
      >
        {props.score ? formatDecimal(props.score.score) : "-"}
      </div>
      <Show when={props.score?.badge}>
        {(badge) => (
          <div class="mt-1">
            <ScoreBadge badge={badge()} />
          </div>
        )}
      </Show>
      <Show when={props.score && anchor() ? { score: props.score!, anchor: anchor()! } : null}>
        {(shown) => <ScoreBreakdownTooltip breakdown={shown().score} anchor={shown().anchor} />}
      </Show>
    </div>
  );
}

const COMPONENT_LABELS: Record<ScoreComponentKey, string> = {
  kda: "KDA",
  kp: "Kill participation",
  dmg: "Damage dealt",
  taken: "Damage taken",
  heal: "Healing",
  gold: "Gold earned",
};

// How the player's stat and its full-credit reference read in the tooltip:
// kda/kp are graded against fixed caps, the rest against the lobby's best.
function componentValue(c: ScoreComponent): string {
  if (c.key === "kda") return `${formatDecimal(c.value)} (full at 8)`;
  if (c.key === "kp") return `${formatPercent(c.value, 0)} (full at ${formatPercent(0.9, 0)})`;
  return `${formatCompact(c.value)} / ${formatCompact(c.reference)}`;
}

function ScoreBreakdownTooltip(props: { breakdown: ScoreBreakdown; anchor: DOMRect }) {
  const b = () => props.breakdown;
  const width = 288;
  const layout = () => {
    const rows =
      b().components.length + (b().multikill ? 1 : 0) + (b().carry ? 1 : 0) + (b().win > 0 ? 1 : 0);
    const height = 74 + rows * 20;
    // Fixed positioning escapes the team card's overflow-hidden; clamp to the
    // viewport so rows near the window edges stay readable.
    const left = Math.min(props.anchor.right + 10, window.innerWidth - width - 8);
    const top = Math.min(
      Math.max(props.anchor.top + props.anchor.height / 2 - height / 2, 8),
      window.innerHeight - height - 8,
    );
    return { left, top };
  };
  const clamped = () => b().raw !== b().score && (b().raw > 10 || b().raw < 1);

  return (
    <div
      class="menu fixed z-50 pointer-events-none px-3.5 py-2.5 text-left"
      style={{ left: `${layout().left}px`, top: `${layout().top}px`, width: `${width}px` }}
    >
      <div class="mb-1.5 flex items-baseline justify-between border-b border-lol-line pb-1.5">
        <span class="font-display text-[14px] font-bold uppercase tracking-[0.06em] text-lol-text-bright">
          Score breakdown
        </span>
        <span class="label text-[11px]">{b().cls ? `${b().cls} weights` : "Standard weights"}</span>
      </div>
      <For each={b().components} keyed={(c) => c.key}>
        {(c) => (
          <BreakdownRow
            label={COMPONENT_LABELS[c().key]}
            detail={componentValue(c())}
            value={
              <>
                {formatDecimal(c().points)}
                <span class="text-lol-text"> / {formatDecimal(c().weight)}</span>
              </>
            }
          />
        )}
      </For>
      <Show when={b().multikill}>
        {(multikill) => (
          <BreakdownRow
            label={`${multikill().label} bonus`}
            value={`+${formatDecimal(multikill().points)}`}
          />
        )}
      </Show>
      <Show when={b().carry}>
        {(carry) => (
          <BreakdownRow
            label="Carry bonus"
            detail={`${formatDecimal(carry().lead, 2)}× next best`}
            value={`+${formatDecimal(carry().points)}`}
          />
        )}
      </Show>
      <Show when={b().win > 0}>
        <BreakdownRow label="Victory bonus" value={`+${formatDecimal(b().win)}`} />
      </Show>
      <div class="mt-1 grid grid-cols-[1fr_auto] items-baseline gap-2 border-t border-lol-line pt-1.5">
        <span class="text-[12px] font-semibold text-lol-text-bright">
          Total
          {clamped()
            ? ` ${formatDecimal(b().raw, 2)}, ${b().raw > 10 ? "capped" : "floored"} at`
            : ""}
        </span>
        <span class={["font-num text-[17px] font-semibold leading-none", scoreColor(b().score)]}>
          {formatDecimal(b().score)}
        </span>
      </div>
    </div>
  );
}

function BreakdownRow(props: { label: string; detail?: string; value: JSX.Element }) {
  return (
    <div class="grid grid-cols-[1fr_auto] items-baseline gap-2 leading-5">
      <span class="truncate text-[12px] text-lol-text">
        {props.label}
        <Show when={props.detail}>
          <span class="ml-1.5 text-[12px] text-lol-text/85">{props.detail}</span>
        </Show>
      </span>
      <span class="font-num text-[13px] font-semibold text-lol-text-bright">{props.value}</span>
    </div>
  );
}
