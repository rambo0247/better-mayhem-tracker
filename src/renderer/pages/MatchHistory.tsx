import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { useLocation } from "react-router-dom";
import { useMatches } from "../hooks/useMatches";
import { useChampionData, getChampionName } from "../hooks/useChampions";
import { useIpc } from "../hooks/useIpc";
import { useLcuStatus } from "../hooks/useLcuStatus";
import { useBackfill } from "../hooks/useBackfill";
import { useViewState } from "../hooks/useViewState";
import { EMPTY_FILTER_OPTIONS } from "../hooks/useFilterOptions";
import type {
  MatchListItem,
  MatchDetail,
  DashboardData,
  MatchFilterOptions,
  MatchHistoryLink,
  MatchSession,
  MatchSort,
  MatchSortDir,
  MultikillType,
  LcuStatus,
  BackfillProgress,
  ChampionData,
} from "../lib/types";
import ChampionIcon from "../components/ChampionIcon";
import AugmentIcon from "../components/AugmentIcon";
import ItemIcon from "../components/ItemIcon";
import MatchScoreboard from "../components/MatchScoreboard";
import MultikillBadge from "../components/MultikillBadge";
import StatBars from "../components/StatBars";
import ScoreCell from "../components/ScoreCell";
import { BadgeCounts, ScoreMeter } from "../components/SharedStats";
import StatCard from "../components/StatCard";
import PageHeader from "../components/PageHeader";
import SummonerIcon from "../components/SummonerIcon";
import SummonerSpellIcon from "../components/SummonerSpellIcon";
import WinRateBar from "../components/WinRateBar";
import {
  ArrowDownIcon,
  ChevronDownIcon,
  CopyIcon,
  ImageIcon,
  StarIcon,
  SwordsIcon,
  ZapIcon,
} from "../components/icons";
import FilterMenu, { FilterField } from "../components/FilterMenu";
import { seasonName } from "../components/SeasonSelect";
import { ExportImageMessage, useImageExport } from "../components/ExportImage";
import {
  LOCALE,
  WEEK_START,
  formatDateTime,
  formatDecimal,
  formatDuration,
  formatPlaytime,
  formatTimeAgo,
  formatKDA,
  kdaRatio,
  kdaColor,
  kdaHighlight,
  formatPatch,
  scoreColor,
} from "../lib/format";
import { queueLabel } from "../components/QueueSelect";
import {
  SESSION_GROUPING_SETTING,
  parseSessionGrouping,
  sessionDay,
  sessionKey,
  sessionWeek,
  type SessionGrouping,
} from "../../shared/session";
import Kda from "../components/Kda";
import RiotId from "../components/RiotId";

// An empty list means something different depending on whether we're still
// waiting on the client, mid-import, or genuinely out of games.
function emptyStateMessage(
  status: LcuStatus,
  backfill: { running: boolean; progress: BackfillProgress | null },
) {
  if (backfill.running) {
    const p = backfill.progress;
    return p && p.total > 0
      ? `Importing your match history — ${p.current.toLocaleString(LOCALE)} of ${p.total.toLocaleString(LOCALE)} games checked...`
      : "Importing your match history...";
  }
  if (status !== "connected" && status !== "ingame") {
    return "Waiting for the League client. Once it's open, your Mayhem games import automatically.";
  }
  return "No ARAM Mayhem games found yet. New games are recorded as you play.";
}

// The multikill filters, toggled from the stat card or the filter menu
const MULTIKILL_KINDS: { kind: MultikillType; label: string; name: string; color: string }[] = [
  { kind: "doubles", label: "Double", name: "double", color: "text-sky-400" },
  { kind: "triples", label: "Triple", name: "triple", color: "text-amber-400" },
  { kind: "quadras", label: "Quadra", name: "quadra", color: "text-purple-400" },
  { kind: "pentas", label: "Penta", name: "penta", color: "text-red-400" },
];

// The unselected state is the default sort (date), so it isn't listed here
const SORT_OPTIONS: { value: MatchSort; label: string }[] = [
  { value: "score", label: "Score" },
  { value: "kda", label: "KDA" },
  { value: "kills", label: "Kills" },
  { value: "duration", label: "Duration" },
  { value: "damageDealt", label: "Damage Dealt" },
  { value: "damageTaken", label: "Damage Taken" },
  { value: "healing", label: "Healing" },
];

interface Session {
  // Doubles as the React key and as what the database's totals are looked up by
  key: string;
  label: string;
  matches: MatchListItem[];
  // Games in the whole session, which is more than `matches` holds until the
  // list has been scrolled to the end of the session
  games: number;
  wins: number;
  losses: number;
  kills: number;
  deaths: number;
  assists: number;
  avgScore: number | null;
}

// Expects a date-ordered list (either direction); remakes count toward the
// session's size but stay out of its record and averages.
//
// Rows are pooled by key rather than by runs of neighbours, so the games from a
// patch that no longer sit together — an older game missing its version can
// land between two that have it — still read as the one session the totals
// below the header describe.
function groupIntoSessions(matches: MatchListItem[], grouping: SessionGrouping): Session[] {
  const sessions = new Map<string, Session>();
  const scores = new Map<string, { sum: number; games: number }>();

  for (const m of matches) {
    const key = sessionKey(m, grouping, WEEK_START);
    let session = sessions.get(key);
    if (!session) {
      session = {
        key,
        label: sessionLabel(m, grouping),
        matches: [],
        games: 0,
        wins: 0,
        losses: 0,
        kills: 0,
        deaths: 0,
        assists: 0,
        avgScore: null,
      };
      sessions.set(key, session);
      scores.set(key, { sum: 0, games: 0 });
    }
    session.matches.push(m);
    session.games++;
    if (m.is_remake) continue;
    if (m.win) session.wins++;
    else session.losses++;
    session.kills += m.kills;
    session.deaths += m.deaths;
    session.assists += m.assists;
    if (m.score != null) {
      const score = scores.get(key)!;
      score.sum += m.score;
      score.games++;
    }
  }

  for (const session of sessions.values()) {
    const score = scores.get(session.key)!;
    if (score.games > 0) session.avgScore = score.sum / score.games;
  }
  return [...sessions.values()];
}

function sessionLabel(match: MatchListItem, grouping: SessionGrouping): string {
  if (grouping === "patch") {
    return match.game_version ? `Patch ${formatPatch(match.game_version)}` : "Unknown patch";
  }
  if (grouping === "week") return weekLabel(sessionWeek(match.game_creation, WEEK_START));
  return dayLabel(sessionDay(match.game_creation));
}

function dayLabel(day: number): string {
  const d = new Date(day);
  const today = new Date(sessionDay(Date.now()));
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString(LOCALE, {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(d.getFullYear() !== today.getFullYear() && { year: "numeric" }),
  });
}

// Weeks open on the regional first day of the week and are named by that day.
function weekLabel(week: number): string {
  const d = new Date(week);
  const thisWeek = new Date(sessionWeek(Date.now(), WEEK_START));
  const lastWeek = new Date(thisWeek);
  lastWeek.setDate(thisWeek.getDate() - 7);
  if (d.toDateString() === thisWeek.toDateString()) return "This week";
  if (d.toDateString() === lastWeek.toDateString()) return "Last week";
  const start = d.toLocaleDateString(LOCALE, {
    month: "short",
    day: "numeric",
    ...(d.getFullYear() !== thisWeek.getFullYear() && { year: "numeric" }),
  });
  return `Week of ${start}`;
}

export default function MatchHistory() {
  // Arriving from another page's link opens the list on that link's filters
  // alone, so it shows exactly the games the link promised. The sort is left
  // as it was.
  const link = (useLocation().state ?? null) as MatchHistoryLink | null;
  const restore = link === null;
  const [championFilter, setChampionFilter] = useViewState<number | undefined>(
    "matches.champion",
    link?.championId,
    restore,
  );
  const [seasonFilter, setSeasonFilter] = useViewState<string | undefined>(
    "matches.season",
    link?.season,
    restore,
  );
  const [patchFilter, setPatchFilter] = useViewState<string | undefined>(
    "matches.patch",
    link?.patch,
    restore,
  );
  const [queueFilter, setQueueFilter] = useViewState<number | undefined>(
    "matches.queue",
    link?.queue,
    restore,
  );
  const [accountFilter, setAccountFilter] = useViewState<string | undefined>(
    "matches.account",
    undefined,
    restore,
  );
  const [multikillFilter, setMultikillFilter] = useViewState<MultikillType[]>(
    "matches.multikills",
    [],
    restore,
  );
  const [sort, setSort] = useViewState<MatchSort | undefined>("matches.sort", undefined);
  const [sortDir, setSortDir] = useViewState<MatchSortDir>("matches.sortDir", "desc");
  const [favoritesOnly, setFavoritesOnly] = useViewState("matches.favorites", false, restore);
  // Every multikill kind picked together counts as the one filter
  const activeFilters =
    [championFilter, seasonFilter, patchFilter, queueFilter, accountFilter].filter(
      (v) => v !== undefined,
    ).length +
    (multikillFilter.length > 0 ? 1 : 0) +
    (favoritesOnly ? 1 : 0);
  // Back to every game, leaving the sort as it is
  const clearFilters = useCallback(() => {
    setChampionFilter(undefined);
    setSeasonFilter(undefined);
    setPatchFilter(undefined);
    setQueueFilter(undefined);
    setAccountFilter(undefined);
    setMultikillFilter([]);
    setFavoritesOnly(false);
  }, [
    setChampionFilter,
    setSeasonFilter,
    setPatchFilter,
    setQueueFilter,
    setAccountFilter,
    setMultikillFilter,
    setFavoritesOnly,
  ]);
  const { matches, loading, hasMore, loadMore, reload } = useMatches({
    championId: championFilter,
    patch: patchFilter,
    queue: queueFilter,
    account: accountFilter,
    season: seasonFilter,
    sort,
    sortDir,
    multikills: multikillFilter,
    favorites: favoritesOnly,
  });

  const toggleMultikill = useCallback(
    (kind: MultikillType) => {
      setMultikillFilter((prev) =>
        prev.includes(kind) ? prev.filter((k) => k !== kind) : [...prev, kind],
      );
    },
    [setMultikillFilter],
  );
  const champData = useChampionData();
  // Read once on mount, which is every time the page is opened: coming back
  // from Settings is what changes it.
  const { data: storedGrouping } = useIpc<string | null>(
    () => window.api.getSetting(SESSION_GROUPING_SETTING),
    [],
  );
  const grouping = parseSessionGrouping(storedGrouping);
  const { data: dashboard, refetch: refetchDashboard } = useIpc<DashboardData>(
    () =>
      window.api.getDashboard({
        championId: championFilter,
        patch: patchFilter,
        queue: queueFilter,
        account: accountFilter,
        season: seasonFilter,
      }),
    [championFilter, patchFilter, queueFilter, accountFilter, seasonFilter],
  );
  // The list arrives a page at a time, so the rows on screen describe the page
  // rather than the day. These cover every game the filters match.
  const { data: sessionTotals, refetch: refetchSessions } = useIpc<MatchSession[]>(
    () =>
      window.api.getMatchSessions({
        championId: championFilter,
        patch: patchFilter,
        queue: queueFilter,
        account: accountFilter,
        season: seasonFilter,
        multikills: multikillFilter,
        favorites: favoritesOnly,
      }),
    [
      championFilter,
      patchFilter,
      queueFilter,
      accountFilter,
      seasonFilter,
      multikillFilter,
      favoritesOnly,
    ],
  );

  // Null until the first answer. The effects below drop selections the data no
  // longer supports, and an empty stand-in would read as data supporting none.
  const [loadedOptions, setLoadedOptions] = useState<MatchFilterOptions | null>(null);
  const filterOptions = loadedOptions ?? EMPTY_FILTER_OPTIONS;
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    match: MatchListItem;
  } | null>(null);
  const [detail, setDetail] = useState<MatchDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  // One instance for the page: both of the right-click menu's image items
  // report through the same message
  const exporting = useImageExport();
  const [puuids, setPuuids] = useState<string[] | null>(null);
  const [profile, setProfile] = useState<{
    name: string | null;
    profileIcon: number | null;
  } | null>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const lcuStatus = useLcuStatus();
  const backfill = useBackfill();

  useEffect(() => {
    window.api.getAllSummonerPuuids().then(setPuuids);
  }, []);

  // The name and icon can change under us as new games arrive
  useEffect(() => {
    const load = () => window.api.getProfile().then(setProfile);
    load();
    return window.api.onGamesUpdated(load);
  }, []);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) loadMore();
      },
      { rootMargin: "200px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [loadMore]);

  const fetchOptions = useCallback(
    () =>
      window.api
        .getMatchFilterOptions({
          championId: championFilter,
          patch: patchFilter,
          queue: queueFilter,
          account: accountFilter,
          season: seasonFilter,
        })
        .then(setLoadedOptions),
    [championFilter, patchFilter, queueFilter, accountFilter, seasonFilter],
  );

  useEffect(() => {
    fetchOptions();

    const unsub = window.api.onGamesUpdated(() => {
      refetchDashboard();
      refetchSessions();
      fetchOptions();
    });
    return unsub;
  }, [fetchOptions, refetchDashboard, refetchSessions]);

  // Clear a selection if new data leaves it without any matching games
  useEffect(() => {
    if (!loadedOptions) return;
    if (championFilter !== undefined && !loadedOptions.champions.includes(championFilter)) {
      setChampionFilter(undefined);
    }
    if (seasonFilter !== undefined && !loadedOptions.seasons.includes(seasonFilter)) {
      setSeasonFilter(undefined);
    }
    if (patchFilter !== undefined && !loadedOptions.patches.includes(patchFilter)) {
      setPatchFilter(undefined);
    }
    if (queueFilter !== undefined && !loadedOptions.queues.includes(queueFilter)) {
      setQueueFilter(undefined);
    }
    if (
      accountFilter !== undefined &&
      !loadedOptions.accounts.some((a) => a.puuid === accountFilter)
    ) {
      setAccountFilter(undefined);
    }
    // Settles rather than loops: clearing a filter sets it to undefined, and
    // the undefined branch does nothing on the re-run.
  }, [
    loadedOptions,
    championFilter,
    seasonFilter,
    patchFilter,
    queueFilter,
    accountFilter,
    setChampionFilter,
    setSeasonFilter,
    setPatchFilter,
    setQueueFilter,
    setAccountFilter,
  ]);

  // Unfavoriting the last game takes the toggle button away with it, so the
  // filter can't be left on with no way to turn it off.
  const hasFavorites = loadedOptions?.hasFavorites;
  useEffect(() => {
    if (hasFavorites === false) setFavoritesOnly(false);
  }, [hasFavorites, setFavoritesOnly]);

  const championOptions = useMemo(
    () =>
      filterOptions.champions
        .map((id) => ({ id, name: getChampionName(champData, id) }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [filterOptions.champions, champData],
  );

  const toggleExpand = useCallback(
    async (gameId: number) => {
      if (expandedId === gameId) {
        setExpandedId(null);
        setDetail(null);
        return;
      }
      setExpandedId(gameId);
      setDetailLoading(true);
      try {
        const d = await window.api.getMatchDetail(gameId);
        setDetail(d);
      } finally {
        setDetailLoading(false);
      }
    },
    [expandedId],
  );

  const handleToggleFavorite = useCallback(
    async (match: MatchListItem) => {
      setContextMenu(null);
      await window.api.toggleFavorite(match.game_id);
      reload();
      // With the favorites filter on, this changed which games are in the list
      refetchSessions();
      // The first favorite reveals the toggle button, the last one hides it
      fetchOptions();
    },
    [reload, refetchSessions, fetchOptions],
  );

  const avgKills =
    dashboard && dashboard.totalGames > 0
      ? formatDecimal(dashboard.totalKills / dashboard.totalGames)
      : "0";
  const avgDeaths =
    dashboard && dashboard.totalGames > 0
      ? formatDecimal(dashboard.totalDeaths / dashboard.totalGames)
      : "0";
  const avgAssists =
    dashboard && dashboard.totalGames > 0
      ? formatDecimal(dashboard.totalAssists / dashboard.totalGames)
      : "0";
  const kdaValue =
    dashboard && dashboard.totalDeaths > 0
      ? (dashboard.totalKills + dashboard.totalAssists) / dashboard.totalDeaths
      : Infinity;
  // With one account selected, the profile card is about that account — not
  // whichever one played most recently.
  const selectedAccount = accountFilter
    ? filterOptions.accounts.find((a) => a.puuid === accountFilter)
    : undefined;
  const profileShown = selectedAccount
    ? { name: selectedAccount.name, profileIcon: selectedAccount.profileIcon }
    : profile;

  // Session headers only make sense when the list reads in time order; any
  // other sort interleaves sessions, so those render flat.
  const isDateSort = !sort || sort === "date";
  const sessions = useMemo(() => {
    if (!isDateSort || grouping === "none") return null;
    const grouped = groupIntoSessions(matches, grouping);
    if (!sessionTotals) return grouped;

    // The rows stay as they are; only the header totals come from the database,
    // so a session that is half-loaded still reports all of itself.
    const byKey = new Map(sessionTotals.map((total) => [total.key, total]));
    return grouped.map((session) => {
      const total = byKey.get(session.key);
      if (!total) return session;
      return {
        ...session,
        games: total.games,
        wins: total.wins,
        losses: total.losses,
        kills: total.kills,
        deaths: total.deaths,
        assists: total.assists,
        avgScore:
          total.scored_games > 0 && total.score_sum != null
            ? total.score_sum / total.scored_games
            : null,
      };
    });
  }, [isDateSort, grouping, matches, sessionTotals]);

  const totalMultikills = dashboard
    ? dashboard.multikills.doubles +
      dashboard.multikills.triples +
      dashboard.multikills.quadras +
      dashboard.multikills.pentas
    : 0;

  const actions = (
    <>
      <FilterMenu active={activeFilters} onReset={clearFilters}>
        {/* A single-account database doesn't need an account dropdown */}
        {(filterOptions.accounts.length > 1 || accountFilter !== undefined) && (
          <FilterField label="Account">
            <select
              value={accountFilter ?? ""}
              onChange={(e) => setAccountFilter(e.target.value === "" ? undefined : e.target.value)}
              className="select w-full"
            >
              <option value="">All Accounts</option>
              {filterOptions.accounts.map((a) => (
                <option key={a.puuid} value={a.puuid}>
                  {a.name ?? "Unknown account"}
                </option>
              ))}
            </select>
          </FilterField>
        )}
        <FilterField label="Champion">
          <select
            value={championFilter ?? ""}
            onChange={(e) =>
              setChampionFilter(e.target.value === "" ? undefined : Number(e.target.value))
            }
            className="select w-full"
          >
            <option value="">All Champions</option>
            {championOptions.map(({ id, name }) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </FilterField>
        <FilterField label="Set">
          <select
            value={seasonFilter ?? ""}
            onChange={(e) => setSeasonFilter(e.target.value === "" ? undefined : e.target.value)}
            className="select w-full"
          >
            <option value="">All Sets</option>
            {filterOptions.seasons.map((s) => (
              <option key={s} value={s}>
                {seasonName(s)}
              </option>
            ))}
          </select>
        </FilterField>
        <FilterField label="Patch">
          <select
            value={patchFilter ?? ""}
            onChange={(e) => setPatchFilter(e.target.value === "" ? undefined : e.target.value)}
            className="select w-full"
          >
            <option value="">All Patches</option>
            {filterOptions.patches.map((p) => (
              <option key={p} value={p}>
                Patch {formatPatch(p)}
              </option>
            ))}
          </select>
        </FilterField>
        {(filterOptions.queues.length > 1 || queueFilter !== undefined) && (
          <FilterField label="Queue">
            <select
              value={queueFilter ?? ""}
              onChange={(e) =>
                setQueueFilter(e.target.value === "" ? undefined : Number(e.target.value))
              }
              className="select w-full"
            >
              <option value="">All Queues</option>
              {filterOptions.queues.map((q) => (
                <option key={q} value={q}>
                  {queueLabel(q)}
                </option>
              ))}
            </select>
          </FilterField>
        )}
        <FilterField label="Multikills">
          <div className="grid grid-cols-4 gap-1">
            {MULTIKILL_KINDS.map(({ kind, name, color }) => (
              <button
                key={kind}
                onClick={() => toggleMultikill(kind)}
                title={`Only show games with a ${name} kill`}
                className={`font-display rounded-[3px] border py-1 text-[12px] font-bold uppercase tracking-[0.06em] transition-colors ${color} ${
                  multikillFilter.includes(kind)
                    ? "border-lol-gold/60 bg-lol-gold/10"
                    : "border-lol-border hover:border-lol-gold/50"
                }`}
              >
                {name}
              </button>
            ))}
          </div>
        </FilterField>
        {filterOptions.hasFavorites && (
          <button
            onClick={() => setFavoritesOnly((v) => !v)}
            className={`btn btn-sm w-full justify-start ${favoritesOnly ? "btn-active" : ""}`}
          >
            <StarIcon
              className={`h-3.5 w-3.5 ${favoritesOnly ? "text-amber-400" : ""}`}
              fill={favoritesOnly ? "currentColor" : "none"}
            />
            Favorites only
          </button>
        )}
      </FilterMenu>
      <div className="flex items-center">
        <select
          value={sort ?? ""}
          onChange={(e) => {
            setSort(e.target.value === "" ? undefined : (e.target.value as MatchSort));
            setSortDir("desc");
          }}
          className="select relative rounded-r-none hover:z-10 focus:z-10"
          aria-label="Sort by"
        >
          <option value="">Newest</option>
          {SORT_OPTIONS.map(({ value, label }) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <button
          onClick={() => setSortDir((d) => (d === "desc" ? "asc" : "desc"))}
          title={
            !sort || sort === "date"
              ? sortDir === "desc"
                ? "Newest first"
                : "Oldest first"
              : sortDir === "desc"
                ? "Highest first"
                : "Lowest first"
          }
          className="btn btn-icon relative -ml-px rounded-l-none hover:z-10 focus-visible:z-10"
        >
          <ArrowDownIcon
            className={`h-3.5 w-3.5 transition-transform ${sortDir === "asc" ? "rotate-180" : ""}`}
          />
        </button>
      </div>
    </>
  );

  return (
    <div className="max-w-[1320px] space-y-6">
      <PageHeader
        kicker="Play"
        title="Match History"
        subtitle={
          dashboard && dashboard.totalGames > 0 ? (
            <>
              <span className="font-num text-[14px] text-lol-text-bright">
                {dashboard.totalGames.toLocaleString(LOCALE)}
              </span>{" "}
              {dashboard.totalGames === 1 ? "game" : "games"} recorded
              {dashboard.totalDuration > 0 && (
                <>
                  {" · "}
                  <span className="font-num text-[14px] text-lol-text-bright">
                    {formatPlaytime(dashboard.totalDuration)}
                  </span>{" "}
                  played
                </>
              )}
            </>
          ) : (
            "Every ARAM Mayhem game you play, recorded automatically"
          )
        }
        actions={actions}
        className="pb-0"
      />

      {/* Stat Cards */}
      {dashboard && dashboard.totalGames > 0 && (
        <div className="grid grid-cols-[minmax(0,1.45fr)_repeat(3,minmax(0,1fr))] items-stretch gap-4">
          <ProfileCard profile={profileShown} dashboard={dashboard} />

          <StatCard
            label="Avg Score"
            accent="gold"
            icon={<StarIcon className="h-3.5 w-3.5" />}
            value={
              dashboard.avgScore != null ? (
                <span className={scoreColor(dashboard.avgScore)}>
                  {formatDecimal(dashboard.avgScore)}
                  <span className="text-[17px] font-medium text-lol-text/60"> / 10</span>
                </span>
              ) : (
                "—"
              )
            }
            subtext={
              <>
                <ScoreMeter score={dashboard.avgScore} />
                {/* The ramp every score in the app is coloured by: ticks on the
                    0–10 track where the colour changes, and what each step means */}
                <div className="relative -mt-1.5 h-1.5">
                  {[5, 7, 9].map((at) => (
                    <span
                      key={at}
                      className="absolute top-0 h-1.5 w-px bg-lol-dark"
                      style={{ left: `${at * 10}%` }}
                    />
                  ))}
                </div>
                <div className="mt-2 flex flex-wrap gap-x-2.5 text-[12px]">
                  {(
                    [
                      ["5+", "solid", "text-lol-text-bright"],
                      ["7+", "great", "text-sky-400"],
                      ["9+", "elite", "text-amber-400"],
                    ] as const
                  ).map(([at, word, color]) => (
                    <span key={at} className={color}>
                      <span className="font-num font-semibold">{at}</span> {word}
                    </span>
                  ))}
                </div>
              </>
            }
          >
            <BadgeCounts
              mvps={dashboard.mvps}
              aces={dashboard.aces}
              scoredWins={dashboard.scoredWins}
              scoredLosses={dashboard.scoredLosses}
            />
          </StatCard>

          <StatCard
            label="Avg KDA"
            accent="sky"
            icon={<SwordsIcon className="h-3.5 w-3.5" />}
            value={
              /* Three numbers where the other cards show one — a notch smaller
                 keeps it on one line in the narrowest column */
              <span className="text-[26px]">
                <Kda kills={avgKills} deaths={avgDeaths} assists={avgAssists} />
              </span>
            }
            subtext={
              <span className={`font-num text-[15px] font-semibold ${kdaColor(kdaValue)}`}>
                {kdaRatio(dashboard.totalKills, dashboard.totalDeaths, dashboard.totalAssists)}{" "}
                <span className="text-[12px] tracking-[0.08em]">KDA</span>
              </span>
            }
          >
            {/* Career totals as tiles, built like the multikill card's beside it */}
            <div className="grid grid-cols-3 gap-1">
              {(
                [
                  ["Kills", dashboard.totalKills],
                  ["Deaths", dashboard.totalDeaths],
                  ["Assists", dashboard.totalAssists],
                ] as const
              ).map(([label, total]) => (
                <div
                  key={label}
                  className="rounded-[3px] border border-lol-line bg-black/15 px-1 py-1 text-center"
                >
                  <div className="font-num text-[16px] font-semibold leading-tight text-lol-text-bright">
                    {total.toLocaleString(LOCALE)}
                  </div>
                  <div className="label text-[11px] leading-3 text-lol-text">{label}</div>
                </div>
              ))}
            </div>
          </StatCard>

          <StatCard
            label="Multikills"
            accent="purple"
            icon={<ZapIcon className="h-3.5 w-3.5" />}
            value={totalMultikills.toLocaleString(LOCALE)}
            subtext={
              <>
                <span className="font-num text-[14px] text-lol-text-bright">
                  {formatDecimal(totalMultikills / dashboard.totalGames)}
                </span>{" "}
                per game
              </>
            }
          >
            <div className="grid grid-cols-4 gap-1">
              {MULTIKILL_KINDS.map(({ kind, label, name, color }) => {
                const active = multikillFilter.includes(kind);
                return (
                  <button
                    key={kind}
                    onClick={() => toggleMultikill(kind)}
                    title={`Only show games with a ${name} kill`}
                    className={`rounded-[3px] border px-1 py-1 text-center transition-colors ${
                      active
                        ? "border-lol-gold/60 bg-lol-gold/10"
                        : "border-lol-line bg-black/15 hover:border-lol-border hover:bg-white/5"
                    }`}
                  >
                    <div className={`font-num text-[17px] font-bold leading-tight ${color}`}>
                      {dashboard.multikills[kind].toLocaleString(LOCALE)}
                    </div>
                    <div className="label text-[11px] leading-3 text-lol-text">{label}</div>
                  </button>
                );
              })}
            </div>
          </StatCard>
        </div>
      )}

      <div>
        {matches.length === 0 && !loading && (
          <div className="panel flex flex-col items-center gap-3 px-8 py-14 text-center">
            <SwordsIcon className="h-8 w-8 text-lol-gold/60" />
            <div className="max-w-md text-[14px] text-lol-text">
              {activeFilters > 0 ? (
                <>
                  No games match the current filters.{" "}
                  <button
                    onClick={clearFilters}
                    className="font-semibold text-lol-gold hover:underline"
                  >
                    Clear filters
                  </button>
                </>
              ) : (
                emptyStateMessage(lcuStatus, backfill)
              )}
            </div>
          </div>
        )}

        {(() => {
          const renderMatch = (m: MatchListItem) => (
            <GameRow
              key={m.game_id}
              match={m}
              champData={champData}
              expanded={expandedId === m.game_id}
              detail={expandedId === m.game_id ? detail : null}
              detailLoading={expandedId === m.game_id && detailLoading}
              puuids={puuids}
              onToggle={() => toggleExpand(m.game_id)}
              onContextMenu={(e) => {
                e.preventDefault();
                setContextMenu({ x: e.clientX, y: e.clientY, match: m });
              }}
            />
          );
          return sessions ? (
            <div className="space-y-6">
              {sessions.map((s) => (
                <section key={s.key}>
                  <SessionHeader session={s} />
                  <div className="space-y-1.5">{s.matches.map(renderMatch)}</div>
                </section>
              ))}
            </div>
          ) : (
            <div className="space-y-1.5">{matches.map(renderMatch)}</div>
          );
        })()}
      </div>

      {hasMore && <div ref={sentinelRef} className="h-1" />}
      {loading && matches.length > 0 && (
        <div className="label py-3 text-center text-[12px]">Loading…</div>
      )}

      {contextMenu && (
        <ContextMenu x={contextMenu.x} y={contextMenu.y} onClose={() => setContextMenu(null)}>
          <MenuItem onClick={() => handleToggleFavorite(contextMenu.match)}>
            <StarIcon
              className={`h-3.5 w-3.5 ${contextMenu.match.favorite ? "text-amber-400" : "text-lol-text"}`}
              fill={contextMenu.match.favorite ? "currentColor" : "none"}
            />
            {contextMenu.match.favorite ? "Remove from Favorites" : "Add to Favorites"}
          </MenuItem>
          <div className="my-1 h-px bg-lol-line" />
          <MenuItem
            onClick={() => {
              const gameId = contextMenu.match.game_id;
              setContextMenu(null);
              void exporting.run({ kind: "game", gameId }, "copy");
            }}
          >
            <CopyIcon className="h-3.5 w-3.5 text-lol-text" />
            Copy Image
          </MenuItem>
          <MenuItem
            onClick={() => {
              const gameId = contextMenu.match.game_id;
              setContextMenu(null);
              void exporting.run({ kind: "game", gameId }, "save");
            }}
          >
            <ImageIcon className="h-3.5 w-3.5 text-lol-text" />
            Export as PNG
          </MenuItem>
        </ContextMenu>
      )}

      <ExportImageMessage message={exporting.message} />
    </div>
  );
}

function MenuItem({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="mx-1 flex w-[calc(100%-0.5rem)] items-center gap-2.5 rounded-[3px] px-2.5 py-1.5 text-left text-[13px] font-medium text-lol-text-bright hover:bg-white/[0.06]"
    >
      {children}
    </button>
  );
}

// The identity half of the top row: who we are, how the record stands, and how
// the last handful of games went.
function ProfileCard({
  profile,
  dashboard,
}: {
  profile: { name: string | null; profileIcon: number | null } | null;
  dashboard: DashboardData;
}) {
  const losses = dashboard.totalGames - dashboard.wins;
  // Oldest on the left so the strip reads left-to-right in time
  const pips = dashboard.recentForm.slice().reverse();

  return (
    <div className="panel relative flex flex-col gap-4 overflow-hidden p-5">
      {/* A wash of gold behind the portrait, so the card reads as the lead */}
      <span className="pointer-events-none absolute -left-16 -top-24 h-64 w-64 rounded-full bg-lol-gold/[0.07] blur-3xl" />
      <span className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-lol-gold/80 via-lol-gold/30 to-transparent" />
      <div className="relative flex items-center gap-3.5">
        <div className="rounded-full bg-gradient-to-b from-lol-gold-light to-lol-gold/40 p-[2px]">
          <SummonerIcon
            iconId={profile?.profileIcon ?? null}
            size={48}
            className="border-2 border-lol-card"
          />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate font-display text-[22px] font-bold leading-tight text-lol-text-bright">
            {profile?.name ? <RiotId id={profile.name} /> : "Summoner"}
          </div>
          {/* The totals below pool every tracked account, so say when the name
              above only accounts for part of them */}
          <div className="truncate text-[12px] text-lol-text">
            {dashboard.totalGames.toLocaleString(LOCALE)}{" "}
            {dashboard.totalGames === 1 ? "game" : "games"}
            {dashboard.totalDuration > 0 && ` · ${formatPlaytime(dashboard.totalDuration)} played`}
            {dashboard.accounts > 1 && ` · ${dashboard.accounts} accounts`}
          </div>
        </div>
      </div>

      <div className="relative mt-auto">
        <div className="mb-2.5 flex items-end justify-between gap-3">
          <div className="font-num text-[32px] font-semibold leading-none">
            <span className="text-lol-win">{dashboard.wins.toLocaleString(LOCALE)}</span>
            <span className="ml-0.5 text-[18px] text-lol-win/70">W</span>
            <span className="ml-2.5 text-lol-loss/85">{losses.toLocaleString(LOCALE)}</span>
            <span className="ml-0.5 text-[18px] text-lol-loss/60">L</span>
          </div>
          <div className="text-right">
            <div className="label mb-1 text-[11px] text-lol-text/80">Last {pips.length}</div>
            <div
              className="flex items-end gap-[3px]"
              title={`Last ${pips.length} ${pips.length === 1 ? "game" : "games"}`}
            >
              {pips.map((g) => (
                <span
                  key={g.game_id}
                  className={`slant-sm h-4 w-[9px] ${g.win ? "bg-lol-win" : "bg-lol-loss/75"}`}
                />
              ))}
            </div>
          </div>
        </div>
        <WinRateBar wins={dashboard.wins} total={dashboard.totalGames} />
      </div>
    </div>
  );
}

function ContextMenu({
  x,
  y,
  onClose,
  children,
}: {
  x: number;
  y: number;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("click", onClose);
    window.addEventListener("contextmenu", onClose, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("click", onClose);
      window.removeEventListener("contextmenu", onClose, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  // Keep the menu inside the viewport
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.right > window.innerWidth) el.style.left = `${x - rect.width}px`;
    if (rect.bottom > window.innerHeight) el.style.top = `${y - rect.height}px`;
  }, [x, y]);

  return (
    <div ref={ref} style={{ left: x, top: y }} className="menu fixed z-50 min-w-52 py-1">
      {children}
    </div>
  );
}

// One play session's date and combined record, sitting above its rows. A
// session of nothing but remakes has no record to show, so only the count
// survives there.
function SessionHeader({ session }: { session: Session }) {
  const played = session.wins + session.losses;
  const ratio = session.deaths > 0 ? (session.kills + session.assists) / session.deaths : Infinity;

  return (
    <div className="mb-2.5 flex items-center gap-4 px-0.5">
      <span className="font-display text-[17px] font-bold uppercase italic tracking-[0.04em] text-lol-text-bright">
        {session.label}
      </span>
      <div className="flex items-center gap-3.5 text-[13px]">
        <span className="text-lol-text">
          {session.games} {session.games === 1 ? "game" : "games"}
        </span>
        {played > 0 && (
          <>
            <span className="font-num text-[14px] font-semibold">
              <span className="text-lol-win">{session.wins}W</span>{" "}
              <span className="text-lol-loss/85">{session.losses}L</span>
            </span>
            <span
              className={`font-num text-[14px] font-semibold ${kdaColor(ratio)}`}
              title={formatKDA(session.kills, session.deaths, session.assists)}
            >
              {kdaRatio(session.kills, session.deaths, session.assists)}
              <span className="ml-1 text-[11px] tracking-[0.08em] text-lol-text">KDA</span>
            </span>
            {session.avgScore != null && (
              <span
                className={`font-num text-[14px] font-semibold ${scoreColor(session.avgScore)}`}
              >
                {formatDecimal(session.avgScore)}
                <span className="ml-1 text-[11px] tracking-[0.08em] text-lol-text">SCORE</span>
              </span>
            )}
          </>
        )}
      </div>
      <span className="h-px flex-1 bg-gradient-to-r from-lol-border to-transparent" />
    </div>
  );
}

interface GameRowProps {
  match: MatchListItem;
  champData: ChampionData;
  expanded: boolean;
  detail: MatchDetail | null;
  detailLoading: boolean;
  puuids: string[] | null;
  onToggle: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}

function parseAugmentIds(raw: string | null): number[] {
  if (!raw) return [];
  return raw.split(",").map(Number).filter(Boolean);
}

function AugmentGrid({ augmentIds, patch }: { augmentIds: number[]; patch?: string | null }) {
  if (augmentIds.length === 0) return null;
  // Classic can grant bonus augments; spill past 4 into a third column so the
  // grid stays two rows tall and rows keep a uniform height.
  const cols = augmentIds.length > 4 ? "grid-cols-3" : "grid-cols-2";
  return (
    <div className={`grid ${cols} w-fit gap-[3px]`}>
      {augmentIds.map((id, i) => (
        <AugmentIcon key={i} augmentId={id} size={24} patch={patch} />
      ))}
    </div>
  );
}

function GameRow({
  match,
  champData,
  expanded,
  detail,
  detailLoading,
  puuids,
  onToggle,
  onContextMenu,
}: GameRowProps) {
  const isRemake = !!match.is_remake;
  const isWin = !!match.win;
  const isFavorite = !!match.favorite;
  const kda = kdaRatio(match.kills, match.deaths, match.assists);
  const augmentIds = parseAugmentIds(match.augment_ids);

  const edge = isRemake ? "bg-white/25" : isWin ? "bg-lol-win" : "bg-lol-loss";
  const tint = isRemake
    ? "from-white/[0.03]"
    : isWin
      ? "from-lol-win/[0.11]"
      : "from-lol-loss/[0.11]";
  const tag = isRemake
    ? "bg-white/10 text-lol-text"
    : isWin
      ? "bg-lol-win/15 text-lol-win"
      : "bg-lol-loss/15 text-lol-loss";

  return (
    <div
      className={`@container overflow-hidden rounded-md border transition-colors ${
        expanded ? "border-lol-border bg-lol-card" : "border-lol-line bg-lol-card/80"
      }`}
    >
      <button
        onClick={onToggle}
        onContextMenu={onContextMenu}
        aria-expanded={expanded}
        data-match-row
        className="group relative flex w-full items-center justify-between gap-4 py-2.5 pl-5 pr-4 text-left transition-colors hover:bg-white/[0.025] @max-[1080px]:gap-3"
      >
        <span className={`absolute inset-y-0 left-0 w-[3px] ${edge}`} />
        <span
          className={`pointer-events-none absolute inset-y-0 left-0 w-[45%] bg-gradient-to-r ${tint} to-transparent`}
        />

        {/* Result and when */}
        <div className="relative w-[68px] shrink-0">
          <div
            className={`slant-sm inline-block px-2 font-display text-[13px] font-extrabold italic leading-5 tracking-[0.08em] ${tag}`}
          >
            {isRemake ? "REMAKE" : isWin ? "VICTORY" : "DEFEAT"}
          </div>
          <div className="font-num mt-1 flex items-center gap-1 text-[13px] text-lol-text">
            {formatDuration(match.game_duration)}
            {isFavorite && (
              <StarIcon
                className="h-3 w-3 text-amber-400"
                fill="currentColor"
                aria-label="Favorite"
              />
            )}
          </div>
        </div>

        {/* Champion */}
        <div className="relative flex w-[176px] shrink-0 items-center gap-2.5">
          <ChampionIcon championId={match.champion_id} size={46} />
          {/* Two 22px spells and the 2px gap match the portrait's height */}
          <div className="flex shrink-0 flex-col gap-0.5">
            <SummonerSpellIcon spellId={match.spell1} size={22} />
            <SummonerSpellIcon spellId={match.spell2} size={22} />
          </div>
          <div className="min-w-0 truncate font-display text-[17px] font-semibold text-lol-text-bright">
            {getChampionName(champData, match.champion_id)}
          </div>
        </div>

        {/* KDA */}
        <div className="relative w-[104px] shrink-0">
          <div className="font-num text-[19px] font-semibold leading-tight text-lol-text-bright">
            <Kda kills={match.kills} deaths={match.deaths} assists={match.assists} />
          </div>
          <div
            className={`font-num text-[13px] font-semibold ${kdaHighlight(match.kills, match.deaths, match.assists)}`}
          >
            {kda} <span className="text-[11px] tracking-[0.08em]">KDA</span>
          </div>
        </div>

        {/* Score — a remake is scored by nothing, so it shows none */}
        <ScoreCell score={isRemake ? null : match.score} badge={match.score_badge} />

        {/* Stat bars */}
        <StatBars
          damage={match.total_damage_dealt}
          taken={match.total_damage_taken}
          heal={match.total_heal}
          max={{
            dmg: match.game_max_dmg,
            taken: match.game_max_taken,
            heal: match.game_max_heal,
          }}
          className="w-[180px] @max-[1080px]:w-[128px]"
        />

        {/* Augments – reserve 3 columns so mixed-queue lists stay aligned */}
        <div className="w-[78px] shrink-0">
          <AugmentGrid augmentIds={augmentIds} patch={match.game_version} />
        </div>

        {/* Items – 3x2 grid, no trinket (slot 6) */}
        <div className="grid shrink-0 grid-cols-3 gap-[3px]">
          {[match.item0, match.item1, match.item2, match.item3, match.item4, match.item5].map(
            (itemId, i) => (
              <ItemIcon key={i} itemId={itemId ?? 0} size={24} patch={match.game_version} />
            ),
          )}
        </div>

        {/* Initials, the same compact chips every table uses, each spelled out
            in its tooltip. A fixed width like every column here, so the row's
            spare room is shared between the columns instead of pooling. */}
        <div className="w-[104px] shrink-0 @max-[1080px]:w-[76px]">
          <MultikillBadge
            doubles={match.double_kills}
            triples={match.triple_kills}
            quadras={match.quadra_kills}
            pentas={match.penta_kills}
            compact
          />
        </div>
        <div className="w-[60px] shrink-0 text-right">
          <div
            className="w-fit ml-auto text-[13px] font-medium text-lol-text-bright/85"
            title={formatDateTime(match.game_creation)}
          >
            {formatTimeAgo(match.game_creation)}
          </div>
          <ChevronDownIcon
            className={`ml-auto mt-1 h-4 w-4 text-lol-text/80 transition-transform group-hover:text-lol-text-bright ${
              expanded ? "rotate-180 text-lol-gold" : ""
            }`}
          />
        </div>
      </button>

      {expanded && (
        <div className="overflow-x-auto border-t border-lol-line bg-black/20 p-4">
          {detailLoading ? (
            <div className="label py-6 text-center text-[12px]">Loading…</div>
          ) : detail ? (
            <MatchScoreboard detail={detail} champData={champData} puuids={puuids} />
          ) : null}
        </div>
      )}
    </div>
  );
}
