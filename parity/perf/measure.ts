import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { waitForNoGame } from "../lib/no-game.ts";
import { apparentBytes } from "./size.ts";
import {
  freePort,
  pidExists,
  prepareUserData,
  rowIsNewestGame,
  sandboxed,
  spawnApp,
  waitForGone,
  waitForQuietClient,
  type Isolation,
  type RunningApp,
} from "./app.ts";
import {
  measureElectronFirstContent,
  parseTauriLines,
  wallClockMs,
  type ElectronFirstContent,
  type TauriFirstContent,
} from "./first-content.ts";
import {
  attributeElectron,
  attributeWebKit,
  electronRole,
  listProcesses,
  MemoryProbeError,
  median,
  openFileNames,
  readFootprint,
  REQUIRED_ELECTRON_ROLES,
  sumMembers,
  type MemorySample,
  type WebKitContext,
} from "./memory-mac.ts";

export interface RunOptions {
  data: string;
  runDir: string;
  idleSeconds: number;
  samples: number;
  intervalSeconds: number;
  isolation: Isolation;
  selector?: string;
  /** Test hook for the missing-helper proof: kill this role once, after the first sample. */
  killRoleAfterFirstSample?: string;
  log: (line: string) => void;
}

export interface RunResult {
  app: string;
  valid: boolean;
  invalidReason?: string;
  firstContentMs: number | null;
  firstContentKind: string;
  firstContentDetail: ElectronFirstContent | TauriFirstContent | null;
  rowIsNewestGame: boolean | null;
  idleFootprintBytes: number | null;
  idleRssBytes: number | null;
  samples: Array<{ footprintBytes: number; rssBytes: number }>;
  members: Array<{ role: string; pid: number; footprintBytes: number; rssBytes: number }>;
  notes: string[];
  loadAverage: number;
  /** Windows: bytes of the folder the portable exe unpacks into, read while it runs. */
  extractedBytes?: number;
}

const FREEZE_DELAY_MS = 1500;

async function sampleWindows(rootPid: number): Promise<{
  sample: MemorySample;
  roles: Map<number, string>;
  exePaths: string[];
  rootExe: string;
}> {
  const script = path.resolve(import.meta.dir, "memory-win.ps1");
  const out = spawnSync(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-RootPid", String(rootPid)],
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  if (out.status !== 0) throw new MemoryProbeError(`memory-win.ps1: ${out.stderr}`, "unreadable");
  const parsed = JSON.parse(out.stdout) as {
    members: Array<{
      pid: number;
      name: string;
      commandLine: string | null;
      executablePath: string | null;
      privateWorkingSetBytes: number;
      workingSetBytes: number;
    }>;
    missing: number[];
  };
  const members = [parsed.members].flat();
  const roles = new Map<number, string>();
  for (const member of members) {
    const role = member.pid === rootPid ? "main" : electronRole(member.commandLine ?? "", false);
    roles.set(member.pid, role === "child" ? member.name.toLowerCase() : role);
  }
  return {
    sample: {
      footprintBytes: members.reduce((total, m) => total + m.privateWorkingSetBytes, 0),
      rssBytes: members.reduce((total, m) => total + m.workingSetBytes, 0),
      members: members.map((m) => ({
        pid: m.pid,
        role: roles.get(m.pid)!,
        name: m.name,
        footprintBytes: m.privateWorkingSetBytes,
        rssBytes: m.workingSetBytes,
      })),
    },
    roles,
    exePaths: members.map((m) => m.executablePath ?? ""),
    rootExe: members.find((m) => m.pid === rootPid)?.executablePath ?? "",
  };
}

function emptyResult(app: string, load: number): RunResult {
  return {
    app,
    valid: false,
    firstContentMs: null,
    firstContentKind: "",
    firstContentDetail: null,
    rowIsNewestGame: null,
    idleFootprintBytes: null,
    idleRssBytes: null,
    samples: [],
    members: [],
    notes: [],
    loadAverage: load,
  };
}

function launchCommand(
  isolation: Isolation,
  command: string,
  args: string[],
  runDir: string,
  noChromiumSandbox: boolean,
) {
  if (process.platform === "darwin" && isolation === "sandbox") {
    return sandboxed(
      command,
      noChromiumSandbox ? ["--no-sandbox", ...args] : args,
      path.join(runDir, "seatbelt.sb"),
    );
  }
  return { command, args };
}

function killTree(app: RunningApp) {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(app.pid), "/T", "/F"]);
  }
}

async function stopAndConfirm(app: RunningApp, watched: number[], result: RunResult) {
  killTree(app);
  await app.stop();
  const alive = await waitForGone(watched, 15_000);
  if (alive.length > 0) result.notes.push(`pids still alive after quit: ${alive.join(",")}`);
}

/** Runs the packaged Electron app on the data, then idles and samples. */
export async function runElectron(
  options: RunOptions & { executable: string },
): Promise<RunResult> {
  const result = emptyResult("electron-1.2.1", (await import("node:os")).loadavg()[0]!);
  await waitForNoGame(options.log);
  if (options.isolation === "none") await waitForQuietClient(options.log);
  const prepared = prepareUserData({ data: options.data, runDir: options.runDir });
  const port = await freePort();
  const userDataArg = `--user-data-dir=${prepared.userData}`;
  const launch = launchCommand(
    options.isolation,
    options.executable,
    [userDataArg, `--remote-debugging-port=${port}`],
    options.runDir,
    true,
  );
  const app = spawnApp({ ...launch, cwd: options.runDir });
  const watched = new Set<number>([app.pid]);
  try {
    const first = await measureElectronFirstContent({
      port,
      spawnedAtMs: app.spawnedAtMs,
      selector: options.selector,
    });
    result.firstContentDetail = first;
    result.firstContentMs = first.framesMs ?? first.domMs;
    result.firstContentKind = first.framesMs === null ? "row-in-dom" : "row-two-frames";
    if (!options.selector) result.rowIsNewestGame = rowIsNewestGame(first.rowText, prepared.newest);
    if (first.visibility !== "visible")
      result.notes.push(`window ${first.visibility} at first content`);
    if (first.lateAttach) result.notes.push("row existed when the probe attached");
    const firstContentAt = wallClockMs();

    await Bun.sleep(FREEZE_DELAY_MS);
    const frozen = new Map<number, string>();
    const readTree = async () => {
      if (process.platform === "win32") {
        const windows = await sampleWindows(app.pid);
        if (result.extractedBytes === undefined) {
          const unpacked = windows.exePaths.find(
            (exe) =>
              exe && exe !== windows.rootExe && path.dirname(exe) !== path.dirname(windows.rootExe),
          );
          if (unpacked) result.extractedBytes = apparentBytes(path.dirname(unpacked));
        }
        return { sample: windows.sample, roles: windows.roles, strays: 0 };
      }
      const attribution = attributeElectron(listProcesses(), app.pid, prepared.userData);
      if (attribution.missingRoles.length > 0) {
        throw new MemoryProbeError(
          `no ${attribution.missingRoles.join(", ")} process`,
          "missing-helper",
        );
      }
      if (attribution.strays.length > 0) {
        throw new MemoryProbeError(
          `${attribution.strays.length} process(es) carry this run's user-data-dir outside its tree`,
          "stray",
        );
      }
      const pids = attribution.members.map((member) => member.row.pid);
      const sample = sumMembers(
        attribution.members,
        readFootprint(pids),
        new Map(attribution.members.map((m) => [m.row.pid, m.row.rssBytes])),
      );
      return {
        sample,
        roles: new Map(attribution.members.map((member) => [member.row.pid, member.role])),
        strays: attribution.strays.length,
      };
    };

    const first0 = await readTree();
    for (const [pid, role] of first0.roles) {
      watched.add(pid);
      if (["renderer", "gpu", "main", "network"].includes(role)) frozen.set(pid, role);
    }
    if (process.platform === "win32") {
      const have = new Set(first0.roles.values());
      const need = REQUIRED_ELECTRON_ROLES.filter((role) => !have.has(role));
      if (need.length > 0)
        throw new MemoryProbeError(`no ${need.join(", ")} process`, "missing-helper");
    }

    const idleUntil = firstContentAt + options.idleSeconds * 1000;
    await Bun.sleep(Math.max(0, idleUntil - wallClockMs()));
    for (let i = 0; i < options.samples; i++) {
      if (i > 0) await Bun.sleep(options.intervalSeconds * 1000);
      if (app.hasExited()) throw new MemoryProbeError("app exited during idle", "missing-helper");
      const { sample, roles } = await readTree();
      for (const [pid, role] of frozen) {
        if (roles.get(pid) !== role) {
          throw new MemoryProbeError(`${role} helper ${pid} is gone`, "missing-helper");
        }
      }
      for (const pid of roles.keys()) watched.add(pid);
      result.samples.push({ footprintBytes: sample.footprintBytes, rssBytes: sample.rssBytes });
      result.members = sample.members.map(({ role, pid, footprintBytes, rssBytes }) => ({
        role,
        pid,
        footprintBytes,
        rssBytes,
      }));
      if (i === 0 && options.killRoleAfterFirstSample) {
        const victim = [...roles].find(([, role]) => role === options.killRoleAfterFirstSample);
        if (victim) process.kill(victim[0], "SIGKILL");
      }
    }
    finish(result);
  } catch (error) {
    invalidate(result, error);
  } finally {
    await stopAndConfirm(app, [...watched], result);
  }
  return result;
}

function finish(result: RunResult) {
  result.idleFootprintBytes = median(result.samples.map((s) => s.footprintBytes));
  result.idleRssBytes = median(result.samples.map((s) => s.rssBytes));
  result.valid = true;
}

function invalidate(result: RunResult, error: unknown) {
  result.valid = false;
  result.invalidReason = error instanceof Error ? error.message : String(error);
  result.idleFootprintBytes = null;
  result.idleRssBytes = null;
}

function bundleExecutable(appPath: string): string {
  const dir = path.join(appPath, "Contents", "MacOS");
  const [name] = fs.readdirSync(dir);
  if (!name) throw new Error(`${dir} is empty`);
  return path.join(dir, name);
}

function bundleIdentifier(appPath: string): string {
  const out = spawnSync(
    "plutil",
    ["-extract", "CFBundleIdentifier", "raw", path.join(appPath, "Contents", "Info.plist")],
    { encoding: "utf8" },
  );
  return out.stdout.trim();
}

/** Runs a Tauri build. `app` is the .app on macOS and the exe on Windows. */
export async function runTauri(options: RunOptions & { app: string }): Promise<RunResult> {
  const result = emptyResult("tauri", (await import("node:os")).loadavg()[0]!);
  await waitForNoGame(options.log);
  if (options.isolation === "none") await waitForQuietClient(options.log);
  const mac = process.platform === "darwin";
  const executable = mac ? bundleExecutable(options.app) : options.app;
  const prepared = prepareTauriRun(options);
  const perfLog = path.join(options.runDir, "perf.log");
  const before = new Set(listProcessesSafe().map((row) => row.pid));
  const launch = launchCommand(options.isolation, executable, [], options.runDir, false);
  const app = spawnApp({
    ...launch,
    cwd: options.runDir,
    env: { BMT_PERF: "1", BMT_PERF_LOG: perfLog, BMT_DATA_DIR: prepared },
  });
  const watched = new Set<number>([app.pid]);
  try {
    const deadline = app.spawnedAtMs + 30_000;
    let first: TauriFirstContent | null = null;
    let paintSeenAt = 0;
    while (wallClockMs() < deadline) {
      const lines = [
        ...app.lines,
        ...(fs.existsSync(perfLog)
          ? fs
              .readFileSync(perfLog, "utf8")
              .split("\n")
              .map((text) => ({ atMs: fs.statSync(perfLog).mtimeMs, text }))
          : []),
      ];
      first = parseTauriLines(lines, app.spawnedAtMs);
      if (first?.source === "first-content") break;
      if (first && !paintSeenAt) paintSeenAt = wallClockMs();
      if (first && wallClockMs() - paintSeenAt > 2000) break;
      if (app.hasExited())
        throw new MemoryProbeError("app exited before first content", "missing-helper");
      await Bun.sleep(10);
    }
    if (!first) {
      throw new MemoryProbeError(
        "no first-content or first-paint line. A Windows release build has no stdout, so it needs BMT_PERF_LOG",
        "unreadable",
      );
    }
    result.firstContentDetail = first;
    result.firstContentMs = first.arrivedMs;
    result.firstContentKind =
      first.source === "first-content" ? "first-content line" : "first-paint line, no rows";
    const firstContentAt = wallClockMs();
    await Bun.sleep(FREEZE_DELAY_MS);

    const readTree = async (frozenRoles?: Map<number, string>) => {
      if (!mac) {
        const windows = await sampleWindows(app.pid);
        return { sample: windows.sample, notes: [] as string[] };
      }
      const rows = listProcesses();
      if (frozenRoles) {
        const members = [...frozenRoles].flatMap(([pid, role]) => {
          const row = rows.find((candidate) => candidate.pid === pid);
          return row ? [{ row, role }] : [];
        });
        if (members.length < frozenRoles.size) {
          throw new MemoryProbeError("a helper is gone", "missing-helper");
        }
        const reading = readFootprint(members.map((member) => member.row.pid));
        return {
          sample: sumMembers(
            members,
            reading,
            new Map(members.map((m) => [m.row.pid, m.row.rssBytes])),
          ),
          notes: [],
        };
      }
      const context: WebKitContext = {
        rootPid: app.pid,
        before,
        spawnedAtMs: app.spawnedAtMs,
        identityTokens: [
          bundleIdentifier(options.app),
          path.basename(executable),
          path.basename(executable).replace(/-/g, "_"),
        ],
        expectedWebContent: 1,
      };
      const candidatePids = rows
        .filter((row) => !before.has(row.pid) && row.command.includes("/WebKit.framework/"))
        .map((row) => row.pid);
      const attribution = attributeWebKit(rows, context, openFileNames(candidatePids));
      if (attribution.ambiguous) {
        throw new MemoryProbeError(
          `WebKit attribution ambiguous: ${attribution.notes.join("; ")}`,
          "ambiguous",
        );
      }
      const pids = attribution.members.map((member) => member.row.pid);
      const sample = sumMembers(
        attribution.members,
        readFootprint(pids),
        new Map(attribution.members.map((m) => [m.row.pid, m.row.rssBytes])),
      );
      return { sample, notes: attribution.notes };
    };

    const frozenTree = await readTree();
    const frozen = new Map(frozenTree.sample.members.map((member) => [member.pid, member.role]));
    for (const pid of frozen.keys()) watched.add(pid);
    const roles = new Set(frozenTree.sample.members.map((member) => member.role));
    const need = (mac ? ["main", "gpu", "networking", "webcontent"] : ["main"]).filter(
      (r) => !roles.has(r),
    );
    if (need.length > 0)
      throw new MemoryProbeError(`no ${need.join(", ")} process`, "missing-helper");
    result.notes.push(...frozenTree.notes);

    await Bun.sleep(Math.max(0, firstContentAt + options.idleSeconds * 1000 - wallClockMs()));
    for (let i = 0; i < options.samples; i++) {
      if (i > 0) await Bun.sleep(options.intervalSeconds * 1000);
      if (app.hasExited()) throw new MemoryProbeError("app exited during idle", "missing-helper");
      const { sample } = await readTree(mac ? frozen : undefined);
      result.samples.push({ footprintBytes: sample.footprintBytes, rssBytes: sample.rssBytes });
      result.members = sample.members.map(({ role, pid, footprintBytes, rssBytes }) => ({
        role,
        pid,
        footprintBytes,
        rssBytes,
      }));
    }
    finish(result);
  } catch (error) {
    invalidate(result, error);
  } finally {
    await stopAndConfirm(app, [...watched], result);
  }
  return result;
}

function listProcessesSafe() {
  return process.platform === "darwin" ? listProcesses() : [];
}

function prepareTauriRun(options: RunOptions): string {
  try {
    return prepareUserData({ data: options.data, runDir: options.runDir }).userData;
  } catch {
    fs.mkdirSync(options.runDir, { recursive: true });
    return options.runDir;
  }
}

export { pidExists };
