import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { assertTrayShape, outline, type MenuItemDump, type TrayDump } from "../menus.ts";

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

  test("the tray template in src/main/index.ts has the same three entries", () => {
    const source = fs.readFileSync(
      path.resolve(import.meta.dir, "../../src/main/index.ts"),
      "utf8",
    );
    const block = source.slice(source.indexOf("Menu.buildFromTemplate(["));
    const labels = [
      ...block.slice(0, block.indexOf("]);")).matchAll(/label: "([^"]+)"|type: "(separator)"/g),
    ].map((m) => m[1] ?? m[2]);
    expect(labels).toEqual(["Show Window", "separator", "Quit"]);
  });
});
