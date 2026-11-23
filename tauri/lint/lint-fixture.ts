import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const projectRoot = resolve(import.meta.dir, "..");
const scratch = mkdtempSync(join(tmpdir(), "bmt-lint-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));

let counter = 0;
export function lint(source: string) {
  const file = join(scratch, `fixture-${counter++}.tsx`);
  writeFileSync(file, source);
  const run = Bun.spawnSync(
    [process.execPath, "lint", "--no-script", "--flavor", "eslint", "-f", "unix", file],
    { cwd: projectRoot },
  );
  return { code: run.exitCode, out: run.stdout.toString() + run.stderr.toString() };
}
