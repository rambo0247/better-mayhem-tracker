// Probes the Tauri `window.api` that tauri/src/api.ts builds over the Rust commands, inside the
// head Tauri app with Electron's renderer loaded. It checks the object's shape, what a stub
// rejects with, what an unknown channel rejects with, and that each of the 11 events reaches
// its `on*` listener under its Electron name. With --timing it also times a stub's round trip
// against Electron's `getVersion`, alternating the apps every 100 calls.
//
//   bun parity/invoke-probe.ts --data <folder> [--timing] [--out <folder>]
import fs from "node:fs";
import path from "node:path";
import { startElectron } from "./run-electron.ts";
import { startTauri } from "./run-tauri.ts";

export const EVENT_SAMPLES: Record<string, unknown> = {
  "lcu:status-changed": "connected",
  "lcu:games-updated": null,
  "lcu:backfill-progress": { current: 1, total: 4, added: 1 },
  "lcu:backfill-done": { error: "probe" },
  "live:changed": {
    inGame: false,
    starting: false,
    gameId: null,
    queueId: null,
    mapId: null,
    mapName: null,
    mapSkin: null,
    gameTime: 0,
    players: [],
    events: [],
  },
  "challenges:changed": { data: null, pending: true },
  "update:progress": 50,
  "update:installing": { hasUpdate: true, latest: "9.9.9" },
  "update:install-failed": "probe",
  "window:maximized-changed": true,
  "data:import-progress": { current: 1, total: 4, imported: 1 },
};

const LISTENERS: Record<string, string> = {
  "lcu:status-changed": "onStatusChanged",
  "lcu:games-updated": "onGamesUpdated",
  "lcu:backfill-progress": "onBackfillProgress",
  "lcu:backfill-done": "onBackfillDone",
  "live:changed": "onLiveGame",
  "challenges:changed": "onChallengesChanged",
  "update:progress": "onUpdateProgress",
  "update:installing": "onUpdateInstalling",
  "update:install-failed": "onUpdateInstallFailed",
  "window:maximized-changed": "onMaximizedChanged",
  "data:import-progress": "onImportProgress",
};

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

// Both pages run a frozen clock, and WebKit coarsens performance.now() to 1 ms, so a round is
// timed from here: 100 awaited calls, less the same evaluate with none, divided by 100
const callsScript = (calls: number) => `(async () => {
  for (let i = 0; i < ${calls}; i++) await window.api.getVersion().catch(() => {});
  return ${calls};
})()`;

async function perCallMs(evaluate: (script: string) => Promise<unknown>): Promise<number> {
  let start = performance.now();
  await evaluate(callsScript(0));
  const empty = performance.now() - start;
  start = performance.now();
  await evaluate(callsScript(100));
  return (performance.now() - start - empty) / 100;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const value = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
  const data = value("--data");
  if (!data) {
    console.error("usage: bun parity/invoke-probe.ts --data <folder> [--timing] [--out <folder>]");
    process.exit(2);
  }
  const out = path.resolve(value("--out") ?? path.join(import.meta.dir, "out", "invoke-probe"));
  fs.mkdirSync(out, { recursive: true });
  const report: Record<string, unknown> = {};
  const tauri = await startTauri({
    data,
    renderer: "electron",
    api: "tauri",
    runDir: path.join(out, "tauri"),
  });
  try {
    const page = tauri.engine;
    report.shape = await page.evaluate(`(() => ({
      keys: Object.keys(window.api).length,
      platform: window.api.platform,
      locale: window.api.locale ?? "undefined",
      boot: window.__BMT_BOOT__,
    }))()`);
    report.stub = await page.evaluate(`window.api.getVersion().then(
      (value) => ({ resolved: value }),
      (error) => ({ name: error.name, message: error.message, code: error.code, isError: error instanceof Error }),
    )`);
    report.unknownRaw =
      await page.evaluate(`window.__TAURI_INTERNALS__.invoke("bmt:unregistered-channel", {}).then(
      (value) => ({ resolved: value }),
      (error) => ({ rejected: String(error) }),
    )`);

    await page.evaluate(`(() => {
      window.__probeEvents = [];
      for (const [event, method] of Object.entries(${JSON.stringify(LISTENERS)})) {
        window.api[method]((...args) => window.__probeEvents.push({ event, args }));
      }
    })()`);
    // listen() resolves asynchronously; give every listener time to register
    await Bun.sleep(500);
    for (const [event, payload] of Object.entries(EVENT_SAMPLES)) {
      await tauri.driver.json("emit", { event, payload });
    }
    await Bun.sleep(500);
    const received = (await page.evaluate("window.__probeEvents")) as {
      event: string;
      args: unknown[];
    }[];
    report.events = Object.entries(EVENT_SAMPLES).map(([event, payload]) => {
      const got = received.filter((r) => r.event === event);
      const expected = event === "lcu:games-updated" ? [] : [payload];
      const pass = got.length === 1 && JSON.stringify(got[0].args) === JSON.stringify(expected);
      return { event, listener: LISTENERS[event], received: got.map((g) => g.args), pass };
    });

    if (args.includes("--timing")) {
      const electron = await startElectron({ data, runDir: path.join(out, "electron") });
      try {
        const tauriRounds: number[] = [];
        const electronRounds: number[] = [];
        for (let round = 0; round < 10; round++) {
          tauriRounds.push(await perCallMs((script) => page.evaluate(script)));
          electronRounds.push(await perCallMs((script) => electron.page.evaluate(script)));
        }
        report.timing = {
          calls: "1000 per app, 10 alternating rounds of 100",
          tauriStubMs: { median: median(tauriRounds), rounds: tauriRounds },
          electronGetVersionMs: { median: median(electronRounds), rounds: electronRounds },
          deltaMs: median(tauriRounds) - median(electronRounds),
        };
      } finally {
        await electron.close();
      }
    }
  } finally {
    await tauri.close();
  }
  const file = path.join(out, "invoke-probe.json");
  fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  console.log(`wrote ${file}`);
}
