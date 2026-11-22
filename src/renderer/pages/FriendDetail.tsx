import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { useExpandedMatch } from "../hooks/useExpandedMatch";
import { useIpc } from "../hooks/useIpc";
import { useChampionData, getChampionName } from "../hooks/useChampions";
import type {
  ChampionData,
  TeammateChampionStats,
  TeammateDetail,
  TeammateMatch,
} from "../lib/types";
import BackToFriends from "../components/BackToFriends";
import ChampionIcon from "../components/ChampionIcon";
import PageHeader from "../components/PageHeader";
import SummonerIcon from "../components/SummonerIcon";
import SharedGameRow from "../components/SharedGameRow";
import StatBars from "../components/StatBars";
import StatCard from "../components/StatCard";
import WinRateBar from "../components/WinRateBar";
import {
  BadgeCounts,
  GamesHeading,
  KdaTotals,
  ProfileHero,
  RowPlayer,
  RowScore,
  RecordTogetherCard,
  ScoreMeter,
  ScoreValue,
  TaggedRiotId,
} from "../components/SharedStats";
import { ChevronDownIcon, StarIcon, SwordsIcon, UsersIcon } from "../components/icons";
import {
  LOCALE,
  formatDecimal,
  formatTimeAgo,
  kdaRatio,
  kdaColor,
  kdaHighlight,
  scoreColor,
} from "../lib/format";
import Kda from "../components/Kda";

export default function FriendDetail() {
  const { key = "" } = useParams();
  const champData = useChampionData();
  const { data, loading, refetch } = useIpc<TeammateDetail | null>(
    () => window.api.getTeammateDetail(key),
    [key],
  );
  const expansion = useExpandedMatch();

  useEffect(() => {
    const unsub = window.api.onGamesUpdated(() => refetch());
    return unsub;
  }, [refetch]);

  // Only before the first answer: a refetch after a new game keeps showing the
  // page it is about to update. null is an answer too ("no games together"), so
  // the check can't be on data alone.
  if (loading && !data) {
    return <div className="label mt-20 text-center">Loading…</div>;
  }

  if (!data) {
    return (
      <div className="max-w-[1320px] space-y-6">
        <PageHeader kicker={<BackToFriends />} title="Friend" className="pb-0" />
        <div className="panel flex flex-col items-center gap-3 px-8 py-14 text-center">
          <UsersIcon className="h-8 w-8 text-lol-gold/60" />
          <div className="text-[14px] text-lol-text">No games found with this player.</div>
        </div>
      </div>
    );
  }

  const { player, matches } = data;
  const avg = (total: number) => formatDecimal(player.games > 0 ? total / player.games : 0);
  const ratio =
    player.deaths > 0
      ? (player.kills + player.assists) / player.deaths
      : player.kills + player.assists;
  // Their score is computed per game rather than stored, so average what we have
  const scored = matches.filter((m) => m.friend.score != null);
  const avgScore = scored.length
    ? scored.reduce((sum, m) => sum + (m.friend.score ?? 0), 0) / scored.length
    : null;
  const mvps = matches.filter((m) => m.friend.score_badge === "MVP").length;
  const aces = matches.filter((m) => m.friend.score_badge === "ACE").length;
  const scoredWins = scored.filter((m) => m.friend.win).length;

  return (
    <div className="max-w-[1320px] space-y-6">
      <ProfileHero
        portrait={
          <div className="rounded-full bg-gradient-to-b from-lol-gold-light to-lol-gold/30 p-[2px]">
            <SummonerIcon
              iconId={player.profileIcon}
              size={76}
              className="border-[3px] border-lol-dark"
            />
          </div>
        }
      >
        <PageHeader
          kicker={<BackToFriends />}
          title={
            // A Riot ID keeps its own casing, which the title's caps would lose
            <span className="normal-case">
              <TaggedRiotId id={player.name} tagClassName="text-lol-text/45" />
            </span>
          }
          subtitle={
            <>
              <span className="font-num text-[14px] font-semibold text-lol-text-bright">
                {player.games.toLocaleString(LOCALE)}
              </span>{" "}
              {player.games === 1 ? "game" : "games"} together · last played{" "}
              <span className="text-lol-text-bright/85">{formatTimeAgo(player.lastPlayed)}</span>
            </>
          }
          className="pb-0"
        />
      </ProfileHero>

      <div className="grid grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)] items-stretch gap-4">
        <RecordTogetherCard wins={player.wins} games={player.games} recent={matches} />

        <StatCard
          label="Their KDA"
          accent="sky"
          icon={<SwordsIcon className="h-3.5 w-3.5" />}
          value={
            /* Three numbers where the other cards show one — a notch smaller
               keeps it on one line in the narrowest column */
            <span className="text-[26px]">
              <Kda
                kills={avg(player.kills)}
                deaths={avg(player.deaths)}
                assists={avg(player.assists)}
              />
            </span>
          }
          subtext={
            <span className={`font-num text-[15px] font-semibold ${kdaColor(ratio)}`}>
              {kdaRatio(player.kills, player.deaths, player.assists)}{" "}
              <span className="text-[12px] tracking-[0.08em]">KDA</span>
            </span>
          }
        >
          {/* Their totals across our games, as tiles like Match History's */}
          <KdaTotals kills={player.kills} deaths={player.deaths} assists={player.assists} />
        </StatCard>

        <StatCard
          label="Their Avg Score"
          accent="gold"
          icon={<StarIcon className="h-3.5 w-3.5" />}
          value={
            <ScoreValue score={avgScore} color={avgScore != null ? scoreColor(avgScore) : ""} />
          }
          subtext={<ScoreMeter score={avgScore} />}
        >
          <BadgeCounts
            mvps={mvps}
            aces={aces}
            scoredWins={scoredWins}
            scoredLosses={scored.length - scoredWins}
          />
        </StatCard>
      </div>

      <ChampionsPanel champions={player.champions} champData={champData} />

      <div>
        <GamesHeading games={matches.length} />
        {/* The stat bars come in once there's room for both players' */}
        <div className="@container space-y-2">
          {matches.map((m) => (
            <SharedGameRow key={m.game_id} match={m} champData={champData} expansion={expansion}>
              <GameBlocks match={m} champData={champData} friendName={player.name} />
            </SharedGameRow>
          ))}
        </div>
      </div>
    </div>
  );
}

// Three rows of a champion grid, the height every row of which is fixed so the
// cut always falls between rows
const CHAMPION_ROW_PX = 52;
const CHAMPION_ROWS_SHOWN = 3;

// Every champion they've played with us, three rows of it until asked for the
// rest: a long-time friend has played most of the roster
function ChampionsPanel({
  champions,
  champData,
}: {
  champions: TeammateChampionStats[];
  champData: ChampionData;
}) {
  const [showAll, setShowAll] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const grid = useRef<HTMLDivElement>(null);
  const collapsed = CHAMPION_ROW_PX * CHAMPION_ROWS_SHOWN;

  // How many fit in three rows depends on how many columns the width allows,
  // so the toggle only shows once the grid is measured to hold more
  useLayoutEffect(() => {
    const el = grid.current;
    if (!el) return;
    const measure = () => setOverflows(el.scrollHeight > collapsed + 1);
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    measure();
    return () => observer.disconnect();
  }, [champions, collapsed]);

  return (
    <div className="panel overflow-hidden">
      <div className="panel-head">
        <span className="section-title">Their Champions</span>
        <span className="font-num text-[14px] text-lol-text">{champions.length}</span>
        {(overflows || showAll) && (
          <button
            onClick={() => setShowAll((v) => !v)}
            aria-expanded={showAll}
            className="btn btn-ghost btn-sm ml-auto -mr-2"
          >
            {showAll ? "Show fewer" : `Show all ${champions.length}`}
            <ChevronDownIcon
              className={`h-3.5 w-3.5 transition-transform ${showAll ? "rotate-180" : ""}`}
            />
          </button>
        )}
      </div>
      {/* The last row's rule tucks under the panel's own border */}
      <div
        ref={grid}
        style={{ maxHeight: showAll ? undefined : collapsed, gridAutoRows: CHAMPION_ROW_PX }}
        className="-mb-px grid grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] gap-x-8 overflow-hidden px-4"
      >
        {champions.map((c) => (
          <ChampionRow key={c.champion_id} champ={c} champData={champData} />
        ))}
      </div>
    </div>
  );
}

function ChampionRow({
  champ,
  champData,
}: {
  champ: TeammateChampionStats;
  champData: ChampionData;
}) {
  const ratio =
    champ.deaths > 0 ? (champ.kills + champ.assists) / champ.deaths : champ.kills + champ.assists;

  return (
    <div className="flex items-center gap-2.5 border-b border-lol-line">
      <ChampionIcon championId={champ.champion_id} size={34} />
      <div className="min-w-0 flex-1 leading-tight">
        <div className="truncate font-display text-[15px] font-semibold text-lol-text-bright">
          {getChampionName(champData, champ.champion_id)}
        </div>
        <div className="font-num truncate text-[12px] text-lol-text">
          {champ.games} {champ.games === 1 ? "game" : "games"} ·{" "}
          <span className={kdaColor(ratio)}>
            {kdaRatio(champ.kills, champ.deaths, champ.assists)} KDA
          </span>
        </div>
      </div>
      <div className="w-[7.5rem] shrink-0">
        <WinRateBar wins={champ.wins} total={champ.games} />
      </div>
    </div>
  );
}

function PlayerBlock({
  label,
  you = false,
  championId,
  champData,
  kills,
  deaths,
  assists,
  score,
  badge,
  damage,
  taken,
  heal,
  max,
}: {
  label: string;
  you?: boolean;
  championId: number;
  champData: ChampionData;
  kills: number;
  deaths: number;
  assists: number;
  score: number | null;
  badge: "MVP" | "ACE" | null;
  damage: number;
  taken: number;
  heal: number;
  max: { dmg: number; taken: number; heal: number };
}) {
  const kda = kdaRatio(kills, deaths, assists);

  return (
    <div className="relative flex min-w-0 items-center gap-2.5">
      <ChampionIcon championId={championId} size={44} />
      {/* The name alone: the tag is in the page title, and the column is narrow */}
      <div className="w-[96px] min-w-0">
        <RowPlayer name={you ? label : label.split("#")[0]} you={you}>
          <div className="truncate font-display text-[16px] font-semibold text-lol-text-bright">
            {getChampionName(champData, championId)}
          </div>
        </RowPlayer>
      </div>
      <div className="w-[84px] shrink-0">
        <div className="font-num text-[17px] font-semibold leading-tight text-lol-text-bright">
          <Kda kills={kills} deaths={deaths} assists={assists} />
        </div>
        <div
          className={`font-num text-[13px] font-semibold ${kdaHighlight(kills, deaths, assists)}`}
        >
          {kda} <span className="text-[11px] tracking-[0.06em]">KDA</span>
        </div>
      </div>
      <RowScore score={score} badge={badge} />
      <StatBars
        damage={damage}
        taken={taken}
        heal={heal}
        max={max}
        className="hidden w-[124px] @min-[70rem]:block"
      />
    </div>
  );
}

function GameBlocks({
  match,
  champData,
  friendName,
}: {
  match: TeammateMatch;
  champData: ChampionData;
  friendName: string;
}) {
  // Both bars scale off the same game bests, so the two sides are comparable
  const max = {
    dmg: match.game_max_dmg,
    taken: match.game_max_taken,
    heal: match.game_max_heal,
  };

  return (
    <>
      <PlayerBlock
        label="You"
        you
        championId={match.champion_id}
        champData={champData}
        kills={match.kills}
        deaths={match.deaths}
        assists={match.assists}
        score={match.score}
        badge={match.score_badge}
        damage={match.total_damage_dealt}
        taken={match.total_damage_taken}
        heal={match.total_heal}
        max={max}
      />

      <span className="relative w-px shrink-0 self-stretch bg-lol-line" />

      <PlayerBlock
        label={friendName}
        championId={match.friend.champion_id}
        champData={champData}
        kills={match.friend.kills}
        deaths={match.friend.deaths}
        assists={match.friend.assists}
        score={match.friend.score}
        badge={match.friend.score_badge}
        damage={match.friend.total_damage_dealt}
        taken={match.friend.total_damage_taken}
        heal={match.friend.total_heal}
        max={max}
      />

      <div className="flex-1" />
    </>
  );
}
