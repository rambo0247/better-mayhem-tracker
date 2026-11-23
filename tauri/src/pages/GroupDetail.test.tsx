import { describe, expect, test } from "bun:test";
import { html, loaded, mountPage, pending, route } from "../testing/ssr";

const { default: GroupDetail } = await import("./GroupDetail");

const line = {
  champion_id: 1,
  win: 1,
  kills: 4,
  deaths: 2,
  assists: 6,
  total_damage_dealt: 1000,
  total_damage_taken: 800,
  total_heal: 0,
  score: 7.5,
  score_badge: null,
};

const member = (key: string, name: string) => ({ key, name, profileIcon: 1 });

const detail = {
  group: {
    key: "a b+c#d",
    members: [member("a b", "Ana#EUW"), member("c#d", "Bo#EUW")],
    games: 1,
    wins: 1,
    kills: 12,
    deaths: 6,
    assists: 18,
    lastPlayed: Date.now(),
  },
  matches: [
    {
      ...line,
      game_id: 10,
      game_creation: Date.now(),
      game_duration: 1500,
      game_max_dmg: 2000,
      game_max_taken: 2000,
      game_max_heal: 100,
      members: [line, line],
    },
  ],
};

const profile = { name: "Me#EUW", profileIcon: 2 };

describe("GroupDetail", () => {
  test("shows Loading before the first answer", () => {
    route.params = { key: "k" };
    expect(html(GroupDetail, pending, loaded(profile))).toContain("Loading…");
  });

  test("an unknown group says so, and goes back to the groups view", () => {
    route.params = { key: "gone" };
    route.navigations = [];
    const view = mountPage(GroupDetail, loaded(null), loaded(profile));
    expect(view.container.textContent).toContain("No games found with this group.");
    view.container.querySelector<HTMLAnchorElement>('a[href="#/friends"]')!.click();
    view.dispose();
    expect(route.navigations).toEqual([{ to: "/friends", options: { state: { view: "groups" } } }]);
  });

  test("each member chip links to the friend by encoded key", () => {
    route.params = { key: "a b+c#d" };
    const out = html(GroupDetail, loaded(detail), loaded(profile));
    expect(out).toContain("Group Members");
    expect(out).toContain('href="#/friends/a%20b"');
    expect(out).toContain('href="#/friends/c%23d"');
    expect(out).toContain("Trio");
  });
});
