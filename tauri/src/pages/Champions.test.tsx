import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { ChampionStats } from "../lib/types";
import { filterAndSort, type SortKey } from "./Champions.rows";

function champ(id: number, over: Partial<ChampionStats> = {}): ChampionStats {
  return {
    champion_id: id,
    games: 10,
    wins: 5,
    kills: 50,
    deaths: 25,
    assists: 50,
    avg_kills: 5,
    avg_deaths: 2.5,
    avg_assists: 5,
    avg_damage: 1000,
    avg_gold: 1000,
    avg_score: 5,
    mvps: 0,
    aces: 0,
    double_kills: 0,
    triple_kills: 0,
    quadra_kills: 0,
    penta_kills: 0,
    ...over,
  };
}

const ROWS = [
  champ(1, {
    games: 30,
    wins: 10,
    kills: 90,
    deaths: 30,
    assists: 30,
    avg_score: null,
    mvps: 1,
    aces: 5,
  }),
  champ(2, {
    games: 10,
    wins: 9,
    kills: 10,
    deaths: 0,
    assists: 10,
    avg_score: 9,
    mvps: 4,
    double_kills: 1,
    penta_kills: 1,
  }),
  champ(3, {
    games: 20,
    wins: 10,
    kills: 20,
    deaths: 10,
    assists: 30,
    avg_score: 7,
    mvps: 2,
    aces: 2,
    triple_kills: 3,
  }),
];

function order(
  sortKey: SortKey,
  sortDir: "asc" | "desc",
  minGames?: number,
  matches: (c: ChampionStats) => boolean = () => true,
) {
  return filterAndSort(ROWS, { minGames, sortKey, sortDir, matches }).map((c) => c.champion_id);
}

describe("Champions row order", () => {
  test("games", () => {
    expect(order("games", "desc")).toEqual([1, 3, 2]);
    expect(order("games", "asc")).toEqual([2, 3, 1]);
  });

  test("win rate sorts by the ratio, not the win count", () => {
    expect(order("wins", "desc")).toEqual([2, 3, 1]);
  });

  test("a champion with no deaths has the highest KDA", () => {
    expect(order("kda", "desc")).toEqual([2, 3, 1]);
    expect(order("kda", "asc")).toEqual([1, 3, 2]);
  });

  test("an unscored champion sorts below every scored one", () => {
    expect(order("avg_score", "desc")).toEqual([2, 3, 1]);
    expect(order("avg_score", "asc")).toEqual([1, 3, 2]);
  });

  test("badges, then MVPs and ACEs on their own", () => {
    expect(order("badges", "desc")).toEqual([1, 2, 3]);
    expect(order("mvps", "desc")).toEqual([2, 3, 1]);
    expect(order("aces", "desc")).toEqual([1, 3, 2]);
  });

  test("multikills in total, then each kind on its own", () => {
    expect(order("multikills", "desc")).toEqual([3, 2, 1]);
    expect(order("double_kills", "desc")[0]).toBe(2);
    expect(order("triple_kills", "desc")[0]).toBe(3);
    expect(order("penta_kills", "desc")[0]).toBe(2);
  });

  test("minimum games and the name match narrow the list", () => {
    expect(order("games", "desc", 20)).toEqual([1, 3]);
    expect(order("games", "desc", undefined, (c) => c.champion_id === 2)).toEqual([2]);
  });
});

describe("Champions search", () => {
  test("narrows on every keystroke, because the input listens to onInput", () => {
    const input = readFileSync(new URL("../components/SearchInput.tsx", import.meta.url), "utf8");
    expect(input).toContain("onInput={(e) => props.onChange(e.currentTarget.value)}");
    expect(input).not.toContain("onChange={(e)");
    const page = readFileSync(new URL("./Champions.tsx", import.meta.url), "utf8");
    expect(page).toMatch(/<SearchInput[^>]*onChange={setSearch}/s);
  });
});
