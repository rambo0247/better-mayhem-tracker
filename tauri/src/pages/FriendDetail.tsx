import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  onSettled,
  Show,
  Switch,
} from "solid-js";
import { useParams } from "@solidjs/router";
import { api } from "../lib/api-shim";
import { reportFirstContent } from "../lib/perf";
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
  const params = useParams<{ key: string }>();
  const champData = useChampionData();
  const { data, loading, refetch } = useIpc(
    ([key]) => api.getTeammateDetail(key),
    () => [params.key ?? ""],
  );
  const expansion = useExpandedMatch();

  onSettled(() => api.onGamesUpdated(() => void refetch()));

  // Only before the first answer: a refetch after a new game keeps showing the
  // page it is about to update. null is an answer too ("no games together"), so
  // the check can't be on data alone.
  return (
    <Switch>
      <Match when={loading() && !data()}>
        <div class="label mt-20 text-center">Loading…</div>
      </Match>
      <Match when={!data()}>
        <div class="max-w-[1320px] space-y-6">
          <PageHeader kicker={<BackToFriends />} title="Friend" class="pb-0" />
          <div class="panel flex flex-col items-center gap-3 px-8 py-14 text-center">
            <UsersIcon class="h-8 w-8 text-lol-gold/60" />
            <div class="text-[14px] text-lol-text">No games found with this player.</div>
          </div>
        </div>
      </Match>
      <Match when={data()}>
        {(loaded) => <FriendPage data={loaded()} champData={champData()} expansion={expansion} />}
      </Match>
    </Switch>
  );
}

function FriendPage(props: {
  data: TeammateDetail;
  champData: ChampionData;
  expansion: ReturnType<typeof useExpandedMatch>;
}) {
  const player = () => props.data.player;
  const matches = () => props.data.matches;
  const avg = (total: number) => formatDecimal(player().games > 0 ? total / player().games : 0);
  const ratio = () =>
    player().deaths > 0
      ? (player().kills + player().assists) / player().deaths
      : player().kills + player().assists;
  // Their score is computed per game rather than stored, so average what we have
  const scored = createMemo(() => matches().filter((m) => m.friend.score != null));
  const avgScore = () =>
    scored().length
      ? scored().reduce((sum, m) => sum + (m.friend.score ?? 0), 0) / scored().length
      : null;
  const mvps = () => matches().filter((m) => m.friend.score_badge === "MVP").length;
  const aces = () => matches().filter((m) => m.friend.score_badge === "ACE").length;
  const scoredWins = () => scored().filter((m) => m.friend.win).length;

  onSettled(() => reportFirstContent());

  return (
    <div class="max-w-[1320px] space-y-6">
      <ProfileHero
        portrait={
          <div class="rounded-full bg-gradient-to-b from-lol-gold-light to-lol-gold/30 p-[2px]">
            <SummonerIcon
              iconId={player().profileIcon}
              size={76}
              class="border-[3px] border-lol-dark"
            />
          </div>
        }
      >
        <PageHeader
          kicker={<BackToFriends />}
          title={
            // A Riot ID keeps its own casing, which the title's caps would lose
            <span class="normal-case">
              <TaggedRiotId id={player().name} tagClass="text-lol-text/45" />
            </span>
          }
          subtitle={
            <>
              <span class="font-num text-[14px] font-semibold text-lol-text-bright">
                {player().games.toLocaleString(LOCALE)}
              </span>{" "}
              {player().games === 1 ? "game" : "games"} together · last played{" "}
              <span class="text-lol-text-bright/85">{formatTimeAgo(player().lastPlayed)}</span>
            </>
          }
          class="pb-0"
        />
      </ProfileHero>

      <div class="grid grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)] items-stretch gap-4">
        <RecordTogetherCard wins={player().wins} games={player().games} recent={matches()} />

        <StatCard
          label="Their KDA"
          accent="sky"
          icon={<SwordsIcon class="h-3.5 w-3.5" />}
          value={
            /* Three numbers where the other cards show one — a notch smaller
               keeps it on one line in the narrowest column */
            <span class="text-[26px]">
              <Kda
                kills={avg(player().kills)}
                deaths={avg(player().deaths)}
                assists={avg(player().assists)}
              />
            </span>
          }
          subtext={
            <span class={["font-num text-[15px] font-semibold", kdaColor(ratio())]}>
              {kdaRatio(player().kills, player().deaths, player().assists)}{" "}
              <span class="text-[12px] tracking-[0.08em]">KDA</span>
            </span>
          }
        >
          {/* Their totals across our games, as tiles like Match History's */}
          <KdaTotals kills={player().kills} deaths={player().deaths} assists={player().assists} />
        </StatCard>

        <StatCard
          label="Their Avg Score"
          accent="gold"
          icon={<StarIcon class="h-3.5 w-3.5" />}
          value={
            <ScoreValue
              score={avgScore()}
              color={avgScore() != null ? scoreColor(avgScore()!) : ""}
            />
          }
          subtext={<ScoreMeter score={avgScore()} />}
        >
          <BadgeCounts
            mvps={mvps()}
            aces={aces()}
            scoredWins={scoredWins()}
            scoredLosses={scored().length - scoredWins()}
          />
        </StatCard>
      </div>

      <ChampionsPanel champions={player().champions} champData={props.champData} />

      <div>
        <GamesHeading games={matches().length} />
        {/* The stat bars come in once there's room for both players' */}
        <div class="@container space-y-2">
          <For each={matches()}>
            {(m) => (
              <SharedGameRow match={m} champData={props.champData} expansion={props.expansion}>
                <GameBlocks match={m} champData={props.champData} friendName={player().name} />
              </SharedGameRow>
            )}
          </For>
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
function ChampionsPanel(props: { champions: TeammateChampionStats[]; champData: ChampionData }) {
  const [showAll, setShowAll] = createSignal(false);
  const [overflows, setOverflows] = createSignal(false);
  let grid: HTMLDivElement | undefined;
  const collapsed = CHAMPION_ROW_PX * CHAMPION_ROWS_SHOWN;

  // How many fit in three rows depends on how many columns the width allows,
  // so the toggle only shows once the grid is measured to hold more
  createEffect(
    () => props.champions,
    () => {
      const el = grid;
      if (!el) return;
      const measure = () => setOverflows(el.scrollHeight > collapsed + 1);
      const observer = new ResizeObserver(measure);
      observer.observe(el);
      measure();
      return () => observer.disconnect();
    },
  );

  return (
    <div class="panel overflow-hidden">
      <div class="panel-head">
        <span class="section-title">Their Champions</span>
        <span class="font-num text-[14px] text-lol-text">{props.champions.length}</span>
        <Show when={overflows() || showAll()}>
          <button
            onClick={() => setShowAll((v) => !v)}
            aria-expanded={showAll() ? "true" : "false"}
            class="btn btn-ghost btn-sm ml-auto -mr-2"
          >
            {showAll() ? "Show fewer" : `Show all ${props.champions.length}`}
            <ChevronDownIcon
              class={["h-3.5 w-3.5 transition-transform", { "rotate-180": showAll() }]}
            />
          </button>
        </Show>
      </div>
      {/* The last row's rule tucks under the panel's own border */}
      <div
        ref={(el) => (grid = el)}
        style={{
          "max-height": showAll() ? undefined : `${collapsed}px`,
          "grid-auto-rows": `${CHAMPION_ROW_PX}px`,
        }}
        class="-mb-px grid grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] gap-x-8 overflow-hidden px-4"
      >
        <For each={props.champions}>
          {(c) => <ChampionRow champ={c} champData={props.champData} />}
        </For>
      </div>
    </div>
  );
}

function ChampionRow(props: { champ: TeammateChampionStats; champData: ChampionData }) {
  const ratio = () =>
    props.champ.deaths > 0
      ? (props.champ.kills + props.champ.assists) / props.champ.deaths
      : props.champ.kills + props.champ.assists;

  return (
    <div class="flex items-center gap-2.5 border-b border-lol-line">
      <ChampionIcon championId={props.champ.champion_id} size={34} />
      <div class="min-w-0 flex-1 leading-tight">
        <div class="truncate font-display text-[15px] font-semibold text-lol-text-bright">
          {getChampionName(props.champData, props.champ.champion_id)}
        </div>
        <div class="font-num truncate text-[12px] text-lol-text">
          {props.champ.games} {props.champ.games === 1 ? "game" : "games"} ·{" "}
          <span class={kdaColor(ratio())}>
            {kdaRatio(props.champ.kills, props.champ.deaths, props.champ.assists)} KDA
          </span>
        </div>
      </div>
      <div class="w-[7.5rem] shrink-0">
        <WinRateBar wins={props.champ.wins} total={props.champ.games} />
      </div>
    </div>
  );
}

function PlayerBlock(props: {
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
  return (
    <div class="relative flex min-w-0 items-center gap-2.5">
      <ChampionIcon championId={props.championId} size={44} />
      {/* The name alone: the tag is in the page title, and the column is narrow */}
      <div class="w-[96px] min-w-0">
        <RowPlayer
          name={props.you ? props.label : props.label.split("#")[0]!}
          you={props.you ?? false}
        >
          <div class="truncate font-display text-[16px] font-semibold text-lol-text-bright">
            {getChampionName(props.champData, props.championId)}
          </div>
        </RowPlayer>
      </div>
      <div class="w-[84px] shrink-0">
        <div class="font-num text-[17px] font-semibold leading-tight text-lol-text-bright">
          <Kda kills={props.kills} deaths={props.deaths} assists={props.assists} />
        </div>
        <div
          class={[
            "font-num text-[13px] font-semibold",
            kdaHighlight(props.kills, props.deaths, props.assists),
          ]}
        >
          {kdaRatio(props.kills, props.deaths, props.assists)}{" "}
          <span class="text-[11px] tracking-[0.06em]">KDA</span>
        </div>
      </div>
      <RowScore score={props.score} badge={props.badge} />
      <StatBars
        damage={props.damage}
        taken={props.taken}
        heal={props.heal}
        max={props.max}
        class="hidden w-[124px] @min-[70rem]:block"
      />
    </div>
  );
}

function GameBlocks(props: { match: TeammateMatch; champData: ChampionData; friendName: string }) {
  // Both bars scale off the same game bests, so the two sides are comparable
  const max = () => ({
    dmg: props.match.game_max_dmg,
    taken: props.match.game_max_taken,
    heal: props.match.game_max_heal,
  });

  return (
    <>
      <PlayerBlock
        label="You"
        you
        championId={props.match.champion_id}
        champData={props.champData}
        kills={props.match.kills}
        deaths={props.match.deaths}
        assists={props.match.assists}
        score={props.match.score}
        badge={props.match.score_badge}
        damage={props.match.total_damage_dealt}
        taken={props.match.total_damage_taken}
        heal={props.match.total_heal}
        max={max()}
      />

      <span class="relative w-px shrink-0 self-stretch bg-lol-line" />

      <PlayerBlock
        label={props.friendName}
        championId={props.match.friend.champion_id}
        champData={props.champData}
        kills={props.match.friend.kills}
        deaths={props.match.friend.deaths}
        assists={props.match.friend.assists}
        score={props.match.friend.score}
        badge={props.match.friend.score_badge}
        damage={props.match.friend.total_damage_dealt}
        taken={props.match.friend.total_damage_taken}
        heal={props.match.friend.total_heal}
        max={max()}
      />

      <div class="flex-1" />
    </>
  );
}
