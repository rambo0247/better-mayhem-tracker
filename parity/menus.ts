import fs from "node:fs";
import path from "node:path";
import { baselineDir } from "./capture.ts";
import { startElectron } from "./run-electron.ts";

export interface MenuItemDump {
  type: string;
  label: string;
  role: string | null;
  enabled: boolean;
  visible: boolean;
  checked: boolean;
  accelerator: string | null;
  submenu: MenuItemDump[] | null;
}

export interface TrayDump {
  tooltip: string | null;
  menu: MenuItemDump[] | null;
  template: unknown[] | null;
  events: { event: string; via: string; handler: string | null }[];
}

export const TRAY_SHAPE = ["Show Window", "separator", "Quit"];

/** The labels of a menu in order, with separators named, as the tray test reads them. */
export const outline = (items: MenuItemDump[]) =>
  items.map((item) => (item.type === "separator" ? "separator" : item.label));

export function assertTrayShape(tray: TrayDump | undefined): asserts tray is TrayDump {
  if (!tray?.menu) throw new Error("the app built no tray menu");
  const got = outline(tray.menu);
  if (JSON.stringify(got) !== JSON.stringify(TRAY_SHAPE)) {
    throw new Error(`tray menu is ${JSON.stringify(got)}, expected ${JSON.stringify(TRAY_SHAPE)}`);
  }
}

export interface TrayProbe {
  doubleClick: { registered: boolean; calls: string[] };
}

/** Lane 9's pass rule: double-clicking the tray icon shows the window, then focuses it. */
export function assertDoubleClickShowsWindow(probe: TrayProbe | undefined): void {
  const got = probe?.doubleClick;
  if (!got?.registered) throw new Error("the tray registers no double-click handler");
  if (JSON.stringify(got.calls) !== JSON.stringify(["show", "focus"])) {
    throw new Error(`double-click calls ${JSON.stringify(got.calls)}, expected show then focus`);
  }
}

/** The Windows lane saves `win-tray-menu.json` beside the macOS `tray-menu.json`. */
export const menuFiles = (platform: NodeJS.Platform = process.platform) => {
  const prefix = platform === "win32" ? "win-" : "";
  return { tray: `${prefix}tray-menu.json`, app: `${prefix}app-menu.json` };
};

/** The run's stub package renames the app, so its name is swapped for the real one. */
const STUB_NAME = "bmt-parity-electron";
const REAL_NAME = "better-mayhem-tracker";
const normalize = <T>(value: T): T =>
  JSON.parse(JSON.stringify(value).replaceAll(STUB_NAME, REAL_NAME)) as T;

async function main() {
  const args = process.argv.slice(2);
  const value = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
  if ((value("--app") ?? "electron") !== "electron") {
    throw new Error("only --app electron is available in this unit");
  }
  const dir = path.resolve(value("--out") ?? baselineDir("electron"));
  fs.mkdirSync(dir, { recursive: true });
  const running = await startElectron({ data: value("--data") ?? "fixture" });
  try {
    const dump = await running.app.evaluate(() => (globalThis as any).__parity.menus());
    assertTrayShape(dump.trays[0]);
    const tray = dump.trays[0] as TrayDump;
    // Last: the Quit probe leaves the app's own quit flag set
    const probe = await running.app.evaluate(() => (globalThis as any).__parity.probeTray());
    assertDoubleClickShowsWindow(probe[0]);
    const interaction = {
      doubleClick: probe[0].doubleClick,
      click: probe[0].click,
      menuItems: probe[0].items,
      note:
        "Native behavior that cannot be captured in-process: where the tray icon sits, and which " +
        "click opens the context menu (a left click on macOS, a right click on Windows). " +
        "Handlers were run with the window's show and focus and app.quit replaced, and what " +
        "they called is recorded.",
    };
    const trayDump = normalize({
      platform: dump.platform,
      tooltip: tray.tooltip,
      items: tray.menu,
      template: tray.template,
      events: tray.events,
      interaction,
    });
    const appDump = normalize({
      platform: dump.platform,
      appName: dump.appName,
      menu: dump.appMenu,
    });
    const files = menuFiles(dump.platform);
    fs.writeFileSync(path.join(dir, files.tray), JSON.stringify(trayDump, null, 1));
    fs.writeFileSync(path.join(dir, files.app), JSON.stringify(appDump, null, 1));
    console.log(
      `wrote ${path.join(dir, files.tray)} (${outline(tray.menu!).join(", ")}) and ${files.app}`,
    );
  } finally {
    await running.close();
  }
}

if (import.meta.main) await main();
