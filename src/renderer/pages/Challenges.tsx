import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useLcuStatus } from "../hooks/useLcuStatus";
import { useChampionData, getChampionName } from "../hooks/useChampions";
import type {
  ChallengeLevel,
  ChallengeProgress,
  ChallengesData,
  ChallengesResult,
} from "../lib/types";
import ChallengeToken from "../components/ChallengeToken";
import ChampionIcon from "../components/ChampionIcon";
import PageHeader from "../components/PageHeader";
import { AwardIcon, ChevronDownIcon } from "../components/icons";
import { LOCALE, formatPercent } from "../lib/format";
import {
  CHALLENGE_LEVEL_COLORS as LEVEL_COLORS,
  challengeLevelName as levelName,
  formatChallengeValue as formatValue,
} from "../lib/challenges";
import { challengeFraction } from "../../shared/challenges";

// Every challenge row and the head of its category share these columns, so the
// category's own bar lines up over the bars of the challenges under it.
// The text column is capped so the bar sits beside the words rather than across
// the page from them.
const ROW_COLS = "grid grid-cols-[44px_minmax(260px,460px)_minmax(420px,1fr)] items-center gap-x-6";

// Snapshot days are stored as YYYY-MM-DD, which is a key, not a date to read.
function formatDay(day: string): string {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year, month - 1, date).toLocaleDateString(LOCALE, {
    month: "short",
    day: "numeric",
  });
}

function percentileLabel(challenge: ChallengeProgress): string | null {
  if (challenge.level === "NONE" || challenge.percentile >= 100) return null;
  return `top ${formatPercent(challenge.percentile / 100)}`;
}

// Points are on every tier and already shown as the challenge's own value, so
// the only reward worth a line is the kind you can wear.
function rewardNote(challenge: ChallengeProgress): string | null {
  const title = challenge.nextRewards.find((r) => r.category === "TITLE" && r.name);
  if (!title) return null;
  return `${levelName(challenge.nextLevel)} unlocks the "${title.name}" title`;
}

// The category heads and challenges each scroll to their own section, so the
// overview at the top can double as a table of contents.
function groupAnchor(id: number): string {
  return `challenge-group-${id}`;
}

// A tier name in the tier's own colour, on a faint wash of it. The colours are
// data, so they go in inline.
function TierTag({ level, className = "" }: { level: ChallengeLevel; className?: string }) {
  const color = LEVEL_COLORS[level];
  return (
    <span
      className={`chip shrink-0 ${className}`}
      style={{
        color,
        backgroundColor: `${color}1c`,
        boxShadow: `inset 0 0 0 1px ${color}38`,
      }}
    >
      {levelName(level)}
    </span>
  );
}

// How far through the current tier. The distance left to the next one is read
// off the empty remainder, so no row spells that out in figures. Every bar
// fills in the same gold: the tier colours include reds and greys that would
// read as warnings or disabled states on a bar, so a tier's colour appears only
// on the chips naming a tier.
function TierBar({
  challenge,
  className = "",
}: {
  challenge: ChallengeProgress;
  className?: string;
}) {
  const fraction = challengeFraction(
    challenge.value,
    challenge.currentThreshold,
    challenge.nextThreshold,
  );
  const maxed = challenge.nextThreshold == null;

  return (
    <div className={`h-1.5 overflow-hidden rounded-[2px] bg-white/[0.06] ${className}`}>
      <div
        className={`h-full rounded-[2px] bg-gradient-to-r transition-all ${
          maxed ? "from-lol-gold to-lol-gold-light" : "from-lol-gold/45 to-lol-gold"
        }`}
        style={{ width: `${fraction * 100}%` }}
      />
    </div>
  );
}

// One line per challenge: the bar, the figures at its end, and the tier it is
// filling toward (or that it's done) in a fixed-width chip. Every slot after
// the bar is a fixed width, so bars, figures and chips line up down a section
// whatever the row holds.
function ProgressTrack({
  challenge,
  doneLabel,
  large = false,
  className = "",
}: {
  challenge: ChallengeProgress;
  // "Complete" for a challenge, "Maxed" for a category or the capstone
  doneLabel: string;
  large?: boolean;
  className?: string;
}) {
  return (
    <div className={`flex items-center gap-4 ${className}`}>
      <TierBar challenge={challenge} className={`min-w-0 flex-1 ${large ? "h-2" : ""}`} />
      {/* A finished challenge still earns progress, and the client still
          reports it, so the badge shows there too */}
      <div className="flex w-[132px] shrink-0 items-baseline justify-end gap-2">
        <DeltaBadge delta={challenge.delta} />
        <ValueFigure
          challenge={challenge}
          className={`font-semibold ${large ? "text-[18px]" : "text-[15px]"}`}
        />
      </div>
      {challenge.nextLevel ? (
        <span
          className="chip w-[104px] shrink-0 justify-center border border-lol-border text-lol-text"
          title={`Next tier: ${levelName(challenge.nextLevel)}`}
        >
          {levelName(challenge.nextLevel)}
        </span>
      ) : (
        <span className="chip w-[104px] shrink-0 justify-center border border-lol-gold/35 bg-lol-gold/12 text-lol-gold">
          {doneLabel}
        </span>
      )}
    </div>
  );
}

// Progress since the baseline snapshot. It sits alone in its slot: next to a
// tier name it read as the distance to that tier, which it is not.
function DeltaBadge({ delta, className = "" }: { delta: number | null; className?: string }) {
  if (delta == null || delta <= 0) return null;
  return (
    <span
      className={`font-num text-[13px] font-semibold whitespace-nowrap text-lol-win ${className}`}
    >
      +{formatValue(delta)}
    </span>
  );
}

// The value against the next threshold, or alone once there is none.
function ValueFigure({
  challenge,
  className = "",
}: {
  challenge: ChallengeProgress;
  className?: string;
}) {
  return (
    <span className={`font-num whitespace-nowrap text-lol-text-bright ${className}`}>
      {formatValue(challenge.value)}
      {challenge.nextThreshold != null && (
        <span className="text-lol-text/70"> / {formatValue(challenge.nextThreshold)}</span>
      )}
    </span>
  );
}

// ---- Champion progress ----

// Which champions a per-champion challenge still wants, and which it already
// has. Alphabetical both ways, so a particular champion can be looked up rather
// than hunted for.
function ChampionProgress({ completedIds }: { completedIds: number[] }) {
  const champData = useChampionData();
  const [showEarned, setShowEarned] = useState(false);

  const { remaining, earned } = useMemo(() => {
    const done = new Set(completedIds);
    // Champion data is the roster; a completed id missing from it (a champion
    // released since the cache was written) still belongs in the count.
    const ids = [...new Set([...Object.keys(champData).map(Number), ...completedIds])];
    const byName = (a: number, b: number) =>
      getChampionName(champData, a).localeCompare(getChampionName(champData, b));
    return {
      remaining: ids.filter((id) => !done.has(id)).sort(byName),
      earned: ids.filter((id) => done.has(id)).sort(byName),
    };
  }, [champData, completedIds]);

  const grid = (ids: number[], done: boolean) => (
    <div className="flex flex-wrap gap-1.5">
      {ids.map((id) => (
        <ChampionIcon
          key={id}
          championId={id}
          size={48}
          rounded={false}
          title={getChampionName(champData, id)}
          // The ones still to earn are the actionable half of this grid, so they
          // stay legible; the ring is what marks the others done.
          className={done ? "ring-2 ring-lol-gold/70" : "opacity-75 hover:opacity-100"}
        />
      ))}
    </div>
  );

  return (
    <div className="space-y-3">
      <div className="label">
        Champions left <span className="font-num text-lol-text-bright">{remaining.length}</span>
      </div>
      {remaining.length > 0 ? (
        grid(remaining, false)
      ) : (
        <div className="text-[13px] text-lol-text">Every champion done.</div>
      )}

      <button
        onClick={() => setShowEarned((open) => !open)}
        className="label flex items-center gap-1.5 transition-colors hover:text-lol-text-bright cursor-pointer"
      >
        <ChevronDownIcon
          className={`h-3.5 w-3.5 transition-transform ${showEarned ? "" : "-rotate-90"}`}
        />
        Champions earned <span className="font-num text-lol-text-bright">{earned.length}</span>
      </button>
      {showEarned && grid(earned, true)}
    </div>
  );
}

// ---- Challenge rows ----

function ChallengeRow({ challenge }: { challenge: ChallengeProgress }) {
  const [expanded, setExpanded] = useState(false);
  const champions = challenge.completedChampionIds;
  const percentile = percentileLabel(challenge);
  const reward = rewardNote(challenge);

  return (
    <div className="border-t border-lol-line transition-colors hover:bg-white/[0.02]">
      <div className={`${ROW_COLS} px-5 py-3.5`}>
        <ChallengeToken iconPath={challenge.iconPath} size={44} dim={challenge.level === "NONE"} />
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate font-display text-[16px] font-semibold leading-tight text-lol-text-bright">
              {challenge.name}
            </span>
            <TierTag level={challenge.level} />
            {percentile && (
              <span className="font-num shrink-0 text-[13px] text-lol-text/80">{percentile}</span>
            )}
          </div>
          <div className="mt-0.5 text-[13px] leading-snug text-lol-text">
            {challenge.description}
          </div>
          {reward && <div className="mt-1 text-[12px] font-medium text-lol-gold">{reward}</div>}
          {champions && (
            <button
              onClick={() => setExpanded((open) => !open)}
              aria-expanded={expanded}
              className="label mt-1.5 flex items-center gap-1 text-[11px] text-lol-gold transition-colors hover:text-lol-gold-light cursor-pointer"
            >
              <ChevronDownIcon
                className={`h-3 w-3 transition-transform ${expanded ? "" : "-rotate-90"}`}
              />
              Champions
            </button>
          )}
        </div>

        <ProgressTrack challenge={challenge} doneLabel="Complete" />
      </div>
      {champions && expanded && (
        <div className="border-t border-lol-line bg-black/20 py-4 pr-5 pl-[84px]">
          <ChampionProgress completedIds={champions} />
        </div>
      )}
    </div>
  );
}

function GroupCard({ group }: { group: ChallengesData["groups"][number] }) {
  const { summary } = group;

  return (
    <section id={groupAnchor(summary.id)} className="panel scroll-mt-4 overflow-hidden">
      <div className={`${ROW_COLS} bg-black/20 px-5 py-3`}>
        <ChallengeToken iconPath={summary.iconPath} size={44} dim={summary.level === "NONE"} />
        <div className="flex min-w-0 items-center gap-2.5">
          <h2 className="section-title truncate">{summary.name}</h2>
          <TierTag level={summary.level} />
          <span className="font-num shrink-0 text-[13px] text-lol-text/70">
            {group.challenges.length} challenges
          </span>
        </div>
        {/* As wide as the rows underneath, so a full bar reads as full */}
        <ProgressTrack challenge={summary} doneLabel="Maxed" />
      </div>
      <div>
        {group.challenges.map((challenge) => (
          <ChallengeRow key={challenge.id} challenge={challenge} />
        ))}
      </div>
    </section>
  );
}

// ---- Headline cards ----

// A soft halo in the tier's colour behind a token, so the headline tokens read
// as lit rather than pasted on.
function Halo({ level, className }: { level: ChallengeLevel; className: string }) {
  const style: CSSProperties = {
    background: `radial-gradient(closest-side, ${LEVEL_COLORS[level]}40, transparent)`,
  };
  return (
    <span className={`pointer-events-none absolute rounded-full ${className}`} style={style} />
  );
}

// The capstone, with the categories that level it laid out underneath as a
// summary of the sections below. Each one jumps to its section.
function CapstoneCard({
  capstone,
  groups,
}: {
  capstone: ChallengeProgress;
  groups: ChallengesData["groups"];
}) {
  const percentile = percentileLabel(capstone);
  const color = LEVEL_COLORS[capstone.level];

  return (
    <div className="panel relative flex flex-col overflow-hidden">
      <span
        className="pointer-events-none absolute inset-x-0 top-0 h-px"
        style={{ background: `linear-gradient(90deg, ${color}cc, ${color}33 45%, transparent)` }}
      />
      <div className="relative flex items-center gap-5 p-5">
        <div className="relative shrink-0">
          <Halo level={capstone.level} className="-inset-6" />
          <ChallengeToken
            iconPath={capstone.iconPath}
            size={88}
            dim={capstone.level === "NONE"}
            className="relative"
          />
        </div>
        <div className="min-w-0 flex-1">
          <div className="label">{capstone.name}</div>
          <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span
              className="font-display text-[34px] font-extrabold uppercase italic leading-none tracking-[0.01em]"
              style={{ color }}
            >
              {levelName(capstone.level)}
            </span>
            {percentile && <span className="font-num text-[14px] text-lol-text">{percentile}</span>}
          </div>
          <ProgressTrack challenge={capstone} doneLabel="Maxed" large className="mt-4" />
        </div>
      </div>

      {groups.length > 0 && (
        <div
          className="mt-auto grid border-t border-lol-line bg-black/15"
          style={{ gridTemplateColumns: `repeat(${groups.length}, minmax(0, 1fr))` }}
        >
          {groups.map(({ summary }) => (
            <button
              key={summary.id}
              onClick={() =>
                document
                  .getElementById(groupAnchor(summary.id))
                  ?.scrollIntoView({ behavior: "smooth", block: "start" })
              }
              title={`Jump to ${summary.name}`}
              className="flex min-w-0 items-center gap-2.5 border-l border-lol-line px-4 py-3 text-left transition-colors first:border-l-0 hover:bg-white/[0.03] cursor-pointer"
            >
              <ChallengeToken
                iconPath={summary.iconPath}
                size={32}
                dim={summary.level === "NONE"}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate font-display text-[14px] font-semibold text-lol-text-bright">
                    {summary.name}
                  </span>
                  <span
                    className="label shrink-0 text-[11px]"
                    style={{ color: LEVEL_COLORS[summary.level] }}
                  >
                    {levelName(summary.level)}
                  </span>
                </div>
                <TierBar challenge={summary} className="mt-1.5 h-1" />
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function PlayerCard({ data }: { data: ChallengesData }) {
  const { player } = data;
  const color = LEVEL_COLORS[player.level];

  return (
    <div className="panel relative flex flex-col overflow-hidden p-5">
      {/* A wash of gold behind the rank, as the profile card on Match History */}
      <span className="pointer-events-none absolute -right-16 -top-24 h-64 w-64 rounded-full bg-lol-gold/[0.06] blur-3xl" />
      <span className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-lol-gold/80 via-lol-gold/30 to-transparent" />

      <div className="relative flex items-center gap-2">
        <span className="flex h-6 w-6 items-center justify-center rounded-md bg-lol-gold/12 text-lol-gold">
          <AwardIcon className="h-3.5 w-3.5" />
        </span>
        <span className="label">Challenge rank</span>
        {player.percentile < 100 && (
          <span className="font-num ml-auto text-[13px] text-lol-text">
            top {formatPercent(player.percentile / 100)} overall
          </span>
        )}
      </div>

      <div className="relative mt-3">
        <div
          className="font-display text-[34px] font-extrabold uppercase italic leading-none tracking-[0.01em]"
          style={{ color }}
        >
          {levelName(player.level)}
        </div>
        <div className="mt-2.5 flex flex-wrap items-baseline gap-x-2">
          <span className="font-num text-[22px] font-semibold leading-none text-lol-text-bright">
            {player.points.toLocaleString(LOCALE)}
          </span>
          <span className="label">points</span>
        </div>
        {player.pointsUntilNextRank > 0 && (
          <div className="mt-1 text-[13px] text-lol-text">
            <span className="font-num text-lol-text-bright/85">
              {player.pointsUntilNextRank.toLocaleString(LOCALE)}
            </span>{" "}
            to next rank
          </div>
        )}
      </div>

      {(player.title || data.equipped.length > 0) && (
        <div className="relative mt-auto flex items-end justify-between gap-3 border-t border-lol-line pt-3.5">
          {player.title ? (
            <div className="min-w-0">
              <div className="label text-[11px] text-lol-text/70">Title</div>
              <div className="truncate font-display text-[16px] font-semibold text-lol-gold">
                {player.title}
              </div>
            </div>
          ) : (
            <span />
          )}
          {data.equipped.length > 0 && (
            <div className="text-right">
              <div className="label mb-1 text-[11px] text-lol-text/70">Equipped</div>
              <div className="flex items-center gap-1.5">
                {data.equipped.map((challenge) => (
                  <ChallengeToken
                    key={challenge.id}
                    iconPath={challenge.iconPath}
                    size={32}
                    dim={challenge.level === "NONE"}
                    title={challenge.name}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SeasonalCard({ challenges }: { challenges: ChallengeProgress[] }) {
  const [open, setOpen] = useState(false);
  if (challenges.length === 0) return null;

  return (
    <div className="panel overflow-hidden">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 px-5 py-3.5 text-left transition-colors hover:bg-white/[0.02] cursor-pointer"
      >
        <ChevronDownIcon
          className={`h-4 w-4 text-lol-gold transition-transform ${open ? "" : "-rotate-90"}`}
        />
        <span className="section-title">Past seasons</span>
        <span className="font-num text-[13px] text-lol-text/70">{challenges.length}</span>
        <span className="ml-auto text-[12px] text-lol-text/70">Progress frozen at season end</span>
      </button>
      {open && (
        <div className="grid grid-cols-2 border-t border-lol-line">
          {challenges.map((challenge) => (
            <div
              key={challenge.id}
              className="flex items-center gap-3 border-b border-lol-line px-5 py-2.5 odd:border-r"
            >
              <ChallengeToken
                iconPath={challenge.iconPath}
                size={32}
                dim={challenge.level === "NONE"}
              />
              <span className="min-w-0 flex-1 truncate font-display text-[15px] font-semibold text-lol-text-bright">
                {challenge.name}
              </span>
              <TierTag level={challenge.level} />
              <ValueFigure challenge={challenge} className="w-24 text-right text-[14px]" />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- Page ----

export default function Challenges() {
  const status = useLcuStatus();
  const [result, setResult] = useState<ChallengesResult | null>(null);

  // No refresh control, because there is nothing for one to do: the stored
  // snapshot lands at once, a live read starts behind it, and the client is
  // asked again on every status change. Challenge values only move by playing
  // games, and the end of one is a status change.
  useEffect(() => {
    let active = true;
    window.api.getChallenges().then((stored) => {
      if (active) setResult(stored);
    });
    const unsub = window.api.onChallengesChanged((live) => {
      if (active) setResult(live);
    });
    return () => {
      active = false;
      unsub();
    };
  }, [status]);

  const data = result?.data ?? null;
  const waiting = result == null || (result.pending && data == null);

  if (waiting) {
    return <div className="label mt-20 text-center">Loading…</div>;
  }

  if (!data) {
    return (
      <div className="max-w-[1320px] space-y-6">
        <PageHeader kicker="Achieve" title="Challenges" className="pb-0" />
        <div className="panel flex flex-col items-center gap-3 px-8 py-16 text-center">
          <AwardIcon className="h-8 w-8 text-lol-gold/60" />
          <div className="max-w-md text-[14px] leading-relaxed text-lol-text">
            Challenge progress comes from the League client, and it isn't running. Start it and this
            fills in. After that the last reading stays here.
          </div>
        </div>
      </div>
    );
  }

  const total = data.groups.reduce((sum, group) => sum + group.challenges.length, 0);
  // The green figures need a key, and it belongs to the whole page rather than
  // to any one card.
  const subtitle = (
    <>
      <span className="font-num text-lol-text-bright/85">{total}</span> challenges across{" "}
      <span className="font-num text-lol-text-bright/85">{data.groups.length}</span> categories
      {data.since && data.capstone?.delta != null && (
        <>
          {" · "}
          <span className="font-semibold text-lol-win">Green</span> figures are progress since{" "}
          {formatDay(data.since)}
        </>
      )}
    </>
  );

  return (
    <div className="max-w-[1320px] space-y-6">
      <PageHeader kicker="Achieve" title="Challenges" subtitle={subtitle} className="pb-0" />

      <div
        className={`grid items-stretch gap-4 ${
          data.capstone ? "lg:grid-cols-[minmax(0,1.75fr)_minmax(0,1fr)]" : ""
        }`}
      >
        {data.capstone && <CapstoneCard capstone={data.capstone} groups={data.groups} />}
        <PlayerCard data={data} />
      </div>

      {data.groups.map((group) => (
        <GroupCard key={group.summary.id} group={group} />
      ))}
      <SeasonalCard challenges={data.seasonal} />
    </div>
  );
}
