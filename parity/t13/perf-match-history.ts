// The T13 perf probe: `getMatchHistory` round trips from the renderer, a
// 50-game page and every game, in trunk Electron and in head Tauri on its
// real Rust commands. Both apps stay open on their own fixture copies, and
// the calls alternate between them every 10, 50 per app per size.
//
//   bun parity/t13/perf-match-history.ts --data <fixture folder> --out <perf.json>
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startElectron } from "../run-electron.ts";
import { startTauri } from "../run-tauri.ts";

const args = process.argv.slice(2);
const value = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const data = value("--data");
const out = value("--out");
if (!data || !out)
  throw new Error("usage: perf-match-history.ts --data <fixture folder> --out <file>");

const copy = (name: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bmt-t13-perf-${name}-`));
  fs.cpSync(data, dir, { recursive: true });
  return dir;
};
const electronData = copy("electron");
const tauriData = copy("tauri");
process.env.BMT_DATA_ROOT = tauriData;

/** Times `rounds` calls inside the page, so only the round trip is measured. */
const probe = `async ([limit, offset, rounds]) => {
  const times = [];
  let rows = 0;
  for (let i = 0; i < rounds; i++) {
    const started = performance.now();
    const page = await window.api.getMatchHistory(limit, offset);
    times.push(performance.now() - started);
    rows = page.matches.length;
  }
  return { times, rows };
}`;

const electron = await startElectron({ data: electronData });
const tauri = await startTauri({ data: tauriData, renderer: "electron", api: "tauri" });
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};
const results: Record<string, unknown> = {};
try {
  for (const [label, limit] of [
    ["page-50", 50],
    ["all", 10000],
  ] as const) {
    const times = { electron: [] as number[], tauri: [] as number[] };
    const rows = { electron: 0, tauri: 0 };
    // One untimed call each, so neither app pays its first statement prepare in the sample
    await electron.page.evaluate(`(${probe})([${limit}, 0, 1])`);
    await tauri.engine.evaluate(`(${probe})([${limit}, 0, 1])`);
    for (let block = 0; block < 5; block++) {
      const e = (await electron.page.evaluate(`(${probe})([${limit}, 0, 10])`)) as {
        times: number[];
        rows: number;
      };
      const t = await tauri.engine.evaluate<{ times: number[]; rows: number }>(
        `(${probe})([${limit}, 0, 10])`,
      );
      times.electron.push(...e.times);
      times.tauri.push(...t.times);
      rows.electron = e.rows;
      rows.tauri = t.rows;
    }
    results[label] = {
      rows,
      electronMedianMs: median(times.electron),
      tauriMedianMs: median(times.tauri),
      times,
    };
    console.log(
      `${label}: ${rows.electron}/${rows.tauri} rows, electron median ${median(times.electron).toFixed(2)} ms, tauri median ${median(times.tauri).toFixed(2)} ms`,
    );
  }
} finally {
  await electron.close();
  await tauri.close();
  fs.rmSync(electronData, { recursive: true, force: true });
  fs.rmSync(tauriData, { recursive: true, force: true });
}
fs.writeFileSync(out, JSON.stringify(results, null, 1));
