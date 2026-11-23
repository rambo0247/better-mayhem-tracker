import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { anonymizeDatabase, type AnonymizeSummary } from "./anonymize.ts";
import { auditFailed, auditFixture, type AuditResult } from "./audit.ts";
import { SNAPSHOT_DIRS } from "./lib/data.ts";
import { realDataRoots, refuseRealFolder } from "./lib/real-folder.ts";
import { SNAPSHOT_MARKER } from "./snapshot.ts";

export const FIXTURE_MARKER = ".bmt-fixture";

export interface FixtureOptions {
  /** A folder `snapshot.ts` wrote. */
  from: string;
  out: string;
  /** Copy the Riot art cache too. It is not private and is not committed. */
  withAssets?: boolean;
  realRoots?: string[];
}

export interface FixtureResult {
  summary: AnonymizeSummary;
  audit: AuditResult;
}

/** Builds the fixture, then audits it against its source and deletes it if anything real is left. */
export function buildFixture(options: FixtureOptions): FixtureResult {
  const realRoots = options.realRoots ?? realDataRoots();
  const from = path.resolve(options.from);
  const out = path.resolve(options.out);
  refuseRealFolder(out, "fixture output", realRoots);
  refuseRealFolder(from, "fixture source", realRoots);
  if (!fs.existsSync(path.join(from, SNAPSHOT_MARKER))) {
    throw new Error(`${from} is not a snapshot folder. Run snapshot.ts first.`);
  }
  if (fs.existsSync(out) && fs.readdirSync(out).length > 0) {
    if (!fs.existsSync(path.join(out, FIXTURE_MARKER))) {
      throw new Error(`${out} exists, is not empty, and is not a fixture folder`);
    }
    fs.rmSync(out, { recursive: true, force: true });
  }
  fs.mkdirSync(path.join(out, "data"), { recursive: true });
  fs.writeFileSync(path.join(out, FIXTURE_MARKER), "anonymized fixture\n");

  const database = path.join(out, "data", "matches.db");
  fs.copyFileSync(path.join(from, "data", "matches.db"), database);
  const summary = anonymizeDatabase(database);

  if (options.withAssets !== false) {
    for (const name of ["champion-cache.json", "augment-icon-cache.json"]) {
      const file = path.join(from, "data", name);
      if (fs.existsSync(file)) fs.copyFileSync(file, path.join(out, "data", name));
    }
    const assets = path.join(from, "asset-cache");
    if (fs.existsSync(assets)) execFileSync("cp", ["-R", assets, path.join(out, "asset-cache")]);
  }
  const audit = auditFixture(out, from, realRoots);
  if (auditFailed(audit)) {
    fs.rmSync(out, { recursive: true, force: true });
    throw new Error(
      `the fixture failed its audit and was deleted: ${JSON.stringify(audit.hits)}\n${audit.locations.join("\n")}`,
    );
  }
  return { summary, audit };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const value = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
  const out = value("--out");
  if (!out) {
    console.error(
      "usage: bun parity/fixture.ts --out <folder> [--from <snapshot folder>] [--no-assets]",
    );
    process.exit(2);
  }
  const { summary, audit } = buildFixture({
    from: value("--from") ?? SNAPSHOT_DIRS.snapshot,
    out,
    withAssets: !args.includes("--no-assets"),
  });
  console.log(`fixture ${path.resolve(out)}`);
  console.log(JSON.stringify(summary, null, 2));
  if (summary.corruptPayloads > 0) {
    console.error(`WARNING: ${summary.corruptPayloads} payloads would not decode and were emptied`);
  }
  const s = audit.searched;
  console.log(
    `audit PASS: ${s.files} files and ${s.strings} strings hold none of ${s.names} names, ${s.tags} tag lines, ${s.puuids} PUUIDs, ${s.numericIds} account and summoner ids`,
  );
}
