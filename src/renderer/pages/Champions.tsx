import { useState, useMemo, useEffect, Fragment, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useIpc } from "../hooks/useIpc";
import { useViewState } from "../hooks/useViewState";
import { useSort } from "../hooks/useSort";
import {
  useChampionData,
  getChampionName,
  useAugmentData,
  useItemData,
} from "../hooks/useChampions";
import type {
  ChampionStats,
  AugmentStats,
  ItemStats,
  MatchListItem,
  MatchHistoryLink,
} from "../lib/types";
import ChampionIcon from "../components/ChampionIcon";
import AugmentIcon from "../components/AugmentIcon";
import ItemIcon from "../components/ItemIcon";
import WinRateBar from "../components/WinRateBar";
import PatchSelect from "../components/PatchSelect";
import QueueSelect from "../components/QueueSelect";
import SortHeader, { CycleSortHeader } from "../components/SortHeader";
import FilterMenu from "../components/FilterMenu";
import MinGamesFilter from "../components/MinGamesFilter";
import SeasonSelect from "../components/SeasonSelect";
import PageHeader from "../components/PageHeader";
import { ChevronRightIcon, TrophyIcon } from "../components/icons";
import {
  LOCALE,
  formatCompact,
  formatDecimal,
  formatDuration,
  formatTimeAgo,
  kdaRatio,
  kdaColor,
  scoreColor,
} from "../lib/format";
import { matchesSearch } from "../lib/search";
import Kda from "../components/Kda";
import SearchInput from "../components/SearchInput";

type SortKey =
  | "games"
  | "wins"
  | "avg_kills"
  | "avg_deaths"
  | "avg_assists"
  | "kda"
  | "avg_score"
  | "badges"
  | "mvps"
  | "aces"
  | "avg_damage"
  | "avg_gold"
  | "multikills"
  | "double_kills"
  | "triple_kills"
  | "quadra_kills"
  | "penta_kills";

// The badge, multikill and K/D/A columns sort by their headline figure first,
// then by each part on its own
const BADGE_STEPS: { field: SortKey; label: string }[] = [
  { field: "badges", label: "MVP / ACE" },
  { field: "mvps", label: "MVP" },
  { field: "aces", label: "ACE" },
];
const MULTIKILL_STEPS: { field: SortKey; label: string }[] = [
  { field: "multikills", label: "Multikills" },
  { field: "double_kills", label: "Doubles" },
  { field: "triple_kills", label: "Triples" },
  { field: "quadra_kills", label: "Quadras" },
  { field: "penta_kills", label: "Pentas" },
];
// The averages share one cell with the ratio under them, the way a game row
// shows them, so one header steps through all four
const KDA_STEPS: { field: SortKey; label: string }[] = [
  { field: "kda", label: "KDA" },
  { field: "avg_kills", label: "Avg Kills" },
  { field: "avg_deaths", label: "Avg Deaths" },
  { field: "avg_assists", label: "Avg Assists" },
];

// The multikill slots, in MultikillBadge's compact look, hues and rule: the
// letter alone for one, the letter and count for more. Each kind keeps its own
// slot, empty or not, so the counts line up down the table.
const MULTIKILL_SLOTS = [
  {
    key: "double_kills",
    letter: "D",
    name: "Double",
    tone: "bg-sky-400/14 text-sky-400 ring-sky-400/25",
  },
  {
    key: "triple_kills",
    letter: "T",
    name: "Triple",
    tone: "bg-amber-400/14 text-amber-400 ring-amber-400/25",
  },
  {
    key: "quadra_kills",
    letter: "Q",
    name: "Quadra",
    tone: "bg-purple-400/14 text-purple-400 ring-purple-400/25",
  },
  {
    key: "penta_kills",
    letter: "P",
    name: "Penta",
    tone: "bg-red-400/16 text-red-400 ring-red-400/35",
  },
] as const;

// One side of the MVP / ACE pair: its badge colour when earned, the same dim
// as the separator's neighbours when not, whichever side it is
function BadgeCount({ count, tone }: { count: number; tone: string }) {
  return (
    <span className={count > 0 ? tone : "text-lol-text/45"}>{count.toLocaleString(LOCALE)}</span>
  );
}

// Table columns, for the expanded row's colSpan
const COLUMN_COUNT = 10;

// One of the three lists in an expanded row: a labelled block on the darker
// floor the row opens onto
function DetailBlock({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="min-w-0 rounded-lg border border-lol-line bg-white/[0.018]">
      <div className="flex h-9 items-center justify-between border-b border-lol-line px-3">
        <h3 className="label">{title}</h3>
        {aside}
      </div>
      <div className="space-y-0.5 p-1.5">{children}</div>
    </section>
  );
}

function EmptyLine({ children }: { children: ReactNode }) {
  return <div className="px-2 py-3 text-[13px] text-lol-text/70">{children}</div>;
}

// Picks and win rate at the end of an augment or item line
function PickStats({ picks, wins }: { picks: number; wins: number }) {
  return (
    <>
      <span className="font-num ml-auto shrink-0 text-[13px] text-lol-text">
        {picks.toLocaleString(LOCALE)}
        <span className="text-lol-text/50">×</span>
      </span>
      <div className="w-30 shrink-0">
        <WinRateBar wins={wins} total={picks} />
      </div>
    </>
  );
}

function ChampionExpanded({
  championId,
  patch,
  queue,
  season,
}: {
  championId: number;
  patch?: string;
  queue?: number;
  season?: string;
}) {
  const navigate = useNavigate();
  const augData = useAugmentData();
  const itemData = useItemData(patch);
  const [augStats, setAugStats] = useState<AugmentStats[] | null>(null);
  const [itemStats, setItemStats] = useState<ItemStats[] | null>(null);
  const [matches, setMatches] = useState<MatchListItem[] | null>(null);

  useEffect(() => {
    window.api.getAugmentStats(championId, patch, queue, season).then(setAugStats);
    window.api.getChampionItemStats(championId, patch, queue, season).then(setItemStats);
    window.api
      .getChampionMatchHistory(championId, 5, 0, patch, queue, season)
      .then((r) => setMatches(r.matches));
  }, [championId, patch, queue, season]);

  if (!augStats || !itemStats || !matches) {
    return (
      <td colSpan={COLUMN_COUNT} className="bg-black/25 px-5 py-10">
        <div className="text-center text-[13px] text-lol-text">Loading…</div>
      </td>
    );
  }

  const topAugments = augStats.slice(0, 6);
  const topItems = itemStats.slice(0, 6);

  return (
    <td
      colSpan={COLUMN_COUNT}
      className="bg-black/25 px-5 pt-4 pb-5 shadow-[inset_0_10px_14px_-12px_rgb(0_0_0/0.7)]"
    >
      <div className="grid grid-cols-3 gap-4">
        <DetailBlock title="Top Augments">
          {topAugments.length > 0 ? (
            topAugments.map((a) => (
              <div
                key={a.augment_id}
                className="flex h-9 items-center gap-2.5 rounded-[3px] px-1.5 hover:bg-white/[0.03]"
              >
                <div className="shrink-0">
                  <AugmentIcon augmentId={a.augment_id} size={26} />
                </div>
                <span className="min-w-0 truncate text-[13px] font-medium text-lol-text-bright">
                  {augData[a.augment_id]?.name ?? `Augment ${a.augment_id}`}
                </span>
                <PickStats picks={a.picks} wins={a.wins} />
              </div>
            ))
          ) : (
            <EmptyLine>No augments recorded</EmptyLine>
          )}
        </DetailBlock>

        <DetailBlock title="Top Items">
          {topItems.length > 0 ? (
            topItems.map((item) => (
              <div
                key={item.item_id}
                className="flex h-9 items-center gap-2.5 rounded-[3px] px-1.5 hover:bg-white/[0.03]"
              >
                <div className="shrink-0">
                  <ItemIcon itemId={item.item_id} size={26} patch={patch} />
                </div>
                <span className="min-w-0 truncate text-[13px] font-medium text-lol-text-bright">
                  {itemData[item.item_id]?.name ?? ""}
                </span>
                <PickStats picks={item.picks} wins={item.wins} />
              </div>
            ))
          ) : (
            <EmptyLine>No items recorded</EmptyLine>
          )}
        </DetailBlock>

        <DetailBlock
          title="Recent Games"
          aside={
            matches.length > 0 && (
              <button
                onClick={() =>
                  navigate("/", {
                    state: { championId, patch, queue, season } satisfies MatchHistoryLink,
                  })
                }
                className="label flex items-center gap-0.5 text-[11px] text-lol-gold transition-colors hover:text-lol-gold-light"
              >
                View all in Match History
                <ChevronRightIcon className="h-3 w-3" />
              </button>
            )
          }
        >
          {matches.length > 0 ? (
            matches.map((m) => (
              <div
                key={m.game_id}
                className={`flex h-9 items-center gap-3 rounded-[3px] border-l-2 bg-gradient-to-r to-transparent pr-2 pl-2 ${
                  m.is_remake
                    ? "border-lol-text/30 from-white/[0.03]"
                    : m.win
                      ? "border-lol-win from-lol-win/[0.11]"
                      : "border-lol-loss from-lol-loss/[0.11]"
                }`}
              >
                <span
                  className={`slant-sm font-display w-12 shrink-0 py-px text-center text-[11px] font-extrabold tracking-[0.08em] uppercase italic ${
                    m.is_remake
                      ? "bg-white/[0.06] text-lol-text"
                      : m.win
                        ? "bg-lol-win/15 text-lol-win"
                        : "bg-lol-loss/15 text-lol-loss"
                  }`}
                >
                  {m.is_remake ? "Remake" : m.win ? "Win" : "Loss"}
                </span>
                <span className="font-num shrink-0 text-[14px] font-semibold text-lol-text-bright">
                  <Kda kills={m.kills} deaths={m.deaths} assists={m.assists} />
                </span>
                {m.score != null && !m.is_remake && (
                  <span
                    className={`font-num shrink-0 text-[14px] font-semibold ${scoreColor(m.score)}`}
                  >
                    {formatDecimal(m.score)}
                  </span>
                )}
                <span className="font-num ml-auto shrink-0 text-[13px] text-lol-text">
                  {formatDuration(m.game_duration)}
                </span>
                <span className="font-num w-14 shrink-0 text-right text-[13px] text-lol-text/70">
                  {formatTimeAgo(m.game_creation)}
                </span>
              </div>
            ))
          ) : (
            <EmptyLine>No games</EmptyLine>
          )}
        </DetailBlock>
      </div>
    </td>
  );
}

export default function Champions() {
  const champData = useChampionData();
  const [patch, setPatch] = useViewState<string | undefined>("champions.patch", undefined);
  const [queue, setQueue] = useViewState<number | undefined>("champions.queue", undefined);
  const [season, setSeason] = useViewState<string | undefined>("champions.season", undefined);
  const { data, refetch } = useIpc<ChampionStats[]>(
    () => window.api.getChampionStats(patch, queue, season),
    [patch, queue, season],
  );
  const [search, setSearch] = useViewState("champions.search", "");
  const [minGames, setMinGames] = useViewState<number | undefined>("champions.minGames", undefined);
  const sort = useSort<SortKey>("champions", "games");
  const { sortKey, sortDir } = sort;
  const [expandedId, setExpandedId] = useState<number | null>(null);

  useEffect(() => {
    const unsub = window.api.onGamesUpdated(() => refetch());
    return unsub;
  }, [refetch]);

  const toggleExpand = (championId: number) => {
    setExpandedId((prev) => (prev === championId ? null : championId));
  };

  const sorted = useMemo(() => {
    if (!data) return [];
    let filtered = data.filter((c) => {
      if (minGames !== undefined && c.games < minGames) return false;
      return matchesSearch(getChampionName(champData, c.champion_id), search);
    });

    filtered.sort((a, b) => {
      let av: number, bv: number;
      if (sortKey === "multikills") {
        av = a.double_kills + a.triple_kills + a.quadra_kills + a.penta_kills;
        bv = b.double_kills + b.triple_kills + b.quadra_kills + b.penta_kills;
      } else if (sortKey === "wins") {
        av = a.games > 0 ? a.wins / a.games : 0;
        bv = b.games > 0 ? b.wins / b.games : 0;
      } else if (sortKey === "kda") {
        av = a.deaths > 0 ? (a.kills + a.assists) / a.deaths : Infinity;
        bv = b.deaths > 0 ? (b.kills + b.assists) / b.deaths : Infinity;
      } else if (sortKey === "badges") {
        av = a.mvps + a.aces;
        bv = b.mvps + b.aces;
      } else if (sortKey === "avg_score") {
        // Champions with no scored games sort below every scored one
        av = a.avg_score ?? -1;
        bv = b.avg_score ?? -1;
      } else {
        av = (a as any)[sortKey];
        bv = (b as any)[sortKey];
      }
      return sortDir === "desc" ? bv - av : av - bv;
    });

    return filtered;
  }, [data, search, minGames, sortKey, sortDir, champData]);

  if (!data) {
    return <div className="text-lol-text text-center mt-20">Loading...</div>;
  }

  const shownGames = sorted.reduce((sum, c) => sum + c.games, 0);

  return (
    <div className="max-w-[1320px] space-y-6">
      <PageHeader
        kicker="Analyze"
        title="Champions"
        subtitle={
          <>
            <span className="font-num text-[14px] font-semibold text-lol-text-bright">
              {sorted.length.toLocaleString(LOCALE)}
            </span>{" "}
            {sorted.length === 1 ? "champion" : "champions"}
            <span className="mx-2 text-lol-text/40">·</span>
            <span className="font-num text-[14px] font-semibold text-lol-text-bright">
              {shownGames.toLocaleString(LOCALE)}
            </span>{" "}
            {shownGames === 1 ? "game" : "games"}
          </>
        }
        actions={
          <>
            <FilterMenu
              active={[season, patch, queue, minGames].filter((v) => v !== undefined).length}
              onReset={() => {
                setSeason(undefined);
                setPatch(undefined);
                setQueue(undefined);
                setMinGames(undefined);
              }}
            >
              <SeasonSelect value={season} onChange={setSeason} label="Set" />
              <PatchSelect value={patch} onChange={setPatch} label="Patch" />
              <QueueSelect value={queue} onChange={setQueue} label="Queue" />
              <MinGamesFilter
                value={minGames}
                onChange={setMinGames}
                max={Math.max(...data.map((c) => c.games))}
              />
            </FilterMenu>
            <SearchInput value={search} onChange={setSearch} placeholder="Search champion..." />
          </>
        }
      />

      {/* Clipped rather than hidden, so the header row can stick while the
          long list scrolls under it. It sticks at -top-2 to cover the page's
          top padding, which would otherwise show rows above it. */}
      <div className="panel overflow-clip">
        <table className="w-full table-fixed">
          <thead className="sticky -top-2 z-10 bg-[#0e142b] shadow-[0_1px_0_var(--color-lol-line)]">
            <tr>
              <th className="tbl-head w-12 px-3 py-3 text-right">#</th>
              <th className="tbl-head px-3 py-3 text-left">Champion</th>
              <SortHeader {...sort} numeric label="Games" field="games" className="w-[76px]" />
              <SortHeader {...sort} numeric label="Win Rate" field="wins" className="w-[168px]" />
              <CycleSortHeader
                {...sort}
                numeric
                steps={KDA_STEPS}
                hint="Average kills / deaths / assists, with the KDA ratio under them"
                className="w-32"
              />
              <SortHeader {...sort} numeric label="Score" field="avg_score" className="w-[72px]" />
              <CycleSortHeader
                {...sort}
                numeric
                steps={BADGE_STEPS}
                hint="MVP / ACE: games as the best player on the winning team / on the losing team"
                className="w-24"
              />
              <SortHeader {...sort} numeric label="Dmg" field="avg_damage" className="w-[76px]" />
              <SortHeader {...sort} numeric label="Gold" field="avg_gold" className="w-[76px]" />
              <CycleSortHeader
                {...sort}
                steps={MULTIKILL_STEPS}
                hint="Multikills: D double, T triple, Q quadra, P penta kills"
                className="w-46"
              />
            </tr>
          </thead>
          <tbody>
            {sorted.map((c, i) => {
              const isExpanded = expandedId === c.champion_id;
              const ratio = c.deaths > 0 ? (c.kills + c.assists) / c.deaths : Infinity;
              return (
                <Fragment key={c.champion_id}>
                  <tr
                    onClick={() => toggleExpand(c.champion_id)}
                    className={`group cursor-pointer border-t border-lol-line transition-colors ${
                      isExpanded ? "bg-white/[0.045]" : "hover:bg-white/[0.03]"
                    }`}
                  >
                    <td
                      className={`font-num px-3 py-2.5 text-right text-[14px] text-lol-text/60 ${
                        isExpanded ? "shadow-[inset_2px_0_0_var(--color-lol-gold)]" : ""
                      }`}
                    >
                      {i + 1}
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-3">
                        <ChampionIcon championId={c.champion_id} size={36} />
                        <div className="min-w-0">
                          <div className="font-display truncate text-[16px] leading-tight font-semibold text-lol-text-bright">
                            {getChampionName(champData, c.champion_id)}
                          </div>
                          <div className="font-num text-[12px] leading-tight text-lol-text">
                            {c.wins.toLocaleString(LOCALE)}W
                            <span className="mx-1 text-lol-text/35">·</span>
                            {(c.games - c.wins).toLocaleString(LOCALE)}L
                          </div>
                        </div>
                        <ChevronRightIcon
                          className={`ml-auto h-4 w-4 shrink-0 transition-all ${
                            isExpanded
                              ? "rotate-90 text-lol-gold"
                              : "text-lol-text/0 group-hover:text-lol-text/60"
                          }`}
                        />
                      </div>
                    </td>
                    <td className="font-num px-3 py-2.5 text-right text-[16px] font-semibold text-lol-text-bright">
                      {c.games.toLocaleString(LOCALE)}
                    </td>
                    <td className="px-3 py-2.5">
                      <WinRateBar wins={c.wins} total={c.games} />
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <div className="font-num text-[15px] leading-tight text-slate-300">
                        <Kda
                          kills={formatDecimal(c.avg_kills)}
                          deaths={formatDecimal(c.avg_deaths)}
                          assists={formatDecimal(c.avg_assists)}
                        />
                      </div>
                      <div
                        className={`font-num text-[12px] leading-tight font-semibold ${kdaColor(ratio)}`}
                      >
                        {kdaRatio(c.kills, c.deaths, c.assists)}
                        <span className="ml-1 text-[11px] tracking-[0.06em] text-lol-text/70">
                          KDA
                        </span>
                      </div>
                    </td>
                    <td
                      className={`font-num px-3 py-2.5 text-right text-[16px] font-semibold ${
                        c.avg_score != null ? scoreColor(c.avg_score) : "text-lol-text/40"
                      }`}
                    >
                      {c.avg_score != null ? formatDecimal(c.avg_score) : "—"}
                    </td>
                    <td className="font-num px-3 py-2.5 text-right text-[15px] whitespace-nowrap">
                      <BadgeCount count={c.mvps} tone="text-amber-300" />
                      <span className="mx-1 text-lol-text/30">/</span>
                      <BadgeCount count={c.aces} tone="text-purple-400" />
                    </td>
                    <td
                      className="font-num px-3 py-2.5 text-right text-[15px] text-slate-300"
                      title={(c.avg_damage ?? 0).toLocaleString(LOCALE)}
                    >
                      {formatCompact(c.avg_damage ?? 0)}
                    </td>
                    <td
                      className="font-num px-3 py-2.5 text-right text-[15px] text-slate-300"
                      title={(c.avg_gold ?? 0).toLocaleString(LOCALE)}
                    >
                      {formatCompact(c.avg_gold ?? 0)}
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex gap-1.5">
                        {MULTIKILL_SLOTS.map((slot) => {
                          const count = c[slot.key];
                          return (
                            <span key={slot.key} className="w-[34px] shrink-0">
                              {count > 0 && (
                                <span
                                  title={`${slot.name} kill${count > 1 ? `s x${count.toLocaleString(LOCALE)}` : ""}`}
                                  className={`font-num inline-block rounded-[2px] px-1.5 py-1 text-[13px] leading-none font-bold whitespace-nowrap ring-1 ring-inset ${slot.tone}`}
                                >
                                  {slot.letter}
                                  {count > 1 ? count.toLocaleString(LOCALE) : ""}
                                </span>
                              )}
                            </span>
                          );
                        })}
                      </div>
                    </td>
                  </tr>
                  {isExpanded && (
                    <tr className="border-t border-lol-line">
                      <ChampionExpanded
                        championId={c.champion_id}
                        patch={patch}
                        queue={queue}
                        season={season}
                      />
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
        {sorted.length === 0 && (
          <div className="flex flex-col items-center gap-3 border-t border-lol-line py-14 text-center">
            <TrophyIcon className="h-7 w-7 text-lol-gold/60" />
            <div className="text-[14px] text-lol-text">
              No champions match these filters. Try a different search or reset the filters.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
