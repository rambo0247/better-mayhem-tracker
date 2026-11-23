import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { realDataRoots, refuseRealFolder } from "./lib/real-folder.ts";

export const SNAPSHOT_MARKER = ".bmt-snapshot";

export interface SnapshotOptions {
  /** The app's data folder. Defaults to the installed app's real folder. */
  source?: string;
  out: string;
  /** Folders the output may never land in. Tests add a temp folder here. */
  realRoots?: string[];
}

export interface SnapshotResult {
  out: string;
  database: string;
  caches: string[];
}

const CACHE_FILES = ["champion-cache.json", "augment-icon-cache.json"];

/**
 * The only code in parity/ that reads the real data folder, and it reads with
 * `sqlite3 -readonly ... .backup` and `cp`. Nothing here opens it for writing.
 */
export function takeSnapshot(options: SnapshotOptions): SnapshotResult {
  const realRoots = options.realRoots ?? realDataRoots();
  const source = options.source ?? realRoots[0]!;
  const out = path.resolve(options.out);
  refuseRealFolder(out, "snapshot output", realRoots);

  const sourceDb = path.join(source, "data", "matches.db");
  if (!fs.existsSync(sourceDb)) throw new Error(`no database at ${sourceDb}`);

  if (fs.existsSync(out) && fs.readdirSync(out).length > 0) {
    if (!fs.existsSync(path.join(out, SNAPSHOT_MARKER))) {
      throw new Error(`${out} exists, is not empty, and is not a snapshot folder`);
    }
    fs.rmSync(out, { recursive: true, force: true });
  }
  fs.mkdirSync(path.join(out, "data"), { recursive: true });
  fs.writeFileSync(path.join(out, SNAPSHOT_MARKER), "snapshot of the app's data folder\n");

  const database = path.join(out, "data", "matches.db");
  const backup = (from: string, readonly: boolean) =>
    execFileSync(
      "sqlite3",
      [...(readonly ? ["-readonly"] : []), from, `.backup '${database.replaceAll("'", "''")}'`],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
  try {
    backup(sourceDb, true);
  } catch (error) {
    // A WAL database that a running app holds can refuse a read-only open. The
    // fallback copies the files with cp and runs .backup on the copy.
    console.error(`readonly backup failed (${String(error).split("\n")[0]}), copying the files`);
    const raw = path.join(out, ".raw");
    fs.mkdirSync(raw);
    for (const suffix of ["", "-wal", "-shm"]) {
      if (fs.existsSync(sourceDb + suffix)) {
        execFileSync("cp", [sourceDb + suffix, path.join(raw, "matches.db" + suffix)]);
      }
    }
    backup(path.join(raw, "matches.db"), false);
    fs.rmSync(raw, { recursive: true, force: true });
  }

  // The copy keeps the app's WAL mode in its header, and a WAL database cannot be
  // opened read-only without its -shm file. Rollback mode lets `sqlite3 -readonly` read it.
  execFileSync("sqlite3", [database, "PRAGMA journal_mode=DELETE"], { stdio: "ignore" });

  const caches: string[] = [];
  for (const name of CACHE_FILES) {
    const from = path.join(source, "data", name);
    if (fs.existsSync(from)) {
      execFileSync("cp", [from, path.join(out, "data", name)]);
      caches.push(`data/${name}`);
    }
  }
  const assets = path.join(source, "asset-cache");
  if (fs.existsSync(assets)) {
    execFileSync("cp", ["-R", assets, path.join(out, "asset-cache")]);
    caches.push("asset-cache/");
  }
  return { out, database, caches };
}

export function hashAppFiles(source: string): Map<string, string> {
  const hashes = new Map<string, string>();
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        hashes.set(
          path.relative(source, full),
          crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex"),
        );
      }
    }
  };
  for (const folder of ["data", "backups", "logs", "asset-cache"]) {
    if (fs.existsSync(path.join(source, folder))) walk(path.join(source, folder));
  }
  return hashes;
}

export function diffHashes(before: Map<string, string>, after: Map<string, string>) {
  return {
    changed: [...before.keys()].filter(
      (file) => after.has(file) && after.get(file) !== before.get(file),
    ),
    removed: [...before.keys()].filter((file) => !after.has(file)),
    added: [...after.keys()].filter((file) => !before.has(file)),
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--out");
  if (at < 0 || !args[at + 1]) {
    console.error("usage: bun parity/snapshot.ts --out <folder>");
    process.exit(2);
  }
  const verifyAt = args.indexOf("--verify");
  const before = verifyAt >= 0 ? hashAppFiles(realDataRoots()[0]!) : undefined;
  const result = takeSnapshot({ out: args[at + 1]! });
  if (before) {
    const { changed, removed, added } = diffHashes(before, hashAppFiles(realDataRoots()[0]!));
    const lines = [
      `files hashed before: ${before.size}`,
      `changed: ${changed.length}`,
      ...changed.map((file) => `  ${file}`),
      `removed: ${removed.length}`,
      ...removed.map((file) => `  ${file}`),
      `added: ${added.length}`,
      ...added.map((file) => `  ${file}`),
    ];
    refuseRealFolder(args[verifyAt + 1]!, "verify log");
    fs.writeFileSync(args[verifyAt + 1]!, lines.join("\n") + "\n");
    console.log(lines.join("\n"));
  }
  console.log(`snapshot ${result.out}`);
  console.log(`  ${result.database}`);
  for (const cache of result.caches) console.log(`  ${cache}`);
}
