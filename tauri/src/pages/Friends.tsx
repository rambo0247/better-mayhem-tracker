import { createEffect, createMemo, For, onSettled, Show, untrack } from "solid-js";
import type { JSX } from "@solidjs/web";
import { useLocation, useNavigate } from "@solidjs/router";
import { api } from "../lib/api-shim";
import { reportFirstContent } from "../lib/perf";
import { useIpc } from "../hooks/useIpc";
import { useViewState } from "../hooks/useViewState";
import { useSort } from "../hooks/useSort";
import { useChampionData, getChampionName } from "../hooks/useChampions";
import {
  MIN_GROUP_MEMBER_GAMES,
  MIN_SHARED_GAMES,
  type FriendsLink,
  type TeammateGroup,
  type TeammateStats,
} from "../lib/types";
import { GROUP_SIZES, groupSize } from "../lib/groups";
import ChampionIcon from "../components/ChampionIcon";
import SummonerIcon from "../components/SummonerIcon";
import WinRateBar from "../components/WinRateBar";
import SortHeader from "../components/SortHeader";
import {
  LOCALE,
  formatDateTime,
  formatDecimal,
  formatTimeAgo,
  kdaRatio,
  kdaColor,
} from "../lib/format";
import { matchesSearch } from "../lib/search";
import Kda from "../components/Kda";
import PageHeader from "../components/PageHeader";
import Select from "../components/Select";
import { TaggedRiotId } from "../components/SharedStats";
import { ChevronRightIcon, UsersIcon } from "../components/icons";
import SearchInput from "../components/SearchInput";
import FilterMenu, { FilterField } from "../components/FilterMenu";
import MinGamesFilter from "../components/MinGamesFilter";
import SeasonSelect from "../components/SeasonSelect";

type View = FriendsLink["view"];
type PlayerSortKey = "games" | "winRate" | "kda" | "lastPlayed";
type GroupSortKey = "size" | "games" | "winRate" | "kda" | "lastPlayed";
type Sort<K extends string> = ReturnType<typeof useSort<K>>;

const VIEWS: { key: View; label: string; title?: string }[] = [
  { key: "players", label: "Players" },
  {
    key: "groups",
    label: "Groups",
    title: `Each game counts once, for everyone on your team you've played ${MIN_GROUP_MEMBER_GAMES}+ games with`,
  },
];

export const friendPath = (key: string) => `/friends/${encodeURIComponent(key)}`;
export const groupPath = (key: string) => `/friends/groups/${encodeURIComponent(key)}`;

function groupRatio(group: TeammateGroup): number {
  const takedowns = group.kills + group.assists;
  return group.deaths > 0 ? takedowns / group.deaths : takedowns;
}

export default function Friends() {
  // Only the link the page was opened by: a later navigation remounts the page
  const link = untrack(() => useLocation<FriendsLink>().state ?? null);
  const [season, setSeason] = useViewState<string | undefined>("friends.season", undefined);
  const [view, setView] = useViewState<View>(
    "friends.view",
    link?.view ?? "players",
    link === null,
  );
  const { data: players, refetch: refetchPlayers } = useIpc(
    ([s]) => api.getTeammateStats(s),
    () => [season()],
  );
  const { data: groups, refetch: refetchGroups } = useIpc(
    ([s]) => api.getTeammateGroups(s),
    () => [season()],
  );
  const [search, setSearch] = useViewState("friends.search", "");
  // The list holds everyone we've played with; this decides who counts as a
  // friend there and which groups are listed, without changing who is in a
  // group. It starts and resets at MIN_SHARED_GAMES rather than off.
  const [minGames, setMinGames] = useViewState<number | undefined>(
    "friends.minGames",
    MIN_SHARED_GAMES,
  );
  const [size, setSize] = useViewState<number | undefined>("friends.groupSize", undefined);
  const playerSort = useSort<PlayerSortKey>("friends", "games");
  const groupSort = useSort<GroupSortKey>("friends.groups", "games");

  onSettled(() =>
    api.onGamesUpdated(() => {
      void refetchPlayers();
      void refetchGroups();
    }),
  );

  const sortedPlayers = createMemo(() => {
    const all = players();
    if (!all) return [];
    const min = minGames();
    const query = search();
    const key = playerSort.sortKey();
    const dir = playerSort.sortDir();
    const filtered = all.filter(
      (t) => (min === undefined || t.games >= min) && matchesSearch(t.name, query),
    );

    filtered.sort((a, b) => {
      let av: number, bv: number;
      switch (key) {
        case "winRate":
          av = a.games > 0 ? a.wins / a.games : 0;
          bv = b.games > 0 ? b.wins / b.games : 0;
          break;
        case "kda":
          av = a.deaths > 0 ? (a.kills + a.assists) / a.deaths : a.kills + a.assists;
          bv = b.deaths > 0 ? (b.kills + b.assists) / b.deaths : b.kills + b.assists;
          break;
        case "lastPlayed":
          av = a.lastPlayed;
          bv = b.lastPlayed;
          break;
        default:
          av = a.games;
          bv = b.games;
      }
      return dir === "desc" ? bv - av : av - bv;
    });

    return filtered;
  });

  const sortedGroups = createMemo(() => {
    const all = groups();
    if (!all) return [];
    const min = minGames();
    const wanted = size();
    const query = search();
    const key = groupSort.sortKey();
    const dir = groupSort.sortDir();
    const filtered = all.filter(
      (g) =>
        (min === undefined || g.games >= min) &&
        (wanted === undefined || groupSize(g) === wanted) &&
        g.members.some((m) => matchesSearch(m.name, query)),
    );

    filtered.sort((a, b) => {
      let av: number, bv: number;
      switch (key) {
        case "size":
          av = groupSize(a);
          bv = groupSize(b);
          break;
        case "winRate":
          av = a.wins / a.games;
          bv = b.wins / b.games;
          break;
        case "kda":
          av = groupRatio(a);
          bv = groupRatio(b);
          break;
        case "lastPlayed":
          av = a.lastPlayed;
          bv = b.lastPlayed;
          break;
        default:
          av = a.games;
          bv = b.games;
      }
      return dir === "desc" ? bv - av : av - bv;
    });

    return filtered;
  });

  const ready = () => players() !== null && groups() !== null;
  const showGroups = () => view() === "groups";
  const listed = () => (showGroups() ? sortedGroups() : sortedPlayers());
  const maxGames = () =>
    Math.max(...(showGroups() ? (groups() ?? []) : (players() ?? [])).map((row) => row.games));

  createEffect(
    () => ready() && listed().length > 0,
    (painted) => {
      if (painted) reportFirstContent();
    },
  );

  const actions = (
    <>
      <div class="seg" role="group" aria-label="View">
        <For each={VIEWS}>
          {(v) => (
            <button
              onClick={() => setView(v.key)}
              title={v.title}
              aria-pressed={view() === v.key ? "true" : "false"}
              class="seg-item"
            >
              {v.label}
            </button>
          )}
        </For>
      </div>
      <FilterMenu
        active={
          (season() !== undefined ? 1 : 0) +
          (minGames() !== MIN_SHARED_GAMES ? 1 : 0) +
          (showGroups() && size() !== undefined ? 1 : 0)
        }
        onReset={() => {
          setSeason(undefined);
          setMinGames(MIN_SHARED_GAMES);
          setSize(undefined);
        }}
      >
        <SeasonSelect value={season()} onChange={(s) => setSeason(s)} label="Set" />
        <Show when={showGroups()}>
          <FilterField label="Group size">
            <Select
              value={size()}
              options={[
                { value: undefined, label: "All sizes" },
                ...Object.entries(GROUP_SIZES).map(([value, label]) => ({
                  value: Number(value),
                  label,
                })),
              ]}
              onChange={setSize}
              class="w-full"
            />
          </FilterField>
        </Show>
        <MinGamesFilter value={minGames()} onChange={(m) => setMinGames(m)} max={maxGames()} />
      </FilterMenu>
      <SearchInput
        value={search()}
        onChange={(q) => setSearch(q)}
        placeholder={showGroups() ? "Search groups..." : "Search player..."}
      />
    </>
  );

  return (
    <Show when={ready()} fallback={<div class="label mt-20 text-center">Loading…</div>}>
      <div class="max-w-[1320px] space-y-6">
        <PageHeader
          kicker="Social"
          title="Friends"
          subtitle={
            <>
              <span class="font-num text-[14px] font-semibold text-lol-text-bright">
                {listed().length.toLocaleString(LOCALE)}
              </span>{" "}
              {showGroups() ? "groups" : "players"} ·{" "}
              <span class="font-num text-[14px] font-semibold text-lol-text-bright">
                {minGames() ?? 1}+
              </span>{" "}
              games together
            </>
          }
          actions={actions}
          class="pb-0"
        />

        <Show
          when={listed().length > 0}
          fallback={
            <div class="panel flex flex-col items-center gap-3 px-8 py-14 text-center">
              <UsersIcon class="h-8 w-8 text-lol-gold/60" />
              <div class="max-w-md text-[14px] text-lol-text">
                No {showGroups() ? "groups" : "players"} match the current search and filters.
              </div>
            </div>
          }
        >
          <div class="panel overflow-hidden">
            <Show
              when={showGroups()}
              fallback={<PlayersTable players={sortedPlayers()} sort={playerSort} />}
            >
              <GroupsTable groups={sortedGroups()} sort={groupSort} />
            </Show>
          </div>
        </Show>
      </div>
    </Show>
  );
}

// A plain column head, for the columns that don't sort
function Th(props: { children?: JSX.Element; class?: string }) {
  return <th class={["tbl-head px-3 py-3 text-left", props.class ?? ""]}>{props.children}</th>;
}

// Their ratio over the per-game line it comes from
function KdaCell(props: {
  ratio: number;
  label: string;
  kills: number;
  deaths: number;
  assists: number;
}) {
  return (
    <div class="leading-tight">
      <div class={["font-num text-[15px] font-semibold", kdaColor(props.ratio)]}>
        {props.label}
        <span class="ml-1 text-[11px] tracking-[0.08em] text-lol-text">KDA</span>
      </div>
      <div class="font-num text-[12px] text-lol-text">
        <Kda
          kills={formatDecimal(props.kills)}
          deaths={formatDecimal(props.deaths)}
          assists={formatDecimal(props.assists)}
        />
      </div>
    </div>
  );
}

function LastPlayedCell(props: { timestamp: number }) {
  return (
    <td class="px-3 py-2.5">
      <span class="font-num text-[14px] text-lol-text" title={formatDateTime(props.timestamp)}>
        {formatTimeAgo(props.timestamp)}
      </span>
    </td>
  );
}

// The row's way in, brought up on hover
function GoCell() {
  return (
    <td class="w-10 pr-4 text-right">
      <ChevronRightIcon class="ml-auto h-4 w-4 text-lol-text/30 transition-colors group-hover:text-lol-gold" />
    </td>
  );
}

// A set height, so rows line up whatever a cell holds
const ROW =
  "group h-[60px] cursor-pointer border-t border-lol-line transition-colors hover:bg-white/[0.03]";

// The two most-played members by name on one line, and a count for the rest;
// every full Riot ID is in the tooltip
const NAMES_SHOWN = 2;

function GroupNames(props: { members: TeammateGroup["members"] }) {
  const rest = () => props.members.length - NAMES_SHOWN;
  return (
    <div
      title={props.members.map((m) => m.name).join("\n")}
      class="flex min-w-0 items-center gap-2 whitespace-nowrap font-display text-[16px] font-semibold text-lol-text-bright"
    >
      <For each={props.members.slice(0, NAMES_SHOWN)}>
        {(m, j) => (
          <span class="flex min-w-0 items-center gap-2">
            <Show when={j() > 0}>
              <span class="text-lol-text/45">+</span>
            </Show>
            <span class="truncate">
              <bdi>{m.name.split("#")[0]}</bdi>
            </span>
          </span>
        )}
      </For>
      <Show when={rest() > 0}>
        <span class="chip h-6 shrink-0 bg-lol-gold/10 px-2 text-[12px] text-lol-gold">
          +{rest()}
        </span>
      </Show>
    </div>
  );
}

function PlayersTable(props: { players: TeammateStats[]; sort: Sort<PlayerSortKey> }) {
  const navigate = useNavigate();
  const champData = useChampionData();
  const head = (label: string, field: PlayerSortKey, cls: string, numeric = false) => (
    <SortHeader
      sortKey={props.sort.sortKey()}
      sortDir={props.sort.sortDir()}
      onSort={props.sort.onSort}
      numeric={numeric}
      label={label}
      field={field}
      class={cls}
    />
  );

  return (
    <table class="w-full">
      <thead>
        <tr class="border-b border-lol-line bg-black/20">
          <Th class="w-14 !text-right">#</Th>
          <Th>Player</Th>
          {head("Games", "games", "w-24", true)}
          {head("Win Rate", "winRate", "w-44")}
          {head("Their KDA", "kda", "w-36")}
          <Th class="w-36">Top Champions</Th>
          {head("Last Played", "lastPlayed", "w-32")}
          <th class="w-10" />
        </tr>
      </thead>
      <tbody>
        <For each={props.players}>
          {(t, i) => {
            const avgKills = t.games > 0 ? t.kills / t.games : 0;
            const avgDeaths = t.games > 0 ? t.deaths / t.games : 0;
            const avgAssists = t.games > 0 ? t.assists / t.games : 0;
            const ratio =
              avgDeaths > 0 ? (avgKills + avgAssists) / avgDeaths : avgKills + avgAssists;

            return (
              <tr onClick={() => navigate(friendPath(t.key))} class={ROW}>
                <td class="font-num px-3 py-2.5 text-right text-[14px] text-lol-text/60">
                  {i() + 1}
                </td>
                <td class="px-3 py-2.5">
                  <div class="flex min-w-0 items-center gap-3">
                    <SummonerIcon
                      iconId={t.profileIcon}
                      size={34}
                      lazy
                      class="ring-1 ring-white/10"
                    />
                    <span class="truncate font-display text-[16px] font-semibold text-lol-text-bright">
                      <TaggedRiotId id={t.name} />
                    </span>
                  </div>
                </td>
                <td class="font-num px-3 py-2.5 text-right text-[15px] font-semibold text-lol-text-bright">
                  {t.games.toLocaleString(LOCALE)}
                </td>
                <td class="px-3 py-2.5">
                  <WinRateBar wins={t.wins} total={t.games} />
                </td>
                <td class="px-3 py-2.5">
                  <KdaCell
                    ratio={ratio}
                    label={kdaRatio(t.kills, t.deaths, t.assists)}
                    kills={avgKills}
                    deaths={avgDeaths}
                    assists={avgAssists}
                  />
                </td>
                <td class="px-3 py-2.5">
                  <div class="flex items-center gap-1.5">
                    <For each={t.champions.slice(0, 3)}>
                      {(c) => (
                        <div class="group/champ relative">
                          <ChampionIcon championId={c.champion_id} size={30} />
                          <div class="menu pointer-events-none absolute bottom-full left-1/2 z-10 mb-1.5 hidden -translate-x-1/2 whitespace-nowrap px-2 py-1 text-[12px] font-medium text-lol-text-bright group-hover/champ:block">
                            {getChampionName(champData(), c.champion_id)}{" "}
                            <span class="font-num text-lol-text">({c.games})</span>
                          </div>
                        </div>
                      )}
                    </For>
                  </div>
                </td>
                <LastPlayedCell timestamp={t.lastPlayed} />
                <GoCell />
              </tr>
            );
          }}
        </For>
      </tbody>
    </table>
  );
}

function GroupsTable(props: { groups: TeammateGroup[]; sort: Sort<GroupSortKey> }) {
  const navigate = useNavigate();
  const head = (label: string, field: GroupSortKey, cls: string, numeric = false) => (
    <SortHeader
      sortKey={props.sort.sortKey()}
      sortDir={props.sort.sortDir()}
      onSort={props.sort.onSort}
      numeric={numeric}
      label={label}
      field={field}
      class={cls}
    />
  );

  return (
    <table class="w-full">
      <thead>
        <tr class="border-b border-lol-line bg-black/20">
          <Th class="w-14 !text-right">#</Th>
          <Th>Group</Th>
          {head("Size", "size", "w-24")}
          {head("Games", "games", "w-24", true)}
          {head("Win Rate", "winRate", "w-44")}
          {head("Group KDA", "kda", "w-36")}
          {head("Last Played", "lastPlayed", "w-32")}
          <th class="w-10" />
        </tr>
      </thead>
      <tbody>
        <For each={props.groups}>
          {(g, i) => {
            // A per-player average, so groups of different sizes compare
            const lines = g.games * groupSize(g);
            return (
              <tr onClick={() => navigate(groupPath(g.key))} class={ROW}>
                <td class="font-num px-3 py-2.5 text-right text-[14px] text-lol-text/60">
                  {i() + 1}
                </td>
                <td class="px-3 py-2.5">
                  <div class="flex min-w-0 items-center gap-3">
                    {/* A full team's width, so every row's names share one left edge */}
                    <div class="flex w-[102px] shrink-0 -space-x-1.5">
                      <For each={g.members}>
                        {(m) => (
                          <SummonerIcon
                            iconId={m.profileIcon}
                            size={30}
                            lazy
                            class="ring-2 ring-lol-card"
                          />
                        )}
                      </For>
                    </div>
                    <GroupNames members={g.members} />
                  </div>
                </td>
                <td class="px-3 py-2.5">
                  <span class="chip h-6 bg-white/[0.06] px-2 text-[12px] text-lol-text-bright/85">
                    {GROUP_SIZES[groupSize(g)]}
                  </span>
                </td>
                <td class="font-num px-3 py-2.5 text-right text-[15px] font-semibold text-lol-text-bright">
                  {g.games.toLocaleString(LOCALE)}
                </td>
                <td class="px-3 py-2.5">
                  <WinRateBar wins={g.wins} total={g.games} />
                </td>
                <td class="px-3 py-2.5">
                  <KdaCell
                    ratio={groupRatio(g)}
                    label={kdaRatio(g.kills, g.deaths, g.assists)}
                    kills={g.kills / lines}
                    deaths={g.deaths / lines}
                    assists={g.assists / lines}
                  />
                </td>
                <LastPlayedCell timestamp={g.lastPlayed} />
                <GoCell />
              </tr>
            );
          }}
        </For>
      </tbody>
    </table>
  );
}
