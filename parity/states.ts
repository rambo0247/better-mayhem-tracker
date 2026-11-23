import type { Page } from "playwright";
import { expand, restoreSettings, runStep, type DriveContext, type Step } from "./drive.ts";
import { settle, type SettleReport } from "./settle.ts";
import { CLIENT_STATES } from "./states-client.ts";
import { OVERLAY_STATES } from "./states-overlays.ts";

export type Viewport = { width: number; height: number };

export interface StateRow {
  id: string;
  group:
    | "default"
    | "rail"
    | "match-history"
    | "champions"
    | "global"
    | "card"
    | "trends"
    | "client"
    | "overlays";
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
  /** A data source this state needs instead of the run's, such as an empty database. */
  data?: "empty";
  /** Leaves the mouse where the steps put it, for a hover state. */
  holdPointer?: boolean;
  /** Captured only on this platform. An id named on its own always runs. */
  platform?: NodeJS.Platform;
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
const FILTERS_ACTIVE = 'button[title="Filters"].btn-active';
const FAVORITES_ON = 'button.btn-active:has-text("Favorites only")';
const sortDirection = (title: string) => `button[title="${title}"]`;

export const STATES: StateRow[] = [
  row("match-history-default", "default", "/", FIRST_MATCH_ROW),
  row("live-game-default", "default", "/live", 'h1.page-title:has-text("Live Game")'),
  row("champions-default", "default", "/champions", "table tbody tr"),
  row("augments-default", "default", "/augments", "table tbody tr"),
  row("trends-default", "default", "/trends", "svg"),
  row("global-stats-default", "default", "/global", "table tbody tr"),
  row("global-champion-detail-default", "default", "/global/champion/{championId}", "table"),
  row("friends-default", "default", "/friends", "table tbody tr"),
  row("friend-detail-default", "default", "/friends/{friendKey}", "h1.page-title .normal-case"),
  row(
    "group-detail-default",
    "default",
    "/friends/groups/{groupKey}",
    "h1.page-title .normal-case",
  ),
  row("records-default", "default", "/records", "h2.section-title"),
  row("season-recap-default", "default", "/season", 'h1.page-title:has-text("Season Recap")'),
  row("challenges-default", "default", "/challenges", "h2.section-title"),
  row("settings-default", "default", "/settings", 'h1.page-title:has-text("Settings")'),
  row("game-card-default", "card", "/card/{gameId}", "body.card-window", {
    viewport: CARD,
    card: true,
  }),
  row("season-card-default", "card", "/season-card/{seasonId}", "body.card-window", {
    viewport: CARD,
    card: true,
  }),
  row("season-card-numbered", "card", "/season-card/{numberedSeasonId}", "body.card-window", {
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
  row("match-history-sorted-score", "match-history", "/", sortDirection("Highest first"), {
    pre: [{ op: "local", key: "view:matches.sort", value: '"score"' }],
  }),
  row("match-history-favorites", "match-history", "/", FAVORITES_ON, {
    pre: [{ op: "local", key: "view:matches.favorites", value: "true" }],
  }),
  row("match-history-no-matches", "match-history", "/", "text=No games match the current filters", {
    // The app drops a filter value it does not offer, so this pairs two it does: neither
    // favorite in the fixture has a penta. The view keys only
    // take effect with remember_filters on, which applyState turns on for them.
    pre: [
      { op: "local", key: "view:matches.favorites", value: "true" },
      { op: "local", key: "view:matches.multikills", value: '["pentas"]' },
    ],
  }),
  row("match-history-grouped-week", "match-history", "/", FIRST_MATCH_ROW, {
    pre: [{ op: "setting", key: "session_grouping", value: "week" }],
  }),
  row("match-history-grouped-none", "match-history", "/", FIRST_MATCH_ROW, {
    pre: [{ op: "setting", key: "session_grouping", value: "none" }],
  }),
  row("match-history-oldest", "match-history", "/", sortDirection("Oldest first"), {
    pre: [{ op: "local", key: "view:matches.sortDir", value: '"asc"' }],
  }),
  row("match-history-sorted-score-ascending", "match-history", "/", sortDirection("Lowest first"), {
    pre: [
      { op: "local", key: "view:matches.sort", value: '"score"' },
      { op: "local", key: "view:matches.sortDir", value: '"asc"' },
    ],
  }),
  row("match-history-multikills-pressed", "match-history", "/", FILTERS_ACTIVE, {
    pre: [{ op: "local", key: "view:matches.multikills", value: '["doubles"]' }],
  }),
  row("match-history-filter-menu", "match-history", "/", "div.menu:not(.hidden)", {
    steps: [
      { op: "click", selector: 'button[title="Filters"]' },
      { op: "wait", ms: 300 },
    ],
  }),
  row("match-history-hide-remakes", "match-history", "/", FIRST_MATCH_ROW, {
    pre: [{ op: "setting", key: "hide_remakes", value: "true" }],
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

  row(
    "trends-weekly",
    "trends",
    "/trends",
    'button.seg-item[aria-pressed="true"]:has-text("Weekly")',
    {
      pre: [{ op: "local", key: "view:trends.granularity", value: '"week"' }],
    },
  ),

  // No games and no client: the waiting message, and the page without its dashboard header.
  row("match-history-empty-waiting", "match-history", "/", "main .panel", { data: "empty" }),
  ...CLIENT_STATES,

  ...OVERLAY_STATES,
];

export const stateGroups = () => [...new Set(STATES.map((s) => s.group))];

export function selectStates(spec: string | undefined): StateRow[] {
  const here = STATES.filter((s) => !s.platform || s.platform === process.platform);
  if (!spec || spec === "all") return here;
  const wanted = spec.split(",");
  const picked = STATES.filter(
    (s) => wanted.includes(s.id) || (wanted.includes(s.group) && here.includes(s)),
  );
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
    const seasons = (await api.getSeasons!()) as {
      id: string;
      games: number;
      start: string | null;
    }[];
    const teammates = await api.getTeammateStats!();
    const groups = await api.getTeammateGroups!();
    const champions = await api.getChampionStats!();
    const withGames = seasons.filter((s) => s.games > 0);
    return {
      gameId: String(history.matches[0]?.game_id ?? ""),
      seasonId: withGames.at(-1)?.id ?? "",
      numberedSeasonId: withGames.findLast((s) => s.start !== null)?.id ?? "",
      friendKey: encodeURIComponent(teammates[0]?.key ?? ""),
      groupKey: encodeURIComponent(groups[0]?.key ?? ""),
      championId: String(champions[0]?.champion_id ?? ""),
    };
  });
}

export interface StateOutcome {
  settle: SettleReport;
  card?: { state: string; height: number; error?: string };
  /** Card states: whether champion, augment and item data all loaded before the card did. */
  lookupsReady?: boolean;
  /** Card states: names the card drew from an id because a lookup was not back in time. */
  placeholders: string[];
  expectFound: boolean;
}

const PLACEHOLDER = /Unknown augment \d+|\bItem \d+\b/g;
export const LOOKUP_TIMEOUT_MS = 20_000;

/**
 * A card stops waiting for its lookups after the app's 3 s grace and draws ids instead. Asking
 * for the same data first fills the main process's caches, so the card's own requests return
 * at once.
 */
async function warmLookups(page: Page): Promise<boolean> {
  return page.evaluate(async (timeout) => {
    const api = window.api as unknown as Record<string, () => Promise<object | null>>;
    const deadline = Date.now() + timeout;
    for (;;) {
      const data = await Promise.all([
        api.getChampionData!(),
        api.getAugmentData!(),
        api.getItemData!(),
      ]);
      if (data.every((d) => d !== null && Object.keys(d).length > 0)) return true;
      if (Date.now() > deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }, LOOKUP_TIMEOUT_MS);
}

/**
 * The renderer's item, augment and spell hooks read their module cache when a row renders and
 * again when its effect runs. A reply that lands between the two fills the cache, so the effect
 * returns early and the row keeps the empty record it rendered with. That left the rows below
 * the first section without items, spells or augment frames in about 1 launch in 8. A second
 * mount starts with every cache full, so the page that is captured never races.
 */
async function remountWithWarmCaches(
  page: Page,
  route: string,
  vars: Record<string, string>,
  viewport: Viewport,
) {
  await page.evaluate(() => (location.hash = "#/__remount"));
  await page.waitForTimeout(200);
  await page.evaluate((hash) => (location.hash = hash), "#" + expand(route, vars));
  await settle(page, viewport);
}

// Past this, applyState says where the time went, so a stall is attributed and not guessed at
const SLOW_STATE_MS = 10_000;

export async function applyState(
  ctx: DriveContext,
  state: StateRow,
  vars: Record<string, string>,
): Promise<StateOutcome> {
  const { page } = ctx;
  const laps: string[] = [];
  const startedAt = Date.now();
  let lapStart = startedAt;
  const lap = (name: string) => {
    laps.push(`${name} ${Date.now() - lapStart}`);
    lapStart = Date.now();
  };
  await restoreSettings(ctx);
  if (ctx.app) await runStep(ctx, { op: "main", call: "reset" });
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  lap("reset");
  const pre = state.pre ?? [];
  if (pre.some((step) => step.op === "local" && step.key.startsWith("view:"))) {
    await runStep(ctx, { op: "setting", key: "remember_filters", value: "true" }, vars);
  }
  for (const step of pre) await runStep(ctx, step, vars);
  lap("pre steps");

  const lookupsReady = state.card ? await warmLookups(page) : undefined;
  ctx.viewport = { ...state.viewport };
  await ctx.resizeWindow(state.viewport.width, state.viewport.height);
  await page.evaluate((hash) => (location.hash = hash), "#" + expand(state.route, vars));
  await page.reload();
  await page.waitForLoadState("load");
  lap("resize and load");
  await settle(page, ctx.viewport);
  lap("first settle");
  if (!state.card) await remountWithWarmCaches(page, state.route, vars, ctx.viewport);

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

  lap("card");
  for (const step of state.steps ?? []) await runStep(ctx, step, vars);
  lap("steps");
  const report = await settle(page, ctx.viewport, { parkMouse: !state.holdPointer });
  lap("final settle");
  const total = Date.now() - startedAt;
  if (total > SLOW_STATE_MS) console.log(`slow ${state.id}: ${total} ms, ${laps.join(", ")}`);
  const expectFound = (await page.locator(state.expect).count()) > 0;
  const placeholders = state.card
    ? ((await page.locator("body").innerText()).match(PLACEHOLDER) ?? [])
    : [];
  return { settle: report, card, lookupsReady, placeholders, expectFound };
}
