import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PARITY_DIR } from "./lib/data.ts";
import { refuseRealFolder } from "./lib/real-folder.ts";
import { VERSION, type Isolation } from "./perf/app.ts";
import { median } from "./perf/memory-mac.ts";
import { runElectron, runTauri, type RunOptions, type RunResult } from "./perf/measure.ts";
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

const args = process.argv.slice(2);
const values = (flag: string) =>
  args.flatMap((arg, i) => (arg === flag && args[i + 1] ? [args[i + 1]!] : []));
const value = (flag: string, fallback?: string) => values(flag)[0] ?? fallback;

function usage(): never {
  console.error(
    [
      "usage: bun parity/perf.ts --app electron-1.2.1 [--app tauri] [--runs 10]",
      "  [--data fixture|<folder>] [--electron <.app|.exe>] [--tauri <.app|.exe>]",
      "  [--idle 60] [--samples 5] [--interval 10] [--isolation sandbox|none]",
      "  [--tauri-download <dmg|exe>] [--out parity/out/perf] [--selector <css>] [--sizes-only]",
    ].join("\n"),
  );
  process.exit(2);
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
  const apps = values("--app");
  if (apps.length === 0) usage();
  const runs = Number(value("--runs", "10"));
  const out = path.resolve(value("--out", path.join(PARITY_DIR, "out", "perf"))!);
  refuseRealFolder(out, "perf output");
  const platformTag = process.platform === "darwin" ? "mac" : "win";
  const base: Omit<RunOptions, "runDir"> = {
    data: value("--data", "fixture")!,
    idleSeconds: Number(value("--idle", "60")),
    samples: Number(value("--samples", "5")),
    intervalSeconds: Number(value("--interval", "10")),
    isolation: value(
      "--isolation",
      process.platform === "darwin" ? "sandbox" : "none",
    ) as Isolation,
    selector: value("--selector"),
    log: console.log,
  };

  let electronApp = value("--electron");
  let electronSource = "operator-supplied path";
  const wantsElectron = apps.includes("electron-1.2.1");
  if (wantsElectron && !electronApp) {
    electronApp = await downloadElectron(out);
    electronSource = `gh release download v${VERSION}`;
  }
  const tauriApp = value("--tauri");
  if (apps.includes("tauri") && !tauriApp) usage();

  const report: Record<string, unknown> = {
    platform: process.platform,
    arch: os.arch(),
    osRelease: os.release(),
    cpus: os.cpus().length,
    loadAverageAtStart: os.loadavg(),
    isolation: base.isolation,
    idleSeconds: base.idleSeconds,
    samples: base.samples,
    intervalSeconds: base.intervalSeconds,
    startedAt: new Date().toISOString(),
  };

  const sizes: Record<string, SizeReport> = {};
  if (wantsElectron) sizes["electron-1.2.1"] = electronSizes(electronApp!, `v${VERSION}`);
  if (apps.includes("tauri") && tauriApp) {
    const installed = process.platform === "darwin" ? tauriApp : path.dirname(tauriApp);
    const download = value("--tauri-download");
    const downloadBytes = download ? fs.statSync(download).size : 0;
    sizes.tauri = {
      downloadAssets: [],
      downloadBytes,
      downloadAsset: download ? path.basename(download) : "not given",
      installedApparentBytes: apparentBytes(installed),
      installedAllocatedBytes: allocatedBytes(installed),
      installedPath: tauriApp,
    };
  }
  report.sizes = sizes;
  report.electronSource = wantsElectron ? electronSource : undefined;
  if (args.includes("--sizes-only")) {
    console.log(JSON.stringify(sizes, null, 2));
    return;
  }

  const results: Record<string, RunResult[]> = Object.fromEntries(apps.map((app) => [app, []]));
  for (let i = 0; i < runs; i++) {
    const order = i % 2 === 0 ? apps : [...apps].reverse();
    for (const app of order) {
      const runDir = path.join(out, "runs", `${app}-${i}`);
      refuseRealFolder(runDir, "run folder");
      console.log(`perf: ${app} run ${i + 1}/${runs}, load ${os.loadavg()[0]!.toFixed(1)}`);
      const result =
        app === "electron-1.2.1"
          ? await runElectron({ ...base, runDir, executable: electronExecutable(electronApp!) })
          : await runTauri({ ...base, runDir, app: tauriApp! });
      results[app]!.push(result);
      fs.rmSync(runDir, { recursive: true, force: true });
      console.log(
        `  ${result.valid ? "ok" : `INVALID ${result.invalidReason}`} first=${result.firstContentMs?.toFixed(0)} ms footprint=${result.idleFootprintBytes ? mib(result.idleFootprintBytes) : "-"} MiB rss=${result.idleRssBytes ? mib(result.idleRssBytes) : "-"} MiB`,
      );
      await Bun.sleep(3000);
    }
  }

  const summary = Object.fromEntries(apps.map((app) => [app, summarize(results[app]!)]));
  const full = { ...report, summary, runs: results, finishedAt: new Date().toISOString() };
  fs.mkdirSync(out, { recursive: true });
  const file = path.join(out, `${apps.join("+")}-${platformTag}.json`);
  fs.writeFileSync(file, JSON.stringify(full, null, 2));
  if (apps.length === 1 && wantsElectron) {
    fs.writeFileSync(
      path.join(out, `electron-1.2.1-${platformTag}.json`),
      JSON.stringify(full, null, 2),
    );
  }
  printSummary(summary, sizes);
  console.log(`perf: wrote ${file}`);
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
