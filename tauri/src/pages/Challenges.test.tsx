import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { transformSync } from "@babel/core";
import { Window } from "happy-dom";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import type { ChallengeProgress, ChallengesData, ChallengesResult } from "../lib/types";

// Solid's DOM build and the JSX transform are what the app is built with, so
// the test loads the page the same way: the browser entries of the two Solid
// packages, and the Babel plugin over every module under src/.
const solidDir = fileURLToPath(new URL("../../node_modules/solid-js/dist/", import.meta.url));
const webDir = fileURLToPath(new URL("../../node_modules/@solidjs/web/dist/", import.meta.url));
const srcDir = fileURLToPath(new URL("../", import.meta.url));

Bun.plugin({
  name: "solid-dom",
  setup(build) {
    build.onResolve({ filter: /^solid-js$/ }, () => ({ path: `${solidDir}solid.js` }));
    build.onResolve({ filter: /^@solidjs\/web$/ }, () => ({ path: `${webDir}web.js` }));
    build.onLoad({ filter: /\.tsx$/ }, ({ path }) => {
      if (!path.startsWith(srcDir)) return undefined;
      const out = transformSync(readFileSync(path, "utf8"), {
        filename: path,
        babelrc: false,
        configFile: false,
        parserOpts: { plugins: ["typescript", "jsx"] },
        plugins: [["@solidjs/babel-plugin", { moduleName: "@solidjs/web", generate: "dom" }]],
      });
      return { contents: out?.code ?? "", loader: "ts" };
    });
  },
});

const win = new Window({ url: "http://localhost/" });
Object.assign(globalThis, {
  window: win,
  document: win.document,
  navigator: win.navigator,
  HTMLElement: win.HTMLElement,
  Node: win.Node,
  Element: win.Element,
  requestAnimationFrame: (cb: () => void) => setTimeout(cb, 0),
});

const progress = (id: number, name: string, over: Partial<ChallengeProgress> = {}) =>
  ({
    id,
    name,
    description: `${name} description`,
    level: "GOLD",
    value: 50,
    currentThreshold: 40,
    nextLevel: "PLATINUM",
    nextThreshold: 100,
    nextRewards: [],
    percentile: 20,
    pointsAwarded: 10,
    iconPath: "",
    retired: false,
    completedChampionIds: null,
    delta: null,
    ...over,
  }) satisfies ChallengeProgress;

function challengesData(over: Partial<ChallengesData> = {}): ChallengesData {
  return {
    player: { level: "DIAMOND", points: 12345, pointsUntilNextRank: 55, percentile: 5, title: "" },
    capstone: progress(1, "Parity Authority"),
    groups: [
      {
        summary: progress(10, "Parity Warrior"),
        challenges: [progress(11, "Win Games"), progress(12, "Pick Champions")],
      },
    ],
    seasonal: [],
    equipped: [],
    fetchedAt: 0,
    since: null,
    ...over,
  };
}

const tick = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

let initial: ChallengesResult;
let emitChanged: (result: ChallengesResult) => void;

mock.module("../lib/perf", () => ({ reportFirstContent: () => {} }));

beforeAll(() => {
  Object.assign(win, {
    api: {
      platform: "darwin",
      getLcuStatus: () => Promise.resolve("Connected"),
      onStatusChanged: () => () => {},
      getChallenges: () => Promise.resolve(initial),
      onChallengesChanged: (cb: (r: ChallengesResult) => void) => {
        emitChanged = cb;
        return () => {};
      },
      getChampionData: () => Promise.resolve({}),
    },
  });
});

async function mount() {
  const { render } = await import("@solidjs/web");
  const { default: Challenges } = await import("./Challenges");
  document.body.innerHTML = "";
  const root = document.createElement("div");
  document.body.append(root);
  render(() => Challenges(), root);
  await tick();
  return root;
}

describe("Challenges", () => {
  beforeEach(() => {
    initial = { data: null, pending: true };
  });

  test("shows Loading… while the first live read is pending", async () => {
    const root = await mount();
    expect(root.textContent).toContain("Loading…");
  });

  test("shows the offline text when the client has never answered", async () => {
    initial = { data: null, pending: false };
    const root = await mount();
    expect(root.textContent).toContain("Challenge progress comes from the League client");
    expect(root.textContent).toContain("it isn't running");
    expect(root.textContent).not.toContain("Loading…");
  });

  test("shows the capstone, player and category cards when loaded", async () => {
    initial = { data: challengesData(), pending: false };
    const root = await mount();
    const text = root.textContent ?? "";
    expect(text).toContain("Parity Authority");
    expect(text).toContain("Challenge rank");
    expect(text).toContain("12,345");
    expect(text).toContain("Parity Warrior");
    expect(text).toContain("2 challenges");
    expect(text).toContain("Win Games");
    expect(root.innerHTML).toContain("lg:grid-cols-[minmax(0,1.75fr)");
  });

  test("lays out a single column without a capstone", async () => {
    initial = { data: challengesData({ capstone: null }), pending: false };
    const root = await mount();
    expect(root.textContent).not.toContain("Parity Authority");
    expect(root.innerHTML).not.toContain("lg:grid-cols-[minmax(0,1.75fr)");
  });

  test("a challenges:changed event with a tier-up updates the page", async () => {
    initial = { data: challengesData(), pending: false };
    const root = await mount();
    expect(root.textContent).toContain("Parity Warrior");
    expect(root.textContent).not.toContain("Platinum Warrior");

    emitChanged({
      data: challengesData({
        groups: [
          {
            summary: progress(10, "Platinum Warrior", { level: "PLATINUM" }),
            challenges: [progress(11, "Win Games", { level: "PLATINUM", delta: 3 })],
          },
        ],
      }),
      pending: false,
    });
    await tick();

    const text = root.textContent ?? "";
    expect(text).toContain("Platinum Warrior");
    expect(text).not.toContain("Parity Warrior");
    expect(text).toContain("+3");
    expect(text).toContain("1 challenges");
  });

  test("a changed event moves the page from offline to loaded", async () => {
    initial = { data: null, pending: false };
    const root = await mount();
    expect(root.textContent).toContain("it isn't running");
    emitChanged({ data: challengesData(), pending: false });
    await tick();
    expect(root.textContent).toContain("Parity Authority");
    expect(root.textContent).not.toContain("it isn't running");
  });
});
