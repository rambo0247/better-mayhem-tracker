// The T14 perf probe: `getGlobalStats` and `getTrends` round trips from the
// renderer, in trunk Electron and in head Tauri on its real Rust commands.
// Both apps stay open on their own fixture copies, and the calls alternate
// between them every 10, 50 per app per case. The cases are T05's `timing.json`
// cases for these two channels.
//
//   bun parity/t14/perf-stats.ts --data <fixture folder> --out <perf.json>
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startElectron } from "../run-electron.ts";
import { startTauri } from "../run-tauri.ts";

const args = process.argv.slice(2);
const value = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const data = value("--data");
const out = value("--out");
if (!data || !out) throw new Error("usage: perf-stats.ts --data <fixture folder> --out <file>");

const copy = (name: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bmt-t14-perf-${name}-`));
  fs.cpSync(data, dir, { recursive: true });
  return dir;
};
const electronData = copy("electron");
const tauriData = copy("tauri");
process.env.BMT_DATA_ROOT = tauriData;

/** Times `rounds` calls inside the page, so only the round trip is measured. */
const probe = `async ([method, callArgs, rounds]) => {
  const times = [];
  for (let i = 0; i < rounds; i++) {
    const started = performance.now();
    await window.api[method](...callArgs);
    times.push(performance.now() - started);
  }
  return times;
}`;

const electron = await startElectron({ data: electronData });
const tauri = await startTauri({ data: tauriData, renderer: "electron", api: "tauri" });
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};
const results: Record<string, unknown> = {};
try {
  const options = (await electron.page.evaluate(() =>
    (window as any).api.getMatchFilterOptions(),
  )) as {
    patches: string[];
    queues: number[];
  };
  const cases: [string, string, unknown[]][] = [
    ["db:global-stats default", "getGlobalStats", []],
    ["db:global-stats patch", "getGlobalStats", [options.patches[0]]],
    ["db:global-stats queue", "getGlobalStats", [undefined, 2400]],
    ["db:trends default", "getTrends", []],
    ["db:trends queue", "getTrends", [2400]],
  ];
  for (const [label, method, callArgs] of cases) {
    const call = (rounds: number) => JSON.stringify([method, callArgs, rounds]);
    const times = { electron: [] as number[], tauri: [] as number[] };
    // One untimed call each, so neither app pays its first statement prepare in the sample
    await electron.page.evaluate(`(${probe})(${call(1)})`);
    await tauri.engine.evaluate(`(${probe})(${call(1)})`);
    for (let block = 0; block < 5; block++) {
      times.electron.push(
        ...((await electron.page.evaluate(`(${probe})(${call(10)})`)) as number[]),
      );
      times.tauri.push(...(await tauri.engine.evaluate<number[]>(`(${probe})(${call(10)})`)));
    }
    results[label] = {
      electronMedianMs: median(times.electron),
      tauriMedianMs: median(times.tauri),
      times,
    };
    console.log(
      `${label}: electron median ${median(times.electron).toFixed(2)} ms, tauri median ${median(times.tauri).toFixed(2)} ms`,
    );
  }
} finally {
  await electron.close();
  await tauri.close();
  fs.rmSync(electronData, { recursive: true, force: true });
  fs.rmSync(tauriData, { recursive: true, force: true });
}
fs.writeFileSync(out, JSON.stringify(results));
