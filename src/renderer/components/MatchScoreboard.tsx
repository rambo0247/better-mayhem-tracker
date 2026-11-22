import { useMemo, useState, type ReactNode } from "react";
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
import {
  computeMatchScoreBreakdowns,
  type ScoreBreakdown,
  type ScoreComponent,
  type ScoreComponentKey,
} from "../../shared/opScore";
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

export default function MatchScoreboard({
  detail,
  champData,
  puuids,
  multikills = false,
}: {
  detail: MatchDetail;
  champData: ChampionData;
  puuids: string[] | null;
  // The wide layout always has the column; this keeps it in the narrow one too
  multikills?: boolean;
}) {
  const participants = useMemo(
    () => parseParticipants(detail.participants, puuids),
    [detail, puuids],
  );
  // The user's own team leads, so the first block under a match row reads as
  // that row's result. Display order only: team numbers stay as recorded.
  const teams = useMemo(
    () =>
      Array.from(groupByTeam(participants).entries()).sort(
        ([, a], [, b]) => Number(b.some((p) => p.isSelf)) - Number(a.some((p) => p.isSelf)),
      ),
    [participants],
  );
  const scores = useMemo(() => {
    const classes: Record<number, string | undefined> = {};
    for (const p of participants) classes[p.championId] = champData[p.championId]?.class;
    return computeMatchScoreBreakdowns(participants, classes);
  }, [participants, champData]);

  const gameMaxStats = useMemo(() => {
    let dmg = 0,
      taken = 0,
      gold = 0,
      heal = 0;
    for (const p of participants) {
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
  }, [participants]);

  if (participants.length === 0) {
    return (
      <div className="py-6 text-center text-[13px] text-lol-text">
        Full game data not available.
      </div>
    );
  }

  return (
    <div className="@container space-y-3">
      {teams.map(([teamId, players]) => (
        <TeamScoreboard
          key={teamId}
          teamId={teamId}
          players={players}
          maxStats={gameMaxStats}
          champData={champData}
          scores={scores}
          patch={detail.game.game_version}
          multikills={multikills}
        />
      ))}
    </div>
  );
}

function TeamScoreboard({
  teamId,
  players,
  maxStats,
  champData,
  scores,
  patch,
  multikills,
}: {
  teamId: number;
  players: ParsedParticipant[];
  maxStats: MaxStats;
  champData: ChampionData;
  scores: Map<number, ScoreBreakdown>;
  patch?: string | null;
  multikills: boolean;
}) {
  const isWin = players[0]?.win ?? false;
  const totals = useMemo(() => computeTeamTotals(players, scores), [players, scores]);
  const grid = multikills ? GRID_COLS_MULTIKILLS : GRID_COLS;

  // The team panel paints its own background rather than borrowing whatever is
  // behind it: inside the app that's the panel it sits in, but an exported card
  // has the page's gradient back there.
  return (
    <div className="panel overflow-hidden">
      {/* Team header: the result on the left, the team's totals on the right */}
      <div className="relative flex min-h-[68px] flex-wrap items-center gap-x-8 gap-y-3 border-b border-lol-line bg-black/20 py-3 pl-5 pr-3">
        <span
          className={`absolute inset-y-0 left-0 w-[3px] ${isWin ? "bg-lol-win" : "bg-lol-loss"}`}
        />
        <span
          className={`pointer-events-none absolute inset-y-0 left-0 w-1/2 bg-gradient-to-r ${
            isWin ? "from-lol-win/[0.12]" : "from-lol-loss/[0.12]"
          } to-transparent`}
        />
        <div className="relative flex items-baseline gap-3">
          <span
            className={`font-display text-[24px] font-extrabold uppercase italic leading-none tracking-[0.03em] ${
              isWin ? "text-lol-win" : "text-lol-loss"
            }`}
          >
            {isWin ? "Victory" : "Defeat"}
          </span>
          <span className="label">Team {teamId === 100 ? "1" : "2"}</span>
        </div>

        <div className="relative ml-auto flex items-center">
          <TeamStat label="Avg score">
            <span
              className={totals.avgScore != null ? scoreColor(totals.avgScore) : "text-lol-text"}
            >
              {totals.avgScore != null ? formatDecimal(totals.avgScore) : "-"}
            </span>
          </TeamStat>
          <TeamStat label="K / D / A">
            <span className="text-lol-text-bright">
              <Kda kills={totals.kills} deaths={totals.deaths} assists={totals.assists} />
            </span>
          </TeamStat>
          <TeamStat label="Damage">
            <span className="text-red-400">{formatCompact(totals.dmg)}</span>
          </TeamStat>
          <TeamStat label="Taken">
            <span className="text-sky-400">{formatCompact(totals.taken)}</span>
          </TeamStat>
          <TeamStat label="Healing">
            <span className="text-emerald-400">{formatCompact(totals.heal)}</span>
          </TeamStat>
          <TeamStat label="Gold">
            <span className="text-lol-gold">{formatCompact(totals.gold)}</span>
          </TeamStat>
        </div>
      </div>

      {/* Column heads */}
      <div
        className={`grid ${grid} tbl-head h-9 items-center gap-2.5 bg-black/10 px-5 text-[12px]`}
      >
        <span />
        <span>Player</span>
        <span className="text-center">Score</span>
        <span className="text-center">KDA</span>
        <span className={NARROW_ONLY}>Dmg · Taken · Heal</span>
        <span className={WIDE_ONLY}>Damage</span>
        <span className={WIDE_ONLY}>Taken</span>
        <span className={WIDE_ONLY}>Healing</span>
        <span className="text-right">Gold</span>
        <span className="pl-1">Items</span>
        <span>Augments</span>
        <span className={multikills ? "" : WIDE_ONLY}>Multikills</span>
      </div>

      {/* Player rows */}
      {players.map((p) => (
        <PlayerRow
          key={p.participantId}
          player={p}
          maxStats={maxStats}
          champData={champData}
          score={scores.get(p.participantId)}
          patch={patch}
          grid={grid}
          multikills={multikills}
        />
      ))}
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
function TeamStat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="border-l border-lol-line px-4 first:border-l-0 whitespace-nowrap">
      <div className="label text-[11px] leading-none">{label}</div>
      <div className="font-num mt-1.5 text-[19px] font-semibold leading-none">{children}</div>
    </div>
  );
}

// One player's share of the lobby's best: the number over a bar in the match
// rows' StatBars palette. The number sits above rather than beside the bar so
// it can't be read as belonging to the next column. The lobby's own best gets
// its number in the bar's colour.
function ScoreboardBar({
  value,
  max,
  color,
  text,
}: {
  value: number;
  max: number;
  color: string;
  text: string;
}) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  const top = value > 0 && value >= max;
  return (
    <div className={WIDE_ONLY}>
      <div
        className={`font-num text-[14px] font-semibold leading-none ${
          top ? text : "text-lol-text-bright/90"
        }`}
      >
        {value > 0 ? formatCompact(value) : "—"}
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-[1px] bg-white/[0.06]">
        <div
          className={`h-full ${top ? "" : "opacity-75"} ${color}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

// The narrow layout's three bars in one cell: the match row's StatBars, set a
// size tighter so a scoreboard row stays near the height of its build grid.
function StackedBar({
  label,
  value,
  max,
  color,
}: {
  label: string;
  value: number;
  max: number;
  color: string;
}) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className="flex h-4 items-center gap-2">
      <span className="w-6 shrink-0 font-display text-[11px] font-bold tracking-[0.06em] text-lol-text">
        {label}
      </span>
      <div className="h-1 flex-1 overflow-hidden rounded-[1px] bg-white/[0.06]">
        <div className={`h-full opacity-80 ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="font-num w-9 shrink-0 text-right text-[12px] font-semibold leading-none text-lol-text-bright/90">
        {value > 0 ? formatCompact(value) : "—"}
      </span>
    </div>
  );
}

function PlayerRow({
  player: p,
  maxStats,
  champData,
  score,
  patch,
  grid,
  multikills,
}: {
  player: ParsedParticipant;
  maxStats: MaxStats;
  champData: ChampionData;
  score?: ScoreBreakdown;
  patch?: string | null;
  grid: string;
  multikills: boolean;
}) {
  const kda = kdaRatio(p.kills, p.deaths, p.assists);

  return (
    <div
      className={`relative grid ${grid} min-h-[54px] items-center gap-2.5 border-t border-lol-line px-5 py-2 transition-colors ${
        p.isSelf
          ? "bg-gradient-to-r from-lol-gold/[0.13] via-lol-gold/[0.04] to-lol-gold/[0.02]"
          : "hover:bg-white/[0.025]"
      }`}
    >
      {p.isSelf && <span className="absolute inset-y-0 left-0 w-[3px] bg-lol-gold" />}

      {/* Champion + spells; two 18px spells and the 2px gap match the portrait */}
      <div className="flex items-center gap-1">
        <ChampionIcon championId={p.championId} size={38} />
        <div className="flex flex-col gap-0.5">
          <SummonerSpellIcon spellId={p.spell1Id} size={18} />
          <SummonerSpellIcon spellId={p.spell2Id} size={18} />
        </div>
      </div>

      {/* Player name */}
      <div className="min-w-0">
        <div
          className={`truncate font-display text-[16px] font-semibold leading-tight ${
            p.isSelf ? "text-lol-gold-light" : "text-lol-text-bright"
          }`}
        >
          <RiotId id={p.summonerName} />
        </div>
        <div className="truncate text-[12px] text-lol-text">
          {getChampionName(champData, p.championId)}
        </div>
      </div>

      {/* Score */}
      <ScoreCell score={score} />

      {/* KDA */}
      <div className="text-center">
        <div className="font-num text-[15px] font-semibold leading-tight text-lol-text-bright">
          <Kda kills={p.kills} deaths={p.deaths} assists={p.assists} />
        </div>
        <div
          className={`font-num text-[12px] font-semibold ${kdaHighlight(p.kills, p.deaths, p.assists)}`}
        >
          {kda}
        </div>
      </div>

      <div className={`space-y-0.5 ${NARROW_ONLY}`}>
        <StackedBar
          label="DMG"
          value={p.totalDamageDealtToChampions}
          max={maxStats.dmg}
          color="bg-red-400"
        />
        <StackedBar
          label="TKN"
          value={p.totalDamageTaken}
          max={maxStats.taken}
          color="bg-sky-400"
        />
        <StackedBar label="HEL" value={p.totalHeal} max={maxStats.heal} color="bg-emerald-400" />
      </div>
      <ScoreboardBar
        value={p.totalDamageDealtToChampions}
        max={maxStats.dmg}
        color="bg-red-400"
        text="text-red-400"
      />
      <ScoreboardBar
        value={p.totalDamageTaken}
        max={maxStats.taken}
        color="bg-sky-400"
        text="text-sky-400"
      />
      <ScoreboardBar
        value={p.totalHeal}
        max={maxStats.heal}
        color="bg-emerald-400"
        text="text-emerald-400"
      />

      {/* Gold */}
      <div className="font-num text-right text-[14px] font-semibold text-lol-gold">
        {formatCompact(p.goldEarned)}
      </div>

      {/* Items, with the trinket set a little apart */}
      <div className="flex items-center gap-1 pl-1">
        <div className="grid grid-cols-3 gap-[3px] @min-[1088px]:flex">
          {p.items.slice(0, 6).map((itemId, i) => (
            <ItemIcon key={i} itemId={itemId} size={22} patch={patch} />
          ))}
        </div>
        <ItemIcon itemId={p.items[6] ?? 0} size={22} patch={patch} />
      </div>

      {/* Augments: up to four in a line when the table is wide, otherwise two
          rows (three columns once there are more than four, as the match row
          lays them out), so a fifth or sixth never runs into the next column */}
      <div
        className={`grid w-fit gap-[3px] ${
          p.augments.length > 4 ? "grid-cols-3" : "grid-cols-2 @min-[1088px]:grid-cols-4"
        }`}
      >
        {p.augments.map((augId, i) => (
          <AugmentIcon key={i} augmentId={augId} size={22} patch={patch} />
        ))}
      </div>

      {/* Multikills */}
      <div className={`min-w-0 ${multikills ? "flex" : "hidden @min-[1088px]:flex"}`}>
        <MultikillBadge
          compact
          doubles={p.doubleKills}
          triples={p.tripleKills}
          quadras={p.quadraKills}
          pentas={p.pentaKills}
        />
      </div>
    </div>
  );
}

function ScoreCell({ score }: { score?: ScoreBreakdown }) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);

  return (
    <div
      className={`text-center ${score ? "cursor-help" : ""}`}
      onMouseEnter={(e) => setAnchor(e.currentTarget.getBoundingClientRect())}
      onMouseLeave={() => setAnchor(null)}
    >
      <div
        className={`font-num text-[18px] font-semibold leading-none ${score ? scoreColor(score.score) : "text-lol-text"}`}
      >
        {score ? formatDecimal(score.score) : "-"}
      </div>
      {score?.badge && (
        <div className="mt-1">
          <ScoreBadge badge={score.badge} />
        </div>
      )}
      {score && anchor && <ScoreBreakdownTooltip breakdown={score} anchor={anchor} />}
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

function ScoreBreakdownTooltip({
  breakdown,
  anchor,
}: {
  breakdown: ScoreBreakdown;
  anchor: DOMRect;
}) {
  const rows =
    breakdown.components.length +
    (breakdown.multikill ? 1 : 0) +
    (breakdown.carry ? 1 : 0) +
    (breakdown.win > 0 ? 1 : 0);
  const width = 288;
  const height = 74 + rows * 20;
  // Fixed positioning escapes the team card's overflow-hidden; clamp to the
  // viewport so rows near the window edges stay readable.
  const left = Math.min(anchor.right + 10, window.innerWidth - width - 8);
  const top = Math.min(
    Math.max(anchor.top + anchor.height / 2 - height / 2, 8),
    window.innerHeight - height - 8,
  );
  const clamped = breakdown.raw !== breakdown.score && (breakdown.raw > 10 || breakdown.raw < 1);

  return (
    <div
      className="menu fixed z-50 pointer-events-none px-3.5 py-2.5 text-left"
      style={{ left, top, width }}
    >
      <div className="mb-1.5 flex items-baseline justify-between border-b border-lol-line pb-1.5">
        <span className="font-display text-[14px] font-bold uppercase tracking-[0.06em] text-lol-text-bright">
          Score breakdown
        </span>
        <span className="label text-[11px]">
          {breakdown.cls ? `${breakdown.cls} weights` : "Standard weights"}
        </span>
      </div>
      {breakdown.components.map((c) => (
        <BreakdownRow
          key={c.key}
          label={COMPONENT_LABELS[c.key]}
          detail={componentValue(c)}
          value={
            <>
              {formatDecimal(c.points)}
              <span className="text-lol-text"> / {formatDecimal(c.weight)}</span>
            </>
          }
        />
      ))}
      {breakdown.multikill && (
        <BreakdownRow
          label={`${breakdown.multikill.label} bonus`}
          value={`+${formatDecimal(breakdown.multikill.points)}`}
        />
      )}
      {breakdown.carry && (
        <BreakdownRow
          label="Carry bonus"
          detail={`${formatDecimal(breakdown.carry.lead, 2)}× next best`}
          value={`+${formatDecimal(breakdown.carry.points)}`}
        />
      )}
      {breakdown.win > 0 && (
        <BreakdownRow label="Victory bonus" value={`+${formatDecimal(breakdown.win)}`} />
      )}
      <div className="mt-1 grid grid-cols-[1fr_auto] items-baseline gap-2 border-t border-lol-line pt-1.5">
        <span className="text-[12px] font-semibold text-lol-text-bright">
          Total
          {clamped
            ? ` ${formatDecimal(breakdown.raw, 2)}, ${breakdown.raw > 10 ? "capped" : "floored"} at`
            : ""}
        </span>
        <span
          className={`font-num text-[17px] font-semibold leading-none ${scoreColor(breakdown.score)}`}
        >
          {formatDecimal(breakdown.score)}
        </span>
      </div>
    </div>
  );
}

function BreakdownRow({
  label,
  detail,
  value,
}: {
  label: string;
  detail?: string;
  value: ReactNode;
}) {
  return (
    <div className="grid grid-cols-[1fr_auto] items-baseline gap-2 leading-5">
      <span className="truncate text-[12px] text-lol-text">
        {label}
        {detail && <span className="ml-1.5 text-[12px] text-lol-text/85">{detail}</span>}
      </span>
      <span className="font-num text-[13px] font-semibold text-lol-text-bright">{value}</span>
    </div>
  );
}
