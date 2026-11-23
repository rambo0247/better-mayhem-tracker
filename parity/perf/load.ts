import os from "node:os";
import { median } from "./memory-mac.ts";

export const DEFAULT_MAX_LOAD = 10;

export interface LoadSample {
  atMs: number;
  /** The 1-minute load average. Windows has none and reports 0. */
  load1: number;
  /** Share of CPU time spent idle across every core since the previous sample. */
  cpuIdle: number | null;
}

/** Windows: the idle share of CPU time between two `os.cpus()` readings, over every core. */
export function cpuIdleBetween(before: os.CpuInfo[], after: os.CpuInfo[]): number | null {
  let idle = 0;
  let total = 0;
  after.forEach((cpu, i) => {
    const was = before[i];
    if (!was) return;
    for (const key of Object.keys(cpu.times) as Array<keyof os.CpuInfo["times"]>) {
      total += cpu.times[key] - was.times[key];
    }
    idle += cpu.times.idle - was.times.idle;
  });
  return total > 0 ? idle / total : null;
}

/**
 * Reads `top -l N -s 2 -n 0` output one line at a time. A `Load Avg` line opens a sample and
 * the next `CPU usage` line closes it. The first sample of each top process covers the time
 * since boot, not the last 2 s, so its CPU idle is dropped.
 */
export function topReader(onSample: (sample: Omit<LoadSample, "atMs">) => void) {
  let load1: number | null = null;
  let first = true;
  return (line: string) => {
    const load = /^Load Avg: ([\d.]+),/.exec(line);
    if (load) load1 = Number(load[1]);
    const cpu = /^CPU usage: .*?([\d.]+)% idle/.exec(line);
    if (cpu && load1 !== null) {
      onSample({ load1, cpuIdle: first ? null : Number(cpu[1]) / 100 });
      first = false;
      load1 = null;
    }
  };
}

const TOP_SAMPLES_PER_PROCESS = 31;

/**
 * Samples load every 2 s until stopped. On macOS `os.cpus()` times stay frozen (measured on
 * Darwin 27.2.0, in Bun and Node alike), so top supplies both numbers. Each top process
 * ends by itself after a minute and is replaced, so a crash leaves no sampler behind.
 */
export function startLoadSampler() {
  const samples: LoadSample[] = [];
  let stopped = false;
  let killTop = () => {};
  let clearTimer = () => {};

  const runTop = async () => {
    while (!stopped) {
      const top = Bun.spawn(["top", "-l", String(TOP_SAMPLES_PER_PROCESS), "-s", "2", "-n", "0"], {
        stdout: "pipe",
        stderr: "ignore",
        stdin: "ignore",
      });
      killTop = () => top.kill();
      const read = topReader((sample) => samples.push({ atMs: Date.now(), ...sample }));
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of top.stdout as ReadableStream<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          read(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
        }
      }
      await top.exited;
    }
  };

  let done: Promise<void> = Promise.resolve();
  if (process.platform === "darwin") done = runTop();
  else {
    let cpus = os.cpus();
    const take = () => {
      const now = os.cpus();
      samples.push({
        atMs: Date.now(),
        load1: os.loadavg()[0]!,
        cpuIdle: cpuIdleBetween(cpus, now),
      });
      cpus = now;
    };
    samples.push({ atMs: Date.now(), load1: os.loadavg()[0]!, cpuIdle: null });
    const timer = setInterval(take, 2000);
    clearTimer = () => clearInterval(timer);
  }
  return {
    samples,
    between: (fromMs: number, toMs: number) =>
      samples.filter((sample) => sample.atMs >= fromMs && sample.atMs <= toMs),
    stop: async () => {
      stopped = true;
      clearTimer();
      killTop();
      await done;
    },
  };
}

export interface LoadSummary {
  samples: number;
  medianLoad1: number | null;
  medianCpuIdle: number | null;
}

export function summarizeLoad(samples: LoadSample[]): LoadSummary {
  const idle = samples.flatMap((sample) => (sample.cpuIdle === null ? [] : [sample.cpuIdle]));
  return {
    samples: samples.length,
    medianLoad1: samples.length ? median(samples.map((sample) => sample.load1)) : null,
    medianCpuIdle: idle.length ? median(idle) : null,
  };
}

export interface LoadGate {
  maxLoad: number;
  /** True when `--max-load` set the threshold instead of the default. */
  maxLoadFromFlag: boolean;
  medianLoad1: number | null;
  passed: boolean;
}

/** A sweep whose median 1-minute load is above the threshold reports no numbers. */
export function loadGate(summary: LoadSummary, maxLoad: number, fromFlag: boolean): LoadGate {
  return {
    maxLoad,
    maxLoadFromFlag: fromFlag,
    medianLoad1: summary.medianLoad1,
    passed: summary.medianLoad1 !== null && summary.medianLoad1 <= maxLoad,
  };
}
