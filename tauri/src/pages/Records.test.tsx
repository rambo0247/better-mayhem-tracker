import { afterEach, beforeEach, expect, test } from "bun:test";
import { fake } from "../../test/fakeApi";
import { FAKE_API } from "../../test/parity-cases";
import { mount, settle } from "../../test/render";
import Records from "./Records";

let view: ReturnType<typeof mount> | undefined;

// The caches behind useChampionData outlive a test file, so every file seeds the same data
const CHAMPIONS = FAKE_API.getChampionData;

function match(over: Partial<Record<string, number>> = {}) {
  return {
    game_id: 7001,
    game_creation: Date.UTC(2025, 8, 12, 18, 30),
    game_duration: 1100,
    queue_id: 2400,
    champion_id: 1,
    win: 1,
    kills: 21,
    deaths: 3,
    assists: 14,
    ...over,
  };
}

const NO_BESTS = {
  kills: null,
  deaths: null,
  assists: null,
  kda: null,
  score: null,
  killingSpree: null,
  damage: null,
  damageTaken: null,
  healing: null,
  gold: null,
  fastestWin: null,
  longestGame: null,
};

const LOADED = {
  totalGames: 1234,
  bests: {
    ...NO_BESTS,
    kills: { value: 21, match: match() },
    gold: { value: 18450, match: match({ game_id: 7002, champion_id: 2, win: 0 }) },
  },
  winStreak: { length: 6, start: 1, end: 2, match: match({ game_id: 7003 }) },
  lossStreak: { length: 1, start: 3, end: 3, match: match({ game_id: 7004, win: 0 }) },
};

(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  invoke: () => Promise.resolve(),
};

const text = () => view!.container.textContent ?? "";
const buttons = () => [...view!.container.querySelectorAll("button")];
const cardTitled = (label: string) => buttons().find((b) => b.textContent?.includes(label))!;

beforeEach(() => {
  fake.reset();
  fake.returns.set("getChampionData", CHAMPIONS);
  fake.returns.set("getAllSummonerPuuids", ["puuid-1"]);
  fake.returns.set("getMatchFilterOptions", {
    patches: [],
    champions: [],
    queues: [420, 2400],
    seasons: [],
    accounts: [],
    hasFavorites: false,
  });
});

afterEach(() => {
  view?.dispose();
  view = undefined;
});

test("shows Loading until the records arrive", async () => {
  fake.returns.set("getRecords", LOADED);
  view = mount(() => <Records />);
  expect(text()).toContain("Loading…");
  expect(text()).not.toContain("Personal bests");
  await settle();
  expect(text()).not.toContain("Loading…");
  expect(text()).toContain("Personal bests across");
});

test("says to sync when no games are recorded and no filter is set", async () => {
  fake.returns.set("getRecords", { ...LOADED, totalGames: 0, bests: NO_BESTS });
  view = mount(() => <Records />);
  await settle();
  expect(text()).toContain(
    "No games recorded yet — sync your match history to start setting records.",
  );
  expect(text()).not.toContain("Single-game bests");
});

test("says no games match when a filter leaves nothing, and keeps the filter on screen", async () => {
  fake.returns.set("getRecords", { ...LOADED, totalGames: 0, bests: NO_BESTS });
  view = mount(() => <Records />);
  await settle();
  const select = view.container.querySelector("select")!;
  select.value = "2400";
  select.dispatchEvent(new Event("change", { bubbles: true }));
  await settle();
  expect(text()).toContain("No games match this filter.");
  expect(view.container.querySelector("select")).not.toBeNull();
  expect(fake.calls.filter((c) => c.method === "getRecords").at(-1)!.args).toEqual([
    2400,
    undefined,
  ]);
});

test("lists the single-game bests and the streaks with the total game count", async () => {
  fake.returns.set("getRecords", LOADED);
  view = mount(() => <Records />);
  await settle();
  expect(text()).toContain("Personal bests across 1,234 games");
  expect(text()).toContain("Single-game bests");
  expect(text()).toContain("Most Kills");
  expect(text()).toContain("Most Gold Earned");
  expect(text()).toContain("18,450");
  expect(text()).toContain("Streaks");
  expect(text()).toContain("Annie");
  expect(text()).toContain("Champion 2");
});

test("counts a single game in the singular", async () => {
  fake.returns.set("getRecords", { ...LOADED, totalGames: 1 });
  view = mount(() => <Records />);
  await settle();
  expect(text()).toContain("Personal bests across 1 game");
  expect(text()).not.toContain("1 games");
});

test("shows a loss streak only from two games", async () => {
  fake.returns.set("getRecords", LOADED);
  view = mount(() => <Records />);
  await settle();
  expect(view.container.querySelectorAll("button[title='View match']").length).toBe(3);

  view.dispose();
  fake.returns.set("getRecords", {
    ...LOADED,
    lossStreak: { length: 2, start: 3, end: 4, match: match({ game_id: 7004, win: 0 }) },
  });
  view = mount(() => <Records />);
  await settle();
  expect(view.container.querySelectorAll("button[title='View match']").length).toBe(4);
});

test("clicking a record opens its match and Escape closes it", async () => {
  fake.returns.set("getRecords", LOADED);
  view = mount(() => <Records />);
  await settle();
  expect(text()).not.toContain("VICTORY");

  cardTitled("Most Kills").click();
  await settle();
  expect(text()).toContain("VICTORY");
  expect(text()).toContain("Loading…");
  expect(fake.calls.find((c) => c.method === "getMatchDetail")!.args).toEqual([7001]);

  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  await settle();
  expect(text()).not.toContain("VICTORY");
});

test("the modal's close button dismisses it", async () => {
  fake.returns.set("getRecords", LOADED);
  view = mount(() => <Records />);
  await settle();
  cardTitled("Most Gold Earned").click();
  await settle();
  expect(text()).toContain("DEFEAT");

  view.container.querySelector<HTMLButtonElement>("button[title='Close']")!.click();
  await settle();
  expect(text()).not.toContain("DEFEAT");
});

test("reloads the records when new games land", async () => {
  fake.returns.set("getRecords", LOADED);
  view = mount(() => <Records />);
  await settle();
  const before = fake.calls.filter((c) => c.method === "getRecords").length;
  fake.returns.set("getRecords", { ...LOADED, totalGames: 1300 });
  fake.emit("onGamesUpdated");
  await settle();
  expect(fake.calls.filter((c) => c.method === "getRecords").length).toBe(before + 1);
  expect(text()).toContain("Personal bests across 1,300 games");
});
