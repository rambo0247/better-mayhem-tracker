import { describe, expect, test } from "bun:test";
import { html, loaded, pending, route } from "../testing/ssr";

const { default: FriendDetail } = await import("./FriendDetail");

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
  score_badge: "MVP",
};

const detail = {
  player: {
    key: "puuid-1",
    name: "Ana#EUW",
    puuid: "puuid-1",
    profileIcon: 1,
    games: 1,
    wins: 1,
    kills: 4,
    deaths: 2,
    assists: 6,
    champions: [{ champion_id: 1, games: 1, wins: 1, kills: 4, deaths: 2, assists: 6 }],
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
      friend: line,
    },
  ],
};

describe("FriendDetail", () => {
  test("shows Loading before the first answer", () => {
    route.params = { key: "puuid-1" };
    expect(html(FriendDetail, pending)).toContain("Loading…");
  });

  test("no shared games says so, with the way back", () => {
    route.params = { key: "gone" };
    const out = html(FriendDetail, loaded(null));
    expect(out).toContain("No games found with this player.");
    expect(out).toContain('href="#/friends"');
  });

  test("a friend's games and champions are listed", () => {
    route.params = { key: "puuid-1" };
    const out = html(FriendDetail, loaded(detail));
    expect(out).toContain("Ana");
    expect(out).toContain("Their Champions");
    expect(out).toContain("Games Played Together");
    expect(out).toContain("VICTORY");
  });
});
