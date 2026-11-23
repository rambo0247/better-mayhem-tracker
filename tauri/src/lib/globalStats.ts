import { matchesSearch } from "./search";
import type { SortDir } from "../hooks/useSort";
import type { GlobalStats } from "./types";
import type { Rarity } from "../components/RarityFilter";

export type ChampionRow = GlobalStats["champions"][number];
export type AugmentRow = GlobalStats["augments"][number];
export type ItemRow = GlobalStats["items"][number];

export type ChampSortKey = "games" | "winRate" | "pickRate" | "kda" | "avgDamage" | "name";
export type PickSortKey = "picks" | "winRate" | "pickRate" | "name";

const rate = (wins: number, total: number) => (total > 0 ? wins / total : 0);

export function sortChampions(
  data: GlobalStats,
  championName: (id: number) => string,
  search: string,
  sortKey: ChampSortKey,
  sortDir: SortDir,
): ChampionRow[] {
  const filtered = data.champions.filter((c) => matchesSearch(championName(c.champion_id), search));
  const slots = data.totalParticipantSlots;
  return filtered.sort((a, b) => {
    let av: number, bv: number;
    if (sortKey === "name") {
      const cmp = championName(a.champion_id).localeCompare(championName(b.champion_id));
      return sortDir === "asc" ? cmp : -cmp;
    } else if (sortKey === "winRate") {
      av = rate(a.wins, a.games);
      bv = rate(b.wins, b.games);
    } else if (sortKey === "kda") {
      av = a.deaths > 0 ? (a.kills + a.assists) / a.deaths : Infinity;
      bv = b.deaths > 0 ? (b.kills + b.assists) / b.deaths : Infinity;
    } else if (sortKey === "avgDamage") {
      av = a.avgDamage;
      bv = b.avgDamage;
    } else if (sortKey === "pickRate") {
      av = slots > 0 ? a.games / slots : 0;
      bv = slots > 0 ? b.games / slots : 0;
    } else {
      av = a.games;
      bv = b.games;
    }
    return sortDir === "desc" ? bv - av : av - bv;
  });
}

export function sortAugments(
  data: GlobalStats,
  augment: { name: (id: number) => string; rarity: (id: number) => string | undefined },
  search: string,
  rarity: Rarity,
  sortKey: PickSortKey,
  sortDir: SortDir,
): AugmentRow[] {
  const filtered = data.augments.filter((a) => {
    if (!matchesSearch(augment.name(a.augment_id), search)) return false;
    return rarity === "all" || augment.rarity(a.augment_id) === rarity;
  });
  const slots = data.totalParticipantSlots;
  return filtered.sort((a, b) => {
    let av: number, bv: number;
    if (sortKey === "name") {
      const cmp = augment.name(a.augment_id).localeCompare(augment.name(b.augment_id));
      return sortDir === "asc" ? cmp : -cmp;
    } else if (sortKey === "winRate") {
      av = rate(a.wins, a.picks);
      bv = rate(b.wins, b.picks);
    } else if (sortKey === "pickRate") {
      av = slots > 0 ? a.picks / slots : 0;
      bv = slots > 0 ? b.picks / slots : 0;
    } else {
      av = a.picks;
      bv = b.picks;
    }
    return sortDir === "desc" ? bv - av : av - bv;
  });
}

export function sortItems(
  data: GlobalStats,
  itemName: (id: number) => string,
  search: string,
  sortKey: "picks" | "winRate" | "name",
  sortDir: SortDir,
): ItemRow[] {
  const filtered = data.items.filter((it) => matchesSearch(itemName(it.item_id), search));
  return filtered.sort((a, b) => {
    if (sortKey === "name") {
      const cmp = itemName(a.item_id).localeCompare(itemName(b.item_id));
      return sortDir === "asc" ? cmp : -cmp;
    }
    const av = sortKey === "winRate" ? rate(a.wins, a.picks) : a.picks;
    const bv = sortKey === "winRate" ? rate(b.wins, b.picks) : b.picks;
    return sortDir === "desc" ? bv - av : av - bv;
  });
}

// The leaders for the cards across the top. The best win rate only counts
// champions with enough games behind them that one lucky night can't top it.
export function findLeaders(data: GlobalStats) {
  const totalGames = Math.round(data.totalParticipantSlots / 10);
  const minGames = Math.max(5, Math.ceil(totalGames / 50));
  let mostPicked: ChampionRow | null = null;
  let bestWinRate: ChampionRow | null = null;
  for (const c of data.champions) {
    if (!mostPicked || c.games > mostPicked.games) mostPicked = c;
    if (
      c.games >= minGames &&
      (!bestWinRate || c.wins / c.games > bestWinRate.wins / bestWinRate.games)
    ) {
      bestWinRate = c;
    }
  }
  let topAugment: AugmentRow | null = null;
  for (const a of data.augments) {
    if (!topAugment || a.picks > topAugment.picks) topAugment = a;
  }
  return { totalGames, minGames, mostPicked, bestWinRate, topAugment };
}

// What a champion link carries so the champion page opens on the same filters
export function championFilterQuery(patch: string | undefined, queue: number | undefined): string {
  const params = new URLSearchParams();
  if (patch) params.set("patch", patch);
  if (queue != null) params.set("queue", String(queue));
  const query = params.toString();
  return query ? `?${query}` : "";
}

// Rows of a champion page's item or augment breakdown, by games or win rate
export function sortPickRows<T extends { picks: number; wins: number }>(
  rows: T[],
  sortKey: "picks" | "winRate" | "name",
  sortDir: SortDir,
  nameOf: (row: T) => string,
): T[] {
  return [...rows].sort((a, b) => {
    if (sortKey === "name") {
      const cmp = nameOf(a).localeCompare(nameOf(b));
      return sortDir === "asc" ? cmp : -cmp;
    }
    const av = sortKey === "winRate" ? rate(a.wins, a.picks) : a.picks;
    const bv = sortKey === "winRate" ? rate(b.wins, b.picks) : b.picks;
    return sortDir === "desc" ? bv - av : av - bv;
  });
}
