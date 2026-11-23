// Renders every case in test/parity-cases.ts with the React components in
// src/renderer, in happy-dom with a fake window.api, and writes the reduced
// trees to test/react-snapshots.json for src/components/react-parity.test.tsx.
// Needs the repository root's node_modules (npm ci at the root), so tauri/'s
// typecheck leaves it out: `bun run react-snapshots`.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Window } from "happy-dom";
import { CASES, FAKE_API, ICON_FILES, ICON_PROPS } from "../test/parity-cases";
import { normalizeDom, type DomNode } from "../test/normalize-dom";

const root = resolve(import.meta.dir, "..");
const renderer = join(root, "..", "src", "renderer", "components");

const win = new Window({ url: "http://localhost/" });
for (const key of [
  "window",
  "document",
  "navigator",
  "localStorage",
  "HTMLElement",
  "Element",
  "Node",
  "Text",
  "SVGElement",
  "HTMLInputElement",
  "Event",
  "MouseEvent",
  "getComputedStyle",
  "matchMedia",
  "requestAnimationFrame",
  "cancelAnimationFrame",
]) {
  Object.defineProperty(globalThis, key, {
    value: key === "window" ? win : (win as unknown as Record<string, unknown>)[key],
    configurable: true,
    writable: true,
  });
}
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
(win as unknown as { api: unknown }).api = new Proxy(
  { platform: "darwin", locale: undefined } as Record<string, unknown>,
  {
    get(target, key) {
      if (typeof key !== "string" || key in target) return target[key as string];
      if (key.startsWith("on")) return () => () => {};
      return () => Promise.resolve(FAKE_API[key] ?? null);
    },
  },
);

const React = await import("react");
const { createRoot } = await import("react-dom/client");

// The Solid names of props, as React spells them
const REACT_PROPS: Record<string, string> = {
  class: "className",
  nameClass: "nameClassName",
  tagClass: "tagClassName",
};

async function reactProps(given: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(given)) {
    out[REACT_PROPS[key] ?? key] = value;
  }
  // RecordCard takes its icon as an element in React
  if (typeof given.icon === "string" && given.icon.endsWith("Icon")) {
    const icons = await import(join(renderer, "icons.tsx"));
    out.icon = React.createElement(icons[given.icon], { className: "w-3 h-3" });
  }
  return out;
}

async function render(component: unknown, props: Record<string, unknown>, ignore: string[] = []) {
  const container = document.createElement("div");
  document.body.append(container);
  const reactRoot = createRoot(container);
  const { children, ...rest } = props;
  await React.act(async () => {
    reactRoot.render(React.createElement(component as never, rest, children as never));
  });
  // Lets the fake window.api answer and the components draw what it said
  await React.act(async () => {
    for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
  });
  const tree = normalizeDom(container, ignore);
  await React.act(async () => reactRoot.unmount());
  container.remove();
  return tree;
}

const snapshots: Record<string, DomNode[]> = {};
for (const c of CASES) {
  const mod = await import(join(renderer, `${c.file}.tsx`));
  snapshots[c.id] = await render(mod[c.name], await reactProps(c.props), c.ignore);
}
for (const file of ICON_FILES) {
  const mod = await import(join(renderer, `${file}.tsx`));
  for (const name of Object.keys(mod).sort()) {
    snapshots[`${file}.${name}`] = await render(mod[name], await reactProps(ICON_PROPS));
  }
}

const out = join(root, "test", "react-snapshots.json");
writeFileSync(out, `${JSON.stringify(snapshots, null, 2)}\n`);
// In the formatter's own shape, so a rerun with no change leaves no diff
spawnSync("bunx", ["oxfmt", out], { cwd: root, stdio: "inherit" });
console.log(`wrote ${Object.keys(snapshots).length} React snapshots to test/react-snapshots.json`);
process.exit(0);
