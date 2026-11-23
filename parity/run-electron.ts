import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { _electron, type ElectronApplication, type Page } from "playwright";
import { dumpGeometry, runStep, type DriveContext, type Step } from "./drive.ts";
import { PARITY_DIR, REPO_DIR, resolveDataRoot } from "./lib/data.ts";
import { realDataRoots, refuseRealFolder } from "./lib/real-folder.ts";
import { settle } from "./settle.ts";

export const FIXED_TIME = new Date("2026-11-22T21:00:00-05:00");
export const DEFAULT_VIEWPORT = { width: 1280, height: 800 };
export const TIME_ZONE = "America/New_York";

const require = createRequire(import.meta.url);

export interface RunningElectron {
  app: ElectronApplication;
  page: Page;
  runDir: string;
  seamLog: string;
  userData: string;
  blockedRequests: string[];
  ctx: DriveContext;
  close(): Promise<void>;
}

export interface StartOptions {
  data: string;
  runDir?: string;
  repo?: string;
  viewport?: { width: number; height: number };
}

function copyTree(from: string, to: string) {
  if (fs.existsSync(from)) fs.cpSync(from, to, { recursive: true });
}

/** Builds the run folder: the built app, the data, and a stub package.json that renames the app. */
export function prepareRun(options: { data: string; runDir: string; repo: string }) {
  const { runDir, repo } = options;
  refuseRealFolder(runDir, "run folder");
  const dataRoot = resolveDataRoot(options.data);
  fs.rmSync(runDir, { recursive: true, force: true });
  fs.mkdirSync(runDir, { recursive: true });

  const built = path.join(repo, "out");
  if (!fs.existsSync(path.join(built, "main", "index.js"))) {
    throw new Error(`${built} has no build. Run \`npm run build\` in ${repo}.`);
  }
  copyTree(built, path.join(runDir, "out"));
  copyTree(path.join(repo, "assets"), path.join(runDir, "assets"));
  fs.symlinkSync(path.join(repo, "node_modules"), path.join(runDir, "node_modules"), "junction");

  const pkg = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")) as {
    version: string;
    main: string;
  };
  fs.writeFileSync(
    path.join(runDir, "package.json"),
    JSON.stringify({ name: "bmt-parity-electron", version: pkg.version, main: pkg.main }),
  );

  copyTree(path.join(dataRoot, "data"), path.join(runDir, "data"));
  copyTree(path.join(dataRoot, "asset-cache"), path.join(runDir, "asset-cache"));
  copyTree(path.join(dataRoot, "backups"), path.join(runDir, "backups"));
  fs.mkdirSync(path.join(runDir, "userdata"));
  fs.mkdirSync(path.join(runDir, "logs"), { recursive: true });

  const db = path.join(runDir, "data", "matches.db");
  execFileSync("sqlite3", [
    db,
    `UPDATE settings SET value='${pkg.version}' WHERE key='last_run_version'`,
  ]);
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

export async function startElectron(options: StartOptions): Promise<RunningElectron> {
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
  prepareRun({ data: options.data, runDir, repo });

  const seamLog = path.join(runDir, "seam.log");
  const userData = path.join(runDir, "userdata");
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    SEAM_LOG: seamLog,
    SEAM_FIXED_TIME: String(FIXED_TIME.getTime()),
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
      "--lang=en-US",
      `--user-data-dir=${userData}`,
      "-r",
      path.join(PARITY_DIR, "seam.cjs"),
      runDir,
    ],
    env,
    cwd: runDir,
  });

  const facts = await app.evaluate(({ app: electron }) => ({
    userData: electron.getPath("userData"),
    packaged: electron.isPackaged,
    name: electron.getName(),
  }));
  if (!fs.realpathSync(facts.userData).startsWith(fs.realpathSync(runDir))) {
    await app.close().catch(() => {});
    throw new Error(`userData escaped the run folder: ${facts.userData}`);
  }
  refuseRealFolder(facts.userData, "Electron userData");

  const context = app.context();
  const blockedRequests: string[] = [];
  await context.route(/^https?:/, (route) => {
    blockedRequests.push(route.request().url());
    return route.abort();
  });
  await context.clock.setFixedTime(FIXED_TIME);

  const resizeWindow = async (width: number, height: number) => {
    await app.evaluate(
      ({ BrowserWindow }, size) => {
        const window = BrowserWindow.getAllWindows()[0]!;
        window.setPosition(40, 40);
        window.setContentSize(size.width, size.height);
      },
      { width, height },
    );
  };

  const page = await app.firstWindow();
  await resizeWindow(viewport.width, viewport.height);
  await page.reload();
  await page.waitForLoadState("load");

  const ctx: DriveContext = { page, viewport, resizeWindow, touchedSettings: new Map() };
  return {
    app,
    page,
    runDir,
    seamLog,
    userData,
    blockedRequests,
    ctx,
    async close() {
      fs.writeFileSync(
        path.join(runDir, "blocked-renderer.json"),
        JSON.stringify(blockedRequests, null, 1),
      );
      await app.evaluate(({ app: electron }) => electron.exit(0)).catch(() => {});
      await app.close().catch(() => {});
    },
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const value = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
  const data = value("--data");
  if (!data) {
    console.error(
      "usage: bun parity/run-electron.ts --data <fixture|snapshot|folder> [--state <id>] [--out <run folder>] [--repo <checkout>]",
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
    viewport: state?.viewport,
  });
  if (state) {
    const vars = await resolveVars(running.page);
    await applyState(running.ctx, state, vars);
  } else {
    await settle(running.page, running.ctx.viewport);
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
