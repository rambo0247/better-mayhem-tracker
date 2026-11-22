import { type ReactNode } from "react";
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
import { ordinal } from "../../shared/text";
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
function Delta({ value, average, format }: { value: number; average: number; format?: "compact" }) {
  if (average <= 0) return null;
  const diff = value - average;
  const meaningful = Math.abs(diff) > average * 0.1;
  const text = format === "compact" ? formatCompact(Math.abs(diff)) : formatDecimal(Math.abs(diff));

  return (
    <span
      className={!meaningful ? "text-lol-text" : diff > 0 ? "text-lol-win" : "text-lol-loss/85"}
    >
      {diff >= 0 ? "+" : "-"}
      {text} vs avg
    </span>
  );
}

export default function GameRecap({
  recap,
  champData,
  puuids,
  heading,
}: {
  recap: GameRecapData;
  champData: ChampionData;
  puuids: string[] | null;
  heading?: ReactNode;
}) {
  const { detail, career, champion, session, streak } = recap;
  const stats = detail.stats;
  const isRemake = !!detail.game.is_remake;
  const isWin = !!stats?.win;
  const items = [
    stats?.item0,
    stats?.item1,
    stats?.item2,
    stats?.item3,
    stats?.item4,
    stats?.item5,
  ];
  const kills = stats?.kills ?? 0;
  const deaths = stats?.deaths ?? 0;
  const assists = stats?.assists ?? 0;

  const result = isRemake ? "Remake" : isWin ? "Victory" : "Defeat";
  const resultText = isRemake ? "text-lol-text" : isWin ? "text-lol-win" : "text-lol-loss";

  return (
    <div className="space-y-6">
      {heading}

      {/* The headline: what happened, on what, where, and how well — set like the
          result graphic a broadcast cuts to when the nexus falls */}
      <div className="panel overflow-hidden">
        <span
          className={`absolute inset-y-0 left-0 w-[3px] ${
            isRemake ? "bg-white/25" : isWin ? "bg-lol-win" : "bg-lol-loss"
          }`}
        />
        <span
          className={`pointer-events-none absolute inset-y-0 left-0 w-[60%] bg-gradient-to-r ${
            isRemake ? "from-white/[0.03]" : isWin ? "from-lol-win/[0.13]" : "from-lol-loss/[0.13]"
          } to-transparent`}
        />

        <div className="relative flex flex-wrap items-center gap-x-7 gap-y-4 px-7 pb-6 pt-7">
          <ChampionIcon
            championId={stats?.champion_id ?? 0}
            size={104}
            className="shadow-[0_12px_28px_-12px_rgb(0_0_0/0.8)] ring-1 ring-white/10"
          />

          <div className="min-w-0">
            <div className="flex items-center gap-3">
              <span
                className={`font-display text-[56px] font-extrabold uppercase italic leading-[0.9] tracking-[0.01em] ${resultText}`}
              >
                {result}
              </span>
              {recap.scoreBadge && <ScoreBadge badge={recap.scoreBadge} large />}
            </div>
            <div className="mt-2.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="font-display text-[24px] font-semibold leading-none text-lol-text-bright">
                {getChampionName(champData, stats?.champion_id ?? 0)}
              </span>
              <span className="font-num text-[24px] font-semibold leading-none text-lol-text-bright">
                <Kda kills={kills} deaths={deaths} assists={assists} />
              </span>
              <span
                className={`font-num text-[16px] font-semibold ${kdaColor(
                  deaths === 0 ? Infinity : (kills + assists) / deaths,
                )}`}
              >
                {kdaRatio(kills, deaths, assists)}
                <span className="ml-1 text-[12px] tracking-[0.08em] text-lol-text">KDA</span>
              </span>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[13px] text-lol-text">
              {recap.mapName && (
                <span className="chip h-6 border border-lol-border bg-white/[0.04] text-[12px] text-lol-text-bright">
                  <MapPinIcon className="h-3 w-3 text-lol-gold" />
                  {recap.mapName}
                </span>
              )}
              <span>{queueLabel(detail.game.queue_id)}</span>
              <Dot />
              <span className="font-num text-[14px]">
                {formatDuration(detail.game.game_duration)}
              </span>
              <Dot />
              <span>{formatTimeAgo(detail.game.game_creation)}</span>
            </div>
          </div>

          {recap.score != null && (
            <div className="ml-auto text-right">
              <div className="label">Score</div>
              <div
                className={`font-num mt-1 text-[64px] font-semibold leading-[0.85] ${scoreColor(recap.score)}`}
              >
                {formatDecimal(recap.score)}
                <span className="ml-1 text-[22px] text-lol-text/50">/ 10</span>
              </div>
              {career.avgScore != null && (
                <div className="font-num mt-2 text-[13px]">
                  <Delta value={recap.score} average={career.avgScore} />
                </div>
              )}
            </div>
          )}
        </div>

        {/* The numbers under the headline, each against the career average,
            with the build the game was played on at the end */}
        <div className="relative flex flex-wrap items-center gap-y-3 border-t border-lol-line bg-black/20 px-3 py-3.5">
          <HeadlineStat
            label="Damage"
            accent="bg-red-400"
            value={formatCompact(stats?.total_damage_dealt ?? 0)}
            delta={
              <Delta
                value={stats?.total_damage_dealt ?? 0}
                average={career.avgDamage}
                format="compact"
              />
            }
          />
          <HeadlineStat
            label="Taken"
            accent="bg-sky-400"
            value={formatCompact(stats?.total_damage_taken ?? 0)}
            delta={
              <Delta
                value={stats?.total_damage_taken ?? 0}
                average={career.avgTaken}
                format="compact"
              />
            }
          />
          <HeadlineStat
            label="Healing"
            accent="bg-emerald-400"
            value={formatCompact(stats?.total_heal ?? 0)}
            delta={
              <Delta value={stats?.total_heal ?? 0} average={career.avgHeal} format="compact" />
            }
          />
          <HeadlineStat
            label="Gold"
            accent="bg-lol-gold"
            value={formatCompact(stats?.gold_earned ?? 0)}
            delta={
              <Delta value={stats?.gold_earned ?? 0} average={career.avgGold} format="compact" />
            }
          />
          <HeadlineStat
            label="Best spree"
            accent="bg-purple-400"
            value={String(stats?.largest_killing_spree ?? 0)}
            delta={
              <MultikillBadge
                doubles={stats?.double_kills ?? 0}
                triples={stats?.triple_kills ?? 0}
                quadras={stats?.quadra_kills ?? 0}
                pentas={stats?.penta_kills ?? 0}
              />
            }
          />

          <div className="ml-auto flex items-center gap-4 px-4">
            <div className="label text-right leading-tight">
              Final
              <br />
              build
            </div>
            <div className="space-y-[3px]">
              <div className="flex items-center gap-[3px]">
                {items.map((itemId, i) => (
                  <ItemIcon
                    key={i}
                    itemId={itemId ?? 0}
                    size={30}
                    patch={detail.game.game_version}
                  />
                ))}
              </div>
              {recap.detail.augments.length > 0 && (
                <div className="flex items-center gap-[3px]">
                  {recap.detail.augments.map((augment) => (
                    <AugmentIcon
                      key={augment.slot}
                      augmentId={augment.augment_id}
                      size={30}
                      patch={detail.game.game_version}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {recap.milestones.length > 0 && (
        <div className="flex flex-wrap gap-2.5">
          {recap.milestones.map((milestone) => (
            <div
              key={milestone.key}
              className="flex items-center gap-3 rounded-lg border border-lol-gold/35 bg-gradient-to-r from-lol-gold/[0.16] to-lol-gold/[0.04] py-2.5 pl-3 pr-4"
              title={milestone.detail}
            >
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-lol-gold/15">
                <SparklesIcon className="h-4 w-4 text-lol-gold" />
              </span>
              <div>
                <div className="font-display text-[15px] font-bold uppercase leading-tight tracking-[0.04em] text-lol-gold-light">
                  {milestone.label}
                </div>
                <div className="text-[12px] text-lol-text">{milestone.detail}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {recap.placements.length > 0 && (
        <Panel
          title="Where it lands"
          subtitle={`among ${career.games.toLocaleString(LOCALE)} recorded games`}
          icon={<MedalIcon className="h-3.5 w-3.5" />}
          accent="gold"
        >
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
            {recap.placements.map((placement) => (
              <PlacementCard key={placement.key} placement={placement} recap={recap} />
            ))}
          </div>
        </Panel>
      )}

      {recap.challenges.length > 0 && (
        <Panel
          title="Challenge progress"
          subtitle={`${recap.challenges.length} moved by this game`}
          icon={<AwardIcon className="h-3.5 w-3.5" />}
          accent="purple"
        >
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
            {recap.challenges.map((challenge) => (
              <ChallengeCard key={challenge.id} challenge={challenge} />
            ))}
          </div>
        </Panel>
      )}

      {/* The two panels share a height, each ending on its win-rate bar */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <Panel
          title="This session"
          subtitle={sessionSubtitle(session.games.length, session.duration)}
          icon={<TimerIcon className="h-3.5 w-3.5" />}
          accent="sky"
        >
          <div className="flex h-full flex-col gap-4">
            <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
              <MiniStat
                label={`${winRatePercent(session.wins, session.wins + session.losses)} win rate`}
              >
                <WinLoss wins={session.wins} losses={session.losses} />
              </MiniStat>
              <MiniStat label={`${kdaRatio(session.kills, session.deaths, session.assists)} KDA`}>
                <span className="text-[20px] text-lol-text-bright">
                  <Kda kills={session.kills} deaths={session.deaths} assists={session.assists} />
                </span>
              </MiniStat>
              {session.avgScore != null && (
                <MiniStat label="Avg score">
                  <span className={`text-[20px] ${scoreColor(session.avgScore)}`}>
                    {formatDecimal(session.avgScore)}
                  </span>
                </MiniStat>
              )}
              {streak && (
                <div className="ml-auto flex items-center gap-2.5">
                  <span
                    className={`flex h-8 w-8 items-center justify-center rounded-md ${
                      streak.kind === "win"
                        ? "bg-lol-win/12 text-lol-win"
                        : "bg-lol-loss/12 text-lol-loss"
                    }`}
                  >
                    {streak.kind === "win" ? (
                      <TrendingUpIcon className="h-4 w-4" />
                    ) : (
                      <TrendingDownIcon className="h-4 w-4" />
                    )}
                  </span>
                  <div>
                    <div
                      className={`font-display text-[16px] font-bold uppercase leading-tight tracking-[0.03em] ${
                        streak.kind === "win" ? "text-lol-win" : "text-lol-loss"
                      }`}
                    >
                      {streak.length}{" "}
                      {streak.kind === "win"
                        ? streak.length === 1
                          ? "win"
                          : "wins"
                        : streak.length === 1
                          ? "loss"
                          : "losses"}{" "}
                      in a row
                    </div>
                    <div className="text-[12px] text-lol-text">
                      {streak.isRecord
                        ? `Your longest ${streak.kind} streak ever`
                        : `${streak.kind === "win" ? "Best" : "Worst"}: ${streak.best}`}
                    </div>
                  </div>
                </div>
              )}
            </div>

            {session.games.length >= SESSION_STRIP_MIN ? (
              <SessionStrip games={session.games} index={session.index} champData={champData} />
            ) : (
              // Too short a session for a game-by-game strip: the same footer
              // as the champion panel beside it, so the two read as a pair
              <div className="mt-auto border-t border-lol-line pt-3">
                <WinRateBar wins={session.wins} total={session.wins + session.losses} />
                <SessionBest games={session.games} champData={champData} />
              </div>
            )}
          </div>
        </Panel>

        <Panel
          title={getChampionName(champData, champion.championId)}
          subtitle={`${champion.games.toLocaleString(LOCALE)} ${champion.games === 1 ? "game" : "games"} on record`}
          icon={<SwordsIcon className="h-3.5 w-3.5" />}
          accent="purple"
        >
          <div className="flex h-full flex-col gap-4">
            <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
              <MiniStat label="On this champion">
                <WinLoss wins={champion.wins} losses={champion.games - champion.wins} />
              </MiniStat>
              {champion.avgScore != null && (
                <MiniStat label="Avg score">
                  <span className={`text-[20px] ${scoreColor(champion.avgScore)}`}>
                    {formatDecimal(champion.avgScore)}
                  </span>
                </MiniStat>
              )}
            </div>
            <div className="mt-auto border-t border-lol-line pt-3">
              <WinRateBar wins={champion.wins} total={champion.games} />
              <div className="mt-2.5 text-[12px] text-lol-text">
                <span className="font-num text-[13px] text-lol-text-bright">
                  <Kda kills={champion.kills} deaths={champion.deaths} assists={champion.assists} />
                </span>{" "}
                lifetime
                {champion.previousBest != null && recap.score != null && (
                  <>
                    {" · "}
                    {recap.score > champion.previousBest
                      ? `beat your previous best of ${formatDecimal(champion.previousBest)}`
                      : `best on this champion: ${formatDecimal(champion.previousBest)}`}
                  </>
                )}
              </div>
            </div>
          </div>
        </Panel>
      </div>

      <section>
        <div className="mb-3 flex items-center gap-3 px-0.5">
          <span className="font-display text-[17px] font-bold uppercase italic tracking-[0.04em] text-lol-text-bright">
            Scoreboard
          </span>
          <span className="text-[13px] text-lol-text">
            {queueLabel(detail.game.queue_id)} · {formatDuration(detail.game.game_duration)}
          </span>
          <span className="h-px flex-1 bg-gradient-to-r from-lol-border to-transparent" />
        </div>
        <MatchScoreboard detail={detail} champData={champData} puuids={puuids} />
      </section>
    </div>
  );
}

function Dot() {
  return <span className="text-lol-text/40">·</span>;
}

// Wins and losses as the match history's profile card sets them: big numbers,
// small letters
function WinLoss({ wins, losses }: { wins: number; losses: number }) {
  // A zero is no result at all, so it stays neutral rather than coloured
  const winText = wins > 0 ? "text-lol-win" : "text-lol-text";
  const lossText = losses > 0 ? "text-lol-loss/85" : "text-lol-text";
  return (
    <span className="text-[30px]">
      <span className={winText}>{wins.toLocaleString(LOCALE)}</span>
      <span className={`ml-0.5 text-[17px] ${winText} opacity-75`}>W</span>
      <span className={`ml-2 ${lossText}`}>{losses.toLocaleString(LOCALE)}</span>
      <span className={`ml-0.5 text-[17px] ${lossText} opacity-75`}>L</span>
    </span>
  );
}

// A number with a quiet caption under it, for the session and champion panels
function MiniStat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="font-num font-semibold leading-none">{children}</div>
      <div className="mt-1.5 text-[12px] text-lol-text">{label}</div>
    </div>
  );
}

function sessionSubtitle(games: number, duration: number): string {
  const played = `${games} ${games === 1 ? "game" : "games"}`;
  return duration > 0 ? `${played} · ${formatPlaytime(duration)} played` : played;
}

function HeadlineStat({
  label,
  accent,
  value,
  delta,
}: {
  label: string;
  accent: string;
  value: string;
  delta?: ReactNode;
}) {
  return (
    <div className="min-w-[116px] border-r border-lol-line px-4">
      <div className="flex items-center gap-1.5">
        <span className={`h-2.5 w-[3px] rounded-[1px] ${accent}`} />
        <span className="label">{label}</span>
      </div>
      <div
        className={`font-num mt-1 text-[24px] font-semibold leading-none ${
          value === "0" ? "text-lol-text" : "text-lol-text-bright"
        }`}
      >
        {value}
      </div>
      {delta && <div className="font-num mt-1.5 min-h-4 text-[12px]">{delta}</div>}
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

function PlacementCard({ placement, recap }: { placement: RecapPlacement; recap: GameRecapData }) {
  const style = placement.good ? RANK_STYLES[placement.rank - 1] : undefined;

  return (
    <div className={`rounded-lg border px-3.5 py-3 ${style ?? "border-lol-line bg-white/[0.02]"}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="label truncate">{placement.label}</span>
        {placement.rank === 1 && (
          <StarIcon
            className={`h-3.5 w-3.5 shrink-0 ${placement.good ? "text-lol-gold" : "text-lol-loss/70"}`}
            fill="currentColor"
          />
        )}
      </div>
      <div className="font-num mt-1.5 text-[26px] font-semibold leading-none text-lol-text-bright">
        {placementValue(placement, recap)}
      </div>
      <div
        className={`mt-1.5 text-[12px] ${
          placement.good && placement.rank === 1 ? "font-semibold text-lol-gold" : "text-lol-text"
        }`}
      >
        {placement.rank === 1
          ? placement.good
            ? "Best ever"
            : "Most ever"
          : `${ordinal(placement.rank, LOCALE)} of ${placement.total.toLocaleString(LOCALE)}`}
      </div>
    </div>
  );
}

// What this one game moved. The client hands over the before and after itself,
// so the gain is exact rather than inferred from a daily snapshot.
function ChallengeCard({ challenge }: { challenge: RecapChallenge }) {
  const gain = challenge.currentValue - challenge.previousValue;
  const tierUp = challenge.previousLevel !== challenge.currentLevel;

  return (
    <div
      className={`rounded-lg border px-3.5 py-2.5 ${
        tierUp
          ? "border-lol-gold/45 bg-gradient-to-r from-lol-gold/[0.14] to-lol-gold/[0.04]"
          : "border-lol-line bg-white/[0.02]"
      }`}
      title={challenge.description}
    >
      <div className="flex items-center gap-2.5">
        <ChallengeToken iconPath={challenge.iconPath} size={32} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="truncate text-[13px] font-semibold text-lol-text-bright">
              {challenge.name}
            </span>
            <span className="font-num ml-auto shrink-0 text-[15px] font-semibold text-lol-win">
              +{formatChallengeValue(gain)}
            </span>
          </div>
          <div className="truncate text-[12px] text-lol-text">
            {tierUp ? (
              <span
                className="font-semibold"
                style={{
                  color: CHALLENGE_LEVEL_COLORS[challenge.currentLevel],
                }}
              >
                {challengeLevelName(challenge.previousLevel)} to{" "}
                {challengeLevelName(challenge.currentLevel)}
              </span>
            ) : challenge.nextThreshold == null ? (
              `${formatChallengeValue(challenge.currentValue)} · complete`
            ) : (
              `${formatChallengeValue(challenge.currentValue)} / ${formatChallengeValue(
                challenge.nextThreshold,
              )} to ${challengeLevelName(challenge.nextLevel)}`
            )}
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
function SessionBest({ games, champData }: { games: RecapSessionGame[]; champData: ChampionData }) {
  const best = games.reduce<RecapSessionGame | null>(
    (top, g) => (g.score != null && (top?.score == null || g.score > top.score) ? g : top),
    null,
  );
  // One game's best is the game above it, already on show; say where the
  // session stands instead, keeping the line that pairs it with the panel beside
  if (games.length < 2) {
    return <div className="mt-2.5 text-[12px] text-lol-text">First game of the session</div>;
  }
  if (!best || best.score == null) return null;
  return (
    <div className="mt-2.5 text-[12px] text-lol-text">
      Best game:{" "}
      <span className="font-display text-[13px] font-semibold text-lol-text-bright">
        {getChampionName(champData, best.champion_id)}
      </span>{" "}
      <span className="font-num text-[13px]">
        <Kda kills={best.kills} deaths={best.deaths} assists={best.assists} />
      </span>{" "}
      ·{" "}
      <span className={`font-num text-[13px] ${scoreColor(best.score)}`}>
        {formatDecimal(best.score)}
      </span>{" "}
      score
    </div>
  );
}

function SessionStrip({
  games,
  index,
  champData,
}: {
  games: RecapSessionGame[];
  index: number;
  champData: ChampionData;
}) {
  if (games.length < SESSION_STRIP_MIN) return null;

  return (
    <div className="border-t border-lol-line pt-3">
      <div className="label mb-2.5">Game by game</div>
      <div className="flex flex-wrap gap-x-1.5 gap-y-2">
        {games.map((game, i) => {
          const current = i === index;
          return (
            <div
              key={game.game_id}
              title={`${getChampionName(champData, game.champion_id)} · ${formatKDA(
                game.kills,
                game.deaths,
                game.assists,
              )}${game.score != null ? ` · ${formatDecimal(game.score)} score` : ""}`}
              className={`flex w-7 flex-col items-center gap-1.5 rounded-[3px] py-1.5 ${
                current ? "bg-lol-gold/10 ring-1 ring-inset ring-lol-gold/50" : ""
              }`}
            >
              <span
                className={`slant-sm block h-4 w-[9px] ${game.win ? "bg-lol-win" : "bg-lol-loss/75"}`}
              />
              <span
                className={`font-num text-[12px] font-semibold leading-none ${
                  game.score != null ? scoreColor(game.score) : "text-lol-text"
                }`}
              >
                {game.score != null ? formatDecimal(game.score) : "–"}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
