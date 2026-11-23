import fs from "node:fs";
import path from "node:path";
import { waitForNoGame } from "./lib/no-game.ts";
import { dumpGeometry } from "./drive.ts";
import { isDataSource, PARITY_DIR } from "./lib/data.ts";
import { startElectron } from "./run-electron.ts";
import { applyState, resolveVars, selectStates, stateGroups, type StateRow } from "./states.ts";

export const baselineDir = (app: string, platform: NodeJS.Platform = process.platform) =>
  path.join(PARITY_DIR, "out", "baseline", `${app}-${platform === "darwin" ? "mac" : "win"}`);

interface Timing {
  id: string;
  ms: number;
  settleMs: number;
  settleTimedOut: boolean;
  ok: boolean;
  error?: string;
}

function parse(argv: string[]) {
  const out = {
    app: "electron",
    data: "fixture",
    states: undefined as string | undefined,
    all: false,
    dir: undefined as string | undefined,
    repo: undefined as string | undefined,
    timing: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--app") out.app = argv[++i]!;
    else if (arg === "--data") out.data = argv[++i]!;
    else if (arg === "--states") out.states = argv[++i];
    else if (arg === "--all") out.all = true;
    else if (arg === "--out") out.dir = argv[++i];
    else if (arg === "--repo") out.repo = argv[++i];
    else if (arg === "--timing") out.timing = true;
    else throw new Error(`unknown flag ${arg}`);
  }
  return out;
}

async function main() {
  const args = parse(process.argv.slice(2));
  if (args.app !== "electron") {
    throw new Error(`--app ${args.app} is not available yet. Only electron is built in this unit.`);
  }
  if (!args.all && !args.states) {
    console.error(
      `usage: bun parity/capture.ts --app electron --data <fixture|snapshot|folder> (--all | --states <ids or groups>) [--out <folder>] [--timing]\ngroups: ${stateGroups().join(", ")}`,
    );
    process.exit(2);
  }
  const states = selectStates(args.all ? "all" : args.states, process.platform);
  const dir = path.resolve(args.dir ?? baselineDir(args.app));
  fs.mkdirSync(dir, { recursive: true });
  const dataLabel = isDataSource(args.data) ? args.data : "folder";
  const startedAt = Date.now();

  const running = await startElectron({
    data: args.data,
    repo: args.repo,
    runDir: path.join(dir, "..", ".run", `${path.basename(dir)}-${process.pid}`),
  });
  const timings: Timing[] = [];
  let failures = 0;
  try {
    const vars = await resolveVars(running.page);
    for (const state of states) {
      await waitForNoGame();
      const t0 = Date.now();
      const record: Timing = { id: state.id, ms: 0, settleMs: 0, settleTimedOut: false, ok: true };
      try {
        const outcome = await applyState(running.ctx, state as StateRow, vars);
        record.settleMs = outcome.settle.ms;
        record.settleTimedOut = outcome.settle.timedOut;
        if (!outcome.expectFound) throw new Error(`expected ${state.expect} on the page`);
        if (state.card && outcome.card?.state !== "ready") {
          throw new Error(`card status ${JSON.stringify(outcome.card)}`);
        }
        fs.writeFileSync(
          path.join(dir, `${state.id}.geometry.json`),
          await dumpGeometry(running.page),
        );
        await running.page.screenshot({
          path: path.join(dir, `${state.id}.png`),
          animations: "disabled",
          caret: "hide",
        });
        fs.writeFileSync(
          path.join(dir, `${state.id}.meta.json`),
          JSON.stringify(
            {
              route: state.route,
              vars,
              viewport: state.viewport,
              data: dataLabel,
              card: outcome.card,
              settle: outcome.settle,
            },
            null,
            1,
          ),
        );
      } catch (error) {
        record.ok = false;
        record.error = String(error);
        failures++;
      }
      record.ms = Date.now() - t0;
      timings.push(record);
      console.log(
        `${record.ok ? "ok  " : "FAIL"} ${state.id} ${record.ms} ms${record.error ? ` ${record.error}` : ""}`,
      );
    }
  } finally {
    await running.close();
  }
  const wallMs = Date.now() - startedAt;
  fs.copyFileSync(running.seamLog, path.join(dir, "seam.log"));
  const blockedWrites = fs
    .readFileSync(running.seamLog, "utf8")
    .split("\n")
    .filter((l) => l.startsWith("blocked-write")).length;
  const max = timings.reduce((a, b) => (b.ms > a.ms ? b : a), timings[0]!);
  const summary = {
    wallMs,
    states: timings.length,
    failures,
    maxState: { id: max?.id, ms: max?.ms },
    blockedWrites,
    timings,
  };
  fs.writeFileSync(path.join(dir, "timing.json"), JSON.stringify(summary, null, 1));
  console.log(
    `${timings.length} states, ${failures} failed, wall ${(wallMs / 1000).toFixed(1)} s, slowest ${max?.id} ${max?.ms} ms, blocked writes ${blockedWrites}`,
  );
  process.exit(failures ? 1 : 0);
}

if (import.meta.main) await main();
