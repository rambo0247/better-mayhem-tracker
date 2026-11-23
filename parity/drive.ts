import fs from "node:fs";
import path from "node:path";
import { refuseRealFolder } from "./lib/real-folder.ts";
import { settle } from "./settle.ts";

export type Step =
  | { op: "click"; selector: string; nth?: number; text?: string; button?: "left" | "right" }
  | { op: "hover"; selector: string; nth?: number }
  | { op: "type"; selector: string; text: string }
  | { op: "key"; key: string }
  | { op: "scroll"; selector?: string; dy: number }
  | { op: "resize"; width: number; height: number }
  | { op: "navigate"; hash: string }
  | { op: "wait"; ms: number }
  | { op: "waitFor"; selector: string; text?: string; timeout?: number }
  | { op: "setting"; key: string; value: string }
  | { op: "local"; key: string; value: string }
  | { op: "settle" }
  /** A main-process hook: `globalThis.__parity[call](arg)` in Electron (seam-overlays.cjs), the driver's answers in Tauri. */
  | { op: "main"; call: string; arg?: unknown };

export interface Target {
  selector: string;
  nth?: number;
  /** Keeps only elements whose text contains this, as Playwright's `filter({ hasText })`. */
  text?: string;
}

/**
 * What the parity tools need from a running app. Selectors follow Playwright: CSS, or
 * `text=...`, the first match unless `nth` says otherwise. `PlaywrightEngine` drives
 * Electron; `TauriEngine` drives the Tauri webview through its parity driver.
 */
export interface Engine {
  readonly name: "playwright" | "tauri";
  /** Runs a function (serialized with its source, so it may use only its argument) or an expression. */
  evaluate<R, A = undefined>(fn: string | ((arg: A) => R | Promise<R>), arg?: A): Promise<R>;
  click(target: Target, button?: "left" | "right"): Promise<void>;
  hover(target: Target): Promise<void>;
  /** Sets the value and fires `input`, as Playwright's `fill`. */
  fill(target: Target, text: string): Promise<void>;
  press(key: string): Promise<void>;
  /** A wheel turn at the mouse's position. */
  wheel(dy: number): Promise<void>;
  scrollBy(target: Target, dy: number): Promise<void>;
  waitFor(target: Target, timeout: number): Promise<void>;
  waitForFunction(fn: () => unknown, timeout: number): Promise<void>;
  count(selector: string): Promise<number>;
  addStyle(css: string): Promise<void>;
  mouseMove(x: number, y: number): Promise<void>;
  screenshot(file: string, options?: { fullPage?: boolean }): Promise<void>;
  content(): Promise<string>;
  /** Reloads and waits for the load event. */
  reload(): Promise<void>;
  /** Sets the content size and waits until the page sees it. */
  resizeWindow(width: number, height: number): Promise<void>;
}

export interface DriveContext {
  engine: Engine;
  /** Runs a `main` step's call in the app's main process, where the runner offers one. */
  main?: (call: string, arg?: unknown) => Promise<unknown>;
  viewport: { width: number; height: number };
  touchedSettings: Map<string, string | null>;
}

export const expand = (text: string, vars: Record<string, string>) =>
  text.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = vars[name];
    if (value === undefined) throw new Error(`state needs {${name}} and it was never resolved`);
    return value;
  });

export async function runStep(
  ctx: DriveContext,
  step: Step,
  vars: Record<string, string> = {},
): Promise<void> {
  const { engine } = ctx;
  switch (step.op) {
    case "click":
      await engine.click(
        { selector: expand(step.selector, vars), nth: step.nth, text: step.text },
        step.button,
      );
      return;
    case "hover":
      await engine.hover({ selector: expand(step.selector, vars), nth: step.nth });
      return;
    case "type":
      await engine.fill({ selector: expand(step.selector, vars) }, expand(step.text, vars));
      return;
    case "key":
      await engine.press(step.key);
      return;
    case "scroll":
      if (step.selector) await engine.scrollBy({ selector: expand(step.selector, vars) }, step.dy);
      else await engine.wheel(step.dy);
      return;
    case "resize":
      ctx.viewport = { width: step.width, height: step.height };
      await engine.resizeWindow(step.width, step.height);
      return;
    case "navigate":
      await engine.evaluate((hash) => (location.hash = hash), expand(step.hash, vars));
      return;
    case "wait":
      await Bun.sleep(step.ms);
      return;
    case "waitFor":
      await engine.waitFor(
        { selector: expand(step.selector, vars), text: step.text },
        step.timeout ?? 10_000,
      );
      return;
    case "setting": {
      const first = !ctx.touchedSettings.has(step.key);
      const before = first
        ? await engine.evaluate((key) => window.api.getSetting(key), step.key)
        : null;
      await engine.evaluate(
        ([key, value]) => window.api.setSetting(key!, value!),
        [step.key, step.value],
      );
      // Only a write that happened needs undoing
      if (first) ctx.touchedSettings.set(step.key, before);
      return;
    }
    case "local":
      await engine.evaluate(
        ([key, value]) => localStorage.setItem(key!, value!),
        [step.key, step.value],
      );
      return;
    case "settle":
      await settle(engine, ctx.viewport);
      return;
    case "main":
      if (!ctx.main) throw new Error("this app has no main-process hooks");
      await ctx.main(step.call, step.arg);
      return;
  }
}

export async function restoreSettings(ctx: DriveContext) {
  const touched = [...ctx.touchedSettings];
  // Cleared first, so a restore that fails fails one state and not every state after it
  ctx.touchedSettings.clear();
  for (const [key, value] of touched) {
    await ctx.engine.evaluate(([k, v]) => window.api.setSetting(k!, v ?? ""), [key, value] as [
      string,
      string | null,
    ]);
  }
}

const GEOMETRY_SOURCE = fs.readFileSync(path.join(import.meta.dir, "geometry.js"), "utf8");

export function dumpGeometry(engine: Engine): Promise<string> {
  return engine.evaluate<string>(GEOMETRY_SOURCE);
}

declare global {
  interface Window {
    api: {
      getSetting(key: string): Promise<string | null>;
      setSetting(key: string, value: string): Promise<void>;
    };
  }
}

export interface Control {
  port: number;
  token: string;
  /** The Tauri driver's own port, when the app is Tauri. */
  driverPort?: number;
}

/**
 * Serves `POST /drive` for `drive.ts --run`: a Step, or `shot`, `dom`, `geometry`, `quit`.
 * Both runners use it, so every op means the same thing for both apps.
 */
export function serveControl(options: {
  ctx: DriveContext;
  runDir: string;
  token: string;
  driverPort?: number;
  close: () => Promise<unknown>;
}): Control {
  const { ctx, runDir, token } = options;
  const shutdown = async () => {
    await options.close();
    process.exit(0);
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.headers.get("authorization") !== `Bearer ${token}`) {
        return new Response("refused", { status: 401 });
      }
      const body = (await request.json()) as Step & { op: string; path?: string };
      try {
        if (body.op === "quit") {
          setTimeout(shutdown, 50);
          return new Response("bye");
        }
        if (body.op === "shot") {
          const file = body.path ?? path.join(runDir, "shot.png");
          refuseRealFolder(file, "screenshot path");
          await ctx.engine.screenshot(file);
          return new Response(file);
        }
        if (body.op === "dom") return new Response(await ctx.engine.content());
        if (body.op === "geometry") return new Response(await dumpGeometry(ctx.engine));
        await runStep(ctx, body as Step);
        return new Response("ok");
      } catch (error) {
        return new Response(String(error), { status: 500 });
      }
    },
  });
  const control: Control = { port: server.port!, token, driverPort: options.driverPort };
  fs.writeFileSync(path.join(runDir, "control.json"), JSON.stringify(control));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return control;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const runAt = args.indexOf("--run");
  const run = runAt >= 0 ? args[runAt + 1] : undefined;
  const rest = args.filter((_, i) => i !== runAt && i !== runAt + 1);
  const [op, ...values] = rest;
  if (!run || !op) {
    console.error(
      "usage: bun parity/drive.ts --run <run folder> <click|hover|type|key|scroll|resize|navigate|wait|waitFor|settle|main|shot|dom|geometry|quit> [args]",
    );
    process.exit(2);
  }
  const control = JSON.parse(fs.readFileSync(path.join(run, "control.json"), "utf8")) as Control;
  const request: Record<string, unknown> = { op };
  if (["click", "hover"].includes(op))
    Object.assign(request, { selector: values[0], text: values[1], button: values[2] });
  else if (op === "main")
    Object.assign(request, { call: values[0], arg: values[1] ? JSON.parse(values[1]) : undefined });
  else if (op === "type") Object.assign(request, { selector: values[0], text: values[1] });
  else if (op === "key") request.key = values[0];
  else if (op === "scroll") Object.assign(request, { dy: Number(values[0]), selector: values[1] });
  else if (op === "resize")
    Object.assign(request, { width: Number(values[0]), height: Number(values[1]) });
  else if (op === "navigate") request.hash = values[0];
  else if (op === "wait") request.ms = Number(values[0]);
  else if (op === "waitFor") Object.assign(request, { selector: values[0], text: values[1] });
  else if (op === "shot") request.path = values[0];
  const response = await fetch(`http://127.0.0.1:${control.port}/drive`, {
    method: "POST",
    headers: { authorization: `Bearer ${control.token}`, "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  const body = await response.text();
  console.log(body);
  process.exit(response.ok ? 0 : 1);
}
