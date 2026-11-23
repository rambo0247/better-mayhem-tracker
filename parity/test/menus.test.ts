import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import {
  assertDoubleClickShowsWindow,
  assertTrayShape,
  menuFiles,
  outline,
  type MenuItemDump,
  type TrayDump,
} from "../menus.ts";
import { ELECTRON_REPO_DIR } from "../lib/data.ts";

const ELECTRON_SOURCE = path.join(ELECTRON_REPO_DIR, "src", "main", "index.ts");

const require = createRequire(import.meta.url);
const { serializeMenu, serializeTemplate } = require("../seam-overlays.cjs") as {
  serializeMenu: (menu: unknown) => MenuItemDump[];
  serializeTemplate: (template: unknown[]) => unknown[];
};

const item = (extra: Record<string, unknown>) => ({
  type: "normal",
  label: "",
  enabled: true,
  visible: true,
  checked: false,
  ...extra,
});
const fakeTray = [
  item({ label: "Show Window" }),
  item({ type: "separator" }),
  item({ label: "Quit", accelerator: "CmdOrCtrl+Q" }),
];

describe("tray dump", () => {
  test("lists Show Window, a separator, and Quit, in that order", () => {
    const items = serializeMenu({ items: fakeTray });
    expect(outline(items)).toEqual(["Show Window", "separator", "Quit"]);
    expect(items[2]?.accelerator).toBe("CmdOrCtrl+Q");
    expect(() => assertTrayShape({ menu: items } as TrayDump)).not.toThrow();
  });

  test("a different order or a missing item is refused", () => {
    const swapped = serializeMenu({ items: [fakeTray[2], fakeTray[1], fakeTray[0]] });
    expect(() => assertTrayShape({ menu: swapped } as TrayDump)).toThrow();
    expect(() => assertTrayShape(undefined)).toThrow();
  });

  test("submenus are dumped with their items", () => {
    const [edit] = serializeMenu({
      items: [item({ label: "Edit", submenu: { items: [item({ label: "Copy" })] } })],
    });
    expect(edit?.submenu?.map((i) => i.label)).toEqual(["Copy"]);
  });

  test("a template keeps a click handler as its source", () => {
    const [entry] = serializeTemplate([{ label: "Quit", click: () => 1 }]) as {
      click: { $function: string };
    }[];
    expect(entry?.click.$function).toContain("=> 1");
  });

  test.skipIf(!fs.existsSync(ELECTRON_SOURCE))(
    "the tray template in 1.2.1's src/main/index.ts has the same three entries",
    () => {
      const source = fs.readFileSync(ELECTRON_SOURCE, "utf8");
      const block = source.slice(source.indexOf("Menu.buildFromTemplate(["));
      const labels = [
        ...block.slice(0, block.indexOf("]);")).matchAll(/label: "([^"]+)"|type: "(separator)"/g),
      ].map((m) => m[1] ?? m[2]);
      expect(labels).toEqual(["Show Window", "separator", "Quit"]);
    },
  );
});

describe("the tray's double-click", () => {
  test("showing the window then focusing it passes, anything else is refused", () => {
    const probe = (calls: string[], registered = true) => ({ doubleClick: { registered, calls } });
    expect(() => assertDoubleClickShowsWindow(probe(["show", "focus"]))).not.toThrow();
    expect(() => assertDoubleClickShowsWindow(probe(["focus", "show"]))).toThrow(/show then focus/);
    expect(() => assertDoubleClickShowsWindow(probe([]))).toThrow(/show then focus/);
    expect(() => assertDoubleClickShowsWindow(probe([], false))).toThrow(/no double-click/);
    expect(() => assertDoubleClickShowsWindow(undefined)).toThrow(/no double-click/);
  });
});

describe("the dump's file names", () => {
  test("Windows saves win-tray-menu.json, macOS tray-menu.json", () => {
    expect(menuFiles("win32")).toEqual({ tray: "win-tray-menu.json", app: "win-app-menu.json" });
    expect(menuFiles("darwin")).toEqual({ tray: "tray-menu.json", app: "app-menu.json" });
  });
});
