import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { runStep } from "./drive.ts";
import { startFakeLcu, type FakeLcu } from "./fake-lcu.ts";
import { loadContext } from "./fake-lcu/context.ts";
import { resolveDataRoot } from "./lib/data.ts";
import { FIXED_TIME, startElectron, type RunReport, type RunningElectron } from "./run-electron.ts";
import { settle } from "./settle.ts";
import { applyState, resolveVars, type StateOutcome, type StateRow } from "./states.ts";
import type { ClientLabel } from "./states-client.ts";

const STATUS_TIMEOUT_MS = 45_000;
const GAME_TIMEOUT_MS = 90_000;

export interface ClientDrive {
  outcome: StateOutcome;
  vars: Record<string, string>;
  /** Milliseconds from the fake client's start to the app reading "Connected" or "In Game". */
  connectMs: number | null;
}

export interface ClientCapture {
  running: RunningElectron;
  /** Brings the app into the state. Throws when the client never gets there. */
  drive(): Promise<ClientDrive>;
  /** Stops the client and the app, and keeps the fake's requests beside the baseline. */
  finish(dir: string): Promise<RunReport>;
}

const statusLabel = (label: ClientLabel) => `League client: ${label}`;

function waitForLabel(page: Page, label: ClientLabel, timeout = STATUS_TIMEOUT_MS) {
  return page.waitForFunction(
    (want) =>
      document
        .querySelector('[role="status"][aria-label^="League client:"]')
        ?.getAttribute("aria-label") === want,
    statusLabel(label),
    { timeout, polling: 50 },
  );
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

async function waitForNewestGame(page: Page, gameId: number) {
  const deadline = Date.now() + GAME_TIMEOUT_MS;
  for (;;) {
    const newest = await page.evaluate(async () => {
      const api = window.api as unknown as Record<string, (...args: unknown[]) => Promise<any>>;
      return (await api.getMatchHistory!(1, 0)).matches[0]?.game_id as number | undefined;
    });
    if (newest === gameId) return;
    if (Date.now() > deadline) throw new Error(`game ${gameId} never became the newest game`);
    await page.waitForTimeout(250);
  }
}

/**
 * Starts the app against a fake client in the state a row describes. Each state gets an app
 * of its own, because the connect loop, the socket, and the database all carry what the
 * client did before.
 */
export async function openClientState(
  state: StateRow,
  options: { data: string; repo?: string; dir: string },
): Promise<ClientCapture> {
  const spec = state.client!;
  const sourceRoot = resolveDataRoot(options.data);
  const work = path.join(options.dir, "..", ".run", `${state.id}-${process.pid}`);
  fs.rmSync(work, { recursive: true, force: true });
  const fakeDir = `${work}-fake`;
  fs.rmSync(fakeDir, { recursive: true, force: true });
  fs.mkdirSync(fakeDir, { recursive: true });

  const data = spec.empty ? emptyDataRoot(sourceRoot, `${work}-empty`) : options.data;
  const running = await startElectron({
    data,
    repo: options.repo,
    runDir: work,
    viewport: state.viewport,
    seamEnv: { SEAM_FAKE_DIR: fakeDir, ...(spec.hold ? { SEAM_HOLD_CONNECT: "1" } : {}) },
  });
  const { page } = running;
  if (spec.hold) {
    await page.context().addInitScript(() => {
      (window as any).__paritySkipConnecting = true;
    });
  }

  let fake: FakeLcu | null = null;
  const startedAt = Date.now();
  if (spec.scenario) {
    const context = loadContext(sourceRoot, spec.options ?? {}, FIXED_TIME.getTime());
    fake = await startFakeLcu({ scenario: spec.scenario, context, dir: fakeDir });
  }

  const finish = async (dir: string) => {
    await fake?.stop();
    const report = await running.close();
    if (fake) {
      fs.writeFileSync(
        path.join(dir, `${state.id}.fake-requests.json`),
        JSON.stringify(
          { scenario: fake.scenario.name, requests: fake.requests, sent: fake.sent },
          null,
          1,
        ),
      );
    }
    fs.rmSync(fakeDir, { recursive: true, force: true });
    if (spec.empty) fs.rmSync(`${work}-empty`, { recursive: true, force: true });
    return report;
  };

  const drive = async (): Promise<ClientDrive> => {
    await waitForLabel(page, spec.ready);
    const connectMs = spec.scenario ? Date.now() - startedAt : null;
    const vars = await resolveVars(page);

    await applyState(running.ctx, { ...state, steps: undefined }, vars);

    if (fake && spec.play) {
      await fake.subscribed;
      fake.play();
      await fake.finished;
      if (spec.after) await waitForLabel(page, spec.after);
      if (spec.awaitGame) await waitForNewestGame(page, fake.scenario.games[0]!.id);
    }
    if (fake && spec.releaseImport) fake.releaseSgp();
    if (fake && spec.stopClient) {
      await fake.stop();
      await waitForLabel(page, "Disconnected");
    }

    await page.locator(state.expect).first().waitFor({ state: "attached", timeout: 30_000 });
    for (const step of state.steps ?? []) await runStep(running.ctx, step, vars);
    const report = await settle(page, running.ctx.viewport);
    const expectFound = (await page.locator(state.expect).count()) > 0;
    return {
      outcome: { settle: report, expectFound, placeholders: [] },
      vars,
      connectMs,
    };
  };

  return { running, drive, finish };
}
