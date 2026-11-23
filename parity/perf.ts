import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PARITY_DIR } from "./lib/data.ts";
import { parseArgs } from "node:util";
import { refuseRealFolder } from "./lib/real-folder.ts";
import { realRoots, VERSION, type Isolation } from "./perf/app.ts";
import { DEFAULT_MIN_CPU_IDLE, loadGate, startLoadSampler, summarizeLoad } from "./perf/load.ts";
import { median } from "./perf/memory-mac.ts";
import {
  runElectron,
  runTauri,
  type RunOptions,
  type RunResult,
  type Scenario,
} from "./perf/measure.ts";
import { checkPerfBundle, RefusedRun, refuseTauriRun, type TauriProfile } from "./perf/tauri.ts";
import {
  allocatedBytes,
  apparentBytes,
  pickDownload,
  releaseAssets,
  type SizeReport,
} from "./perf/size.ts";

export interface Stat {
  n: number;
  median: number;
  min: number;
  max: number;
  /** (max - min) / median, the number the plan caps at 15%. */
  spread: number;
}

export function stat(values: number[]): Stat | null {
  if (values.length === 0) return null;
  const mid = median(values);
  const min = Math.min(...values);
  const max = Math.max(...values);
  return { n: values.length, median: mid, min, max, spread: mid === 0 ? 0 : (max - min) / mid };
}

export function summarize(runs: RunResult[]) {
  const valid = runs.filter((run) => run.valid);
  return {
    runs: runs.length,
    valid: valid.length,
    invalid: runs.filter((run) => !run.valid).map((run) => run.invalidReason ?? "unknown"),
    idleFootprintBytes: stat(valid.map((run) => run.idleFootprintBytes!)),
    idleRssBytes: stat(valid.map((run) => run.idleRssBytes!)),
    firstContentMs: stat(
      valid.filter((run) => run.firstContentMs !== null).map((run) => run.firstContentMs!),
    ),
  };
}

const APPS = ["electron-1.2.1", "tauri"] as const;
type AppName = (typeof APPS)[number];
const SCENARIOS: Scenario[] = ["visible-idle", "hidden-idle"];
const PROFILES: TauriProfile[] = ["release", "lane"];

export const USAGE = [
  "usage: bun parity/perf.ts --app electron-1.2.1 [--app tauri --tauri <.app|.exe>] [--runs 10]",
  "  [--scenario visible-idle|hidden-idle] [--data fixture|<folder>|none] [--electron <.app|.exe>]",
  "  [--tauri-profile release|lane] [--tauri-download <dmg|exe>] [--idle 60] [--samples 5]",
  "  [--interval 10] [--isolation sandbox|none] [--min-cpu-idle 0.3] [--out parity/out/perf]",
  "  [--selector <css>] [--kill-role-after-first-sample <role>] [--sizes-only]",
].join("\n");

export class UsageError extends Error {}

export interface Cli {
  apps: AppName[];
  runs: number;
  scenario: Scenario;
  data: string;
  electron?: string;
  tauri?: string;
  tauriProfile: TauriProfile;
  tauriDownload?: string;
  idleSeconds: number;
  samples: number;
  intervalSeconds: number;
  isolation: Isolation;
  minCpuIdle: number;
  minCpuIdleFromFlag: boolean;
  out: string;
  selector?: string;
  killRoleAfterFirstSample?: string;
  sizesOnly: boolean;
}

function oneOf<T extends string>(flag: string, value: string, allowed: readonly T[]): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new UsageError(`${flag} must be one of ${allowed.join(", ")}, not ${value}`);
  }
  return value as T;
}

function positive(flag: string, value: string, integer = false): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || (integer && !Number.isInteger(n))) {
    throw new UsageError(
      `${flag} must be a positive ${integer ? "integer" : "number"}, not ${value}`,
    );
  }
  return n;
}

function share(flag: string, value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 1) {
    throw new UsageError(`${flag} must be a share above 0 and at most 1, not ${value}`);
  }
  return n;
}

/** Parses the command line. Unknown flags, bad values and unsafe Tauri runs throw. */
export function parseCli(
  argv: string[],
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): Cli {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        app: { type: "string", multiple: true },
        runs: { type: "string", default: "10" },
        scenario: { type: "string", default: "visible-idle" },
        data: { type: "string", default: "fixture" },
        electron: { type: "string" },
        tauri: { type: "string" },
        "tauri-profile": { type: "string", default: "release" },
        "tauri-download": { type: "string" },
        idle: { type: "string", default: "60" },
        samples: { type: "string", default: "5" },
        interval: { type: "string", default: "10" },
        isolation: { type: "string", default: platform === "darwin" ? "sandbox" : "none" },
        "min-cpu-idle": { type: "string" },
        out: { type: "string", default: path.join(PARITY_DIR, "out", "perf") },
        selector: { type: "string" },
        "kill-role-after-first-sample": { type: "string" },
        "sizes-only": { type: "boolean", default: false },
      },
    }).values;
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  const apps = (parsed.app ?? []).map((app) => oneOf("--app", app, APPS));
  if (apps.length === 0) throw new UsageError("name at least one --app");
  const isolation = oneOf("--isolation", parsed.isolation!, ["sandbox", "none"] as const);
  if (isolation === "sandbox" && platform !== "darwin") {
    throw new UsageError("--isolation sandbox exists only on macOS");
  }
  const cli: Cli = {
    apps: [...new Set(apps)],
    runs: positive("--runs", parsed.runs!, true),
    scenario: oneOf("--scenario", parsed.scenario!, SCENARIOS),
    data: parsed.data!,
    electron: parsed.electron,
    tauri: parsed.tauri,
    tauriProfile: oneOf("--tauri-profile", parsed["tauri-profile"]!, PROFILES),
    tauriDownload: parsed["tauri-download"],
    idleSeconds: positive("--idle", parsed.idle!),
    samples: positive("--samples", parsed.samples!, true),
    intervalSeconds: positive("--interval", parsed.interval!),
    isolation,
    minCpuIdle:
      parsed["min-cpu-idle"] === undefined
        ? DEFAULT_MIN_CPU_IDLE
        : share("--min-cpu-idle", parsed["min-cpu-idle"]),
    minCpuIdleFromFlag: parsed["min-cpu-idle"] !== undefined,
    out: path.resolve(parsed.out!),
    selector: parsed.selector,
    killRoleAfterFirstSample: parsed["kill-role-after-first-sample"],
    sizesOnly: parsed["sizes-only"]!,
  };
  if (cli.apps.includes("tauri")) {
    if (!cli.tauri) throw new UsageError("--app tauri needs --tauri <.app|.exe>");
    refuseTauriRun({ platform, env, isolation: cli.isolation, data: cli.data });
  }
  return cli;
}

async function downloadElectron(out: string): Promise<string> {
  const mac = process.platform === "darwin";
  const dir = path.join(out, "assets", `v${VERSION}`);
  const asset = pickDownload(releaseAssets(`v${VERSION}`), process.platform, os.arch());
  const archive = mac ? asset.name.replace(/\.dmg$/, ".zip") : asset.name;
  const target = path.join(dir, archive);
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(target)) {
    const got = spawnSync(
      "gh",
      [
        "release",
        "download",
        `v${VERSION}`,
        "-R",
        "rambo0247/better-mayhem-tracker",
        "-p",
        archive,
        "-D",
        dir,
      ],
      { stdio: "inherit" },
    );
    if (got.status !== 0) throw new Error("gh release download failed");
  }
  if (!mac) return target;
  const unpacked = path.join(dir, "app");
  if (!fs.existsSync(unpacked)) {
    const unzip = spawnSync("ditto", ["-x", "-k", target, unpacked], { stdio: "inherit" });
    if (unzip.status !== 0) throw new Error("ditto failed");
  }
  return path.join(unpacked, "Better Mayhem Tracker.app");
}

function electronSizes(appPath: string, tag: string): SizeReport {
  const assets = releaseAssets(tag);
  const download = pickDownload(assets, process.platform, os.arch());
  const mac = process.platform === "darwin";
  const installed = mac ? appPath : path.dirname(appPath);
  return {
    downloadAssets: assets,
    downloadBytes: download.size,
    downloadAsset: download.name,
    installedApparentBytes: mac ? apparentBytes(installed) : fs.statSync(appPath).size,
    installedAllocatedBytes: mac ? allocatedBytes(installed) : fs.statSync(appPath).size,
    installedPath: appPath,
  };
}

const mib = (bytes: number) => (bytes / 1048576).toFixed(1);

async function main() {
  let cli: Cli;
  try {
    cli = parseCli(process.argv.slice(2));
    if (cli.tauri && process.platform === "darwin") checkPerfBundle(cli.tauri);
  } catch (error) {
    if (!(error instanceof UsageError || error instanceof RefusedRun)) throw error;
    console.error(`perf: ${error.message}\n${USAGE}`);
    process.exit(2);
  }
  const { apps, out } = cli;
  refuseRealFolder(out, "perf output", realRoots());
  const platformTag = process.platform === "darwin" ? "mac" : "win";
  const base: Omit<RunOptions, "runDir"> = {
    data: cli.data,
    idleSeconds: cli.idleSeconds,
    samples: cli.samples,
    intervalSeconds: cli.intervalSeconds,
    isolation: cli.isolation,
    scenario: cli.scenario,
    selector: cli.selector,
    killRoleAfterFirstSample: cli.killRoleAfterFirstSample,
    log: console.log,
  };

  let electronApp = cli.electron;
  let electronSource = "operator-supplied path";
  const wantsElectron = apps.includes("electron-1.2.1");
  if (wantsElectron && !electronApp) {
    electronApp = await downloadElectron(out);
    electronSource = `gh release download v${VERSION}`;
  }
  const tauriApp = cli.tauri;

  const report: Record<string, unknown> = {
    platform: process.platform,
    arch: os.arch(),
    osRelease: os.release(),
    cpus: os.cpus().length,
    scenario: cli.scenario,
    isolation: base.isolation,
    tauriProfile: tauriApp ? cli.tauriProfile : undefined,
    idleSeconds: base.idleSeconds,
    samples: base.samples,
    intervalSeconds: base.intervalSeconds,
    startedAt: new Date().toISOString(),
  };

  const sizes: Record<string, SizeReport> = {};
  if (wantsElectron) sizes["electron-1.2.1"] = electronSizes(electronApp!, `v${VERSION}`);
  if (tauriApp) {
    const installed = process.platform === "darwin" ? tauriApp : path.dirname(tauriApp);
    const download = cli.tauriDownload;
    sizes.tauri = {
      downloadAssets: [],
      downloadBytes: download ? fs.statSync(download).size : 0,
      downloadAsset: download ? path.basename(download) : "not given",
      installedApparentBytes: apparentBytes(installed),
      installedAllocatedBytes: allocatedBytes(installed),
      installedPath: tauriApp,
    };
  }
  report.sizes = sizes;
  report.electronSource = wantsElectron ? electronSource : undefined;
  if (cli.sizesOnly) {
    console.log(JSON.stringify(sizes, null, 2));
    return;
  }

  const sampler = startLoadSampler();
  const results: Record<string, RunResult[]> = Object.fromEntries(apps.map((app) => [app, []]));
  for (let i = 0; i < cli.runs; i++) {
    const order = i % 2 === 0 ? apps : [...apps].reverse();
    for (const app of order) {
      const runDir = path.join(out, "runs", `${app}-${i}`);
      refuseRealFolder(runDir, "run folder", realRoots());
      console.log(`perf: ${app} run ${i + 1}/${cli.runs}, load ${os.loadavg()[0]!.toFixed(1)}`);
      const startedMs = Date.now();
      const result =
        app === "electron-1.2.1"
          ? await runElectron({ ...base, runDir, executable: electronExecutable(electronApp!) })
          : await runTauri({ ...base, runDir, app: tauriApp!, profile: cli.tauriProfile });
      result.load = summarizeLoad(sampler.between(startedMs, Date.now()));
      results[app]!.push(result);
      try {
        fs.rmSync(runDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
      } catch (error) {
        result.notes.push(`run folder left behind: ${String(error)}`);
      }
      console.log(`  ${result.valid ? "ok" : `INVALID ${result.invalidReason}`}`);
      await Bun.sleep(3000);
    }
  }
  await sampler.stop();

  const extracted = (results["electron-1.2.1"] ?? [])
    .map((run) => run.extractedBytes)
    .filter((bytes): bytes is number => bytes !== undefined);
  if (extracted.length > 0 && sizes["electron-1.2.1"]) {
    sizes["electron-1.2.1"].installedApparentBytes = median(extracted);
    sizes["electron-1.2.1"].installedAllocatedBytes = median(extracted);
  }
  const loadSummary = summarizeLoad(sampler.samples);
  const gate = loadGate(loadSummary, cli.minCpuIdle, cli.minCpuIdleFromFlag);
  const summary = Object.fromEntries(apps.map((app) => [app, summarize(results[app]!)]));
  const full = {
    ...report,
    load: {
      ...gate,
      ...loadSummary,
      loadAverageMeaningful: process.platform !== "win32",
      intervalMs: 2000,
      samples: sampler.samples,
    },
    summary,
    runs: results,
    finishedAt: new Date().toISOString(),
  };
  fs.mkdirSync(out, { recursive: true });
  const scenarioTag = cli.scenario === "visible-idle" ? "" : `-${cli.scenario}`;
  const name = (apps: string) => `${apps}${scenarioTag}-${platformTag}`;
  if (!gate.passed) {
    const file = path.join(out, `${name(apps.join("+"))}.refused.json`);
    fs.writeFileSync(file, JSON.stringify(full, null, 2));
    console.error(
      `perf: refused, median CPU idle ${pct(loadSummary.medianCpuIdle)} is below ${pct(cli.minCpuIdle)}, so no numbers are reported. Raw runs in ${file}`,
    );
    process.exit(1);
  }
  const file = path.join(out, `${name(apps.join("+"))}.json`);
  fs.writeFileSync(file, JSON.stringify(full, null, 2));
  printSummary(summary, sizes);
  console.log(
    `  median CPU idle ${pct(loadSummary.medianCpuIdle)} (min ${pct(cli.minCpuIdle)}${cli.minCpuIdleFromFlag ? " from --min-cpu-idle" : ""}), median load ${loadSummary.medianLoad1?.toFixed(1)}`,
  );
  console.log(`perf: wrote ${file}`);
}

function pct(share: number | null): string {
  return share === null ? "-" : `${(share * 100).toFixed(0)}%`;
}

function electronExecutable(appPath: string): string {
  if (process.platform !== "darwin") return appPath;
  return path.join(appPath, "Contents", "MacOS", "Better Mayhem Tracker");
}

function printSummary(
  summary: Record<string, ReturnType<typeof summarize>>,
  sizes: Record<string, SizeReport>,
) {
  for (const [app, s] of Object.entries(summary)) {
    const size = sizes[app];
    console.log(`\n${app}  valid ${s.valid}/${s.runs}`);
    if (size) {
      console.log(`  download   ${mib(size.downloadBytes)} MiB (${size.downloadAsset})`);
      console.log(
        `  installed  ${mib(size.installedAllocatedBytes)} MiB on disk, ${mib(size.installedApparentBytes)} MiB apparent`,
      );
    }
    const line = (label: string, st: Stat | null, scale: (n: number) => string) =>
      console.log(
        st
          ? `  ${label} median ${scale(st.median)}, range ${scale(st.min)} to ${scale(st.max)}, spread ${(st.spread * 100).toFixed(1)}%`
          : `  ${label} none`,
      );
    line("idle memory (footprint)", s.idleFootprintBytes, (n) => `${mib(n)} MiB`);
    line("idle memory (rss)      ", s.idleRssBytes, (n) => `${mib(n)} MiB`);
    line("launch to first content", s.firstContentMs, (n) => `${n.toFixed(0)} ms`);
    for (const reason of s.invalid) console.log(`  invalid run: ${reason}`);
  }
}

if (import.meta.main) await main();
