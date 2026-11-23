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
import { PARITY_DIR, REPO_DIR, resolveDataRoot } from "./lib/data.ts";
import { waitForNoGame } from "./lib/no-game.ts";
import { refuseRealFolder } from "./lib/real-folder.ts";
import { DEFAULT_VIEWPORT, FIXED_TIME, TIME_ZONE } from "./run-electron.ts";
import { settle } from "./settle.ts";

export const SENTINEL = "bmt-parity-driver-v1";
export type Renderer = "electron" | "solid";

const READY_LINE = new RegExp(`${SENTINEL} listening 127\\.0\\.0\\.1:(\\d+)`);

/** The debug build with `--features parity-driver`. */
export function tauriBinary(repo: string = REPO_DIR): string {
  const exe = process.platform === "win32" ? ".exe" : "";
  const target = process.env.CARGO_TARGET_DIR ?? path.join(repo, "tauri", "src-tauri", "target");
  return path.join(target, "debug", `better-mayhem-tracker-tauri${exe}`);
}

// ---------------------------------------------------------------------------
// Replay bundle

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

export function initScript(bundle: ReplayBundle | undefined): string {
  const parts = [clockScript(FIXED_TIME.getTime())];
  if (bundle) {
    parts.push(`globalThis.__BMT_REPLAY__ = ${JSON.stringify(bundle)};`);
    parts.push(fs.readFileSync(path.join(PARITY_DIR, "replay-api.js"), "utf8"));
  }
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Driver client and engine

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
 * `text=` (case-insensitive substring, innermost element), `filter({ hasText })`, first or nth.
 * Scrolls it into view and returns its center.
 */
function resolveInPage(target: { selector: string; nth?: number; text?: string; scroll: boolean }) {
  const normalize = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const all = (selector: string): Element[] => {
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

  async click(target: Target) {
    const { x, y } = await this.resolve(target);
    await this.mouseMove(x, y);
    await this.driver.call("mouse", { kind: "down", x, y });
    await this.driver.call("mouse", { kind: "up", x, y });
  }

  async hover(target: Target) {
    const { x, y } = await this.resolve(target);
    const reply = await this.driver.json<{ path: string }>("mouse", { kind: "move", x, y });
    this.mouse = { x, y };
    const hoverMatches = await this.evaluate(
      (point) => document.elementFromPoint(point.x, point.y)?.matches(":hover") ?? false,
      { x, y },
    );
    this.lastHover = { path: reply.path, hoverMatches };
  }

  async fill(target: Target, text: string) {
    await this.resolve(target);
    await this.evaluate(
      ({ target: t, text: value }) => {
        const el = document.querySelectorAll(t.selector)[t.nth ?? 0] as HTMLInputElement;
        el.focus();
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
        Object.getOwnPropertyDescriptor(proto.prototype, "value")!.set!.call(el, value);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      },
      { target, text },
    );
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
    await this.evaluate(
      ({ target: t, dy: by }) => document.querySelectorAll(t.selector)[t.nth ?? 0]!.scrollBy(0, by),
      { target, dy },
    );
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

  async mouseMove(x: number, y: number) {
    await this.driver.call("mouse", { kind: "move", x, y });
    this.mouse = { x, y };
  }

  /** Last snapshot's facts, recorded with each capture. */
  lastSnapshot?: { width: number; height: number; sourceColorSpace: string; backingScale: number };

  async screenshot(file: string) {
    const response = await this.driver.call("snapshot", { scale: 2 });
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

  async resizeWindow(width: number, height: number) {
    await this.driver.call("resize", { width, height });
    const deadline = Date.now() + 5000;
    for (;;) {
      const seen = await this.evaluate(() => [innerWidth, innerHeight]);
      if (seen[0] === width && seen[1] === height) return;
      if (Date.now() > deadline) {
        throw new Error(`asked for ${width}x${height}, the page sees ${seen[0]}x${seen[1]}`);
      }
      await Bun.sleep(50);
    }
  }
}

// ---------------------------------------------------------------------------
// Launch

export interface StartTauriOptions {
  data: string;
  renderer?: Renderer;
  runDir?: string;
  repo?: string;
  binary?: string;
  goldenDir?: string;
  scenario?: string;
  locale?: string;
  viewport?: { width: number; height: number };
}

export interface RunningTauri {
  child: ChildProcess;
  driver: TauriDriver;
  engine: TauriEngine;
  runDir: string;
  token: string;
  ctx: DriveContext;
  facts: Record<string, unknown>;
  close(): Promise<void>;
}

/** WebView2 takes Chromium's switches; these match `run-electron.ts`. */
const WEBVIEW2_ARGS = [
  "--force-device-scale-factor=2",
  "--force-color-profile=srgb",
  "--disable-gpu",
  "--lang=en-US",
  "--disable-backgrounding-occluded-windows",
  // Setting any argument replaces wry's defaults, so its feature switches come back here
  "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,CalculateNativeWinOcclusion",
];

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
  refuseRealFolder(runDir, "run folder");
  fs.rmSync(runDir, { recursive: true, force: true });
  fs.mkdirSync(runDir, { recursive: true });

  const binary = options.binary ?? tauriBinary(repo);
  if (!fs.existsSync(binary)) {
    throw new Error(
      `${binary} is missing. Run \`CI=true bun run tauri build --debug --no-bundle --features parity-driver\` in tauri/.`,
    );
  }
  const dataRoot = resolveDataRoot(options.data);
  const assets = path.join(runDir, "asset-cache");
  if (fs.existsSync(path.join(dataRoot, "asset-cache"))) {
    fs.cpSync(path.join(dataRoot, "asset-cache"), assets, { recursive: true });
  }

  let bundle: ReplayBundle | undefined;
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    TZ: TIME_ZONE,
    LANG: "en_US.UTF-8",
    BMT_PARITY_ASSETS: assets,
  };
  if (renderer === "electron") {
    const rendererDir = path.join(repo, "out", "renderer");
    if (!fs.existsSync(path.join(rendererDir, "index.html"))) {
      throw new Error(`${rendererDir} has no build. Run \`npm run build\` in ${repo}.`);
    }
    env.BMT_PARITY_RENDERER_DIR = rendererDir;
    bundle = buildReplayBundle({
      goldenDir: options.goldenDir ?? path.join(PARITY_DIR, "out", "golden"),
      methods: readInvokeChannels(repo),
      events: readEventMethods(repo),
      locale: options.locale ?? "en-US",
      scenario: options.scenario,
    });
  }
  const init = path.join(runDir, "init.js");
  fs.writeFileSync(init, initScript(bundle));
  env.BMT_PARITY_INIT = init;
  if (process.platform === "win32") {
    env.BMT_PARITY_BROWSER_ARGS = WEBVIEW2_ARGS.join(" ");
    env.BMT_PARITY_WEBVIEW_DATA = path.join(runDir, "webview2");
  }
  const token = crypto.randomBytes(16).toString("hex");
  env.BMT_PARITY_TOKEN = token;

  // NSUserDefaults' argument domain, so AppKit and WebKit take en-US whatever the system says
  const args =
    process.platform === "darwin" ? ["-AppleLanguages", "(en-US)", "-AppleLocale", "en_US"] : [];
  const started = Date.now();
  const child = spawn(binary, args, { cwd: runDir, env, stdio: ["ignore", "pipe", "pipe"] });
  const log = fs.createWriteStream(path.join(runDir, "tauri.log"));
  const port = await waitForReadyLine(child, log, 60_000);
  const driver = new TauriDriver(port, token);
  const engine = new TauriEngine(driver);

  const close = async () => {
    await driver.call("quit").catch(() => {});
    const exited = new Promise((resolve) => child.once("exit", resolve));
    const timeout = Bun.sleep(5000).then(() => "timeout");
    if ((await Promise.race([exited, timeout])) === "timeout") child.kill();
    log.end();
  };

  try {
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
    if (page.timeZone !== TIME_ZONE) {
      throw new Error(`the webview runs in ${page.timeZone}, not ${TIME_ZONE}`);
    }
    if (page.now !== FIXED_TIME.getTime()) throw new Error(`the page clock reads ${page.now}`);
    const info = await driver.json<Record<string, unknown>>("info");
    const facts = { renderer, binary, launchMs: Date.now() - started, page, window: info };
    fs.writeFileSync(path.join(runDir, "facts.json"), JSON.stringify(facts, null, 1));
    const ctx: DriveContext = { engine, viewport, touchedSettings: new Map() };
    return { child, driver, engine, runDir, token, ctx, facts, close };
  } catch (error) {
    await close();
    throw error;
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const value = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
  const renderer = (value("--renderer") ?? "electron") as Renderer;
  if (!["electron", "solid"].includes(renderer)) {
    console.error(
      "usage: bun parity/run-tauri.ts [--renderer electron|solid] [--data <fixture|snapshot|folder>] [--state <id>] [--out <run folder>] [--golden <dir>] [--scenario <events file>] [--binary <path>]",
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
    data: value("--data") ?? "fixture",
    renderer,
    runDir: value("--out"),
    goldenDir: value("--golden"),
    scenario: value("--scenario"),
    binary: value("--binary"),
    viewport: state?.viewport,
  });
  if (state) {
    const vars = await resolveVars(running.engine);
    await applyState(running.ctx, state, vars);
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
  const control = serveControl({
    ctx: running.ctx,
    runDir: running.runDir,
    token: running.token,
    driverPort: running.driver.port,
    close: () => running.close(),
  });
  console.log(`ready run=${running.runDir} control=127.0.0.1:${control.port}`);
}
