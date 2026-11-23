import { createMemo, For, Match, onSettled, Show, Switch } from "solid-js";
import { useParams } from "@solidjs/router";
import { api } from "../lib/api-shim";
import { reportFirstContent } from "../lib/perf";
import { useExpandedMatch } from "../hooks/useExpandedMatch";
import { useIpc } from "../hooks/useIpc";
import { useChampionData, getChampionName } from "../hooks/useChampions";
import type {
  ChampionData,
  TeammateGroupDetail,
  TeammateGroupMatch,
  TeammateLine,
} from "../lib/types";
import { GROUP_SIZES, groupSize } from "../lib/groups";
import BackToFriends from "../components/BackToFriends";
import ChampionIcon from "../components/ChampionIcon";
import SummonerIcon from "../components/SummonerIcon";
import PageHeader from "../components/PageHeader";
import { ScoreBadge } from "../components/ScoreCell";
import SharedGameRow, { SharedGameHeader } from "../components/SharedGameRow";
import StatBars from "../components/StatBars";
import StatCard from "../components/StatCard";
import {
  BadgeCounts,
  GamesHeading,
  KdaTotals,
  ProfileHero,
  RowScore,
  RecordTogetherCard,
  ScoreMeter,
  ScoreValue,
} from "../components/SharedStats";
import { StarIcon, SwordsIcon, UsersIcon } from "../components/icons";
import {
  LOCALE,
  formatDecimal,
  formatTimeAgo,
  kdaRatio,
  kdaColor,
  scoreColor,
} from "../lib/format";
import Kda from "../components/Kda";

// The fields a line of ours and a teammate's have in common, so both add up the
// same way
type GameLine = Pick<TeammateLine, "kills" | "deaths" | "assists" | "score" | "score_badge">;

function summarize(lines: GameLine[]) {
  const kills = lines.reduce((sum, l) => sum + l.kills, 0);
  const deaths = lines.reduce((sum, l) => sum + l.deaths, 0);
  const assists = lines.reduce((sum, l) => sum + l.assists, 0);
  const scored = lines.filter((l) => l.score != null);

  return {
    kills,
    deaths,
    assists,
    ratio: deaths > 0 ? (kills + assists) / deaths : kills + assists,
    avgScore: scored.length
      ? scored.reduce((sum, l) => sum + (l.score ?? 0), 0) / scored.length
      : null,
    mvps: lines.filter((l) => l.score_badge === "MVP").length,
    aces: lines.filter((l) => l.score_badge === "ACE").length,
  };
}

// The game list's width at which a group's rows have room for stat bars, then
// for full-size ones. Decided on the list rather than each block, so every
// player in every row shows the same thing. Written out because Tailwind only
// sees whole class names. A quad or a full team would need a list wider than
// the page ever gets, so their rows go without.
const STAT_BAR_WIDTHS: Record<number, string> = {
  2: "@min-[56rem]:block @min-[61rem]:w-40",
  3: "@min-[78rem]:block @min-[84rem]:w-40",
};

// A Riot ID's name half, for where the tag won't fit
function gameName(id: string): string {
  return id.split("#")[0]!;
}

export default function GroupDetail() {
  const params = useParams<{ key: string }>();
  const champData = useChampionData();
  const { data, loading, refetch } = useIpc(
    ([key]) => api.getTeammateGroupDetail(key),
    () => [params.key ?? ""],
  );
  const { data: profile } = useIpc(() => api.getProfile());
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
        <div class="max-w-[96rem] space-y-6">
          <PageHeader
            kicker={<BackToFriends link={{ view: "groups" }} />}
            title="Group"
            class="pb-0"
          />
          <div class="panel flex flex-col items-center gap-3 px-8 py-14 text-center">
            <UsersIcon class="h-8 w-8 text-lol-gold/60" />
            <div class="text-[14px] text-lol-text">No games found with this group.</div>
          </div>
        </div>
      </Match>
      <Match when={data()}>
        {(loaded) => (
          <GroupPage
            data={loaded()}
            champData={champData()}
            profileIcon={profile()?.profileIcon ?? null}
            expansion={expansion}
          />
        )}
      </Match>
    </Switch>
  );
}

function GroupPage(props: {
  data: TeammateGroupDetail;
  champData: ChampionData;
  profileIcon: number | null;
  expansion: ReturnType<typeof useExpandedMatch>;
}) {
  const group = () => props.data.group;
  const matches = () => props.data.matches;
  const shownNames = () =>
    group().members.length > 3 ? group().members.slice(0, 2) : group().members;
  const hiddenNames = () => group().members.length - shownNames().length;
  const members = createMemo(() =>
    group().members.map((member, i) => ({
      ...member,
      summary: summarize(matches().map((m) => m.members[i]!)),
    })),
  );
  const you = createMemo(() => summarize(matches()));
  // The page's totals are everyone's, us included
  const lines = createMemo(() => matches().flatMap((m): GameLine[] => [m, ...m.members]));
  const overall = createMemo(() => summarize(lines()));
  const avg = (total: number) => formatDecimal(lines().length > 0 ? total / lines().length : 0);
  // A badge goes to a player on the winning or the losing team, so each line
  // counts toward the share of its own side
  const scoredLines = createMemo(() =>
    matches().flatMap((m) => [m, ...m.members].filter((l) => l.score != null).map(() => !!m.win)),
  );
  const scoredWins = () => scoredLines().filter(Boolean).length;

  onSettled(() => reportFirstContent());

  return (
    // Wider than a friend's page, so a bigger group has the room for stat bars
    <div class="max-w-[96rem] space-y-6">
      <ProfileHero
        portrait={
          <div class="flex -space-x-5">
            <For each={group().members}>
              {(m) => (
                <SummonerIcon iconId={m.profileIcon} size={68} class="ring-[3px] ring-lol-dark" />
              )}
            </For>
          </div>
        }
      >
        <PageHeader
          kicker={<BackToFriends link={{ view: "groups" }} />}
          // Names keep their own casing, which the title's caps would lose; past
          // three, the rest are counted, and named in the tooltip
          title={
            <span
              class="normal-case"
              title={group()
                .members.map((m) => m.name)
                .join("\n")}
            >
              <For each={shownNames()}>
                {(m, i) => (
                  <span>
                    <Show when={i() > 0}>
                      <span class="text-lol-text/45"> + </span>
                    </Show>
                    <bdi>{gameName(m.name)}</bdi>
                  </span>
                )}
              </For>
              <Show when={hiddenNames() > 0}>
                <span class="chip ml-3 h-7 bg-lol-gold/12 px-2.5 align-middle text-[16px] not-italic text-lol-gold">
                  +{hiddenNames()}
                </span>
              </Show>
            </span>
          }
          subtitle={
            <>
              <span class="chip mr-2 bg-white/[0.07] align-[1px] text-lol-text-bright/85">
                {GROUP_SIZES[groupSize(group())]}
              </span>
              <span class="font-num text-[14px] font-semibold text-lol-text-bright">
                {group().games.toLocaleString(LOCALE)}
              </span>{" "}
              {group().games === 1 ? "game" : "games"} together · last played{" "}
              <span class="text-lol-text-bright/85">{formatTimeAgo(group().lastPlayed)}</span>
            </>
          }
          class="pb-0"
        />
      </ProfileHero>

      <div class="grid grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)] items-stretch gap-4">
        <RecordTogetherCard wins={group().wins} games={group().games} recent={matches()} />

        <StatCard
          label="Group KDA"
          accent="sky"
          icon={<SwordsIcon class="h-3.5 w-3.5" />}
          value={
            /* Three numbers where the other cards show one — a notch smaller
               keeps it on one line in the narrowest column */
            <span class="text-[26px]">
              <Kda
                kills={avg(overall().kills)}
                deaths={avg(overall().deaths)}
                assists={avg(overall().assists)}
              />
            </span>
          }
          subtext={
            <span class={["font-num text-[15px] font-semibold", kdaColor(overall().ratio)]}>
              {kdaRatio(overall().kills, overall().deaths, overall().assists)}{" "}
              <span class="text-[12px] tracking-[0.08em]">KDA</span>
              <span class="ml-2 font-sans text-[12px] font-normal text-lol-text">
                avg per player
              </span>
            </span>
          }
        >
          {/* Everyone's totals, us included */}
          <KdaTotals
            kills={overall().kills}
            deaths={overall().deaths}
            assists={overall().assists}
          />
        </StatCard>

        <StatCard
          label="Group Avg Score"
          accent="gold"
          icon={<StarIcon class="h-3.5 w-3.5" />}
          value={
            <ScoreValue
              score={overall().avgScore}
              color={overall().avgScore != null ? scoreColor(overall().avgScore!) : ""}
            />
          }
          subtext={<ScoreMeter score={overall().avgScore} />}
        >
          <BadgeCounts
            mvps={overall().mvps}
            aces={overall().aces}
            scoredWins={scoredWins()}
            scoredLosses={scoredLines().length - scoredWins()}
          />
        </StatCard>
      </div>

      <div class="panel overflow-hidden">
        <div class="panel-head">
          <span class="section-title">Group Members</span>
          <span class="font-num text-[14px] text-lol-text">{groupSize(group())}</span>
        </div>
        {/* One column each, wrapping on a narrow window */}
        <div class="grid grid-cols-[repeat(auto-fit,minmax(13rem,1fr))] divide-x divide-lol-line">
          <MemberRow name="You" you profileIcon={props.profileIcon} summary={you()} />
          <For each={members()}>
            {(m) => (
              <a
                href={`#/friends/${encodeURIComponent(m.key)}`}
                class="group block transition-colors hover:bg-white/[0.03]"
              >
                <MemberRow name={m.name} profileIcon={m.profileIcon} summary={m.summary} link />
              </a>
            )}
          </For>
        </div>
      </div>

      <div>
        <GamesHeading games={matches().length} />
        <div class="@container">
          <PlayerHeads group={group()} />
          <div class="space-y-2">
            <For each={matches()}>
              {(m) => (
                <SharedGameRow match={m} champData={props.champData} expansion={props.expansion}>
                  <GameBlocks match={m} group={group()} champData={props.champData} />
                </SharedGameRow>
              )}
            </For>
          </div>
        </div>
      </div>
    </div>
  );
}

function MemberRow(props: {
  name: string;
  you?: boolean;
  link?: boolean;
  profileIcon: number | null;
  summary: ReturnType<typeof summarize>;
}) {
  return (
    <div class="flex items-center gap-3 px-4 py-3">
      <SummonerIcon iconId={props.profileIcon} size={40} class="ring-1 ring-white/10" />
      <div class="min-w-0 flex-1 leading-tight">
        {/* The name alone, so a full team's columns keep it whole; the title has
            the rest */}
        <div
          title={props.name}
          class={[
            "truncate font-display text-[16px] font-semibold transition-colors",
            props.you ? "text-lol-gold" : "text-lol-text-bright",
            { "group-hover:text-lol-gold-light": props.link },
          ]}
        >
          <bdi>{gameName(props.name)}</bdi>
        </div>
        <div class={["font-num text-[13px] font-semibold", kdaColor(props.summary.ratio)]}>
          {kdaRatio(props.summary.kills, props.summary.deaths, props.summary.assists)}
          <span class="ml-1 text-[11px] tracking-[0.06em] text-lol-text">KDA</span>
        </div>
        <div class="font-num mt-1 flex items-center gap-1.5 text-[13px] font-semibold text-lol-text-bright">
          <span>
            <ScoreBadge badge="MVP" />
          </span>
          <span class="mr-1.5">{props.summary.mvps}</span>
          <span>
            <ScoreBadge badge="ACE" />
          </span>
          <span>{props.summary.aces}</span>
        </div>
      </div>
      <RowScore score={props.summary.avgScore} badge={null} />
    </div>
  );
}

// The columns every game's row lays its players out in: a set width each, so
// they hold from row to row and wrap onto a second line in a window too narrow
// for them
const PLAYER_COLUMNS =
  "grid min-w-0 flex-1 grid-cols-[repeat(auto-fit,minmax(10.25rem,1fr))] gap-y-2";

// Who each column is, and "Score" over the scores, once above the list rather
// than in every row. Stays in view while the games scroll under it.
function PlayerHeads(props: { group: TeammateGroupDetail["group"] }) {
  const statBars = () => STAT_BAR_WIDTHS[groupSize(props.group)] ?? "";
  const heads = () => [
    { key: "you", name: "You", you: true },
    ...props.group.members.map((m) => ({ key: m.key, name: gameName(m.name), you: false })),
  ];

  return (
    <div class="sticky top-0 z-10 -mx-1 mb-2 bg-lol-dark/85 px-1 pt-2 backdrop-blur">
      <SharedGameHeader>
        <div class={PLAYER_COLUMNS}>
          <For each={heads()}>
            {(h) => (
              <div class="flex min-w-0 items-end gap-2.5 pl-3 pr-2">
                <div
                  title={h.name}
                  // The portrait, its gap and the line's width in the rows below
                  class={[
                    "w-[162px] min-w-0 truncate font-display text-[14px] font-semibold",
                    h.you ? "text-lol-gold" : "text-lol-text-bright",
                  ]}
                >
                  <bdi>{h.name}</bdi>
                </div>
                <div class="label w-12 shrink-0 text-center text-[11px] text-lol-text/80">
                  Score
                </div>
                <div class={["hidden w-32 shrink-0", statBars()]} />
              </div>
            )}
          </For>
        </div>
      </SharedGameHeader>
    </div>
  );
}

// Everyone's line in one game, ours first, under the heads above
function GameBlocks(props: {
  match: TeammateGroupMatch;
  group: TeammateGroupDetail["group"];
  champData: ChampionData;
}) {
  const statBars = () => STAT_BAR_WIDTHS[groupSize(props.group)] ?? "";
  // Every bar scales off the same game bests, so the players are comparable
  const max = () => ({
    dmg: props.match.game_max_dmg,
    taken: props.match.game_max_taken,
    heal: props.match.game_max_heal,
  });

  return (
    <div class={PLAYER_COLUMNS}>
      <MemberBlock
        you
        line={props.match}
        max={max()}
        statBars={statBars()}
        champData={props.champData}
      />
      <For each={props.group.members}>
        {(_member, i) => (
          <MemberBlock
            line={props.match.members[i()]!}
            max={max()}
            statBars={statBars()}
            champData={props.champData}
          />
        )}
      </For>
    </div>
  );
}

function MemberBlock(props: {
  you?: boolean;
  line: TeammateLine;
  max: { dmg: number; taken: number; heal: number };
  statBars: string;
  champData: ChampionData;
}) {
  return (
    <div class="relative flex min-w-0 items-center gap-2.5 pl-3 pr-2">
      {/* Each player's own rule, ours in gold, so the eye finds its column */}
      <span
        class={[
          "absolute inset-y-0.5 left-0 w-[2px] rounded-[1px]",
          props.you ? "bg-lol-gold/80" : "bg-white/[0.16]",
        ]}
      />
      <ChampionIcon
        championId={props.line.champion_id}
        size={40}
        title={getChampionName(props.champData, props.line.champion_id)}
        class="shrink-0"
      />
      {/* A set width, shrinking in a full team's columns, which the head over
          it matches. Set back a step, so the scores beside it lead the row. */}
      <div class="font-num w-28 min-w-0 whitespace-nowrap text-[17px] font-semibold text-lol-text">
        <Kda kills={props.line.kills} deaths={props.line.deaths} assists={props.line.assists} />
      </div>
      <RowScore score={props.line.score} badge={props.line.score_badge} caption={false} />
      <StatBars
        damage={props.line.total_damage_dealt}
        taken={props.line.total_damage_taken}
        heal={props.line.total_heal}
        max={props.max}
        class={`hidden w-32 ${props.statBars}`}
      />
    </div>
  );
}
