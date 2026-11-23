import { afterEach, beforeEach, expect, test } from "bun:test";
import { fake } from "../../test/fakeApi";
import { FAKE_API } from "../../test/parity-cases";
import { mount, settle } from "../../test/render";
import Augments from "./Augments";

let view: ReturnType<typeof mount> | undefined;

// The caches behind the champion and augment hooks outlive a test file, so
// every file seeds the same data; ids it does not name render as unknown
const CHAMPIONS = FAKE_API.getChampionData;
const AUGMENTS = FAKE_API.getAugmentData;

const champs = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ champion_id: i + 1, picks: 100 - i, wins: 10 }));

const STATS = {
  totalGames: 200,
  augments: [
    { augment_id: 201, picks: 50, wins: 30, champions: champs(7) },
    { augment_id: 202, picks: 20, wins: 5, champions: champs(1) },
    { augment_id: 999, picks: 80, wins: 40, champions: champs(2) },
  ],
};

(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  invoke: () => Promise.resolve(),
};

const text = () => view!.container.textContent ?? "";
const rows = () => [...view!.container.querySelectorAll<HTMLElement>("tbody tr[aria-expanded]")];
const names = () => rows().map((r) => r.children[1]!.textContent!.replace(/^\W+/, ""));
const click = (el: Element | undefined) => {
  el!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  return settle();
};
const button = (label: string) =>
  [...view!.container.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
const header = (label: string) =>
  [...view!.container.querySelectorAll("th")].find((h) => h.textContent?.trim() === label);

beforeEach(() => {
  fake.reset();
  fake.returns.set("getChampionData", CHAMPIONS);
  fake.returns.set("getAugmentData", AUGMENTS);
  fake.returns.set("getAugmentStatsDetailed", STATS);
  fake.returns.set("getMatchFilterOptions", {
    patches: [],
    champions: [],
    queues: [],
    seasons: [],
    accounts: [],
    hasFavorites: false,
  });
  fake.returns.set("getPatches", []);
});

afterEach(() => {
  view?.dispose();
  view = undefined;
});

test("shows Loading until the stats arrive", async () => {
  view = mount(() => <Augments />);
  expect(text()).toContain("Loading...");
  expect(text()).not.toContain("Augment");
  await settle();
  expect(text()).not.toContain("Loading...");
  expect(text()).toContain("Augments");
});

test("lists every augment with its counts and the game total", async () => {
  view = mount(() => <Augments />);
  await settle();
  expect(text()).toContain("3 augments");
  expect(text()).toContain("200 games");
  expect(names()).toEqual(["Unknown augment 999", "Back To Basics", "Pentakill"]);
  const unknown = rows()[0]!.textContent!;
  expect(unknown).toContain("80");
  expect(unknown).toContain("40.0%");
  expect(unknown).toContain("50.0%");
  expect(rows()[1]!.textContent).toContain("Gold");
  expect(rows()[1]!.textContent).toContain("25.0%");
  expect(rows()[1]!.textContent).toContain("60.0%");
  expect(rows()[2]!.textContent).toContain("Prismatic");
});

test("a champion list longer than five folds the rest into a count", async () => {
  view = mount(() => <Augments />);
  await settle();
  expect(rows()[1]!.textContent).toContain("+2");
  expect(rows()[0]!.textContent).not.toContain("+");
});

test("filtering to a rarity keeps only that rarity and updates the count", async () => {
  view = mount(() => <Augments />);
  await settle();
  await click(button("Prismatic"));
  expect(names()).toEqual(["Pentakill"]);
  expect(text()).toContain("1 augment");
  expect(text()).not.toContain("1 augments");
  expect(button("Prismatic")!.getAttribute("aria-pressed")).toBe("true");
  await click(button("All"));
  expect(names().length).toBe(3);
});

test("searching narrows the rows by augment name", async () => {
  view = mount(() => <Augments />);
  await settle();
  const input = view.container.querySelector<HTMLInputElement>("input[type=text]")!;
  input.value = "back to";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
  expect(names()).toEqual(["Back To Basics"]);
});

test("shows the empty state when nothing matches", async () => {
  view = mount(() => <Augments />);
  await settle();
  const input = view.container.querySelector<HTMLInputElement>("input[type=text]")!;
  input.value = "nothing called this";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
  expect(rows().length).toBe(0);
  expect(text()).toContain("No augments match these filters. Try another rarity or search.");
  expect(text()).toContain("0 augments");
});

test("shows the empty state when there are no augments at all", async () => {
  fake.returns.set("getAugmentStatsDetailed", { totalGames: 0, augments: [] });
  view = mount(() => <Augments />);
  await settle();
  expect(text()).toContain("No augments match these filters.");
});

test("clicking a column sorts by it and clicking again reverses it", async () => {
  view = mount(() => <Augments />);
  await settle();
  await click(header("Win Rate"));
  expect(names()).toEqual(["Back To Basics", "Unknown augment 999", "Pentakill"]);
  await click(header("Win Rate"));
  expect(names()).toEqual(["Pentakill", "Unknown augment 999", "Back To Basics"]);
  await click(header("Augment"));
  expect(names()).toEqual(["Back To Basics", "Pentakill", "Unknown augment 999"]);
  await click(header("Augment"));
  expect(names()).toEqual(["Unknown augment 999", "Pentakill", "Back To Basics"]);
});

test("expanding a row lists its champions beneath it and collapses again", async () => {
  view = mount(() => <Augments />);
  await settle();
  const before = rows().length;
  const bodyRows = () => view!.container.querySelectorAll("tbody tr").length;
  expect(bodyRows()).toBe(before);

  const basics = rows()[1]!;
  expect(basics.getAttribute("aria-expanded")).toBe("false");
  await click(basics);
  expect(basics.getAttribute("aria-expanded")).toBe("true");
  expect(bodyRows()).toBe(before + 7);
  expect(basics.nextElementSibling!.textContent).toContain("Annie");
  expect(basics.nextElementSibling!.nextElementSibling!.textContent).toContain("Champion 2");

  await click(basics);
  expect(basics.getAttribute("aria-expanded")).toBe("false");
  expect(bodyRows()).toBe(before);
});

test("reloads the stats when new games land", async () => {
  view = mount(() => <Augments />);
  await settle();
  const count = () => fake.calls.filter((c) => c.method === "getAugmentStatsDetailed").length;
  const before = count();
  fake.returns.set("getAugmentStatsDetailed", { ...STATS, totalGames: 300 });
  fake.emit("onGamesUpdated");
  await settle();
  expect(count()).toBe(before + 1);
  expect(text()).toContain("300 games");
});
