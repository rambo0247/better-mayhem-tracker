import { useMemo, useEffect, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
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
import { TaggedRiotId } from "../components/SharedStats";
import { ChevronRightIcon, UsersIcon } from "../components/icons";
import SearchInput from "../components/SearchInput";
import FilterMenu, { FilterField } from "../components/FilterMenu";
import MinGamesFilter from "../components/MinGamesFilter";
import SeasonSelect from "../components/SeasonSelect";

type View = FriendsLink["view"];
type PlayerSortKey = "games" | "winRate" | "kda" | "lastPlayed";
type GroupSortKey = "size" | "games" | "winRate" | "kda" | "lastPlayed";

const VIEWS: { key: View; label: string; title?: string }[] = [
  { key: "players", label: "Players" },
  {
    key: "groups",
    label: "Groups",
    title: `Each game counts once, for everyone on your team you've played ${MIN_GROUP_MEMBER_GAMES}+ games with`,
  },
];

function groupRatio(group: TeammateGroup): number {
  const takedowns = group.kills + group.assists;
  return group.deaths > 0 ? takedowns / group.deaths : takedowns;
}

export default function Friends() {
  const link = (useLocation().state ?? null) as FriendsLink | null;
  const [season, setSeason] = useViewState<string | undefined>("friends.season", undefined);
  const [view, setView] = useViewState<View>(
    "friends.view",
    link?.view ?? "players",
    link === null,
  );
  const { data: players, refetch: refetchPlayers } = useIpc<TeammateStats[]>(
    () => window.api.getTeammateStats(season),
    [season],
  );
  const { data: groups, refetch: refetchGroups } = useIpc<TeammateGroup[]>(
    () => window.api.getTeammateGroups(season),
    [season],
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
  const { sortKey: playerSortKey, sortDir: playerSortDir } = playerSort;
  const { sortKey: groupSortKey, sortDir: groupSortDir } = groupSort;

  useEffect(() => {
    const unsub = window.api.onGamesUpdated(() => {
      refetchPlayers();
      refetchGroups();
    });
    return unsub;
  }, [refetchPlayers, refetchGroups]);

  const sortedPlayers = useMemo(() => {
    if (!players) return [];
    let filtered = players.filter(
      (t) => (minGames === undefined || t.games >= minGames) && matchesSearch(t.name, search),
    );

    filtered.sort((a, b) => {
      let av: number, bv: number;
      switch (playerSortKey) {
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
      return playerSortDir === "desc" ? bv - av : av - bv;
    });

    return filtered;
  }, [players, search, minGames, playerSortKey, playerSortDir]);

  const sortedGroups = useMemo(() => {
    if (!groups) return [];
    const filtered = groups.filter(
      (g) =>
        (minGames === undefined || g.games >= minGames) &&
        (size === undefined || groupSize(g) === size) &&
        g.members.some((m) => matchesSearch(m.name, search)),
    );

    filtered.sort((a, b) => {
      let av: number, bv: number;
      switch (groupSortKey) {
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
      return groupSortDir === "desc" ? bv - av : av - bv;
    });

    return filtered;
  }, [groups, search, minGames, size, groupSortKey, groupSortDir]);

  if (!players || !groups) {
    return <div className="label mt-20 text-center">Loading…</div>;
  }

  const showGroups = view === "groups";
  const listed = showGroups ? sortedGroups : sortedPlayers;

  const actions = (
    <>
      <div className="seg" role="group" aria-label="View">
        {VIEWS.map((v) => (
          <button
            key={v.key}
            onClick={() => setView(v.key)}
            title={v.title}
            aria-pressed={view === v.key}
            className="seg-item"
          >
            {v.label}
          </button>
        ))}
      </div>
      <FilterMenu
        active={
          (season !== undefined ? 1 : 0) +
          (minGames !== MIN_SHARED_GAMES ? 1 : 0) +
          (showGroups && size !== undefined ? 1 : 0)
        }
        onReset={() => {
          setSeason(undefined);
          setMinGames(MIN_SHARED_GAMES);
          setSize(undefined);
        }}
      >
        <SeasonSelect value={season} onChange={setSeason} label="Set" />
        {showGroups && (
          <FilterField label="Group size">
            <select
              value={size ?? ""}
              onChange={(e) => setSize(e.target.value === "" ? undefined : Number(e.target.value))}
              className="select w-full"
            >
              <option value="">All sizes</option>
              {Object.entries(GROUP_SIZES).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </FilterField>
        )}
        <MinGamesFilter
          value={minGames}
          onChange={setMinGames}
          max={Math.max(...(showGroups ? groups : players).map((row) => row.games))}
        />
      </FilterMenu>
      <SearchInput
        value={search}
        onChange={setSearch}
        placeholder={showGroups ? "Search groups..." : "Search player..."}
      />
    </>
  );

  return (
    <div className="max-w-[1320px] space-y-6">
      <PageHeader
        kicker="Social"
        title="Friends"
        subtitle={
          <>
            <span className="font-num text-[14px] font-semibold text-lol-text-bright">
              {listed.length.toLocaleString(LOCALE)}
            </span>{" "}
            {showGroups ? "groups" : "players"} ·{" "}
            <span className="font-num text-[14px] font-semibold text-lol-text-bright">
              {minGames ?? 1}+
            </span>{" "}
            games together
          </>
        }
        actions={actions}
        className="pb-0"
      />

      {listed.length === 0 ? (
        <div className="panel flex flex-col items-center gap-3 px-8 py-14 text-center">
          <UsersIcon className="h-8 w-8 text-lol-gold/60" />
          <div className="max-w-md text-[14px] text-lol-text">
            No {showGroups ? "groups" : "players"} match the current search and filters.
          </div>
        </div>
      ) : (
        <div className="panel overflow-hidden">
          {showGroups ? (
            <GroupsTable groups={sortedGroups} sort={groupSort} />
          ) : (
            <PlayersTable players={sortedPlayers} sort={playerSort} />
          )}
        </div>
      )}
    </div>
  );
}

// A plain column head, for the columns that don't sort
function Th({ children, className = "" }: { children?: ReactNode; className?: string }) {
  return <th className={`tbl-head px-3 py-3 text-left ${className}`}>{children}</th>;
}

// Their ratio over the per-game line it comes from
function KdaCell({
  ratio,
  label,
  kills,
  deaths,
  assists,
}: {
  ratio: number;
  label: string;
  kills: number;
  deaths: number;
  assists: number;
}) {
  return (
    <div className="leading-tight">
      <div className={`font-num text-[15px] font-semibold ${kdaColor(ratio)}`}>
        {label}
        <span className="ml-1 text-[11px] tracking-[0.08em] text-lol-text">KDA</span>
      </div>
      <div className="font-num text-[12px] text-lol-text">
        <Kda
          kills={formatDecimal(kills)}
          deaths={formatDecimal(deaths)}
          assists={formatDecimal(assists)}
        />
      </div>
    </div>
  );
}

function LastPlayedCell({ timestamp }: { timestamp: number }) {
  return (
    <td className="px-3 py-2.5">
      <span className="font-num text-[14px] text-lol-text" title={formatDateTime(timestamp)}>
        {formatTimeAgo(timestamp)}
      </span>
    </td>
  );
}

// The row's way in, brought up on hover
function GoCell() {
  return (
    <td className="w-10 pr-4 text-right">
      <ChevronRightIcon className="ml-auto h-4 w-4 text-lol-text/30 transition-colors group-hover:text-lol-gold" />
    </td>
  );
}

// A set height, so rows line up whatever a cell holds
const ROW =
  "group h-[60px] cursor-pointer border-t border-lol-line transition-colors hover:bg-white/[0.03]";

// The two most-played members by name on one line, and a count for the rest;
// every full Riot ID is in the tooltip
const NAMES_SHOWN = 2;

function GroupNames({ members }: { members: TeammateGroup["members"] }) {
  const rest = members.length - NAMES_SHOWN;
  return (
    <div
      title={members.map((m) => m.name).join("\n")}
      className="flex min-w-0 items-center gap-2 whitespace-nowrap font-display text-[16px] font-semibold text-lol-text-bright"
    >
      {members.slice(0, NAMES_SHOWN).map((m, j) => (
        <span key={m.key} className="flex min-w-0 items-center gap-2">
          {j > 0 && <span className="text-lol-text/45">+</span>}
          <span className="truncate">
            <bdi>{m.name.split("#")[0]}</bdi>
          </span>
        </span>
      ))}
      {rest > 0 && (
        <span className="chip h-6 shrink-0 bg-lol-gold/10 px-2 text-[12px] text-lol-gold">
          +{rest}
        </span>
      )}
    </div>
  );
}

function PlayersTable({
  players,
  sort,
}: {
  players: TeammateStats[];
  sort: ReturnType<typeof useSort<PlayerSortKey>>;
}) {
  const navigate = useNavigate();
  const champData = useChampionData();

  return (
    <table className="w-full">
      <thead>
        <tr className="border-b border-lol-line bg-black/20">
          <Th className="w-14 !text-right">#</Th>
          <Th>Player</Th>
          <SortHeader {...sort} numeric label="Games" field="games" className="w-24" />
          <SortHeader {...sort} label="Win Rate" field="winRate" className="w-44" />
          <SortHeader {...sort} label="Their KDA" field="kda" className="w-36" />
          <Th className="w-36">Top Champions</Th>
          <SortHeader {...sort} label="Last Played" field="lastPlayed" className="w-32" />
          <th className="w-10" />
        </tr>
      </thead>
      <tbody>
        {players.map((t, i) => {
          const avgKills = t.games > 0 ? t.kills / t.games : 0;
          const avgDeaths = t.games > 0 ? t.deaths / t.games : 0;
          const avgAssists = t.games > 0 ? t.assists / t.games : 0;
          const ratio = avgDeaths > 0 ? (avgKills + avgAssists) / avgDeaths : avgKills + avgAssists;

          return (
            <tr
              key={t.key}
              onClick={() => navigate(`/friends/${encodeURIComponent(t.key)}`)}
              className={ROW}
            >
              <td className="font-num px-3 py-2.5 text-right text-[14px] text-lol-text/60">
                {i + 1}
              </td>
              <td className="px-3 py-2.5">
                <div className="flex min-w-0 items-center gap-3">
                  <SummonerIcon
                    iconId={t.profileIcon}
                    size={34}
                    lazy
                    className="ring-1 ring-white/10"
                  />
                  <span className="truncate font-display text-[16px] font-semibold text-lol-text-bright">
                    <TaggedRiotId id={t.name} />
                  </span>
                </div>
              </td>
              <td className="font-num px-3 py-2.5 text-right text-[15px] font-semibold text-lol-text-bright">
                {t.games.toLocaleString(LOCALE)}
              </td>
              <td className="px-3 py-2.5">
                <WinRateBar wins={t.wins} total={t.games} />
              </td>
              <td className="px-3 py-2.5">
                <KdaCell
                  ratio={ratio}
                  label={kdaRatio(t.kills, t.deaths, t.assists)}
                  kills={avgKills}
                  deaths={avgDeaths}
                  assists={avgAssists}
                />
              </td>
              <td className="px-3 py-2.5">
                <div className="flex items-center gap-1.5">
                  {t.champions.slice(0, 3).map((c) => (
                    <div key={c.champion_id} className="group/champ relative">
                      <ChampionIcon championId={c.champion_id} size={30} />
                      <div className="menu pointer-events-none absolute bottom-full left-1/2 z-10 mb-1.5 hidden -translate-x-1/2 whitespace-nowrap px-2 py-1 text-[12px] font-medium text-lol-text-bright group-hover/champ:block">
                        {getChampionName(champData, c.champion_id)}{" "}
                        <span className="font-num text-lol-text">({c.games})</span>
                      </div>
                    </div>
                  ))}
                </div>
              </td>
              <LastPlayedCell timestamp={t.lastPlayed} />
              <GoCell />
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function GroupsTable({
  groups,
  sort,
}: {
  groups: TeammateGroup[];
  sort: ReturnType<typeof useSort<GroupSortKey>>;
}) {
  const navigate = useNavigate();

  return (
    <table className="w-full">
      <thead>
        <tr className="border-b border-lol-line bg-black/20">
          <Th className="w-14 !text-right">#</Th>
          <Th>Group</Th>
          <SortHeader {...sort} label="Size" field="size" className="w-24" />
          <SortHeader {...sort} numeric label="Games" field="games" className="w-24" />
          <SortHeader {...sort} label="Win Rate" field="winRate" className="w-44" />
          <SortHeader {...sort} label="Group KDA" field="kda" className="w-36" />
          <SortHeader {...sort} label="Last Played" field="lastPlayed" className="w-32" />
          <th className="w-10" />
        </tr>
      </thead>
      <tbody>
        {groups.map((g, i) => {
          // A per-player average, so groups of different sizes compare
          const lines = g.games * groupSize(g);
          return (
            <tr
              key={g.key}
              onClick={() => navigate(`/friends/groups/${encodeURIComponent(g.key)}`)}
              className={ROW}
            >
              <td className="font-num px-3 py-2.5 text-right text-[14px] text-lol-text/60">
                {i + 1}
              </td>
              <td className="px-3 py-2.5">
                <div className="flex min-w-0 items-center gap-3">
                  {/* A full team's width, so every row's names share one left edge */}
                  <div className="flex w-[102px] shrink-0 -space-x-1.5">
                    {g.members.map((m) => (
                      <SummonerIcon
                        key={m.key}
                        iconId={m.profileIcon}
                        size={30}
                        lazy
                        className="ring-2 ring-lol-card"
                      />
                    ))}
                  </div>
                  <GroupNames members={g.members} />
                </div>
              </td>
              <td className="px-3 py-2.5">
                <span className="chip h-6 bg-white/[0.06] px-2 text-[12px] text-lol-text-bright/85">
                  {GROUP_SIZES[groupSize(g)]}
                </span>
              </td>
              <td className="font-num px-3 py-2.5 text-right text-[15px] font-semibold text-lol-text-bright">
                {g.games.toLocaleString(LOCALE)}
              </td>
              <td className="px-3 py-2.5">
                <WinRateBar wins={g.wins} total={g.games} />
              </td>
              <td className="px-3 py-2.5">
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
        })}
      </tbody>
    </table>
  );
}
