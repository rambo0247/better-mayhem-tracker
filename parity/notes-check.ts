import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { PARITY_DIR } from "./lib/data.ts";
import { startElectron } from "./run-electron.ts";

/**
 * Checks the synthetic What's New notes a state uses against the app's real loadUpdateNotes.
 * For each older `last_run_version` it launches the app, reads the notes the real handler
 * built from the fake GitHub page, then asks the seam to build its synthetic copy from the
 * same page and compares the two.
 */
const CASES = [
  { from: "1.0.0", scenario: "notes-multi" },
  { from: "1.2.0", scenario: "notes-single" },
];

const out = path.join(PARITY_DIR, "out", process.argv[2] ?? "notes-check");
fs.mkdirSync(out, { recursive: true });
const results: unknown[] = [];
let failed = false;

for (const { from, scenario } of CASES) {
  const running = await startElectron({
    data: "fixture",
    runDir: path.join(out, `run-${from}`),
    lastRunVersion: from,
  });
  try {
    const hooks = (name: string, arg: unknown) =>
      running.app.evaluate(
        async (_electron, { name, arg }) => (globalThis as any).__parity[name](arg),
        { name, arg },
      );
    await hooks("github", scenario);
    const real = await hooks("realCall", { method: "getUpdateNotes" });
    const synthetic = await hooks("notes", { from, scenario });
    const same = isDeepStrictEqual(real, synthetic);
    failed ||= !same;
    results.push({
      from,
      scenario,
      same,
      versions: real?.releases?.map((r: any) => r.version),
      real,
      synthetic,
    });
  } finally {
    const report = await running.close();
    if (report.faults.length > 0 || report.leaks.length > 0) {
      console.error(JSON.stringify(report));
      failed = true;
    }
  }
}
fs.writeFileSync(path.join(out, "notes-check.json"), JSON.stringify(results, null, 1));
console.log(
  JSON.stringify(
    results.map((r: any) => ({
      from: r.from,
      scenario: r.scenario,
      same: r.same,
      versions: r.versions,
    })),
    null,
    1,
  ),
);
process.exitCode = failed ? 1 : 0;
