import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { settle } from "./settle.ts";

export type Step =
  | { op: "click"; selector: string; nth?: number; text?: string }
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
  | { op: "settle" };

export interface DriveContext {
  page: Page;
  viewport: { width: number; height: number };
  resizeWindow: (width: number, height: number) => Promise<void>;
  touchedSettings: Map<string, string | null>;
}

const locate = (page: Page, selector: string, nth?: number, text?: string) => {
  let locator = page.locator(selector);
  if (text !== undefined) locator = locator.filter({ hasText: text });
  return nth === undefined ? locator.first() : locator.nth(nth);
};

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
  const { page } = ctx;
  switch (step.op) {
    case "click":
      await locate(page, expand(step.selector, vars), step.nth, step.text).click();
      return;
    case "hover":
      await locate(page, expand(step.selector, vars), step.nth).hover();
      return;
    case "type":
      await locate(page, expand(step.selector, vars)).fill(expand(step.text, vars));
      return;
    case "key":
      await page.keyboard.press(step.key);
      return;
    case "scroll":
      if (step.selector) {
        await locate(page, expand(step.selector, vars)).evaluate(
          (el, dy) => el.scrollBy(0, dy),
          step.dy,
        );
      } else {
        await page.mouse.wheel(0, step.dy);
      }
      return;
    case "resize":
      ctx.viewport = { width: step.width, height: step.height };
      await ctx.resizeWindow(step.width, step.height);
      return;
    case "navigate":
      await page.evaluate((hash) => (location.hash = hash), expand(step.hash, vars));
      return;
    case "wait":
      await page.waitForTimeout(step.ms);
      return;
    case "waitFor": {
      const locator = locate(page, expand(step.selector, vars), undefined, step.text);
      await locator.waitFor({ state: "visible", timeout: step.timeout ?? 10_000 });
      return;
    }
    case "setting": {
      if (!ctx.touchedSettings.has(step.key)) {
        const before = await page.evaluate((key) => window.api.getSetting(key), step.key);
        ctx.touchedSettings.set(step.key, before);
      }
      await page.evaluate(
        ([key, value]) => window.api.setSetting(key!, value!),
        [step.key, step.value],
      );
      return;
    }
    case "local":
      await page.evaluate(
        ([key, value]) => localStorage.setItem(key!, value!),
        [step.key, step.value],
      );
      return;
    case "settle":
      await settle(page, ctx.viewport);
      return;
  }
}

export async function restoreSettings(ctx: DriveContext) {
  for (const [key, value] of ctx.touchedSettings) {
    await ctx.page.evaluate(([k, v]) => window.api.setSetting(k!, v ?? ""), [key, value] as [
      string,
      string | null,
    ]);
  }
  ctx.touchedSettings.clear();
}

export async function dumpGeometry(page: Page): Promise<string> {
  const source = fs.readFileSync(path.join(import.meta.dir, "geometry.js"), "utf8");
  return page.evaluate(source) as Promise<string>;
}

declare global {
  interface Window {
    api: {
      getSetting(key: string): Promise<string | null>;
      setSetting(key: string, value: string): Promise<void>;
    };
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const runAt = args.indexOf("--run");
  const run = runAt >= 0 ? args[runAt + 1] : undefined;
  const rest = args.filter((_, i) => i !== runAt && i !== runAt + 1);
  const [op, ...values] = rest;
  if (!run || !op) {
    console.error(
      "usage: bun parity/drive.ts --run <run folder> <click|hover|type|key|scroll|resize|navigate|wait|waitFor|settle|shot|dom|geometry> [args]",
    );
    process.exit(2);
  }
  const control = JSON.parse(fs.readFileSync(path.join(run, "control.json"), "utf8")) as {
    port: number;
    token: string;
  };
  const request: Record<string, unknown> = { op };
  if (["click", "hover"].includes(op))
    Object.assign(request, { selector: values[0], text: values[1] });
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
