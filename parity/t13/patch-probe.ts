// What trunk Electron's patch dropdown shows over odd `game_version` text, for
// the `patch_probe` test in tauri/src-tauri/src/db/matches.rs. The newest
// games take the odd versions, in order, and the rest keep the fixture's.
//
//   bun parity/t13/patch-probe.ts --data <fixture folder> --out <patch-probe.json>
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startElectron } from "../run-electron.ts";

const args = process.argv.slice(2);
const value = (flag: string) => args[args.indexOf(flag) + 1];
const data = value("--data");
const out = value("--out");
if (!data || !out) throw new Error("usage: patch-probe.ts --data <fixture folder> --out <file>");

const VERSIONS = [
  "abc",
  "0x10.1",
  "16.10",
  " 16.3",
  "16.1e1",
  "Infinity.1",
  "16.2",
  "x.y",
  "15.9",
  "16",
  "16.0x2",
  ".5",
  "1_6.1",
  " 16.4",
  "-0x1.2",
  "16.-1",
];
const copy = fs.mkdtempSync(path.join(os.tmpdir(), "bmt-t13-patch-"));
fs.cpSync(data, copy, { recursive: true });
const db = new Database(path.join(copy, "data", "matches.db"));
const ids = db
  .query("SELECT game_id FROM games ORDER BY game_creation DESC LIMIT ?")
  .all(VERSIONS.length) as { game_id: number }[];
ids.forEach(({ game_id }, i) =>
  db.run("UPDATE games SET game_version = ? WHERE game_id = ?", [VERSIONS[i]!, game_id]),
);
db.close();
const run = await startElectron({ data: copy });
try {
  const patches = await run.page.evaluate(
    async () => (await (window as any).api.getMatchFilterOptions()).patches,
  );
  fs.writeFileSync(out, JSON.stringify({ versions: VERSIONS, patches }));
  console.log(JSON.stringify(patches));
} finally {
  await run.close();
  fs.rmSync(copy, { recursive: true, force: true });
}
