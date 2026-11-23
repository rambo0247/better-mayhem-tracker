// Runs Electron 1.2.1's own src/main/autostart.ts with HOME in a scratch
// folder and records what it writes, for tauri/src-tauri/src/autostart.rs to
// match. The LaunchAgent comes from autostart.ts's own fs calls. The Windows
// side stops at app.setLoginItemSettings, whose arguments are recorded; the
// registry write behind it is Electron's C++ and runs only on Windows.
//
//   bun parity/autostart-golden.ts [--out <file>]
//
// It runs itself again as a child with HOME set to a scratch folder, because
// os.homedir() reads HOME only at startup, and the child refuses to load
// autostart.ts unless os.homedir() is that folder.
import { mock } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { REPO_DIR } from "./lib/data.ts";

const BUNDLE = "/Applications/Better Mayhem Tracker.app";
const MOVED_BUNDLE = "/Users/player/Games & <Tools>/Better Mayhem Tracker.app";
const EXE = String.raw`C:\Users\player\Downloads\BetterMayhemTracker.exe`;
const MOVED_EXE = String.raw`D:\Games & Tools\BetterMayhemTracker.exe`;

interface Step {
  name: string;
  call: "sync" | "apply";
  enabled?: boolean;
  /** The bundle on macOS, the exe on Windows; null for a run with no durable copy. */
  install: string | null;
}

const STEPS: { darwin: Step[]; win32: Step[] } = {
  darwin: [
    { name: "launch, never asked", call: "sync", install: BUNDLE },
    { name: "turn on", call: "apply", enabled: true, install: BUNDLE },
    { name: "turn on again", call: "apply", enabled: true, install: BUNDLE },
    { name: "launch, unchanged", call: "sync", install: BUNDLE },
    { name: "launch after a move", call: "sync", install: MOVED_BUNDLE },
    { name: "turn on in a dev run", call: "apply", enabled: true, install: null },
    { name: "turn off", call: "apply", enabled: false, install: MOVED_BUNDLE },
    { name: "turn off again", call: "apply", enabled: false, install: MOVED_BUNDLE },
    { name: "launch, off", call: "sync", install: BUNDLE },
  ],
  win32: [
    { name: "launch, never asked", call: "sync", install: EXE },
    { name: "turn on", call: "apply", enabled: true, install: EXE },
    { name: "turn on again", call: "apply", enabled: true, install: EXE },
    { name: "launch after a move", call: "sync", install: MOVED_EXE },
    { name: "turn off", call: "apply", enabled: false, install: MOVED_EXE },
    { name: "turn off again", call: "apply", enabled: false, install: MOVED_EXE },
  ],
};

const settings = new Map<string, string>();
const loginItemCalls: unknown[] = [];
let platform: NodeJS.Platform = "darwin";
let install: string | null = null;

function mockElectronSide() {
  Object.defineProperty(process, "platform", { get: () => platform });
  void mock.module("electron", () => ({
    app: {
      setLoginItemSettings: (settings: unknown) => loginItemCalls.push(settings),
      // package.json's name: electron-builder keeps productName under build
      getName: () => "better-mayhem-tracker",
    },
  }));
  void mock.module(path.join(REPO_DIR, "src/main/db/index.ts"), () => ({
    getSetting: (key: string) => settings.get(key) ?? null,
    setSetting: (key: string, value: string) => settings.set(key, value),
  }));
  void mock.module(path.join(REPO_DIR, "src/main/install-location.ts"), () => ({
    portableExe: () => (platform === "win32" ? install : null),
    macAppBundle: () => (platform === "darwin" ? install : null),
    hasDurableInstall: () => install !== null,
  }));
}

const CHILD = "BMT_AUTOSTART_GOLDEN_HOME";

async function record() {
  const home = process.env[CHILD];
  if (!home || os.homedir() !== home || !path.basename(home).startsWith("bmt-autostart-home-")) {
    throw new Error(
      `refusing to run autostart.ts: os.homedir() is ${os.homedir()}, not a scratch home`,
    );
  }
  const execPath = process.execPath;
  mockElectronSide();
  const autostart = await import(path.join(REPO_DIR, "src/main/autostart.ts"));
  const plist = path.join(
    home,
    "Library",
    "LaunchAgents",
    "com.better-mayhem-tracker.app.autostart.plist",
  );
  const out: Record<string, unknown[]> = {};
  for (const os_ of ["darwin", "win32"] as const) {
    platform = os_;
    settings.clear();
    fs.rmSync(plist, { force: true });
    out[os_] = STEPS[os_].map((step) => {
      install = step.install;
      if (step.call === "apply") settings.set("auto_start", String(step.enabled));
      Object.defineProperty(process, "execPath", {
        value:
          install && os_ === "darwin"
            ? `${install}/Contents/MacOS/Better Mayhem Tracker`
            : execPath,
        configurable: true,
      });
      loginItemCalls.length = 0;
      if (step.call === "sync") autostart.syncAutoStart();
      else autostart.applyAutoStart(step.enabled);
      return {
        ...step,
        supported: autostart.isAutoStartSupported(),
        autoStart: settings.get("auto_start") ?? null,
        autoStartPath: settings.get("auto_start_path") ?? null,
        ...(os_ === "darwin"
          ? { plist: fs.existsSync(plist) ? fs.readFileSync(plist, "utf8") : null }
          : { setLoginItemSettings: [...loginItemCalls] }),
      };
    });
  }
  return {
    about:
      "Electron 1.2.1's src/main/autostart.ts run by parity/autostart-golden.ts, HOME in a scratch folder",
    ...out,
  };
}

/** The golden, from a child whose HOME is a scratch folder that is removed afterwards. */
export function recordInScratchHome(): unknown {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bmt-autostart-home-"));
  try {
    const child = spawnSync(process.execPath, [import.meta.path, "--child"], {
      env: { ...process.env, HOME: home, [CHILD]: home },
      encoding: "utf8",
    });
    if (child.status !== 0) throw new Error(`recorder failed:\n${child.stderr}`);
    return JSON.parse(child.stdout);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

if (import.meta.main && process.argv.includes("--child")) {
  process.stdout.write(JSON.stringify(await record()));
} else if (import.meta.main) {
  const at = process.argv.indexOf("--out");
  const file =
    at > 0
      ? path.resolve(process.argv[at + 1]!)
      : path.join(REPO_DIR, "tauri/src-tauri/tests/fixtures/electron-autostart.json");
  fs.writeFileSync(file, `${JSON.stringify(recordInScratchHome(), null, 2)}\n`);
  console.log(`wrote ${file}`);
}
