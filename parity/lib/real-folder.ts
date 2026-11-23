import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const APP_FOLDER_NAMES = ["better-mayhem-tracker", "Better Mayhem Tracker"];

/** Where the installed apps keep their data, on this machine. */
export function realDataRoots(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string[] {
  const bases: string[] = [];
  if (platform === "darwin") bases.push(path.join(home, "Library", "Application Support"));
  else if (platform === "win32") bases.push(env.APPDATA ?? path.join(home, "AppData", "Roaming"));
  else bases.push(env.XDG_CONFIG_HOME ?? path.join(home, ".config"));
  return bases.flatMap((base) => APP_FOLDER_NAMES.map((name) => path.join(base, name)));
}

const fold = (p: string) => path.resolve(p).toLowerCase();

function lexicallyUnder(candidate: string, root: string): boolean {
  const c = fold(candidate);
  const r = fold(root);
  return c === r || c.startsWith(r + path.sep);
}

/**
 * Walks up from `target` to the nearest ancestor that exists and resolves it,
 * so a symlink pointing into a real folder is caught. Only ancestors of the
 * target are touched, and a target already inside a root never gets here.
 */
function resolveThroughSymlinks(target: string): string {
  let dir = path.resolve(target);
  const tail: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync(dir);
      return path.join(real, ...tail.reverse());
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) return path.resolve(target);
      tail.push(path.basename(dir));
      dir = parent;
    }
  }
}

/** The root with its parent resolved, so the root itself is never touched. */
function resolvedRoot(root: string): string {
  return path.join(resolveThroughSymlinks(path.dirname(root)), path.basename(root));
}

export function isUnderRealFolder(target: string, roots: string[] = realDataRoots()): boolean {
  if (roots.some((root) => lexicallyUnder(target, root))) return true;
  const resolved = resolveThroughSymlinks(target);
  return roots.some((root) => lexicallyUnder(resolved, resolvedRoot(root)));
}

export function refuseRealFolder(target: string, what: string, roots: string[] = realDataRoots()) {
  if (isUnderRealFolder(target, roots)) {
    throw new Error(`${what} refused: ${target} is inside the app's real data folder`);
  }
}
