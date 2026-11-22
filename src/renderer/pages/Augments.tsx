import { useState, useMemo, useEffect, Fragment } from "react";
import { useIpc } from "../hooks/useIpc";
import { useViewState } from "../hooks/useViewState";
import { useSort } from "../hooks/useSort";
import {
  useChampionData,
  getChampionName,
  useAugmentData,
  getAugmentName,
} from "../hooks/useChampions";
import type { AugmentStatsDetailedResult } from "../lib/types";
import { LOCALE, formatPercent } from "../lib/format";
import { matchesSearch } from "../lib/search";
import AugmentIcon from "../components/AugmentIcon";
import ChampionIcon from "../components/ChampionIcon";
import WinRateBar from "../components/WinRateBar";
import PatchSelect from "../components/PatchSelect";
import QueueSelect from "../components/QueueSelect";
import SortHeader from "../components/SortHeader";
import SearchInput from "../components/SearchInput";
import FilterMenu from "../components/FilterMenu";
import MinGamesFilter from "../components/MinGamesFilter";
import SeasonSelect from "../components/SeasonSelect";
import RarityFilter, { type Rarity } from "../components/RarityFilter";
import PageHeader from "../components/PageHeader";
import { ChevronRightIcon, SparklesIcon } from "../components/icons";

type SortKey = "picks" | "winRate" | "name";

// The rarity tag beside each augment. The icon's ring already carries the
// colour, so the name itself can stay in the table's one bright text colour.
const RARITY_TAGS: Record<string, { label: string; tone: string }> = {
  kSilver: { label: "Silver", tone: "bg-slate-300/10 text-slate-300 ring-slate-300/20" },
  kGold: { label: "Gold", tone: "bg-amber-400/12 text-amber-400 ring-amber-400/25" },
  kPrismatic: {
    label: "Prismatic",
    tone: "bg-fuchsia-400/12 text-fuchsia-300 ring-fuchsia-400/30",
  },
};

// Portraits shown in the collapsed row, before the rest fold into a count
const TOP_CHAMPIONS = 5;

export default function Augments() {
  const champData = useChampionData();
  const augmentData = useAugmentData();
  const [patch, setPatch] = useViewState<string | undefined>("augments.patch", undefined);
  const [queue, setQueue] = useViewState<number | undefined>("augments.queue", undefined);
  const [season, setSeason] = useViewState<string | undefined>("augments.season", undefined);
  const { data, refetch } = useIpc<AugmentStatsDetailedResult>(
    () => window.api.getAugmentStatsDetailed(patch, queue, season),
    [patch, queue, season],
  );
  const [search, setSearch] = useViewState("augments.search", "");
  const [minPicks, setMinPicks] = useViewState<number | undefined>("augments.minPicks", undefined);
  const sort = useSort<SortKey>("augments", "picks");
  const { sortKey, sortDir } = sort;
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [rarityFilter, setRarityFilter] = useViewState<Rarity>("augments.rarity", "all");

  useEffect(() => {
    const unsub = window.api.onGamesUpdated(() => refetch());
    return unsub;
  }, [refetch]);

  const totalGames = data?.totalGames ?? 0;

  const toggleExpand = (augmentId: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(augmentId)) next.delete(augmentId);
      else next.add(augmentId);
      return next;
    });
  };

  const sorted = useMemo(() => {
    if (!data) return [];
    let filtered = data.augments.filter((a) => {
      const aug = augmentData[a.augment_id];
      if (!matchesSearch(getAugmentName(augmentData, a.augment_id), search)) return false;
      if (rarityFilter !== "all" && aug?.rarity !== rarityFilter) return false;
      if (minPicks !== undefined && a.picks < minPicks) return false;
      return true;
    });

    filtered.sort((a, b) => {
      let av: number, bv: number;
      if (sortKey === "name") {
        const nameA = getAugmentName(augmentData, a.augment_id);
        const nameB = getAugmentName(augmentData, b.augment_id);
        const cmp = nameA.localeCompare(nameB);
        return sortDir === "asc" ? cmp : -cmp;
      } else if (sortKey === "winRate") {
        av = a.picks > 0 ? a.wins / a.picks : 0;
        bv = b.picks > 0 ? b.wins / b.picks : 0;
      } else {
        av = a.picks;
        bv = b.picks;
      }
      return sortDir === "desc" ? bv - av : av - bv;
    });

    return filtered;
  }, [data, search, sortKey, sortDir, augmentData, rarityFilter, minPicks]);

  if (!data) {
    return <div className="text-lol-text text-center mt-20">Loading...</div>;
  }

  return (
    <div className="max-w-[1320px] space-y-6">
      <PageHeader
        kicker="Analyze"
        title="Augments"
        subtitle={
          <>
            <span className="font-num text-[14px] font-semibold text-lol-text-bright">
              {sorted.length.toLocaleString(LOCALE)}
            </span>{" "}
            {sorted.length === 1 ? "augment" : "augments"}
            <span className="mx-2 text-lol-text/40">·</span>
            <span className="font-num text-[14px] font-semibold text-lol-text-bright">
              {totalGames.toLocaleString(LOCALE)}
            </span>{" "}
            {totalGames === 1 ? "game" : "games"}
          </>
        }
        actions={
          <>
            <RarityFilter value={rarityFilter} onChange={setRarityFilter} />
            <FilterMenu
              active={[season, patch, queue, minPicks].filter((v) => v !== undefined).length}
              onReset={() => {
                setSeason(undefined);
                setPatch(undefined);
                setQueue(undefined);
                setMinPicks(undefined);
              }}
            >
              <SeasonSelect value={season} onChange={setSeason} label="Set" />
              <PatchSelect value={patch} onChange={setPatch} label="Patch" />
              <QueueSelect value={queue} onChange={setQueue} label="Queue" />
              <MinGamesFilter
                value={minPicks}
                onChange={setMinPicks}
                max={Math.max(...data.augments.map((a) => a.picks))}
                label="Min picks"
              />
            </FilterMenu>
            <SearchInput value={search} onChange={setSearch} placeholder="Search augment..." />
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
              <th className="w-11" aria-label="Expand" />
              <SortHeader {...sort} label="Augment" field="name" />
              <th className="tbl-head w-28 px-3 py-3 text-left">Rarity</th>
              <th
                className="tbl-head w-[208px] px-3 py-3 text-left"
                title="The champions this augment was picked on, most picks first"
              >
                Played on
              </th>
              <SortHeader {...sort} numeric label="Picks" field="picks" className="w-20" />
              <th className="tbl-head w-24 px-3 py-3 text-right">Pick Rate</th>
              <SortHeader {...sort} numeric label="Win Rate" field="winRate" className="w-44" />
            </tr>
          </thead>
          <tbody>
            {sorted.map((a) => {
              const isExpanded = expanded.has(a.augment_id);
              const pickRate = formatPercent(totalGames > 0 ? a.picks / totalGames : 0);
              const rarity = RARITY_TAGS[augmentData[a.augment_id]?.rarity ?? ""];
              const champions = [...a.champions].sort((x, y) => y.picks - x.picks);
              const hidden = champions.length - TOP_CHAMPIONS;
              return (
                <Fragment key={a.augment_id}>
                  <tr
                    onClick={() => toggleExpand(a.augment_id)}
                    aria-expanded={isExpanded}
                    className={`group cursor-pointer border-t border-lol-line transition-colors ${
                      isExpanded ? "bg-white/[0.045]" : "hover:bg-white/[0.03]"
                    }`}
                  >
                    <td
                      className={`py-2.5 pl-4 ${
                        isExpanded ? "shadow-[inset_2px_0_0_var(--color-lol-gold)]" : ""
                      }`}
                    >
                      <ChevronRightIcon
                        className={`h-4 w-4 transition-all ${
                          isExpanded
                            ? "rotate-90 text-lol-gold"
                            : "text-lol-text/50 group-hover:text-lol-text-bright"
                        }`}
                      />
                    </td>
                    <td className="px-3 py-2.5">
                      <AugmentIcon
                        augmentId={a.augment_id}
                        size={36}
                        showName
                        nameClassName="ml-1.5 font-display text-[16px] font-semibold text-lol-text-bright!"
                      />
                    </td>
                    <td className="px-3 py-2.5">
                      {rarity && (
                        <span className={`chip ring-1 ring-inset ${rarity.tone}`}>
                          {rarity.label}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center">
                        <div className="flex -space-x-1">
                          {champions.slice(0, TOP_CHAMPIONS).map((c) => (
                            <ChampionIcon
                              key={c.champion_id}
                              championId={c.champion_id}
                              size={28}
                              title={`${getChampionName(champData, c.champion_id)} · ${c.picks.toLocaleString(LOCALE)} picks`}
                              className="ring-2 ring-lol-card"
                            />
                          ))}
                        </div>
                        {hidden > 0 && (
                          <span className="font-num ml-2.5 text-[14px] font-semibold text-lol-text-bright/80">
                            +{hidden}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="font-num px-3 py-2.5 text-right text-[16px] font-semibold text-lol-text-bright">
                      {a.picks.toLocaleString(LOCALE)}
                    </td>
                    <td className="font-num px-3 py-2.5 text-right text-[15px] text-slate-300">
                      {pickRate}
                    </td>
                    <td className="px-3 py-2.5">
                      <WinRateBar wins={a.wins} total={a.picks} />
                    </td>
                  </tr>
                  {isExpanded &&
                    champions.map((c, i) => (
                      <tr
                        key={`${a.augment_id}-${c.champion_id}`}
                        className={`bg-black/25 ${i === 0 ? "border-t border-lol-line" : ""}`}
                      >
                        <td className="shadow-[inset_2px_0_0_var(--color-lol-gold)]" />
                        <td colSpan={3} className="py-1.5 pr-3 pl-8">
                          <div className="flex items-center gap-2.5">
                            <span className="h-px w-3 bg-lol-text/25" />
                            <ChampionIcon championId={c.champion_id} size={26} />
                            <span className="font-display text-[15px] font-medium text-lol-text-bright/85">
                              {getChampionName(champData, c.champion_id)}
                            </span>
                          </div>
                        </td>
                        <td className="font-num px-3 py-1.5 text-right text-[14px] text-slate-300">
                          {c.picks.toLocaleString(LOCALE)}
                        </td>
                        <td />
                        <td className="px-3 py-1.5">
                          <WinRateBar wins={c.wins} total={c.picks} />
                        </td>
                      </tr>
                    ))}
                </Fragment>
              );
            })}
          </tbody>
        </table>
        {sorted.length === 0 && (
          <div className="flex flex-col items-center gap-3 border-t border-lol-line py-14 text-center">
            <SparklesIcon className="h-7 w-7 text-lol-gold/60" />
            <div className="text-[14px] text-lol-text">
              No augments match these filters. Try another rarity or search.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
