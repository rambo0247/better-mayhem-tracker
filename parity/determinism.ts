import fs from "node:fs";
import path from "node:path";
import { diffFiles } from "./diff.ts";
import { refuseRealFolder } from "./lib/real-folder.ts";

export function compareRuns(a: string, b: string, diffDir?: string) {
  if (diffDir) refuseRealFolder(diffDir, "diff folder");
  const ids = fs
    .readdirSync(a)
    .filter(
      (name) =>
        name.endsWith(".png") && !name.endsWith(".diff.png") && !name.endsWith(".side-by-side.png"),
    )
    .map((name) => name.slice(0, -4))
    .sort();
  const rows = ids.map((id) => {
    const other = path.join(b, `${id}.png`);
    if (!fs.existsSync(other))
      return { id, pass: false, differing: -1, note: "missing in second run" };
    const result = diffFiles(path.join(a, `${id}.png`), other, {
      policy: "same-engine",
      outPrefix: diffDir ? path.join(diffDir, id) : undefined,
    });
    return { id, pass: result.pass, differing: result.differing, note: result.reasons.join("; ") };
  });
  return rows;
}

if (import.meta.main) {
  const [a, b] = process.argv.slice(2);
  if (!a || !b) {
    console.error("usage: bun parity/determinism.ts <run folder> <run folder>");
    process.exit(2);
  }
  const rows = compareRuns(a, b, path.join(b, "diff"));
  for (const row of rows)
    console.log(`${row.pass ? "PASS" : "FAIL"} ${row.id} differing=${row.differing} ${row.note}`);
  const failed = rows.filter((row) => !row.pass).length;
  console.log(`${rows.length - failed}/${rows.length} states match under the same-engine policy`);
  process.exit(failed ? 1 : 0);
}
