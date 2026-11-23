import { afterEach, beforeEach, expect, test } from "bun:test";
import { createRouter, memoryHistory } from "@solidjs/router";
import { fake } from "../../test/fakeApi";
import { FAKE_API } from "../../test/parity-cases";
import { mount, settle } from "../../test/render";
import SeasonRecap from "./SeasonRecap";

let view: ReturnType<typeof mount> | undefined;

(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  invoke: () => Promise.resolve(),
};
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const SEASONS = [
  { id: "set-2", name: "Set 2", start: "2026-06-10", end: "2026-10-20", games: 0 },
  { id: "set-3", name: "Set 3", start: "2026-10-21", end: null, games: 2 },
  { id: "all", name: "All time", start: null, end: null, games: 2 },
];

const NO_RECORD = {
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

function recap(over: Record<string, unknown> = {}) {
  const day = new Date(2026, 10, 3).getTime();
  return {
    season: SEASONS[1],
    seasons: SEASONS,
    player: { gameName: "Rambo", tagLine: "NA1", profileIcon: 1 },
    accounts: 1,
    patch: null,
    firstGame: day,
    lastGame: day + 3_600_000,
    games: 2,
    wins: 1,
    duration: 2400,
    days: [{ day, games: 2, wins: 1 }],
    busiestDay: { day, games: 2, wins: 1 },
    dayStreak: null,
    peakHour: 20,
    topWeekday: 2,
    kills: 20,
    deaths: 10,
    assists: 30,
    damage: 50000,
    damageTaken: 40000,
    healing: 1000,
    gold: 24000,
    multikills: { doubles: 1, triples: 0, quadras: 0, pentas: 0 },
    killParticipation: 0.5,
    damageShare: 0.25,
    avgScore: 5.5,
    mvps: 0,
    aces: 0,
    scoredWins: 1,
    scoredLosses: 1,
    champions: [
      { champion_id: 1, games: 2, wins: 1, kills: 20, deaths: 10, assists: 30, avgScore: 5.5 },
    ],
    uniqueChampions: 1,
    augments: [],
    items: [],
    records: { totalGames: 2, bests: NO_RECORD, winStreak: null, lossStreak: null },
    friends: [],
    ...over,
  };
}

function page(url = "/") {
  const Router = createRouter({
    routes: [{ path: "/", component: SeasonRecap }],
    history: memoryHistory(url),
  });
  return mount(() => <Router>{(props) => props.children}</Router>);
}

const text = () => view!.container.textContent ?? "";
const button = (label: string) =>
  [...view!.container.querySelectorAll("button")].find((b) => b.textContent?.includes(label));

beforeEach(() => {
  fake.reset();
  fake.returns.set("getChampionData", FAKE_API.getChampionData);
  fake.returns.set("getItemData", FAKE_API.getItemData);
  fake.returns.set("getAugmentData", FAKE_API.getAugmentData);
  fake.returns.set("getMatchFilterOptions", {
    patches: [],
    champions: [],
    queues: [],
    seasons: [],
    accounts: [],
    hasFavorites: false,
  });
  fake.returns.set("getSeasonRecap", recap());
});

afterEach(() => {
  view?.dispose();
  view = undefined;
});

test("shows Loading until the recap arrives", async () => {
  view = page();
  expect(text()).toContain("Loading...");
  await settle();
  expect(text()).not.toContain("Loading...");
  expect(text()).toContain("Season Recap");
});

test("offers every season with its game count, and the export buttons, when games exist", async () => {
  view = page();
  await settle();
  expect(text()).toContain("Set 3 (2 games)");
  expect(text()).toContain("All time (2 games)");
  expect(text()).toContain("Set 2 (0 games)");
  expect(button("Copy Image")).toBeDefined();
  expect(button("Export PNG")).toBeDefined();
  expect(text()).toContain("Rambo");
});

test("an empty season says so and offers nothing to export", async () => {
  fake.returns.set("getSeasonRecap", recap({ games: 0, wins: 0, days: [], season: SEASONS[0] }));
  view = page();
  await settle();
  expect(text()).toContain("No games recorded in this season.");
  expect(button("Copy Image")).toBeUndefined();
  expect(button("Export PNG")).toBeUndefined();
});

test("a season with no games under the queue filter says the filter is why", async () => {
  fake.returns.set("getMatchFilterOptions", {
    patches: [],
    champions: [],
    queues: [420, 2400],
    seasons: [],
    accounts: [],
    hasFavorites: false,
  });
  view = page();
  await settle();
  fake.returns.set("getSeasonRecap", recap({ games: 0, wins: 0, days: [] }));
  const queue = [...view.container.querySelectorAll("select")].find((s) =>
    s.textContent?.includes("All Queues"),
  )!;
  queue.value = "2400";
  queue.dispatchEvent(new Event("change", { bubbles: true }));
  await settle();
  expect(text()).toContain("No games in this season match this filter.");
  const last = fake.calls.filter((c) => c.method === "getSeasonRecap").at(-1)!;
  expect(last.args).toEqual([undefined, 2400, undefined]);
});

test("Hide friends only appears with friends and toggles", async () => {
  view = page();
  await settle();
  expect(button("Hide friends")).toBeUndefined();

  view.dispose();
  const friend = {
    key: "f1",
    name: "Sidekick",
    puuid: "p1",
    profileIcon: 2,
    games: 2,
    wins: 1,
    kills: 1,
    deaths: 1,
    assists: 1,
    champions: [{ champion_id: 1, games: 2 }],
    lastPlayed: Date.now(),
  };
  fake.returns.set("getSeasonRecap", recap({ friends: [friend] }));
  view = page();
  await settle();
  const hide = button("Hide friends")!;
  expect(hide.getAttribute("aria-pressed")).toBe("false");
  expect(text()).toContain("Sidekick");
  hide.click();
  await settle();
  expect(button("Hide friends")!.getAttribute("aria-pressed")).toBe("true");
  expect(text()).not.toContain("Sidekick");
});

test("Export PNG shows the failure text the command gives", async () => {
  fake.returns.set("exportCardImage", { success: false, error: "not ported" });
  view = page();
  await settle();
  button("Export PNG")!.click();
  await settle();
  expect(text()).toContain("not ported");
  expect(fake.calls.find((c) => c.method === "exportCardImage")!.args).toEqual([
    { kind: "season", seasonId: "set-3", queue: undefined, account: undefined, hideFriends: false },
  ]);
});

test("the ?season= link picks that season and is then dropped from the address", async () => {
  const history = memoryHistory("/?season=set-2");
  const Router = createRouter({
    routes: [{ path: "/", component: SeasonRecap }],
    history,
  });
  view = mount(() => <Router>{(props) => props.children}</Router>);
  await settle();
  expect(fake.calls.find((c) => c.method === "getSeasonRecap")!.args[0]).toBe("set-2");
  expect(history.get()).not.toContain("season=");
});
