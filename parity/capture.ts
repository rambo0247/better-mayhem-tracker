import fs from "node:fs";
import path from "node:path";
import { gameRunning, waitForNoGame } from "./lib/no-game.ts";
import { dumpGeometry } from "./drive.ts";
import { isDataSource, PARITY_DIR } from "./lib/data.ts";
import { refuseRealFolder } from "./lib/real-folder.ts";
import { gpuSwitch, startElectron, type RunningElectron } from "./run-electron.ts";
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
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--app") out.app = argv[++i]!;
    else if (arg === "--data") out.data = argv[++i]!;
    else if (arg === "--states") out.states = argv[++i];
    else if (arg === "--all") out.all = true;
    else if (arg === "--out") out.dir = argv[++i];
    else if (arg === "--repo") out.repo = argv[++i];
    else throw new Error(`unknown flag ${arg}`);
  }
  return out;
}

/**
 * One capture at a time. Two overlapping runs left ng2.log's Electron closed after 4 states, in
 * the same minute the other run's teardown ran.
 */
export function takeCaptureLock(lock = path.join(PARITY_DIR, "out", ".capture.lock")) {
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  for (;;) {
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: "wx" });
      process.on("exit", () => fs.rmSync(lock, { force: true }));
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const holder = Number(fs.readFileSync(lock, "utf8"));
    if (holder !== process.pid && isAlive(holder)) {
      throw new Error(`capture ${holder} is running; one capture at a time`);
    }
    fs.rmSync(lock, { force: true });
  }
}

function isAlive(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function main() {
  const args = parse(process.argv.slice(2));
  if (args.app !== "electron") {
    throw new Error(`--app ${args.app} is not available yet. Only electron is built in this unit.`);
  }
  if (!args.all && !args.states) {
    console.error(
      `usage: bun parity/capture.ts --app electron --data <fixture|snapshot|folder> (--all | --states <ids or groups>) [--out <folder>]\ngroups: ${stateGroups().join(", ")}`,
    );
    process.exit(2);
  }
  const states = selectStates(args.all ? "all" : args.states);
  const dir = path.resolve(args.dir ?? baselineDir(args.app));
  refuseRealFolder(dir, "capture folder");
  takeCaptureLock();
  fs.mkdirSync(dir, { recursive: true });
  const dataLabel = isDataSource(args.data) ? args.data : "folder";
  const startedAt = Date.now();

  let launches = 0;
  let data = args.data;
  const launch = () =>
    startElectron({
      data,
      repo: args.repo,
      runDir: path.join(dir, "..", ".run", `${path.basename(dir)}-${process.pid}-${launches++}`),
    });
  const timings: Timing[] = [];
  const seamLogs: string[] = [];
  const allFaults: string[] = [];
  const leaks: string[] = [];
  let failures = 0;

  const finish = async (session: RunningElectron, seen: number) => {
    const report = await session.close();
    const mainLog = path.join(session.runDir, "logs", "main.log");
    if (fs.existsSync(mainLog)) {
      fs.copyFileSync(mainLog, path.join(dir, `main.${seamLogs.length}.log`));
    }
    seamLogs.push(fs.readFileSync(session.seamLog, "utf8"));
    fs.rmSync(session.runDir, { recursive: true, force: true });
    allFaults.push(...report.faults);
    leaks.push(...report.leaks);
    if (report.faults.length > seen) {
      failures++;
      console.log(
        `FAIL main process fault after the last state: ${report.faults.slice(seen).join(" | ").slice(0, 400)}`,
      );
    }
  };

  let running: RunningElectron | undefined;
  let vars: Record<string, string> = {};
  let seenFaults = 0;
  const relaunch = async () => {
    if (running) await finish(running, seenFaults);
    running = undefined;
    await waitForNoGame();
    running = await launch();
    seenFaults = 0;
    vars = await resolveVars(running.page);
  };
  try {
    await relaunch();
    for (const state of states) {
      if (gameRunning()) {
        console.log("a League game started, closing the window and waiting");
        await relaunch();
      }
      if ((state.data ?? args.data) !== data) {
        data = state.data ?? args.data;
        await relaunch();
      }
      const session = running!;
      const t0 = Date.now();
      const record: Timing = { id: state.id, ms: 0, settleMs: 0, settleTimedOut: false, ok: true };
      try {
        const outcome = await applyState(session.ctx, state as StateRow, vars);
        record.settleMs = outcome.settle.ms;
        record.settleTimedOut = outcome.settle.timedOut;
        const faults = session.faults();
        if (faults.length > seenFaults) {
          const fresh = faults.slice(seenFaults);
          seenFaults = faults.length;
          throw new Error(`main process fault: ${fresh.join(" | ").slice(0, 400)}`);
        }
        if (outcome.settle.timedOut) throw new Error("the page never settled");
        if (!outcome.expectFound) throw new Error(`expected ${state.expect} on the page`);
        if (state.card && outcome.card?.state !== "ready") {
          throw new Error(`card status ${JSON.stringify(outcome.card)}`);
        }
        if (outcome.lookupsReady === false) {
          throw new Error("champion, augment or item data never loaded");
        }
        if (outcome.placeholders.length > 0) {
          throw new Error(
            `the card drew ids for missing lookups: ${outcome.placeholders.join(", ")}`,
          );
        }
        if (outcome.settle.decodeFailures) {
          console.log(`warn ${state.id}: ${outcome.settle.decodeFailures} images did not decode`);
        }
        fs.writeFileSync(
          path.join(dir, `${state.id}.geometry.json`),
          await dumpGeometry(session.page),
        );
        await session.page.screenshot({
          path: path.join(dir, `${state.id}.png`),
          animations: "disabled",
          caret: "hide",
          fullPage: state.card === true,
        });
        if (state.card) {
          const tall = fs.readFileSync(path.join(dir, `${state.id}.png`)).readUInt32BE(20) / 2;
          // The card publishes Math.ceil of a fractional height, the page a rounded one.
          if (Math.abs(tall - outcome.card!.height) > 1) {
            throw new Error(
              `card image is ${tall} CSS px tall, the card is ${outcome.card!.height}`,
            );
          }
        }
        fs.writeFileSync(
          path.join(dir, `${state.id}.meta.json`),
          JSON.stringify(
            {
              route: state.route,
              vars,
              viewport: state.viewport,
              data: state.data ?? dataLabel,
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
    if (running) await finish(running, seenFaults);
  }
  if (leaks.length) {
    failures++;
    console.log(`FAIL the app wrote outside the run folder:\n  ${leaks.join("\n  ")}`);
  }
  const wallMs = Date.now() - startedAt;
  const seamText = seamLogs.join("");
  fs.writeFileSync(path.join(dir, "seam.log"), seamText);
  const blockedWrites = seamText.split("\n").filter((l) => l.startsWith("blocked-write")).length;
  if (blockedWrites > 0) {
    failures++;
    console.log(`FAIL the seam blocked ${blockedWrites} writes to the real data folder`);
  }
  const max = timings.reduce((a, b) => (b.ms > a.ms ? b : a), timings[0]!);
  const summary = {
    gpu: gpuSwitch(),
    wallMs,
    states: timings.length,
    failures,
    faults: allFaults.length,
    leaks,
    maxState: { id: max?.id, ms: max?.ms },
    blockedWrites,
    timings,
  };
  fs.writeFileSync(path.join(dir, "timing.json"), JSON.stringify(summary, null, 1));
  console.log(
    `${timings.length} states, ${failures} failed, wall ${(wallMs / 1000).toFixed(1)} s, slowest ${max?.id} ${max?.ms} ms, blocked writes ${blockedWrites}, main-process faults ${allFaults.length}, writes outside the run folder ${leaks.length}`,
  );
  process.exit(failures ? 1 : 0);
}

if (import.meta.main) await main();
