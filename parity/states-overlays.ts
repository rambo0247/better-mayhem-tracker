import type { Step } from "./drive.ts";
import type { StateRow } from "./states.ts";

// Overlay rows of the state table (plan Appendix F, "Shared overlays" and the
// header's dialogs, banners, and toasts). They sit in their own module so T02 and T03
// can add rows to states.ts without touching these. Only types come from states.ts,
// because states.ts imports this file.
const FULL = { width: 1280, height: 820 };
const RAIL = { width: 1179, height: 820 };

const FIRST_MATCH_ROW = "button.group.relative.flex.w-full";
const FAVORITE_ROW = `${FIRST_MATCH_ROW}:has([aria-label="Favorite"])`;
const PLAYER_ROW = 'div[class*="min-h-[54px]"]';
const UPDATE_BUTTON = 'button[aria-label^="Update to version"]';
const DIALOG = '[role="dialog"]';
const TOAST = 'div.menu[role="status"]';
const TOOLTIP = '[role="tooltip"]';

const main = (call: string, arg?: unknown): Step => ({ op: "main", call, arg });
const github = (scenario: string): Step => main("github", scenario);
const returns = (method: string, value: unknown): Step => main("value", { method, value });
const emit = (channel: string, payload?: unknown): Step => main("emit", { channel, payload });
const notes = (from: string, scenario: string): Step => main("notes", { from, scenario });

const overlay = (
  id: string,
  route: string,
  expect: string,
  extra: Partial<StateRow> = {},
): StateRow => ({
  id,
  group: "overlays",
  route,
  viewport: FULL,
  expect,
  ...extra,
});

const openUpdateDialog: Step[] = [
  { op: "click", selector: UPDATE_BUTTON },
  { op: "waitFor", selector: DIALOG },
  { op: "wait", ms: 400 },
];

const expandFirstMatch: Step[] = [
  { op: "click", selector: FIRST_MATCH_ROW },
  { op: "waitFor", selector: PLAYER_ROW },
  { op: "wait", ms: 800 },
];

const update: StateRow[] = [
  overlay("overlay-update-button", "/", UPDATE_BUTTON, { pre: [github("update-available")] }),
  overlay("overlay-update-button-rail", "/", UPDATE_BUTTON, {
    viewport: RAIL,
    pre: [github("update-available")],
  }),
  overlay("overlay-update-dialog", "/", DIALOG, {
    pre: [github("update-available")],
    steps: openUpdateDialog,
  }),
  overlay("overlay-update-dialog-multi", "/", DIALOG, {
    pre: [github("update-multi")],
    steps: openUpdateDialog,
  }),
  overlay("overlay-update-dialog-many", "/", DIALOG, {
    pre: [github("update-many")],
    steps: openUpdateDialog,
  }),
  overlay("overlay-update-dialog-no-asset", "/", DIALOG, {
    platform: "win32",
    pre: [github("update-no-asset")],
    steps: openUpdateDialog,
  }),
  overlay("overlay-update-downloading", "/", "text=Downloading", {
    pre: [github("downloading"), main("hold", { method: "downloadUpdate" })],
    steps: [
      ...openUpdateDialog,
      { op: "click", selector: `${DIALOG} button.btn-primary` },
      { op: "waitFor", selector: "text=Downloading" },
      emit("update:progress", 42),
      { op: "wait", ms: 400 },
    ],
  }),
  overlay("overlay-update-installing", "/", "text=Downloading", {
    pre: [github("update-available"), main("launchInstall")],
    steps: [emit("update:progress", 67), { op: "wait", ms: 400 }],
  }),
  overlay("overlay-update-install-failed", "/", `${DIALOG} .text-lol-loss`, {
    pre: [github("update-available"), main("launchInstall")],
    steps: [
      emit("update:install-failed", "Download stalled, please try again"),
      { op: "waitFor", selector: `${DIALOG} .text-lol-loss` },
      { op: "wait", ms: 400 },
    ],
  }),
  overlay("overlay-update-error-not-installed", "/", `${DIALOG} .text-lol-loss`, {
    pre: [github("update-available")],
    steps: [
      ...openUpdateDialog,
      { op: "click", selector: `${DIALOG} button.btn-primary` },
      { op: "waitFor", selector: `${DIALOG} .text-lol-loss` },
      { op: "wait", ms: 400 },
    ],
  }),
  overlay("overlay-dialog-escape", "/", `${UPDATE_BUTTON}:focus`, {
    pre: [github("update-available")],
    steps: [...openUpdateDialog, { op: "key", key: "Escape" }, { op: "wait", ms: 400 }],
  }),
  overlay("overlay-dialog-mouse-close", "/", `${UPDATE_BUTTON}:focus`, {
    pre: [github("update-available")],
    steps: [
      ...openUpdateDialog,
      { op: "click", selector: `${DIALOG} button`, text: "Not Now" },
      { op: "wait", ms: 400 },
    ],
  }),
];

const whatsNew: StateRow[] = [
  overlay("overlay-whats-new-single", "/", DIALOG, {
    pre: [github("notes-single"), notes("1.2.0", "notes-single")],
  }),
  overlay("overlay-whats-new-multi", "/", DIALOG, {
    pre: [github("notes-multi"), notes("1.0.0", "notes-multi")],
  }),
  overlay("overlay-whats-new-unavailable", "/", DIALOG, {
    pre: [
      returns("getUpdateNotes", {
        from: "1.2.0",
        to: "1.2.1",
        url: "https://github.com/rambo0247/better-mayhem-tracker/releases/tag/v1.2.1",
        releases: [],
      }),
    ],
  }),
];

const RESTORED = "matches-2026-11-22T20-00-00-auto.db";
const KEPT = "matches.db.corrupt-2026-11-22T21-00-00";

const recovery: StateRow[] = (["missing", "corrupt"] as const).flatMap((problem) =>
  [true, false].flatMap((restored) =>
    [true, false].map((kept) =>
      overlay(
        `overlay-recovery-${problem}-${restored ? "restored" : "empty"}-${kept ? "kept" : "unkept"}`,
        "/",
        '[role="alert"]',
        {
          pre: [
            returns("getRecoveryReport", {
              problem,
              restoredFrom: restored ? RESTORED : null,
              quarantined: kept ? KEPT : null,
            }),
          ],
        },
      ),
    ),
  ),
);

const toasts: StateRow[] = [
  overlay("overlay-toast-importing", "/", TOAST, {
    steps: [emit("lcu:backfill-progress", { current: 120, total: 480, added: 31 })],
  }),
  overlay("overlay-toast-imported", "/", TOAST, {
    steps: [
      emit("lcu:backfill-done", {
        added: 37,
        scanned: 480,
        checked: 480,
        totalGames: 706,
        limit: null,
        cancelled: false,
      }),
    ],
  }),
  overlay("overlay-toast-stopped", "/", TOAST, {
    steps: [
      emit("lcu:backfill-done", {
        added: 12,
        scanned: 150,
        checked: 150,
        totalGames: 681,
        limit: null,
        cancelled: true,
      }),
    ],
  }),
  overlay("overlay-toast-failed", "/", TOAST, {
    steps: [emit("lcu:backfill-done", { error: "The League client closed during the import" })],
  }),
];

const AUGMENT_GOLD = `${PLAYER_ROW} img[class*="ring-amber-400"]`;
const AUGMENT_PRISMATIC = `${PLAYER_ROW} img[class*="ring-fuchsia-400"]`;
const ITEM = `${PLAYER_ROW} img[alt=""][width="22"]`;

const hoverState = (id: string, selector: string, expect: string): StateRow =>
  overlay(id, "/", expect, {
    holdPointer: true,
    steps: [...expandFirstMatch, { op: "hover", selector }, { op: "wait", ms: 700 }],
  });

const hovers: StateRow[] = [
  hoverState("overlay-hover-augment-gold", AUGMENT_GOLD, TOOLTIP),
  hoverState("overlay-hover-augment-prismatic", AUGMENT_PRISMATIC, TOOLTIP),
  hoverState("overlay-hover-item", ITEM, TOOLTIP),
  {
    ...hoverState("overlay-hover-flips-above", `${ITEM} >> nth=-1`, TOOLTIP),
    // The window's minimum height, which both apps hold to, leaves no room below the last item
    viewport: { width: 1280, height: 600 },
  },
  hoverState("overlay-score-breakdown", `${PLAYER_ROW} .cursor-help`, ".menu.fixed.z-50"),
  overlay("overlay-hover-nav-link", "/", FIRST_MATCH_ROW, {
    holdPointer: true,
    steps: [
      { op: "hover", selector: 'nav a[href$="/champions"]' },
      { op: "wait", ms: 300 },
    ],
  }),
  overlay("overlay-hover-trends-chart", "/trends", "svg", {
    holdPointer: true,
    steps: [
      { op: "hover", selector: "svg.block >> nth=0" },
      { op: "wait", ms: 400 },
    ],
  }),
];

const filterMenu = (page: string, route: string, loaded: string): StateRow =>
  overlay(`overlay-filter-menu-${page}`, route, 'button[title="Filters"][aria-expanded="true"]', {
    steps: [
      { op: "waitFor", selector: loaded },
      { op: "click", selector: 'button[title="Filters"]' },
      { op: "wait", ms: 400 },
    ],
  });

const menus: StateRow[] = [
  filterMenu("match-history", "/", FIRST_MATCH_ROW),
  filterMenu("champions", "/champions", "table tbody tr"),
  filterMenu("augments", "/augments", "table tbody tr"),
  filterMenu("friends", "/friends", "table tbody tr"),
  overlay("overlay-context-menu", "/", "text=Export as PNG", {
    steps: [
      { op: "click", selector: FIRST_MATCH_ROW, button: "right" },
      { op: "waitFor", selector: "text=Export as PNG" },
      { op: "wait", ms: 300 },
    ],
  }),
];

const favoriteMenu: StateRow[] = [
  overlay("overlay-context-menu-favorite", "/", "text=Remove from Favorites", {
    steps: [
      { op: "waitFor", selector: FAVORITE_ROW },
      { op: "click", selector: FAVORITE_ROW, button: "right" },
      { op: "waitFor", selector: "text=Remove from Favorites" },
      { op: "wait", ms: 300 },
    ],
  }),
];

const recordsModal: StateRow[] = [
  overlay("overlay-records-modal", "/records", PLAYER_ROW, {
    steps: [
      { op: "click", selector: 'button[title="View match"]' },
      { op: "waitFor", selector: PLAYER_ROW },
      { op: "wait", ms: 800 },
    ],
  }),
];

const exportPill = (
  id: string,
  method: string,
  result: unknown,
  menuItem: string,
  text: string,
): StateRow =>
  overlay(id, "/", `${TOAST}:has-text("${text}")`, {
    pre: [returns(method, result)],
    steps: [
      { op: "click", selector: FIRST_MATCH_ROW, button: "right" },
      { op: "click", selector: "button", text: menuItem },
      { op: "waitFor", selector: TOAST },
      { op: "wait", ms: 400 },
    ],
  });

const exportPills: StateRow[] = [
  exportPill(
    "overlay-export-copied",
    "copyCardImage",
    { success: true },
    "Copy Image",
    "Copied the game image to the clipboard",
  ),
  exportPill(
    "overlay-export-saved",
    "exportCardImage",
    { success: true, path: "/Users/player/Pictures/game-card.png" },
    "Export as PNG",
    "Saved to /Users/player/Pictures/game-card.png",
  ),
  exportPill(
    "overlay-export-failed",
    "copyCardImage",
    { success: false, error: "Couldn't draw the card: the window closed" },
    "Copy Image",
    "Couldn't draw the card",
  ),
];

const exportBusy = (id: string, method: string, label: string, busy: string): StateRow =>
  overlay(id, "/season", `button:has-text("${busy}")`, {
    pre: [main("hold", { method })],
    steps: [
      { op: "click", selector: "button.btn", text: label },
      { op: "waitFor", selector: "button.btn", text: busy },
      { op: "wait", ms: 400 },
    ],
  });

const exportBusyStates: StateRow[] = [
  exportBusy("overlay-export-busy-copy", "copyCardImage", "Copy Image", "Copying..."),
  exportBusy("overlay-export-busy-save", "exportCardImage", "Export PNG", "Exporting..."),
];

export const OVERLAY_STATES: StateRow[] = [
  ...update,
  ...whatsNew,
  ...recovery,
  ...toasts,
  ...hovers,
  ...menus,
  ...favoriteMenu,
  ...recordsModal,
  ...exportPills,
  ...exportBusyStates,
];
