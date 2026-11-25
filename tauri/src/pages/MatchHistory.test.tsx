import { afterEach, beforeEach, expect, test } from "bun:test";
import { createRouter, memoryHistory } from "@solidjs/router";
import { fake } from "../../test/fakeApi";
import { FAKE_API } from "../../test/parity-cases";
import { mount, settle } from "../../test/render";
import { dropdown, pick } from "../../test/select";
import MatchHistory from "./MatchHistory";

let view: ReturnType<typeof mount> | undefined;

(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  invoke: () => Promise.resolve(),
};

// Happy-dom has no layout, so a test says when the sentinel scrolls into view
class FakeObserver {
  static live = new Set<FakeObserver>();
  target: Element | null = null;
  constructor(private callback: (entries: { isIntersecting: boolean }[]) => void) {}
  observe(el: Element) {
    this.target = el;
    FakeObserver.live.add(this);
  }
  unobserve() {}
  disconnect() {
    FakeObserver.live.delete(this);
  }
  intersect() {
    this.callback([{ isIntersecting: true }]);
  }
}
(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = FakeObserver;

const PAGE_SIZE = 20;
const TOTAL = 25;
const NOW = Date.now();

function game(id: number) {
  return {
    game_id: id,
    queue_id: 2400,
    game_creation: NOW - id * 60_000,
    game_duration: 1100,
    is_remake: 0,
    favorite: 0,
    champion_id: 1,
    win: id % 2,
    kills: 5,
    deaths: 3,
    assists: 7,
    double_kills: 0,
    triple_kills: 0,
    quadra_kills: 0,
    penta_kills: 0,
    total_damage_dealt: 1000,
    total_damage_taken: 1000,
    total_heal: 0,
    gold_earned: 9000,
    item0: null,
    item1: null,
    item2: null,
    item3: null,
    item4: null,
    item5: null,
    score: null,
    score_badge: null,
    spell1: null,
    spell2: null,
    augment_ids: null,
    game_version: null,
    game_max_dmg: 1000,
    game_max_taken: 1000,
    game_max_heal: 0,
  };
}

const historyCalls: { limit: number; offset: number }[] = [];

// A list of TOTAL games served a page at a time, as the database does
function serveGames() {
  const api = (window as unknown as { api: Record<string, unknown> }).api;
  api.getMatchHistory = (limit: number, offset: number) => {
    historyCalls.push({ limit, offset });
    const matches = Array.from({ length: Math.min(limit, TOTAL - offset) }, (_, i) =>
      game(offset + i + 1),
    );
    return Promise.resolve({ matches, total: TOTAL });
  };
}

function page() {
  const Router = createRouter({
    routes: [{ path: "/", component: MatchHistory }],
    history: memoryHistory("/"),
  });
  return mount(() => <Router>{(props) => props.children}</Router>);
}

const text = () => view!.container.textContent ?? "";
const rowButtons = () => [...view!.container.querySelectorAll<HTMLElement>("[data-match-row]")];
const rowNodes = () => rowButtons().map((b) => b.parentElement!);
const sentinel = () => [...FakeObserver.live].at(-1);

beforeEach(() => {
  fake.reset();
  historyCalls.length = 0;
  FakeObserver.live.clear();
  for (const [method, value] of Object.entries(FAKE_API)) fake.returns.set(method, value);
  fake.returns.set("getMatchHistory", { matches: [], total: 0 });
});

afterEach(() => {
  view?.dispose();
  view = undefined;
  delete (window as unknown as { api: Record<string, unknown> }).api.getMatchHistory;
});

test("says it is waiting for the League client while there is none and no games", async () => {
  view = page();
  await settle();
  expect(rowButtons().length).toBe(0);
  expect(text()).toContain(
    "Waiting for the League client. Once it's open, your Mayhem games import automatically.",
  );
});

test("says no games were found once the client is connected", async () => {
  fake.returns.set("getLcuStatus", "connected");
  view = page();
  await settle();
  expect(text()).toContain("No ARAM Mayhem games found yet. New games are recorded as you play.");
  expect(text()).not.toContain("Waiting for the League client");
});

test("reports the import while one runs, and how far along it is", async () => {
  fake.returns.set("isBackfillRunning", true);
  view = page();
  await settle();
  expect(text()).toContain("Importing your match history...");

  fake.emit("onBackfillProgress", { current: 50, total: 1000 });
  await settle();
  expect(text()).toContain("Importing your match history — 50 of 1,000 games checked...");
});

test("a filter that leaves nothing says so, and Clear filters brings the other message back", async () => {
  fake.returns.set("getMatchFilterOptions", {
    patches: [],
    champions: [1],
    queues: [],
    seasons: [],
    accounts: [],
    hasFavorites: false,
  });
  view = page();
  await settle();
  const champion = dropdown(view.container, "All Champions");
  await pick(champion, champion.querySelectorAll('[aria-hidden="true"]')[1]!.textContent!);
  expect(text()).toContain("No games match the current filters.");

  [...view.container.querySelectorAll("button")]
    .find((b) => b.textContent === "Clear filters")!
    .click();
  await settle();
  expect(text()).not.toContain("No games match the current filters.");
  expect(text()).toContain("Waiting for the League client");
});

test("loads the first page, and the second when the sentinel intersects", async () => {
  serveGames();
  view = page();
  await settle();
  expect(rowButtons().length).toBe(PAGE_SIZE);
  expect(historyCalls).toEqual([{ limit: PAGE_SIZE, offset: 0 }]);
  expect(sentinel()).toBeDefined();

  sentinel()!.intersect();
  await settle();
  expect(historyCalls).toEqual([
    { limit: PAGE_SIZE, offset: 0 },
    { limit: PAGE_SIZE, offset: PAGE_SIZE },
  ]);
  expect(rowButtons().length).toBe(TOTAL);
  expect(view.container.querySelector(".h-1")).toBeNull();
  expect([...FakeObserver.live].every((o) => !o.target!.isConnected)).toBe(true);
});

test("a second page leaves the rows already on screen in place", async () => {
  serveGames();
  view = page();
  await settle();
  const before = rowNodes();

  sentinel()!.intersect();
  await settle();
  const after = rowNodes();
  expect(after.length).toBe(TOTAL);
  expect(after.slice(0, PAGE_SIZE).every((node, i) => node === before[i])).toBe(true);
});

test("expanding a row leaves every other row's node in place", async () => {
  serveGames();
  view = page();
  await settle();
  const before = rowNodes();
  const buttons = rowButtons();
  expect(buttons.every((b) => b.getAttribute("aria-expanded") === "false")).toBe(true);

  buttons[2]!.click();
  await settle();
  expect(fake.calls.find((c) => c.method === "getMatchDetail")!.args).toEqual([3]);
  expect(buttons[2]!.getAttribute("aria-expanded")).toBe("true");
  expect(buttons.filter((b) => b.getAttribute("aria-expanded") === "true").length).toBe(1);

  const after = rowNodes();
  expect(after.length).toBe(before.length);
  expect(after.every((node, i) => node === before[i])).toBe(true);
  expect(rowButtons().every((b, i) => b === buttons[i])).toBe(true);
});

test("opening another row collapses the first without rebuilding either", async () => {
  serveGames();
  view = page();
  await settle();
  const before = rowNodes();
  const buttons = rowButtons();

  buttons[0]!.click();
  await settle();
  buttons[1]!.click();
  await settle();
  expect(buttons[0]!.getAttribute("aria-expanded")).toBe("false");
  expect(buttons[1]!.getAttribute("aria-expanded")).toBe("true");
  expect(rowNodes().every((node, i) => node === before[i])).toBe(true);
});
