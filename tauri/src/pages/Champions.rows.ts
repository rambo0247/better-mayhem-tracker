import type { ChampionStats } from "../lib/types";

export type SortKey =
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

function sortValue(c: ChampionStats, key: SortKey): number {
  switch (key) {
    case "multikills":
      return c.double_kills + c.triple_kills + c.quadra_kills + c.penta_kills;
    case "wins":
      return c.games > 0 ? c.wins / c.games : 0;
    case "kda":
      return c.deaths > 0 ? (c.kills + c.assists) / c.deaths : Infinity;
    case "badges":
      return c.mvps + c.aces;
    case "avg_score":
      // Champions with no scored games sort below every scored one
      return c.avg_score ?? -1;
    default:
      return c[key];
  }
}

export function filterAndSort(
  rows: ChampionStats[],
  options: {
    minGames: number | undefined;
    sortKey: SortKey;
    sortDir: "asc" | "desc";
    matches: (c: ChampionStats) => boolean;
  },
): ChampionStats[] {
  const { minGames, sortKey, sortDir, matches } = options;
  const kept = rows.filter((c) => (minGames === undefined || c.games >= minGames) && matches(c));
  return kept.sort((a, b) => {
    const av = sortValue(a, sortKey);
    const bv = sortValue(b, sortKey);
    // Two infinite KDAs would subtract to NaN
    if (av === bv) return 0;
    return sortDir === "desc" ? bv - av : av - bv;
  });
}
