/**
 * T40's end-to-end parity report.
 *
 *   bun parity/report.ts run [--data fixture] [--out parity/out/report] [--binary <driver build>]
 *     [--electron-baseline <dir>] [--tauri-capture <dir>] [--golden-dir <dir>] [--skip-golden] [--tools <dir>]
 *   bun parity/report.ts render --run <report-mac.json> [--run <report-win.json>]
 *     [--perf <perf.json> ...] [--out docs/tauri-port/parity-report.md]
 *
 * `run` captures every state in `states.ts` for this platform in trunk Electron and in the head
 * Tauri app on its own Solid UI and Rust commands, diffs each pair with the cross-engine policy
 * (the side-by-side lands in `<out>/tauri-<platform>/cross-engine/`), replays the goldens, runs
 * the React-ism scan and the contract check, and writes `<out>/report-<platform>.json`.
 * `render` merges one or both platforms' JSON with perf.ts sweeps into the markdown report and
 * exits 1 when the run failed. Windows runs `run` in the `report-windows` job of parity.yml.
 */
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CROSS_ENGINE } from "./diff.ts";
import { PARITY_DIR, REPO_DIR, resolveDataRoot } from "./lib/data.ts";
import { selectStates } from "./states.ts";

export const EXPECTED_GOLDEN_CHANNELS = 61;
/**
 * E1, the operator's decision of 2026-11-23: a state may differ on up to 1.5% of its pixels (raised from 0.3%, then 0.45%).
 * `diff.ts` still gates at 0.3%, so the report re-judges a state whose only failure is that budget.
 */
export const E1_PAGE_BUDGET_PCT = 1.5;

/** The state's verdict under E1: the page-budget gate moves to 1.5%, every other gate stays. */
export function underE1(c: { pass: boolean; reasons: string[]; differingPct?: number }) {
  if (c.pass) return true;
  const onlyBudget = c.reasons.length > 0 && c.reasons.every((r) => r.startsWith("page budget"));
  return onlyBudget && (c.differingPct ?? Infinity) <= E1_PAGE_BUDGET_PCT;
}
export type PlatformId = "mac" | "win";
export const PLATFORM_NAMES: Record<PlatformId, string> = { mac: "macOS", win: "Windows" };

export interface StateLine {
  id: string;
  pass: boolean;
  /** The first gate a failing state failed, as `capture.ts` names it. */
  cause?: string;
  differingPct?: number;
  worstTilePct?: number;
  /** Rows the layout gate compared on x, y and height only (register rule B). */
  widthExempt?: number;
  /** Scaled images whose boxes the tile rule left out (register rule E). */
  imageExempt?: number;
  reasons: string[];
  sideBySide?: string;
}

export interface GoldenSummary {
  pass: number;
  fail: number;
  notPorted: number;
  noGolden: number;
  exitCode: number;
  /** The harness printed its summary line; a panic before it leaves the counts at zero. */
  completed: boolean;
  failing: string[];
  log: string;
}

export interface CheckResult {
  name: string;
  pass: boolean;
  detail: string;
}

export interface Mask {
  state: string;
  region: string;
  reason: string;
}

export interface PlatformRun {
  platform: PlatformId;
  head: string;
  trunk: string;
  fixtureSha256: string;
  startedAt: string;
  finishedAt: string;
  /** Every state `states.ts` runs on this platform, so a state that never ran still fails. */
  expected: string[];
  states: StateLine[];
  golden?: GoldenSummary;
  checks: CheckResult[];
  masks: Mask[];
  contactSheet?: string;
}

export interface Stat {
  n: number;
  median: number;
  min: number;
  max: number;
  spread: number;
}

export interface PerfSide {
  version: string;
  downloadBytes: number;
  downloadAsset: string;
  installedBytes: number;
  idleMemoryBytes: Stat | null;
  firstContentMs: Stat | null;
  valid: number;
  runs: number;
  source: string;
  medianCpuIdle: number | null;
  medianLoad1: number | null;
}

export type PerfTable = Partial<Record<PlatformId, { electron?: PerfSide; tauri?: PerfSide }>>;

export interface Deviation {
  name: string;
  where: string;
  rule: string;
}

export interface Report {
  generatedAt: string;
  runs: Partial<Record<PlatformId, PlatformRun>>;
  perf: PerfTable;
  deviations: Deviation[];
}

export interface Verdict {
  pass: boolean;
  failures: string[];
  notes: string[];
}

/**
 * The operator dropped the Windows perf sweep on 2026-11-23: macOS gives the before and after
 * numbers, and Windows reports download size only.
 */
export const WINDOWS_PERF_DROPPED = true;

/**
 * Whether Tauri's number is worse than Electron's by more than either side's own run-to-run
 * spread (max over min, minus one). A size has no spread, so any increase counts.
 */
export function worseBeyondNoise(
  before: { value: number; stat?: Stat },
  after: { value: number; stat?: Stat },
): boolean {
  const noise = Math.max(before.stat?.spread ?? 0, after.stat?.spread ?? 0);
  return after.value > before.value * (1 + noise);
}

// The four metrics, lower is better for each, and what Tauri is judged on
const METRICS = [
  { key: "download", label: "Download size", unit: "bytes" },
  { key: "installed", label: "Installed size", unit: "bytes" },
  { key: "memory", label: "Idle memory, all processes", unit: "bytes" },
  { key: "launch", label: "Launch to first content", unit: "ms" },
] as const;
type MetricKey = (typeof METRICS)[number]["key"];

function metric(side: PerfSide, key: MetricKey): { value: number; stat?: Stat } | null {
  if (key === "download") return side.downloadBytes ? { value: side.downloadBytes } : null;
  if (key === "installed") return side.installedBytes ? { value: side.installedBytes } : null;
  const stat = key === "memory" ? side.idleMemoryBytes : side.firstContentMs;
  return stat ? { value: stat.median, stat } : null;
}

/** What one platform's run failed: its states, its golden replay, its checks and its masks. */
export function runFailures(name: string, run: PlatformRun): string[] {
  const failures: string[] = [];
  const byId = new Map(run.states.map((s) => [s.id, s]));
  for (const id of run.expected) {
    const state = byId.get(id);
    if (!state) failures.push(`${name}: ${id} did not run`);
    else if (!state.pass) failures.push(`${name}: ${id} failed (${state.cause ?? "unknown"})`);
  }
  const golden = run.golden;
  if (!golden) failures.push(`${name}: goldens not replayed`);
  else if (!golden.completed) {
    failures.push(`${name}: the golden replay exited ${golden.exitCode} before its summary`);
  } else if (
    golden.pass !== EXPECTED_GOLDEN_CHANNELS ||
    golden.fail !== 0 ||
    golden.notPorted !== 0 ||
    golden.noGolden !== 0 ||
    golden.exitCode !== 0
  ) {
    failures.push(
      `${name}: goldens ${golden.pass} pass, ${golden.fail} fail, ${golden.notPorted} not ported, want ${EXPECTED_GOLDEN_CHANNELS} pass`,
    );
  }
  for (const check of run.checks) if (!check.pass) failures.push(`${name}: ${check.name} failed`);
  for (const mask of run.masks) {
    if (!mask.reason) failures.push(`${name}: mask on ${mask.state} has no reason`);
  }
  return failures;
}

export function verdictOf(report: Report): Verdict {
  const failures: string[] = [];
  const notes: string[] = [];
  for (const platform of ["mac", "win"] as const) {
    const name = PLATFORM_NAMES[platform];
    const run = report.runs[platform];
    if (!run) {
      failures.push(`${name}: no run`);
      continue;
    }
    failures.push(...runFailures(name, run));
    const perf = report.perf[platform];
    if (platform === "win" && WINDOWS_PERF_DROPPED && (!perf?.electron || !perf.tauri)) {
      notes.push(`${name}: perf not measured, by the operator's decision; macOS gives the numbers`);
      continue;
    }
    if (!perf?.electron || !perf.tauri) {
      failures.push(`${name}: perf needs both Electron and Tauri numbers`);
      continue;
    }
    for (const m of METRICS) {
      const before = metric(perf.electron, m.key);
      const after = metric(perf.tauri, m.key);
      if (!before || !after) failures.push(`${name}: ${m.label.toLowerCase()} not measured`);
      else if (worseBeyondNoise(before, after))
        failures.push(`${name}: Tauri is worse on ${m.label}`);
      else if (after.value > before.value)
        notes.push(
          `${name}: ${m.label} is on par: Tauri is higher by less than the runs' own spread`,
        );
    }
  }
  return { pass: failures.length === 0, failures, notes };
}

// Rendering

const mib = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
const pct = (share: number) => `${(share * 100).toFixed(1)}%`;

function format(value: number, unit: "bytes" | "ms") {
  return unit === "bytes" ? mib(value) : `${Math.round(value)} ms`;
}

function cell(m: (typeof METRICS)[number], side: PerfSide | undefined) {
  if (!side) return "not measured";
  const value = metric(side, m.key);
  if (!value) return "not measured";
  if (!value.stat) return format(value.value, m.unit);
  const s = value.stat;
  return `${format(s.median, m.unit)} (${format(s.min, m.unit)} to ${format(s.max, m.unit)}, spread ${pct(s.spread)}, n=${s.n})`;
}

function stateCell(run: PlatformRun | undefined, id: string) {
  if (!run) return "not run";
  if (!run.expected.includes(id)) return "n/a";
  const state = run.states.find((s) => s.id === id);
  if (!state) return "FAIL (did not run)";
  const numbers =
    state.differingPct === undefined
      ? ""
      : ` ${state.differingPct.toFixed(3)}%, tile ${(state.worstTilePct ?? 0).toFixed(2)}%`;
  return state.pass ? `PASS${numbers}` : `FAIL ${state.cause ?? ""}${numbers}`.trimEnd();
}

export function renderReport(report: Report, command: string): string {
  const verdict = verdictOf(report);
  const mac = report.runs.mac;
  const win = report.runs.win;
  const ids = [...new Set([...(mac?.expected ?? []), ...(win?.expected ?? [])])].sort();
  const lines: string[] = [];
  lines.push("# Parity report", "");
  lines.push(
    `Generated by \`${command}\` at ${report.generatedAt}. Do not edit by hand; rerun the command.`,
    "",
  );
  lines.push("| Platform | Tauri head | Electron trunk | Fixture matches.db | Ran |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const run of [mac, win]) {
    if (!run) continue;
    lines.push(
      `| ${PLATFORM_NAMES[run.platform]} | ${run.head.slice(0, 10)} | ${run.trunk.slice(0, 10)} | ${run.fixtureSha256.slice(0, 8)} | ${run.startedAt} to ${run.finishedAt} |`,
    );
  }
  lines.push("", `## Verdict: ${verdict.pass ? "PASS" : "FAIL"}`, "");
  if (verdict.failures.length > 0) {
    lines.push(`${verdict.failures.length} items fail the run.`, "");
    for (const failure of verdict.failures) lines.push(`- ${failure}`);
    lines.push("");
  } else lines.push("Every state, golden, check and metric passes on both platforms.", "");
  for (const note of verdict.notes) lines.push(`- ${note}`);
  if (verdict.notes.length > 0) lines.push("");

  lines.push("## States", "");
  lines.push(
    `Cross-engine policy: layout gate within ${CROSS_ENGINE.layoutToleranceCss} CSS px, pixelmatch threshold ${CROSS_ENGINE.threshold} without anti-aliasing, at most ${E1_PAGE_BUDGET_PCT}% of the page (decision E1, set by the operator on 2026-11-23; \`diff.ts\` gates at ${pct(CROSS_ENGINE.pageBudget)}, and the report passes a state whose only failure is that gate when it stays within ${E1_PAGE_BUDGET_PCT}%) and ${pct(CROSS_ENGINE.tileBudget)} of any ${CROSS_ENGINE.tileCss} px tile. A cell gives the share of pixels differing and the worst tile.`,
    "",
  );
  const passed = (name: string, run?: PlatformRun) =>
    run
      ? `${name}: ${run.states.filter((s) => s.pass).length} of ${run.expected.length} states pass.`
      : `${name}: not run.`;
  lines.push(`${passed("macOS", mac)} ${passed("Windows", win)}`, "");
  lines.push("| State | macOS | Windows |", "| --- | --- | --- |");
  for (const id of ids) lines.push(`| ${id} | ${stateCell(mac, id)} | ${stateCell(win, id)} |`);
  lines.push("");
  const failing = [mac, win].flatMap((run) =>
    run ? run.states.filter((s) => !s.pass).map((s) => ({ run, s })) : [],
  );
  if (failing.length > 0) {
    lines.push("### Failing states", "");
    for (const { run, s } of failing) {
      lines.push(
        `- ${PLATFORM_NAMES[run.platform]} \`${s.id}\`: ${s.reasons.join("; ") || s.cause}${s.sideBySide ? `. Side by side: \`${s.sideBySide}\`` : ""}`,
      );
    }
    lines.push("");
  }
  const sheets = [mac, win].filter((run) => run?.contactSheet);
  if (sheets.length > 0) {
    lines.push(
      `Side-by-side images (Electron, Tauri, diff) are in each run's \`tauri-<platform>/cross-engine/\`. Contact sheets: ${sheets.map((run) => `\`${run!.contactSheet}\``).join(", ")}.`,
      "",
    );
  }

  lines.push("## Goldens", "");
  for (const run of [mac, win]) {
    if (!run) continue;
    const g = run.golden;
    lines.push(
      g && !g.completed
        ? `- ${PLATFORM_NAMES[run.platform]}: the replay exited ${g.exitCode} before its summary line; see \`${g.log}\`.`
        : g
          ? `- ${PLATFORM_NAMES[run.platform]}: ${g.pass} of ${EXPECTED_GOLDEN_CHANNELS} channels pass, ${g.fail} fail, ${g.notPorted} not ported${g.noGolden ? `, ${g.noGolden} no golden` : ""}.${g.failing.length ? ` Failing: ${g.failing.join(", ")}.` : ""}`
          : `- ${PLATFORM_NAMES[run.platform]}: not replayed.`,
    );
  }
  lines.push("");

  lines.push("## Before and after", "");
  lines.push(
    "Electron 1.2.1 is the before, the Tauri head the after. Download size is the release asset a player downloads. Idle memory counts every process of the app: on macOS the de-duplicated footprint of the app and its WebKit or Electron helpers, attributed by process tree and bundle; on Windows the private working set of the app and its WebView2 or Electron children. Each timed number is the median of interleaved runs with its range and spread.",
    "",
  );
  for (const platform of ["mac", "win"] as const) {
    const perf = report.perf[platform];
    lines.push(`### ${PLATFORM_NAMES[platform]}`, "");
    if (!perf) {
      lines.push("Not measured.", "");
      continue;
    }
    lines.push("| Metric | Electron 1.2.1 | Tauri | Change |", "| --- | --- | --- | --- |");
    for (const m of METRICS) {
      const before = perf.electron && metric(perf.electron, m.key);
      const after = perf.tauri && metric(perf.tauri, m.key);
      const change =
        before && after ? `${((after.value / before.value - 1) * 100).toFixed(0)}%` : "";
      lines.push(`| ${m.label} | ${cell(m, perf.electron)} | ${cell(m, perf.tauri)} | ${change} |`);
    }
    lines.push("");
    for (const [label, side] of [
      ["Electron", perf.electron],
      ["Tauri", perf.tauri],
    ] as const) {
      if (!side) continue;
      const load =
        side.medianCpuIdle === null
          ? ""
          : `, median CPU idle ${pct(side.medianCpuIdle)}, median load ${side.medianLoad1?.toFixed(1) ?? "n/a"}`;
      lines.push(
        `- ${label}: ${side.downloadAsset}, ${side.valid} of ${side.runs} runs valid${load}. Source \`${side.source}\`.`,
      );
    }
    lines.push("");
  }

  lines.push("## Checks", "");
  for (const run of [mac, win]) {
    if (!run) continue;
    for (const check of run.checks) {
      lines.push(
        `- ${PLATFORM_NAMES[run.platform]} ${check.name}: ${check.pass ? "PASS" : "FAIL"}. ${check.detail}`,
      );
    }
  }
  lines.push("");

  lines.push("## Masks", "");
  const masks = [mac, win].flatMap((run) => run?.masks.map((m) => ({ run, m })) ?? []);
  if (masks.length === 0) lines.push("No state masks or declares a blur region.", "");
  else {
    for (const { run, m } of masks) {
      lines.push(
        `- ${PLATFORM_NAMES[run!.platform]} \`${m.state}\` ${m.region}: ${m.reason || "NO REASON"}`,
      );
    }
    lines.push("");
  }

  lines.push("## Recorded deviations", "");
  lines.push(
    "The engine-difference register from `parity/README.md`: differences the layout gate leaves out, each approved by the root, with negative controls in `parity/test/register.test.ts`.",
    "",
  );
  for (const d of report.deviations) lines.push(`- **${d.name}.** ${d.where} ${d.rule}`);
  const applied = (count: (s: StateLine) => number | undefined) =>
    [mac, win].flatMap(
      (run) =>
        run?.states
          .filter((s) => count(s))
          .map((s) => `${PLATFORM_NAMES[run.platform]} \`${s.id}\` (${count(s)})`) ?? [],
    );
  const widthExempt = applied((s) => s.widthExempt);
  if (widthExempt.length > 0)
    lines.push(`- Rule B applied, rows compared without width: ${widthExempt.join(", ")}.`);
  const imageExempt = applied((s) => s.imageExempt);
  if (imageExempt.length > 0)
    lines.push(
      `- Rule E applied, scaled images left out of the tile rule: ${imageExempt.join(", ")}.`,
    );
  lines.push("");
  return lines.join("\n");
}

/** The register's `### ` entries, read from the README so the report never restates them. */
export function readDeviations(readme: string): Deviation[] {
  const start = readme.indexOf("## Engine-difference register");
  if (start < 0) return [];
  const rest = readme.slice(start);
  const end = rest.indexOf("\n## ", 3);
  const section = end < 0 ? rest : rest.slice(0, end);
  return section
    .split("\n### ")
    .slice(1)
    .map((block) => {
      const [title, ...body] = block.split("\n");
      const field = (label: string) =>
        body.find((l) => l.startsWith(`- ${label}:`))?.slice(label.length + 4) ?? "";
      const where = field("Where");
      return {
        name: title!.trim(),
        where: where ? `Where: ${where}` : "",
        rule: field("Rule") || body.filter((l) => l.trim()).join(" "),
      };
    });
}

export function parseGoldenSummary(log: string, exitCode: number): GoldenSummary {
  const m = log.match(/^(\d+) pass, (\d+) fail, (\d+) not ported(?:, (\d+) no golden)?$/m);
  const failing = [...log.matchAll(/^(\S+)\s+\S+\s+\d+\s+(fail|not ported|no golden)$/gm)].map(
    (row) => `${row[1]} (${row[2]})`,
  );
  if (!m) {
    return {
      pass: 0,
      fail: 0,
      notPorted: 0,
      noGolden: 0,
      exitCode,
      completed: false,
      failing,
      log,
    };
  }
  return {
    pass: Number(m[1]),
    fail: Number(m[2]),
    notPorted: Number(m[3]),
    noGolden: Number(m[4] ?? 0),
    exitCode,
    completed: true,
    failing,
    log,
  };
}

interface PerfJson {
  platform?: string;
  version?: string;
  sizes: Record<
    string,
    { downloadBytes: number; downloadAsset: string; installedAllocatedBytes: number }
  >;
  summary: Record<
    string,
    { runs: number; valid: number; idleFootprintBytes: Stat | null; firstContentMs: Stat | null }
  >;
  load?: { medianCpuIdle?: number | null; medianLoad1?: number | null };
}

/** One perf.ts sweep's numbers per app. A later file replaces an earlier one's app. */
export function readPerf(table: PerfTable, file: string, json: PerfJson): PerfTable {
  const platform: PlatformId = file.endsWith("-win.json") ? "win" : "mac";
  const entry = { ...table[platform] };
  for (const [app, summary] of Object.entries(json.summary)) {
    const size = json.sizes[app];
    const side: PerfSide = {
      version: app,
      downloadBytes: size?.downloadBytes ?? 0,
      downloadAsset: size?.downloadAsset ?? "not given",
      installedBytes: size?.installedAllocatedBytes ?? 0,
      idleMemoryBytes: summary.idleFootprintBytes,
      firstContentMs: summary.firstContentMs,
      valid: summary.valid,
      runs: summary.runs,
      source: path.relative(REPO_DIR, file),
      medianCpuIdle: json.load?.medianCpuIdle ?? null,
      medianLoad1: json.load?.medianLoad1 ?? null,
    };
    if (app.startsWith("electron")) entry.electron = side;
    else if (app === "tauri") entry.tauri = side;
  }
  return { ...table, [platform]: entry };
}

// Running on this platform

const platformId = (): PlatformId => (process.platform === "darwin" ? "mac" : "win");

function git(...args: string[]) {
  const out = spawnSync("git", ["-C", REPO_DIR, ...args], { encoding: "utf8" });
  if (out.status !== 0) throw new Error(`git ${args.join(" ")}: ${out.stderr}`);
  return out.stdout.trim();
}

interface Tools {
  /** Prefix for any command that opens an app window: the game wait and a capture slot. */
  launch: (cmd: string[]) => string[];
  /** Prefix for any cargo command. */
  build: (cmd: string[]) => string[];
  waitNoGame?: string;
}

/**
 * On the operator's Mac every app launch waits for no League game and takes a capture slot,
 * and every cargo run takes a build slot. CI runners have neither script and need neither.
 */
function tools(dir: string | undefined): Tools {
  if (!dir) {
    if (process.platform === "darwin" && process.env.CI !== "true") {
      throw new Error("pass --tools <dir with wait-no-game.sh, capture-slot.sh, build-slot.sh>");
    }
    return { launch: (cmd) => cmd, build: (cmd) => cmd };
  }
  const script = (name: string) => {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) throw new Error(`${file} is missing`);
    return file;
  };
  const capture = script("capture-slot.sh");
  const build = script("build-slot.sh");
  return {
    launch: (cmd) => [capture, ...cmd],
    build: (cmd) => [build, "nice", "-n", "10", ...cmd],
    waitNoGame: script("wait-no-game.sh"),
  };
}

function run(cmd: string[], options: { cwd?: string; env?: Record<string, string>; log?: string }) {
  console.log(`report: ${cmd.join(" ")}`);
  const out: SpawnSyncReturns<string> = spawnSync(cmd[0]!, cmd.slice(1), {
    cwd: options.cwd ?? REPO_DIR,
    env: { ...process.env, ...options.env } as Record<string, string>,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (out.error) throw out.error;
  const text = `${out.stdout}${out.stderr}`;
  if (options.log) fs.writeFileSync(options.log, text);
  process.stdout.write(text.split("\n").slice(-8).join("\n"));
  return { code: out.status ?? 1, text };
}

function launchApp(t: Tools, cmd: string[], log: string, env: Record<string, string> = {}) {
  if (t.waitNoGame) run([t.waitNoGame], {});
  return run(t.launch(cmd), { log, env });
}

/** The capture flags this tree's `capture.ts` takes, so the report runs on every unit's version. */
const captureTakes = (flag: string) =>
  fs.readFileSync(path.join(PARITY_DIR, "capture.ts"), "utf8").includes(`"${flag}"`);

/**
 * Where the Tauri build comes from: `--binary` where capture.ts takes it, else the Cargo target
 * folder run-tauri.ts reads, which holds the binary at `<target>/debug/<name>`.
 */
function tauriBuild(binary: string | undefined): { args: string[]; env: Record<string, string> } {
  if (!binary) return { args: [], env: {} };
  const file = path.resolve(binary);
  if (captureTakes("--binary")) return { args: ["--binary", file], env: {} };
  if (path.basename(path.dirname(file)) !== "debug") {
    throw new Error(`${file}: this capture.ts finds the build only at <CARGO_TARGET_DIR>/debug/`);
  }
  return { args: [], env: { CARGO_TARGET_DIR: path.dirname(path.dirname(file)) } };
}

interface CrossEngineReport {
  states: {
    id: string;
    pass: boolean;
    cause?: string;
    reasons: string[];
    differingPct?: number;
    worstTile?: { pct: number };
    layout?: { widthExempt?: number };
    scaledImages?: { exempt: boolean }[];
    blurRegions?: { region: { x: number; y: number; w: number; h: number } }[];
  }[];
}

/** One line per expected state, from both apps' timing files and the cross-engine report. */
export function stateLines(
  expected: string[],
  dirs: { electron: string; tauri: string },
  read: (file: string) => string | undefined = (file) =>
    fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined,
): { states: StateLine[]; blur: { state: string; region: string }[] } {
  const timing = (dir: string) => {
    const text = read(path.join(dir, "timing.json"));
    const rows = text
      ? (JSON.parse(text).timings as { id: string; ok: boolean; error?: string }[])
      : [];
    return new Map(rows.map((r) => [r.id, r]));
  };
  const electron = timing(dirs.electron);
  const tauri = timing(dirs.tauri);
  const crossText = read(path.join(dirs.tauri, "cross-engine-report.json"));
  const cross = new Map(
    (crossText ? (JSON.parse(crossText) as CrossEngineReport).states : []).map((s) => [s.id, s]),
  );
  const states: StateLine[] = [];
  const blur: { state: string; region: string }[] = [];
  for (const id of expected) {
    const failedCapture = (
      [
        ["Electron", electron.get(id)],
        ["Tauri", tauri.get(id)],
      ] as const
    ).filter(([, t]) => !t?.ok);
    if (failedCapture.length > 0) {
      states.push({
        id,
        pass: false,
        cause: "capture",
        reasons: failedCapture.map(([app, t]) => `${app} ${t ? t.error : "did not capture"}`),
      });
      continue;
    }
    const c = cross.get(id);
    if (!c) {
      states.push({
        id,
        pass: false,
        cause: "capture",
        reasons: ["not in the cross-engine report"],
      });
      continue;
    }
    // Each engine reports its own boxes for the same element, so one region can appear twice
    const regions = new Set(
      (c.blurRegions ?? []).map(
        ({ region: r }) => `blur ${[r.x, r.y, r.w, r.h].map(Math.round).join(",")}`,
      ),
    );
    for (const region of regions) blur.push({ state: id, region });
    states.push({
      id,
      pass: underE1(c),
      cause: underE1(c) ? undefined : c.cause,
      differingPct: c.differingPct,
      worstTilePct: c.worstTile?.pct,
      widthExempt: c.layout?.widthExempt || undefined,
      imageExempt: c.scaledImages?.filter((image) => image.exempt).length || undefined,
      reasons: c.reasons,
      sideBySide: path.relative(
        REPO_DIR,
        path.join(dirs.tauri, "cross-engine", `${id}.side-by-side.png`),
      ),
    });
  }
  return { states, blur };
}

function contactSheet(states: StateLine[], target: string): string | undefined {
  const images = states.map((s) => s.sideBySide && path.join(REPO_DIR, s.sideBySide));
  const present = images.filter((f): f is string => !!f && fs.existsSync(f));
  if (present.length === 0) return undefined;
  const which = spawnSync(process.platform === "win32" ? "where" : "which", ["magick"]);
  if (which.status !== 0) return undefined;
  const out = run(
    [
      "magick",
      "montage",
      ...present,
      "-geometry",
      "900x+8+8",
      "-tile",
      "4x",
      "-background",
      "#0f1115",
      "-depth",
      "8",
      `PNG24:${target}`,
    ],
    {},
  );
  return out.code === 0 ? path.relative(REPO_DIR, target) : undefined;
}

/**
 * capture.ts makes every element that asks for a backdrop blur a blur region, the one kind of
 * region the policy judges apart; nothing else in the tree masks a state.
 */
export const BLUR_REASON =
  "backdrop blur, which WebKit snapshots do not draw (Appendix A); judged by the tile rule at threshold 0.2 and left out of the page count";

async function runPlatform(argv: string[]) {
  const opt = flags(argv, [
    "--data",
    "--out",
    "--binary",
    "--electron-baseline",
    "--tauri-capture",
    "--golden-dir",
    "--tools",
    "--trunk",
  ]);
  const skipGolden = argv.includes("--skip-golden");
  const t = tools(opt["--tools"]);
  const data = opt["--data"] ?? "fixture";
  const dataRoot = resolveDataRoot(data);
  const platform = platformId();
  const out = path.resolve(opt["--out"] ?? path.join(PARITY_DIR, "out", "report"));
  fs.mkdirSync(out, { recursive: true });
  const startedAt = new Date().toISOString();
  const expected = selectStates("all").map((s) => s.id);

  const electronDir = path.resolve(
    opt["--electron-baseline"] ?? path.join(out, `electron-${platform}`),
  );
  // Client states run against the fake League client where capture.ts can start it
  const all = captureTakes("--with-client") ? ["--all", "--with-client"] : ["--all"];
  if (!opt["--electron-baseline"]) {
    launchApp(
      t,
      [
        "bun",
        "parity/capture.ts",
        "--app",
        "electron",
        "--data",
        data,
        ...all,
        "--out",
        electronDir,
      ],
      path.join(out, `electron-${platform}.log`),
    );
  }
  // A Tauri capture already compared with this Electron baseline, for a rerun of the later steps
  const tauriDir = path.resolve(opt["--tauri-capture"] ?? path.join(out, `tauri-${platform}`));
  const build = tauriBuild(opt["--binary"]);
  if (!opt["--tauri-capture"]) {
    launchApp(
      t,
      [
        "bun",
        "parity/capture.ts",
        "--app",
        "tauri",
        "--renderer",
        "solid",
        "--data",
        data,
        ...all,
        "--out",
        tauriDir,
        "--compare",
        electronDir,
        ...build.args,
      ],
      path.join(out, `tauri-${platform}.log`),
      build.env,
    );
  }
  const { states, blur } = stateLines(expected, { electron: electronDir, tauri: tauriDir });

  let golden: GoldenSummary | undefined;
  if (!skipGolden) {
    const goldenDir = path.resolve(opt["--golden-dir"] ?? path.join(PARITY_DIR, "out", "golden"));
    const manifest = JSON.parse(fs.readFileSync(path.join(goldenDir, "manifest.json"), "utf8"));
    const result = run(
      t.build(["cargo", "test", "--features", "parity-driver", "--test", "golden"]),
      {
        cwd: path.join(REPO_DIR, "tauri", "src-tauri"),
        env: {
          BMT_GOLDEN_DIR: goldenDir,
          BMT_GOLDEN_DATA: path.join(dataRoot, "data"),
          // The harness refuses any zone or locale but the recording's (tauri/src-tauri/src/replay.rs)
          TZ:
            process.platform === "win32" && manifest.timeZone === "America/New_York"
              ? "EST5EDT"
              : String(manifest.timeZone),
          LANG: `${String(manifest.locale).replace("-", "_")}.UTF-8`,
        },
        log: path.join(out, `golden-${platform}.log`),
      },
    );
    golden = parseGoldenSummary(result.text, result.code);
  }

  const checks: CheckResult[] = [];
  const reactIsms = run(["bun", "scripts/react-isms.ts"], {
    cwd: path.join(REPO_DIR, "tauri"),
    log: path.join(out, `react-isms-${platform}.log`),
  });
  // Rows are a pattern, then its count in tauri/src, then in the React tree
  const counts = [...reactIsms.text.matchAll(/^(.+?)\s+(\d+)\s+\d+$/gm)];
  const found = counts.filter((m) => m[2] !== "0").map((m) => `${m[1]!.trim()} ${m[2]}`);
  checks.push({
    name: "react-isms.ts",
    pass: reactIsms.code === 0 && found.length === 0,
    detail: `${counts.length} patterns, ${found.length ? `found ${found.join(", ")}` : "every count in tauri/src is 0"}.`,
  });
  const check = (name: string, cmd: string[], cwd: string, log: string) => {
    const result = run(cmd, { cwd, log: path.join(out, `${log}-${platform}.log`) });
    checks.push({
      name,
      pass: result.code === 0,
      detail: `exit ${result.code}, last line: ${result.text.trim().split("\n").slice(-1)[0] ?? ""}`,
    });
  };
  // The Rust contract must equal the committed bindings, and both must equal src/shared/api.ts
  check(
    "export_bindings --check",
    t.build([
      "cargo",
      "run",
      "--bin",
      "export_bindings",
      "--features",
      "export-bindings",
      "--",
      "--check",
    ]),
    path.join(REPO_DIR, "tauri", "src-tauri"),
    "export-bindings",
  );
  check(
    "contract-check.ts",
    ["bun", "scripts/contract-check.ts"],
    path.join(REPO_DIR, "tauri"),
    "contract",
  );

  const db = fs.readFileSync(path.join(dataRoot, "data", "matches.db"));
  const result: PlatformRun = {
    platform,
    head: git("rev-parse", "HEAD"),
    trunk: git("rev-parse", opt["--trunk"] ?? "main"),
    fixtureSha256: crypto.createHash("sha256").update(db).digest("hex"),
    startedAt,
    finishedAt: new Date().toISOString(),
    expected,
    states,
    golden: golden && {
      ...golden,
      log: path.relative(REPO_DIR, path.join(out, `golden-${platform}.log`)),
    },
    checks,
    masks: blur.map((b) => ({ ...b, reason: BLUR_REASON })),
    contactSheet: contactSheet(states, path.join(out, `report-${platform}.png`)),
  };
  const file = path.join(out, `report-${platform}.json`);
  fs.writeFileSync(file, JSON.stringify(result, null, 1));
  const failed = states.filter((s) => !s.pass);
  console.log(
    `report: ${states.length - failed.length} of ${expected.length} states pass on ${PLATFORM_NAMES[platform]}${failed.length ? `; failing ${failed.map((s) => s.id).join(", ")}` : ""}`,
  );
  if (golden)
    console.log(
      `report: goldens ${golden.pass} pass, ${golden.fail} fail, ${golden.notPorted} not ported`,
    );
  console.log(`report: wrote ${file}`);
}

function render(argv: string[]) {
  const runs: Report["runs"] = {};
  let perf: PerfTable = {};
  let out = path.join(REPO_DIR, "docs", "tauri-port", "parity-report.md");
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    const value = argv[++i];
    if (!value) throw new Error(`${flag} needs a value`);
    if (flag === "--run") {
      const parsed = JSON.parse(fs.readFileSync(value, "utf8")) as PlatformRun;
      runs[parsed.platform] = parsed;
    } else if (flag === "--perf") {
      perf = readPerf(perf, path.resolve(value), JSON.parse(fs.readFileSync(value, "utf8")));
    } else if (flag === "--out") out = path.resolve(value);
    else throw new Error(`unknown flag ${flag}`);
  }
  const report: Report = {
    generatedAt: new Date().toISOString(),
    runs,
    perf,
    deviations: readDeviations(fs.readFileSync(path.join(PARITY_DIR, "README.md"), "utf8")),
  };
  const command = `bun parity/report.ts render ${argv
    .map((a) => (a.startsWith("--") ? a : path.relative(REPO_DIR, path.resolve(a))))
    .join(" ")}`;
  fs.writeFileSync(out, renderReport(report, command));
  // The root's format check covers docs/, and oxfmt pads every table cell
  const oxfmt = path.join(REPO_DIR, "node_modules", ".bin", "oxfmt");
  if (fs.existsSync(oxfmt)) spawnSync(oxfmt, [out], { cwd: REPO_DIR, stdio: "ignore" });
  const verdict = verdictOf(report);
  console.log(`report: ${verdict.pass ? "PASS" : "FAIL"}, wrote ${path.relative(REPO_DIR, out)}`);
  for (const failure of verdict.failures) console.log(`  ${failure}`);
  return verdict.pass;
}

function flags(argv: string[], known: string[]) {
  const out: Record<string, string | undefined> = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    if (flag === "--skip-golden") continue;
    if (!known.includes(flag)) throw new Error(`unknown flag ${flag}`);
    out[flag] = argv[++i];
  }
  return out;
}

const USAGE = `usage:
  bun parity/report.ts run [--data fixture] [--out <dir>] [--binary <driver build>] [--electron-baseline <dir>] [--tauri-capture <dir>] [--golden-dir <dir>] [--skip-golden] [--tools <dir>] [--trunk <rev>]
  bun parity/report.ts render --run <report-<platform>.json> ... [--perf <perf.json> ...] [--out <file.md>]
  bun parity/report.ts check <report-<platform>.json>`;

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "run") await runPlatform(rest);
  else if (command === "render") process.exit(render(rest) ? 0 : 1);
  else if (command === "check" && rest[0]) {
    // One platform's run alone, for a CI job that has no perf sweep and no other platform
    const run = JSON.parse(fs.readFileSync(rest[0], "utf8")) as PlatformRun;
    const failures = runFailures(PLATFORM_NAMES[run.platform], run);
    for (const failure of failures) console.log(failure);
    console.log(`report ${PLATFORM_NAMES[run.platform]}: ${failures.length ? "FAIL" : "PASS"}`);
    process.exit(failures.length ? 1 : 0);
  } else {
    console.error(USAGE);
    process.exit(2);
  }
}
