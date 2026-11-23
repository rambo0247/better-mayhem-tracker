import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { copyData, freshRunDir, rowIsNewestGame, sandboxed, type PreparedData } from "./app.ts";

/**
 * WebKit keeps `~/Library/WebKit/<bundle id>` under the real home whatever HOME says, so the
 * binary under test must not carry the player's id. `tauri-perf.conf.json` sets this one.
 */
export const PERF_BUNDLE_ID = "com.better-mayhem-tracker.perf";
export const PRODUCTION_BUNDLE_ID = "com.better-mayhem-tracker.app";
export const PERF_CONFIG = path.join(import.meta.dir, "tauri-perf.conf.json");
const DATA_FOLDER = "better-mayhem-tracker";
const MADE_MARKER = ".bmt-perf-made";

/**
 * A release build compiles no data-root override (T09), so it opens the folder the OS
 * reports. A lane build, any other Cargo profile, honors `BMT_DATA_ROOT`.
 */
export type TauriProfile = "release" | "lane";

export class RefusedRun extends Error {}

/**
 * Where the build will open its data, and what moves it there. On macOS `dirs::config_dir`
 * is `$HOME/Library/Application Support` (dirs 7.0.0 through dirs-sys 0.5.0's `home_dir`,
 * which reads HOME first), so HOME points the release build at the run folder. On Windows
 * the folder comes from `SHGetKnownFolderPath`, which nothing in the environment moves, so a
 * release build opens the system's own folder and only a CI runner may run it.
 */
export interface TauriPlacement {
  dataRoot: string;
  env: Record<string, string>;
  /** The OS's own data folder, which only a CI runner lets this tool write. */
  systemFolder: boolean;
}

export function tauriPlacement(
  platform: NodeJS.Platform,
  profile: TauriProfile,
  runDir: string,
  roamingAppData: () => string = windowsRoamingAppData,
): TauriPlacement {
  const userData = path.join(runDir, "userdata");
  if (platform === "darwin") {
    const home = path.join(runDir, "home");
    return profile === "lane"
      ? { dataRoot: userData, env: { HOME: home, BMT_DATA_ROOT: userData }, systemFolder: false }
      : {
          dataRoot: path.join(home, "Library", "Application Support", DATA_FOLDER),
          env: { HOME: home },
          systemFolder: false,
        };
  }
  return profile === "lane"
    ? { dataRoot: userData, env: { BMT_DATA_ROOT: userData }, systemFolder: false }
    : { dataRoot: path.join(roamingAppData(), DATA_FOLDER), env: {}, systemFolder: true };
}

function windowsRoamingAppData(): string {
  const out = spawnSync(
    "powershell",
    ["-NoProfile", "-Command", "[Environment]::GetFolderPath('ApplicationData')"],
    { encoding: "utf8" },
  );
  const folder = out.stdout.trim();
  if (out.status !== 0 || !folder) throw new Error(`no roaming AppData folder: ${out.stderr}`);
  return folder;
}

export function onCiRunner(env: NodeJS.ProcessEnv): boolean {
  return env.CI === "true" && env.GITHUB_ACTIONS === "true";
}

/** Throws when a Tauri run could reach the operator's data or cannot prove what it opened. */
export function refuseTauriRun(options: {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  isolation: string;
  data: string;
}) {
  if (options.data === "none") {
    throw new RefusedRun("a Tauri run needs data, so it can prove it opened the copy");
  }
  if (options.platform === "darwin") {
    if (options.isolation !== "sandbox") {
      throw new RefusedRun(
        "--isolation none is refused for Tauri: the Seatbelt profile is the backstop that keeps the app out of the real data folder",
      );
    }
    return;
  }
  if (options.platform === "win32") {
    if (onCiRunner(options.env)) return;
    throw new RefusedRun(
      "Tauri perf on Windows runs only on a CI runner (CI and GITHUB_ACTIONS set to true): a release build finds its data folder with SHGetKnownFolderPath, which no environment variable moves",
    );
  }
  throw new RefusedRun(`Tauri perf does not run on ${options.platform}`);
}

/** The id in the bundle's Info.plist, which must be the perf id. */
export function checkPerfBundle(appPath: string): string {
  const plist = path.join(appPath, "Contents", "Info.plist");
  const out = spawnSync("plutil", ["-extract", "CFBundleIdentifier", "raw", plist], {
    encoding: "utf8",
  });
  const id = out.stdout.trim();
  if (out.status !== 0 || !id) throw new RefusedRun(`no CFBundleIdentifier in ${plist}`);
  if (id !== PERF_BUNDLE_ID) {
    throw new RefusedRun(
      `${appPath} carries ${id === PRODUCTION_BUNDLE_ID ? "the production bundle id" : "the bundle id"} ${id}, and WebKit would write under ~/Library/WebKit/${id}. Build it with \`tauri build --config ${PERF_CONFIG}\` so it carries ${PERF_BUNDLE_ID}`,
    );
  }
  return id;
}

export function bundleExecutable(appPath: string): string {
  const dir = path.join(appPath, "Contents", "MacOS");
  const [name] = fs.readdirSync(dir);
  if (!name) throw new Error(`${dir} is empty`);
  return path.join(dir, name);
}

/**
 * The command that starts the build under test: on macOS the bundle's executable, after the
 * bundle-id check, under the Seatbelt profile. `app` is the .app on macOS and the exe on
 * Windows.
 */
export function tauriCommand(
  app: string,
  runDir: string,
  args: string[],
): { command: string; args: string[]; executable: string } {
  if (process.platform !== "darwin") return { command: app, args, executable: app };
  checkPerfBundle(app);
  const executable = bundleExecutable(app);
  return { ...sandboxed(executable, args, path.join(runDir, "seatbelt.sb")), executable };
}

/**
 * Empties the run folder and copies the data to where the build will look. The system
 * folder is cleared only when this tool made it, so a folder that holds a player's data
 * stops the run instead.
 */
export function prepareTauriData(
  placement: TauriPlacement,
  data: string,
  runDir: string,
): PreparedData {
  freshRunDir(runDir);
  const root = placement.dataRoot;
  if (placement.systemFolder && fs.existsSync(root)) {
    if (!fs.existsSync(path.join(root, MADE_MARKER))) {
      throw new RefusedRun(`${root} holds data this tool did not make, so it is left alone`);
    }
    fs.rmSync(root, { recursive: true });
  }
  fs.mkdirSync(root, { recursive: true });
  if (placement.systemFolder) fs.writeFileSync(path.join(root, MADE_MARKER), "");
  return copyData(data, root);
}

/** Why the run cannot show it opened the fixture copy, or null when it can. */
export function fixtureProof(
  logText: string | null,
  rowText: string | null,
  newest: PreparedData["newest"],
): string | null {
  if (!logText) return "no log in the prepared data folder, so the app opened some other folder";
  if (rowText === null)
    return "the first-content line carries no row= text, so the row is unproven";
  if (!rowIsNewestGame(rowText, newest)) return "the first row is not the fixture's newest game";
  return null;
}

export const tauriLogFile = (placement: TauriPlacement) =>
  path.join(placement.dataRoot, "logs", "main.log");
