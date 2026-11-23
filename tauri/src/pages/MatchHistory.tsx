import { createEffect, createMemo, createSignal, For, onSettled, Show, untrack } from "solid-js";
import type { JSX } from "@solidjs/web";
import { useLocation } from "@solidjs/router";
import { useMatches } from "../hooks/useMatches";
import { useChampionData, getChampionName } from "../hooks/useChampions";
import { useIpc } from "../hooks/useIpc";
import { useLcuStatus } from "../hooks/useLcuStatus";
import { useBackfill } from "../hooks/useBackfill";
import { useViewState } from "../hooks/useViewState";
import { useExpandedMatch } from "../hooks/useExpandedMatch";
import { EMPTY_FILTER_OPTIONS } from "../hooks/useFilterOptions";
import { api } from "../lib/api-shim";
import { reportFirstContent } from "../lib/perf";
import type {
  MatchListItem,
  MatchDetail,
  ChampionData,
  DashboardData,
  MatchHistoryLink,
  MatchSession,
  MatchSort,
  MatchSortDir,
  MultikillType,
  LcuStatus,
  BackfillProgress,
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
} from "@shared/session";
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
  // Doubles as the list key and as what the database's totals are looked up by
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
  // as it was. Read once: the page is mounted afresh for every visit.
  const location = useLocation();
  const link = untrack(() => (location.state ?? null) as MatchHistoryLink | null);
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
  const activeFilters = () =>
    [championFilter(), seasonFilter(), patchFilter(), queueFilter(), accountFilter()].filter(
      (v) => v !== undefined,
    ).length +
    (multikillFilter().length > 0 ? 1 : 0) +
    (favoritesOnly() ? 1 : 0);
  // Back to every game, leaving the sort as it is
  const clearFilters = () => {
    setChampionFilter(undefined);
    setSeasonFilter(undefined);
    setPatchFilter(undefined);
    setQueueFilter(undefined);
    setAccountFilter(undefined);
    setMultikillFilter([]);
    setFavoritesOnly(false);
  };
  const { matches, loading, hasMore, loadMore, reload } = useMatches(() => ({
    championId: championFilter(),
    patch: patchFilter(),
    queue: queueFilter(),
    account: accountFilter(),
    season: seasonFilter(),
    sort: sort(),
    sortDir: sortDir(),
    multikills: multikillFilter(),
    favorites: favoritesOnly(),
  }));

  const toggleMultikill = (kind: MultikillType) => {
    setMultikillFilter((prev) =>
      prev.includes(kind) ? prev.filter((k) => k !== kind) : [...prev, kind],
    );
  };
  const champData = useChampionData();
  // Read once on mount, which is every time the page is opened: coming back
  // from Settings is what changes it.
  const { data: storedGrouping } = useIpc<string | null>(() =>
    api.getSetting(SESSION_GROUPING_SETTING),
  );
  const grouping = () => parseSessionGrouping(storedGrouping());
  const { data: dashboard, refetch: refetchDashboard } = useIpc(
    ([championId, patch, queue, account, season]) =>
      api.getDashboard({ championId, patch, queue, account, season }),
    () =>
      [championFilter(), patchFilter(), queueFilter(), accountFilter(), seasonFilter()] as const,
  );
  // The list arrives a page at a time, so the rows on screen describe the page
  // rather than the day. These cover every game the filters match.
  const { data: sessionTotals, refetch: refetchSessions } = useIpc<
    MatchSession[],
    readonly [
      number | undefined,
      string | undefined,
      number | undefined,
      string | undefined,
      string | undefined,
      MultikillType[],
      boolean,
    ]
  >(
    ([championId, patch, queue, account, season, multikills, favorites]) =>
      api.getMatchSessions({ championId, patch, queue, account, season, multikills, favorites }),
    () =>
      [
        championFilter(),
        patchFilter(),
        queueFilter(),
        accountFilter(),
        seasonFilter(),
        multikillFilter(),
        favoritesOnly(),
      ] as const,
  );

  // Null until the first answer. The effects below drop selections the data no
  // longer supports, and an empty stand-in would read as data supporting none.
  const { data: loadedOptions, refetch: refetchOptions } = useIpc(
    ([championId, patch, queue, account, season]) =>
      api.getMatchFilterOptions({ championId, patch, queue, account, season }),
    () =>
      [championFilter(), patchFilter(), queueFilter(), accountFilter(), seasonFilter()] as const,
  );
  const filterOptions = () => loadedOptions() ?? EMPTY_FILTER_OPTIONS;
  const [contextMenu, setContextMenu] = createSignal<{
    x: number;
    y: number;
    match: MatchListItem;
  } | null>(null);
  const { puuids, expandedId, detail, detailLoading, toggleExpand } = useExpandedMatch();
  // One instance for the page: both of the right-click menu's image items
  // report through the same message
  const exporting = useImageExport();
  const [profile, setProfile] = createSignal<{
    name: string | null;
    profileIcon: number | null;
  } | null>(null);
  const [sentinel, setSentinel] = createSignal<HTMLDivElement>();
  const lcuStatus = useLcuStatus();
  const backfill = useBackfill();

  // The name and icon can change under us as new games arrive
  onSettled(() => {
    const load = () => void api.getProfile().then(setProfile);
    load();
    return api.onGamesUpdated(load);
  });

  onSettled(() =>
    api.onGamesUpdated(() => {
      void refetchDashboard();
      void refetchSessions();
      void refetchOptions();
    }),
  );

  // Observed afresh whenever a page finishes loading: a sentinel still inside
  // the margin after the new rows land would otherwise never report again, and
  // the list would stop short of the end of a tall window.
  createEffect(
    () => ({ el: sentinel(), idle: !loading() }),
    ({ el, idle }) => {
      if (!el || !idle) return;
      const observer = new IntersectionObserver(
        ([entry]) => {
          if (entry.isIntersecting) loadMore();
        },
        { rootMargin: "200px" },
      );
      observer.observe(el);
      return () => observer.disconnect();
    },
  );

  createEffect(
    () => matches().length > 0,
    (any) => {
      if (any) reportFirstContent();
    },
  );

  // Clear a selection if new data leaves it without any matching games
  createEffect(
    () => ({
      options: loadedOptions(),
      champion: championFilter(),
      season: seasonFilter(),
      patch: patchFilter(),
      queue: queueFilter(),
      account: accountFilter(),
    }),
    ({ options, champion, season, patch, queue, account }) => {
      if (!options) return;
      if (champion !== undefined && !options.champions.includes(champion)) {
        setChampionFilter(undefined);
      }
      if (season !== undefined && !options.seasons.includes(season)) {
        setSeasonFilter(undefined);
      }
      if (patch !== undefined && !options.patches.includes(patch)) {
        setPatchFilter(undefined);
      }
      if (queue !== undefined && !options.queues.includes(queue)) {
        setQueueFilter(undefined);
      }
      if (account !== undefined && !options.accounts.some((a) => a.puuid === account)) {
        setAccountFilter(undefined);
      }
    },
  );

  // Unfavoriting the last game takes the toggle button away with it, so the
  // filter can't be left on with no way to turn it off.
  createEffect(
    () => loadedOptions()?.hasFavorites,
    (hasFavorites) => {
      if (hasFavorites === false) setFavoritesOnly(false);
    },
  );

  const championOptions = createMemo(() =>
    filterOptions()
      .champions.map((id) => ({ id, name: getChampionName(champData(), id) }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  );

  const handleToggleFavorite = async (match: MatchListItem) => {
    setContextMenu(null);
    await api.toggleFavorite(match.game_id);
    void reload();
    // With the favorites filter on, this changed which games are in the list
    void refetchSessions();
    // The first favorite reveals the toggle button, the last one hides it
    void refetchOptions();
  };

  const hasDashboard = () => (dashboard()?.totalGames ?? 0) > 0;
  // With one account selected, the profile card is about that account — not
  // whichever one played most recently.
  const profileShown = () => {
    const account = accountFilter();
    const selected = account
      ? filterOptions().accounts.find((a) => a.puuid === account)
      : undefined;
    return selected ? { name: selected.name, profileIcon: selected.profileIcon } : profile();
  };

  // Session headers only make sense when the list reads in time order; any
  // other sort interleaves sessions, so those render flat.
  const isDateSort = () => !sort() || sort() === "date";
  const withTotals = (grouped: Session[]): Session[] => {
    const totals = sessionTotals();
    if (!totals) return grouped;

    // The rows stay as they are; only the header totals come from the database,
    // so a session that is half-loaded still reports all of itself.
    const byKey = new Map(totals.map((total) => [total.key, total]));
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
  };
  const sessions = createMemo<Session[] | null>(() => {
    const mode = grouping();
    return !isDateSort() || mode === "none" ? null : withTotals(groupIntoSessions(matches(), mode));
  });

  const renderMatch = (m: () => MatchListItem) => (
    <GameRow
      match={m()}
      champData={champData()}
      expanded={expandedId() === m().game_id}
      detail={expandedId() === m().game_id ? detail() : null}
      detailLoading={expandedId() === m().game_id && detailLoading()}
      puuids={puuids()}
      onToggle={() => void toggleExpand(m().game_id)}
      onContextMenu={(e) => {
        e.preventDefault();
        setContextMenu({ x: e.clientX, y: e.clientY, match: m() });
      }}
    />
  );

  const actions = (
    <>
      <FilterMenu active={activeFilters()} onReset={clearFilters}>
        {/* A single-account database doesn't need an account dropdown */}
        <Show when={filterOptions().accounts.length > 1 || accountFilter() !== undefined}>
          <FilterField label="Account">
            <select
              value={accountFilter() ?? ""}
              onChange={(e) =>
                setAccountFilter(e.currentTarget.value === "" ? undefined : e.currentTarget.value)
              }
              class="select w-full"
            >
              <option value="" selected={accountFilter() === undefined}>
                All Accounts
              </option>
              <For each={filterOptions().accounts}>
                {(a) => (
                  <option value={a.puuid} selected={accountFilter() === a.puuid}>
                    {a.name ?? "Unknown account"}
                  </option>
                )}
              </For>
            </select>
          </FilterField>
        </Show>
        <FilterField label="Champion">
          <select
            value={championFilter() ?? ""}
            onChange={(e) =>
              setChampionFilter(
                e.currentTarget.value === "" ? undefined : Number(e.currentTarget.value),
              )
            }
            class="select w-full"
          >
            <option value="" selected={championFilter() === undefined}>
              All Champions
            </option>
            <For each={championOptions()}>
              {({ id, name }) => (
                <option value={id} selected={championFilter() === id}>
                  {name}
                </option>
              )}
            </For>
          </select>
        </FilterField>
        <FilterField label="Set">
          <select
            value={seasonFilter() ?? ""}
            onChange={(e) =>
              setSeasonFilter(e.currentTarget.value === "" ? undefined : e.currentTarget.value)
            }
            class="select w-full"
          >
            <option value="" selected={seasonFilter() === undefined}>
              All Sets
            </option>
            <For each={filterOptions().seasons}>
              {(s) => (
                <option value={s} selected={seasonFilter() === s}>
                  {seasonName(s)}
                </option>
              )}
            </For>
          </select>
        </FilterField>
        <FilterField label="Patch">
          <select
            value={patchFilter() ?? ""}
            onChange={(e) =>
              setPatchFilter(e.currentTarget.value === "" ? undefined : e.currentTarget.value)
            }
            class="select w-full"
          >
            <option value="" selected={patchFilter() === undefined}>
              All Patches
            </option>
            <For each={filterOptions().patches}>
              {(p) => (
                <option value={p} selected={patchFilter() === p}>
                  Patch {formatPatch(p)}
                </option>
              )}
            </For>
          </select>
        </FilterField>
        <Show when={filterOptions().queues.length > 1 || queueFilter() !== undefined}>
          <FilterField label="Queue">
            <select
              value={queueFilter() ?? ""}
              onChange={(e) =>
                setQueueFilter(
                  e.currentTarget.value === "" ? undefined : Number(e.currentTarget.value),
                )
              }
              class="select w-full"
            >
              <option value="" selected={queueFilter() === undefined}>
                All Queues
              </option>
              <For each={filterOptions().queues}>
                {(q) => (
                  <option value={q} selected={queueFilter() === q}>
                    {queueLabel(q)}
                  </option>
                )}
              </For>
            </select>
          </FilterField>
        </Show>
        <FilterField label="Multikills">
          <div class="grid grid-cols-4 gap-1">
            <For each={MULTIKILL_KINDS}>
              {({ kind, name, color }) => (
                <button
                  onClick={() => toggleMultikill(kind)}
                  title={`Only show games with a ${name} kill`}
                  class={[
                    "font-display rounded-[3px] border py-1 text-[12px] font-bold uppercase tracking-[0.06em] transition-colors",
                    color,
                    multikillFilter().includes(kind)
                      ? "border-lol-gold/60 bg-lol-gold/10"
                      : "border-lol-border hover:border-lol-gold/50",
                  ]}
                >
                  {name}
                </button>
              )}
            </For>
          </div>
        </FilterField>
        <Show when={filterOptions().hasFavorites}>
          <button
            onClick={() => setFavoritesOnly((v) => !v)}
            class={["btn btn-sm w-full justify-start", { "btn-active": favoritesOnly() }]}
          >
            <StarIcon
              class={["h-3.5 w-3.5", { "text-amber-400": favoritesOnly() }]}
              fill={favoritesOnly() ? "currentColor" : "none"}
            />
            Favorites only
          </button>
        </Show>
      </FilterMenu>
      <div class="flex items-center">
        <select
          value={sort() ?? ""}
          onChange={(e) => {
            const picked = e.currentTarget.value;
            setSort(picked === "" ? undefined : (picked as MatchSort));
            setSortDir("desc");
          }}
          class="select relative rounded-r-none hover:z-10 focus:z-10"
          aria-label="Sort by"
        >
          <option value="" selected={!sort()}>
            Newest
          </option>
          <For each={SORT_OPTIONS}>
            {({ value, label }) => (
              <option value={value} selected={sort() === value}>
                {label}
              </option>
            )}
          </For>
        </select>
        <button
          onClick={() => setSortDir((d) => (d === "desc" ? "asc" : "desc"))}
          title={
            !sort() || sort() === "date"
              ? sortDir() === "desc"
                ? "Newest first"
                : "Oldest first"
              : sortDir() === "desc"
                ? "Highest first"
                : "Lowest first"
          }
          class="btn btn-icon relative -ml-px rounded-l-none hover:z-10 focus-visible:z-10"
        >
          <ArrowDownIcon
            class={["h-3.5 w-3.5 transition-transform", { "rotate-180": sortDir() === "asc" }]}
          />
        </button>
      </div>
    </>
  );

  return (
    <div class="max-w-[1320px] space-y-6">
      <PageHeader
        kicker="Play"
        title="Match History"
        subtitle={
          <Show
            when={hasDashboard() ? dashboard() : null}
            fallback="Every ARAM Mayhem game you play, recorded automatically"
          >
            {(d) => (
              <>
                <span class="font-num text-[14px] text-lol-text-bright">
                  {d().totalGames.toLocaleString(LOCALE)}
                </span>{" "}
                {d().totalGames === 1 ? "game" : "games"} recorded
                <Show when={d().totalDuration > 0}>
                  {" · "}
                  <span class="font-num text-[14px] text-lol-text-bright">
                    {formatPlaytime(d().totalDuration)}
                  </span>{" "}
                  played
                </Show>
              </>
            )}
          </Show>
        }
        actions={actions}
        class="pb-0"
      />

      {/* Stat Cards */}
      <Show when={hasDashboard() ? dashboard() : null}>
        {(d) => (
          <DashboardCards
            dashboard={d()}
            profile={profileShown()}
            multikillFilter={multikillFilter()}
            onToggleMultikill={toggleMultikill}
          />
        )}
      </Show>

      <div>
        <Show when={matches().length === 0 && !loading()}>
          <div class="panel flex flex-col items-center gap-3 px-8 py-14 text-center">
            <SwordsIcon class="h-8 w-8 text-lol-gold/60" />
            <div class="max-w-md text-[14px] text-lol-text">
              <Show
                when={activeFilters() > 0}
                fallback={emptyStateMessage(lcuStatus(), {
                  running: backfill.running(),
                  progress: backfill.progress(),
                })}
              >
                No games match the current filters.{" "}
                <button onClick={clearFilters} class="font-semibold text-lol-gold hover:underline">
                  Clear filters
                </button>
              </Show>
            </div>
          </div>
        </Show>

        <Show
          when={sessions()}
          fallback={
            <div class="space-y-1.5">
              <For each={matches()} keyed={(m) => m.game_id}>
                {renderMatch}
              </For>
            </div>
          }
        >
          {(grouped) => (
            <div class="space-y-6">
              <For each={grouped()} keyed={(s) => s.key}>
                {(s) => (
                  <section>
                    <SessionHeader session={s()} />
                    <div class="space-y-1.5">
                      <For each={s().matches} keyed={(m) => m.game_id}>
                        {renderMatch}
                      </For>
                    </div>
                  </section>
                )}
              </For>
            </div>
          )}
        </Show>
      </div>

      <Show when={hasMore()}>
        <div ref={setSentinel} class="h-1" />
      </Show>
      <Show when={loading() && matches().length > 0}>
        <div class="label py-3 text-center text-[12px]">Loading…</div>
      </Show>

      <Show when={contextMenu()}>
        {(menu) => (
          <ContextMenu x={menu().x} y={menu().y} onClose={() => setContextMenu(null)}>
            <MenuItem onClick={() => void handleToggleFavorite(menu().match)}>
              <StarIcon
                class={["h-3.5 w-3.5", menu().match.favorite ? "text-amber-400" : "text-lol-text"]}
                fill={menu().match.favorite ? "currentColor" : "none"}
              />
              {menu().match.favorite ? "Remove from Favorites" : "Add to Favorites"}
            </MenuItem>
            <div class="my-1 h-px bg-lol-line" />
            <MenuItem
              onClick={() => {
                const gameId = menu().match.game_id;
                setContextMenu(null);
                void exporting.run({ kind: "game", gameId }, "copy");
              }}
            >
              <CopyIcon class="h-3.5 w-3.5 text-lol-text" />
              Copy Image
            </MenuItem>
            <MenuItem
              onClick={() => {
                const gameId = menu().match.game_id;
                setContextMenu(null);
                void exporting.run({ kind: "game", gameId }, "save");
              }}
            >
              <ImageIcon class="h-3.5 w-3.5 text-lol-text" />
              Export as PNG
            </MenuItem>
          </ContextMenu>
        )}
      </Show>

      <ExportImageMessage message={exporting.message()} />
    </div>
  );
}

function MenuItem(props: { onClick: () => void; children: JSX.Element }) {
  return (
    <button
      onClick={() => props.onClick()}
      class="mx-1 flex w-[calc(100%-0.5rem)] items-center gap-2.5 rounded-[3px] px-2.5 py-1.5 text-left text-[13px] font-medium text-lol-text-bright hover:bg-white/[0.06]"
    >
      {props.children}
    </button>
  );
}

// The four stat cards above the list: who we are and how the record stands,
// then the averages and the multikill counts, which double as filters.
function DashboardCards(props: {
  dashboard: DashboardData;
  profile: { name: string | null; profileIcon: number | null } | null;
  multikillFilter: MultikillType[];
  onToggleMultikill: (kind: MultikillType) => void;
}) {
  const perGame = (total: number) =>
    props.dashboard.totalGames > 0 ? formatDecimal(total / props.dashboard.totalGames) : "0";
  const kdaValue = () =>
    props.dashboard.totalDeaths > 0
      ? (props.dashboard.totalKills + props.dashboard.totalAssists) / props.dashboard.totalDeaths
      : Infinity;
  const totalMultikills = () =>
    props.dashboard.multikills.doubles +
    props.dashboard.multikills.triples +
    props.dashboard.multikills.quadras +
    props.dashboard.multikills.pentas;

  return (
    <div class="grid grid-cols-[minmax(0,1.45fr)_repeat(3,minmax(0,1fr))] items-stretch gap-4">
      <ProfileCard profile={props.profile} dashboard={props.dashboard} />

      <StatCard
        label="Avg Score"
        accent="gold"
        icon={<StarIcon class="h-3.5 w-3.5" />}
        value={
          <Show when={props.dashboard.avgScore} fallback="—">
            {(score) => (
              <span class={scoreColor(score())}>
                {formatDecimal(score())}
                <span class="text-[17px] font-medium text-lol-text/60"> / 10</span>
              </span>
            )}
          </Show>
        }
        subtext={
          <>
            <ScoreMeter score={props.dashboard.avgScore} />
            {/* The ramp every score in the app is coloured by: ticks on the
                0–10 track where the colour changes, and what each step means */}
            <div class="relative -mt-1.5 h-1.5">
              <For each={[5, 7, 9]}>
                {(at) => (
                  <span
                    class="absolute top-0 h-1.5 w-px bg-lol-dark"
                    style={{ left: `${at * 10}%` }}
                  />
                )}
              </For>
            </div>
            <div class="mt-2 flex flex-wrap gap-x-2.5 text-[12px]">
              <For
                each={
                  [
                    ["5+", "solid", "text-lol-text-bright"],
                    ["7+", "great", "text-sky-400"],
                    ["9+", "elite", "text-amber-400"],
                  ] as const
                }
              >
                {([at, word, color]) => (
                  <span class={color}>
                    <span class="font-num font-semibold">{at}</span> {word}
                  </span>
                )}
              </For>
            </div>
          </>
        }
      >
        <BadgeCounts
          mvps={props.dashboard.mvps}
          aces={props.dashboard.aces}
          scoredWins={props.dashboard.scoredWins}
          scoredLosses={props.dashboard.scoredLosses}
        />
      </StatCard>

      <StatCard
        label="Avg KDA"
        accent="sky"
        icon={<SwordsIcon class="h-3.5 w-3.5" />}
        value={
          /* Three numbers where the other cards show one — a notch smaller
             keeps it on one line in the narrowest column */
          <span class="text-[26px]">
            <Kda
              kills={perGame(props.dashboard.totalKills)}
              deaths={perGame(props.dashboard.totalDeaths)}
              assists={perGame(props.dashboard.totalAssists)}
            />
          </span>
        }
        subtext={
          <span class={["font-num text-[15px] font-semibold", kdaColor(kdaValue())]}>
            {kdaRatio(
              props.dashboard.totalKills,
              props.dashboard.totalDeaths,
              props.dashboard.totalAssists,
            )}{" "}
            <span class="text-[12px] tracking-[0.08em]">KDA</span>
          </span>
        }
      >
        {/* Career totals as tiles, built like the multikill card's beside it */}
        <div class="grid grid-cols-3 gap-1">
          <For
            each={
              [
                ["Kills", props.dashboard.totalKills],
                ["Deaths", props.dashboard.totalDeaths],
                ["Assists", props.dashboard.totalAssists],
              ] as const
            }
            keyed={false}
          >
            {(tile) => (
              <div class="rounded-[3px] border border-lol-line bg-black/15 px-1 py-1 text-center">
                <div class="font-num text-[16px] font-semibold leading-tight text-lol-text-bright">
                  {tile()[1].toLocaleString(LOCALE)}
                </div>
                <div class="label text-[11px] leading-3 text-lol-text">{tile()[0]}</div>
              </div>
            )}
          </For>
        </div>
      </StatCard>

      <StatCard
        label="Multikills"
        accent="purple"
        icon={<ZapIcon class="h-3.5 w-3.5" />}
        value={totalMultikills().toLocaleString(LOCALE)}
        subtext={
          <>
            <span class="font-num text-[14px] text-lol-text-bright">
              {formatDecimal(totalMultikills() / props.dashboard.totalGames)}
            </span>{" "}
            per game
          </>
        }
      >
        <div class="grid grid-cols-4 gap-1">
          <For each={MULTIKILL_KINDS}>
            {({ kind, label, name, color }) => (
              <button
                onClick={() => props.onToggleMultikill(kind)}
                title={`Only show games with a ${name} kill`}
                class={[
                  "rounded-[3px] border px-1 py-1 text-center transition-colors",
                  props.multikillFilter.includes(kind)
                    ? "border-lol-gold/60 bg-lol-gold/10"
                    : "border-lol-line bg-black/15 hover:border-lol-border hover:bg-white/5",
                ]}
              >
                <div class={["font-num text-[17px] font-bold leading-tight", color]}>
                  {props.dashboard.multikills[kind].toLocaleString(LOCALE)}
                </div>
                <div class="label text-[11px] leading-3 text-lol-text">{label}</div>
              </button>
            )}
          </For>
        </div>
      </StatCard>
    </div>
  );
}

// The identity half of the top row: who we are, how the record stands, and how
// the last handful of games went.
function ProfileCard(props: {
  profile: { name: string | null; profileIcon: number | null } | null;
  dashboard: DashboardData;
}) {
  const losses = () => props.dashboard.totalGames - props.dashboard.wins;
  // Oldest on the left so the strip reads left-to-right in time
  const pips = () => props.dashboard.recentForm.slice().reverse();

  return (
    <div class="panel relative flex flex-col gap-4 overflow-hidden p-5">
      {/* A wash of gold behind the portrait, so the card reads as the lead */}
      <span class="pointer-events-none absolute -left-16 -top-24 h-64 w-64 rounded-full bg-lol-gold/[0.07] blur-3xl" />
      <span class="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-lol-gold/80 via-lol-gold/30 to-transparent" />
      <div class="relative flex items-center gap-3.5">
        <div class="rounded-full bg-gradient-to-b from-lol-gold-light to-lol-gold/40 p-[2px]">
          <SummonerIcon
            iconId={props.profile?.profileIcon ?? null}
            size={48}
            class="border-2 border-lol-card"
          />
        </div>
        <div class="min-w-0 flex-1">
          <div class="truncate font-display text-[22px] font-bold leading-tight text-lol-text-bright">
            <Show when={props.profile?.name} fallback="Summoner">
              {(name) => <RiotId id={name()} />}
            </Show>
          </div>
          {/* The totals below pool every tracked account, so say when the name
              above only accounts for part of them */}
          <div class="truncate text-[12px] text-lol-text">
            {props.dashboard.totalGames.toLocaleString(LOCALE)}{" "}
            {props.dashboard.totalGames === 1 ? "game" : "games"}
            {props.dashboard.totalDuration > 0 &&
              ` · ${formatPlaytime(props.dashboard.totalDuration)} played`}
            {props.dashboard.accounts > 1 && ` · ${props.dashboard.accounts} accounts`}
          </div>
        </div>
      </div>

      <div class="relative mt-auto">
        <div class="mb-2.5 flex items-end justify-between gap-3">
          <div class="font-num text-[32px] font-semibold leading-none">
            <span class="text-lol-win">{props.dashboard.wins.toLocaleString(LOCALE)}</span>
            <span class="ml-0.5 text-[18px] text-lol-win/70">W</span>
            <span class="ml-2.5 text-lol-loss/85">{losses().toLocaleString(LOCALE)}</span>
            <span class="ml-0.5 text-[18px] text-lol-loss/60">L</span>
          </div>
          <div class="text-right">
            <div class="label mb-1 text-[11px] text-lol-text/80">Last {pips().length}</div>
            <div
              class="flex items-end gap-[3px]"
              title={`Last ${pips().length} ${pips().length === 1 ? "game" : "games"}`}
            >
              <For each={pips()}>
                {(g) => (
                  <span class={["slant-sm h-4 w-[9px]", g.win ? "bg-lol-win" : "bg-lol-loss/75"]} />
                )}
              </For>
            </div>
          </div>
        </div>
        <WinRateBar wins={props.dashboard.wins} total={props.dashboard.totalGames} />
      </div>
    </div>
  );
}

function ContextMenu(props: { x: number; y: number; onClose: () => void; children: JSX.Element }) {
  let el: HTMLDivElement | undefined;

  onSettled(() => {
    const close = () => props.onClose();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", close);
    };
  });

  // Keep the menu inside the viewport
  createEffect(
    () => ({ x: props.x, y: props.y }),
    ({ x, y }) => {
      if (!el) return;
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
      const rect = el.getBoundingClientRect();
      if (rect.right > window.innerWidth) el.style.left = `${x - rect.width}px`;
      if (rect.bottom > window.innerHeight) el.style.top = `${y - rect.height}px`;
    },
  );

  return (
    <div ref={(node) => (el = node)} class="menu fixed z-50 min-w-52 py-1">
      {props.children}
    </div>
  );
}

// One play session's date and combined record, sitting above its rows. A
// session of nothing but remakes has no record to show, so only the count
// survives there.
function SessionHeader(props: { session: Session }) {
  const played = () => props.session.wins + props.session.losses;
  const ratio = () =>
    props.session.deaths > 0
      ? (props.session.kills + props.session.assists) / props.session.deaths
      : Infinity;

  return (
    <div class="mb-2.5 flex items-center gap-4 px-0.5">
      <span class="font-display text-[17px] font-bold uppercase italic tracking-[0.04em] text-lol-text-bright">
        {props.session.label}
      </span>
      <div class="flex items-center gap-3.5 text-[13px]">
        <span class="text-lol-text">
          {props.session.games} {props.session.games === 1 ? "game" : "games"}
        </span>
        <Show when={played() > 0}>
          <span class="font-num text-[14px] font-semibold">
            <span class="text-lol-win">{props.session.wins}W</span>{" "}
            <span class="text-lol-loss/85">{props.session.losses}L</span>
          </span>
          <span
            class={["font-num text-[14px] font-semibold", kdaColor(ratio())]}
            title={formatKDA(props.session.kills, props.session.deaths, props.session.assists)}
          >
            {kdaRatio(props.session.kills, props.session.deaths, props.session.assists)}
            <span class="ml-1 text-[11px] tracking-[0.08em] text-lol-text">KDA</span>
          </span>
          <Show when={props.session.avgScore}>
            {(score) => (
              <span class={["font-num text-[14px] font-semibold", scoreColor(score())]}>
                {formatDecimal(score())}
                <span class="ml-1 text-[11px] tracking-[0.08em] text-lol-text">SCORE</span>
              </span>
            )}
          </Show>
        </Show>
      </div>
      <span class="h-px flex-1 bg-gradient-to-r from-lol-border to-transparent" />
    </div>
  );
}

function parseAugmentIds(raw: string | null): number[] {
  if (!raw) return [];
  return raw.split(",").map(Number).filter(Boolean);
}

function AugmentGrid(props: { augmentIds: number[]; patch?: string | null }) {
  return (
    <Show when={props.augmentIds.length > 0}>
      {/* Classic can grant bonus augments; spill past 4 into a third column so the
          grid stays two rows tall and rows keep a uniform height. */}
      <div
        class={[
          "grid w-fit gap-[3px]",
          props.augmentIds.length > 4 ? "grid-cols-3" : "grid-cols-2",
        ]}
      >
        <For each={props.augmentIds} keyed={false}>
          {(id) => <AugmentIcon augmentId={id()} size={24} patch={props.patch} />}
        </For>
      </div>
    </Show>
  );
}

function GameRow(props: {
  match: MatchListItem;
  champData: ChampionData;
  expanded: boolean;
  detail: MatchDetail | null;
  detailLoading: boolean;
  puuids: string[] | null;
  onToggle: () => void;
  onContextMenu: (e: MouseEvent) => void;
}) {
  const isRemake = () => !!props.match.is_remake;
  const isWin = () => !!props.match.win;
  const kda = () => kdaRatio(props.match.kills, props.match.deaths, props.match.assists);
  const augmentIds = createMemo(() => parseAugmentIds(props.match.augment_ids));
  const itemIds = () => [
    props.match.item0,
    props.match.item1,
    props.match.item2,
    props.match.item3,
    props.match.item4,
    props.match.item5,
  ];

  const edge = () => (isRemake() ? "bg-white/25" : isWin() ? "bg-lol-win" : "bg-lol-loss");
  const tint = () =>
    isRemake() ? "from-white/[0.03]" : isWin() ? "from-lol-win/[0.11]" : "from-lol-loss/[0.11]";
  const tag = () =>
    isRemake()
      ? "bg-white/10 text-lol-text"
      : isWin()
        ? "bg-lol-win/15 text-lol-win"
        : "bg-lol-loss/15 text-lol-loss";

  return (
    <div
      class={[
        "@container overflow-hidden rounded-md border transition-colors",
        props.expanded ? "border-lol-border bg-lol-card" : "border-lol-line bg-lol-card/80",
      ]}
    >
      <button
        onClick={() => props.onToggle()}
        onContextMenu={(e) => props.onContextMenu(e)}
        aria-expanded={props.expanded ? "true" : "false"}
        data-match-row
        class="group relative flex w-full items-center justify-between gap-4 py-2.5 pl-5 pr-4 text-left transition-colors hover:bg-white/[0.025] @max-[1080px]:gap-3"
      >
        <span class={["absolute inset-y-0 left-0 w-[3px]", edge()]} />
        <span
          class={[
            "pointer-events-none absolute inset-y-0 left-0 w-[45%] bg-gradient-to-r to-transparent",
            tint(),
          ]}
        />

        {/* Result and when */}
        <div class="relative w-[68px] shrink-0">
          <div
            class={[
              "slant-sm inline-block px-2 font-display text-[13px] font-extrabold italic leading-5 tracking-[0.08em]",
              tag(),
            ]}
          >
            {isRemake() ? "REMAKE" : isWin() ? "VICTORY" : "DEFEAT"}
          </div>
          <div class="font-num mt-1 flex items-center gap-1 text-[13px] text-lol-text">
            {formatDuration(props.match.game_duration)}
            <Show when={props.match.favorite}>
              <StarIcon class="h-3 w-3 text-amber-400" fill="currentColor" aria-label="Favorite" />
            </Show>
          </div>
        </div>

        {/* Champion */}
        <div class="relative flex w-[176px] shrink-0 items-center gap-2.5">
          <ChampionIcon championId={props.match.champion_id} size={46} />
          {/* Two 22px spells and the 2px gap match the portrait's height */}
          <div class="flex shrink-0 flex-col gap-0.5">
            <SummonerSpellIcon spellId={props.match.spell1} size={22} />
            <SummonerSpellIcon spellId={props.match.spell2} size={22} />
          </div>
          <div class="min-w-0 truncate font-display text-[17px] font-semibold text-lol-text-bright">
            {getChampionName(props.champData, props.match.champion_id)}
          </div>
        </div>

        {/* KDA */}
        <div class="relative w-[104px] shrink-0">
          <div class="font-num text-[19px] font-semibold leading-tight text-lol-text-bright">
            <Kda
              kills={props.match.kills}
              deaths={props.match.deaths}
              assists={props.match.assists}
            />
          </div>
          <div
            class={[
              "font-num text-[13px] font-semibold",
              kdaHighlight(props.match.kills, props.match.deaths, props.match.assists),
            ]}
          >
            {kda()} <span class="text-[11px] tracking-[0.08em]">KDA</span>
          </div>
        </div>

        {/* Score — a remake is scored by nothing, so it shows none */}
        <ScoreCell score={isRemake() ? null : props.match.score} badge={props.match.score_badge} />

        {/* Stat bars */}
        <StatBars
          damage={props.match.total_damage_dealt}
          taken={props.match.total_damage_taken}
          heal={props.match.total_heal}
          max={{
            dmg: props.match.game_max_dmg,
            taken: props.match.game_max_taken,
            heal: props.match.game_max_heal,
          }}
          class="w-[180px] @max-[1080px]:w-[128px]"
        />

        {/* Augments – reserve 3 columns so mixed-queue lists stay aligned */}
        <div class="w-[78px] shrink-0">
          <AugmentGrid augmentIds={augmentIds()} patch={props.match.game_version} />
        </div>

        {/* Items – 3x2 grid, no trinket (slot 6) */}
        <div class="grid shrink-0 grid-cols-3 gap-[3px]">
          <For each={itemIds()} keyed={false}>
            {(itemId) => (
              <ItemIcon itemId={itemId() ?? 0} size={24} patch={props.match.game_version} />
            )}
          </For>
        </div>

        {/* Initials, the same compact chips every table uses, each spelled out
            in its tooltip. A fixed width like every column here, so the row's
            spare room is shared between the columns instead of pooling. */}
        <div class="w-[104px] shrink-0 @max-[1080px]:w-[76px]">
          <MultikillBadge
            doubles={props.match.double_kills}
            triples={props.match.triple_kills}
            quadras={props.match.quadra_kills}
            pentas={props.match.penta_kills}
            compact
          />
        </div>
        <div class="w-[60px] shrink-0 text-right">
          <div
            class="w-fit ml-auto text-[13px] font-medium text-lol-text-bright/85"
            title={formatDateTime(props.match.game_creation)}
          >
            {formatTimeAgo(props.match.game_creation)}
          </div>
          <ChevronDownIcon
            class={[
              "ml-auto mt-1 h-4 w-4 text-lol-text/80 transition-transform group-hover:text-lol-text-bright",
              { "rotate-180 text-lol-gold": props.expanded },
            ]}
          />
        </div>
      </button>

      <Show when={props.expanded}>
        <div class="overflow-x-auto border-t border-lol-line bg-black/20 p-4">
          <Show
            when={!props.detailLoading}
            fallback={<div class="label py-6 text-center text-[12px]">Loading…</div>}
          >
            <Show when={props.detail}>
              {(detail) => (
                <MatchScoreboard
                  detail={detail()}
                  champData={props.champData}
                  puuids={props.puuids}
                />
              )}
            </Show>
          </Show>
        </div>
      </Show>
    </div>
  );
}
