import { beforeAll, expect, test } from "bun:test";
import type { Component } from "solid-js";
import { Dynamic } from "@solidjs/web";
import snapshots from "../../test/v1-dom-snapshots.json";
import { caseFingerprints, CASES, FAKE_API, ICON_FILES, ICON_PROPS } from "../../test/parity-cases";
import { normalizeDom, type DomNode } from "../../test/normalize-dom";
import { fake } from "../../test/fakeApi";
import { mount, settle } from "../../test/render";
import * as icons from "./icons";

// Each shared component, rendered with the props test/parity-cases.ts gives
// it, against test/v1-dom-snapshots.json: the 1.2.1 React component's DOM for the
// same props, recorded from the v1.2.1 tag. Text, tags, classes and every
// other attribute have to match.

const modules = import.meta.glob<Record<string, Component<Record<string, unknown>>>>(
  ["./*.tsx", "!./*.test.tsx"],
  { eager: true },
);

const REACT = snapshots as unknown as Record<string, DomNode[]>;

beforeAll(() => {
  for (const [method, value] of Object.entries(FAKE_API)) fake.returns.set(method, value);
});

// The Solid API differs from React's by design in two places
function solidProps(given: Record<string, unknown>): Record<string, unknown> {
  const out = { ...given };
  // HoverCard builds its card on hover, from a render function
  if (typeof given.content === "string") out.content = () => given.content;
  // RecordCard draws its icon twice, so it takes the component
  if (typeof given.icon === "string" && given.icon.endsWith("Icon")) {
    out.icon = (icons as Record<string, unknown>)[given.icon];
  }
  return out;
}

// Where the Solid markup differs from React's on purpose, it is put back the
// React way before comparing. ChampionIcon's crop span stands for the img
// Electron drew with object-view-box, which WKWebView ignores: the span's
// classes less the three that make it a clipping box, its size, and the img's
// source. RecordCard's mask carries a -webkit- copy WKWebView needs.
const WEBKIT_MASK = /\[-webkit-mask-image:[^\]]*\]/;

function undoDeliberateChanges(root: Element) {
  for (const span of root.querySelectorAll<HTMLElement>("[data-parity-skip]")) {
    const img = span.firstElementChild!;
    const classes = (span.getAttribute("class") ?? "")
      .split(/\s+/)
      .filter((c) => c && !["relative", "block", "overflow-hidden"].includes(c));
    img.setAttribute("class", classes.join(" "));
    const title = span.getAttribute("title");
    if (title) img.setAttribute("title", title);
    const size = String(Number.parseFloat(span.style.width));
    img.setAttribute("width", size);
    img.setAttribute("height", size);
    img.setAttribute("style", "object-view-box: inset(6%)");
    span.replaceWith(img);
  }
  for (const el of root.querySelectorAll("[class]")) {
    const cls = el.getAttribute("class")!;
    if (WEBKIT_MASK.test(cls)) el.setAttribute("class", cls.replace(WEBKIT_MASK, ""));
  }
}

async function render(
  component: Component<Record<string, unknown>>,
  props: Record<string, unknown>,
  ignore?: string[],
) {
  const view = mount(() => <Dynamic component={component} {...props} />);
  await settle();
  undoDeliberateChanges(view.container);
  const tree = normalizeDom(view.container, ignore);
  view.dispose();
  return tree;
}

test("v1-dom-snapshots.json was made from these cases", () => {
  const made = (snapshots as unknown as { __cases: Record<string, string> }).__cases;
  // A new case needs its snapshot recorded from the v1.2.1 tag
  expect(made).toEqual(caseFingerprints());
});

for (const c of CASES) {
  test(`${c.id} renders as React does`, async () => {
    const mod = modules[`./${c.file}.tsx`];
    expect(mod, `components/${c.file}.tsx`).toBeDefined();
    const component = mod![c.name]!;
    expect(await render(component, solidProps(c.props), c.ignore)).toEqual(REACT[c.id]!);
  });
}

for (const file of ICON_FILES) {
  test(`every icon in ${file} renders as React does`, async () => {
    const mod = modules[`./${file}.tsx`]!;
    const names = Object.keys(mod).sort();
    expect(names).toEqual(
      Object.keys(REACT)
        .filter((k) => k.startsWith(`${file}.`))
        .map((k) => k.slice(file.length + 1))
        .sort(),
    );
    for (const name of names) {
      expect([name, await render(mod[name]!, ICON_PROPS)]).toEqual([
        name,
        REACT[`${file}.${name}`]!,
      ]);
    }
  });
}
