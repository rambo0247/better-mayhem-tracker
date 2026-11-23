import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { spawnApp, waitForGone, sandboxed } from "./app.ts";
import { wallClockMs } from "./first-content.ts";
import {
  attributeElectron,
  attributeWebKit,
  listProcesses,
  openFileNames,
  readFootprint,
  type WebKitContext,
} from "./memory-mac.ts";

/** Known-case proofs for the memory attribution. Prints one PASS or FAIL line per claim. */
const MB = 1024 * 1024;
const results: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, detail: string) => {
  results.push([name, ok, detail]);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${detail}`);
};

function vmmapFootprint(pid: number): number {
  const out = spawnSync("vmmap", ["-summary", String(pid)], {
    encoding: "utf8",
    maxBuffer: 1 << 26,
  });
  const match = /Physical footprint:\s+([\d.]+)([KMG])/.exec(out.stdout);
  if (!match) throw new Error(`vmmap gave no footprint for ${pid}`);
  return (
    Number(match[1]) * ({ K: 1024, M: MB, G: 1024 * MB } as const)[match[2] as "K" | "M" | "G"]
  );
}

async function syntheticTree() {
  const worker = path.join(import.meta.dir, "alloc-worker.ts");
  const spawn = (kind: string, mb: number) =>
    Bun.spawn(["bun", worker, kind, String(mb)], { stdout: "pipe", stdin: "ignore" });
  const idle = spawn("idle", 0);
  await Bun.sleep(1500);
  const baseline = readFootprint([idle.pid]).footprint.get(idle.pid)!;
  idle.kill();

  const parent = spawn("parent", 150);
  const decoy = spawn("idle-big", 150);
  await Bun.sleep(3500);
  const rows = listProcesses();
  const attribution = attributeElectron(rows, parent.pid);
  const pids = attribution.members.map((m) => m.row.pid);
  const reading = readFootprint([...pids, decoy.pid]);
  const attributed = pids.reduce((total, pid) => total + reading.footprint.get(pid)!, 0);
  const expected = 150 * MB * 2 + baseline * 3;
  check(
    "synthetic tree includes the parent and both children",
    pids.length === 3,
    `${pids.length} processes`,
  );
  check("synthetic tree leaves the decoy out", !pids.includes(decoy.pid), `decoy pid ${decoy.pid}`);
  const off = Math.abs(attributed - expected) / expected;
  check(
    "summed footprint matches 2 x 150 MB allocated plus 3 idle baselines",
    off < 0.1,
    `attributed ${(attributed / MB).toFixed(0)} MB, expected ${(expected / MB).toFixed(0)} MB, off ${(off * 100).toFixed(1)}%`,
  );
  const viaVmmap = pids.reduce((total, pid) => total + vmmapFootprint(pid), 0);
  const gap = Math.abs(viaVmmap - attributed) / attributed;
  check(
    "footprint agrees with vmmap's Physical footprint",
    gap < 0.05,
    `footprint ${(attributed / MB).toFixed(0)} MB, vmmap ${(viaVmmap / MB).toFixed(0)} MB, gap ${(gap * 100).toFixed(1)}%`,
  );
  parent.kill();
  decoy.kill();
}

async function webkitDecoys(appPath: string) {
  const dir = path.join(appPath, "Contents", "MacOS");
  const executable = path.join(dir, fs.readdirSync(dir)[0]!);
  const work = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "bmt-prove-"));
  const start = () => {
    const launch = sandboxed(executable, [], path.join(work, `${Math.random()}.sb`));
    return spawnApp({ ...launch, cwd: work });
  };
  const before = new Set(listProcesses().map((row) => row.pid));
  const mine = start();
  await Bun.sleep(4000);
  const context = (): WebKitContext => ({
    rootPid: mine.pid,
    before,
    spawnedAtMs: mine.spawnedAtMs,
    identityTokens: ["com.better-mayhem-tracker.app", path.basename(executable).replace(/-/g, "_")],
    expectedWebContent: 1,
  });
  const resolve = () => {
    const rows = listProcesses();
    const fresh = rows.filter(
      (r) => !before.has(r.pid) && r.command.includes("/WebKit.framework/"),
    );
    return attributeWebKit(rows, context(), openFileNames(fresh.map((r) => r.pid)));
  };
  const alone = resolve();
  const memberPids = alone.members.map((m) => m.row.pid).sort();
  check(
    "WebKit: one app resolves to itself, a GPU, a networking and a content helper",
    !alone.ambiguous &&
      alone.members
        .map((m) => m.role)
        .sort()
        .join() === "gpu,main,networking,webcontent",
    `${memberPids.join(",")}`,
  );

  const frozenBefore = new Set(listProcesses().map((row) => row.pid));
  const late = start();
  await Bun.sleep(4000);
  const lateAttr = (() => {
    const rows = listProcesses();
    return attributeWebKit(
      rows,
      {
        ...context(),
        before: new Set([
          ...before,
          ...[...frozenBefore].filter((p) => !memberPids.includes(p) && p !== mine.pid),
        ]),
      },
      new Map(),
    );
  })();
  check(
    "WebKit: a second copy started after the freeze does not enter the first copy's set once its pids are known",
    lateAttr.members.every((m) => m.row.pid === mine.pid || memberPids.includes(m.row.pid)) ||
      lateAttr.ambiguous,
    lateAttr.ambiguous ? `flagged ambiguous: ${lateAttr.notes.join("; ")}` : "set unchanged",
  );
  const merged = resolve();
  check(
    "WebKit: without the freeze the probe sees the second copy as ambiguous and refuses to sum",
    merged.ambiguous,
    merged.notes.join("; ") || "not flagged",
  );
  await late.stop();
  await mine.stop();
  await waitForGone([...memberPids, late.pid], 15_000);
  fs.rmSync(work, { recursive: true, force: true });
}

const tauri = process.argv[process.argv.indexOf("--tauri") + 1];
console.log(`prove: ${new Date().toISOString()} at ${wallClockMs()}`);
await syntheticTree();
if (tauri) await webkitDecoys(tauri);
const failed = results.filter(([, ok]) => !ok);
console.log(failed.length === 0 ? "prove: all PASS" : `prove: ${failed.length} FAIL`);
process.exit(failed.length === 0 ? 0 : 1);
