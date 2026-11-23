// Loaded with -r ahead of seam.cjs for T24's hand-off lane. Not app code.
// It makes the unpacked Electron 1.2.1 run look like a packaged install at a scratch
// bundle path, the way the packaged app sees itself, so its own updater runs unchanged:
// app.isPackaged is true and process.execPath points into the scratch bundle, which
// macAppBundle() reads, GitHub's URLs go to fake-github.ts, `open` resolves to a stub, and the
// login item's home is a scratch folder.
const os = require("os");
const path = require("path");

// seam.cjs first, so its real-folder guard and network block are computed from the real
// home before anything here moves os.homedir(). The later -r of the same file is a no-op.
require(path.join(__dirname, "seam.cjs"));

const need = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`updater-handoff-seam: ${name} is not set`);
  return value;
};
const execPath = need("HANDOFF_EXEC_PATH");
const github = need("HANDOFF_GITHUB");
const stubBin = need("HANDOFF_STUB_BIN");
const scratchHome = need("HANDOFF_HOME");
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(github)) {
  throw new Error(`updater-handoff-seam: ${github} is not a loopback base`);
}
if (/^\/Applications\/|\/Users\/[^/]+\/Applications\//.test(execPath)) {
  throw new Error(`updater-handoff-seam: refusing an installed app at ${execPath}`);
}

// A packaged app keeps its data in userData, so the run's data moves there first.
// run-electron.ts runs Electron in the run folder, with userData at <run>/userdata.
const fs = require("fs");
const userData = path.join(process.cwd(), "userdata");
for (const name of ["data", "asset-cache", "backups"]) {
  const from = path.join(process.cwd(), name);
  const to = path.join(userData, name);
  if (fs.existsSync(from) && !fs.existsSync(to)) fs.cpSync(from, to, { recursive: true });
}

process.execPath = execPath;
// Electron settles isPackaged from the real binary before this runs, so it is set too
const { app } = require("electron");
Object.defineProperty(app, "isPackaged", { get: () => true, configurable: true });
if (!app.isPackaged) throw new Error("updater-handoff-seam: app.isPackaged did not take");
process.env.PATH = `${stubBin}:${process.env.PATH}`;
os.homedir = () => scratchHome;

const RELEASES =
  /^https:\/\/api\.github\.com(\/repos\/rambo0247\/better-mayhem-tracker\/releases.*)$/;
const DOWNLOAD =
  /^https:\/\/github\.com(\/rambo0247\/better-mayhem-tracker\/releases\/download\/.*)$/;
const blocked = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = typeof input === "string" ? input : (input.url ?? String(input));
  const match = RELEASES.exec(url) ?? DOWNLOAD.exec(url);
  return blocked(match ? github + match[1] : input, init);
};
