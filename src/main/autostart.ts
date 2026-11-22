import { app } from "electron";
import fs from "fs";
import os from "os";
import path from "path";
import { getSetting, setSetting } from "./db";
import { hasDurableInstall, macAppBundle, portableExe } from "./install-location";

// Auto-start exists so the poller keeps recording games, not so a window lands
// in front of whatever the user signed in to do, so the login item always asks
// for the tray. Forwarded through the portable launcher, which passes its own
// command line on to the extracted exe.
export const HIDDEN_FLAG = "--hidden";

// macOS login items can't carry arguments, so the hidden launch would be lost.
// A per-user LaunchAgent can, and launchd starts it at every sign-in.
const LAUNCH_AGENT_LABEL = "com.better-mayhem-tracker.app.autostart";

function launchAgentPath(): string {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`);
}

function xmlEscape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// What gets registered: the portable exe on Windows, the executable inside the
// app bundle on macOS. Null in dev and in any run with no durable copy.
function registeredTarget(): string | null {
  const exe = portableExe();
  if (exe) return exe;
  const bundle = macAppBundle();
  if (bundle) return path.join(bundle, "Contents", "MacOS", path.basename(process.execPath));
  return null;
}

// False in dev and in any unpackaged run: there is no durable exe to register.
export function isAutoStartSupported(): boolean {
  return hasDurableInstall();
}

function writeLoginItem(enabled: boolean, target: string): void {
  if (process.platform === "darwin") {
    const file = launchAgentPath();
    if (!enabled) {
      fs.rmSync(file, { force: true });
      return;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0">',
        "<dict>",
        "  <key>Label</key>",
        `  <string>${LAUNCH_AGENT_LABEL}</string>`,
        "  <key>ProgramArguments</key>",
        "  <array>",
        `    <string>${xmlEscape(target)}</string>`,
        `    <string>${HIDDEN_FLAG}</string>`,
        "  </array>",
        "  <key>RunAtLoad</key>",
        "  <true/>",
        "</dict>",
        "</plist>",
        "",
      ].join("\n"),
    );
    return;
  }

  app.setLoginItemSettings({
    openAtLogin: enabled,
    path: target,
    args: [HIDDEN_FLAG],
    // Pinned rather than left to default to the AppUserModelId, so the value
    // name can't shift with the order startup happens to call things in.
    name: app.getName(),
  });
}

export function applyAutoStart(enabled: boolean): void {
  const target = registeredTarget();
  if (!target) return;

  // The login item is derived state: `auto_start` holds the user's answer and
  // `auto_start_path` records the target last registered, so a launch can tell
  // whether the entry still points at where the program lives now.
  const registered = getSetting("auto_start_path");
  // Deliberately narrow. On Windows setLoginItemSettings also resets the
  // startup-approved key, so rewriting an entry that is already correct would
  // silently undo a user who switched the app off in Task Manager's Startup tab.
  if (enabled ? registered === target : !registered) return;

  try {
    writeLoginItem(enabled, target);
    setSetting("auto_start_path", enabled ? target : "");
  } catch (err) {
    // Costs auto-start, never the launch. The recorded path stays stale, so the
    // next start tries again.
    console.error("Failed to update the login item:", err);
  }
}

// A portable exe or an app bundle gets moved and renamed, which leaves the
// registered path pointing at nothing. Re-registering on each launch keeps it
// current.
export function syncAutoStart(): void {
  applyAutoStart(getSetting("auto_start") === "true");
}
