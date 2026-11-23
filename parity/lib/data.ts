import fs from "node:fs";
import path from "node:path";
import { refuseRealFolder } from "./real-folder.ts";

export const PARITY_DIR = path.resolve(import.meta.dir, "..");
export const REPO_DIR = path.resolve(PARITY_DIR, "..");
export const SNAPSHOT_DIRS = {
  fixture: path.join(PARITY_DIR, "snapshots", "fixture"),
  snapshot: path.join(PARITY_DIR, "snapshots", "private"),
} as const;

export type DataSource = keyof typeof SNAPSHOT_DIRS;
export const isDataSource = (value: string): value is DataSource => value in SNAPSHOT_DIRS;

/** A data root holds `data/matches.db` and optionally `asset-cache/` and `backups/`. */
export function resolveDataRoot(spec: string): string {
  const root = path.resolve(isDataSource(spec) ? SNAPSHOT_DIRS[spec] : spec);
  refuseRealFolder(root, "data folder");
  if (fs.existsSync(path.join(root, "matches.db"))) return path.dirname(root);
  if (!fs.existsSync(path.join(root, "data", "matches.db"))) {
    const hint = isDataSource(spec)
      ? spec === "fixture"
        ? "Run `bun parity/fixture.ts --out parity/snapshots/fixture`, or download the fixture artifact."
        : "Run `bun parity/snapshot.ts --out parity/snapshots/private`."
      : "Point --data at a folder from snapshot.ts or fixture.ts.";
    throw new Error(`no data/matches.db under ${root}. ${hint}`);
  }
  return root;
}

/**
 * Copies a data tree, refusing any symlink in it. A link carried into a run folder could
 * point the app at the real data folder, and following it would read the target instead.
 */
export function copyDataTree(from: string, to: string) {
  if (!fs.existsSync(from)) return;
  fs.cpSync(from, to, {
    recursive: true,
    filter: (source) => {
      if (fs.lstatSync(source).isSymbolicLink()) {
        throw new Error(`${source} is a symlink. Data copied into a run folder may hold none.`);
      }
      return true;
    },
  });
}
