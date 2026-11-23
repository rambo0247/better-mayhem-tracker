import { describe, expect, test } from "bun:test";
import {
  championFilterQuery,
  findLeaders,
  sortAugments,
  sortChampions,
  sortItems,
  sortPickRows,
} from "./globalStats";
import type { GlobalStats } from "./types";

const champ = (champion_id: number, games: number, wins: number, deaths = 10) => ({
  champion_id,
  games,
  wins,
  kills: 20,
  deaths,
  assists: 30,
  avgDamage: games * 100,
});

const stats = (champions: GlobalStats["champions"]): GlobalStats => ({
  champions,
  augments: [
    { augment_id: 1, picks: 40, wins: 10 },
    { augment_id: 2, picks: 90, wins: 60 },
    { augment_id: 3, picks: 10, wins: 5 },
  ],
  items: [
    { item_id: 11, picks: 5, wins: 1 },
    { item_id: 12, picks: 50, wins: 20 },
  ],
  totalParticipantSlots: 1000,
});

const names: Record<number, string> = { 1: "Ahri", 2: "Zed", 3: "Annie" };
const championName = (id: number) => names[id] ?? `Champion ${id}`;

describe("sortChampions", () => {
  const data = stats([champ(1, 50, 20), champ(2, 80, 60), champ(3, 10, 9)]);

  test("sorts by games, largest first, by default direction", () => {
    expect(
      sortChampions(data, championName, "", "games", "desc").map((c) => c.champion_id),
    ).toEqual([2, 1, 3]);
  });

  test("sorts by win rate", () => {
    expect(
      sortChampions(data, championName, "", "winRate", "desc").map((c) => c.champion_id),
    ).toEqual([3, 2, 1]);
  });

  test("sorts a name column alphabetically ascending", () => {
    expect(sortChampions(data, championName, "", "name", "asc").map((c) => c.champion_id)).toEqual([
      1, 3, 2,
    ]);
  });

  test("the search narrows to matching names", () => {
    expect(
      sortChampions(data, championName, "an", "games", "desc").map((c) => c.champion_id),
    ).toEqual([3]);
  });

  test("a champion with no deaths tops the KDA sort", () => {
    const withPerfect = stats([champ(1, 50, 20), champ(2, 80, 60, 0)]);
    expect(
      sortChampions(withPerfect, championName, "", "kda", "desc").map((c) => c.champion_id),
    ).toEqual([2, 1]);
  });
});

describe("sortAugments", () => {
  const data = stats([]);
  const augment = {
    name: (id: number) => `Augment ${id}`,
    rarity: (id: number) => (id === 2 ? "kGold" : "kSilver"),
  };

  test("filters by rarity", () => {
    expect(
      sortAugments(data, augment, "", "kGold", "picks", "desc").map((a) => a.augment_id),
    ).toEqual([2]);
  });

  test("sorts by pick rate", () => {
    expect(
      sortAugments(data, augment, "", "all", "pickRate", "desc").map((a) => a.augment_id),
    ).toEqual([2, 1, 3]);
  });

  test("searches the augment's name", () => {
    expect(
      sortAugments(data, augment, "augment 3", "all", "picks", "desc").map((a) => a.augment_id),
    ).toEqual([3]);
  });
});

describe("sortItems", () => {
  test("searches by name and sorts by win rate", () => {
    const data = stats([]);
    const itemName = (id: number) => `Item ${id}`;
    expect(sortItems(data, itemName, "", "winRate", "desc").map((i) => i.item_id)).toEqual([
      12, 11,
    ]);
    expect(sortItems(data, itemName, "11", "picks", "desc").map((i) => i.item_id)).toEqual([11]);
  });
});

describe("findLeaders", () => {
  test("counts games as a tenth of the participant slots", () => {
    expect(findLeaders(stats([champ(1, 50, 20)])).totalGames).toBe(100);
  });

  test("best win rate needs the minimum games", () => {
    const leaders = findLeaders(stats([champ(1, 50, 20), champ(3, 4, 4)]));
    expect(leaders.minGames).toBe(5);
    expect(leaders.mostPicked?.champion_id).toBe(1);
    expect(leaders.bestWinRate?.champion_id).toBe(1);
  });

  test("no champion has enough games", () => {
    const leaders = findLeaders(stats([champ(1, 3, 3), champ(2, 2, 1)]));
    expect(leaders.bestWinRate).toBeNull();
    expect(leaders.mostPicked?.champion_id).toBe(1);
  });

  test("the top augment is the most picked", () => {
    expect(findLeaders(stats([])).topAugment?.augment_id).toBe(2);
  });
});

describe("championFilterQuery", () => {
  test("carries the patch and the queue", () => {
    expect(championFilterQuery("16.22", 2400)).toBe("?patch=16.22&queue=2400");
    expect(championFilterQuery(undefined, 2400)).toBe("?queue=2400");
    expect(championFilterQuery("16.22", undefined)).toBe("?patch=16.22");
  });

  test("is empty with neither", () => {
    expect(championFilterQuery(undefined, undefined)).toBe("");
  });
});

describe("sortPickRows", () => {
  const rows = [
    { id: "b", picks: 5, wins: 5 },
    { id: "a", picks: 20, wins: 5 },
  ];
  test("sorts without changing the input", () => {
    const sorted = sortPickRows(rows, "picks", "desc", (r) => r.id);
    expect(sorted.map((r) => r.id)).toEqual(["a", "b"]);
    expect(rows.map((r) => r.id)).toEqual(["b", "a"]);
    expect(sortPickRows(rows, "winRate", "desc", (r) => r.id).map((r) => r.id)).toEqual(["b", "a"]);
    expect(sortPickRows(rows, "name", "asc", (r) => r.id).map((r) => r.id)).toEqual(["a", "b"]);
  });
});
