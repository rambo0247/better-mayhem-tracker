import type { ReactNode } from "react";
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
import { ALL_TIME_ID, findSeason, seasonBounds, seasonDate } from "../../shared/seasons";
import { sessionDay } from "../../shared/session";
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
const DAY_MS = 86_400_000;

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
  if (recap.firstGame == null || recap.lastGame == null) return null;
  return DATE_FORMAT.formatRange(recap.firstGame, recap.lastGame);
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
  if (recap.firstGame == null || recap.lastGame == null) return null;
  const last = sessionDay(recap.lastGame);
  return { first: sessionDay(recap.firstGame), last, through: last };
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
export default function SeasonRecapCard({
  recap,
  champData,
  hideFriends = false,
}: {
  recap: SeasonRecap;
  champData: ChampionData;
  hideFriends?: boolean;
}) {
  const topChampion = recap.champions[0] ?? null;
  const records = recordCards(recap.records.bests);
  const highlights = RECORD_KEYS.flatMap((key) => records.filter((card) => card.key === key)).slice(
    0,
    RECORD_COUNT,
  );

  return (
    <div className="app-stage relative overflow-hidden px-8 pt-8 pb-7">
      {/* The gold rule along the top edge, the graphic's signature */}
      <span className="pointer-events-none absolute inset-x-0 top-0 h-[3px] bg-gradient-to-r from-lol-gold via-lol-gold-light/80 to-lol-gold/10" />

      <div className="relative space-y-5">
        <Hero recap={recap} champData={champData} topChampion={topChampion} />

        <Combat recap={recap} />

        <div className="grid grid-cols-3 gap-4">
          <Panel
            title="Top champions"
            subtitle={`${recap.uniqueChampions} played`}
            icon={<TrophyIcon className="h-3 w-3" />}
            accent="gold"
            className="h-full"
          >
            <Rows empty="No champions yet">
              {recap.champions.map((champ, i) => (
                <ChampionRow
                  key={champ.champion_id}
                  rank={i + 1}
                  champ={champ}
                  champData={champData}
                />
              ))}
            </Rows>
          </Panel>
          <Panel
            title="Top augments"
            icon={<CrosshairIcon className="h-3 w-3" />}
            accent="purple"
            className="h-full"
          >
            <Rows empty="No augments recorded">
              {recap.augments.map((augment, i) => (
                <PickRow
                  key={augment.augment_id}
                  rank={i + 1}
                  picks={augment.picks}
                  wins={augment.wins}
                >
                  <AugmentIcon
                    augmentId={augment.augment_id}
                    size={32}
                    showName
                    nameClassName="font-display text-[16px] font-semibold"
                    patch={recap.patch}
                  />
                </PickRow>
              ))}
            </Rows>
          </Panel>
          <ItemsPanel recap={recap} />
        </div>

        {highlights.length > 0 && (
          <Panel
            title={recap.season.id === ALL_TIME_ID ? "Personal bests" : "Season bests"}
            subtitle="single-game highs"
            icon={<MedalIcon className="h-3 w-3" />}
            accent="gold"
          >
            <div className="-mx-4 -mb-4 grid grid-cols-4 divide-x divide-lol-line border-t border-lol-line">
              {highlights.map(({ key, ...card }) => (
                <Best key={key} card={card} champData={champData} />
              ))}
            </div>
          </Panel>
        )}

        {/* The calendar's panel is as wide as the calendar wants, within
            limits, and the people played with take the rest: a short season's
            few weeks then leave no empty box beside them */}
        {recap.friends.length > 0 ? (
          <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-4">
            <Panel
              title="Played most with"
              subtitle="games on your team"
              icon={<UsersIcon className="h-3 w-3" />}
              accent="sky"
              className="h-full"
            >
              {/* One grid for every row, so the champions and bars start on one line
                  while the name column is only as wide as the longest name. The
                  edge tracks carry the rows' 16px padding on top of their own
                  32px avatar and 64px record. */}
              <div className="-mx-4 -mb-4 grid grid-cols-[48px_fit-content(170px)_auto_minmax(40px,1fr)_80px] gap-x-3 divide-y divide-lol-line border-t border-lol-line">
                {recap.friends.map((friend) => (
                  <FriendRow key={friend.key} friend={friend} hideName={hideFriends} />
                ))}
              </div>
            </Panel>
            <Activity recap={recap} narrow />
          </div>
        ) : (
          <Activity recap={recap} />
        )}
      </div>
    </div>
  );
}

// The banner: the player over their most played champion's splash, then the
// season's headline numbers along its foot like a broadcast lower third
const HERO_TAG =
  "slant px-3 font-display text-[13px] font-extrabold italic uppercase leading-[22px] tracking-[0.1em]";

function Hero({
  recap,
  champData,
  topChampion,
}: {
  recap: SeasonRecap;
  champData: ChampionData;
  topChampion: SeasonChampion | null;
}) {
  const { season, player } = recap;
  const title = season.id === ALL_TIME_ID ? "All-Time Recap" : `${season.name} Recap`;
  const dates = coverage(recap);
  const live = inProgress(season.id);
  const losses = recap.games - recap.wins;
  const streak = recap.records.winStreak;

  return (
    <div className="panel overflow-hidden">
      <div className="relative min-h-[236px]">
        {topChampion && (
          <img
            src={CHAMPION_SPLASH_URL(topChampion.champion_id)}
            alt=""
            className="absolute inset-y-0 right-0 h-full w-[72%] object-cover object-[center_22%] opacity-75"
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = "none";
            }}
          />
        )}
        {/* The art fades out behind the name so the text never sits on a busy
            part of the splash, and darkens toward the numbers below it */}
        <div className="absolute inset-0 bg-gradient-to-r from-lol-card from-[34%] via-lol-card/75 via-[58%] to-lol-card/0" />
        <div className="absolute inset-0 bg-gradient-to-t from-lol-card/90 via-transparent to-lol-card/40" />
        <span className="pointer-events-none absolute -left-20 -top-28 h-80 w-80 rounded-full bg-lol-gold/[0.08] blur-3xl" />

        <div className="relative flex h-full min-h-[236px] items-center gap-7 px-8 py-7">
          <div className="shrink-0 rounded-full bg-gradient-to-b from-lol-gold-light via-lol-gold to-lol-gold/30 p-[3px] shadow-[0_10px_30px_-8px_rgb(212_178_115/0.45)]">
            <SummonerIcon
              iconId={player.profileIcon}
              size={112}
              className="border-[3px] border-lol-card"
            />
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2.5">
              <span className="kicker text-lol-text-bright/80">ARAM Mayhem</span>
              {/* The season and whether it is still going share one tag shape */}
              <span className={`${HERO_TAG} bg-lol-gold text-[#140f04]`}>{title}</span>
              {live && (
                <span className={`${HERO_TAG} bg-lol-win text-[#04140c]`}>
                  In progress · as of{" "}
                  {new Date().toLocaleDateString(LOCALE, { month: "short", day: "numeric" })}
                </span>
              )}
            </div>
            <div className="mt-3 truncate font-display text-[64px] font-extrabold italic uppercase leading-[0.9] tracking-[0.005em] text-lol-text-bright">
              <bdi>{player.gameName ?? "Summoner"}</bdi>
              {player.tagLine && (
                <span className="ml-2 text-[30px] font-bold text-lol-text/55">
                  #<bdi>{player.tagLine}</bdi>
                </span>
              )}
            </div>
            <div className="mt-3.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[14px] text-lol-text">
              {dates && (
                <span className="inline-flex items-center gap-1.5">
                  <CalendarIcon className="h-4 w-4 text-lol-gold" />
                  {dates}
                </span>
              )}
              {recap.accounts > 1 && (
                <span className="text-lol-text/80">{recap.accounts} accounts combined</span>
              )}
            </div>
          </div>

          <div className="flex shrink-0 flex-col items-end gap-6 self-stretch">
            <div className="flex items-center gap-2.5">
              <BrandMark className="h-7 w-7 drop-shadow-[0_4px_12px_rgb(212_178_115/0.3)]" />
              <span className="flex flex-col font-display font-extrabold italic uppercase leading-[0.95] tracking-[0.04em]">
                <span className="text-[15px] text-lol-text-bright">Better Mayhem</span>
                <span className="text-[11px] tracking-[0.26em] text-lol-gold">Tracker</span>
              </span>
            </div>
            {topChampion && (
              <div className="mt-auto text-right">
                <div className="label text-lol-gold/90">Most played</div>
                <div className="mt-1 font-display text-[28px] font-bold italic uppercase leading-none text-lol-text-bright">
                  {getChampionName(champData, topChampion.champion_id)}
                </div>
                <div className="mt-1.5 font-num text-[14px] text-lol-text">
                  {topChampion.games.toLocaleString(LOCALE)}{" "}
                  {topChampion.games === 1 ? "game" : "games"} ·{" "}
                  <span className={winRateColor(topChampion.wins, topChampion.games)}>
                    {winRatePercent(topChampion.wins, topChampion.games)}
                  </span>{" "}
                  win rate
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="relative grid grid-cols-5 divide-x divide-lol-line border-t border-lol-line bg-black/30">
        <Headline
          label="Games"
          icon={<SwordsIcon className="h-3.5 w-3.5" />}
          tone="text-lol-gold"
          value={recap.games.toLocaleString(LOCALE)}
          sub={`${recap.days.length} ${recap.days.length === 1 ? "day" : "days"} played`}
        />
        <Headline
          label="Record"
          icon={<TrophyIcon className="h-3.5 w-3.5" />}
          tone="text-lol-win"
          value={
            <>
              <span className="text-lol-win">{recap.wins.toLocaleString(LOCALE)}</span>
              <span className="ml-0.5 text-[20px] text-lol-win/70">W</span>
              <span className="ml-2.5 text-lol-loss/85">{losses.toLocaleString(LOCALE)}</span>
              <span className="ml-0.5 text-[20px] text-lol-loss/60">L</span>
            </>
          }
        >
          <WinRateBar wins={recap.wins} total={recap.games} />
        </Headline>
        <Headline
          label="Time played"
          icon={<ClockIcon className="h-3.5 w-3.5" />}
          tone="text-sky-400"
          value={formatPlaytime(recap.duration)}
          sub={`${formatDuration(Math.round(recap.duration / recap.games))} average game`}
        />
        <Headline
          label="Best win streak"
          icon={<TrendingUpIcon className="h-3.5 w-3.5" />}
          tone="text-purple-400"
          value={
            streak ? (
              <>
                {streak.length}
                <span className="ml-1.5 text-[20px] text-lol-text">
                  {streak.length === 1 ? "win" : "wins"}
                </span>
              </>
            ) : (
              "None yet"
            )
          }
          sub={
            recap.records.lossStreak && recap.records.lossStreak.length > 1
              ? `Longest loss streak: ${recap.records.lossStreak.length}`
              : undefined
          }
        />
        <Headline
          label="KDA"
          icon={<ZapIcon className="h-3.5 w-3.5" />}
          tone="text-sky-400"
          value={
            <span className={kdaColor(kdaValue(recap.kills, recap.deaths, recap.assists))}>
              {kdaRatio(recap.kills, recap.deaths, recap.assists)}
            </span>
          }
          sub={
            <>
              <span className="font-num">
                <Kda
                  kills={perGame(recap.kills, recap.games)}
                  deaths={perGame(recap.deaths, recap.games)}
                  assists={perGame(recap.assists, recap.games)}
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

function Headline({
  label,
  icon,
  tone,
  value,
  sub,
  children,
}: {
  label: string;
  icon: ReactNode;
  tone: string;
  value: ReactNode;
  sub?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col px-6 py-5">
      <div className="flex items-center gap-1.5">
        <span className={tone}>{icon}</span>
        <span className="label">{label}</span>
      </div>
      <div className="mt-2 truncate font-num text-[40px] font-semibold leading-none text-lol-text-bright">
        {value}
      </div>
      {sub && <div className="mt-2 truncate text-[13px] text-lol-text">{sub}</div>}
      {children && <div className="mt-auto pt-3">{children}</div>}
    </div>
  );
}

// The fight in three tiers: the four numbers that say how a season went, big;
// the multikills, each in its own colour; then everything else, small
function Combat({ recap }: { recap: SeasonRecap }) {
  const { games, multikills } = recap;
  const kills: { label: string; count: number; tone: string }[] = [
    { label: "Double", count: multikills.doubles, tone: "text-sky-400" },
    { label: "Triple", count: multikills.triples, tone: "text-amber-400" },
    { label: "Quadra", count: multikills.quadras, tone: "text-purple-400" },
    { label: "Penta", count: multikills.pentas, tone: "text-red-400" },
  ];

  return (
    <Panel
      title="Combat"
      subtitle={`across ${games.toLocaleString(LOCALE)} ${games === 1 ? "game" : "games"}`}
      icon={<FlameIcon className="h-3 w-3" />}
      accent="purple"
    >
      <div className="-mx-4 grid grid-cols-4 divide-x divide-lol-line border-t border-lol-line">
        <Lead
          label="Kills"
          value={recap.kills.toLocaleString(LOCALE)}
          sub={`${perGame(recap.kills, games)} per game`}
        />
        <Lead
          label="Damage dealt"
          value={formatTotal(recap.damage)}
          sub={
            recap.damageShare != null
              ? `${formatPercent(recap.damageShare)} of team damage`
              : "to champions"
          }
        />
        <Lead
          label="Kill participation"
          value={recap.killParticipation != null ? formatPercent(recap.killParticipation) : "-"}
          sub="of team kills"
        />
        <Lead
          label="Avg score"
          value={recap.avgScore != null ? formatDecimal(recap.avgScore) : "-"}
          tone={recap.avgScore != null ? scoreColor(recap.avgScore) : undefined}
          sub="out of 10"
        />
      </div>

      <div className="-mx-4 -mb-4 flex border-t border-lol-line bg-black/20">
        <div className="shrink-0 border-r border-lol-line px-5 py-4">
          <div className="label">Multikills</div>
          <div className="mt-2.5 grid grid-cols-4 gap-2">
            {kills.map((kill) => (
              <div
                key={kill.label}
                className="w-[76px] rounded-md border border-lol-line bg-white/[0.025] py-2 text-center"
              >
                <div className={`font-num text-[26px] font-semibold leading-none ${kill.tone}`}>
                  {kill.count.toLocaleString(LOCALE)}
                </div>
                <div className="label mt-1 text-[12px] text-lol-text-bright/75">{kill.label}</div>
              </div>
            ))}
          </div>
        </div>
        <div className="grid flex-1 grid-cols-4 gap-x-5 gap-y-3.5 px-5 py-4">
          <Minor
            label="Deaths"
            value={recap.deaths.toLocaleString(LOCALE)}
            sub={`${perGame(recap.deaths, games)}/game`}
          />
          <Minor
            label="Assists"
            value={recap.assists.toLocaleString(LOCALE)}
            sub={`${perGame(recap.assists, games)}/game`}
          />
          <Minor
            label="MVP"
            value={recap.mvps.toLocaleString(LOCALE)}
            sub={share(recap.mvps, recap.scoredWins, "wins")}
          />
          <Minor
            label="ACE"
            value={recap.aces.toLocaleString(LOCALE)}
            sub={share(recap.aces, recap.scoredLosses, "losses")}
          />
          <Minor
            label="Damage taken"
            value={formatTotal(recap.damageTaken)}
            sub={`${formatTotal(recap.damageTaken / games)}/game`}
          />
          <Minor
            label="Healing"
            value={formatTotal(recap.healing)}
            sub={`${formatTotal(recap.healing / games)}/game`}
          />
          <Minor
            label="Gold earned"
            value={formatTotal(recap.gold)}
            sub={`${formatTotal(recap.gold / games)}/game`}
          />
          <Minor
            label="Damage / min"
            value={Math.round(recap.damage / (recap.duration / 60)).toLocaleString(LOCALE)}
            sub="to champions"
          />
        </div>
      </div>
    </Panel>
  );
}

function Lead({
  label,
  value,
  sub,
  tone = "text-lol-text-bright",
}: {
  label: string;
  value: ReactNode;
  sub: string;
  tone?: string;
}) {
  return (
    <div className="min-w-0 px-5 py-4">
      <div className="label">{label}</div>
      <div className={`mt-1.5 font-num text-[38px] font-semibold leading-none ${tone}`}>
        {value}
      </div>
      <div className="mt-2 truncate text-[13px] text-lol-text">{sub}</div>
    </div>
  );
}

function Minor({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="min-w-0">
      <div className="label truncate text-[12px] text-lol-text-bright/75">{label}</div>
      <div className="mt-0.5 flex items-baseline gap-1.5">
        <span className="font-num text-[20px] font-semibold leading-tight text-lol-text-bright">
          {value}
        </span>
        <span className="truncate text-[12px] text-lol-text">{sub}</span>
      </div>
    </div>
  );
}

function Rows({ empty, children }: { empty: string; children: ReactNode[] }) {
  if (children.length === 0) return <div className="py-4 text-[13px] text-lol-text">{empty}</div>;
  return (
    <div className="-mx-4 -mb-4 divide-y divide-lol-line border-t border-lol-line">{children}</div>
  );
}

function WinRate({ wins, games, detail }: { wins: number; games: number; detail: string }) {
  return (
    <div className="shrink-0 text-right">
      <div
        className={`font-num text-[17px] font-semibold leading-tight ${winRateColor(wins, games)}`}
      >
        {winRatePercent(wins, games)}
      </div>
      <div className="font-num text-[12px] text-lol-text">{detail}</div>
    </div>
  );
}

// A place in one of the three top-six lists: the rank, the thing ranked, then
// how it went. Fixed height so the lists' rows line up across the columns.
function ListRow({ rank, children }: { rank: number; children: ReactNode }) {
  return (
    <div className="flex h-[54px] items-center gap-3 px-4">
      <span
        className={`w-3 shrink-0 text-center font-num text-[15px] font-semibold ${
          rank === 1 ? "text-lol-gold" : "text-lol-text/50"
        }`}
      >
        {rank}
      </span>
      {children}
    </div>
  );
}

function ChampionRow({
  rank,
  champ,
  champData,
}: {
  rank: number;
  champ: SeasonChampion;
  champData: ChampionData;
}) {
  return (
    <ListRow rank={rank}>
      <ChampionIcon championId={champ.champion_id} size={36} />
      <div className="min-w-0 flex-1">
        <div className="truncate font-display text-[16px] font-semibold leading-tight text-lol-text-bright">
          {getChampionName(champData, champ.champion_id)}
        </div>
        <div className="truncate text-[12px] text-lol-text">
          <span
            className={`font-num ${kdaColor(kdaValue(champ.kills, champ.deaths, champ.assists))}`}
          >
            {kdaRatio(champ.kills, champ.deaths, champ.assists)}
          </span>{" "}
          KDA
          {champ.avgScore != null && (
            <>
              {" · "}
              <span className={`font-num ${scoreColor(champ.avgScore)}`}>
                {formatDecimal(champ.avgScore)}
              </span>{" "}
              score
            </>
          )}
        </div>
      </div>
      <WinRate
        wins={champ.wins}
        games={champ.games}
        detail={`${champ.games.toLocaleString(LOCALE)} ${champ.games === 1 ? "game" : "games"}`}
      />
    </ListRow>
  );
}

function PickRow({
  rank,
  picks,
  wins,
  children,
}: {
  rank: number;
  picks: number;
  wins: number;
  children: ReactNode;
}) {
  return (
    <ListRow rank={rank}>
      <div className="min-w-0 flex-1">{children}</div>
      <WinRate
        wins={wins}
        games={picks}
        detail={`${picks.toLocaleString(LOCALE)} ${picks === 1 ? "pick" : "picks"}`}
      />
    </ListRow>
  );
}

// Boots are bought nearly every game, so only the favourite pair makes the
// list, last and labelled, rather than letting three pairs crowd out the items.
// The label is what explains a pair with more picks sitting below the rest.
function ItemsPanel({ recap }: { recap: SeasonRecap }) {
  const itemData = useItemData(recap.patch);
  const isBoots = (item: ItemStats) => itemData[item.item_id]?.boots ?? false;
  const boots = recap.items.find(isBoots);
  const items = recap.items
    .filter((item) => !isBoots(item))
    .slice(0, boots ? TOP_ITEMS - 1 : TOP_ITEMS);
  if (boots) items.push(boots);

  return (
    <Panel
      title="Top items"
      icon={<CoinsIcon className="h-3 w-3" />}
      accent="win"
      className="h-full"
    >
      <Rows empty="No items recorded">
        {items.map((item, i) => (
          <PickRow key={item.item_id} rank={i + 1} picks={item.picks} wins={item.wins}>
            <div className="flex min-w-0 items-center gap-2">
              <ItemIcon itemId={item.item_id} size={32} patch={recap.patch} />
              <span className="truncate font-display text-[16px] font-semibold text-lol-text-bright">
                {itemData[item.item_id]?.name || `Item ${item.item_id}`}
              </span>
              {item === boots && (
                <span className="chip shrink-0 border border-lol-border text-[11px] text-lol-text">
                  Boots
                </span>
              )}
            </div>
          </PickRow>
        ))}
      </Rows>
    </Panel>
  );
}

// One single-game best: the number, then the game it was set in along the foot
function Best({ card, champData }: { card: Omit<RecordCardDef, "key">; champData: ChampionData }) {
  const { label, icon, accent, value, sub, match } = card;
  return (
    <div className="flex min-w-0 flex-col px-5 py-4">
      <div className="flex items-center gap-2">
        <span
          className={`flex h-5 w-5 items-center justify-center rounded-md ${ACCENTS[accent].chip}`}
        >
          {icon}
        </span>
        <span className="label truncate">{label}</span>
      </div>
      <div className="mt-2 font-num text-[36px] font-semibold leading-none text-lol-text-bright">
        {value}
      </div>
      {sub && <div className="mt-1 text-[12px] text-lol-text">{sub}</div>}
      <div className="mt-auto flex items-center gap-2.5 pt-4">
        <ChampionIcon championId={match.champion_id} size={30} />
        <div className="min-w-0 flex-1">
          <div className="truncate font-display text-[15px] font-semibold leading-tight text-lol-text-bright">
            {getChampionName(champData, match.champion_id)}
          </div>
          <div className="truncate text-[12px] text-lol-text">
            <span
              className={`font-display font-bold ${match.win ? "text-lol-win" : "text-lol-loss"}`}
            >
              {match.win ? "W" : "L"}
            </span>
            {" · "}
            <span className="font-num">
              <Kda kills={match.kills} deaths={match.deaths} assists={match.assists} />
            </span>
            {" · "}
            {recordDate(match.game_creation)}
          </div>
        </div>
      </div>
    </div>
  );
}

// A row of the list's shared grid: the name column sizes to the longest name
// (long ones cut short), the champions played together close behind it, then
// the bar runs on to the record
function FriendRow({ friend, hideName }: { friend: TeammateStats; hideName: boolean }) {
  const [name, tag] = splitRiotId(friend.name);
  const rate = friend.games > 0 ? (friend.wins / friend.games) * 100 : 0;

  return (
    <div className="col-span-5 grid h-14 grid-cols-subgrid items-center px-4">
      <SummonerIcon iconId={friend.profileIcon} size={32} />
      <div className="min-w-0">
        {hideName ? (
          // A blank where the name goes, the height of the line it stands in for
          <div className="flex h-5 items-center">
            <div className="h-1 w-24 rounded-[2px] bg-lol-text/30" />
          </div>
        ) : (
          <div className="truncate font-display text-[16px] font-semibold leading-5 text-lol-text-bright">
            <bdi>{name}</bdi>
            {tag && (
              <span className="font-medium text-lol-text/55">
                {" "}
                #<bdi>{tag}</bdi>
              </span>
            )}
          </div>
        )}
        <div className="text-[12px] text-lol-text">
          <span className="font-num">{friend.games.toLocaleString(LOCALE)}</span> games together
        </div>
      </div>
      <div className="flex shrink-0 -space-x-1.5">
        {friend.champions.slice(0, 3).map((champ) => (
          <ChampionIcon
            key={champ.champion_id}
            championId={champ.champion_id}
            size={24}
            className="ring-2 ring-lol-card"
          />
        ))}
      </div>
      {/* Wins against losses, with the even-odds line marked, as WinRateBar
          draws it, minus the figure the column beside it already gives */}
      <div className="relative h-1.5 overflow-hidden rounded-[2px] bg-lol-loss/25">
        <div
          className="h-full rounded-[2px] bg-gradient-to-r from-lol-win/70 to-lol-win"
          style={{ width: `${rate}%` }}
        />
        <span className="absolute inset-y-0 left-1/2 w-px bg-lol-dark/70" />
      </div>
      <div>
        <WinRate
          wins={friend.wins}
          games={friend.games}
          detail={`${friend.wins.toLocaleString(LOCALE)}W ${(friend.games - friend.wins).toLocaleString(LOCALE)}L`}
        />
      </div>
    </div>
  );
}

// When the season was played: every day of it on a calendar, then what the
// days had in common. Beside the people played with it is `narrow`: a season
// of a few weeks puts its facts beside its calendar and the panel hugs the
// pair, a longer one spreads the calendar across a fixed width with the facts
// under it. On its own the panel spans the card, the facts in a row.
function Activity({ recap, narrow = false }: { recap: SeasonRecap; narrow?: boolean }) {
  const span = calendarSpan(recap);
  const days = new Map(recap.days.map((played) => [played.day, played]));
  const facts: { key: string; icon: ReactNode; label: string; value: string; sub: string }[] = [];

  if (recap.busiestDay) {
    const { day, games, wins } = recap.busiestDay;
    facts.push({
      key: "day",
      icon: <ZapIcon className="h-3 w-3" />,
      label: "Busiest day",
      value: WEEKDAY_DATE_FORMAT.format(day),
      sub: `${games} ${games === 1 ? "game" : "games"} · ${wins}W ${games - wins}L`,
    });
  }
  if (recap.peakHour != null) {
    facts.push({
      key: "hour",
      icon: <ClockIcon className="h-3 w-3" />,
      label: "Prime time",
      value: formatHour(recap.peakHour),
      sub: "most games started",
    });
  }
  if (recap.topWeekday != null) {
    facts.push({
      key: "weekday",
      icon: <SparklesIcon className="h-3 w-3" />,
      label: "Favorite day",
      value: formatWeekday(recap.topWeekday, "long"),
      sub: "most games played",
    });
  }
  // A day on its own is no streak
  if (recap.dayStreak && recap.dayStreak.days > 1) {
    const { days: length, from, to } = recap.dayStreak;
    facts.push({
      key: "streak",
      icon: <FlameIcon className="h-3 w-3" />,
      label: "Longest streak",
      value: `${length} days`,
      sub: SHORT_DATE_FORMAT.formatRange(from, to),
    });
  }

  const short = span != null && calendarWeeks(span) <= SHORT_WEEKS;
  const beside = narrow && short;

  const factCells = facts.map((fact) => (
    <div key={fact.key} className="flex min-w-0 flex-col justify-center px-4 py-3.5">
      <div className="flex items-center gap-1.5">
        <span className="text-lol-gold">{fact.icon}</span>
        <span className="label truncate text-[11px]">{fact.label}</span>
      </div>
      <div className="mt-1 truncate font-display text-[18px] font-semibold leading-tight text-lol-text-bright">
        {fact.value}
      </div>
      <div className="truncate text-[12px] text-lol-text">{fact.sub}</div>
    </div>
  ));
  // A two-by-two square of facts, ruled between the cells only
  const square =
    "grid grid-cols-2 [&>*]:border-lol-line [&>*:nth-child(even)]:border-l [&>*:nth-child(n+3)]:border-t";

  return (
    <Panel
      title="Activity"
      subtitle={
        span
          ? `${recap.days.length} of ${Math.round((span.through - span.first) / DAY_MS) + 1} days played`
          : undefined
      }
      icon={<CalendarIcon className="h-3 w-3" />}
      accent="gold"
      className={`h-full ${narrow && !beside ? "w-[620px]" : ""}`}
    >
      {beside ? (
        <div className="flex h-full items-stretch gap-5">
          {span && (
            <div className="flex items-center">
              <ActivityCalendar days={days} {...span} cell={calendarCell(span)} />
            </div>
          )}
          {facts.length > 0 && (
            <div
              className={`${square} w-[320px] grid-rows-2 rounded-lg border border-lol-line bg-black/20`}
            >
              {factCells}
            </div>
          )}
        </div>
      ) : (
        <>
          {/* A long span fills the width; a short one on a full-width card
              stays at its own size, centred */}
          {span && (
            <div className={short ? "flex justify-center py-1" : "py-1"}>
              <ActivityCalendar days={days} {...span} cell={calendarCell(span)} fill={!short} />
            </div>
          )}
          {facts.length > 0 && (
            <div
              className={`-mx-4 -mb-4 mt-4 border-t border-lol-line bg-black/20 ${
                narrow ? square : "grid grid-cols-4 [&>*]:border-lol-line [&>*+*]:border-l"
              }`}
            >
              {factCells}
            </div>
          )}
        </>
      )}
    </Panel>
  );
}
