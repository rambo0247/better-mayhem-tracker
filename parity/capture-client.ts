import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import { runStep, type DriveContext, type Engine } from "./drive.ts";
import { startFakeLcu, type FakeLcu } from "./fake-lcu.ts";
import { loadContext } from "./fake-lcu/context.ts";
import { resolveDataRoot } from "./lib/data.ts";
import { FIXED_TIME } from "./run-electron.ts";
import { settle } from "./settle.ts";
import {
  applyState,
  resolveVars,
  type StateOutcome,
  type StateRow,
  type Viewport,
} from "./states.ts";
import type { ClientLabel } from "./states-client.ts";

const STATUS_TIMEOUT_MS = 45_000;
const GAME_TIMEOUT_MS = 90_000;

export interface ClientDrive {
  outcome: StateOutcome;
  vars: Record<string, string>;
  /** Milliseconds from the app's start to it reading "Connected" or "In Game". */
  connectMs: number | null;
}

/** The pieces a test replaces to fail one of them. */
export interface ClientDeps {
  startFakeLcu: typeof startFakeLcu;
  loadContext: typeof loadContext;
  resolveVars: typeof resolveVars;
  applyState: typeof applyState;
  settle: typeof settle;
}

const REAL_DEPS: ClientDeps = {
  startFakeLcu,
  loadContext,
  resolveVars,
  applyState,
  settle,
};

/** What a client state's app is started with: its data, and the fake client it reaches. */
export interface ClientLaunch {
  data: string;
  runDir: string;
  viewport: Viewport;
  /** The fake's folder, which holds its lockfile folder, CA and discovery file once it runs. */
  fakeDir: string;
  /** The fake client, or null for a state with no client. */
  fake: FakeLcu | null;
  /** Keep the status on "Connecting..." by holding the connect loop's first tick. */
  hold: boolean;
}

/** The app a client state drives, closed with the folder its logs go to and its launch number. */
export interface ClientApp<R> {
  ctx: DriveContext;
  close(dir: string, launch: number): Promise<R>;
}

/** Tells settle.ts that "Connecting..." is the state, not a load still running. */
export const HOLD_CONNECTING_SCRIPT = "window.__paritySkipConnecting = true;";

/** Electron finds the fake through its seam, which hides every other League path. */
export const electronClientEnv = (launch: ClientLaunch): Record<string, string> => ({
  SEAM_FAKE_DIR: launch.fakeDir,
  ...(launch.hold ? { SEAM_HOLD_CONNECT: "1" } : {}),
});

/**
 * A parity build finds the client only where these name (T19's discovery, T20's match-history
 * service, T21's in-game API, and the fake's CA through the parity-ca feature). With no fake
 * they name nothing, so the app finds no client.
 */
export function tauriClientEnv(launch: ClientLaunch): Record<string, string> {
  const env: Record<string, string> = launch.hold ? { BMT_PARITY_HOLD_CONNECT: "1" } : {};
  const fake = launch.fake;
  if (!fake) return env;
  if (fake.livePort === 2999) throw new Error("the fake live client took port 2999");
  return {
    ...env,
    BMT_PARITY_LEAGUE_DIR: fake.lockfileDir,
    BMT_PARITY_CA: path.join(fake.dir, "ca.pem"),
    BMT_PARITY_LIVE_PORT: String(fake.livePort),
    BMT_PARITY_SGP_URL: fake.sgpUrl,
  };
}

export interface ClientCapture<A extends ClientApp<R>, R> {
  app: A;
  /** Brings the app into the state. Throws when the client never gets there. */
  drive(): Promise<ClientDrive>;
  /** Stops the client and the app, and keeps the fake's requests beside the baseline. */
  finish(dir: string, launch: number): Promise<R>;
}

const statusLabel = (label: ClientLabel) => `League client: ${label}`;

async function poll<A>(
  engine: Engine,
  test: (arg: A) => boolean,
  arg: A,
  timeout: number,
  what: string,
) {
  const deadline = Date.now() + timeout;
  while (!(await engine.evaluate(test, arg))) {
    if (Date.now() > deadline) throw new Error(`${what} not within ${timeout} ms`);
    await Bun.sleep(50);
  }
}

const waitForLabel = (engine: Engine, label: ClientLabel, timeout = STATUS_TIMEOUT_MS) =>
  poll(
    engine,
    (want) =>
      document
        .querySelector('[role="status"][aria-label^="League client:"]')
        ?.getAttribute("aria-label") === want,
    statusLabel(label),
    timeout,
    `the status reading "${statusLabel(label)}"`,
  );

async function waitForAttached(engine: Engine, selector: string, timeout: number) {
  const deadline = Date.now() + timeout;
  while ((await engine.count(selector)) === 0) {
    if (Date.now() > deadline) throw new Error(`${selector} not on the page within ${timeout} ms`);
    await Bun.sleep(50);
  }
}

/** The fixture's own data with every game and account removed, for the "no games" states. */
function emptyDataRoot(source: string, into: string): string {
  const root = path.join(into, "data");
  fs.mkdirSync(root, { recursive: true });
  const database = path.join(root, "matches.db");
  fs.copyFileSync(path.join(source, "data", "matches.db"), database);
  const db = new Database(database);
  try {
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[];
    for (const { name } of tables) {
      if (name !== "settings") db.run(`DELETE FROM "${name}"`);
    }
    db.run("DELETE FROM settings WHERE key LIKE 'backfill_complete_%'");
  } finally {
    db.close();
  }
  return into;
}

async function waitForNewestGame(engine: Engine, gameId: number) {
  const deadline = Date.now() + GAME_TIMEOUT_MS;
  for (;;) {
    const newest = await engine.evaluate(async () => {
      const api = window.api as unknown as Record<string, (...args: unknown[]) => Promise<any>>;
      return (await api.getMatchHistory!(1, 0)).matches[0]?.game_id as number | undefined;
    });
    if (newest === gameId) return;
    if (Date.now() > deadline) throw new Error(`game ${gameId} never became the newest game`);
    await Bun.sleep(250);
  }
}

/**
 * Starts a fake client in the state a row describes, then the app `start` launches against it.
 * Each state gets an app of its own, because the connect loop, the socket, and the database
 * all carry what the client did before. The fake runs first because a Tauri build reads where
 * the client is once, at launch.
 */
export async function openClientState<A extends ClientApp<R>, R>(
  state: StateRow,
  options: {
    data: string;
    dir: string;
    start: (launch: ClientLaunch) => Promise<A>;
    deps?: Partial<ClientDeps>;
  },
): Promise<ClientCapture<A, R>> {
  const deps = { ...REAL_DEPS, ...options.deps };
  const spec = state.client!;
  const sourceRoot = resolveDataRoot(options.data);
  const work = path.join(options.dir, "..", ".run", `${state.id}-${process.pid}`);
  fs.rmSync(work, { recursive: true, force: true });
  const fakeDir = `${work}-fake`;
  fs.rmSync(fakeDir, { recursive: true, force: true });
  fs.mkdirSync(fakeDir, { recursive: true });

  const cleanUp = () => {
    fs.rmSync(fakeDir, { recursive: true, force: true });
    if (spec.empty) fs.rmSync(`${work}-empty`, { recursive: true, force: true });
  };

  let fake: FakeLcu | null = null;
  let app: A;
  try {
    const data = spec.empty ? emptyDataRoot(sourceRoot, `${work}-empty`) : options.data;
    if (spec.scenario) {
      const context = deps.loadContext(sourceRoot, spec.options ?? {}, FIXED_TIME.getTime());
      fake = await deps.startFakeLcu({ scenario: spec.scenario, context, dir: fakeDir });
    }
    app = await options.start({
      data,
      runDir: work,
      viewport: state.viewport,
      fakeDir,
      fake,
      hold: spec.hold === true,
    });
  } catch (error) {
    try {
      await fake?.stop();
    } catch (stopError) {
      throw new AggregateError([error, stopError], "the app and the fake client both failed", {
        cause: stopError,
      });
    } finally {
      cleanUp();
    }
    throw error;
  }
  const startedAt = Date.now();
  const { engine } = app.ctx;

  let stopping: Promise<void> | null = null;
  const stopFake = () => (stopping ??= fake ? fake.stop() : Promise.resolve());

  const finish = async (dir: string, launch: number) => {
    const errors: unknown[] = [];
    const attempt = async <T>(step: () => Promise<T> | T): Promise<T | undefined> => {
      try {
        return await step();
      } catch (error) {
        errors.push(error);
        return undefined;
      }
    };
    await attempt(stopFake);
    const report = await attempt(() => app.close(dir, launch));
    if (fake) {
      const stopped = fake;
      await attempt(() =>
        fs.writeFileSync(
          path.join(dir, `${state.id}.fake-requests.json`),
          JSON.stringify(
            { scenario: stopped.scenario.name, requests: stopped.requests, sent: stopped.sent },
            null,
            1,
          ),
        ),
      );
    }
    await attempt(cleanUp);
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "closing the client state failed");
    return report!;
  };

  const drive = async (): Promise<ClientDrive> => {
    await waitForLabel(engine, spec.ready);
    const connectMs = spec.scenario ? Date.now() - startedAt : null;
    const vars = await deps.resolveVars(engine);

    await deps.applyState(app.ctx, { ...state, steps: undefined }, vars);

    if (fake && spec.play) {
      await fake.subscribed;
      fake.play();
      await fake.finished;
      if (spec.after) await waitForLabel(engine, spec.after);
      if (spec.awaitGame) await waitForNewestGame(engine, fake.scenario.games[0]!.id);
    }
    if (fake && spec.releaseImport) fake.releaseSgp();
    if (fake && spec.stopClient) {
      await stopFake();
      await waitForLabel(engine, "Disconnected");
    }

    await waitForAttached(engine, state.expect, 30_000);
    for (const step of state.steps ?? []) await runStep(app.ctx, step, vars);
    const report = await deps.settle(engine, app.ctx.viewport);
    const expectFound = (await engine.count(state.expect)) > 0;
    return {
      outcome: { settle: report, expectFound, placeholders: [] },
      vars,
      connectMs,
    };
  };

  return { app, drive, finish };
}
