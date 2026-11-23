import { describe, expect, test } from "bun:test";
import { html, loaded } from "../testing/ssr";

const { default: Friends, friendPath, groupPath } = await import("./Friends");

const player = (key: string, name: string, games: number) => ({
  key,
  name,
  puuid: key,
  profileIcon: 1,
  games,
  wins: games - 1,
  kills: games * 5,
  deaths: games * 2,
  assists: games * 7,
  champions: [{ champion_id: 1, games }],
  lastPlayed: Date.now(),
});

describe("Friends", () => {
  test("shows Loading until both lists answer", () => {
    expect(html(Friends, loaded(null), loaded([]))).toContain("Loading…");
  });

  test("an empty list says nothing matches", () => {
    const out = html(Friends, loaded([]), loaded([]));
    expect(out).toContain("No players match the current search and filters.");
  });

  test("lists the players that meet the minimum", () => {
    const out = html(
      Friends,
      loaded([player("p1", "Ana#EUW", 12), player("p2", "Bo#EUW", 1)]),
      loaded([]),
    );
    expect(out).toContain("Ana");
    expect(out).not.toContain(">Bo<");
  });

  test("a row opens the encoded key", () => {
    expect(friendPath("a b#c/d")).toBe("/friends/a%20b%23c%2Fd");
    expect(groupPath("k1+k2#x")).toBe("/friends/groups/k1%2Bk2%23x");
  });
});
