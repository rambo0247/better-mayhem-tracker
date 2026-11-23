// Shared by the bun tools and by seam.cjs inside Electron, so there is one definition of
// "the installed app's data folder" and one way to decide a path is inside it.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const APP_FOLDER_NAMES = ["better-mayhem-tracker", "Better Mayhem Tracker"];

function realDataRoots(platform = process.platform, env = process.env, home = os.homedir()) {
  const bases = [];
  if (platform === "darwin") bases.push(path.join(home, "Library", "Application Support"));
  else if (platform === "win32") bases.push(env.APPDATA || path.join(home, "AppData", "Roaming"));
  else bases.push(env.XDG_CONFIG_HOME || path.join(home, ".config"));
  return bases.flatMap((base) => APP_FOLDER_NAMES.map((name) => path.join(base, name)));
}

const fold = (p) => path.resolve(p).toLowerCase();

function lexicallyUnder(candidate, root) {
  const c = fold(candidate);
  const r = fold(root);
  return c === r || c.startsWith(r + path.sep);
}

const readLink = (p) => {
  try {
    return fs.readlinkSync(p);
  } catch {
    return null;
  }
};

/**
 * Resolves the nearest existing ancestor, so a path not created yet is judged by where it would
 * land. A dangling symlink is followed by hand, because realpath refuses it and a write creates
 * its target. The hop limit is above the kernel's own, so a chain the kernel would follow is.
 */
function resolveThroughSymlinks(target, hops = 0) {
  let dir = path.resolve(target);
  const tail = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(dir), ...tail.reverse());
    } catch {
      const link = hops < 64 ? readLink(dir) : null;
      if (link !== null) {
        return resolveThroughSymlinks(
          path.resolve(path.dirname(dir), link, ...tail.reverse()),
          hops + 1,
        );
      }
      const parent = path.dirname(dir);
      if (parent === dir) return path.resolve(target);
      tail.push(path.basename(dir));
      dir = parent;
    }
  }
}

/** True when the path, or where its symlinks lead, is inside any root, or the root's own real location. */
function isUnderRealFolder(target, roots = realDataRoots()) {
  if (roots.some((root) => lexicallyUnder(target, root))) return true;
  const resolved = resolveThroughSymlinks(target);
  return roots.some(
    (root) =>
      lexicallyUnder(resolved, root) || lexicallyUnder(resolved, resolveThroughSymlinks(root)),
  );
}

/** Every parity write goes through this before it creates or opens anything. */
function refuseRealFolder(target, what, roots = realDataRoots()) {
  if (isUnderRealFolder(target, roots)) {
    throw new Error(`${what} refused: ${target} is inside the app's real data folder`);
  }
}

module.exports = {
  APP_FOLDER_NAMES,
  realDataRoots,
  isUnderRealFolder,
  refuseRealFolder,
  resolveThroughSymlinks,
};
