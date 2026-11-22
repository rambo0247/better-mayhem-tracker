import { app, shell } from "electron";
import fs from "fs";
import path from "path";
import { APP_DISPLAY_NAME } from "./install-location";

// Windows groups taskbar entries and attributes notifications by this id, and
// only substitutes a pinned shortcut for the running exe when the shortcut
// carries the same one — so the app and the shortcut below must agree.
export const APP_USER_MODEL_ID = "com.better-mayhem-tracker.app";

// The portable build runs from a temp copy that its launcher extracts on start
// and deletes on exit, so pinning the running window would pin a path that no
// longer exists by the time it is clicked. Windows resolves a pin against the
// Start Menu shortcut carrying the same AppUserModelID when there is one, so
// keeping this shortcut current is what makes the pin point at the real exe.
export function ensureStartMenuShortcut() {
  if (process.platform !== "win32") return;
  const exe = process.env.PORTABLE_EXECUTABLE_FILE;
  if (!exe) {
    // Expected in dev; in a packaged build it means the app wasn't started
    // through the portable launcher, so there is no durable exe to point at
    if (app.isPackaged)
      console.log("Not launched as the portable exe; skipping Start Menu shortcut");
    return;
  }

  const link = path.join(
    app.getPath("appData"),
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    `${APP_DISPLAY_NAME}.lnk`,
  );

  try {
    const existing = shell.readShortcutLink(link);
    if (existing.target === exe && existing.appUserModelId === APP_USER_MODEL_ID) return;
  } catch {
    // No shortcut yet, or it is unreadable — either way it gets written below.
  }

  try {
    // A fresh profile may not have its Programs folder yet, and the shortcut
    // can't be written into a folder that isn't there
    fs.mkdirSync(path.dirname(link), { recursive: true });
    // Reports failure by returning false rather than throwing
    const written = shell.writeShortcutLink(link, "create", {
      target: exe,
      cwd: path.dirname(exe),
      description: APP_DISPLAY_NAME,
      appUserModelId: APP_USER_MODEL_ID,
    });
    if (written) console.log(`Wrote Start Menu shortcut at ${link}`);
    else console.error(`Failed to write Start Menu shortcut at ${link}`);
  } catch (err) {
    // A missing shortcut only costs pinning, so it is never worth failing startup.
    console.error("Failed to write Start Menu shortcut:", err);
  }
}
