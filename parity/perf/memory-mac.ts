import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ProcRow {
  pid: number;
  ppid: number;
  startedMs: number;
  rssBytes: number;
  command: string;
}

export interface Member {
  pid: number;
  role: string;
  name: string;
  footprintBytes: number;
  rssBytes: number;
}

export interface MemorySample {
  footprintBytes: number;
  rssBytes: number;
  members: Member[];
}

const PS_LINE =
  /^\s*(\d+)\s+(\d+)\s+([A-Z][a-z]{2} [A-Z][a-z]{2}\s+\d+ \d\d:\d\d:\d\d \d{4})\s+(\d+)\s+(.*)$/;

/** Reads `ps -axo pid=,ppid=,lstart=,rss=,command=`. */
export function parsePs(text: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of text.split("\n")) {
    const match = PS_LINE.exec(line);
    if (!match) continue;
    const [, pid, ppid, lstart, rss, command] = match;
    const [, month, day, time, year] = /^\w{3} (\w{3})\s+(\d+) (\S+) (\d{4})$/.exec(lstart!)!;
    rows.push({
      pid: Number(pid),
      ppid: Number(ppid),
      startedMs: new Date(`${month} ${day} ${year} ${time}`).getTime(),
      rssBytes: Number(rss) * 1024,
      command: command!,
    });
  }
  return rows;
}

export function listProcesses(): ProcRow[] {
  let failure = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    const out = spawnSync("ps", ["-wwaxo", "pid=,ppid=,lstart=,rss=,command="], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    if (out.status === 0) return parsePs(out.stdout);
    failure = `${out.status} ${out.stderr} ${out.error ?? ""}`;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  }
  throw new Error(`ps failed five times: ${failure}`);
}

/** The root and everything under it by parent pid. */
export function descendants(rows: ProcRow[], rootPid: number): ProcRow[] {
  const byParent = new Map<number, ProcRow[]>();
  for (const row of rows) byParent.set(row.ppid, [...(byParent.get(row.ppid) ?? []), row]);
  const root = rows.find((row) => row.pid === rootPid);
  if (!root) return [];
  const found = [root];
  for (let i = 0; i < found.length; i++) found.push(...(byParent.get(found[i]!.pid) ?? []));
  return found;
}

/** Chromium names each helper's job in its command line. */
export function electronRole(command: string, isRoot: boolean): string {
  if (isRoot) return "main";
  const type = /--type=([\w-]+)/.exec(command)?.[1];
  if (type === "renderer") return "renderer";
  if (type === "gpu-process") return "gpu";
  if (type === "utility") {
    return /--utility-sub-type=network\.mojom\.NetworkService/.test(command)
      ? "network"
      : "utility";
  }
  return type ? `helper-${type}` : "child";
}

export const REQUIRED_ELECTRON_ROLES = ["main", "renderer", "gpu", "network"];

export interface ElectronAttribution {
  members: Array<{ row: ProcRow; role: string }>;
  /** Processes outside the tree that carry the run's `--user-data-dir`. */
  strays: ProcRow[];
  missingRoles: string[];
}

export function attributeElectron(
  rows: ProcRow[],
  rootPid: number,
  userDataDir?: string,
): ElectronAttribution {
  const tree = descendants(rows, rootPid);
  const members = tree.map((row) => ({
    row,
    role: electronRole(row.command, row.pid === rootPid),
  }));
  const inTree = new Set(tree.map((row) => row.pid));
  const strays = userDataDir
    ? rows.filter(
        (row) => !inTree.has(row.pid) && row.command.includes(`--user-data-dir=${userDataDir}`),
      )
    : [];
  const roles = new Set(members.map((member) => member.role));
  return {
    members,
    strays,
    missingRoles: REQUIRED_ELECTRON_ROLES.filter((role) => !roles.has(role)),
  };
}

const WEBKIT_ROLE = /\/com\.apple\.WebKit\.(WebContent|GPU|Networking)\.xpc\//;

export function webkitRole(command: string): "webcontent" | "gpu" | "networking" | null {
  const kind = WEBKIT_ROLE.exec(command)?.[1];
  if (kind === "WebContent") return "webcontent";
  if (kind === "GPU") return "gpu";
  if (kind === "Networking") return "networking";
  return null;
}

export interface WebKitContext {
  rootPid: number;
  /** Every pid that existed before the app was spawned. */
  before: ReadonlySet<number>;
  spawnedAtMs: number;
  /** Names the app puts on the files its helpers open: bundle id, executable name. */
  identityTokens: string[];
  expectedWebContent: number;
}

export interface WebKitAttribution {
  members: Array<{ row: ProcRow; role: string }>;
  ambiguous: boolean;
  notes: string[];
}

/** Parses `lsof -Fpn`: a `p<pid>` line, then that process's `n<name>` lines. */
export function parseLsofNames(text: string): Map<number, string[]> {
  const names = new Map<number, string[]>();
  let current = -1;
  for (const line of text.split("\n")) {
    if (line.startsWith("p")) {
      current = Number(line.slice(1));
      names.set(current, []);
    } else if (line.startsWith("n") && current >= 0) names.get(current)!.push(line.slice(1));
  }
  return names;
}

export function openFileNames(pids: number[]): Map<number, string[]> {
  if (pids.length === 0) return new Map();
  const out = spawnSync("lsof", ["-w", "-p", pids.join(","), "-Fpn"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return parseLsofNames(out.stdout);
}

const PROXIMITY = 8;

/**
 * WebKit's helpers are XPC services launched by launchd, so parent pid says nothing. The
 * public facts that tie them to the app are these. They did not exist before the spawn.
 * They started at or after it. The GPU helper keeps its cache in a folder named after the
 * host executable and the networking helper keeps website data under the bundle id, both
 * visible to `lsof`. The content helper has no such file, so it counts only when it is the
 * one expected content helper that is new, or the nearest by pid to the bound helpers.
 */
export function attributeWebKit(
  rows: ProcRow[],
  context: WebKitContext,
  openNames: Map<number, string[]> = new Map(),
): WebKitAttribution {
  const notes: string[] = [];
  const spawnedSecond = Math.floor(context.spawnedAtMs / 1000) * 1000;
  const fresh = rows
    .map((row) => ({ row, kind: webkitRole(row.command) }))
    .filter(
      (item) =>
        item.kind !== null &&
        !context.before.has(item.row.pid) &&
        item.row.startedMs >= spawnedSecond,
    ) as Array<{ row: ProcRow; kind: "webcontent" | "gpu" | "networking" }>;

  const tied = (pid: number) =>
    (openNames.get(pid) ?? []).some((name) =>
      context.identityTokens.some((token) => name.includes(token)),
    );
  const members: Array<{ row: ProcRow; role: string }> = descendants(rows, context.rootPid).map(
    (row) => ({ row, role: row.pid === context.rootPid ? "main" : "child" }),
  );
  let ambiguous = false;

  const pickByFile = (kind: "gpu" | "networking") => {
    const all = fresh.filter((item) => item.kind === kind);
    const bound = all.filter((item) => tied(item.row.pid));
    if (bound.length > 0) {
      if (bound.length < all.length) notes.push(`${all.length - bound.length} other new ${kind}`);
      return bound;
    }
    if (all.length === 1) {
      notes.push(`${kind} taken as the only new one, no open file names it yet`);
      return all;
    }
    if (all.length > 1) {
      ambiguous = true;
      notes.push(`${all.length} new ${kind} helpers and none names this app`);
    }
    return [];
  };
  const gpu = pickByFile("gpu");
  const networking = pickByFile("networking");
  for (const item of [...gpu, ...networking]) members.push({ row: item.row, role: item.kind });

  const contents = fresh.filter((item) => item.kind === "webcontent");
  const anchors = [...gpu, ...networking].map((item) => item.row.pid);
  let chosen = contents;
  if (contents.length > context.expectedWebContent) {
    const distance = (item: { row: ProcRow }) =>
      anchors.length ? Math.min(...anchors.map((pid) => Math.abs(pid - item.row.pid))) : Infinity;
    const ranked = [...contents].sort((a, b) => distance(a) - distance(b));
    chosen = ranked.slice(0, context.expectedWebContent);
    const next = ranked[context.expectedWebContent];
    const nearest = distance(chosen[chosen.length - 1]!);
    if (nearest > PROXIMITY || (next && distance(next) <= PROXIMITY * 2)) {
      ambiguous = true;
      notes.push(`${contents.length} new content helpers and none clearly follows this app's pids`);
    } else notes.push("content helper chosen by pid proximity to the bound helpers");
  }
  if (chosen.length < context.expectedWebContent) {
    ambiguous = true;
    notes.push(`expected ${context.expectedWebContent} content helper, found ${chosen.length}`);
  }
  for (const item of chosen) members.push({ row: item.row, role: "webcontent" });
  if (gpu.length === 0) notes.push("no GPU helper attributed");
  if (networking.length === 0) notes.push("no networking helper attributed");
  return { members, ambiguous, notes };
}

export interface FootprintReading {
  footprint: Map<number, number>;
  missing: number[];
}

/** `footprint -j` reports each process's phys_footprint, the number Activity Monitor calls Memory. */
export function parseFootprint(json: string, wanted: number[]): FootprintReading {
  const parsed = JSON.parse(json) as { processes?: Array<{ pid: number; footprint: number }> };
  const footprint = new Map<number, number>();
  for (const proc of parsed.processes ?? []) footprint.set(proc.pid, proc.footprint);
  return { footprint, missing: wanted.filter((pid) => !footprint.has(pid)) };
}

export function readFootprint(pids: number[]): FootprintReading {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bmt-footprint-"));
  const file = path.join(dir, "fp.json");
  try {
    spawnSync("footprint", ["-p", ...pids.map(String), "-j", file], {
      encoding: "utf8",
    });
    if (!fs.existsSync(file)) {
      return { footprint: new Map(), missing: pids };
    }
    return parseFootprint(fs.readFileSync(file, "utf8"), pids);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export class MemoryProbeError extends Error {
  constructor(
    message: string,
    readonly kind: "missing-helper" | "ambiguous" | "stray" | "unreadable",
  ) {
    super(message);
  }
}

/** Sums footprint and RSS over members, and throws when any member cannot be read. */
export function sumMembers(
  members: Array<{ row: ProcRow; role: string }>,
  reading: FootprintReading,
  latestRss: Map<number, number>,
): MemorySample {
  if (reading.missing.length > 0) {
    throw new MemoryProbeError(
      `no footprint for pid ${reading.missing.join(", ")}`,
      "missing-helper",
    );
  }
  const out: Member[] = members.map(({ row, role }) => ({
    pid: row.pid,
    role,
    name: path.basename(row.command.split(" --")[0]!),
    footprintBytes: reading.footprint.get(row.pid)!,
    rssBytes: latestRss.get(row.pid) ?? row.rssBytes,
  }));
  return {
    footprintBytes: out.reduce((total, member) => total + member.footprintBytes, 0),
    rssBytes: out.reduce((total, member) => total + member.rssBytes, 0),
    members: out,
  };
}

export function median(values: number[]): number {
  if (values.length === 0) throw new Error("median of nothing");
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const pidArg = args[args.indexOf("--pid") + 1];
  if (!pidArg) {
    console.error("usage: bun parity/perf/memory-mac.ts --pid <app pid> [--user-data-dir <dir>]");
    process.exit(2);
  }
  const rows = listProcesses();
  const attribution = attributeElectron(
    rows,
    Number(pidArg),
    args[args.indexOf("--user-data-dir") + 1],
  );
  const reading = readFootprint(attribution.members.map((member) => member.row.pid));
  const sample = sumMembers(attribution.members, reading, new Map());
  console.log(JSON.stringify({ ...sample, strays: attribution.strays.map((r) => r.pid) }, null, 2));
}
