import { useState, useMemo, useEffect, useCallback, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryFilters } from "../hooks/useQueryFilters";
import { useIpc } from "../hooks/useIpc";
import { useViewState } from "../hooks/useViewState";
import { readViewState, writeViewState } from "../lib/viewState";
import {
  LOCALE,
  formatDecimal,
  formatPercent,
  kdaColor,
  kdaRatio,
  winRateColor,
  winRatePercent,
} from "../lib/format";
import Kda from "../components/Kda";
import { matchesSearch } from "../lib/search";
import {
  useChampionData,
  getChampionName,
  useAugmentData,
  getAugmentName,
  useItemData,
} from "../hooks/useChampions";
import type { GlobalStats } from "../lib/types";
import ChampionIcon from "../components/ChampionIcon";
import AugmentIcon from "../components/AugmentIcon";
import ItemIcon from "../components/ItemIcon";
import WinRateBar from "../components/WinRateBar";
import PatchSelect from "../components/PatchSelect";
import QueueSelect from "../components/QueueSelect";
import RarityFilter, { type Rarity } from "../components/RarityFilter";
import SortHeader from "../components/SortHeader";
import SearchInput from "../components/SearchInput";
import StatCard, { type StatAccent } from "../components/StatCard";
import PageHeader from "../components/PageHeader";
import {
  ChevronRightIcon,
  FunnelIcon,
  GlobeIcon,
  SparklesIcon,
  TrophyIcon,
  UsersIcon,
} from "../components/icons";
import { useSort } from "../hooks/useSort";

type Tab = "champions" | "augments" | "items";
type ChampSortKey = "games" | "winRate" | "pickRate" | "kda" | "avgDamage" | "name";
type AugSortKey = "picks" | "winRate" | "pickRate" | "name";
type ItemSortKey = "picks" | "winRate" | "name";

export default function GlobalStats() {
  const champData = useChampionData();
  const augmentData = useAugmentData();
  const navigate = useNavigate();
  // Filters and tab live in the URL so returning from a champion page lands
  // back on the same view
  const { searchParams, setSearchParams, setParam, patch, queue } = useQueryFilters();
  const tabParam = searchParams.get("tab");
  const tab: Tab = tabParam === "augments" || tabParam === "items" ? tabParam : "champions";

  const setPatch = (p: string | undefined) => setParam("patch", p);
  const setQueue = (q: number | undefined) => setParam("queue", q);
  const setTab = (t: Tab) => setParam("tab", t === "champions" ? undefined : t);

  // Those three live in the URL, so remembering them means putting the query
  // string back on the way in. Arriving with one already set — the back link
  // from a champion page — wins over whatever was stored.
  const [restored, setRestored] = useState(false);
  useEffect(() => {
    const saved = readViewState("global.params", "");
    if (saved && !searchParams.toString()) {
      setSearchParams(new URLSearchParams(saved), { replace: true });
    }
    setRestored(true);
    // Only ever on the way in, so the stored value can't clobber a live edit
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (restored) writeViewState("global.params", searchParams.toString());
  }, [restored, searchParams]);

  // Carried into the champion page so it opens with the same filters, and
  // comes back on its back link
  const filterQuery = useMemo(() => {
    const params = new URLSearchParams();
    if (patch) params.set("patch", patch);
    if (queue != null) params.set("queue", String(queue));
    const query = params.toString();
    return query ? `?${query}` : "";
  }, [patch, queue]);

  const { data, refetch } = useIpc<GlobalStats>(
    () => window.api.getGlobalStats(patch, queue),
    [patch, queue],
  );

  // Champion tab state
  const [champSearch, setChampSearch] = useViewState("global.champSearch", "");
  const champSort = useSort<ChampSortKey>("global.champ", "games");
  const { sortKey: champSortKey, sortDir: champSortDir } = champSort;

  // Augment tab state
  const [augSearch, setAugSearch] = useViewState("global.augSearch", "");
  const augSort = useSort<AugSortKey>("global.aug", "picks");
  const { sortKey: augSortKey, sortDir: augSortDir } = augSort;
  const [rarityFilter, setRarityFilter] = useViewState<Rarity>("global.augRarity", "all");

  // Item tab state
  const itemData = useItemData(patch);
  const [itemSearch, setItemSearch] = useViewState("global.itemSearch", "");
  const itemSort = useSort<ItemSortKey>("global.item", "picks");
  const { sortKey: itemSortKey, sortDir: itemSortDir } = itemSort;

  useEffect(() => {
    const unsub = window.api.onGamesUpdated(() => refetch());
    return unsub;
  }, [refetch]);

  const totalGames = data ? Math.round(data.totalParticipantSlots / 10) : 0;

  const sortedChampions = useMemo(() => {
    if (!data) return [];
    let filtered = data.champions.filter((c) => {
      return matchesSearch(getChampionName(champData, c.champion_id), champSearch);
    });

    filtered.sort((a, b) => {
      let av: number, bv: number;
      if (champSortKey === "name") {
        const nameA = getChampionName(champData, a.champion_id);
        const nameB = getChampionName(champData, b.champion_id);
        const cmp = nameA.localeCompare(nameB);
        return champSortDir === "asc" ? cmp : -cmp;
      } else if (champSortKey === "winRate") {
        av = a.games > 0 ? a.wins / a.games : 0;
        bv = b.games > 0 ? b.wins / b.games : 0;
      } else if (champSortKey === "kda") {
        av = a.deaths > 0 ? (a.kills + a.assists) / a.deaths : Infinity;
        bv = b.deaths > 0 ? (b.kills + b.assists) / b.deaths : Infinity;
      } else if (champSortKey === "avgDamage") {
        av = a.avgDamage;
        bv = b.avgDamage;
      } else if (champSortKey === "pickRate") {
        av = data.totalParticipantSlots > 0 ? a.games / data.totalParticipantSlots : 0;
        bv = data.totalParticipantSlots > 0 ? b.games / data.totalParticipantSlots : 0;
      } else {
        av = a.games;
        bv = b.games;
      }
      return champSortDir === "desc" ? bv - av : av - bv;
    });

    return filtered;
  }, [data, champSearch, champSortKey, champSortDir, champData]);

  const sortedAugments = useMemo(() => {
    if (!data) return [];
    let filtered = data.augments.filter((a) => {
      if (!matchesSearch(getAugmentName(augmentData, a.augment_id), augSearch)) return false;
      if (rarityFilter !== "all" && augmentData[a.augment_id]?.rarity !== rarityFilter)
        return false;
      return true;
    });

    filtered.sort((a, b) => {
      let av: number, bv: number;
      if (augSortKey === "name") {
        const nameA = getAugmentName(augmentData, a.augment_id);
        const nameB = getAugmentName(augmentData, b.augment_id);
        const cmp = nameA.localeCompare(nameB);
        return augSortDir === "asc" ? cmp : -cmp;
      } else if (augSortKey === "winRate") {
        av = a.picks > 0 ? a.wins / a.picks : 0;
        bv = b.picks > 0 ? b.wins / b.picks : 0;
      } else if (augSortKey === "pickRate") {
        av = data!.totalParticipantSlots > 0 ? a.picks / data!.totalParticipantSlots : 0;
        bv = data!.totalParticipantSlots > 0 ? b.picks / data!.totalParticipantSlots : 0;
      } else {
        av = a.picks;
        bv = b.picks;
      }
      return augSortDir === "desc" ? bv - av : av - bv;
    });

    return filtered;
  }, [data, augSearch, augSortKey, augSortDir, augmentData, rarityFilter]);

  const getItemName = useCallback((id: number) => itemData[id]?.name ?? `Item ${id}`, [itemData]);

  const sortedItems = useMemo(() => {
    if (!data) return [];
    const filtered = data.items.filter((it) => matchesSearch(getItemName(it.item_id), itemSearch));

    filtered.sort((a, b) => {
      if (itemSortKey === "name") {
        const cmp = getItemName(a.item_id).localeCompare(getItemName(b.item_id));
        return itemSortDir === "asc" ? cmp : -cmp;
      }
      let av: number, bv: number;
      if (itemSortKey === "winRate") {
        av = a.picks > 0 ? a.wins / a.picks : 0;
        bv = b.picks > 0 ? b.wins / b.picks : 0;
      } else {
        av = a.picks;
        bv = b.picks;
      }
      return itemSortDir === "desc" ? bv - av : av - bv;
    });

    return filtered;
  }, [data, itemSearch, itemSortKey, itemSortDir, getItemName]);

  // The leaders for the cards across the top. The best win rate only counts
  // champions with enough games behind them that one lucky night can't top it.
  const leaders = useMemo(() => {
    if (!data) return null;
    const minGames = Math.max(5, Math.ceil(totalGames / 50));
    let mostPicked: GlobalStats["champions"][number] | null = null;
    let bestWinRate: GlobalStats["champions"][number] | null = null;
    for (const c of data.champions) {
      if (!mostPicked || c.games > mostPicked.games) mostPicked = c;
      if (
        c.games >= minGames &&
        (!bestWinRate || c.wins / c.games > bestWinRate.wins / bestWinRate.games)
      ) {
        bestWinRate = c;
      }
    }
    let topAugment: GlobalStats["augments"][number] | null = null;
    for (const a of data.augments) {
      if (!topAugment || a.picks > topAugment.picks) topAugment = a;
    }
    return { minGames, mostPicked, bestWinRate, topAugment };
  }, [data, totalGames]);

  if (!data || !leaders) {
    return <div className="text-lol-text text-center mt-20">Loading...</div>;
  }

  const slots = data.totalParticipantSlots;
  const rateOf = (n: number) => formatPercent(slots > 0 ? n / slots : 0);
  // The pick-rate bars are drawn against each table's most picked row
  const maxChampGames = Math.max(0, ...data.champions.map((c) => c.games));
  const maxAugPicks = Math.max(0, ...data.augments.map((a) => a.picks));
  const maxItemPicks = Math.max(0, ...data.items.map((it) => it.picks));
  const openChampion = (id: number) => navigate(`/global/champion/${id}${filterQuery}`);

  const tabs: { key: Tab; label: string; count: number }[] = [
    { key: "champions", label: "Champions", count: data.champions.length },
    { key: "augments", label: "Augments", count: data.augments.length },
    { key: "items", label: "Items", count: data.items.length },
  ];
  // The tab already carries the full count, so this only speaks up once a
  // search or filter has narrowed the list
  const shown =
    tab === "champions"
      ? { count: sortedChampions.length, total: data.champions.length }
      : tab === "augments"
        ? { count: sortedAugments.length, total: data.augments.length }
        : { count: sortedItems.length, total: data.items.length };

  return (
    <div className="max-w-[1320px] space-y-6">
      <PageHeader
        kicker="Analyze"
        title="Total Stats"
        className="pb-0"
        subtitle={
          <>
            Every player in your games <Dot />
            <Count n={totalGames} /> games <Dot />
            <Count n={data.champions.length} /> champions <Dot />
            <Count n={data.augments.length} /> augments <Dot />
            <Count n={data.items.length} /> items
          </>
        }
        actions={
          <>
            <QueueSelect value={queue} onChange={setQueue} />
            <PatchSelect value={patch} onChange={setPatch} />
          </>
        }
      />

      {totalGames > 0 && (
        <div className="grid grid-cols-4 items-stretch gap-4">
          <StatCard
            label="Games"
            accent="gold"
            icon={<GlobeIcon className="h-3.5 w-3.5" />}
            value={totalGames.toLocaleString(LOCALE)}
            subtext={
              <>
                <span className="font-num text-[14px] text-lol-text-bright/80">
                  {slots.toLocaleString(LOCALE)}
                </span>{" "}
                champion picks
              </>
            }
          />
          <LeaderCard label="Most Picked" accent="sky" icon={<UsersIcon className="h-3.5 w-3.5" />}>
            {leaders.mostPicked && (
              <ChampionLeader
                championId={leaders.mostPicked.champion_id}
                name={getChampionName(champData, leaders.mostPicked.champion_id)}
                onOpen={() => openChampion(leaders.mostPicked!.champion_id)}
              >
                <span className="font-num text-[15px] font-semibold text-lol-text-bright">
                  {leaders.mostPicked.games.toLocaleString(LOCALE)}
                </span>{" "}
                games <Dot />{" "}
                <span className="font-num text-[15px]">{rateOf(leaders.mostPicked.games)}</span>{" "}
                pick rate
              </ChampionLeader>
            )}
          </LeaderCard>
          <LeaderCard
            label="Best Win Rate"
            accent="win"
            icon={<TrophyIcon className="h-3.5 w-3.5" />}
            hint={`Min ${leaders.minGames} games`}
          >
            {leaders.bestWinRate ? (
              <ChampionLeader
                championId={leaders.bestWinRate.champion_id}
                name={getChampionName(champData, leaders.bestWinRate.champion_id)}
                onOpen={() => openChampion(leaders.bestWinRate!.champion_id)}
              >
                <span
                  className={`font-num text-[15px] font-semibold ${winRateColor(
                    leaders.bestWinRate.wins,
                    leaders.bestWinRate.games,
                  )}`}
                >
                  {winRatePercent(leaders.bestWinRate.wins, leaders.bestWinRate.games)}
                </span>{" "}
                in{" "}
                <span className="font-num text-[15px]">
                  {leaders.bestWinRate.games.toLocaleString(LOCALE)}
                </span>{" "}
                games
              </ChampionLeader>
            ) : (
              <div className="text-[13px] text-lol-text">No champion has enough games yet</div>
            )}
          </LeaderCard>
          <LeaderCard
            label="Top Augment"
            accent="purple"
            icon={<SparklesIcon className="h-3.5 w-3.5" />}
          >
            {leaders.topAugment && (
              <div className="flex min-w-0 items-center gap-3">
                <AugmentIcon augmentId={leaders.topAugment.augment_id} size={44} />
                <div className="min-w-0">
                  <div className="truncate font-display text-[19px] font-bold leading-tight text-lol-text-bright">
                    {getAugmentName(augmentData, leaders.topAugment.augment_id)}
                  </div>
                  <div className="truncate text-[13px] text-lol-text">
                    <span className="font-num text-[15px] font-semibold text-lol-text-bright">
                      {leaders.topAugment.picks.toLocaleString(LOCALE)}
                    </span>{" "}
                    picks <Dot />{" "}
                    <span
                      className={`font-num text-[15px] font-semibold ${winRateColor(
                        leaders.topAugment.wins,
                        leaders.topAugment.picks,
                      )}`}
                    >
                      {winRatePercent(leaders.topAugment.wins, leaders.topAugment.picks)}
                    </span>{" "}
                    win rate
                  </div>
                </div>
              </div>
            )}
          </LeaderCard>
        </div>
      )}

      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="seg" role="group" aria-label="Stats to show">
            {tabs.map((t) => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                aria-pressed={tab === t.key}
                className="seg-item px-4"
              >
                {t.label}
                <span className="font-num text-[13px] font-semibold opacity-60">
                  {t.count.toLocaleString(LOCALE)}
                </span>
              </button>
            ))}
          </div>
          {tab === "augments" && <RarityFilter value={rarityFilter} onChange={setRarityFilter} />}
          <div className="ml-auto flex items-center gap-3">
            {shown.count !== shown.total && (
              <span className="text-[13px] text-lol-text">
                <span className="font-num text-[15px] font-semibold text-lol-text-bright">
                  {shown.count.toLocaleString(LOCALE)}
                </span>{" "}
                of{" "}
                <span className="font-num text-[15px]">{shown.total.toLocaleString(LOCALE)}</span>
              </span>
            )}
            {tab === "champions" && (
              <SearchInput
                value={champSearch}
                onChange={setChampSearch}
                placeholder="Search champion..."
              />
            )}
            {tab === "augments" && (
              <SearchInput
                value={augSearch}
                onChange={setAugSearch}
                placeholder="Search augment..."
              />
            )}
            {tab === "items" && (
              <SearchInput
                value={itemSearch}
                onChange={setItemSearch}
                placeholder="Search item..."
              />
            )}
          </div>
        </div>

        {tab === "champions" && (
          <div className="panel overflow-clip">
            <table className="w-full table-fixed">
              <TableHead>
                <th className="tbl-head w-14 px-3 py-3 text-right">#</th>
                {/* The name column is held to its content's width; the win-rate
                    bar's column takes whatever room the window has left */}
                <SortHeader {...champSort} label="Champion" field="name" className="w-[9.5rem]" />
                <SortHeader {...champSort} numeric label="Games" field="games" className="w-16" />
                <RecordHead className="w-[7.5rem]" />
                <SortHeader
                  {...champSort}
                  numeric
                  label="Pick %"
                  field="pickRate"
                  hint={PICK_RATE_HINT}
                  className="w-44"
                />
                <SortHeader {...champSort} numeric label="Win %" field="winRate" />
                <SortHeader
                  {...champSort}
                  numeric
                  label="KDA"
                  field="kda"
                  hint="Kills plus assists over deaths, with the average kills / deaths / assists under it"
                  className="w-32"
                />
                <SortHeader
                  {...champSort}
                  numeric
                  label="Avg Dmg"
                  field="avgDamage"
                  hint="Average damage to champions per game"
                  className="w-24"
                />
                <th className="w-10" aria-hidden />
              </TableHead>
              <tbody>
                {sortedChampions.map((c, i) => (
                  <tr
                    key={c.champion_id}
                    onClick={() => openChampion(c.champion_id)}
                    className="group cursor-pointer border-t border-lol-line transition-colors hover:bg-white/[0.03]"
                  >
                    <RankCell rank={i + 1} />
                    <td className="px-3 py-2">
                      <div className="flex min-w-0 items-center gap-3">
                        <ChampionIcon championId={c.champion_id} size={36} />
                        <span
                          title={getChampionName(champData, c.champion_id)}
                          className="truncate font-display text-[16px] font-semibold text-lol-text-bright transition-colors group-hover:text-lol-gold-light"
                        >
                          {getChampionName(champData, c.champion_id)}
                        </span>
                      </div>
                    </td>
                    <StatCells
                      games={c.games}
                      wins={c.wins}
                      slots={slots}
                      maxGames={maxChampGames}
                    />
                    <KdaCell
                      kills={c.kills}
                      deaths={c.deaths}
                      assists={c.assists}
                      games={c.games}
                    />
                    <td className="font-num px-3 py-2 text-right text-[15px] text-lol-text-bright/85">
                      {c.avgDamage.toLocaleString(LOCALE)}
                    </td>
                    <td className="pr-3 text-right">
                      <ChevronRightIcon className="ml-auto h-4 w-4 text-lol-text/30 transition-colors group-hover:text-lol-gold" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {sortedChampions.length === 0 && <EmptyRows>No champions match your search.</EmptyRows>}
          </div>
        )}

        {tab === "items" && (
          <div className="panel overflow-clip">
            <table className="w-full table-fixed">
              <TableHead>
                <th className="tbl-head w-14 px-3 py-3 text-right">#</th>
                <SortHeader {...itemSort} label="Item" field="name" />
                <SortHeader {...itemSort} numeric label="Picks" field="picks" className="w-24" />
                <RecordHead />
                <th className="tbl-head w-64 px-3 py-3 text-right" title={PICK_RATE_HINT}>
                  Pick %
                </th>
                <SortHeader {...itemSort} numeric label="Win %" field="winRate" className="w-64" />
                <th className="w-12" aria-hidden />
              </TableHead>
              <tbody>
                {sortedItems.map((item, i) => (
                  <tr
                    key={item.item_id}
                    className="border-t border-lol-line transition-colors hover:bg-white/[0.03]"
                  >
                    <RankCell rank={i + 1} />
                    <td className="px-3 py-2">
                      <div className="flex min-w-0 items-center gap-3">
                        <ItemIcon itemId={item.item_id} size={36} patch={patch} />
                        <span className="truncate font-display text-[16px] font-semibold text-lol-text-bright">
                          {getItemName(item.item_id)}
                        </span>
                      </div>
                    </td>
                    <StatCells
                      games={item.picks}
                      wins={item.wins}
                      slots={slots}
                      maxGames={maxItemPicks}
                    />
                    <td />
                  </tr>
                ))}
              </tbody>
            </table>
            {sortedItems.length === 0 && <EmptyRows>No items match your search.</EmptyRows>}
          </div>
        )}

        {tab === "augments" && (
          <div className="panel overflow-clip">
            <table className="w-full table-fixed">
              <TableHead>
                <th className="tbl-head w-14 px-3 py-3 text-right">#</th>
                <SortHeader {...augSort} label="Augment" field="name" />
                <SortHeader {...augSort} numeric label="Picks" field="picks" className="w-24" />
                <RecordHead />
                <SortHeader
                  {...augSort}
                  numeric
                  label="Pick %"
                  field="pickRate"
                  hint={PICK_RATE_HINT}
                  className="w-64"
                />
                <SortHeader {...augSort} numeric label="Win %" field="winRate" className="w-64" />
                <th className="w-12" aria-hidden />
              </TableHead>
              <tbody>
                {sortedAugments.map((a, i) => (
                  <tr
                    key={a.augment_id}
                    className="border-t border-lol-line transition-colors hover:bg-white/[0.03]"
                  >
                    <RankCell rank={i + 1} />
                    <td className="max-w-0 px-3 py-2">
                      <AugmentIcon
                        augmentId={a.augment_id}
                        size={36}
                        showName
                        nameClassName="ml-1.5 font-display text-[16px] font-semibold"
                      />
                    </td>
                    <StatCells games={a.picks} wins={a.wins} slots={slots} maxGames={maxAugPicks} />
                    <td />
                  </tr>
                ))}
              </tbody>
            </table>
            {sortedAugments.length === 0 && <EmptyRows>No augments match these filters.</EmptyRows>}
          </div>
        )}
      </div>
    </div>
  );
}

const PICK_RATE_HINT = "Share of every player's picks across these games";

// The header row stays pinned to the top of the page while a long table
// scrolls under it, so it needs a solid fill rather than the usual tint
function TableHead({ children }: { children: ReactNode }) {
  return (
    <thead className="sticky -top-2 z-10 bg-[#0e142c] [&_th]:shadow-[inset_0_-1px_0_rgb(255_255_255/0.07)]">
      <tr>{children}</tr>
    </thead>
  );
}

function RecordHead({ className = "w-36" }: { className?: string }) {
  return (
    <th className={`tbl-head px-3 py-3 text-right ${className}`} title="Wins and losses">
      Record
    </th>
  );
}

// The numbers every table shares: count, win-loss record, pick rate against the
// most picked row, and win rate
function StatCells({
  games,
  wins,
  slots,
  maxGames,
}: {
  games: number;
  wins: number;
  slots: number;
  maxGames: number;
}) {
  const losses = games - wins;
  return (
    <>
      <td className="font-num px-3 py-2 text-right text-[15px] font-semibold text-lol-text-bright">
        {games.toLocaleString(LOCALE)}
      </td>
      <td className="font-num px-3 py-2 text-right text-[14px]">
        <span className="text-lol-win/90">{wins.toLocaleString(LOCALE)}</span>
        <span className="ml-0.5 text-[12px] text-lol-win/60">W</span>
        <span className="ml-2 text-lol-loss/85">{losses.toLocaleString(LOCALE)}</span>
        <span className="ml-0.5 text-[12px] text-lol-loss/60">L</span>
      </td>
      <td className="px-3 py-2 pl-6">
        <div className="flex items-center gap-2.5">
          <div className="h-1.5 flex-1 overflow-hidden rounded-[2px] bg-white/[0.06]">
            <div
              className="h-full rounded-[2px] bg-gradient-to-r from-sky-500/35 to-sky-400/70"
              style={{
                width: `${maxGames > 0 ? (games / maxGames) * 100 : 0}%`,
              }}
            />
          </div>
          <span className="font-num min-w-11 text-right text-[14px] font-semibold text-lol-text-bright/85">
            {formatPercent(slots > 0 ? games / slots : 0)}
          </span>
        </div>
      </td>
      <td className="px-3 py-2 pl-6">
        <WinRateBar wins={wins} total={games} />
      </td>
    </>
  );
}

function Dot() {
  return <span className="mx-1 text-lol-text/40">·</span>;
}

function Count({ n }: { n: number }) {
  return (
    <span className="font-num text-[14px] font-semibold text-lol-text-bright/85">
      {n.toLocaleString(LOCALE)}
    </span>
  );
}

function RankCell({ rank }: { rank: number }) {
  return <td className="font-num px-3 py-2 text-right text-[14px] text-lol-text/60">{rank}</td>;
}

function EmptyRows({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 border-t border-lol-line px-8 py-14 text-center">
      <FunnelIcon className="h-7 w-7 text-lol-gold/60" />
      <div className="text-[14px] text-lol-text">{children}</div>
    </div>
  );
}

// A StatCard whose headline is a champion or augment rather than a number
function LeaderCard({
  label,
  accent,
  icon,
  hint,
  children,
}: {
  label: string;
  accent: StatAccent;
  icon: ReactNode;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <StatCard
      label={label}
      accent={accent}
      icon={icon}
      value={
        <>
          {hint && (
            <span className="label absolute right-4 top-[1.1rem] text-[11px] text-lol-text/60">
              {hint}
            </span>
          )}
          <div className="pt-1 font-sans text-[14px] font-normal leading-normal tracking-normal">
            {children}
          </div>
        </>
      }
    />
  );
}

function ChampionLeader({
  championId,
  name,
  onOpen,
  children,
}: {
  championId: number;
  name: string;
  onOpen: () => void;
  children: ReactNode;
}) {
  return (
    <button onClick={onOpen} className="group flex w-full min-w-0 items-center gap-3 text-left">
      <ChampionIcon
        championId={championId}
        size={44}
        className="ring-1 ring-white/10 transition-shadow group-hover:ring-lol-gold/60"
      />
      <div className="min-w-0">
        <div className="truncate font-display text-[19px] font-bold leading-tight text-lol-text-bright transition-colors group-hover:text-lol-gold-light">
          {name}
        </div>
        <div className="truncate text-[13px] text-lol-text">{children}</div>
      </div>
    </button>
  );
}

// The pooled KDA ratio in its quality colour, with the per-game averages it
// comes from in small type under it
function KdaCell({
  kills,
  deaths,
  assists,
  games,
}: {
  kills: number;
  deaths: number;
  assists: number;
  games: number;
}) {
  const ratio = deaths > 0 ? (kills + assists) / deaths : Infinity;
  const avg = (n: number) => formatDecimal(games > 0 ? n / games : 0);
  return (
    <td className="px-3 py-2 text-right">
      <div className={`font-num text-[15px] font-semibold leading-tight ${kdaColor(ratio)}`}>
        {kdaRatio(kills, deaths, assists)}
      </div>
      <div className="font-num text-[12px] leading-tight text-lol-text">
        <Kda kills={avg(kills)} deaths={avg(deaths)} assists={avg(assists)} />
      </div>
    </td>
  );
}
