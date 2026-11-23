import { expect, test } from "bun:test";
import type { BackfillResult } from "../bindings";
import { readFileSync } from "node:fs";
import {
  backfillOutcome,
  backfillProgressLine,
  flipQueue,
  importProgressLine,
  parseHiddenQueues,
  toggleWrite,
} from "./settings-model";

const count = (n: number) => n.toLocaleString("en-US");
const day = () => "Jan 5, 2026";
const result = (over: Partial<BackfillResult>): BackfillResult => ({
  added: 4,
  scanned: 100,
  checked: 100,
  totalGames: 100,
  limit: null,
  cancelled: false,
  ...over,
});

// Every boolean the React page writes through its shared toggle, in page order
const BOOLEAN_SETTINGS = [
  "auto_start",
  "minimize_to_tray",
  "remember_filters",
  "hide_remakes",
  "auto_update",
  "show_release_notes",
  "auto_backup",
];

test("each boolean setting is wired through the shared toggle", () => {
  const source = readFileSync(new URL("./Settings.tsx", import.meta.url), "utf8");
  const wired = [...source.matchAll(/toggle\(\s*"([a-z_]+)"/g)].map((m) => m[1]);
  expect(wired).toEqual(BOOLEAN_SETTINGS);
});

test("a switch writes the opposite of its current value as a string", () => {
  for (const key of BOOLEAN_SETTINGS) {
    expect(toggleWrite(key, true)).toEqual([key, "false"]);
    expect(toggleWrite(key, false)).toEqual([key, "true"]);
  }
});

test("flipping a queue adds then removes it and stores a comma list", () => {
  const off = flipQueue(new Set(), 450);
  expect(off.setting).toBe("450");
  const two = flipQueue(off.next, 900);
  expect(two.setting).toBe("450,900");
  const back = flipQueue(two.next, 450);
  expect(back.setting).toBe("900");
  expect(flipQueue(back.next, 900).setting).toBe("");
});

test("hidden queues parse from the stored list, empty when unset", () => {
  expect([...parseHiddenQueues("450,900")]).toEqual([450, 900]);
  expect(parseHiddenQueues(null).size).toBe(0);
  expect(parseHiddenQueues("").size).toBe(0);
});

test("import and backfill progress lines read as in Electron", () => {
  expect(importProgressLine({ current: 1200, total: 5000, imported: 30 }, count)).toBe(
    "Importing game 1,200 of 5,000, 30 new so far",
  );
  expect(backfillProgressLine({ current: 1, total: 0, added: 0 }, count)).toBe(
    "Nothing new to check",
  );
  expect(backfillProgressLine({ current: 2, total: 10, added: 1 }, count)).toBe(
    "Checking game 2 of 10, 1 added so far",
  );
});

test("backfill outcomes cover added, none, cancelled and both limits", () => {
  expect(backfillOutcome(result({}), count, day)).toBe(
    "Added 4 game(s) from 100 found in your Riot history",
  );
  expect(backfillOutcome(result({ added: 0 }), count, day)).toBe(
    "No new Mayhem games found (100 games checked)",
  );
  expect(backfillOutcome(result({ cancelled: true }), count, day)).toBe(
    "Stopped after adding 4 game(s). Run it again to finish.",
  );
  expect(
    backfillOutcome(result({ limit: { kind: "service", historyStart: 1 } }), count, day),
  ).toContain("only goes back to Jan 5, 2026");
  expect(backfillOutcome(result({ limit: { kind: "paging" } }), count, day)).toContain(
    "100-game paging limit",
  );
});
