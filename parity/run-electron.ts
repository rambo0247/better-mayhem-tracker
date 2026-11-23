import { Database } from "bun:sqlite";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { _electron, type ElectronApplication, type Page } from "playwright";
import { dumpGeometry, runStep, type DriveContext, type Step } from "./drive.ts";
import { PARITY_DIR, REPO_DIR, resolveDataRoot } from "./lib/data.ts";
import { waitForNoGame } from "./lib/no-game.ts";
import { realDataRoots, refuseRealFolder } from "./lib/real-folder.ts";
import { resolveThroughSymlinks } from "./lib/real-folder.cjs";
import { settle } from "./settle.ts";

export const FIXED_TIME = new Date("2026-11-22T21:00:00-05:00");
export const DEFAULT_VIEWPORT = { width: 1280, height: 820 };
export const TIME_ZONE = "America/New_York";

const require = createRequire(import.meta.url);

export interface RunningElectron {
  app: ElectronApplication;
  page: Page;
  runDir: string;
  seamLog: string;
  blockedRequests: string[];
  ctx: DriveContext;
  /** Seam faults logged so far: uncaught errors, stubbed error dialogs. */
  faults(): string[];
  close(): Promise<RunReport>;
}

export interface RunReport {
  faults: string[];
  /** Files that appeared or changed outside the run folder during the run. */
  leaks: string[];
  /** How the app ended. "graceful-timed-out" is a graceful quit that fell back to exit. */
  quit: "exit" | "graceful" | "graceful-timed-out";
}

export interface StartOptions {
  data: string;
  runDir?: string;
  repo?: string;
  viewport?: { width: number; height: number };
  /**
   * How close() ends the app. "exit" calls app.exit(0), which skips before-quit and so the final
   * fetch. "graceful" calls app.quit(), as the tray's Quit does, and falls back to "exit" if the
   * process is still running after quitTimeoutMs.
   */
  quit?: "exit" | "graceful";
  quitTimeoutMs?: number;
  /** Extra environment for the seam, such as SEAM_FAKE_DIR. */
  seamEnv?: Record<string, string>;
}

export function readFaults(seamLog: string): string[] {
  if (!fs.existsSync(seamLog)) return [];
  return fs
    .readFileSync(seamLog, "utf8")
    .split(/\n(?=\S)/)
    .filter((entry) => entry.startsWith("fault "));
}

function copyTree(from: string, to: string) {
  if (fs.existsSync(from)) fs.cpSync(from, to, { recursive: true, dereference: true });
}

export const RUN_MARKER = ".bmt-parity-run";

const isInside = (child: string, parent: string) =>
  child === parent || child.startsWith(parent + path.sep);

/**
 * The app finds its data folder from where its own script really lives, so a symlink
 * anywhere in the run folder would move data/, backups/, logs/ and asset-cache/ to the
 * link's target. Refuses a run folder, or an out/ above it, that is a link or resolves
 * elsewhere.
 */
export function assertRunFolderPinned(runDir: string) {
  const parityOut = path.join(PARITY_DIR, "out");
  if (
    isInside(path.resolve(runDir), parityOut) &&
    fs.lstatSync(parityOut, { throwIfNoEntry: false })?.isSymbolicLink()
  ) {
    throw new Error(`${parityOut} is a symlink. Captures would write beside its target.`);
  }
  const parent = fs.realpathSync(path.dirname(runDir));
  const expected = path.join(parent, path.basename(runDir));
  if (fs.realpathSync(runDir) !== expected) {
    throw new Error(`run folder ${runDir} resolves to ${fs.realpathSync(runDir)}, not ${expected}`);
  }
}

/** After the build is copied in: nothing in the run folder may resolve outside it, bar node_modules. */
export function assertNoEscapingLinks(runDir: string) {
  const root = fs.realpathSync(runDir);
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (full === path.join(runDir, "node_modules")) continue;
      if (fs.realpathSync(full) !== path.join(fs.realpathSync(dir), entry.name)) {
        throw new Error(`${full} resolves to ${fs.realpathSync(full)}, outside the run folder`);
      }
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(runDir);
  if (!isInside(fs.realpathSync(path.join(runDir, "out", "main", "index.js")), root)) {
    throw new Error("the app's script resolves outside the run folder");
  }
}

/** Everything git or the app's data folders could show changed in the checkout, bar parity/out. */
export function checkoutStamp(repo: string): Map<string, string> {
  const stamp = new Map<string, string>();
  const status = spawnSync(
    "git",
    [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "--ignored=traditional",
      "--",
      ".",
      ":(exclude)parity/out",
    ],
    { cwd: repo, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 },
  );
  if (status.error || status.status !== 0) {
    throw new Error(
      `git status failed in ${repo}: ${status.error?.message ?? `exit ${status.status}`} ${status.stderr}`,
    );
  }
  for (const line of status.stdout.split("\n").filter(Boolean)) stamp.set(`git ${line}`, "");
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const info = fs.lstatSync(full);
        stamp.set(full, `${info.size}:${info.mtimeMs}`);
      }
    }
  };
  for (const name of ["data", "backups", "logs", "asset-cache", "userdata"]) {
    const dir = path.join(repo, name);
    if (fs.existsSync(dir)) walk(dir);
  }
  return stamp;
}

export function stampDiff(before: Map<string, string>, after: Map<string, string>): string[] {
  const changed: string[] = [];
  for (const [key, value] of after)
    if (before.get(key) !== value) changed.push(`added or changed ${key}`);
  for (const key of before.keys()) if (!after.has(key)) changed.push(`removed ${key}`);
  return changed;
}

export function prepareRun(options: { data: string; runDir: string; repo: string }) {
  const { runDir, repo } = options;
  refuseRealFolder(runDir, "run folder");
  // The app creates its own database in an empty data folder, as on a fresh install.
  const empty = options.data === "empty";
  const dataRoot = empty ? undefined : resolveDataRoot(options.data);
  if (dataRoot && isInside(fs.realpathSync(dataRoot), resolveThroughSymlinks(runDir))) {
    throw new Error(`run folder ${runDir} contains the data folder ${dataRoot}`);
  }
  const marker = path.join(runDir, RUN_MARKER);
  if (fs.existsSync(runDir) && fs.readdirSync(runDir).length > 0 && !fs.existsSync(marker)) {
    throw new Error(
      `${runDir} is not empty and was not made by a parity run, refusing to clear it`,
    );
  }
  fs.rmSync(runDir, { recursive: true, force: true });
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(marker, "bmt parity run folder\n");
  assertRunFolderPinned(runDir);

  const built = path.join(repo, "out");
  if (!fs.existsSync(path.join(built, "main", "index.js"))) {
    throw new Error(`${built} has no build. Run \`npm run build\` in ${repo}.`);
  }
  copyTree(built, path.join(runDir, "out"));
  copyTree(path.join(repo, "assets"), path.join(runDir, "assets"));
  fs.symlinkSync(
    fs.realpathSync(path.join(repo, "node_modules")),
    path.join(runDir, "node_modules"),
    "junction",
  );

  const pkg = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")) as {
    version: string;
    main: string;
  };
  fs.writeFileSync(
    path.join(runDir, "package.json"),
    JSON.stringify({ name: "bmt-parity-electron", version: pkg.version, main: pkg.main }),
  );

  fs.mkdirSync(path.join(runDir, "userdata"));
  fs.mkdirSync(path.join(runDir, "logs"), { recursive: true });
  if (!dataRoot) {
    fs.mkdirSync(path.join(runDir, "data"));
    assertNoEscapingLinks(runDir);
    return { dataRoot, version: pkg.version };
  }
  copyTree(path.join(dataRoot, "data"), path.join(runDir, "data"));
  copyTree(path.join(dataRoot, "asset-cache"), path.join(runDir, "asset-cache"));
  copyTree(path.join(dataRoot, "backups"), path.join(runDir, "backups"));

  const db = path.join(runDir, "data", "matches.db");
  const database = new Database(db);
  if (options.data === "fixture") {
    const row = database
      .query("SELECT value FROM settings WHERE key = 'last_run_version'")
      .get() as { value: string } | undefined;
    if (row?.value !== pkg.version) {
      database.close();
      throw new Error(
        `the fixture is frozen at ${row?.value} and the app is ${pkg.version}. Rebuild the fixture, or the first run shows the what's-new dialog.`,
      );
    }
  } else {
    database.run("UPDATE settings SET value = ? WHERE key = 'last_run_version'", [pkg.version]);
  }
  database.close();
  assertNoEscapingLinks(runDir);
  return { dataRoot, version: pkg.version };
}

function electronBinary(repo: string): string {
  const binary = require(path.join(repo, "node_modules", "electron")) as string;
  if (!fs.existsSync(binary)) {
    throw new Error(
      `Electron is not downloaded. Run \`node node_modules/electron/install.js\` in ${repo}.`,
    );
  }
  return binary;
}

/** A window behind others still paints and runs its timers, so a screenshot always gets a frame. */
export const KEEP_PAINTING = [
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--disable-background-timer-throttling",
];

/**
 * Chromium re-rasterizes only the rectangle an invalidation touched, so the antialiasing of an
 * icon's edge depends on which invalidations came first. Six reloads of one state gave five
 * different screenshots; with this flag they gave one.
 */
export const PARTIAL_RASTER_OFF = "--disable-partial-raster";

/** GPU compositing is off unless PARITY_GPU=on: GPU frames repeat less between runs (waiver W1). */
export function gpuSwitch(value = process.env.PARITY_GPU): "on" | "off" {
  if (value === undefined || value === "" || value === "off") return "off";
  if (value === "on") return "on";
  throw new Error(`PARITY_GPU is "${value}"; use on or off`);
}

/** Teardown steps may fail because the app is already gone, which is worth a line and not a crash. */
async function teardown(step: string, work: Promise<unknown>) {
  await work.catch((error) => console.error(`run-electron: ${step} failed: ${String(error)}`));
}

async function exitApp(app: ElectronApplication) {
  // exit(0) alone destroys a visible window without a close event, and macOS then emits
  // hide on the dead wrapper, where Electron's own visibilityChanged listener throws.
  await teardown(
    "destroying windows",
    app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().forEach((w) => {
        w.removeAllListeners();
        w.destroy();
      }),
    ),
  );
  await teardown(
    "exit",
    app.evaluate(({ app: electron }) => electron.exit(0)),
  );
  await teardown("close", app.close());
}

async function quit(
  app: ElectronApplication,
  mode: "exit" | "graceful",
  timeoutMs: number,
): Promise<RunReport["quit"]> {
  if (mode === "exit") {
    await exitApp(app);
    return "exit";
  }
  let exited = false;
  const gone = new Promise<boolean>((resolve) =>
    app.process().once("exit", () => {
      exited = true;
      resolve(true);
    }),
  );
  await app
    .evaluate(({ app: electron }) => electron.quit())
    .catch((error) => {
      if (!exited) console.error(`run-electron: quit failed: ${String(error)}`);
    });
  const finished = await Promise.race([
    gone,
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
  if (finished) {
    await teardown("close", app.close());
    return "graceful";
  }
  console.error(
    `run-electron: the app was still running ${timeoutMs} ms after quit(), so it exits`,
  );
  await exitApp(app);
  return "graceful-timed-out";
}

export async function startElectron(options: StartOptions): Promise<RunningElectron> {
  await waitForNoGame();
  const repo = options.repo ?? REPO_DIR;
  const viewport = options.viewport ?? DEFAULT_VIEWPORT;
  const runDir = path.resolve(
    options.runDir ??
      path.join(
        PARITY_DIR,
        "out",
        "runs",
        `${Date.now()}-${crypto.randomBytes(3).toString("hex")}`,
      ),
  );
  const before = checkoutStamp(repo);
  prepareRun({ data: options.data, runDir, repo });

  const seamLog = path.join(runDir, "seam.log");
  const userData = path.join(runDir, "userdata");
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...options.seamEnv,
    SEAM_LOG: seamLog,
    SEAM_RUN_DIR: runDir,
    SEAM_FIXED_TIME: String(FIXED_TIME.getTime()),
    SEAM_FORK_DEPTH: "0",
    SEAM_LIVE_PORT: "2999",
    SEAM_REAL_ROOTS: JSON.stringify(realDataRoots()),
    TZ: TIME_ZONE,
    LANG: "en_US.UTF-8",
  };
  delete env.ELECTRON_RENDERER_URL;
  delete env.NODE_OPTIONS;

  const app = await _electron.launch({
    executablePath: electronBinary(repo),
    args: [
      "--force-device-scale-factor=2",
      "--force-color-profile=srgb",
      PARTIAL_RASTER_OFF,
      ...(gpuSwitch() === "on" ? [] : ["--disable-gpu"]),
      ...(process.env.PARITY_BACKGROUNDING === "on" ? [] : KEEP_PAINTING),
      "--lang=en-US",
      ...(process.env.PARITY_ELECTRON_ARGS?.split(" ").filter(Boolean) ?? []),
      `--user-data-dir=${userData}`,
      "-r",
      path.join(PARITY_DIR, "seam.cjs"),
      runDir,
    ],
    env,
    cwd: runDir,
  });

  const blockedRequests: string[] = [];
  let page: Page;
  let resizeWindow: (width: number, height: number) => Promise<void>;
  try {
    const reportedUserData = await app.evaluate(({ app: electron }) =>
      electron.getPath("userData"),
    );
    if (!isInside(fs.realpathSync(reportedUserData), fs.realpathSync(runDir))) {
      throw new Error(`userData escaped the run folder: ${reportedUserData}`);
    }
    refuseRealFolder(reportedUserData, "Electron userData");

    const context = app.context();
    await context.route(/^https?:/, (route) => {
      blockedRequests.push(route.request().url());
      return route.abort();
    });
    await context.clock.setFixedTime(FIXED_TIME);

    resizeWindow = async (width: number, height: number) => {
      await app.evaluate(
        ({ BrowserWindow }, size) => {
          const window = BrowserWindow.getAllWindows()[0]!;
          window.setPosition(40, 40);
          // On a Windows display scaled other than the forced device scale (125% against 2),
          // the content comes out a DIP narrower than asked, and the page with it. Steer by the
          // content size Electron reports, which is what the page sees. A clamp to the screen
          // stays as it was.
          let ask = [size.width, size.height] as [number, number];
          for (let attempt = 0; attempt < 3; attempt++) {
            window.setContentSize(ask[0], ask[1]);
            const [width, height] = window.getContentSize() as [number, number];
            if (width === size.width && height === size.height) break;
            ask = [ask[0] + size.width - width, ask[1] + size.height - height];
          }
        },
        { width, height },
      );
    };

    page = await app.firstWindow();
    await resizeWindow(viewport.width, viewport.height);
    await page.reload();
    await page.waitForLoadState("load");
  } catch (error) {
    await exitApp(app);
    throw error;
  }

  const ctx: DriveContext = { page, viewport, resizeWindow, touchedSettings: new Map() };
  const faults = () => readFaults(seamLog);
  return {
    app,
    page,
    runDir,
    seamLog,
    blockedRequests,
    ctx,
    faults,
    async close() {
      fs.writeFileSync(
        path.join(runDir, "blocked-renderer.json"),
        JSON.stringify(blockedRequests, null, 1),
      );
      const ended = await quit(app, options.quit ?? "exit", options.quitTimeoutMs ?? 20_000);
      return { faults: faults(), leaks: stampDiff(before, checkoutStamp(repo)), quit: ended };
    },
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const value = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
  const data = value("--data");
  if (!data) {
    console.error(
      "usage: bun parity/run-electron.ts --data <fixture|snapshot|empty|folder> [--state <id>] [--out <run folder>] [--repo <checkout>] [--fake <fake-lcu folder>]",
    );
    process.exit(2);
  }
  const { STATES, applyState, resolveVars } = await import("./states.ts");
  const stateId = value("--state");
  const state = stateId ? STATES.find((s) => s.id === stateId) : undefined;
  if (stateId && !state) {
    console.error(`unknown state ${stateId}. Known: ${STATES.map((s) => s.id).join(", ")}`);
    process.exit(2);
  }
  const running = await startElectron({
    data,
    runDir: value("--out"),
    repo: value("--repo"),
    seamEnv: value("--fake") ? { SEAM_FAKE_DIR: path.resolve(value("--fake")!) } : undefined,
    viewport: state?.viewport,
    quit: value("--quit") === "graceful" ? "graceful" : undefined,
  });
  try {
    if (state) await applyState(running.ctx, state, await resolveVars(running.page));
    else await settle(running.page, running.ctx.viewport);
  } catch (error) {
    await running.close();
    throw error;
  }

  const token = crypto.randomBytes(16).toString("hex");
  const shutdown = async () => {
    await running.close();
    process.exit(0);
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.headers.get("authorization") !== `Bearer ${token}`) {
        return new Response("refused", { status: 401 });
      }
      const body = (await request.json()) as Step & { op: string; path?: string };
      try {
        if (body.op === "quit") {
          setTimeout(shutdown, 50);
          return new Response("bye");
        }
        if (body.op === "shot") {
          const file = body.path ?? path.join(running.runDir, "shot.png");
          refuseRealFolder(file, "screenshot path");
          await running.page.screenshot({ path: file, animations: "disabled", caret: "hide" });
          return new Response(file);
        }
        if (body.op === "dom") return new Response(await running.page.content());
        if (body.op === "geometry") return new Response(await dumpGeometry(running.page));
        await runStep(running.ctx, body as Step);
        return new Response("ok");
      } catch (error) {
        return new Response(String(error), { status: 500 });
      }
    },
  });
  fs.writeFileSync(
    path.join(running.runDir, "control.json"),
    JSON.stringify({ port: server.port, token }),
  );
  console.log(`ready run=${running.runDir} control=127.0.0.1:${server.port}`);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
