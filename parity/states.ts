import type { Page } from "playwright";
import { expand, restoreSettings, runStep, type DriveContext, type Step } from "./drive.ts";
import { settle, type SettleReport } from "./settle.ts";

export type Viewport = { width: number; height: number };

export interface StateRow {
  id: string;
  /** Selector for a group of states, as in `capture.ts --states <group>`. */
  group: "default" | "rail" | "match-history" | "champions" | "global" | "card" | "trends";
  /** Hash route, with {vars} resolved from the data before the state runs. */
  route: string;
  viewport: Viewport;
  /** Run before the page loads: localStorage seeds and settings. */
  pre?: Step[];
  /** Run after the page settles. The state settles again once they finish. */
  steps?: Step[];
  /** Text or selector that must be on the page, so a blank page never passes as a baseline. */
  expect: string;
  /** Card routes publish a status the capture waits on. */
  card?: boolean;
}

const FULL: Viewport = { width: 1280, height: 820 };
const CARD: Viewport = { width: 1200, height: 820 };
const row = (
  id: string,
  group: StateRow["group"],
  route: string,
  expectSelector: string,
  extra: Partial<StateRow> = {},
): StateRow => ({
  id,
  group,
  route,
  viewport: FULL,
  expect: expectSelector,
  ...extra,
});

const FIRST_MATCH_ROW = "button.group.relative.flex.w-full";

export const STATES: StateRow[] = [
  row("match-history-default", "default", "/", FIRST_MATCH_ROW),
  row("live-game-default", "default", "/live", "main"),
  row("champions-default", "default", "/champions", "table tbody tr"),
  row("augments-default", "default", "/augments", "table tbody tr"),
  row("trends-default", "default", "/trends", "svg"),
  row("global-stats-default", "default", "/global", "table tbody tr"),
  row("global-champion-detail-default", "default", "/global/champion/{championId}", "table"),
  row("friends-default", "default", "/friends", "table tbody tr"),
  row("friend-detail-default", "default", "/friends/{friendKey}", "main"),
  row("group-detail-default", "default", "/friends/groups/{groupKey}", "main"),
  row("records-default", "default", "/records", "main"),
  row("season-recap-default", "default", "/season", "main"),
  row("challenges-default", "default", "/challenges", "main"),
  row("settings-default", "default", "/settings", "main"),
  row("game-card-default", "card", "/card/{gameId}", "body.card-window", {
    viewport: CARD,
    card: true,
  }),
  row("season-card-default", "card", "/season-card/{seasonId}", "body.card-window", {
    viewport: CARD,
    card: true,
  }),

  row("match-history-rail-1179", "rail", "/", FIRST_MATCH_ROW, {
    viewport: { width: 1179, height: 820 },
  }),
  row("match-history-narrow-900", "rail", "/", FIRST_MATCH_ROW, {
    viewport: { width: 900, height: 820 },
  }),

  row("match-history-expanded", "match-history", "/", FIRST_MATCH_ROW, {
    steps: [
      { op: "click", selector: FIRST_MATCH_ROW },
      { op: "wait", ms: 800 },
    ],
  }),
  row("match-history-sorted-score", "match-history", "/", FIRST_MATCH_ROW, {
    pre: [{ op: "local", key: "view:matches.sort", value: '"score"' }],
  }),
  row("match-history-favorites", "match-history", "/", FIRST_MATCH_ROW, {
    pre: [{ op: "local", key: "view:matches.favorites", value: "true" }],
  }),
  row("match-history-no-matches", "match-history", "/", "main", {
    pre: [{ op: "local", key: "view:matches.queue", value: "999" }],
  }),

  row("champions-expanded", "champions", "/champions", "table tbody tr", {
    steps: [
      { op: "click", selector: "table tbody tr" },
      { op: "waitFor", selector: "text=Top Augments" },
      { op: "wait", ms: 800 },
    ],
  }),

  row("global-stats-augments", "global", "/global", "table tbody tr", {
    steps: [{ op: "click", selector: ".seg-item", text: "Augments" }],
  }),
  row("global-stats-items", "global", "/global", "table tbody tr", {
    steps: [{ op: "click", selector: ".seg-item", text: "Items" }],
  }),

  row("trends-weekly", "trends", "/trends", "svg", {
    pre: [{ op: "local", key: "view:trends.granularity", value: '"week"' }],
  }),
];

export const stateGroups = () => [...new Set(STATES.map((s) => s.group))];

export function selectStates(spec: string | undefined): StateRow[] {
  const all = STATES;
  if (!spec || spec === "all") return all;
  const wanted = spec.split(",");
  const picked = all.filter((s) => wanted.includes(s.id) || wanted.includes(s.group));
  const unknown = wanted.filter((w) => !STATES.some((s) => s.id === w || s.group === w));
  if (unknown.length > 0) {
    throw new Error(
      `unknown state or group: ${unknown.join(", ")}. Groups: ${stateGroups().join(", ")}`,
    );
  }
  return picked;
}

export async function resolveVars(page: Page): Promise<Record<string, string>> {
  return page.evaluate(async () => {
    const api = window.api as unknown as Record<string, (...args: unknown[]) => Promise<any>>;
    const history = await api.getMatchHistory!(1, 0);
    const seasons = (await api.getSeasons!()) as { id: string; games: number }[];
    const teammates = await api.getTeammateStats!();
    const groups = await api.getTeammateGroups!();
    const champions = await api.getChampionStats!();
    const withGames = seasons.filter((s) => s.games > 0);
    return {
      gameId: String(history.matches[0]?.game_id ?? ""),
      seasonId: withGames.at(-1)?.id ?? "",
      friendKey: encodeURIComponent(teammates[0]?.key ?? ""),
      groupKey: encodeURIComponent(groups[0]?.key ?? ""),
      championId: String(champions[0]?.champion_id ?? ""),
    };
  });
}

export interface StateOutcome {
  settle: SettleReport;
  card?: { state: string; height: number; error?: string };
  expectFound: boolean;
}

export async function applyState(
  ctx: DriveContext,
  state: StateRow,
  vars: Record<string, string>,
): Promise<StateOutcome> {
  const { page } = ctx;
  await restoreSettings(ctx);
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  for (const step of state.pre ?? []) await runStep(ctx, step, vars);

  ctx.viewport = { ...state.viewport };
  await ctx.resizeWindow(state.viewport.width, state.viewport.height);
  await page.evaluate((hash) => (location.hash = hash), "#" + expand(state.route, vars));
  await page.reload();
  await page.waitForLoadState("load");
  await settle(page, ctx.viewport);

  let card: StateOutcome["card"];
  if (state.card) {
    await page.waitForFunction(() => (window as any).__mayhemCardStatus, undefined, {
      timeout: 15_000,
    });
    card = await page.evaluate(() => (window as any).__mayhemCardStatus);
    if (card && card.state === "ready" && card.height > 0) {
      await ctx.resizeWindow(state.viewport.width, Math.max(card.height, 600));
    }
  }

  for (const step of state.steps ?? []) await runStep(ctx, step, vars);
  const report = await settle(page, ctx.viewport);
  const expectFound = (await page.locator(state.expect).count()) > 0;
  return { settle: report, card, expectFound };
}
