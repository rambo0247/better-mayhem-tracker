/**
 * T23's macOS lanes and review media for the login item: turning autostart on, an Electron
 * LaunchAgent already present, a moved app bundle, and turning it off.
 *
 *   bun parity/autostart-review.ts --binary <lane build> [--electron-settings <png>]
 *     [--out parity/out/review]
 *
 * Lane 8 runs the parity-driver debug build that `run-tauri.ts` finds, on the Settings page,
 * beside Electron's dev-run baseline of the same page (`--electron-settings`, from T02).
 *
 * The lane build is a release-profile build, the only one install_location counts as installed
 * once T09's `bmt_release_profile` lands, with the Tauri identifier set to the lane's:
 *
 *   TAURI_CONFIG='{"identifier":"com.better-mayhem-tracker.lane-t23"}' \
 *     cargo build --release --features custom-protocol
 *
 * A release build has no data root override and no data guard, so the lanes give it none to
 * need. It runs from a scratch `.app` with the lane's bundle id, with HOME pointing at a
 * scratch folder: its data folder and its LaunchAgents folder both resolve under HOME
 * (`dirs`). It runs under the Seatbelt profile T06's perf runs use, which denies the real data
 * folders, writes to the real LaunchAgents, the League install, and `ps`, so a build that
 * looked past HOME fails instead of touching the operator's files. The lane identifier keeps
 * its single-instance socket, `/tmp/<identifier>_si.sock`, apart from any installed app's, so
 * a launch can never hand over to one and bring its window up; the script refuses a binary
 * without it. The script checks that the app's log landed in the scratch data folder before
 * it trusts a result. Electron's side is what its own autostart.ts writes
 * (`autostart-golden.ts`), because a packaged Electron resolves its data folder outside HOME.
 *
 * WebKit ignores HOME and keeps its website data and caches under the real
 * `~/Library/{WebKit,Caches}/<bundle id>`, so the lane bundle has an id of its own, the
 * script refuses to start if those folders already exist, and removes them at the end.
 */
import { Database } from "bun:sqlite";
import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PARITY_DIR, REPO_DIR } from "./lib/data.ts";
import { waitForNoGame } from "./lib/no-game.ts";
import { fileContains, startTauri } from "./run-tauri.ts";
import { applyState, STATES } from "./states.ts";
import { realDataRoots, refuseRealFolder } from "./lib/real-folder.ts";

const args = process.argv.slice(2);
const value = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const binary = path.resolve(value("--binary") ?? "");
if (!fs.existsSync(binary) || !fs.statSync(binary).isFile()) {
  console.error("usage: bun parity/autostart-review.ts --binary <lane build> [--out <dir>]");
  process.exit(2);
}
const out = path.resolve(value("--out") ?? path.join(PARITY_DIR, "out", "review"));
fs.mkdirSync(out, { recursive: true });
// Resolved, as Electron's process.execPath is, so the paths the lanes expect are the ones
// both apps register
const work = path.join(fs.realpathSync(out), "T23-work");
fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });

const home = path.join(work, "home");
const launchAgents = path.join(home, "Library", "LaunchAgents");
const dataRoot = path.join(home, "Library", "Application Support", "better-mayhem-tracker");
const dbFile = path.join(dataRoot, "data", "matches.db");
const LABEL = "com.better-mayhem-tracker.app.autostart";
const plistFile = path.join(launchAgents, `${LABEL}.plist`);
const EXE = "Contents/MacOS/Better Mayhem Tracker";
const LANE_BUNDLE_ID = "com.better-mayhem-tracker.lane-t23";
/** The operator's home from the user database, whatever HOME says. */
const realHome = os.userInfo().homedir;

for (const dir of [work, home, dataRoot]) {
  refuseRealFolder(dir, "T23 lane folder", realDataRoots("darwin", {}, realHome));
}
if (!fileContains(binary, LANE_BUNDLE_ID)) {
  throw new Error(`${binary} does not carry the identifier ${LANE_BUNDLE_ID}; see the header`);
}
const webkitLeftovers = ["WebKit", "Caches"].map((dir) =>
  path.join(realHome, "Library", dir, LANE_BUNDLE_ID),
);
for (const dir of webkitLeftovers) {
  if (fs.existsSync(dir)) throw new Error(`${dir} exists before the lanes ran; not touching it`);
}
process.on("exit", () => {
  for (const dir of webkitLeftovers) fs.rmSync(dir, { recursive: true, force: true });
});
if (home.startsWith(path.join(realHome, "Library"))) throw new Error(`${home} is not scratch`);

/** T06's perf profile (`parity/perf/app.ts` on port/T06-perf), for an app with no seam. */
const sandboxFile = path.join(work, "lane.sb");
fs.writeFileSync(
  sandboxFile,
  [
    "(version 1)",
    "(allow default)",
    `(deny file* (subpath ${JSON.stringify("/Applications/League of Legends.app")}))`,
    `(deny file* (subpath ${JSON.stringify("/Users/Shared/Riot Games")}))`,
    `(deny process-exec (literal ${JSON.stringify("/bin/ps")}))`,
    ...realDataRoots("darwin", {}, realHome).map(
      (root) => `(deny file* (subpath ${JSON.stringify(root)}))`,
    ),
    `(deny file-write* (subpath ${JSON.stringify(path.join(realHome, "Library", "LaunchAgents"))}))`,
    "",
  ].join("\n"),
);

fs.cpSync(path.join(PARITY_DIR, "snapshots", "fixture", "data"), path.join(dataRoot, "data"), {
  recursive: true,
});

interface Check {
  name: string;
  pass: boolean;
  detail: unknown;
}
const checks: Check[] = [];
const check = (name: string, pass: boolean, detail: unknown) => {
  checks.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${name} ${JSON.stringify(detail)}`);
};

const golden = JSON.parse(
  fs.readFileSync(
    path.join(REPO_DIR, "tauri/src-tauri/tests/fixtures/electron-autostart.json"),
    "utf8",
  ),
);
const ELECTRON_TARGET = `/Applications/Better Mayhem Tracker.app/${EXE}`;
const electronOn: string = golden.darwin.find((s: { name: string }) => s.name === "turn on").plist;
const xmlEscape = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** Electron's LaunchAgent for `target`: its recorded output with the target swapped in. */
const electronPlist = (target: string) =>
  electronOn.replace(
    `<string>${ELECTRON_TARGET}</string>`,
    `<string>${xmlEscape(target)}</string>`,
  );

function makeBundle(dir: string) {
  fs.mkdirSync(path.join(dir, "Contents", "MacOS"), { recursive: true });
  fs.copyFileSync(binary, path.join(dir, EXE), fs.constants.COPYFILE_FICLONE);
  fs.chmodSync(path.join(dir, EXE), 0o755);
  fs.writeFileSync(
    path.join(dir, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>Better Mayhem Tracker</string>
  <key>CFBundleIdentifier</key>
  <string>${LANE_BUNDLE_ID}</string>
  <key>CFBundleName</key>
  <string>Better Mayhem Tracker</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
</dict>
</plist>
`,
  );
}

function settings(values: Record<string, string | null>) {
  const db = new Database(dbFile);
  for (const [key, v] of Object.entries(values)) {
    if (v === null) db.run("DELETE FROM settings WHERE key = ?", [key]);
    else db.run("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", [key, v]);
  }
  db.close();
}

function setting(key: string): string | null {
  const db = new Database(dbFile);
  const row = db.query("SELECT value FROM settings WHERE key = ?").get(key) as {
    value: string;
  } | null;
  db.close();
  return row?.value ?? null;
}

function agents() {
  const names = fs.existsSync(launchAgents) ? fs.readdirSync(launchAgents).sort() : [];
  const plist = fs.existsSync(plistFile) ? fs.readFileSync(plistFile, "utf8") : null;
  const mtimeMs = plist === null ? null : fs.statSync(plistFile).mtimeMs;
  return { names, plist, mtimeMs, autoStartPath: setting("auto_start_path") };
}

function waitExit(child: ChildProcess, ms: number) {
  return new Promise<number | null | "timeout">((resolve) => {
    if (child.exitCode !== null) return resolve(child.exitCode);
    const timer = setTimeout(() => resolve("timeout"), ms);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

/**
 * Launches `exe` with `--hidden`, as the login item does, under the lane's Seatbelt profile,
 * until startup has run. sandbox-exec execs the app, so the child's pid is the app's.
 */
async function launch(exe: string, name: string) {
  await waitForNoGame();
  const mainLog = path.join(dataRoot, "logs", "main.log");
  const logBefore = fs.existsSync(mainLog) ? fs.statSync(mainLog).size : 0;
  const child = spawn("/usr/bin/sandbox-exec", ["-f", sandboxFile, exe, "--hidden"], {
    env: { ...process.env, HOME: home, TZ: "UTC" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let text = "";
  const started = Date.now();
  let ready = false;
  child.stdout!.on("data", (chunk) => {
    text += chunk;
    if (text.includes("window main ")) ready = true;
  });
  child.stderr!.on("data", (chunk) => (text += chunk));
  while (!ready && child.exitCode === null && Date.now() - started < 30_000) await Bun.sleep(100);
  child.kill("SIGTERM");
  if ((await waitExit(child, 5_000)) === "timeout") {
    child.kill("SIGKILL");
    await waitExit(child, 5_000);
  }
  fs.writeFileSync(path.join(work, `${name}.app.log`), text);
  const logAfter = fs.existsSync(mainLog) ? fs.statSync(mainLog).size : 0;
  if (!ready || logAfter <= logBefore) {
    throw new Error(
      `${name}: the app did not start against the scratch data folder (ready ${ready}, main.log ${logBefore} -> ${logAfter} bytes)\n${text}`,
    );
  }
  return text;
}

function unifiedDiff(a: string, b: string, labels: [string, string]) {
  const fa = path.join(work, "diff-a.plist");
  const fb = path.join(work, "diff-b.plist");
  fs.writeFileSync(fa, a);
  fs.writeFileSync(fb, b);
  const result = spawnSync("diff", ["-u", "--label", labels[0], "--label", labels[1], fa, fb], {
    encoding: "utf8",
  });
  return result.stdout || "(identical)\n";
}

const FONT = "/System/Library/Fonts/Supplemental/Arial.ttf";
const MONO = "/System/Library/Fonts/Menlo.ttc";
const magick = (...argv: string[]) => execFileSync("magick", argv, { stdio: "pipe" });
const file = (name: string) => path.join(work, name);
const video: { file: string; seconds: number }[] = [];

/** Text on a dark panel under a title, for a file's contents or a log. */
function panel(name: string, title: string, body: string, width = 1880) {
  const shown = (text: string) => text.replaceAll(work, "$SCRATCH");
  const text = shown(body).trimEnd();
  const heading = shown(title);
  const lines = text.split("\n").length;
  magick(
    "-size",
    `${width}x${120 + lines * 30}`,
    "xc:#1b1d24",
    "-fill",
    "#ffffff",
    "-font",
    FONT,
    "-pointsize",
    "30",
    "-annotate",
    "+30+50",
    heading,
    "-fill",
    "#e8e8e8",
    "-font",
    MONO,
    "-pointsize",
    "20",
    "-annotate",
    "+30+100",
    text,
    file(name),
  );
  return file(name);
}

function stack(name: string, ...panels: string[]) {
  magick(
    ...panels,
    "-background",
    "#0f1115",
    "-gravity",
    "north",
    "-splice",
    "0x16",
    "-append",
    file(name),
  );
  return file(name);
}

function frame(src: string, caption: string, seconds = 8) {
  const target = file(`frame-${String(video.length).padStart(2, "0")}.png`);
  magick(
    src,
    "-resize",
    "1920x1000>",
    "-background",
    "#0f1115",
    "-gravity",
    "center",
    "-extent",
    "1920x1000",
    "-gravity",
    "north",
    "-splice",
    "0x80",
    "-fill",
    "#ffffff",
    "-pointsize",
    "32",
    "-font",
    FONT,
    "-annotate",
    "+0+22",
    caption,
    target,
  );
  video.push({ file: target, seconds });
}

const appsDir = path.join(work, "Applications");
const bundle = path.join(appsDir, "Better Mayhem Tracker.app");
const movedBundle = path.join(work, "Moved Apps", "Better Mayhem Tracker.app");
const target = path.join(bundle, EXE);
const movedTarget = path.join(movedBundle, EXE);
makeBundle(bundle);

// Lane 1: turning autostart on writes Electron's LaunchAgent, apart from the bundle path
{
  settings({ auto_start: "true", auto_start_path: null });
  await launch(target, "lane1");
  const state = agents();
  const same = state.plist === electronPlist(target);
  const diff = unifiedDiff(electronOn, state.plist ?? "", [
    "Electron 1.2.1 (autostart.ts, /Applications)",
    `Tauri (autostart.rs, ${bundle})`,
  ]);
  const changed = diff
    .split("\n")
    .filter((l) => /^[-+][^-+]/.test(l))
    .map((l) => l.slice(1));
  check("lane 1: the LaunchAgent equals Electron's byte for byte for the same bundle", same, {
    names: state.names,
    autoStartPath: state.autoStartPath,
  });
  check(
    "lane 1: against Electron's /Applications output only the bundle path line differs",
    changed.length === 2 && changed.every((l) => l.includes("Better Mayhem Tracker.app/")),
    changed,
  );
  fs.writeFileSync(
    path.join(out, "plist-diff.log"),
    `${diff}\nbyte-equal to Electron's output for ${target}: ${same}\nLaunchAgents: ${state.names.join(", ")}\nauto_start_path: ${state.autoStartPath}\n`,
  );
  const image = stack(
    "plist-pair.png",
    panel("plist-electron.png", "Electron 1.2.1 writes (autostart.ts)", electronOn),
    panel(
      "plist-tauri.png",
      "Tauri writes (autostart.rs), launched from a scratch bundle",
      state.plist ?? "(none)",
    ),
    panel("plist-diff.png", "diff -u", diff),
  );
  fs.copyFileSync(image, path.join(out, "T23-review-plist.png"));
  frame(image, "Autostart on: the same LaunchAgent as Electron, only the bundle path differs");
}

// Lane 9: an Electron-written LaunchAgent and auto_start_path carry over untouched
{
  const inherited = electronPlist(target);
  fs.writeFileSync(plistFile, inherited);
  const old = new Date("2026-01-01T00:00:00Z");
  fs.utimesSync(plistFile, old, old);
  settings({ auto_start: "true", auto_start_path: target });
  const before = agents();
  await launch(target, "lane9");
  const after = agents();
  const pass =
    after.plist === inherited &&
    after.mtimeMs === before.mtimeMs &&
    after.names.length === 1 &&
    after.autoStartPath === target;
  check("lane 9: Tauri keeps the Electron LaunchAgent and adds no second agent", pass, {
    names: after.names,
    unchangedBytes: after.plist === inherited,
    unchangedMtime: after.mtimeMs === before.mtimeMs,
  });
  const text = [
    `Before: ${before.names.join(", ")} (Electron 1.2.1's bytes, mtime ${old.toISOString()})`,
    `auto_start = true, auto_start_path = ${target}`,
    "",
    "Tauri launched with --hidden",
    "",
    `After:  ${after.names.join(", ")}`,
    `bytes unchanged: ${after.plist === inherited}`,
    `mtime unchanged: ${after.mtimeMs === before.mtimeMs}`,
    `auto_start_path: ${after.autoStartPath}`,
  ].join("\n");
  fs.writeFileSync(path.join(out, "inherited-plist.log"), `${text}\n`);
  const image = panel("inherited.png", "An Electron LaunchAgent is already there", text);
  fs.copyFileSync(image, path.join(out, "T23-review-inherited.png"));
  frame(image, "Updated from Electron: the existing LaunchAgent stays as it is, no second entry");
}

// Lane 4: a moved bundle rewrites the LaunchAgent at the next launch, as Electron's sync does
{
  const before = agents();
  fs.mkdirSync(path.dirname(movedBundle), { recursive: true });
  fs.renameSync(bundle, movedBundle);
  await launch(movedTarget, "lane4");
  const after = agents();
  const pass =
    after.plist === electronPlist(movedTarget) &&
    after.autoStartPath === movedTarget &&
    after.names.length === 1;
  check("lane 4: the LaunchAgent follows the moved bundle", pass, {
    autoStartPath: after.autoStartPath,
    names: after.names,
  });
  const diff = unifiedDiff(before.plist ?? "", after.plist ?? "", [
    "before the move",
    "after the move",
  ]);
  fs.writeFileSync(
    path.join(out, "moved-app.log"),
    `moved ${bundle}\n   to ${movedBundle}\n\n${diff}\nequal to Electron's output for the new path: ${after.plist === electronPlist(movedTarget)}\nauto_start_path: ${after.autoStartPath}\n`,
  );
  const image = stack(
    "moved-pair.png",
    panel("moved-before.png", `Before: ${bundle}`, before.plist ?? "(none)"),
    panel("moved-after.png", `After a launch from ${movedBundle}`, after.plist ?? "(none)"),
  );
  fs.copyFileSync(image, path.join(out, "T23-review-moved-app.png"));
  frame(image, "Moved app: the next launch points the LaunchAgent at the new path");
}

// Lane 11: a launch through a symlinked folder or a ".." registers the resolved path, as
// Electron's process.execPath does, so it leaves Electron's LaunchAgent for that path alone
{
  const linked = path.join(work, "Linked Apps");
  fs.symlinkSync(path.dirname(movedBundle), linked);
  const routes = [
    ["a symlinked folder", path.join(linked, path.basename(movedBundle), EXE)],
    [
      "a .. component",
      // Joined by hand: path.join would fold the ".." away
      [path.dirname(movedBundle), "..", "Moved Apps", path.basename(movedBundle), EXE].join("/"),
    ],
  ] as const;
  const lines: string[] = [`Electron registers ${movedTarget} for each, its realpath`, ""];
  for (const [route, exe] of routes) {
    const inherited = electronPlist(movedTarget);
    fs.writeFileSync(plistFile, inherited);
    const old = new Date("2026-01-01T00:00:00Z");
    fs.utimesSync(plistFile, old, old);
    settings({ auto_start: "true", auto_start_path: movedTarget });
    if (!exe.includes("/../") && route.includes("..")) throw new Error(`${exe} lost its ..`);
    const before = agents();
    await launch(exe, `lane11-${route.replaceAll(/\W+/g, "-")}`);
    const after = agents();
    const untouched =
      after.plist === inherited &&
      after.mtimeMs === before.mtimeMs &&
      after.names.length === 1 &&
      after.autoStartPath === movedTarget;
    check(`lane 11: launched through ${route}, Electron's LaunchAgent is untouched`, untouched, {
      exe,
      unchangedBytes: after.plist === inherited,
      unchangedMtime: after.mtimeMs === before.mtimeMs,
      autoStartPath: after.autoStartPath,
    });
    lines.push(
      `Launched as ${exe}`,
      `  bytes unchanged: ${after.plist === inherited}, mtime unchanged: ${after.mtimeMs === before.mtimeMs}`,
      `  auto_start_path: ${after.autoStartPath}`,
      "",
    );
  }
  fs.rmSync(linked);
  const text = lines.join("\n");
  fs.writeFileSync(path.join(out, "hostile-symlink.log"), text);
  const image = panel("symlink.png", "Launched through a symlink and a ..", text);
  fs.copyFileSync(image, path.join(out, "T23-review-symlink.png"));
  frame(image, "Launched by another route to the same app: the LaunchAgent stays Electron's");
}

// Lane 5: turning autostart off removes the LaunchAgent
{
  settings({ auto_start: "false" });
  const before = agents();
  await launch(movedTarget, "lane5");
  const after = agents();
  const pass = after.plist === null && after.names.length === 0 && after.autoStartPath === "";
  check("lane 5: autostart off removes the LaunchAgent", pass, after);
  const text = [
    `Before: ${before.names.join(", ") || "(empty)"}`,
    'auto_start = "false"',
    "",
    "Tauri launched",
    "",
    `After:  ${after.names.join(", ") || "(empty)"}`,
    `auto_start_path: ${JSON.stringify(after.autoStartPath)}`,
  ].join("\n");
  fs.writeFileSync(path.join(out, "autostart-off.log"), `${text}\n`);
  frame(panel("off.png", "Autostart off", text), "Autostart off: the LaunchAgent is removed");
}

// Lane 8: a run with no durable copy says autostart is unavailable, as Electron's dev run does
{
  const state = STATES.find((s) => s.id === "settings-default")!;
  const tauri = await startTauri({
    data: "fixture",
    renderer: "electron",
    api: "tauri",
    runDir: path.join(work, "lane8"),
    viewport: state.viewport,
  });
  try {
    // No vars: the route takes none, and the queries resolveVars runs are not ported yet
    await applyState(tauri.ctx, state, {});
    const supported = await tauri.engine.evaluate(() => (window as any).api.isAutoStartSupported());
    const note = (await tauri.engine.content()).includes("Needs the app in Applications");
    const shot = path.join(out, "autostart-unsupported.png");
    await tauri.engine.screenshot(shot);
    check(
      "lane 8: an unpackaged build answers autostart:supported false and Settings says so",
      supported === false && note,
      { supported, note },
    );
    const electronShot = value("--electron-settings");
    const sides = electronShot ? [electronShot, shot] : [shot];
    const labels = electronShot
      ? ["Electron 1.2.1, dev run (T02)", "Tauri debug build"]
      : ["Tauri"];
    const labelled = sides.map((src, i) => {
      const target = file(`unsupported-${i}.png`);
      magick(
        src,
        "-resize",
        "1280x",
        "-background",
        "#0f1115",
        "-gravity",
        "north",
        "-splice",
        "0x50",
        "-fill",
        "#e8e8e8",
        "-pointsize",
        "28",
        "-font",
        FONT,
        "-annotate",
        "+0+10",
        labels[i]!,
        target,
      );
      return target;
    });
    const pairFile = file("unsupported-pair.png");
    magick(...labelled, "-background", "#0f1115", "-splice", "16x0", "+append", pairFile);
    fs.copyFileSync(pairFile, path.join(out, "T23-review-unsupported.png"));
    frame(pairFile, "Not installed: the Open at login switch is locked in both apps");
  } finally {
    await tauri.close();
  }
}

fs.writeFileSync(path.join(out, "T23-review.json"), JSON.stringify(checks, null, 1));
const list = file("frames.txt");
fs.writeFileSync(
  list,
  video.map((f) => `file '${f.file}'\nduration ${f.seconds}`).join("\n") +
    `\nfile '${video.at(-1)!.file}'\n`,
);
execFileSync("ffmpeg", [
  "-y",
  "-loglevel",
  "error",
  "-f",
  "concat",
  "-safe",
  "0",
  "-i",
  list,
  "-vf",
  "fps=30,format=yuv420p",
  "-c:v",
  "libx264",
  path.join(out, "T23-review.mp4"),
]);
const failed = checks.filter((c) => !c.pass);
console.log(`${checks.length - failed.length} pass, ${failed.length} fail; media in ${out}`);
process.exit(failed.length ? 1 : 0);
