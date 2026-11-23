import { For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import type {
  ChampionData,
  GameRecap as GameRecapData,
  RecapChallenge,
  RecapPlacement,
  RecapSessionGame,
} from "../lib/types";
import { getChampionName } from "../hooks/useChampions";
import {
  LOCALE,
  formatCompact,
  formatDecimal,
  formatDuration,
  formatKDA,
  formatPlaytime,
  formatTimeAgo,
  kdaColor,
  kdaRatio,
  winRatePercent,
  scoreColor,
} from "../lib/format";
import {
  CHALLENGE_LEVEL_COLORS,
  challengeLevelName,
  formatChallengeValue,
} from "../lib/challenges";
import { ordinal } from "@shared/text";
import { queueLabel } from "./QueueSelect";
import ChallengeToken from "./ChallengeToken";
import ChampionIcon from "./ChampionIcon";
import ItemIcon from "./ItemIcon";
import AugmentIcon from "./AugmentIcon";
import MatchScoreboard from "./MatchScoreboard";
import MultikillBadge from "./MultikillBadge";
import Panel from "./Panel";
import { ScoreBadge } from "./ScoreCell";
import WinRateBar from "./WinRateBar";
import {
  AwardIcon,
  MapPinIcon,
  MedalIcon,
  SparklesIcon,
  StarIcon,
  SwordsIcon,
  TimerIcon,
  TrendingDownIcon,
  TrendingUpIcon,
} from "./icons";
import Kda from "./Kda";

// A stat against the average of every game on record. Small differences aren't
// worth colouring, so anything inside a tenth of the average reads as neutral.
function Delta(props: { value: number; average: number; format?: "compact" }) {
  const diff = () => props.value - props.average;
  const meaningful = () => Math.abs(diff()) > props.average * 0.1;
  const text = () =>
    props.format === "compact" ? formatCompact(Math.abs(diff())) : formatDecimal(Math.abs(diff()));

  return (
    <Show when={props.average > 0}>
      <span
        class={!meaningful() ? "text-lol-text" : diff() > 0 ? "text-lol-win" : "text-lol-loss/85"}
      >
        {diff() >= 0 ? "+" : "-"}
        {text()} vs avg
      </span>
    </Show>
  );
}

export default function GameRecap(props: {
  recap: GameRecapData;
  champData: ChampionData;
  puuids: string[] | null;
  heading?: JSX.Element;
}) {
  const detail = () => props.recap.detail;
  const career = () => props.recap.career;
  const champion = () => props.recap.champion;
  const session = () => props.recap.session;
  const stats = () => props.recap.detail.stats;
  const isRemake = () => !!detail().game.is_remake;
  const isWin = () => !!stats()?.win;
  const items = () => {
    const s = stats();
    return [s?.item0, s?.item1, s?.item2, s?.item3, s?.item4, s?.item5];
  };
  const score = () => props.recap.score ?? 0;
  const kills = () => stats()?.kills ?? 0;
  const deaths = () => stats()?.deaths ?? 0;
  const assists = () => stats()?.assists ?? 0;

  const result = () => (isRemake() ? "Remake" : isWin() ? "Victory" : "Defeat");
  const resultText = () =>
    isRemake() ? "text-lol-text" : isWin() ? "text-lol-win" : "text-lol-loss";

  return (
    <div class="space-y-6">
      {props.heading}

      {/* The headline: what happened, on what, where, and how well — set like the
          result graphic a broadcast cuts to when the nexus falls */}
      <div class="panel overflow-hidden">
        <span
          class={[
            "absolute inset-y-0 left-0 w-[3px]",
            isRemake() ? "bg-white/25" : isWin() ? "bg-lol-win" : "bg-lol-loss",
          ]}
        />
        <span
          class={[
            "pointer-events-none absolute inset-y-0 left-0 w-[60%] bg-gradient-to-r to-transparent",
            isRemake()
              ? "from-white/[0.03]"
              : isWin()
                ? "from-lol-win/[0.13]"
                : "from-lol-loss/[0.13]",
          ]}
        />

        <div class="relative flex flex-wrap items-center gap-x-7 gap-y-4 px-7 pb-6 pt-7">
          <ChampionIcon
            championId={stats()?.champion_id ?? 0}
            size={104}
            class="shadow-[0_12px_28px_-12px_rgb(0_0_0/0.8)] ring-1 ring-white/10"
          />

          <div class="min-w-0">
            <div class="flex items-center gap-3">
              <span
                class={[
                  "font-display text-[56px] font-extrabold uppercase italic leading-[0.9] tracking-[0.01em]",
                  resultText(),
                ]}
              >
                {result()}
              </span>
              <Show when={props.recap.scoreBadge}>
                {(badge) => <ScoreBadge badge={badge()} large />}
              </Show>
            </div>
            <div class="mt-2.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span class="font-display text-[24px] font-semibold leading-none text-lol-text-bright">
                {getChampionName(props.champData, stats()?.champion_id ?? 0)}
              </span>
              <span class="font-num text-[24px] font-semibold leading-none text-lol-text-bright">
                <Kda kills={kills()} deaths={deaths()} assists={assists()} />
              </span>
              <span
                class={[
                  "font-num text-[16px] font-semibold",
                  kdaColor(deaths() === 0 ? Infinity : (kills() + assists()) / deaths()),
                ]}
              >
                {kdaRatio(kills(), deaths(), assists())}
                <span class="ml-1 text-[12px] tracking-[0.08em] text-lol-text">KDA</span>
              </span>
            </div>
            <div class="mt-3 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[13px] text-lol-text">
              <Show when={props.recap.mapName}>
                <span class="chip h-6 border border-lol-border bg-white/[0.04] text-[12px] text-lol-text-bright">
                  <MapPinIcon class="h-3 w-3 text-lol-gold" />
                  {props.recap.mapName}
                </span>
              </Show>
              <span>{queueLabel(detail().game.queue_id)}</span>
              <Dot />
              <span class="font-num text-[14px]">
                {formatDuration(detail().game.game_duration)}
              </span>
              <Dot />
              <span>{formatTimeAgo(detail().game.game_creation)}</span>
            </div>
          </div>

          <Show when={props.recap.score != null}>
            <div class="ml-auto text-right">
              <div class="label">Score</div>
              <div
                class={[
                  "font-num mt-1 text-[64px] font-semibold leading-[0.85]",
                  scoreColor(score()),
                ]}
              >
                {formatDecimal(score())}
                <span class="ml-1 text-[22px] text-lol-text/50">/ 10</span>
              </div>
              <Show when={career().avgScore != null}>
                <div class="font-num mt-2 text-[13px]">
                  <Delta value={score()} average={career().avgScore!} />
                </div>
              </Show>
            </div>
          </Show>
        </div>

        {/* The numbers under the headline, each against the career average,
            with the build the game was played on at the end */}
        <div class="relative flex flex-wrap items-center gap-y-3 border-t border-lol-line bg-black/20 px-3 py-3.5">
          <HeadlineStat
            label="Damage"
            accent="bg-red-400"
            value={formatCompact(stats()?.total_damage_dealt ?? 0)}
            delta={
              <Delta
                value={stats()?.total_damage_dealt ?? 0}
                average={career().avgDamage}
                format="compact"
              />
            }
          />
          <HeadlineStat
            label="Taken"
            accent="bg-sky-400"
            value={formatCompact(stats()?.total_damage_taken ?? 0)}
            delta={
              <Delta
                value={stats()?.total_damage_taken ?? 0}
                average={career().avgTaken}
                format="compact"
              />
            }
          />
          <HeadlineStat
            label="Healing"
            accent="bg-emerald-400"
            value={formatCompact(stats()?.total_heal ?? 0)}
            delta={
              <Delta value={stats()?.total_heal ?? 0} average={career().avgHeal} format="compact" />
            }
          />
          <HeadlineStat
            label="Gold"
            accent="bg-lol-gold"
            value={formatCompact(stats()?.gold_earned ?? 0)}
            delta={
              <Delta
                value={stats()?.gold_earned ?? 0}
                average={career().avgGold}
                format="compact"
              />
            }
          />
          <HeadlineStat
            label="Best spree"
            accent="bg-purple-400"
            value={String(stats()?.largest_killing_spree ?? 0)}
            delta={
              <MultikillBadge
                doubles={stats()?.double_kills ?? 0}
                triples={stats()?.triple_kills ?? 0}
                quadras={stats()?.quadra_kills ?? 0}
                pentas={stats()?.penta_kills ?? 0}
              />
            }
          />

          <div class="ml-auto flex items-center gap-4 px-4">
            <div class="label text-right leading-tight">
              Final
              <br />
              build
            </div>
            <div class="space-y-[3px]">
              <div class="flex items-center gap-[3px]">
                <For each={items()} keyed={false}>
                  {(itemId) => (
                    <ItemIcon itemId={itemId() ?? 0} size={30} patch={detail().game.game_version} />
                  )}
                </For>
              </div>
              <Show when={detail().augments.length > 0}>
                <div class="flex items-center gap-[3px]">
                  <For each={detail().augments}>
                    {(augment) => (
                      <AugmentIcon
                        augmentId={augment.augment_id}
                        size={30}
                        patch={detail().game.game_version}
                      />
                    )}
                  </For>
                </div>
              </Show>
            </div>
          </div>
        </div>
      </div>

      <Show when={props.recap.milestones.length > 0}>
        <div class="flex flex-wrap gap-2.5">
          <For each={props.recap.milestones}>
            {(milestone) => (
              <div
                class="flex items-center gap-3 rounded-lg border border-lol-gold/35 bg-gradient-to-r from-lol-gold/[0.16] to-lol-gold/[0.04] py-2.5 pl-3 pr-4"
                title={milestone.detail}
              >
                <span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-lol-gold/15">
                  <SparklesIcon class="h-4 w-4 text-lol-gold" />
                </span>
                <div>
                  <div class="font-display text-[15px] font-bold uppercase leading-tight tracking-[0.04em] text-lol-gold-light">
                    {milestone.label}
                  </div>
                  <div class="text-[12px] text-lol-text">{milestone.detail}</div>
                </div>
              </div>
            )}
          </For>
        </div>
      </Show>

      <Show when={props.recap.placements.length > 0}>
        <Panel
          title="Where it lands"
          subtitle={`among ${career().games.toLocaleString(LOCALE)} recorded games`}
          icon={<MedalIcon class="h-3.5 w-3.5" />}
          accent="gold"
        >
          <div class="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
            <For each={props.recap.placements}>
              {(placement) => <PlacementCard placement={placement} recap={props.recap} />}
            </For>
          </div>
        </Panel>
      </Show>

      <Show when={props.recap.challenges.length > 0}>
        <Panel
          title="Challenge progress"
          subtitle={`${props.recap.challenges.length} moved by this game`}
          icon={<AwardIcon class="h-3.5 w-3.5" />}
          accent="purple"
        >
          <div class="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
            <For each={props.recap.challenges}>
              {(challenge) => <ChallengeCard challenge={challenge} />}
            </For>
          </div>
        </Panel>
      </Show>

      {/* The two panels share a height, each ending on its win-rate bar */}
      <div class="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <Panel
          title="This session"
          subtitle={sessionSubtitle(session().games.length, session().duration)}
          icon={<TimerIcon class="h-3.5 w-3.5" />}
          accent="sky"
        >
          <div class="flex h-full flex-col gap-4">
            <div class="flex flex-wrap items-end gap-x-8 gap-y-3">
              <MiniStat
                label={`${winRatePercent(session().wins, session().wins + session().losses)} win rate`}
              >
                <WinLoss wins={session().wins} losses={session().losses} />
              </MiniStat>
              <MiniStat
                label={`${kdaRatio(session().kills, session().deaths, session().assists)} KDA`}
              >
                <span class="text-[20px] text-lol-text-bright">
                  <Kda
                    kills={session().kills}
                    deaths={session().deaths}
                    assists={session().assists}
                  />
                </span>
              </MiniStat>
              <Show when={session().avgScore != null}>
                <MiniStat label="Avg score">
                  <span class={["text-[20px]", scoreColor(session().avgScore!)]}>
                    {formatDecimal(session().avgScore!)}
                  </span>
                </MiniStat>
              </Show>
              <Show when={props.recap.streak}>{(streak) => <Streak streak={streak()} />}</Show>
            </div>

            <Show
              when={session().games.length >= SESSION_STRIP_MIN}
              fallback={
                // Too short a session for a game-by-game strip: the same footer
                // as the champion panel beside it, so the two read as a pair
                <div class="mt-auto border-t border-lol-line pt-3">
                  <WinRateBar wins={session().wins} total={session().wins + session().losses} />
                  <SessionBest games={session().games} champData={props.champData} />
                </div>
              }
            >
              <SessionStrip
                games={session().games}
                index={session().index}
                champData={props.champData}
              />
            </Show>
          </div>
        </Panel>

        <Panel
          title={getChampionName(props.champData, champion().championId)}
          subtitle={`${champion().games.toLocaleString(LOCALE)} ${champion().games === 1 ? "game" : "games"} on record`}
          icon={<SwordsIcon class="h-3.5 w-3.5" />}
          accent="purple"
        >
          <div class="flex h-full flex-col gap-4">
            <div class="flex flex-wrap items-end gap-x-8 gap-y-3">
              <MiniStat label="On this champion">
                <WinLoss wins={champion().wins} losses={champion().games - champion().wins} />
              </MiniStat>
              <Show when={champion().avgScore != null}>
                <MiniStat label="Avg score">
                  <span class={["text-[20px]", scoreColor(champion().avgScore!)]}>
                    {formatDecimal(champion().avgScore!)}
                  </span>
                </MiniStat>
              </Show>
            </div>
            <div class="mt-auto border-t border-lol-line pt-3">
              <WinRateBar wins={champion().wins} total={champion().games} />
              <div class="mt-2.5 text-[12px] text-lol-text">
                <span class="font-num text-[13px] text-lol-text-bright">
                  <Kda
                    kills={champion().kills}
                    deaths={champion().deaths}
                    assists={champion().assists}
                  />
                </span>{" "}
                lifetime
                <Show when={champion().previousBest != null && props.recap.score != null}>
                  {" · "}
                  {props.recap.score! > champion().previousBest!
                    ? `beat your previous best of ${formatDecimal(champion().previousBest!)}`
                    : `best on this champion: ${formatDecimal(champion().previousBest!)}`}
                </Show>
              </div>
            </div>
          </div>
        </Panel>
      </div>

      <section>
        <div class="mb-3 flex items-center gap-3 px-0.5">
          <span class="font-display text-[17px] font-bold uppercase italic tracking-[0.04em] text-lol-text-bright">
            Scoreboard
          </span>
          <span class="text-[13px] text-lol-text">
            {queueLabel(detail().game.queue_id)} · {formatDuration(detail().game.game_duration)}
          </span>
          <span class="h-px flex-1 bg-gradient-to-r from-lol-border to-transparent" />
        </div>
        <MatchScoreboard detail={detail()} champData={props.champData} puuids={props.puuids} />
      </section>
    </div>
  );
}

function Dot() {
  return <span class="text-lol-text/40">·</span>;
}

type Streak = NonNullable<GameRecapData["streak"]>;

function Streak(props: { streak: Streak }) {
  const win = () => props.streak.kind === "win";
  const noun = () =>
    win()
      ? props.streak.length === 1
        ? "win"
        : "wins"
      : props.streak.length === 1
        ? "loss"
        : "losses";

  return (
    <div class="ml-auto flex items-center gap-2.5">
      <span
        class={[
          "flex h-8 w-8 items-center justify-center rounded-md",
          win() ? "bg-lol-win/12 text-lol-win" : "bg-lol-loss/12 text-lol-loss",
        ]}
      >
        <Show when={win()} fallback={<TrendingDownIcon class="h-4 w-4" />}>
          <TrendingUpIcon class="h-4 w-4" />
        </Show>
      </span>
      <div>
        <div
          class={[
            "font-display text-[16px] font-bold uppercase leading-tight tracking-[0.03em]",
            win() ? "text-lol-win" : "text-lol-loss",
          ]}
        >
          {props.streak.length} {noun()} in a row
        </div>
        <div class="text-[12px] text-lol-text">
          {props.streak.isRecord
            ? `Your longest ${props.streak.kind} streak ever`
            : `${win() ? "Best" : "Worst"}: ${props.streak.best}`}
        </div>
      </div>
    </div>
  );
}

// Wins and losses as the match history's profile card sets them: big numbers,
// small letters
function WinLoss(props: { wins: number; losses: number }) {
  // A zero is no result at all, so it stays neutral rather than coloured
  const winText = () => (props.wins > 0 ? "text-lol-win" : "text-lol-text");
  const lossText = () => (props.losses > 0 ? "text-lol-loss/85" : "text-lol-text");
  return (
    <span class="text-[30px]">
      <span class={winText()}>{props.wins.toLocaleString(LOCALE)}</span>
      <span class={["ml-0.5 text-[17px] opacity-75", winText()]}>W</span>
      <span class={["ml-2", lossText()]}>{props.losses.toLocaleString(LOCALE)}</span>
      <span class={["ml-0.5 text-[17px] opacity-75", lossText()]}>L</span>
    </span>
  );
}

// A number with a quiet caption under it, for the session and champion panels
function MiniStat(props: { label: string; children: JSX.Element }) {
  return (
    <div>
      <div class="font-num font-semibold leading-none">{props.children}</div>
      <div class="mt-1.5 text-[12px] text-lol-text">{props.label}</div>
    </div>
  );
}

function sessionSubtitle(games: number, duration: number): string {
  const played = `${games} ${games === 1 ? "game" : "games"}`;
  return duration > 0 ? `${played} · ${formatPlaytime(duration)} played` : played;
}

function HeadlineStat(props: {
  label: string;
  accent: string;
  value: string;
  delta?: JSX.Element;
}) {
  return (
    <div class="min-w-[116px] border-r border-lol-line px-4">
      <div class="flex items-center gap-1.5">
        <span class={["h-2.5 w-[3px] rounded-[1px]", props.accent]} />
        <span class="label">{props.label}</span>
      </div>
      <div
        class={[
          "font-num mt-1 text-[24px] font-semibold leading-none",
          props.value === "0" ? "text-lol-text" : "text-lol-text-bright",
        ]}
      >
        {props.value}
      </div>
      <Show when={props.delta}>
        <div class="font-num mt-1.5 min-h-4 text-[12px]">{props.delta}</div>
      </Show>
    </div>
  );
}

// Only the top three get a colour: past that, "9th best game of 700" is a fact
// rather than an achievement, and dressing it up as one would cheapen the rest.
const RANK_STYLES = [
  "border-lol-gold/45 bg-gradient-to-b from-lol-gold/[0.14] to-lol-gold/[0.04]",
  "border-slate-300/30 bg-gradient-to-b from-slate-300/[0.10] to-slate-300/[0.03]",
  "border-amber-700/45 bg-gradient-to-b from-amber-700/[0.14] to-amber-700/[0.04]",
];

function placementValue(placement: RecapPlacement, recap: GameRecapData): string {
  switch (placement.format) {
    case "score":
      return formatDecimal(placement.value);
    case "compact":
      return formatCompact(placement.value);
    case "duration":
      return formatDuration(placement.value);
    case "kda":
      return kdaRatio(
        recap.detail.stats?.kills ?? 0,
        recap.detail.stats?.deaths ?? 0,
        recap.detail.stats?.assists ?? 0,
      );
    default:
      return Math.round(placement.value).toLocaleString(LOCALE);
  }
}

function PlacementCard(props: { placement: RecapPlacement; recap: GameRecapData }) {
  const style = () => (props.placement.good ? RANK_STYLES[props.placement.rank - 1] : undefined);

  return (
    <div class={["rounded-lg border px-3.5 py-3", style() ?? "border-lol-line bg-white/[0.02]"]}>
      <div class="flex items-center justify-between gap-2">
        <span class="label truncate">{props.placement.label}</span>
        <Show when={props.placement.rank === 1}>
          <StarIcon
            class={[
              "h-3.5 w-3.5 shrink-0",
              props.placement.good ? "text-lol-gold" : "text-lol-loss/70",
            ]}
            fill="currentColor"
          />
        </Show>
      </div>
      <div class="font-num mt-1.5 text-[26px] font-semibold leading-none text-lol-text-bright">
        {placementValue(props.placement, props.recap)}
      </div>
      <div
        class={[
          "mt-1.5 text-[12px]",
          props.placement.good && props.placement.rank === 1
            ? "font-semibold text-lol-gold"
            : "text-lol-text",
        ]}
      >
        {props.placement.rank === 1
          ? props.placement.good
            ? "Best ever"
            : "Most ever"
          : `${ordinal(props.placement.rank, LOCALE)} of ${props.placement.total.toLocaleString(LOCALE)}`}
      </div>
    </div>
  );
}

// What this one game moved. The client hands over the before and after itself,
// so the gain is exact rather than inferred from a daily snapshot.
function ChallengeCard(props: { challenge: RecapChallenge }) {
  const gain = () => props.challenge.currentValue - props.challenge.previousValue;
  const tierUp = () => props.challenge.previousLevel !== props.challenge.currentLevel;

  return (
    <div
      class={[
        "rounded-lg border px-3.5 py-2.5",
        tierUp()
          ? "border-lol-gold/45 bg-gradient-to-r from-lol-gold/[0.14] to-lol-gold/[0.04]"
          : "border-lol-line bg-white/[0.02]",
      ]}
      title={props.challenge.description}
    >
      <div class="flex items-center gap-2.5">
        <ChallengeToken iconPath={props.challenge.iconPath} size={32} />
        <div class="min-w-0 flex-1">
          <div class="flex items-baseline gap-2">
            <span class="truncate text-[13px] font-semibold text-lol-text-bright">
              {props.challenge.name}
            </span>
            <span class="font-num ml-auto shrink-0 text-[15px] font-semibold text-lol-win">
              +{formatChallengeValue(gain())}
            </span>
          </div>
          <div class="truncate text-[12px] text-lol-text">
            <Show
              when={tierUp()}
              fallback={
                <Show
                  when={props.challenge.nextThreshold != null}
                  fallback={`${formatChallengeValue(props.challenge.currentValue)} · complete`}
                >
                  {`${formatChallengeValue(props.challenge.currentValue)} / ${formatChallengeValue(
                    props.challenge.nextThreshold!,
                  )} to ${challengeLevelName(props.challenge.nextLevel)}`}
                </Show>
              }
            >
              <span
                class="font-semibold"
                style={{ color: CHALLENGE_LEVEL_COLORS[props.challenge.currentLevel] }}
              >
                {challengeLevelName(props.challenge.previousLevel)} to{" "}
                {challengeLevelName(props.challenge.currentLevel)}
              </span>
            </Show>
          </div>
        </div>
      </div>
    </div>
  );
}

// The day's games in order, with this one called out. Reads as a shape: a good
// run looks like a good run without having to read a single number. Under
// three games there is no shape to read, so the strip waits until there is.
const SESSION_STRIP_MIN = 3;

// The session's best-scored game, under its win-rate bar the way the champion
// panel beside it carries its lifetime line
function SessionBest(props: { games: RecapSessionGame[]; champData: ChampionData }) {
  const best = () =>
    props.games.reduce<RecapSessionGame | null>(
      (top, g) => (g.score != null && (top?.score == null || g.score > top.score) ? g : top),
      null,
    );
  // One game's best is the game above it, already on show; say where the
  // session stands instead, keeping the line that pairs it with the panel beside
  return (
    <Show
      when={props.games.length >= 2}
      fallback={<div class="mt-2.5 text-[12px] text-lol-text">First game of the session</div>}
    >
      <Show when={best()?.score != null}>
        <div class="mt-2.5 text-[12px] text-lol-text">
          Best game:{" "}
          <span class="font-display text-[13px] font-semibold text-lol-text-bright">
            {getChampionName(props.champData, best()!.champion_id)}
          </span>{" "}
          <span class="font-num text-[13px]">
            <Kda kills={best()!.kills} deaths={best()!.deaths} assists={best()!.assists} />
          </span>{" "}
          ·{" "}
          <span class={["font-num text-[13px]", scoreColor(best()!.score!)]}>
            {formatDecimal(best()!.score!)}
          </span>{" "}
          score
        </div>
      </Show>
    </Show>
  );
}

function SessionStrip(props: {
  games: RecapSessionGame[];
  index: number;
  champData: ChampionData;
}) {
  return (
    <div class="border-t border-lol-line pt-3">
      <div class="label mb-2.5">Game by game</div>
      <div class="flex flex-wrap gap-x-1.5 gap-y-2">
        <For each={props.games}>
          {(game, i) => (
            <div
              title={`${getChampionName(props.champData, game.champion_id)} · ${formatKDA(
                game.kills,
                game.deaths,
                game.assists,
              )}${game.score != null ? ` · ${formatDecimal(game.score)} score` : ""}`}
              class={[
                "flex w-7 flex-col items-center gap-1.5 rounded-[3px] py-1.5",
                i() === props.index ? "bg-lol-gold/10 ring-1 ring-inset ring-lol-gold/50" : "",
              ]}
            >
              <span
                class={["slant-sm block h-4 w-[9px]", game.win ? "bg-lol-win" : "bg-lol-loss/75"]}
              />
              <span
                class={[
                  "font-num text-[12px] font-semibold leading-none",
                  game.score != null ? scoreColor(game.score) : "text-lol-text",
                ]}
              >
                {game.score != null ? formatDecimal(game.score) : "–"}
              </span>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}
