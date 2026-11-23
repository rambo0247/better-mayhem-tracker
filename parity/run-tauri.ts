import { type ChildProcess, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  dumpGeometry,
  serveControl,
  type DriveContext,
  type Engine,
  type Target,
} from "./drive.ts";
import { copyDataTree, PARITY_DIR, REPO_DIR, resolveDataRoot } from "./lib/data.ts";
import { gameRunning, waitForNoGame } from "./lib/no-game.ts";
import { claimRunFolder, DEFAULT_VIEWPORT, FIXED_TIME, TIME_ZONE } from "./run-electron.ts";
import { settle } from "./settle.ts";

export const SENTINEL = "bmt-parity-driver-v1";
export type Renderer = "electron" | "solid";

const READY_LINE = new RegExp(`${SENTINEL} listening 127\\.0\\.0\\.1:(\\d+)`);

/**
 * The names a debug build goes by. `tauri build` moves cargo's output to
 * `mainBinaryName`, and a plain `cargo build` leaves cargo's name.
 */
export function tauriBinaryNames(platform: NodeJS.Platform = process.platform): string[] {
  const exe = platform === "win32" ? ".exe" : "";
  return [`Better Mayhem Tracker${exe}`, `better-mayhem-tracker-tauri${exe}`];
}

export interface TauriBinaryOptions {
  platform?: NodeJS.Platform;
  targetDir?: string;
  log?: (line: string) => void;
}

/** The debug build with `--features parity-driver`, under whichever name exists, the newer when both do. */
export function tauriBinary(repo: string = REPO_DIR, options: TauriBinaryOptions = {}): string {
  const target =
    options.targetDir ??
    process.env.CARGO_TARGET_DIR ??
    path.join(repo, "tauri", "src-tauri", "target");
  const candidates = tauriBinaryNames(options.platform).map((name) =>
    path.join(target, "debug", name),
  );
  const found = candidates.flatMap((file) => {
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    return stat ? [{ file, mtime: stat.mtimeMs }] : [];
  });
  const [first, second] = found;
  if (!first) {
    throw new Error(
      `Neither ${candidates.join(" nor ")} exists. Run \`CI=true bun run tauri build --debug --no-bundle --features parity-driver\` in tauri/.`,
    );
  }
  if (!second) return first.file;
  const newer = second.mtime > first.mtime ? second : first;
  (options.log ?? console.log)(
    `Both ${first.file} and ${second.file} exist; using the newer ${newer.file}`,
  );
  return newer.file;
}

export const PRODUCTION_IDENTIFIER = "com.better-mayhem-tracker.app";
export const PARITY_IDENTIFIER = "com.better-mayhem-tracker.parity";

/**
 * WebKit keeps a webview's storage under ~/Library by bundle identifier, whatever HOME says,
 * and Tauri names the app's data folders by its config identifier. So a driver build under
 * the app's own identifier writes into the real app's folders. Refuses a binary whose
 * embedded config or enclosing .app names the production identifier, or that lacks the
 * parity one (a build from before build.rs set it).
 */
export function refuseProductionIdentifier(binary: string) {
  const bytes = fs.readFileSync(binary);
  const bundlePlist = path.join(path.dirname(binary), "..", "Info.plist");
  const insideApp = path.resolve(binary, "..", "..", "..").endsWith(".app");
  const plist = insideApp && fs.existsSync(bundlePlist) ? fs.readFileSync(bundlePlist, "utf8") : "";
  const bundleId = plist.match(/<key>CFBundleIdentifier<\/key>\s*<string>([^<]*)<\/string>/)?.[1];
  if (bytes.includes(PRODUCTION_IDENTIFIER) || bundleId === PRODUCTION_IDENTIFIER) {
    throw new Error(
      `${binary} carries the production bundle identifier ${PRODUCTION_IDENTIFIER}. Rebuild it with --features parity-driver, and pass --config src-tauri/tauri.parity.conf.json to a bundled build.`,
    );
  }
  if (
    !bytes.includes(PARITY_IDENTIFIER) ||
    (bundleId !== undefined && bundleId !== PARITY_IDENTIFIER)
  ) {
    throw new Error(
      `${binary} does not carry the parity bundle identifier ${PARITY_IDENTIFIER}. Rebuild it with --features parity-driver.`,
    );
  }
}

export interface ReplayCase {
  case: string;
  group: string;
  seq: number;
  args: unknown[];
  outcome: unknown;
}

export interface ReplayBundle {
  platform: NodeJS.Platform;
  locale?: string;
  methods: Record<string, string>;
  events: Record<string, string>;
  goldens: Record<string, ReplayCase[]>;
  /** Each state's calls and the case answering each, from T05's `states/<id>.json`. */
  states: Record<string, { channel: string; args: unknown[]; case: string }[]>;
  emit?: { event: string; payload?: unknown }[];
}

/** `INVOKE_CHANNELS` from `src/shared/api.ts`: the method each channel answers. */
export function readInvokeChannels(repo: string = REPO_DIR): Record<string, string> {
  const source = fs.readFileSync(path.join(repo, "src", "shared", "api.ts"), "utf8");
  const block = source.match(/export const INVOKE_CHANNELS = \{([\s\S]*?)\n\}/)?.[1];
  if (!block) throw new Error("INVOKE_CHANNELS not found in src/shared/api.ts");
  return Object.fromEntries(
    [...block.matchAll(/^\s*(\w+): "([^"]+)",/gm)].map((m) => [m[1]!, m[2]!]),
  );
}

/** The preload's `onX: subscribe("event")` lines: the method each pushed event reaches. */
export function readEventMethods(repo: string = REPO_DIR): Record<string, string> {
  const source = fs.readFileSync(path.join(repo, "src", "preload", "index.ts"), "utf8");
  return Object.fromEntries(
    [...source.matchAll(/^\s*(on\w+): subscribe\("([^"]+)"\)/gm)].map((m) => [m[1]!, m[2]!]),
  );
}

export function buildReplayBundle(options: {
  goldenDir: string;
  methods: Record<string, string>;
  events: Record<string, string>;
  platform?: NodeJS.Platform;
  locale?: string;
  scenario?: string;
}): ReplayBundle {
  const ipc = path.join(options.goldenDir, "ipc");
  if (!fs.existsSync(ipc)) {
    throw new Error(
      `no goldens under ${ipc}. Record them with \`bun parity/record-ipc.ts --data fixture\` (T05) or pass --golden.`,
    );
  }
  const goldens: Record<string, ReplayCase[]> = {};
  for (const dir of fs.readdirSync(ipc)) {
    for (const file of fs.readdirSync(path.join(ipc, dir)).filter((f) => f.endsWith(".json"))) {
      const golden = JSON.parse(fs.readFileSync(path.join(ipc, dir, file), "utf8"));
      if (golden.format !== 1) throw new Error(`${dir}/${file}: golden format ${golden.format}`);
      (goldens[golden.channel] ??= []).push({
        case: golden.case,
        group: golden.group,
        seq: golden.seq,
        args: golden.args,
        outcome: golden.outcome,
      });
    }
  }
  const states: ReplayBundle["states"] = {};
  const stateDir = path.join(options.goldenDir, "states");
  for (const file of fs.existsSync(stateDir) ? fs.readdirSync(stateDir) : []) {
    if (!file.endsWith(".json")) continue;
    const list = JSON.parse(fs.readFileSync(path.join(stateDir, file), "utf8"));
    if (list.format !== 1) throw new Error(`states/${file}: format ${list.format}`);
    states[list.state] = list.calls.map(
      (c: { channel: string; args: unknown[]; case: string }) => ({
        channel: c.channel,
        args: c.args,
        case: c.case,
      }),
    );
  }
  let emit: ReplayBundle["emit"];
  if (options.scenario) {
    const file = path.join(options.goldenDir, "events", `${options.scenario}.jsonl`);
    emit = fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .sort((a, b) => a.seq - b.seq)
      .map(({ event, payload }) => ({ event, payload }));
  }
  return {
    platform: options.platform ?? process.platform,
    locale: options.locale,
    methods: options.methods,
    events: options.events,
    goldens,
    states,
    emit,
  };
}

/** The Date `run-electron.ts` freezes with Playwright's clock, the same proxy as seam.cjs. */
const clockScript = (fixed: number) => `(() => {
  const RealDate = Date;
  const fixed = ${fixed};
  globalThis.Date = new Proxy(RealDate, {
    construct(target, args) { return args.length === 0 ? new target(fixed) : new target(...args); },
    apply(target) { return new target(fixed).toString(); },
    get(target, key, receiver) { return key === "now" ? () => fixed : Reflect.get(target, key, receiver); },
  });
})();`;

export function initScript(bundle: ReplayBundle | undefined, api?: string): string {
  const parts = [clockScript(FIXED_TIME.getTime())];
  if (api) parts.push(api);
  if (bundle) {
    parts.push(`globalThis.__BMT_REPLAY__ = ${JSON.stringify(bundle)};`);
    parts.push(fs.readFileSync(path.join(PARITY_DIR, "replay-api.js"), "utf8"));
  }
  return parts.join("\n");
}

export class TauriDriver {
  constructor(
    readonly port: number,
    private readonly token: string,
  ) {}

  async call(op: string, body: Record<string, unknown> = {}): Promise<Response> {
    const response = await fetch(`http://127.0.0.1:${this.port}/`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify({ op, ...body }),
    });
    if (!response.ok) {
      const text = await response.text();
      const message = text.startsWith("{") ? (JSON.parse(text).error ?? text) : text;
      throw new Error(`driver ${op}: ${message}`);
    }
    return response;
  }

  async json<T>(op: string, body: Record<string, unknown> = {}): Promise<T> {
    return (await this.call(op, body)).json() as Promise<T>;
  }
}

/** Source of a function plus its argument, or an expression, as the driver's `eval` takes it. */
export function expressionOf(fn: string | ((arg: any) => unknown), arg?: unknown): string {
  if (typeof fn === "string") return fn.trim().replace(/;+$/, "");
  return `(${fn.toString()})(${arg === undefined ? "" : JSON.stringify(arg)})`;
}

interface Resolved {
  found: number;
  visible: boolean;
  x: number;
  y: number;
}

/**
 * Finds a target in the page with Playwright's rules for the selectors the states use: CSS,
 * `text=` (case-insensitive substring, innermost element), a trailing `:has-text("...")`,
 * `filter({ hasText })`, first or nth.
 * Scrolls it into view and returns its center.
 */
function resolveInPage(target: {
  selector: string;
  nth?: number;
  text?: string;
  scroll: boolean;
  fill?: string;
  scrollBy?: number;
}) {
  const normalize = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const all = (selector: string): Element[] => {
    const hasText = selector.match(/^(.+):has-text\((["'])(.*)\2\)$/);
    if (hasText) {
      const wanted = normalize(hasText[3]!);
      return [...document.querySelectorAll(hasText[1]!)].filter((el) =>
        normalize(el.textContent ?? "").includes(wanted),
      );
    }
    if (!selector.startsWith("text=")) return [...document.querySelectorAll(selector)];
    const wanted = normalize(selector.slice(5).replace(/^"(.*)"$/, "$1"));
    const has = (el: Element) => normalize(el.textContent ?? "").includes(wanted);
    return [...document.querySelectorAll("body *")].filter(
      (el) => has(el) && ![...el.children].some(has),
    );
  };
  let list = all(target.selector);
  if (target.text !== undefined) {
    const text = normalize(target.text);
    list = list.filter((el) => normalize(el.textContent ?? "").includes(text));
  }
  const el = list[target.nth ?? 0];
  if (!el) return { found: list.length, visible: false, x: 0, y: 0 };
  if (target.fill !== undefined) {
    const input = el as HTMLInputElement;
    input.focus();
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
    Object.getOwnPropertyDescriptor(proto.prototype, "value")!.set!.call(input, target.fill);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }
  if (target.scrollBy !== undefined) el.scrollBy(0, target.scrollBy);
  if (target.scroll) {
    const box = el.getBoundingClientRect();
    if (box.bottom > innerHeight || box.top < 0 || box.right > innerWidth || box.left < 0) {
      el.scrollIntoView({ block: "center", inline: "center" });
    }
  }
  const box = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  const visible = box.width > 0 && box.height > 0 && style.visibility !== "hidden";
  return { found: list.length, visible, x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

export class TauriEngine implements Engine {
  readonly name = "tauri" as const;
  private mouse = { x: 0, y: 0 };
  /** The last resize the screen cut short, recorded with the capture. */
  clamped?: { asked: [number, number]; seen: [number, number] };
  /** Window size per page px in each dimension, learned on every resize. */
  private windowPerPage = [1, 1];
  private viewport = { width: 0, height: 0 };
  /** How the last hover reached the page, for lanes that check native `:hover`. */
  lastHover?: { path: string; hoverMatches: boolean };

  constructor(readonly driver: TauriDriver) {}

  async evaluate<R, A = undefined>(fn: string | ((arg: A) => R | Promise<R>), arg?: A): Promise<R> {
    const response = await this.driver.call("eval", {
      expression: expressionOf(fn as (arg: unknown) => unknown, arg),
    });
    return (await response.json()) as R;
  }

  private async resolve(target: Target, timeout = 10_000, scroll = true): Promise<Resolved> {
    const deadline = Date.now() + timeout;
    for (;;) {
      const found = await this.evaluate(resolveInPage, { ...target, scroll });
      if (found.visible) return found;
      if (Date.now() > deadline) {
        throw new Error(
          `${target.selector}${target.text ? ` with text ${target.text}` : ""}: ${found.found} matches, none visible after ${timeout} ms`,
        );
      }
      await Bun.sleep(100);
    }
  }

  async click(target: Target, button?: "left" | "right") {
    if (button === "right") throw new Error("the parity driver sends only the left button");
    const { x, y } = await this.resolve(target);
    await this.mouseMove(x, y);
    await this.driver.call("mouse", { kind: "down", x, y });
    await this.driver.call("mouse", { kind: "up", x, y });
  }

  async hover(target: Target) {
    const { x, y } = await this.resolve(target);
    this.lastHover = await this.mouseMove(x, y);
  }

  async fill(target: Target, text: string) {
    await this.resolve(target);
    await this.evaluate(resolveInPage, { ...target, scroll: false, fill: text });
  }

  async press(key: string) {
    await this.driver.call("key", { kind: "down", key });
    await this.driver.call("key", { kind: "up", key });
  }

  async wheel(dy: number) {
    await this.driver.call("wheel", { ...this.mouse, dx: 0, dy });
  }

  async scrollBy(target: Target, dy: number) {
    await this.resolve(target, 10_000, false);
    await this.evaluate(resolveInPage, { ...target, scroll: false, scrollBy: dy });
  }

  async waitFor(target: Target, timeout: number) {
    await this.resolve(target, timeout, false);
  }

  async waitForFunction(fn: () => unknown, timeout: number) {
    const deadline = Date.now() + timeout;
    while (!(await this.evaluate(fn))) {
      if (Date.now() > deadline) throw new Error(`waitForFunction timed out after ${timeout} ms`);
      await Bun.sleep(100);
    }
  }

  async count(selector: string) {
    return (await this.evaluate(resolveInPage, { selector, scroll: false })).found;
  }

  async addStyle(css: string) {
    await this.evaluate((text) => {
      const style = document.createElement("style");
      style.textContent = text;
      document.head.appendChild(style);
    }, css);
  }

  /**
   * WebKit applies a mouse move only in the active window, and the driver never activates the
   * app, so when the native move leaves `:hover` unset the page gets the events Chromium would
   * fire: out and leave on the old element, over and enter on the new one, then a move. Script
   * handlers (React's onMouseEnter) see them; CSS `:hover` does not, and `hoverMatches` says so.
   */
  async mouseMove(x: number, y: number) {
    await this.driver.call("mouse", { kind: "move", x, y });
    this.mouse = { x, y };
    const hoverMatches = await this.evaluate(
      (point) => {
        const state = ((window as any).__bmtPointer ??= { over: null });
        const el = document.elementFromPoint(point.x, point.y);
        if (el?.matches(":hover")) {
          state.over = el;
          return true;
        }
        const init = {
          bubbles: true,
          cancelable: true,
          clientX: point.x,
          clientY: point.y,
          view: window,
        };
        const chain = (from: any) => {
          const out: Element[] = [];
          for (let n = from; n; n = n.parentElement) out.push(n);
          return out;
        };
        const before = state.over;
        if (before !== el) {
          const entering = chain(el).filter((n) => !chain(before).includes(n));
          const leaving = chain(before).filter((n) => !chain(el).includes(n));
          if (before) {
            const related = { ...init, relatedTarget: el };
            before.dispatchEvent(new PointerEvent("pointerout", related));
            for (const n of leaving)
              n.dispatchEvent(new PointerEvent("pointerleave", { ...related, bubbles: false }));
            before.dispatchEvent(new MouseEvent("mouseout", related));
            for (const n of leaving)
              n.dispatchEvent(new MouseEvent("mouseleave", { ...related, bubbles: false }));
          }
          if (el) {
            const related = { ...init, relatedTarget: before };
            el.dispatchEvent(new PointerEvent("pointerover", related));
            const outsideIn = entering.reverse();
            for (const n of outsideIn)
              n.dispatchEvent(new PointerEvent("pointerenter", { ...related, bubbles: false }));
            el.dispatchEvent(new MouseEvent("mouseover", related));
            for (const n of outsideIn)
              n.dispatchEvent(new MouseEvent("mouseenter", { ...related, bubbles: false }));
          }
          state.over = el;
        }
        el?.dispatchEvent(new PointerEvent("pointermove", init));
        el?.dispatchEvent(new MouseEvent("mousemove", init));
        return false;
      },
      { x, y },
    );
    return { path: hoverMatches ? "native" : "script", hoverMatches };
  }

  /** Last snapshot's facts, recorded with each capture. */
  lastSnapshot?: { width: number; height: number; sourceColorSpace: string; backingScale: number };

  async screenshot(file: string, options: { fullPage?: boolean } = {}) {
    const size = options.fullPage ? await this.growToFullPage() : this.viewport;
    const response = await this.driver
      .call("snapshot", { scale: 2, ...size })
      .catch(async (error) => {
        const { occluded } = await this.driver.json<{ occluded: boolean }>("info");
        // WebKit paints no window that is covered or on a sleeping display
        throw occluded
          ? new Error(`${error.message}; the window is occluded or the display is asleep`)
          : error;
      });
    this.lastSnapshot = JSON.parse(response.headers.get("x-bmt-snapshot") ?? "{}");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()));
  }

  content() {
    return this.evaluate(() => "<!DOCTYPE html>" + document.documentElement.outerHTML);
  }

  async reload() {
    await this.driver.call("reload");
    await this.waitForFunction(() => document.readyState === "complete", 15_000);
  }

  /**
   * The window's content size can differ from the area the page lays out in: on macOS 26 the
   * webview loses 32 px to the title bar, and WebView2's forced device scale changes the CSS px
   * in a window. So this steers by what the page reports, starting from the last ratio seen.
   */
  async resizeWindow(width: number, height: number) {
    const target = [width, height] as const;
    this.clamped = undefined;
    const read = () => this.evaluate(() => [innerWidth, innerHeight] as [number, number]);
    const settled = async () => {
      let last = await read();
      for (const deadline = Date.now() + 2000; Date.now() < deadline;) {
        await Bun.sleep(50);
        const now = await read();
        if (now[0] === last[0] && now[1] === last[1]) return now;
        last = now;
      }
      return last;
    };
    const { emulated } = await this.driver.json<{ emulated: boolean }>("viewport", {
      width,
      height,
      scale: 2,
    });
    if (emulated) {
      await this.driver.call("resize", { width, height });
      const seen = await settled();
      if (seen[0] !== width || seen[1] !== height) {
        throw new Error(`emulated ${width}x${height}, the page sees ${seen[0]}x${seen[1]}`);
      }
      this.viewport = { width, height };
      return;
    }
    let ask = target.map((value, i) => Math.round(value * this.windowPerPage[i]!));
    let seen: [number, number] = [0, 0];
    for (let attempt = 0; attempt < 5; attempt++) {
      await this.driver.call("resize", { width: ask[0], height: ask[1] });
      seen = await settled();
      this.windowPerPage = [ask[0]! / seen[0], ask[1]! / seen[1]];
      if (seen[0] === width && seen[1] === height) {
        this.viewport = { width, height };
        return;
      }
      ask = ask.map((value, i) =>
        Math.round(value + (target[i]! - seen[i]!) * this.windowPerPage[i]!),
      );
    }
    if (seen[0] !== width) {
      throw new Error(`asked for ${width}x${height}, the page sees ${seen[0]}x${seen[1]}`);
    }
    // The OS keeps a window on its screen; Electron's runner accepts the same clamp unchecked
    this.clamped = { asked: [width, height], seen };
    this.viewport = { width: seen[0], height: seen[1] };
  }

  /**
   * Playwright's fullPage: a page taller than the viewport is shot at its scroll height. The
   * window cannot grow past the screen, so the webview grows past the window's bottom edge,
   * and the next resize gives it back the window's frame.
   */
  private async growToFullPage() {
    const height = await this.evaluate(() => document.documentElement.scrollHeight);
    if (height <= this.viewport.height) return this.viewport;
    await this.driver.call("page-height", { height });
    const deadline = Date.now() + 2000;
    let seen = await this.evaluate(() => [innerWidth, innerHeight] as [number, number]);
    while (seen[1] !== height && Date.now() < deadline) {
      await Bun.sleep(50);
      seen = await this.evaluate(() => [innerWidth, innerHeight] as [number, number]);
    }
    if (seen[0] !== this.viewport.width || seen[1] !== height) {
      throw new Error(
        `the page is ${height} CSS px tall, and the grown webview shows ${seen[0]}x${seen[1]}`,
      );
    }
    return { width: seen[0], height };
  }
}

export interface StartTauriOptions {
  /** The data root the app reads its asset cache and data folder from, as a copy. */
  data?: string;
  renderer?: Renderer;
  /**
   * What answers the Electron renderer's `window.api`: the T05 goldens, or the Rust commands
   * through `tauri/src/api.ts`.
   */
  api?: "replay" | "tauri";
  runDir?: string;
  repo?: string;
  binary?: string;
  goldenDir?: string;
  scenario?: string;
  locale?: string;
  viewport?: { width: number; height: number };
  /**
   * Fail unless the page runs in TIME_ZONE. WebKit's WebContent process does not inherit
   * TZ, so on macOS the host's own zone shows through. Only the smoke check turns it off.
   */
  requireTimeZone?: boolean;
  readyTimeoutMs?: number;
  /** Extra arguments after the AppKit locale ones, such as `--hidden`. */
  args?: string[];
  /** Extra environment, such as the shell's stand-ins in `parity_shell.rs`. */
  env?: Record<string, string>;
}

export interface RunningTauri {
  child: ChildProcess;
  driver: TauriDriver;
  engine: TauriEngine;
  runDir: string;
  token: string;
  /** What the app was started with, so a lane can start a second instance the same way. */
  env: Record<string, string>;
  args: string[];
  ctx: DriveContext;
  facts: Record<string, unknown>;
  close(): Promise<void>;
}

/**
 * WebView2 takes Chromium's switches; these match `run-electron.ts`, except the device scale,
 * which the driver sets with the viewport through DevTools emulation, as Playwright does.
 */
const WEBVIEW2_ARGS = [
  "--force-color-profile=srgb",
  "--disable-gpu",
  "--lang=en-US",
  "--disable-backgrounding-occluded-windows",
  // Setting any argument replaces wry's defaults, so its feature switches come back here
  "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,CalculateNativeWinOcclusion",
];

/**
 * The host variables a webview needs to start, by name in any case. Nothing else is
 * inherited, so a BMT_PARITY_* or WEBVIEW2_* left in the shell never reaches a run.
 */
const HOST_ENV = new Set(
  [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "TMPDIR",
    "RUST_BACKTRACE",
    "SystemRoot",
    "SystemDrive",
    "windir",
    "ComSpec",
    "PATHEXT",
    "USERPROFILE",
    "USERNAME",
    "APPDATA",
    "LOCALAPPDATA",
    "ProgramData",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "TEMP",
    "TMP",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
    "OS",
  ].map((name) => name.toLowerCase()),
);

export function childEnv(
  host: NodeJS.ProcessEnv,
  own: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(host)) {
    if (value !== undefined && HOST_ENV.has(name.toLowerCase())) env[name] = value;
  }
  return { ...env, ...own };
}

const within = (work: Promise<unknown>, ms: number) =>
  Promise.race([work.then(() => true), Bun.sleep(ms).then(() => false)]);

/**
 * Stops the app: `quit` through the driver when given, then SIGTERM and SIGKILL until it
 * is gone, so it never outlives the run or keeps holding off display sleep. A quit that
 * fails still ends the app, then fails the run.
 */
export async function stopApp(child: ChildProcess, quit?: () => Promise<unknown>) {
  const exited =
    child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const quitError = quit
    ? await quit().then(
        () => undefined,
        (error: unknown) => (error instanceof Error ? error.message : JSON.stringify(error)),
      )
    : undefined;
  if (!(await within(exited, quit && quitError === undefined ? 5000 : 0))) {
    child.kill();
    if (!(await within(exited, 5000))) child.kill("SIGKILL");
    await exited;
  }
  if (quitError !== undefined) {
    console.error(`run-tauri: quit failed: ${quitError}`);
    throw new Error(`quit failed, so the app was stopped by signal: ${quitError}`);
  }
}

function waitForReadyLine(child: ChildProcess, log: fs.WriteStream, timeoutMs: number) {
  return new Promise<number>((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            `no "${SENTINEL} listening" line within ${timeoutMs} ms. Is it a --features parity-driver build?`,
          ),
        ),
      timeoutMs,
    );
    const onData = (chunk: Buffer) => {
      log.write(chunk);
      buffer += chunk.toString("utf8");
      const match = buffer.match(READY_LINE);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    };
    child.stdout!.on("data", onData);
    child.stderr!.on("data", (chunk: Buffer) => log.write(chunk));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(
        new Error(
          `the Tauri app exited with ${code} before the driver listened; see the run's tauri.log`,
        ),
      );
    });
  });
}

export async function startTauri(options: StartTauriOptions): Promise<RunningTauri> {
  await waitForNoGame();
  const repo = options.repo ?? REPO_DIR;
  const renderer = options.renderer ?? "electron";
  const viewport = options.viewport ?? DEFAULT_VIEWPORT;
  const runDir = path.resolve(
    options.runDir ??
      path.join(
        PARITY_DIR,
        "out",
        "runs",
        `${Date.now()}-tauri-${crypto.randomBytes(3).toString("hex")}`,
      ),
  );
  // An empty data folder has no asset cache to serve
  const dataRoot =
    options.data === undefined || options.data === "empty"
      ? undefined
      : resolveDataRoot(options.data);
  claimRunFolder(runDir, dataRoot);

  const binary = options.binary ?? tauriBinary(repo);
  if (!fs.existsSync(binary)) {
    throw new Error(
      `${binary} is missing. Run \`CI=true bun run tauri build --debug --no-bundle --features parity-driver\` in tauri/.`,
    );
  }
  refuseProductionIdentifier(binary);
  const assets = path.join(runDir, "asset-cache");
  if (dataRoot) copyDataTree(path.join(dataRoot, "asset-cache"), assets);
  // A debug build refuses to start without a root away from the real folder (data_guard.rs),
  // and gets a copy, so a run never writes into the snapshot or fixture it came from
  const appRoot = path.join(runDir, "data-root");
  if (dataRoot) fs.cpSync(dataRoot, appRoot, { recursive: true });
  else fs.mkdirSync(appRoot, { recursive: true });

  let bundle: ReplayBundle | undefined;
  let api: string | undefined;
  const env: Record<string, string> = {
    TZ: TIME_ZONE,
    LANG: "en_US.UTF-8",
    BMT_PARITY_ASSETS: assets,
    // The Rust clock freezes with the page's, as SEAM_FIXED_TIME freezes Electron's main
    BMT_FIXED_TIME: String(FIXED_TIME.getTime()),
    BMT_DATA_ROOT: appRoot,
  };
  if (renderer === "electron") {
    const rendererDir = path.join(repo, "out", "renderer");
    if (!fs.existsSync(path.join(rendererDir, "index.html"))) {
      throw new Error(`${rendererDir} has no build. Run \`npm run build\` in ${repo}.`);
    }
    env.BMT_PARITY_RENDERER_DIR = rendererDir;
  }
  if (renderer === "electron" && options.api === "tauri") {
    const { buildApiBundle } = await import("../tauri/scripts/api-bundle.ts");
    api = await buildApiBundle();
  } else if (renderer === "electron") {
    bundle = buildReplayBundle({
      goldenDir: options.goldenDir ?? path.join(PARITY_DIR, "out", "golden"),
      methods: readInvokeChannels(repo),
      events: readEventMethods(repo),
      locale: options.locale ?? "en-US",
      scenario: options.scenario,
    });
  }
  const init = path.join(runDir, "init.js");
  fs.writeFileSync(init, initScript(bundle, api));
  env.BMT_PARITY_INIT = init;
  if (process.platform === "win32") {
    env.BMT_PARITY_BROWSER_ARGS = WEBVIEW2_ARGS.join(" ");
    env.BMT_PARITY_WEBVIEW_DATA = path.join(runDir, "webview2");
  }
  // Switches for the two proofs the root asked for, passed on only when set
  for (const name of ["BMT_PARITY_ACTIVATION", "BMT_PARITY_COVER"]) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  const token = crypto.randomBytes(16).toString("hex");
  env.BMT_PARITY_TOKEN = token;
  Object.assign(env, options.env);

  // NSUserDefaults' argument domain, so AppKit and WebKit take en-US whatever the system says
  const args = [
    ...(process.platform === "darwin"
      ? ["-AppleLanguages", "(en-US)", "-AppleLocale", "en_US"]
      : []),
    ...(options.args ?? []),
  ];
  const started = Date.now();
  const child = spawn(binary, args, {
    cwd: runDir,
    env: childEnv(process.env, env),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = fs.createWriteStream(path.join(runDir, "tauri.log"));
  try {
    const port = await waitForReadyLine(child, log, options.readyTimeoutMs ?? 60_000);
    const driver = new TauriDriver(port, token);
    const engine = new TauriEngine(driver);
    const close = async () => {
      try {
        await stopApp(child, () => driver.call("quit"));
      } finally {
        log.end();
      }
    };
    await engine.waitForFunction(
      () => document.readyState === "complete" && document.body !== null,
      30_000,
    );
    await engine.resizeWindow(viewport.width, viewport.height);
    await engine.reload();
    const page = await engine.evaluate(() => ({
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      locale: Intl.DateTimeFormat().resolvedOptions().locale,
      now: Date.now(),
      dpr: devicePixelRatio,
      userAgent: navigator.userAgent,
      api: typeof (window as any).api,
    }));
    if (page.timeZone !== TIME_ZONE && options.requireTimeZone !== false) {
      throw new Error(`the webview runs in ${page.timeZone}, not ${TIME_ZONE}`);
    }
    if (page.now !== FIXED_TIME.getTime()) throw new Error(`the page clock reads ${page.now}`);
    const info = await driver.json<Record<string, unknown>>("info");
    const facts = { renderer, binary, launchMs: Date.now() - started, page, window: info };
    fs.writeFileSync(path.join(runDir, "facts.json"), JSON.stringify(facts, null, 1));
    const ctx: DriveContext = { engine, viewport, touchedSettings: new Map() };
    return { child, driver, engine, runDir, token, env, args, ctx, facts, close };
  } catch (error) {
    await stopApp(child);
    log.end();
    throw error;
  }
}

/**
 * Proves the driver's primitives on this machine with no data: the app's own page, a script,
 * native input seen by the page as trusted events, a resize, a snapshot, and refusals. CI runs
 * it on both platforms, which is the first run of WebView2's driver path.
 */
export async function smoke(options: { binary?: string; out?: string }) {
  const viewport = { width: 900, height: 600 };
  const running = await startTauri({
    renderer: "solid",
    binary: options.binary,
    runDir: options.out,
    viewport,
    requireTimeZone: false,
  });
  const { engine, driver } = running;
  const checks: { name: string; pass: boolean; detail: unknown }[] = [];
  const check = (name: string, pass: boolean, detail: unknown) =>
    checks.push({ name, pass, detail });
  try {
    check("eval awaits a promise", (await engine.evaluate("Promise.resolve(21 * 2)")) === 42, 42);
    const thrown = await engine.evaluate("(() => { throw new Error('boom') })()").catch(String);
    check("eval reports a thrown error", String(thrown).includes("boom"), thrown);

    // Styles go through the CSSOM: the app's CSP blocks inline style attributes
    await engine.evaluate(() => {
      const place = (el: HTMLElement, left: number, top: number, width: number, height: number) =>
        Object.assign(el.style, {
          position: "fixed",
          left: `${left}px`,
          top: `${top}px`,
          width: `${width}px`,
          height: `${height}px`,
        });
      const button = document.createElement("button");
      button.id = "b";
      button.textContent = "Press me";
      place(button, 100, 100, 200, 80);
      const input = document.createElement("input");
      input.id = "i";
      place(input, 100, 300, 200, 30);
      const twins = ["first", "second"].flatMap((name, i) => {
        const area = document.createElement("textarea");
        area.className = "twin";
        area.textContent = name;
        place(area, 400, 100 + i * 60, 200, 40);
        const pane = document.createElement("div");
        pane.className = "pane";
        pane.textContent = `${name} pane`;
        place(pane, 650, 100 + i * 120, 200, 100);
        pane.style.overflow = "auto";
        const tall = document.createElement("div");
        tall.style.height = "1000px";
        pane.append(tall);
        return [area, pane];
      });
      document.body.replaceChildren(button, input, ...twins);
      const seen: string[] = ((window as any).__seen = []);
      for (const type of ["mousemove", "mousedown", "mouseup", "click", "keydown", "keyup"]) {
        document.addEventListener(type, (e: any) =>
          seen.push(`${type}:${e.isTrusted}:${e.key ?? ""}:${e.clientX ?? ""},${e.clientY ?? ""}`),
        );
      }
    });
    const seenHover = (lines: string[]) =>
      lines.some((line) => /^mousemove:(true|false)::200,140$/.test(line));
    await engine.hover({ selector: "#b" });
    // WebKit sets :hover only in the active window, which the driver never makes it
    check(
      "hover reaches the page's handlers",
      seenHover(await engine.evaluate<string[]>("window.__seen")),
      engine.lastHover,
    );
    await engine.click({ selector: "#b" });
    await engine.click({ selector: "#i" });
    await engine.press("a");
    await engine.press("Enter");
    // A loaded CI runner delivers the events late: macos-latest had not seen Enter after 300 ms
    await engine
      .waitForFunction(
        () => (window as any).__seen.some((l: string) => l.startsWith("keyup:true:Enter")),
        5000,
      )
      .catch(() => undefined);
    const seen = await engine.evaluate<string[]>("window.__seen");
    const has = (prefix: string) => seen.some((line) => line.startsWith(prefix));
    check("a click arrives as trusted events", has("mousedown:true") && has("click:true"), seen);
    check("the click lands at the element's center", has("click:true::200,140"), seen);
    check(
      "keys arrive as trusted events",
      has("keydown:true:a") && has("keydown:true:Enter"),
      seen,
    );
    const typed = await engine.evaluate<string>("document.getElementById('i').value");
    check("a key types into the focused input", typed === "a", typed);

    const hasText = [
      await engine.count('button:has-text("press ME")'),
      await engine.count('button:has-text("nope")'),
    ];
    check("count takes a :has-text selector", hasText[0] === 1 && hasText[1] === 0, hasText);
    await engine.fill({ selector: "textarea.twin", text: "second" }, "typed");
    const areas = await engine.evaluate(() =>
      [...document.querySelectorAll("textarea")].map((a) => a.value),
    );
    check(
      "fill takes the element its text filter picks",
      areas[0] === "first" && areas[1] === "typed",
      areas,
    );
    await engine.scrollBy({ selector: "text=second pane" }, 50);
    const scrolled = await engine.evaluate(() =>
      [...document.querySelectorAll(".pane")].map((p) => p.scrollTop),
    );
    check("scrollBy takes a text= target", scrolled[0] === 0 && scrolled[1] === 50, scrolled);

    await engine.resizeWindow(1000, 640);
    const size = await engine.evaluate<number[]>("[innerWidth, innerHeight]");
    check("resize reaches the page", size[0] === 1000 && size[1] === 640, size);

    const file = path.join(running.runDir, "smoke.png");
    await engine.screenshot(file);
    const png = fs.readFileSync(file);
    const pngSize = [png.readUInt32BE(16), png.readUInt32BE(20)];
    check("the snapshot is the viewport at 2x", pngSize[0] === 2000 && pngSize[1] === 1280, {
      pngSize,
      ...engine.lastSnapshot,
    });

    const url = `http://127.0.0.1:${driver.port}/`;
    const post = (headers: Record<string, string>) =>
      fetch(url, { method: "POST", headers, body: '{"op":"info"}' }).then((r) => r.status);
    const noToken = await post({});
    const wrong = await post({ authorization: "Bearer 0000000000000000" });
    check("a request without the token is refused", noToken === 401, noToken);
    check("a request with a wrong token is refused", wrong === 401, wrong);
    const home = await engine.evaluate<string>("location.href");
    const navigate = await driver
      .call("navigate", { url: "file:///etc/hosts", timeoutMs: 2000 })
      .then(() => "navigated", String);
    check("navigate refuses a file: URL", navigate.includes("refused"), navigate);
    await engine.evaluate((url) => void (location.href = url), "https://example.com/");
    await Bun.sleep(1000);
    const after = await engine.evaluate<string>("location.href");
    check("the page cannot leave its origin", after === home, { home, after });
    check("the facts are recorded", true, running.facts);
  } finally {
    await running.close();
  }
  fs.writeFileSync(path.join(running.runDir, "smoke.json"), JSON.stringify(checks, null, 1));
  for (const c of checks)
    console.log(`${c.pass ? "PASS" : "FAIL"} ${c.name} ${JSON.stringify(c.detail)}`);
  return checks.every((c) => c.pass);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const value = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
  if (args[0] === "--smoke") {
    const ok = await smoke({ binary: value("--binary"), out: value("--out") });
    process.exit(ok ? 0 : 1);
  }
  const renderer = (value("--renderer") ?? "electron") as Renderer;
  if (!["electron", "solid"].includes(renderer)) {
    console.error(
      "usage: bun parity/run-tauri.ts [--renderer electron|solid] [--api replay|tauri] [--data <fixture|snapshot|folder>] [--state <id>] [--out <run folder>] [--golden <dir>] [--scenario <events file>] [--binary <path>]",
    );
    process.exit(2);
  }
  const { STATES, applyState, resolveVars } = await import("./states.ts");
  const stateId = value("--state");
  const state = stateId ? STATES.find((s) => s.id === stateId) : undefined;
  if (stateId && !state) {
    console.error(`unknown state ${stateId}. Known: ${STATES.map((s) => s.id).join(", ")}`);
    process.exit(2);
  }
  const running = await startTauri({
    data: value("--data") ?? (renderer === "electron" ? "fixture" : undefined),
    renderer,
    api: value("--api") === "tauri" ? "tauri" : "replay",
    runDir: value("--out"),
    goldenDir: value("--golden"),
    scenario: value("--scenario"),
    binary: value("--binary"),
    viewport: state?.viewport,
  });
  try {
    if (state) {
      await applyState(running.ctx, state, await resolveVars(running.engine));
      const png = path.join(running.runDir, `${state.id}.png`);
      fs.writeFileSync(
        path.join(running.runDir, `${state.id}.geometry.json`),
        await dumpGeometry(running.engine),
      );
      await running.engine.screenshot(png);
      console.log(`wrote ${png} and ${state.id}.geometry.json`);
    } else {
      await settle(running.engine, running.ctx.viewport);
    }
  } catch (error) {
    await running.close();
    throw error;
  }
  const control = serveControl({
    ctx: running.ctx,
    runDir: running.runDir,
    token: running.token,
    driverPort: running.driver.port,
    close: () => running.close(),
  });
  console.log(`ready run=${running.runDir} control=127.0.0.1:${control.port}`);
  // The window floats above others, so it must not stay up over a League game
  const watch = setInterval(async () => {
    if (!gameRunning()) return;
    clearInterval(watch);
    console.log("a League game started, closing the Tauri window");
    await running.close();
    process.exit(3);
  }, 5000);
}
