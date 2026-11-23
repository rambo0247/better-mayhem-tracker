import { children, createMemo, For, Show } from "solid-js";
import { Dynamic, type JSX } from "@solidjs/web";
import type {
  ChampionData,
  ItemStats,
  SeasonChampion,
  SeasonRecap,
  TeammateStats,
} from "../lib/types";
import { getChampionName, useItemData } from "../hooks/useChampions";
import { CHAMPION_SPLASH_URL } from "../lib/constants";
import {
  LOCALE,
  formatDecimal,
  formatDuration,
  formatHour,
  formatPercent,
  formatPlaytime,
  formatTotal,
  formatWeekday,
  kdaColor,
  kdaRatio,
  scoreColor,
  winRateColor,
  winRatePercent,
} from "../lib/format";
import { ALL_TIME_ID, findSeason, seasonBounds, seasonDate } from "@shared/seasons";
import { sessionDay } from "@shared/session";
import ActivityCalendar from "./ActivityCalendar";
import AugmentIcon from "./AugmentIcon";
import BrandMark from "./BrandMark";
import ChampionIcon from "./ChampionIcon";
import ItemIcon from "./ItemIcon";
import Kda from "./Kda";
import Panel from "./Panel";
import { recordCards, recordDate, type RecordCardDef } from "./RecordCard";
import { ACCENTS } from "./StatCard";
import SummonerIcon from "./SummonerIcon";
import WinRateBar from "./WinRateBar";
import {
  CalendarIcon,
  ClockIcon,
  CoinsIcon,
  CrosshairIcon,
  FlameIcon,
  MedalIcon,
  SparklesIcon,
  SwordsIcon,
  TrendingUpIcon,
  TrophyIcon,
  UsersIcon,
  ZapIcon,
} from "./icons";

// Matching the six champions and augments the main process sends, so the
// three lists line up
const TOP_ITEMS = 6;
// The record tiles worth sharing, in the order they're wanted: the first four a
// season has set make the row
const RECORD_KEYS = ["kills", "damage", "score", "spree", "kda", "healing", "taken", "assists"];
const RECORD_COUNT = 4;
// A season up to this many calendar weeks long is short enough to set its
// facts beside the calendar rather than under it
const SHORT_WEEKS = 16;
const DAY_MS = 86_400_000;

function calendarWeeks(span: { first: number; last: number }): number {
  return Math.ceil((span.last - span.first) / DAY_MS / 7) + 1;
}

// How wide a calendar week is drawn where it isn't stretched to fill: a season
// of a few weeks gets big squares so it holds its panel, a longer one the
// usual size
function calendarCell(span: { first: number; last: number }): number {
  const weeks = calendarWeeks(span);
  if (weeks <= 8) return 27;
  if (weeks <= SHORT_WEEKS) return 24;
  return 20;
}

const DATE_FORMAT = new Intl.DateTimeFormat(LOCALE, {
  month: "short",
  day: "numeric",
  year: "numeric",
});
const SHORT_DATE_FORMAT = new Intl.DateTimeFormat(LOCALE, { month: "short", day: "numeric" });
const WEEKDAY_DATE_FORMAT = new Intl.DateTimeFormat(LOCALE, {
  weekday: "short",
  month: "short",
  day: "numeric",
});

// What the card says it covers: the season's own dates where it has them, the
// span of games played for all time
function coverage(recap: SeasonRecap): string | null {
  const { season } = recap;
  if (season.start) {
    const start = seasonDate(season.start);
    if (!season.end) return `Since ${DATE_FORMAT.format(start)}`;
    return DATE_FORMAT.formatRange(start, seasonDate(season.end));
  }
  return recap.firstGame != null && recap.lastGame != null
    ? DATE_FORMAT.formatRange(recap.firstGame, recap.lastGame)
    : null;
}

// The session days the calendar covers, on the same terms as coverage: a whole
// season, up to today for one with no end announced, or the span of games for
// all time. Days after `through` are still to come.
function calendarSpan(recap: SeasonRecap): { first: number; last: number; through: number } | null {
  const { season } = recap;
  const today = sessionDay(Date.now());
  if (season.start) {
    const last = season.end ? seasonDate(season.end) : today;
    return { first: seasonDate(season.start), last, through: Math.min(last, today) };
  }
  const last = recap.lastGame == null ? null : sessionDay(recap.lastGame);
  return recap.firstGame != null && last != null
    ? { first: sessionDay(recap.firstGame), last, through: last }
    : null;
}

function inProgress(seasonId: string): boolean {
  const season = findSeason(seasonId);
  if (!season) return false;
  const { from, to } = seasonBounds(season);
  const now = Date.now();
  return now >= from && (to == null || now < to);
}

// Riot ids come through as "Name#TAG", and the tag reads better set back
function splitRiotId(id: string): [string, string | null] {
  const hash = id.lastIndexOf("#");
  return hash > 0 ? [id.slice(0, hash), id.slice(hash + 1)] : [id, null];
}

function kdaValue(kills: number, deaths: number, assists: number): number {
  return deaths === 0 ? Infinity : (kills + assists) / deaths;
}

function perGame(total: number, games: number): string {
  return formatDecimal(games > 0 ? total / games : 0);
}

// MVP and ACE out of the games that could have produced them, as the match
// list's dashboard counts them
function share(count: number, of: number, games: string): string {
  return of > 0 ? `${formatPercent(count / of)} of ${games}` : `no scored ${games}`;
}

/**
 * A season on one card, for sharing: who played, how much and how well, what
 * they played it on, their best games, who they played with and when. Drawn at the
 * export width (CARD_WIDTH) both in the capture window and in the page's
 * preview, which scales it down rather than reflowing it, so what the page
 * shows is exactly the image that gets saved.
 *
 * The card paints its own stage edge to edge, so the image needs no frame
 * around it to look finished.
 *
 * With hideFriends, the people played with have their names blanked out, for
 * sharing an image without putting anyone else's name in it.
 */
export default function SeasonRecapCard(props: {
  recap: SeasonRecap;
  champData: ChampionData;
  hideFriends?: boolean;
}) {
  const topChampion = () => props.recap.champions[0] ?? null;
  const highlights = createMemo(() => {
    const records = recordCards(props.recap.records.bests);
    return RECORD_KEYS.flatMap((key) => records.filter((card) => card.key === key)).slice(
      0,
      RECORD_COUNT,
    );
  });

  return (
    <div class="app-stage relative overflow-hidden px-8 pt-8 pb-7">
      {/* The gold rule along the top edge, the graphic's signature */}
      <span class="pointer-events-none absolute inset-x-0 top-0 h-[3px] bg-gradient-to-r from-lol-gold via-lol-gold-light/80 to-lol-gold/10" />

      <div class="relative space-y-5">
        <Hero recap={props.recap} champData={props.champData} topChampion={topChampion()} />

        <Combat recap={props.recap} />

        <div class="grid grid-cols-3 gap-4">
          <Panel
            title="Top champions"
            subtitle={`${props.recap.uniqueChampions} played`}
            icon={<TrophyIcon class="h-3 w-3" />}
            accent="gold"
            class="h-full"
          >
            <Rows empty="No champions yet" count={props.recap.champions.length}>
              <For each={props.recap.champions}>
                {(champ, i) => (
                  <ChampionRow rank={i() + 1} champ={champ} champData={props.champData} />
                )}
              </For>
            </Rows>
          </Panel>
          <Panel
            title="Top augments"
            icon={<CrosshairIcon class="h-3 w-3" />}
            accent="purple"
            class="h-full"
          >
            <Rows empty="No augments recorded" count={props.recap.augments.length}>
              <For each={props.recap.augments}>
                {(augment, i) => (
                  <PickRow rank={i() + 1} picks={augment.picks} wins={augment.wins}>
                    <AugmentIcon
                      augmentId={augment.augment_id}
                      size={32}
                      showName
                      nameClass="font-display text-[16px] font-semibold"
                      patch={props.recap.patch}
                    />
                  </PickRow>
                )}
              </For>
            </Rows>
          </Panel>
          <ItemsPanel recap={props.recap} />
        </div>

        <Show when={highlights().length > 0}>
          <Panel
            title={props.recap.season.id === ALL_TIME_ID ? "Personal bests" : "Season bests"}
            subtitle="single-game highs"
            icon={<MedalIcon class="h-3 w-3" />}
            accent="gold"
          >
            <div class="-mx-4 -mb-4 grid grid-cols-4 divide-x divide-lol-line border-t border-lol-line">
              <For each={highlights()}>
                {(card) => <Best card={card} champData={props.champData} />}
              </For>
            </div>
          </Panel>
        </Show>

        {/* The calendar's panel is as wide as the calendar wants, within
            limits, and the people played with take the rest: a short season's
            few weeks then leave no empty box beside them */}
        <Show when={props.recap.friends.length > 0} fallback={<Activity recap={props.recap} />}>
          <div class="grid grid-cols-[minmax(0,1fr)_auto] gap-4">
            <Panel
              title="Played most with"
              subtitle="games on your team"
              icon={<UsersIcon class="h-3 w-3" />}
              accent="sky"
              class="h-full"
            >
              {/* One grid for every row, so the champions and bars start on one line
                  while the name column is only as wide as the longest name. The
                  edge tracks carry the rows' 16px padding on top of their own
                  32px avatar and 64px record. */}
              <div class="-mx-4 -mb-4 grid grid-cols-[48px_fit-content(170px)_auto_minmax(40px,1fr)_80px] gap-x-3 divide-y divide-lol-line border-t border-lol-line">
                <For each={props.recap.friends}>
                  {(friend) => <FriendRow friend={friend} hideName={props.hideFriends ?? false} />}
                </For>
              </div>
            </Panel>
            <Activity recap={props.recap} narrow />
          </div>
        </Show>
      </div>
    </div>
  );
}

// The banner: the player over their most played champion's splash, then the
// season's headline numbers along its foot like a broadcast lower third
const HERO_TAG =
  "slant px-3 font-display text-[13px] font-extrabold italic uppercase leading-[22px] tracking-[0.1em]";

function Hero(props: {
  recap: SeasonRecap;
  champData: ChampionData;
  topChampion: SeasonChampion | null;
}) {
  const title = () =>
    props.recap.season.id === ALL_TIME_ID ? "All-Time Recap" : `${props.recap.season.name} Recap`;
  const dates = () => coverage(props.recap);
  const live = () => inProgress(props.recap.season.id);
  const losses = () => props.recap.games - props.recap.wins;
  const streak = () => props.recap.records.winStreak;
  const lossStreak = () => props.recap.records.lossStreak;

  return (
    <div class="panel overflow-hidden">
      <div class="relative min-h-[236px]">
        <Show when={props.topChampion}>
          {(top) => (
            <img
              src={CHAMPION_SPLASH_URL(top().champion_id)}
              alt=""
              class="absolute inset-y-0 right-0 h-full w-[72%] object-cover object-[center_22%] opacity-75"
              onError={(e) => {
                e.currentTarget.style.display = "none";
              }}
            />
          )}
        </Show>
        {/* The art fades out behind the name so the text never sits on a busy
            part of the splash, and darkens toward the numbers below it */}
        <div class="absolute inset-0 bg-gradient-to-r from-lol-card from-[34%] via-lol-card/75 via-[58%] to-lol-card/0" />
        <div class="absolute inset-0 bg-gradient-to-t from-lol-card/90 via-transparent to-lol-card/40" />
        <span class="pointer-events-none absolute -left-20 -top-28 h-80 w-80 rounded-full bg-lol-gold/[0.08] blur-3xl" />

        <div class="relative flex h-full min-h-[236px] items-center gap-7 px-8 py-7">
          <div class="shrink-0 rounded-full bg-gradient-to-b from-lol-gold-light via-lol-gold to-lol-gold/30 p-[3px] shadow-[0_10px_30px_-8px_rgb(212_178_115/0.45)]">
            <SummonerIcon
              iconId={props.recap.player.profileIcon}
              size={112}
              class="border-[3px] border-lol-card"
            />
          </div>

          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2.5">
              <span class="kicker text-lol-text-bright/80">ARAM Mayhem</span>
              {/* The season and whether it is still going share one tag shape */}
              <span class={[HERO_TAG, "bg-lol-gold text-[#140f04]"]}>{title()}</span>
              <Show when={live()}>
                <span class={[HERO_TAG, "bg-lol-win text-[#04140c]"]}>
                  In progress · as of{" "}
                  {new Date().toLocaleDateString(LOCALE, { month: "short", day: "numeric" })}
                </span>
              </Show>
            </div>
            <div class="mt-3 truncate font-display text-[64px] font-extrabold italic uppercase leading-[0.9] tracking-[0.005em] text-lol-text-bright">
              <bdi>{props.recap.player.gameName ?? "Summoner"}</bdi>
              <Show when={props.recap.player.tagLine}>
                <span class="ml-2 text-[30px] font-bold text-lol-text/55">
                  #<bdi>{props.recap.player.tagLine}</bdi>
                </span>
              </Show>
            </div>
            <div class="mt-3.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[14px] text-lol-text">
              <Show when={dates()}>
                <span class="inline-flex items-center gap-1.5">
                  <CalendarIcon class="h-4 w-4 text-lol-gold" />
                  {dates()}
                </span>
              </Show>
              <Show when={props.recap.accounts > 1}>
                <span class="text-lol-text/80">{props.recap.accounts} accounts combined</span>
              </Show>
            </div>
          </div>

          <div class="flex shrink-0 flex-col items-end gap-6 self-stretch">
            <div class="flex items-center gap-2.5">
              <BrandMark class="h-7 w-7 drop-shadow-[0_4px_12px_rgb(212_178_115/0.3)]" />
              <span class="flex flex-col font-display font-extrabold italic uppercase leading-[0.95] tracking-[0.04em]">
                <span class="text-[15px] text-lol-text-bright">Better Mayhem</span>
                <span class="text-[11px] tracking-[0.26em] text-lol-gold">Tracker</span>
              </span>
            </div>
            <Show when={props.topChampion}>
              {(top) => (
                <div class="mt-auto text-right">
                  <div class="label text-lol-gold/90">Most played</div>
                  <div class="mt-1 font-display text-[28px] font-bold italic uppercase leading-none text-lol-text-bright">
                    {getChampionName(props.champData, top().champion_id)}
                  </div>
                  <div class="mt-1.5 font-num text-[14px] text-lol-text">
                    {top().games.toLocaleString(LOCALE)} {top().games === 1 ? "game" : "games"} ·{" "}
                    <span class={winRateColor(top().wins, top().games)}>
                      {winRatePercent(top().wins, top().games)}
                    </span>{" "}
                    win rate
                  </div>
                </div>
              )}
            </Show>
          </div>
        </div>
      </div>

      <div class="relative grid grid-cols-5 divide-x divide-lol-line border-t border-lol-line bg-black/30">
        <Headline
          label="Games"
          icon={<SwordsIcon class="h-3.5 w-3.5" />}
          tone="text-lol-gold"
          value={props.recap.games.toLocaleString(LOCALE)}
          sub={`${props.recap.days.length} ${props.recap.days.length === 1 ? "day" : "days"} played`}
        />
        <Headline
          label="Record"
          icon={<TrophyIcon class="h-3.5 w-3.5" />}
          tone="text-lol-win"
          value={
            <>
              <span class="text-lol-win">{props.recap.wins.toLocaleString(LOCALE)}</span>
              <span class="ml-0.5 text-[20px] text-lol-win/70">W</span>
              <span class="ml-2.5 text-lol-loss/85">{losses().toLocaleString(LOCALE)}</span>
              <span class="ml-0.5 text-[20px] text-lol-loss/60">L</span>
            </>
          }
        >
          <WinRateBar wins={props.recap.wins} total={props.recap.games} />
        </Headline>
        <Headline
          label="Time played"
          icon={<ClockIcon class="h-3.5 w-3.5" />}
          tone="text-sky-400"
          value={formatPlaytime(props.recap.duration)}
          sub={`${formatDuration(Math.round(props.recap.duration / props.recap.games))} average game`}
        />
        <Headline
          label="Best win streak"
          icon={<TrendingUpIcon class="h-3.5 w-3.5" />}
          tone="text-purple-400"
          value={
            <Show when={streak()} fallback="None yet">
              {(best) => (
                <>
                  {best().length}
                  <span class="ml-1.5 text-[20px] text-lol-text">
                    {best().length === 1 ? "win" : "wins"}
                  </span>
                </>
              )}
            </Show>
          }
          sub={
            lossStreak() && lossStreak()!.length > 1
              ? `Longest loss streak: ${lossStreak()!.length}`
              : undefined
          }
        />
        <Headline
          label="KDA"
          icon={<ZapIcon class="h-3.5 w-3.5" />}
          tone="text-sky-400"
          value={
            <span
              class={kdaColor(kdaValue(props.recap.kills, props.recap.deaths, props.recap.assists))}
            >
              {kdaRatio(props.recap.kills, props.recap.deaths, props.recap.assists)}
            </span>
          }
          sub={
            <>
              <span class="font-num">
                <Kda
                  kills={perGame(props.recap.kills, props.recap.games)}
                  deaths={perGame(props.recap.deaths, props.recap.games)}
                  assists={perGame(props.recap.assists, props.recap.games)}
                />
              </span>{" "}
              per game
            </>
          }
        />
      </div>
    </div>
  );
}

function Headline(props: {
  label: string;
  icon: JSX.Element;
  tone: string;
  value: JSX.Element;
  sub?: JSX.Element;
  children?: JSX.Element;
}) {
  // Resolved once: each read of a JSX prop would build its nodes again
  const sub = children(() => props.sub);
  const extra = children(() => props.children);
  return (
    <div class="flex min-w-0 flex-col px-6 py-5">
      <div class="flex items-center gap-1.5">
        <span class={props.tone}>{props.icon}</span>
        <span class="label">{props.label}</span>
      </div>
      <div class="mt-2 truncate font-num text-[40px] font-semibold leading-none text-lol-text-bright">
        {props.value}
      </div>
      <Show when={sub()}>
        <div class="mt-2 truncate text-[13px] text-lol-text">{sub()}</div>
      </Show>
      <Show when={extra()}>
        <div class="mt-auto pt-3">{extra()}</div>
      </Show>
    </div>
  );
}

// The fight in three tiers: the four numbers that say how a season went, big;
// the multikills, each in its own colour; then everything else, small
function Combat(props: { recap: SeasonRecap }) {
  const games = () => props.recap.games;
  const kills = () => [
    { label: "Double", count: props.recap.multikills.doubles, tone: "text-sky-400" },
    { label: "Triple", count: props.recap.multikills.triples, tone: "text-amber-400" },
    { label: "Quadra", count: props.recap.multikills.quadras, tone: "text-purple-400" },
    { label: "Penta", count: props.recap.multikills.pentas, tone: "text-red-400" },
  ];

  return (
    <Panel
      title="Combat"
      subtitle={`across ${games().toLocaleString(LOCALE)} ${games() === 1 ? "game" : "games"}`}
      icon={<FlameIcon class="h-3 w-3" />}
      accent="purple"
    >
      <div class="-mx-4 grid grid-cols-4 divide-x divide-lol-line border-t border-lol-line">
        <Lead
          label="Kills"
          value={props.recap.kills.toLocaleString(LOCALE)}
          sub={`${perGame(props.recap.kills, games())} per game`}
        />
        <Lead
          label="Damage dealt"
          value={formatTotal(props.recap.damage)}
          sub={
            props.recap.damageShare != null
              ? `${formatPercent(props.recap.damageShare)} of team damage`
              : "to champions"
          }
        />
        <Lead
          label="Kill participation"
          value={
            props.recap.killParticipation != null
              ? formatPercent(props.recap.killParticipation)
              : "-"
          }
          sub="of team kills"
        />
        <Lead
          label="Avg score"
          value={props.recap.avgScore != null ? formatDecimal(props.recap.avgScore) : "-"}
          tone={props.recap.avgScore != null ? scoreColor(props.recap.avgScore) : undefined}
          sub="out of 10"
        />
      </div>

      <div class="-mx-4 -mb-4 flex border-t border-lol-line bg-black/20">
        <div class="shrink-0 border-r border-lol-line px-5 py-4">
          <div class="label">Multikills</div>
          <div class="mt-2.5 grid grid-cols-4 gap-2">
            <For each={kills()}>
              {(kill) => (
                <div class="w-[76px] rounded-md border border-lol-line bg-white/[0.025] py-2 text-center">
                  <div class={["font-num text-[26px] font-semibold leading-none", kill.tone]}>
                    {kill.count.toLocaleString(LOCALE)}
                  </div>
                  <div class="label mt-1 text-[12px] text-lol-text-bright/75">{kill.label}</div>
                </div>
              )}
            </For>
          </div>
        </div>
        <div class="grid flex-1 grid-cols-4 gap-x-5 gap-y-3.5 px-5 py-4">
          <Minor
            label="Deaths"
            value={props.recap.deaths.toLocaleString(LOCALE)}
            sub={`${perGame(props.recap.deaths, games())}/game`}
          />
          <Minor
            label="Assists"
            value={props.recap.assists.toLocaleString(LOCALE)}
            sub={`${perGame(props.recap.assists, games())}/game`}
          />
          <Minor
            label="MVP"
            value={props.recap.mvps.toLocaleString(LOCALE)}
            sub={share(props.recap.mvps, props.recap.scoredWins, "wins")}
          />
          <Minor
            label="ACE"
            value={props.recap.aces.toLocaleString(LOCALE)}
            sub={share(props.recap.aces, props.recap.scoredLosses, "losses")}
          />
          <Minor
            label="Damage taken"
            value={formatTotal(props.recap.damageTaken)}
            sub={`${formatTotal(props.recap.damageTaken / games())}/game`}
          />
          <Minor
            label="Healing"
            value={formatTotal(props.recap.healing)}
            sub={`${formatTotal(props.recap.healing / games())}/game`}
          />
          <Minor
            label="Gold earned"
            value={formatTotal(props.recap.gold)}
            sub={`${formatTotal(props.recap.gold / games())}/game`}
          />
          <Minor
            label="Damage / min"
            value={Math.round(props.recap.damage / (props.recap.duration / 60)).toLocaleString(
              LOCALE,
            )}
            sub="to champions"
          />
        </div>
      </div>
    </Panel>
  );
}

function Lead(props: { label: string; value: JSX.Element; sub: string; tone?: string }) {
  return (
    <div class="min-w-0 px-5 py-4">
      <div class="label">{props.label}</div>
      <div
        class={[
          "mt-1.5 font-num text-[38px] font-semibold leading-none",
          props.tone ?? "text-lol-text-bright",
        ]}
      >
        {props.value}
      </div>
      <div class="mt-2 truncate text-[13px] text-lol-text">{props.sub}</div>
    </div>
  );
}

function Minor(props: { label: string; value: string; sub: string }) {
  return (
    <div class="min-w-0">
      <div class="label truncate text-[12px] text-lol-text-bright/75">{props.label}</div>
      <div class="mt-0.5 flex items-baseline gap-1.5">
        <span class="font-num text-[20px] font-semibold leading-tight text-lol-text-bright">
          {props.value}
        </span>
        <span class="truncate text-[12px] text-lol-text">{props.sub}</span>
      </div>
    </div>
  );
}

function Rows(props: { empty: string; count: number; children: JSX.Element }) {
  return (
    <Show
      when={props.count > 0}
      fallback={<div class="py-4 text-[13px] text-lol-text">{props.empty}</div>}
    >
      <div class="-mx-4 -mb-4 divide-y divide-lol-line border-t border-lol-line">
        {props.children}
      </div>
    </Show>
  );
}

function WinRate(props: { wins: number; games: number; detail: string }) {
  return (
    <div class="shrink-0 text-right">
      <div
        class={[
          "font-num text-[17px] font-semibold leading-tight",
          winRateColor(props.wins, props.games),
        ]}
      >
        {winRatePercent(props.wins, props.games)}
      </div>
      <div class="font-num text-[12px] text-lol-text">{props.detail}</div>
    </div>
  );
}

// A place in one of the three top-six lists: the rank, the thing ranked, then
// how it went. Fixed height so the lists' rows line up across the columns.
function ListRow(props: { rank: number; children: JSX.Element }) {
  return (
    <div class="flex h-[54px] items-center gap-3 px-4">
      <span
        class={[
          "w-3 shrink-0 text-center font-num text-[15px] font-semibold",
          props.rank === 1 ? "text-lol-gold" : "text-lol-text/50",
        ]}
      >
        {props.rank}
      </span>
      {props.children}
    </div>
  );
}

function ChampionRow(props: { rank: number; champ: SeasonChampion; champData: ChampionData }) {
  return (
    <ListRow rank={props.rank}>
      <ChampionIcon championId={props.champ.champion_id} size={36} />
      <div class="min-w-0 flex-1">
        <div class="truncate font-display text-[16px] font-semibold leading-tight text-lol-text-bright">
          {getChampionName(props.champData, props.champ.champion_id)}
        </div>
        <div class="truncate text-[12px] text-lol-text">
          <span
            class={[
              "font-num",
              kdaColor(kdaValue(props.champ.kills, props.champ.deaths, props.champ.assists)),
            ]}
          >
            {kdaRatio(props.champ.kills, props.champ.deaths, props.champ.assists)}
          </span>{" "}
          KDA
          <Show when={props.champ.avgScore != null}>
            {" · "}
            <span class={["font-num", scoreColor(props.champ.avgScore!)]}>
              {formatDecimal(props.champ.avgScore!)}
            </span>{" "}
            score
          </Show>
        </div>
      </div>
      <WinRate
        wins={props.champ.wins}
        games={props.champ.games}
        detail={`${props.champ.games.toLocaleString(LOCALE)} ${props.champ.games === 1 ? "game" : "games"}`}
      />
    </ListRow>
  );
}

function PickRow(props: { rank: number; picks: number; wins: number; children: JSX.Element }) {
  return (
    <ListRow rank={props.rank}>
      <div class="min-w-0 flex-1">{props.children}</div>
      <WinRate
        wins={props.wins}
        games={props.picks}
        detail={`${props.picks.toLocaleString(LOCALE)} ${props.picks === 1 ? "pick" : "picks"}`}
      />
    </ListRow>
  );
}

// Boots are bought nearly every game, so only the favourite pair makes the
// list, last and labelled, rather than letting three pairs crowd out the items.
// The label is what explains a pair with more picks sitting below the rest.
function ItemsPanel(props: { recap: SeasonRecap }) {
  const itemData = useItemData(() => props.recap.patch);
  const listing = createMemo(() => {
    const isBoots = (item: ItemStats) => itemData()[item.item_id]?.boots ?? false;
    const boots = props.recap.items.find(isBoots);
    const items = props.recap.items
      .filter((item) => !isBoots(item))
      .slice(0, boots ? TOP_ITEMS - 1 : TOP_ITEMS);
    if (boots) items.push(boots);
    return { items, boots };
  });

  return (
    <Panel title="Top items" icon={<CoinsIcon class="h-3 w-3" />} accent="win" class="h-full">
      <Rows empty="No items recorded" count={listing().items.length}>
        <For each={listing().items}>
          {(item, i) => (
            <PickRow rank={i() + 1} picks={item.picks} wins={item.wins}>
              <div class="flex min-w-0 items-center gap-2">
                <ItemIcon itemId={item.item_id} size={32} patch={props.recap.patch} />
                <span class="truncate font-display text-[16px] font-semibold text-lol-text-bright">
                  {itemData()[item.item_id]?.name || `Item ${item.item_id}`}
                </span>
                <Show when={item === listing().boots}>
                  <span class="chip shrink-0 border border-lol-border text-[11px] text-lol-text">
                    Boots
                  </span>
                </Show>
              </div>
            </PickRow>
          )}
        </For>
      </Rows>
    </Panel>
  );
}

// One single-game best: the number, then the game it was set in along the foot
function Best(props: { card: RecordCardDef; champData: ChampionData }) {
  return (
    <div class="flex min-w-0 flex-col px-5 py-4">
      <div class="flex items-center gap-2">
        <span
          class={[
            "flex h-5 w-5 items-center justify-center rounded-md",
            ACCENTS[props.card.accent].chip,
          ]}
        >
          <Dynamic component={props.card.icon} class="h-3 w-3" />
        </span>
        <span class="label truncate">{props.card.label}</span>
      </div>
      <div class="mt-2 font-num text-[36px] font-semibold leading-none text-lol-text-bright">
        {props.card.value}
      </div>
      <Show when={props.card.sub}>
        <div class="mt-1 text-[12px] text-lol-text">{props.card.sub}</div>
      </Show>
      <div class="mt-auto flex items-center gap-2.5 pt-4">
        <ChampionIcon championId={props.card.match.champion_id} size={30} />
        <div class="min-w-0 flex-1">
          <div class="truncate font-display text-[15px] font-semibold leading-tight text-lol-text-bright">
            {getChampionName(props.champData, props.card.match.champion_id)}
          </div>
          <div class="truncate text-[12px] text-lol-text">
            <span
              class={[
                "font-display font-bold",
                props.card.match.win ? "text-lol-win" : "text-lol-loss",
              ]}
            >
              {props.card.match.win ? "W" : "L"}
            </span>
            {" · "}
            <span class="font-num">
              <Kda
                kills={props.card.match.kills}
                deaths={props.card.match.deaths}
                assists={props.card.match.assists}
              />
            </span>
            {" · "}
            {recordDate(props.card.match.game_creation)}
          </div>
        </div>
      </div>
    </div>
  );
}

// A row of the list's shared grid: the name column sizes to the longest name
// (long ones cut short), the champions played together close behind it, then
// the bar runs on to the record
function FriendRow(props: { friend: TeammateStats; hideName: boolean }) {
  const parts = () => splitRiotId(props.friend.name);
  const rate = () => (props.friend.games > 0 ? (props.friend.wins / props.friend.games) * 100 : 0);

  return (
    <div class="col-span-5 grid h-14 grid-cols-subgrid items-center px-4">
      <SummonerIcon iconId={props.friend.profileIcon} size={32} />
      <div class="min-w-0">
        <Show
          when={!props.hideName}
          fallback={
            // A blank where the name goes, the height of the line it stands in for
            <div class="flex h-5 items-center">
              <div class="h-1 w-24 rounded-[2px] bg-lol-text/30" />
            </div>
          }
        >
          <div class="truncate font-display text-[16px] font-semibold leading-5 text-lol-text-bright">
            <bdi>{parts()[0]}</bdi>
            <Show when={parts()[1]}>
              <span class="font-medium text-lol-text/55">
                {" "}
                #<bdi>{parts()[1]}</bdi>
              </span>
            </Show>
          </div>
        </Show>
        <div class="text-[12px] text-lol-text">
          <span class="font-num">{props.friend.games.toLocaleString(LOCALE)}</span> games together
        </div>
      </div>
      <div class="flex shrink-0 -space-x-1.5">
        <For each={props.friend.champions.slice(0, 3)}>
          {(champ) => (
            <ChampionIcon championId={champ.champion_id} size={24} class="ring-2 ring-lol-card" />
          )}
        </For>
      </div>
      {/* Wins against losses, with the even-odds line marked, as WinRateBar
          draws it, minus the figure the column beside it already gives */}
      <div class="relative h-1.5 overflow-hidden rounded-[2px] bg-lol-loss/25">
        <div
          class="h-full rounded-[2px] bg-gradient-to-r from-lol-win/70 to-lol-win"
          style={{ width: `${rate()}%` }}
        />
        <span class="absolute inset-y-0 left-1/2 w-px bg-lol-dark/70" />
      </div>
      <div>
        <WinRate
          wins={props.friend.wins}
          games={props.friend.games}
          detail={`${props.friend.wins.toLocaleString(LOCALE)}W ${(props.friend.games - props.friend.wins).toLocaleString(LOCALE)}L`}
        />
      </div>
    </div>
  );
}

interface Fact {
  key: string;
  icon: (props: { class?: string }) => JSX.Element;
  label: string;
  value: string;
  sub: string;
}

// A two-by-two square of facts, ruled between the cells only
const SQUARE =
  "grid grid-cols-2 [&>*]:border-lol-line [&>*:nth-child(even)]:border-l [&>*:nth-child(n+3)]:border-t";

// When the season was played: every day of it on a calendar, then what the
// days had in common. Beside the people played with it is `narrow`: a season
// of a few weeks puts its facts beside its calendar and the panel hugs the
// pair, a longer one spreads the calendar across a fixed width with the facts
// under it. On its own the panel spans the card, the facts in a row.
function Activity(props: { recap: SeasonRecap; narrow?: boolean }) {
  const span = createMemo(() => calendarSpan(props.recap));
  const days = createMemo(() => new Map(props.recap.days.map((played) => [played.day, played])));
  const facts = createMemo(() => {
    const recap = props.recap;
    const list: Fact[] = [];
    if (recap.busiestDay) {
      const { day, games, wins } = recap.busiestDay;
      list.push({
        key: "day",
        icon: ZapIcon,
        label: "Busiest day",
        value: WEEKDAY_DATE_FORMAT.format(day),
        sub: `${games} ${games === 1 ? "game" : "games"} · ${wins}W ${games - wins}L`,
      });
    }
    if (recap.peakHour != null) {
      list.push({
        key: "hour",
        icon: ClockIcon,
        label: "Prime time",
        value: formatHour(recap.peakHour),
        sub: "most games started",
      });
    }
    if (recap.topWeekday != null) {
      list.push({
        key: "weekday",
        icon: SparklesIcon,
        label: "Favorite day",
        value: formatWeekday(recap.topWeekday, "long"),
        sub: "most games played",
      });
    }
    // A day on its own is no streak
    if (recap.dayStreak && recap.dayStreak.days > 1) {
      const { days: length, from, to } = recap.dayStreak;
      list.push({
        key: "streak",
        icon: FlameIcon,
        label: "Longest streak",
        value: `${length} days`,
        sub: SHORT_DATE_FORMAT.formatRange(from, to),
      });
    }
    return list;
  });

  const short = () => {
    const current = span();
    return current != null && calendarWeeks(current) <= SHORT_WEEKS;
  };
  const beside = () => (props.narrow ?? false) && short();

  const subtitle = () => {
    const current = span();
    return current
      ? `${props.recap.days.length} of ${Math.round((current.through - current.first) / DAY_MS) + 1} days played`
      : undefined;
  };

  const FactCells = () => (
    <For each={facts()}>
      {(fact) => (
        <div class="flex min-w-0 flex-col justify-center px-4 py-3.5">
          <div class="flex items-center gap-1.5">
            <span class="text-lol-gold">
              <Dynamic component={fact.icon} class="h-3 w-3" />
            </span>
            <span class="label truncate text-[11px]">{fact.label}</span>
          </div>
          <div class="mt-1 truncate font-display text-[18px] font-semibold leading-tight text-lol-text-bright">
            {fact.value}
          </div>
          <div class="truncate text-[12px] text-lol-text">{fact.sub}</div>
        </div>
      )}
    </For>
  );

  return (
    <Panel
      title="Activity"
      subtitle={subtitle()}
      icon={<CalendarIcon class="h-3 w-3" />}
      accent="gold"
      class={props.narrow && !beside() ? "h-full w-[620px]" : "h-full"}
    >
      <Show
        when={beside()}
        fallback={
          <>
            {/* A long span fills the width; a short one on a full-width card
                stays at its own size, centred */}
            <Show when={span()}>
              {(current) => (
                <div class={short() ? "flex justify-center py-1" : "py-1"}>
                  <ActivityCalendar
                    days={days()}
                    first={current().first}
                    last={current().last}
                    through={current().through}
                    cell={calendarCell(current())}
                    fill={!short()}
                  />
                </div>
              )}
            </Show>
            <Show when={facts().length > 0}>
              <div
                class={[
                  "-mx-4 -mb-4 mt-4 border-t border-lol-line bg-black/20",
                  props.narrow ? SQUARE : "grid grid-cols-4 [&>*]:border-lol-line [&>*+*]:border-l",
                ]}
              >
                <FactCells />
              </div>
            </Show>
          </>
        }
      >
        <div class="flex h-full items-stretch gap-5">
          <Show when={span()}>
            {(current) => (
              <div class="flex items-center">
                <ActivityCalendar
                  days={days()}
                  first={current().first}
                  last={current().last}
                  through={current().through}
                  cell={calendarCell(current())}
                />
              </div>
            )}
          </Show>
          <Show when={facts().length > 0}>
            <div
              class={[
                SQUARE,
                "w-[320px] grid-rows-2 rounded-lg border border-lol-line bg-black/20",
              ]}
            >
              <FactCells />
            </div>
          </Show>
        </div>
      </Show>
    </Panel>
  );
}
