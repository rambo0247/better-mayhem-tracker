import os from "node:os";
import { median } from "./memory-mac.ts";

/**
 * A sweep whose median CPU idle is below this share refuses. Set from macOS samples near a
 * 1-minute load of 16, where idle was 17 to 37% (see the T06 record for why load 10 was not sampled). CPU idle gates on every platform because
 * `os.loadavg()` is always 0 on Windows.
 */
export const DEFAULT_MIN_CPU_IDLE = 0.3;

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
 * the next `CPU usage` line closes it. The first sample of each top process is a
 * short-interval reading, not a full 2 s interval, so its CPU idle is dropped.
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
  minCpuIdle: number;
  /** True when `--min-cpu-idle` set the threshold instead of the default. */
  minCpuIdleFromFlag: boolean;
  medianCpuIdle: number | null;
  medianLoad1: number | null;
  passed: boolean;
}

/** A sweep whose median CPU idle is below the threshold reports no numbers. */
export function loadGate(summary: LoadSummary, minCpuIdle: number, fromFlag: boolean): LoadGate {
  return {
    minCpuIdle,
    minCpuIdleFromFlag: fromFlag,
    medianCpuIdle: summary.medianCpuIdle,
    medianLoad1: summary.medianLoad1,
    passed: summary.medianCpuIdle !== null && summary.medianCpuIdle >= minCpuIdle,
  };
}
