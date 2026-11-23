import fs from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import {
  CROSS_ENGINE,
  diffFiles,
  readGeometry,
  type DiffResult,
  type GeometryRow,
  type BlurRegion,
  type FocusMeta,
} from "./diff.ts";
import { dumpGeometry, type DriveContext } from "./drive.ts";
import { isDataSource, PARITY_DIR } from "./lib/data.ts";
import { gameRunning, waitForNoGame } from "./lib/no-game.ts";
import { refuseRealFolder } from "./lib/real-folder.ts";
import {
  electronClientEnv,
  HOLD_CONNECTING_SCRIPT,
  openClientState,
  tauriClientEnv,
  type ClientCapture,
  type ClientLaunch,
} from "./capture-client.ts";
import { gpuSwitch, startElectron, type RunningElectron } from "./run-electron.ts";
import { startTauri, type Renderer, type RunningTauri } from "./run-tauri.ts";
import {
  applyState,
  resolveVars,
  selectStates,
  stateGroups,
  type StateOutcome,
  type StateRow,
} from "./states.ts";

export const baselineDir = (app: string, platform: NodeJS.Platform = process.platform) =>
  path.join(PARITY_DIR, "out", "baseline", `${app}-${platform === "darwin" ? "mac" : "win"}`);

interface Timing {
  id: string;
  ms: number;
  settleMs: number;
  settleTimedOut: boolean;
  ok: boolean;
  error?: string;
  /** Client states: app start to the app reading "Connected" or "In Game". */
  connectMs?: number;
  /** Electron card states: how many times the card was drawn again for a missing lookup. */
  retries?: number;
}

/** Tries for an Electron reference card, as T05's recording allowed. */
const CARD_ATTEMPTS = 5;

type App = "electron" | "tauri";

interface ClosedApp {
  faults: string[];
  leaks: string[];
  seam: string;
}

interface RunningApp {
  ctx: DriveContext;
  runDir: string;
  faults(): string[];
  /** Facts recorded in every state's meta file. */
  meta(): Promise<Record<string, unknown>>;
  /** Closes the app and copies its logs into `dir`, numbered by launch. */
  close(dir: string, launch: number): Promise<ClosedApp>;
}

function parse(argv: string[]) {
  const out = {
    app: "electron" as App,
    renderer: "electron" as Renderer,
    data: "fixture",
    states: undefined as string | undefined,
    all: false,
    withClient: false,
    dir: undefined as string | undefined,
    repo: undefined as string | undefined,
    golden: undefined as string | undefined,
    compare: undefined as string | undefined,
    /** What answers Electron's renderer in the Tauri driver: the goldens, or the Rust commands. */
    api: undefined as "replay" | "tauri" | undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--app") out.app = argv[++i] as App;
    else if (arg === "--renderer") out.renderer = argv[++i] as Renderer;
    else if (arg === "--data") out.data = argv[++i]!;
    else if (arg === "--states") out.states = argv[++i];
    else if (arg === "--all") out.all = true;
    else if (arg === "--with-client") out.withClient = true;
    else if (arg === "--out") out.dir = argv[++i];
    else if (arg === "--repo") out.repo = argv[++i];
    else if (arg === "--golden") out.golden = argv[++i];
    else if (arg === "--compare") out.compare = argv[++i];
    else if (arg === "--api") {
      const api = argv[++i];
      if (api !== "replay" && api !== "tauri")
        throw new Error(`--api takes replay or tauri, not ${api}`);
      out.api = api;
    } else throw new Error(`unknown flag ${arg}`);
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

function electronApp(running: RunningElectron): RunningApp {
  return {
    ctx: running.ctx,
    runDir: running.runDir,
    faults: () => running.faults(),
    meta: async () => ({ engine: "electron" }),
    async close(dir, launch) {
      const report = await running.close();
      const mainLog = path.join(running.runDir, "logs", "main.log");
      if (fs.existsSync(mainLog)) fs.copyFileSync(mainLog, path.join(dir, `main.${launch}.log`));
      return { ...report, seam: fs.readFileSync(running.seamLog, "utf8") };
    },
  };
}

function tauriApp(args: ReturnType<typeof parse>, running: RunningTauri): RunningApp {
  return {
    ctx: running.ctx,
    runDir: running.runDir,
    faults: () => [],
    meta: async () => ({
      engine: process.platform === "darwin" ? "wkwebview" : "webview2",
      renderer: args.renderer,
      snapshot: running.engine.lastSnapshot,
      clamped: running.engine.clamped,
      // A call the goldens do not answer changes what the page shows, not how it renders
      replayMisses: await running.engine.evaluate(
        () => ((window as any).api?.__misses ?? []) as string[],
      ),
      replayCalls: await running.engine.evaluate(
        () => ((window as any).api?.__calls ?? []) as string[],
      ),
    }),
    async close(dir, launch) {
      // A close that fails is the one its log has to explain
      try {
        await running.close();
      } finally {
        for (const [name, ext] of [
          ["facts", "json"],
          ["tauri", "log"],
        ]) {
          const file = path.join(running.runDir, `${name}.${ext}`);
          if (fs.existsSync(file)) {
            fs.copyFileSync(file, path.join(dir, `${name}.${launch}.${ext}`));
          }
        }
      }
      return { faults: [], leaks: [], seam: "" };
    },
  };
}

async function start(
  args: ReturnType<typeof parse>,
  data: string,
  runDir: string,
): Promise<RunningApp> {
  if (args.app === "electron") {
    return electronApp(await startElectron({ data, repo: args.repo, runDir }));
  }
  return tauriApp(
    args,
    await startTauri({
      data,
      electronRepo: args.repo,
      renderer: args.renderer,
      api: args.api,
      goldenDir: args.golden,
      runDir,
    }),
  );
}

/** The app for a client state, reaching the fake client the way each app finds one. */
async function startClientApp(
  args: ReturnType<typeof parse>,
  launch: ClientLaunch,
): Promise<RunningApp> {
  const { data, runDir, viewport } = launch;
  if (args.app === "electron") {
    const running = await startElectron({
      data,
      repo: args.repo,
      runDir,
      viewport,
      seamEnv: electronClientEnv(launch),
    });
    if (launch.hold) await running.page.context().addInitScript(HOLD_CONNECTING_SCRIPT);
    return electronApp(running);
  }
  return tauriApp(
    args,
    await startTauri({
      data,
      electronRepo: args.repo,
      renderer: args.renderer,
      api: args.api,
      goldenDir: args.golden,
      runDir,
      viewport,
      env: tauriClientEnv(launch),
      init: launch.hold ? HOLD_CONNECTING_SCRIPT : undefined,
    }),
  );
}

/**
 * Where the gate's worst tile sits. diff.ts counts the most differing pixels in any 64 CSS px
 * window, sliding, which pixelmatch reports without a position, so this finds the window with
 * the most red marks in the diff image, the same pixels pixelmatch counted.
 */
export function locateWorstWindow(diff: PNG, scale: number) {
  const { width: w, height: h } = diff;
  const n = Math.min(Math.round(CROSS_ENGINE.tileCss * scale), w, h);
  const sums = new Uint32Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (diff.data[i] === 255 && diff.data[i + 1] === 0 && diff.data[i + 2] === 0) row++;
      sums[(y + 1) * (w + 1) + x + 1] = sums[y * (w + 1) + x + 1]! + row;
    }
  }
  const at = (x: number, y: number) => sums[y * (w + 1) + x]!;
  let best = { x: 0, y: 0, differing: 0 };
  for (let y = 0; y + n <= h; y++) {
    for (let x = 0; x + n <= w; x++) {
      const count = at(x + n, y + n) - at(x + n, y) - at(x, y + n) + at(x, y);
      if (count > best.differing) best = { x, y, differing: count };
    }
  }
  return { xCss: best.x / scale, yCss: best.y / scale, differing: best.differing };
}

/** The innermost element box under a CSS px point, to name what a failing tile shows. */
export function elementAt(rows: GeometryRow[], x: number, y: number) {
  let best: GeometryRow | undefined;
  for (const row of rows) {
    const [, , rx, ry, w, h] = row;
    if (x >= rx && x < rx + w && y >= ry && y < ry + h) {
      if (!best || row[0].length >= best[0].length) best = row;
    }
  }
  return best && { path: best[0], tag: best[1], box: best.slice(2) };
}

/**
 * Calls Electron's renderer makes only on Windows, for the window controls it draws there. The
 * per-state call lists were recorded on macOS, where it draws none, so on Windows the channel's
 * `default` golden ("fresh window") answers them, and the replay names that answer unlisted.
 */
export const WINDOWS_RENDERER_CALLS = ["isWindowMaximized"];

/** The replay misses that fail a state: any its row does not declare, but for the above. */
export function unexpectedMisses(
  misses: string[],
  declared: string[] = [],
  platform: NodeJS.Platform = process.platform,
): string[] {
  return misses.filter((miss) => {
    const [, kind, method] = miss.match(/^(\w+): (\w+)\(/) ?? [];
    if (declared.includes(method ?? "")) return false;
    return !(
      platform === "win32" &&
      kind === "unlisted" &&
      WINDOWS_RENDERER_CALLS.includes(method!)
    );
  });
}

export type Cause = "capture" | "size" | "replay-data" | "layout" | "page-budget" | "tile";

/**
 * The first gate a cross-engine result failed. A state the goldens did not fully answer drew
 * other data, so its failure says nothing about the engine.
 */
export function causeOf(result: DiffResult, replayMisses: string[] = []): Cause | undefined {
  if (result.pass) return undefined;
  if (replayMisses.length > 0) return "replay-data";
  if (result.reasons.some((r) => r.startsWith("image sizes differ"))) return "size";
  if (result.layout && !result.layout.pass) return "layout";
  if (result.reasons.some((r) => r.startsWith("page budget"))) return "page-budget";
  return "tile";
}

export function compareBaselines(electronDir: string, tauriDir: string, ids: string[]) {
  const out = path.join(tauriDir, "cross-engine");
  fs.mkdirSync(out, { recursive: true });
  const scale = 2;
  const metaOf = (dir: string, id: string): Record<string, any> => {
    const file = path.join(dir, `${id}.meta.json`);
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  };
  const states = ids.map((id) => {
    const a = path.join(electronDir, `${id}.png`);
    const b = path.join(tauriDir, `${id}.png`);
    const electronMeta = metaOf(electronDir, id);
    const tauriMeta = metaOf(tauriDir, id);
    const replayMisses: string[] = tauriMeta.replayMisses ?? [];
    if (!fs.existsSync(a) || !fs.existsSync(b)) {
      return { id, pass: false, cause: "capture" as Cause, reasons: ["missing capture"] };
    }
    const blurRegions: BlurRegion[] = [
      ...(electronMeta.blurRegions ?? []),
      ...(tauriMeta.blurRegions ?? []),
    ];
    const focus: [FocusMeta | null, FocusMeta | null] = [
      electronMeta.focused ?? null,
      tauriMeta.focused ?? null,
    ];
    const geometry: [string, string] = [
      path.join(electronDir, `${id}.geometry.json`),
      path.join(tauriDir, `${id}.geometry.json`),
    ];
    const result = diffFiles(a, b, {
      policy: "cross-engine",
      geometry,
      scale,
      blurRegions,
      focus,
      outPrefix: path.join(out, id),
    });
    const at = result.diffImage ? locateWorstWindow(result.diffImage, scale) : undefined;
    const half = CROSS_ENGINE.tileCss / 2;
    const under = at && elementAt(readGeometry(geometry[0]), at.xCss + half, at.yCss + half);
    const { diffImage: _image, worstTile, ...numbers } = result;
    return {
      id,
      ...numbers,
      cause: causeOf(result, replayMisses),
      replayMisses,
      worstTile: worstTile && {
        ...worstTile,
        at: at && { xCss: at.xCss, yCss: at.yCss, located: at.differing },
        under,
      },
    };
  });
  const byCause: Record<string, string[]> = {};
  for (const state of states) if (state.cause) (byCause[state.cause] ??= []).push(state.id);
  const report = {
    policy: CROSS_ENGINE,
    electron: electronDir,
    tauri: tauriDir,
    passed: states.filter((s) => s.pass).length,
    total: states.length,
    byCause,
    states,
  };
  fs.writeFileSync(
    path.join(tauriDir, "cross-engine-report.json"),
    JSON.stringify(report, null, 1),
  );
  return report;
}

async function main() {
  const args = parse(process.argv.slice(2));
  if (!["electron", "tauri"].includes(args.app) || (!args.all && !args.states)) {
    console.error(
      `usage: bun parity/capture.ts --app <electron|tauri> [--renderer electron|solid] --data <fixture|snapshot|folder> (--all [--with-client] | --states <ids or groups>) [--out <folder>] [--golden <dir>] [--compare <electron baseline folder>]\ngroups: ${stateGroups().join(", ")}`,
    );
    process.exit(2);
  }
  const states = selectStates(args.all ? "all" : args.states).filter(
    (state) => !(args.all && !args.withClient && state.client),
  );
  const dir = path.resolve(args.dir ?? baselineDir(args.app));
  refuseRealFolder(dir, "capture folder");
  takeCaptureLock();
  fs.mkdirSync(dir, { recursive: true });
  const dataLabel = isDataSource(args.data) ? args.data : "folder";
  const startedAt = Date.now();

  let launches = 0;
  let data = args.data;
  const launch = () =>
    start(
      args,
      data,
      path.join(dir, "..", ".run", `${path.basename(dir)}-${process.pid}-${launches++}`),
    );
  const timings: Timing[] = [];
  const seamLogs: string[] = [];
  const allFaults: string[] = [];
  const leaks: string[] = [];
  let failures = 0;

  const finish = async (session: RunningApp, seen: number) => {
    const report = await session.close(dir, seamLogs.length);
    seamLogs.push(report.seam);
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

  let running: RunningApp | undefined;
  let vars: Record<string, string> = {};
  let seenFaults = 0;
  const closeShared = async () => {
    if (running) await finish(running, seenFaults);
    running = undefined;
  };
  const relaunch = async () => {
    await closeShared();
    await waitForNoGame();
    running = await launch();
    seenFaults = 0;
    vars = await resolveVars(running.ctx.engine);
  };
  try {
    for (const state of states) {
      let session: RunningApp;
      let clientRun: ClientCapture<RunningApp, ClosedApp> | undefined;
      let sessionVars = vars;
      let clientSeen = 0;
      const record: Timing = { id: state.id, ms: 0, settleMs: 0, settleTimedOut: false, ok: true };
      const t0 = Date.now();
      if (state.client) {
        await closeShared();
        await waitForNoGame();
        try {
          clientRun = await openClientState(state as StateRow, {
            data: args.data,
            dir,
            start: (launch) => startClientApp(args, launch),
          });
        } catch (error) {
          record.ok = false;
          record.error = String(error);
          failures++;
          record.ms = Date.now() - t0;
          timings.push(record);
          console.log(`FAIL ${state.id} ${record.ms} ms ${record.error}`);
          continue;
        }
        const run = clientRun;
        session = { ...run.app, close: (to, launch) => run.finish(to, launch) };
      } else {
        if (running && gameRunning()) {
          console.log("a League game started, closing the window and waiting");
          await relaunch();
        }
        if (running && (state.data ?? args.data) !== data) {
          data = state.data ?? args.data;
          await relaunch();
        }
        if (!running) {
          data = state.data ?? args.data;
          await relaunch();
        }
        session = running!;
        sessionVars = vars;
      }
      try {
        let outcome: StateOutcome;
        if (clientRun) {
          const driven = await clientRun.drive();
          outcome = driven.outcome;
          sessionVars = driven.vars;
          if (driven.connectMs != null) record.connectMs = driven.connectMs;
        } else {
          const reference = { warmEveryPatch: args.app === "electron" };
          outcome = await applyState(session.ctx, state as StateRow, sessionVars, reference);
          // Electron 1.2.1's card draws ids for a lookup that misses its 3 s grace, as T05 found
          // recording. Only the Electron reference retries, so a Tauri card that does it fails
          for (
            let attempt = 1;
            args.app === "electron" && outcome.placeholders.length > 0 && attempt < CARD_ATTEMPTS;
            attempt++
          ) {
            console.log(
              `retry ${state.id} ${attempt}: the card drew ids for missing lookups: ${outcome.placeholders.join(", ")}`,
            );
            record.retries = attempt;
            outcome = await applyState(session.ctx, state as StateRow, sessionVars, reference);
          }
        }
        record.settleMs = outcome.settle.ms;
        record.settleTimedOut = outcome.settle.timedOut;
        const faults = session.faults();
        const seen = clientRun ? clientSeen : seenFaults;
        if (faults.length > seen) {
          const fresh = faults.slice(seen);
          if (clientRun) clientSeen = faults.length;
          else seenFaults = faults.length;
          throw new Error(`main process fault: ${fresh.join(" | ").slice(0, 400)}`);
        }
        if (outcome.settle.timedOut) {
          throw new Error(`the page never settled: ${outcome.settle.stuckOn}`);
        }
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
          console.log(
            `warn ${state.id}: ${outcome.settle.decodeFailures} images did not decode, as ${outcome.settle.failedImages.join(" ")}`,
          );
        }
        fs.writeFileSync(
          path.join(dir, `${state.id}.geometry.json`),
          await dumpGeometry(session.ctx.engine),
        );
        // WebKit snapshots draw no backdrop blur (Appendix A), so every element that asks for
        // one is a blur region, judged by the 0.2 threshold tile rule. A dialog panel inside
        // one draws no blur itself, so the page count keeps it
        const blurRegions = await session.ctx.engine.evaluate(() => {
          const clip = (el: Element) => {
            const box = el.getBoundingClientRect();
            const x = Math.max(0, box.left);
            const y = Math.max(0, box.top);
            const w = Math.min(innerWidth, box.right) - x;
            const h = Math.min(innerHeight, box.bottom) - y;
            return w > 0 && h > 0 ? [{ x, y, w, h }] : [];
          };
          return [...document.querySelectorAll("body *")].flatMap((el) => {
            const style = getComputedStyle(el);
            const filter =
              style.getPropertyValue("backdrop-filter") ||
              style.getPropertyValue("-webkit-backdrop-filter");
            if (!filter || filter === "none") return [];
            const keep = [...el.querySelectorAll('[role="dialog"]')].flatMap(clip);
            return clip(el).map((region) => ({ ...region, keep }));
          });
        });
        // Register rule F: the focused element, and whether this window can draw its ring
        const focused = await session.ctx.engine.evaluate((): FocusMeta | null => {
          const el = document.activeElement;
          if (!el || el === document.body || el === document.documentElement) return null;
          let at = "";
          for (let node: Element = el; node !== document.body; node = node.parentElement!) {
            if (!node.parentElement) return null;
            at = `/${[...node.parentElement.children].indexOf(node)}${at}`;
          }
          const box = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return {
            path: `b${at}`,
            box: { x: box.left, y: box.top, w: box.width, h: box.height },
            outline:
              style.outlineStyle === "none"
                ? null
                : {
                    width: parseFloat(style.outlineWidth) || 0,
                    offset: parseFloat(style.outlineOffset) || 0,
                  },
            focusVisible: el.matches(":focus-visible"),
            focusMatches: el.matches(":focus"),
            documentHasFocus: document.hasFocus(),
          };
        });
        await session.ctx.engine.screenshot(path.join(dir, `${state.id}.png`), {
          fullPage: state.card === true,
        });
        const meta = await session.meta();
        fs.writeFileSync(
          path.join(dir, `${state.id}.meta.json`),
          JSON.stringify(
            {
              route: state.route,
              vars: sessionVars,
              viewport: state.viewport,
              data: state.data ?? dataLabel,
              card: outcome.card,
              settle: outcome.settle,
              blurRegions,
              focused,
              ...meta,
            },
            null,
            1,
          ),
        );
        const misses = unexpectedMisses((meta.replayMisses ?? []) as string[], state.replayMisses);
        if (misses.length > 0) {
          throw new Error(`the goldens did not answer: ${misses.join(" | ").slice(0, 400)}`);
        }
        if (state.card) {
          const tall = fs.readFileSync(path.join(dir, `${state.id}.png`)).readUInt32BE(20) / 2;
          // The card publishes Math.ceil of a fractional height, the page a rounded one.
          if (Math.abs(tall - outcome.card!.height) > 1) {
            throw new Error(
              `card image is ${tall} CSS px tall, the card is ${outcome.card!.height}`,
            );
          }
        }
      } catch (error) {
        record.ok = false;
        record.error = String(error);
        failures++;
      }
      record.ms = Date.now() - t0;
      if (clientRun) await finish(session, clientSeen);
      timings.push(record);
      console.log(
        `${record.ok ? "ok  " : "FAIL"} ${state.id} ${record.ms} ms${record.connectMs != null ? ` connect ${record.connectMs} ms` : ""}${record.error ? ` ${record.error}` : ""}`,
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
    app: args.app,
    gpu: args.app === "electron" ? gpuSwitch() : undefined,
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

  if (args.compare) {
    const report = compareBaselines(
      path.resolve(args.compare),
      dir,
      timings.map((t) => t.id),
    );
    const causes = Object.entries(report.byCause).map(
      ([cause, ids]) => `${cause}: ${ids.join(", ")}`,
    );
    console.log(`cross-engine: ${report.passed}/${report.total} pass. ${causes.join("; ")}`);
  }
  process.exit(failures ? 1 : 0);
}

if (import.meta.main) await main();
