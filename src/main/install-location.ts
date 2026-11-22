import { app } from "electron";
import path from "path";

// app.getName() is package.json's "name" (better-mayhem-tracker), which also
// names the data folder. What the user sees, in the Start Menu and as the exe
// in their folder, goes by these instead. The exe name matches the release
// artifact (build.win.artifactName in package.json).
export const APP_DISPLAY_NAME = "Better Mayhem Tracker";
export const WINDOWS_EXE_NAME = "BetterMayhemTracker.exe";

// Where the copy of the program the user keeps lives: the thing to register at
// sign-in and to replace with a new version. The running process isn't always
// it, so each platform has its own answer, and null means there is no durable
// copy to point at (a dev run, or a copy the OS is running from somewhere
// temporary).

// The portable launcher runs the app from a temp copy it deletes on exit, so
// process.execPath is a path that no longer exists by the next sign-in.
// PORTABLE_EXECUTABLE_FILE is the exe the user actually keeps.
export function portableExe(): string | null {
  if (process.platform !== "win32") return null;
  return process.env.PORTABLE_EXECUTABLE_FILE ?? null;
}

// The .app bundle the running executable sits in. A quarantined app opened
// straight from Downloads or a disk image is run from a randomised read-only
// copy (App Translocation), which is neither stable enough to register nor
// writable enough to update, so it doesn't count.
export function macAppBundle(): string | null {
  if (process.platform !== "darwin" || !app.isPackaged) return null;
  // <bundle>.app/Contents/MacOS/<executable>
  const bundle = path.resolve(process.execPath, "..", "..", "..");
  if (!bundle.endsWith(".app")) return null;
  if (bundle.includes("/AppTranslocation/") || bundle.startsWith("/Volumes/")) return null;
  return bundle;
}

// Whether this run has a durable copy of itself at all
export function hasDurableInstall(): boolean {
  return portableExe() !== null || macAppBundle() !== null;
}
