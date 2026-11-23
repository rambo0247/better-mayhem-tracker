import { createEffect, createMemo, createSignal, For, Match, Show, Switch } from "solid-js";
import { useLcuStatus } from "../hooks/useLcuStatus";
import { useChampionData, getChampionName } from "../hooks/useChampions";
import { api } from "../lib/api-shim";
import { reportFirstContent } from "../lib/perf";
import type {
  ChallengeLevel,
  ChallengeProgress,
  ChallengesData,
  ChallengesResult,
  ChampionData,
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
import { challengeFraction } from "../shared/challenges";

type Group = ChallengesData["groups"][number];

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
  return challenge.level === "NONE" || challenge.percentile >= 100
    ? null
    : `top ${formatPercent(challenge.percentile / 100)}`;
}

// Points are on every tier and already shown as the challenge's own value, so
// the only reward worth a line is the kind you can wear.
function rewardNote(challenge: ChallengeProgress): string | null {
  const title = challenge.nextRewards.find((r) => r.category === "TITLE" && r.name);
  return title ? `${levelName(challenge.nextLevel)} unlocks the "${title.name}" title` : null;
}

// The category heads and challenges each scroll to their own section, so the
// overview at the top can double as a table of contents.
function groupAnchor(id: number): string {
  return `challenge-group-${id}`;
}

// A tier name in the tier's own colour, on a faint wash of it. The colours are
// data, so they go in inline.
function TierTag(props: { level: ChallengeLevel; class?: string }) {
  const color = () => LEVEL_COLORS[props.level];
  return (
    <span
      class={["chip shrink-0", props.class ?? ""]}
      style={{
        color: color(),
        "background-color": `${color()}1c`,
        "box-shadow": `inset 0 0 0 1px ${color()}38`,
      }}
    >
      {levelName(props.level)}
    </span>
  );
}

// How far through the current tier. The distance left to the next one is read
// off the empty remainder, so no row spells that out in figures. Every bar
// fills in the same gold: the tier colours include reds and greys that would
// read as warnings or disabled states on a bar, so a tier's colour appears only
// on the chips naming a tier.
function TierBar(props: { challenge: ChallengeProgress; class?: string }) {
  const fraction = () =>
    challengeFraction(
      props.challenge.value,
      props.challenge.currentThreshold,
      props.challenge.nextThreshold,
    );
  const maxed = () => props.challenge.nextThreshold == null;

  return (
    <div class={["h-1.5 overflow-hidden rounded-[2px] bg-white/[0.06]", props.class ?? ""]}>
      <div
        class={[
          "h-full rounded-[2px] bg-gradient-to-r transition-all",
          maxed() ? "from-lol-gold to-lol-gold-light" : "from-lol-gold/45 to-lol-gold",
        ]}
        style={{ width: `${fraction() * 100}%` }}
      />
    </div>
  );
}

// One line per challenge: the bar, the figures at its end, and the tier it is
// filling toward (or that it's done) in a fixed-width chip. Every slot after
// the bar is a fixed width, so bars, figures and chips line up down a section
// whatever the row holds.
function ProgressTrack(props: {
  challenge: ChallengeProgress;
  // "Complete" for a challenge, "Maxed" for a category or the capstone
  doneLabel: string;
  large?: boolean;
  class?: string;
}) {
  return (
    <div class={["flex items-center gap-4", props.class ?? ""]}>
      <TierBar
        challenge={props.challenge}
        class={props.large ? "min-w-0 flex-1 h-2" : "min-w-0 flex-1"}
      />
      {/* A finished challenge still earns progress, and the client still
          reports it, so the badge shows there too */}
      <div class="flex w-[132px] shrink-0 items-baseline justify-end gap-2">
        <DeltaBadge delta={props.challenge.delta} />
        <ValueFigure
          challenge={props.challenge}
          class={["font-semibold", props.large ? "text-[18px]" : "text-[15px]"]}
        />
      </div>
      <Show
        when={props.challenge.nextLevel}
        fallback={
          <span class="chip w-[104px] shrink-0 justify-center border border-lol-gold/35 bg-lol-gold/12 text-lol-gold">
            {props.doneLabel}
          </span>
        }
      >
        {(next) => (
          <span
            class="chip w-[104px] shrink-0 justify-center border border-lol-border text-lol-text"
            title={`Next tier: ${levelName(next())}`}
          >
            {levelName(next())}
          </span>
        )}
      </Show>
    </div>
  );
}

// Progress since the baseline snapshot. It sits alone in its slot: next to a
// tier name it read as the distance to that tier, which it is not.
function DeltaBadge(props: { delta: number | null }) {
  return (
    <Show when={props.delta != null && props.delta > 0}>
      <span class="font-num text-[13px] font-semibold whitespace-nowrap text-lol-win">
        +{formatValue(props.delta ?? 0)}
      </span>
    </Show>
  );
}

// The value against the next threshold, or alone once there is none.
function ValueFigure(props: { challenge: ChallengeProgress; class?: string | string[] }) {
  return (
    <span class={["font-num whitespace-nowrap text-lol-text-bright", props.class ?? ""]}>
      {formatValue(props.challenge.value)}
      <Show when={props.challenge.nextThreshold != null}>
        <span class="text-lol-text/70"> / {formatValue(props.challenge.nextThreshold ?? 0)}</span>
      </Show>
    </span>
  );
}

// ---- Champion progress ----

function ChampionGrid(props: { ids: number[]; done: boolean; champData: ChampionData }) {
  return (
    <div class="flex flex-wrap gap-1.5">
      <For each={props.ids}>
        {(id) => (
          <ChampionIcon
            championId={id}
            size={48}
            rounded={false}
            title={getChampionName(props.champData, id)}
            // The ones still to earn are the actionable half of this grid, so they
            // stay legible; the ring is what marks the others done.
            class={props.done ? "ring-2 ring-lol-gold/70" : "opacity-75 hover:opacity-100"}
          />
        )}
      </For>
    </div>
  );
}

// Which champions a per-champion challenge still wants, and which it already
// has. Alphabetical both ways, so a particular champion can be looked up rather
// than hunted for.
function ChampionProgress(props: { completedIds: number[] }) {
  const champData = useChampionData();
  const [showEarned, setShowEarned] = createSignal(false);

  const split = createMemo(() => {
    const done = new Set(props.completedIds);
    // Champion data is the roster; a completed id missing from it (a champion
    // released since the cache was written) still belongs in the count.
    const ids = [...new Set([...Object.keys(champData()).map(Number), ...props.completedIds])];
    const byName = (a: number, b: number) =>
      getChampionName(champData(), a).localeCompare(getChampionName(champData(), b));
    return {
      remaining: ids.filter((id) => !done.has(id)).sort(byName),
      earned: ids.filter((id) => done.has(id)).sort(byName),
    };
  });

  return (
    <div class="space-y-3">
      <div class="label">
        Champions left <span class="font-num text-lol-text-bright">{split().remaining.length}</span>
      </div>
      <Show
        when={split().remaining.length > 0}
        fallback={<div class="text-[13px] text-lol-text">Every champion done.</div>}
      >
        <ChampionGrid ids={split().remaining} done={false} champData={champData()} />
      </Show>

      <button
        onClick={() => setShowEarned((open) => !open)}
        class="label flex items-center gap-1.5 transition-colors hover:text-lol-text-bright cursor-pointer"
      >
        <ChevronDownIcon
          class={["h-3.5 w-3.5 transition-transform", showEarned() ? "" : "-rotate-90"]}
        />
        Champions earned <span class="font-num text-lol-text-bright">{split().earned.length}</span>
      </button>
      <Show when={showEarned()}>
        <ChampionGrid ids={split().earned} done={true} champData={champData()} />
      </Show>
    </div>
  );
}

// ---- Challenge rows ----

function ChallengeRow(props: { challenge: ChallengeProgress }) {
  const [expanded, setExpanded] = createSignal(false);
  const percentile = () => percentileLabel(props.challenge);
  const reward = () => rewardNote(props.challenge);

  return (
    <div class="border-t border-lol-line transition-colors hover:bg-white/[0.02]">
      <div class={[ROW_COLS, "px-5 py-3.5"]}>
        <ChallengeToken
          iconPath={props.challenge.iconPath}
          size={44}
          dim={props.challenge.level === "NONE"}
        />
        <div class="min-w-0">
          <div class="flex min-w-0 items-center gap-2">
            <span class="truncate font-display text-[16px] font-semibold leading-tight text-lol-text-bright">
              {props.challenge.name}
            </span>
            <TierTag level={props.challenge.level} />
            <Show when={percentile()}>
              <span class="font-num shrink-0 text-[13px] text-lol-text/80">{percentile()}</span>
            </Show>
          </div>
          <div class="mt-0.5 text-[13px] leading-snug text-lol-text">
            {props.challenge.description}
          </div>
          <Show when={reward()}>
            <div class="mt-1 text-[12px] font-medium text-lol-gold">{reward()}</div>
          </Show>
          <Show when={props.challenge.completedChampionIds}>
            <button
              onClick={() => setExpanded((open) => !open)}
              aria-expanded={expanded() ? "true" : "false"}
              class="label mt-1.5 flex items-center gap-1 text-[11px] text-lol-gold transition-colors hover:text-lol-gold-light cursor-pointer"
            >
              <ChevronDownIcon
                class={["h-3 w-3 transition-transform", expanded() ? "" : "-rotate-90"]}
              />
              Champions
            </button>
          </Show>
        </div>

        <ProgressTrack challenge={props.challenge} doneLabel="Complete" />
      </div>
      <Show when={expanded() ? props.challenge.completedChampionIds : null}>
        {(champions) => (
          <div class="border-t border-lol-line bg-black/20 py-4 pr-5 pl-[84px]">
            <ChampionProgress completedIds={champions()} />
          </div>
        )}
      </Show>
    </div>
  );
}

function GroupCard(props: { group: Group }) {
  const summary = () => props.group.summary;

  return (
    <section id={groupAnchor(summary().id)} class="panel scroll-mt-4 overflow-hidden">
      <div class={[ROW_COLS, "bg-black/20 px-5 py-3"]}>
        <ChallengeToken iconPath={summary().iconPath} size={44} dim={summary().level === "NONE"} />
        <div class="flex min-w-0 items-center gap-2.5">
          <h2 class="section-title truncate">{summary().name}</h2>
          <TierTag level={summary().level} />
          <span class="font-num shrink-0 text-[13px] text-lol-text/70">
            {props.group.challenges.length} challenges
          </span>
        </div>
        {/* As wide as the rows underneath, so a full bar reads as full */}
        <ProgressTrack challenge={summary()} doneLabel="Maxed" />
      </div>
      <div>
        <For each={props.group.challenges} keyed={(challenge) => challenge.id}>
          {(challenge) => <ChallengeRow challenge={challenge()} />}
        </For>
      </div>
    </section>
  );
}

// ---- Headline cards ----

// A soft halo in the tier's colour behind a token, so the headline tokens read
// as lit rather than pasted on.
function Halo(props: { level: ChallengeLevel; class: string }) {
  return (
    <span
      class={["pointer-events-none absolute rounded-full", props.class]}
      style={{
        background: `radial-gradient(closest-side, ${LEVEL_COLORS[props.level]}40, transparent)`,
      }}
    />
  );
}

// The capstone, with the categories that level it laid out underneath as a
// summary of the sections below. Each one jumps to its section.
function CapstoneCard(props: { capstone: ChallengeProgress; groups: Group[] }) {
  const percentile = () => percentileLabel(props.capstone);
  const color = () => LEVEL_COLORS[props.capstone.level];

  return (
    <div class="panel relative flex flex-col overflow-hidden">
      <span
        class="pointer-events-none absolute inset-x-0 top-0 h-px"
        style={{
          background: `linear-gradient(90deg, ${color()}cc, ${color()}33 45%, transparent)`,
        }}
      />
      <div class="relative flex items-center gap-5 p-5">
        <div class="relative shrink-0">
          <Halo level={props.capstone.level} class="-inset-6" />
          <ChallengeToken
            iconPath={props.capstone.iconPath}
            size={88}
            dim={props.capstone.level === "NONE"}
            class="relative"
          />
        </div>
        <div class="min-w-0 flex-1">
          <div class="label">{props.capstone.name}</div>
          <div class="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span
              class="font-display text-[34px] font-extrabold uppercase italic leading-none tracking-[0.01em]"
              style={{ color: color() }}
            >
              {levelName(props.capstone.level)}
            </span>
            <Show when={percentile()}>
              <span class="font-num text-[14px] text-lol-text">{percentile()}</span>
            </Show>
          </div>
          <ProgressTrack challenge={props.capstone} doneLabel="Maxed" large class="mt-4" />
        </div>
      </div>

      <Show when={props.groups.length > 0}>
        <div
          class="mt-auto grid border-t border-lol-line bg-black/15"
          style={{ "grid-template-columns": `repeat(${props.groups.length}, minmax(0, 1fr))` }}
        >
          <For each={props.groups} keyed={(group) => group.summary.id}>
            {(group) => (
              <button
                onClick={() =>
                  document
                    .getElementById(groupAnchor(group().summary.id))
                    ?.scrollIntoView({ behavior: "smooth", block: "start" })
                }
                title={`Jump to ${group().summary.name}`}
                class="flex min-w-0 items-center gap-2.5 border-l border-lol-line px-4 py-3 text-left transition-colors first:border-l-0 hover:bg-white/[0.03] cursor-pointer"
              >
                <ChallengeToken
                  iconPath={group().summary.iconPath}
                  size={32}
                  dim={group().summary.level === "NONE"}
                />
                <div class="min-w-0 flex-1">
                  <div class="flex items-baseline justify-between gap-2">
                    <span class="truncate font-display text-[14px] font-semibold text-lol-text-bright">
                      {group().summary.name}
                    </span>
                    <span
                      class="label shrink-0 text-[11px]"
                      style={{ color: LEVEL_COLORS[group().summary.level] }}
                    >
                      {levelName(group().summary.level)}
                    </span>
                  </div>
                  <TierBar challenge={group().summary} class="mt-1.5 h-1" />
                </div>
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

function PlayerCard(props: { data: ChallengesData }) {
  const player = () => props.data.player;

  return (
    <div class="panel relative flex flex-col overflow-hidden p-5">
      {/* A wash of gold behind the rank, as the profile card on Match History */}
      <span class="pointer-events-none absolute -right-16 -top-24 h-64 w-64 rounded-full bg-lol-gold/[0.06] blur-3xl" />
      <span class="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-lol-gold/80 via-lol-gold/30 to-transparent" />

      <div class="relative flex items-center gap-2">
        <span class="flex h-6 w-6 items-center justify-center rounded-md bg-lol-gold/12 text-lol-gold">
          <AwardIcon class="h-3.5 w-3.5" />
        </span>
        <span class="label">Challenge rank</span>
        <Show when={player().percentile < 100}>
          <span class="font-num ml-auto text-[13px] text-lol-text">
            top {formatPercent(player().percentile / 100)} overall
          </span>
        </Show>
      </div>

      <div class="relative mt-3">
        <div
          class="font-display text-[34px] font-extrabold uppercase italic leading-none tracking-[0.01em]"
          style={{ color: LEVEL_COLORS[player().level] }}
        >
          {levelName(player().level)}
        </div>
        <div class="mt-2.5 flex flex-wrap items-baseline gap-x-2">
          <span class="font-num text-[22px] font-semibold leading-none text-lol-text-bright">
            {player().points.toLocaleString(LOCALE)}
          </span>
          <span class="label">points</span>
        </div>
        <Show when={player().pointsUntilNextRank > 0}>
          <div class="mt-1 text-[13px] text-lol-text">
            <span class="font-num text-lol-text-bright/85">
              {player().pointsUntilNextRank.toLocaleString(LOCALE)}
            </span>{" "}
            to next rank
          </div>
        </Show>
      </div>

      <Show when={player().title || props.data.equipped.length > 0}>
        <div class="relative mt-auto flex items-end justify-between gap-3 border-t border-lol-line pt-3.5">
          <Show when={player().title} fallback={<span />}>
            <div class="min-w-0">
              <div class="label text-[11px] text-lol-text/70">Title</div>
              <div class="truncate font-display text-[16px] font-semibold text-lol-gold">
                {player().title}
              </div>
            </div>
          </Show>
          <Show when={props.data.equipped.length > 0}>
            <div class="text-right">
              <div class="label mb-1 text-[11px] text-lol-text/70">Equipped</div>
              <div class="flex items-center gap-1.5">
                <For each={props.data.equipped} keyed={(challenge) => challenge.id}>
                  {(challenge) => (
                    <ChallengeToken
                      iconPath={challenge().iconPath}
                      size={32}
                      dim={challenge().level === "NONE"}
                      title={challenge().name}
                    />
                  )}
                </For>
              </div>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  );
}

function SeasonalCard(props: { challenges: ChallengeProgress[] }) {
  const [open, setOpen] = createSignal(false);

  return (
    <Show when={props.challenges.length > 0}>
      <div class="panel overflow-hidden">
        <button
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open() ? "true" : "false"}
          class="flex w-full items-center gap-2.5 px-5 py-3.5 text-left transition-colors hover:bg-white/[0.02] cursor-pointer"
        >
          <ChevronDownIcon
            class={["h-4 w-4 text-lol-gold transition-transform", open() ? "" : "-rotate-90"]}
          />
          <span class="section-title">Past seasons</span>
          <span class="font-num text-[13px] text-lol-text/70">{props.challenges.length}</span>
          <span class="ml-auto text-[12px] text-lol-text/70">Progress frozen at season end</span>
        </button>
        <Show when={open()}>
          <div class="grid grid-cols-2 border-t border-lol-line">
            <For each={props.challenges} keyed={(challenge) => challenge.id}>
              {(challenge) => (
                <div class="flex items-center gap-3 border-b border-lol-line px-5 py-2.5 odd:border-r">
                  <ChallengeToken
                    iconPath={challenge().iconPath}
                    size={32}
                    dim={challenge().level === "NONE"}
                  />
                  <span class="min-w-0 flex-1 truncate font-display text-[15px] font-semibold text-lol-text-bright">
                    {challenge().name}
                  </span>
                  <TierTag level={challenge().level} />
                  <ValueFigure challenge={challenge()} class="w-24 text-right text-[14px]" />
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>
    </Show>
  );
}

// ---- Page ----

export default function Challenges() {
  const status = useLcuStatus();
  const [result, setResult] = createSignal<ChallengesResult | null>(null);

  // No refresh control, because there is nothing for one to do: the stored
  // snapshot lands at once, a live read starts behind it, and the client is
  // asked again on every status change. Challenge values only move by playing
  // games, and the end of one is a status change.
  createEffect(status, () => {
    let active = true;
    void api.getChallenges().then((stored) => {
      if (active) setResult(stored);
    });
    const unsub = api.onChallengesChanged((live) => {
      if (active) setResult(live);
    });
    return () => {
      active = false;
      unsub();
    };
  });

  const data = () => result()?.data ?? null;
  const waiting = () => {
    const r = result();
    return r == null || (r.pending && r.data == null);
  };

  createEffect(
    () => !waiting(),
    (ready) => {
      if (ready) reportFirstContent();
    },
  );

  return (
    <Switch>
      <Match when={waiting()}>
        <div class="label mt-20 text-center">Loading…</div>
      </Match>
      <Match when={!data()}>
        <div class="max-w-[1320px] space-y-6">
          <PageHeader kicker="Achieve" title="Challenges" class="pb-0" />
          <div class="panel flex flex-col items-center gap-3 px-8 py-16 text-center">
            <AwardIcon class="h-8 w-8 text-lol-gold/60" />
            <div class="max-w-md text-[14px] leading-relaxed text-lol-text">
              Challenge progress comes from the League client, and it isn't running. Start it and
              this fills in. After that the last reading stays here.
            </div>
          </div>
        </div>
      </Match>
      <Match when={data()}>{(d) => <Loaded data={d()} />}</Match>
    </Switch>
  );
}

function Loaded(props: { data: ChallengesData }) {
  const total = () => props.data.groups.reduce((sum, group) => sum + group.challenges.length, 0);
  // The green figures need a key, and it belongs to the whole page rather than
  // to any one card.
  const subtitle = (
    <>
      <span class="font-num text-lol-text-bright/85">{total()}</span> challenges across{" "}
      <span class="font-num text-lol-text-bright/85">{props.data.groups.length}</span> categories
      <Show when={props.data.since && props.data.capstone?.delta != null}>
        {" · "}
        <span class="font-semibold text-lol-win">Green</span> figures are progress since{" "}
        {formatDay(props.data.since ?? "")}
      </Show>
    </>
  );

  return (
    <div class="max-w-[1320px] space-y-6">
      <PageHeader kicker="Achieve" title="Challenges" subtitle={subtitle} class="pb-0" />

      <div
        class={[
          "grid items-stretch gap-4",
          props.data.capstone ? "lg:grid-cols-[minmax(0,1.75fr)_minmax(0,1fr)]" : "",
        ]}
      >
        <Show when={props.data.capstone}>
          {(capstone) => <CapstoneCard capstone={capstone()} groups={props.data.groups} />}
        </Show>
        <PlayerCard data={props.data} />
      </div>

      <For each={props.data.groups} keyed={(group) => group.summary.id}>
        {(group) => <GroupCard group={group()} />}
      </For>
      <SeasonalCard challenges={props.data.seasonal} />
    </div>
  );
}
