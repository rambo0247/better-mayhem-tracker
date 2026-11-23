import { Database } from "bun:sqlite";
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
  copyAttempts: number;
}

const CACHE_FILES = ["champion-cache.json", "augment-icon-cache.json"];
const DB_FILES = ["matches.db", "matches.db-wal", "matches.db-shm"];
const COPY_ATTEMPTS = 5;

const fileState = (file: string) => {
  if (!fs.existsSync(file)) return "absent";
  const stat = fs.statSync(file, { bigint: true });
  return `${stat.size}:${stat.mtimeNs}`;
};

/**
 * Copies the database files with plain reads until no source file moved during the copy. SQLite
 * never opens anything in the source: even `-readonly` writes the -shm file.
 */
function copyDatabaseFiles(sourceData: string, raw: string): number {
  const states = () => DB_FILES.map((name) => fileState(path.join(sourceData, name))).join(" ");
  for (let attempt = 1; attempt <= COPY_ATTEMPTS; attempt++) {
    fs.rmSync(raw, { recursive: true, force: true });
    fs.mkdirSync(raw);
    const before = states();
    for (const name of DB_FILES) {
      const from = path.join(sourceData, name);
      if (fs.existsSync(from)) fs.writeFileSync(path.join(raw, name), fs.readFileSync(from));
    }
    if (states() === before) return attempt;
  }
  throw new Error(`the database kept changing during ${COPY_ATTEMPTS} copies; close the app`);
}

export function takeSnapshot(options: SnapshotOptions): SnapshotResult {
  const realRoots = options.realRoots ?? realDataRoots();
  const source = options.source ?? realRoots[0]!;
  const out = path.resolve(options.out);
  refuseRealFolder(out, "snapshot output", realRoots);

  const sourceData = path.join(source, "data");
  if (!fs.existsSync(path.join(sourceData, "matches.db"))) {
    throw new Error(`no database at ${path.join(sourceData, "matches.db")}`);
  }

  if (fs.existsSync(out) && fs.readdirSync(out).length > 0) {
    if (!fs.existsSync(path.join(out, SNAPSHOT_MARKER))) {
      throw new Error(`${out} exists, is not empty, and is not a snapshot folder`);
    }
    fs.rmSync(out, { recursive: true, force: true });
  }
  fs.mkdirSync(path.join(out, "data"), { recursive: true });
  fs.writeFileSync(path.join(out, SNAPSHOT_MARKER), "snapshot of the app's data folder\n");

  const raw = path.join(out, ".raw");
  const copyAttempts = copyDatabaseFiles(sourceData, raw);
  const database = path.join(out, "data", "matches.db");
  const copy = new Database(path.join(raw, "matches.db"));
  const integrity = copy.query("PRAGMA integrity_check").all() as { integrity_check: string }[];
  if (integrity.length !== 1 || integrity[0]!.integrity_check !== "ok") {
    copy.close();
    throw new Error(`the copied database fails integrity_check: ${JSON.stringify(integrity)}`);
  }
  copy.run("VACUUM INTO ?", [database]);
  copy.close();
  fs.rmSync(raw, { recursive: true, force: true });
  // A WAL database cannot be opened read-only without its -shm file; rollback mode can.
  const snapshot = new Database(database);
  snapshot.run("PRAGMA journal_mode=DELETE");
  snapshot.close();

  const caches: string[] = [];
  for (const name of CACHE_FILES) {
    const from = path.join(sourceData, name);
    if (fs.existsSync(from)) {
      fs.writeFileSync(path.join(out, "data", name), fs.readFileSync(from));
      caches.push(`data/${name}`);
    }
  }
  const assets = path.join(source, "asset-cache");
  if (fs.existsSync(assets)) {
    fs.cpSync(assets, path.join(out, "asset-cache"), { recursive: true });
    caches.push("asset-cache/");
  }
  return { out, database, caches, copyAttempts };
}

export function hashAppFiles(source: string): Map<string, string> {
  const hashes = new Map<string, string>();
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        const hash = crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex");
        const { mtimeNs } = fs.statSync(full, { bigint: true });
        hashes.set(path.relative(source, full), `${hash} ${mtimeNs}`);
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
  const value = (flag: string) => {
    const at = args.indexOf(flag);
    return at >= 0 ? args[at + 1] : undefined;
  };
  const out = value("--out");
  const verifyLog = value("--verify");
  if (!out || (args.includes("--verify") && !verifyLog)) {
    console.error("usage: bun parity/snapshot.ts --out <folder> [--verify <log>]");
    process.exit(2);
  }
  refuseRealFolder(out, "snapshot output");
  if (verifyLog) refuseRealFolder(verifyLog, "verify log");

  const real = realDataRoots()[0]!;
  const before = verifyLog ? hashAppFiles(real) : undefined;
  const result = takeSnapshot({ out });
  if (verifyLog && before) {
    const { changed, removed, added } = diffHashes(before, hashAppFiles(real));
    const lines = [
      `files hashed before (sha256 and mtime): ${before.size}`,
      `changed: ${changed.length}`,
      ...changed.map((file) => `  ${file}`),
      `removed: ${removed.length}`,
      ...removed.map((file) => `  ${file}`),
      `added: ${added.length}`,
      ...added.map((file) => `  ${file}`),
    ];
    fs.writeFileSync(verifyLog, lines.join("\n") + "\n");
    console.log(lines.join("\n"));
  }
  console.log(`snapshot ${result.out} (database copied in ${result.copyAttempts} attempt(s))`);
  console.log(`  ${result.database}`);
  for (const cache of result.caches) console.log(`  ${cache}`);
}
