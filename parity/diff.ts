import fs from "node:fs";
import path from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { refuseRealFolder } from "./lib/real-folder.ts";

export type Policy = "same-engine" | "cross-engine";
type Box = [path: string, tag: string, x: number, y: number, w: number, h: number];
/**
 * What `geometry.js` adds after a box: "ellipsis" when an ancestor truncates its overflowing
 * text, and an `img`'s natural size once it has decoded.
 */
export type Mark = "ellipsis" | { image: [naturalWidth: number, naturalHeight: number] };
export type GeometryRow = [...Box, ...Mark[]];
export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * An element with a backdrop blur, which WebKit snapshots do not draw. `keep` holds the dialog
 * panels inside it: they draw no blur of their own, so the page count still covers them.
 */
export interface BlurRegion extends Region {
  keep?: Region[];
}

/** The focused element as `capture.ts` records it, with what decides whether it shows a ring. */
export interface FocusMeta {
  /** The element's path in `geometry.js`'s walk. */
  path: string;
  box: Region;
  outline: { width: number; offset: number } | null;
  focusVisible: boolean;
  focusMatches: boolean;
  documentHasFocus: boolean;
}

export const SAME_ENGINE = { threshold: 0.03, includeAA: true, allowedPixels: 0 };
export const CROSS_ENGINE = {
  threshold: 0.1,
  includeAA: false,
  pageBudget: 0.003,
  tileCss: 64,
  tileBudget: 0.08,
  blurThreshold: 0.2,
  layoutToleranceCss: 1,
  /** Rule E: how far, in device px, and by how many levels a scaled image's pixel may move. */
  imageReachDevicePx: 1,
  imageToleranceLevels: 8,
};

export interface LayoutResult {
  pass: boolean;
  elementsA: number;
  elementsB: number;
  identical: number;
  within05: number;
  within1: number;
  beyond: number;
  pathMismatches: number;
  /** Pairs compared on x, y and height only, because both sit inside a truncating ancestor. */
  widthExempt: number;
  worst?: { path: string; shiftCss: number };
}

export interface DiffResult {
  policy: Policy;
  pass: boolean;
  reasons: string[];
  size: [number, number];
  differing: number;
  differingPct: number;
  worstTile?: { differing: number; pct: number };
  blurRegions: { region: Region; worstTilePct: number; pass: boolean }[];
  /** Register rule E: scaled images whose box the tile rule leaves out when their crops agree. */
  scaledImages: { path: string; region: Region; displacedTilePct: number; exempt: boolean }[];
  /** Register rule F: the focus ring box the tile rule leaves out, when Tauri's window can't draw it. */
  unfocusedRing?: { path: string; region: Region };
  layout?: LayoutResult;
  diffImage?: PNG;
}

export interface DiffOptions {
  policy: Policy;
  geometryA?: GeometryRow[];
  geometryB?: GeometryRow[];
  blurRegions?: BlurRegion[];
  /** The focused element in each capture, Electron's first. */
  focus?: [FocusMeta | null, FocusMeta | null];
  /** Device pixels per CSS pixel in both images. */
  scale?: number;
}

export function compareLayout(
  a: GeometryRow[],
  b: GeometryRow[],
  toleranceCss: number,
): LayoutResult {
  const result: LayoutResult = {
    pass: true,
    elementsA: a.length,
    elementsB: b.length,
    identical: 0,
    within05: 0,
    within1: 0,
    beyond: 0,
    pathMismatches: 0,
    widthExempt: 0,
  };
  const pairs = Math.min(a.length, b.length);
  let worst = 0;
  for (let i = 0; i < pairs; i++) {
    const rowA = a[i]!;
    const rowB = b[i]!;
    const pathA = rowA[0];
    if (pathA !== rowB[0]) {
      result.pathMismatches++;
      continue;
    }
    // Chromium's inline box under text-overflow: ellipsis spans the ellipsis, WebKit's the text
    // run, so their widths differ while nothing moves (the register in README.md).
    const widthExempt = rowA[6] === "ellipsis" && rowB[6] === "ellipsis";
    if (widthExempt) result.widthExempt++;
    const keys = widthExempt ? ([2, 3, 5] as const) : ([2, 3, 4, 5] as const);
    const shift = Math.max(...keys.map((k) => Math.abs(rowA[k] - rowB[k])));
    if (shift === 0) result.identical++;
    else if (shift <= 0.5) result.within05++;
    else if (shift <= toleranceCss) result.within1++;
    else result.beyond++;
    if (shift > worst) {
      worst = shift;
      result.worst = { path: pathA, shiftCss: +shift.toFixed(2) };
    }
  }
  result.pass =
    a.length === b.length && result.pathMismatches === 0 && result.beyond === 0 && a.length > 0;
  return result;
}

/**
 * Images drawn at a size other than their natural one, at the same box in both engines within
 * one device pixel: each engine resamples them on its own pixel grid (register rule E).
 */
export function scaledImages(
  a: GeometryRow[],
  b: GeometryRow[],
  scale: number,
): { path: string; region: Region }[] {
  const natural = (row: GeometryRow) =>
    row.slice(6).find((mark): mark is Exclude<Mark, string> => typeof mark === "object")?.image;
  const found: { path: string; region: Region }[] = [];
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const rowA = a[i]!;
    const rowB = b[i]!;
    const [na, nb] = [natural(rowA), natural(rowB)];
    if (rowA[0] !== rowB[0] || !na || !nb || na[0] !== nb[0] || na[1] !== nb[1]) continue;
    if (([2, 3, 4, 5] as const).some((k) => Math.abs(rowA[k] - rowB[k]) * scale > 1)) continue;
    const [, , x, y, w, h] = rowA;
    if (Math.abs(w * scale - na[0]) < 0.5 && Math.abs(h * scale - na[1]) < 0.5) continue;
    found.push({ path: rowA[0], region: { x, y, w, h } });
  }
  return found;
}

/**
 * Register rule F. WebKit matches `:focus-visible` only in the active window, and the driver
 * never activates Tauri's, so a ring Electron draws on the element both captures focus is
 * missing from Tauri's pixels. The ring's box, grown by its outline, is what the tile rule
 * leaves out, when the two boxes agree within one device px.
 */
export function unfocusedRing(
  focus: [FocusMeta | null, FocusMeta | null] | undefined,
  scale: number,
): { path: string; region: Region } | undefined {
  const [a, b] = focus ?? [];
  if (!a?.focusVisible || !a.outline || !b || b.documentHasFocus || a.path !== b.path) return;
  if ((["x", "y", "w", "h"] as const).some((k) => Math.abs(a.box[k] - b.box[k]) * scale > 1)) {
    return;
  }
  const grow = Math.max(0, a.outline.width + a.outline.offset);
  const { x, y, w, h } = a.box;
  return {
    path: a.path,
    region: { x: x - grow, y: y - grow, w: w + 2 * grow, h: h + 2 * grow },
  };
}

/**
 * Pixels of one crop that no pixel of the other comes near: every channel must fall within the
 * other crop's range over the neighbours `reach` device px away, give or take `tolerance` levels.
 * A resampling one row apart passes. Another image, a recolour or a shift does not.
 */
function displacedMismatches(
  a: { data: Uint8Array; w: number; h: number },
  b: { data: Uint8Array; w: number; h: number },
  reach: number,
  tolerance: number,
): Uint8Array {
  const { w, h } = a;
  const miss = new Uint8Array(w * h);
  for (const [p, q] of [
    [a.data, b.data],
    [b.data, a.data],
  ] as const) {
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        for (let ch = 0; ch < 3; ch++) {
          let lo = 255;
          let hi = 0;
          for (let j = Math.max(0, y - reach); j <= Math.min(h - 1, y + reach); j++)
            for (let i = Math.max(0, x - reach); i <= Math.min(w - 1, x + reach); i++) {
              const v = q[(j * w + i) * 4 + ch]!;
              lo = Math.min(lo, v);
              hi = Math.max(hi, v);
            }
          const v = p[(y * w + x) * 4 + ch]!;
          if (v < lo - tolerance || v > hi + tolerance) {
            miss[y * w + x] = 1;
            break;
          }
        }
  }
  return miss;
}

/** The largest share of set cells in any n by n window of a w by h mask. */
function worstWindow(mask: Uint8Array, w: number, h: number, n: number): number {
  const size = Math.min(n, w, h);
  const sum = new Int32Array((w + 1) * (h + 1));
  const at = (x: number, y: number) => sum[y * (w + 1) + x]!;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      sum[(y + 1) * (w + 1) + x + 1] = mask[y * w + x]! + at(x + 1, y) + at(x, y + 1) - at(x, y);
  let worst = 0;
  for (let y = size; y <= h; y++)
    for (let x = size; x <= w; x++)
      worst = Math.max(
        worst,
        at(x, y) - at(x - size, y) - at(x, y - size) + at(x - size, y - size),
      );
  return size > 0 ? worst / (size * size) : 0;
}

function regionMask(width: number, height: number, regions: Region[], scale: number): Uint8Array {
  const mask = new Uint8Array(width * height);
  for (const r of regions) {
    const x0 = Math.max(0, Math.floor(r.x * scale));
    const y0 = Math.max(0, Math.floor(r.y * scale));
    const x1 = Math.min(width, Math.ceil((r.x + r.w) * scale));
    const y1 = Math.min(height, Math.ceil((r.y + r.h) * scale));
    for (let y = y0; y < y1; y++) mask.fill(1, y * width + x0, y * width + x1);
  }
  return mask;
}

/** The blur regions' pixels the page count leaves out: each region but the panels it keeps. */
function blurPageMask(
  width: number,
  height: number,
  blur: BlurRegion[],
  scale: number,
): Uint8Array {
  const mask = regionMask(width, height, blur, scale);
  const keep = regionMask(
    width,
    height,
    blur.flatMap((r) => r.keep ?? []),
    scale,
  );
  for (let i = 0; i < mask.length; i++) if (keep[i]) mask[i] = 0;
  return mask;
}

function crop(png: PNG, r: Region, scale: number): { data: Uint8Array; w: number; h: number } {
  const x0 = Math.max(0, Math.floor(r.x * scale));
  const y0 = Math.max(0, Math.floor(r.y * scale));
  const w = Math.max(0, Math.min(png.width, Math.ceil((r.x + r.w) * scale)) - x0);
  const h = Math.max(0, Math.min(png.height, Math.ceil((r.y + r.h) * scale)) - y0);
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const from = ((y0 + y) * png.width + x0) * 4;
    data.set(png.data.subarray(from, from + w * 4), y * w * 4);
  }
  return { data, w, h };
}

export function diffPngs(a: PNG, b: PNG, options: DiffOptions): DiffResult {
  const scale = options.scale ?? 2;
  const result: DiffResult = {
    policy: options.policy,
    pass: true,
    reasons: [],
    size: [a.width, a.height],
    differing: 0,
    differingPct: 0,
    blurRegions: [],
    scaledImages: [],
  };
  if (a.width !== b.width || a.height !== b.height) {
    result.pass = false;
    result.reasons.push(
      `image sizes differ: ${a.width}x${a.height} against ${b.width}x${b.height}`,
    );
    return result;
  }
  const { width, height } = a;
  const total = width * height;
  const diff = new PNG({ width, height });

  if (options.policy === "same-engine") {
    result.differing = pixelmatch(a.data, b.data, diff.data, width, height, {
      threshold: SAME_ENGINE.threshold,
      includeAA: SAME_ENGINE.includeAA,
    });
    result.differingPct = +((100 * result.differing) / total).toFixed(4);
    result.diffImage = diff;
    if (result.differing > SAME_ENGINE.allowedPixels) {
      result.pass = false;
      result.reasons.push(
        `${result.differing} pixels differ at threshold ${SAME_ENGINE.threshold}`,
      );
    }
    return result;
  }

  if (options.geometryA && options.geometryB) {
    result.layout = compareLayout(
      options.geometryA,
      options.geometryB,
      CROSS_ENGINE.layoutToleranceCss,
    );
    if (!result.layout.pass) {
      result.pass = false;
      const l = result.layout;
      result.reasons.push(
        `layout gate: ${l.elementsA} against ${l.elementsB} elements, ${l.beyond} boxes moved more than ${CROSS_ENGINE.layoutToleranceCss} CSS px, ${l.pathMismatches} path mismatches`,
      );
    }
  } else {
    result.pass = false;
    result.reasons.push(
      "layout gate: geometry for both images is required under the cross-engine policy",
    );
  }

  const blur = options.blurRegions ?? [];
  const ignore = blur.length ? regionMask(width, height, blur, scale) : undefined;
  const base = {
    threshold: CROSS_ENGINE.threshold,
    includeAA: CROSS_ENGINE.includeAA,
    ...(ignore ? { ignoreMask: ignore } : {}),
  };
  result.differing = pixelmatch(a.data, b.data, diff.data, width, height, {
    ...base,
    ...(blur.length ? { ignoreMask: blurPageMask(width, height, blur, scale) } : {}),
  });
  result.differingPct = +((100 * result.differing) / total).toFixed(4);
  result.diffImage = diff;
  if (result.differing / total > CROSS_ENGINE.pageBudget) {
    result.pass = false;
    result.reasons.push(
      `page budget: ${result.differingPct}% of pixels differ, budget ${CROSS_ENGINE.pageBudget * 100}%`,
    );
  }

  const tile = Math.round(CROSS_ENGINE.tileCss * scale);
  for (const { path: at, region } of scaledImages(
    options.geometryA ?? [],
    options.geometryB ?? [],
    scale,
  )) {
    const ca = crop(a, region, scale);
    const cb = crop(b, region, scale);
    // An image scrolled out of the snapshot has no pixels for the tile rule to leave out
    if (ca.w === 0 || ca.h === 0) continue;
    const miss = displacedMismatches(
      ca,
      cb,
      CROSS_ENGINE.imageReachDevicePx,
      CROSS_ENGINE.imageToleranceLevels,
    );
    const pct = +(100 * worstWindow(miss, ca.w, ca.h, tile)).toFixed(2);
    result.scaledImages.push({
      path: at,
      region,
      displacedTilePct: pct,
      exempt: pct / 100 <= CROSS_ENGINE.tileBudget,
    });
  }
  result.unfocusedRing = unfocusedRing(options.focus, scale);
  const exempt = [
    ...result.scaledImages.filter((s) => s.exempt).map((s) => s.region),
    ...(result.unfocusedRing ? [result.unfocusedRing.region] : []),
  ];
  const tileIgnore =
    exempt.length > 0 ? regionMask(width, height, [...blur, ...exempt], scale) : ignore;
  const worstCount = pixelmatch(a.data, b.data, null, width, height, {
    ...base,
    ...(tileIgnore ? { ignoreMask: tileIgnore } : {}),
    windowSize: tile,
  });
  const tilePct = worstCount / (tile * tile);
  result.worstTile = { differing: worstCount, pct: +(100 * tilePct).toFixed(2) };
  if (tilePct > CROSS_ENGINE.tileBudget) {
    result.pass = false;
    result.reasons.push(
      `tile rule: a ${CROSS_ENGINE.tileCss} CSS px tile has ${result.worstTile.pct}% differing, budget ${CROSS_ENGINE.tileBudget * 100}%`,
    );
  }

  for (const region of blur) {
    const ca = crop(a, region, scale);
    const cb = crop(b, region, scale);
    const size = Math.min(tile, ca.w, ca.h);
    const count = pixelmatch(ca.data, cb.data, null, ca.w, ca.h, {
      threshold: CROSS_ENGINE.blurThreshold,
      includeAA: CROSS_ENGINE.includeAA,
      windowSize: size,
    });
    const pct = +((100 * count) / (size * size)).toFixed(2);
    const pass = pct / 100 <= CROSS_ENGINE.tileBudget;
    result.blurRegions.push({ region, worstTilePct: pct, pass });
    if (!pass) {
      result.pass = false;
      result.reasons.push(
        `blur region ${JSON.stringify(region)}: tile ${pct}% at threshold ${CROSS_ENGINE.blurThreshold}`,
      );
    }
  }
  return result;
}

export function sideBySide(a: PNG, b: PNG, diff: PNG): PNG {
  const out = new PNG({
    width: a.width + b.width + diff.width,
    height: Math.max(a.height, b.height, diff.height),
  });
  out.data.fill(255);
  let offset = 0;
  for (const image of [a, b, diff]) {
    PNG.bitblt(image, out, 0, 0, image.width, image.height, offset, 0);
    offset += image.width;
  }
  return out;
}

export function readGeometry(file: string): GeometryRow[] {
  return JSON.parse(fs.readFileSync(file, "utf8")) as GeometryRow[];
}

export function diffFiles(
  aFile: string,
  bFile: string,
  options: Omit<DiffOptions, "geometryA" | "geometryB"> & {
    geometry?: [string, string];
    outPrefix?: string;
  },
): DiffResult {
  if (options.outPrefix) refuseRealFolder(options.outPrefix, "diff output");
  const a = PNG.sync.read(fs.readFileSync(aFile));
  const b = PNG.sync.read(fs.readFileSync(bFile));
  const result = diffPngs(a, b, {
    ...options,
    geometryA: options.geometry ? readGeometry(options.geometry[0]) : undefined,
    geometryB: options.geometry ? readGeometry(options.geometry[1]) : undefined,
  });
  if (options.outPrefix && result.diffImage) {
    fs.mkdirSync(path.dirname(options.outPrefix), { recursive: true });
    fs.writeFileSync(`${options.outPrefix}.diff.png`, PNG.sync.write(result.diffImage));
    fs.writeFileSync(
      `${options.outPrefix}.side-by-side.png`,
      PNG.sync.write(sideBySide(a, b, result.diffImage)),
    );
  }
  return result;
}

function parseRegion(text: string): Region {
  const [x, y, w, h] = text.split(",").map(Number);
  if ([x, y, w, h].some((n) => n === undefined || Number.isNaN(n)))
    throw new Error(`bad region ${text}`);
  return { x: x!, y: y!, w: w!, h: h! };
}

function parseCli(args: string[]) {
  const parsed = {
    positional: [] as string[],
    geometry: undefined as [string, string] | undefined,
    blurRegions: [] as Region[],
    policy: "cross-engine" as Policy,
    scale: 2,
    out: undefined as string | undefined,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--geometry") parsed.geometry = [args[++i]!, args[++i]!];
    else if (arg === "--blur") parsed.blurRegions.push(parseRegion(args[++i]!));
    else if (arg === "--policy") parsed.policy = args[++i] as Policy;
    else if (arg === "--scale") parsed.scale = Number(args[++i]);
    else if (arg === "--out") parsed.out = args[++i];
    else if (arg.startsWith("--")) throw new Error(`unknown flag ${arg}`);
    else parsed.positional.push(arg);
  }
  return parsed;
}

if (import.meta.main) {
  const cli = parseCli(process.argv.slice(2));
  const [a, b] = cli.positional;
  if (!a || !b || !["same-engine", "cross-engine"].includes(cli.policy)) {
    console.error(
      "usage: bun parity/diff.ts <trunk.png> <head.png> [--policy same-engine|cross-engine] [--geometry <trunk.json> <head.json>] [--blur x,y,w,h]... [--scale 2] [--out <prefix>]",
    );
    process.exit(2);
  }
  const result = diffFiles(a, b, {
    policy: cli.policy,
    geometry: cli.geometry,
    blurRegions: cli.blurRegions,
    scale: cli.scale,
    outPrefix: cli.out ?? b.replace(/\.png$/, ""),
  });
  const { diffImage: _diffImage, ...printable } = result;
  console.log(JSON.stringify(printable));
  console.log(result.pass ? "PASS" : "FAIL");
  for (const reason of result.reasons) console.log(`  ${reason}`);
  process.exit(result.pass ? 0 : 1);
}
