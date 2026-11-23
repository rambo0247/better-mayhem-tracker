import type { Json } from "./golden-format.ts";

/**
 * Fields whose value depends on the wall clock, by key name. Both sides replace them with
 * CLOCK_MARK before comparing. A name goes here only after two recordings of the same fixture
 * disagreed on it, so the list is evidence rather than a guess.
 */
export const CLOCK_FIELDS: ReadonlySet<string> = new Set<string>([]);

export const CLOCK_MARK = "<clock>";

export interface CanonOptions {
  clockFields?: ReadonlySet<string>;
}

function mask(value: Json | undefined, fields: ReadonlySet<string>): Json | undefined {
  if (value === undefined || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => mask(item, fields) as Json);
  const out: { [key: string]: Json } = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = fields.has(key) ? CLOCK_MARK : (mask(value[key], fields) as Json);
  }
  return out;
}

/**
 * The form both sides compare. Keys are sorted at every depth. A number keeps the digits
 * JavaScript prints, so `3` and `3.0` are the same value and `0.1 + 0.2` stays `0.30000000000000004`.
 * `undefined` canonicalizes as `null`: Electron resolves a void command with `undefined`, Tauri with `null`.
 */
export function canonicalize(value: Json | undefined, options: CanonOptions = {}): string {
  const masked = mask(value ?? null, options.clockFields ?? CLOCK_FIELDS);
  return JSON.stringify(masked ?? null);
}

export const canonEqual = (a: Json | undefined, b: Json | undefined, options?: CanonOptions) =>
  canonicalize(a, options) === canonicalize(b, options);
