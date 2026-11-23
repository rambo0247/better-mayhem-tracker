// Turns a Tauri build into the release assets under the names the 1.2.1
// updater looks for, the same ones electron-builder writes.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

export type Platform = "mac" | "win";
export type Arch = "arm64" | "x64";

export const APP_NAME = "Better Mayhem Tracker";
export const WINDOWS_BINARY = "better-mayhem-tracker-tauri.exe";

export function assetNames(platform: Platform, arch: Arch): string[] {
  if (platform === "win") {
    if (arch !== "x64") throw new Error(`No Windows build for ${arch}`);
    return ["BetterMayhemTracker.exe"];
  }
  return [`BetterMayhemTracker-mac-${arch}.zip`, `BetterMayhemTracker-mac-${arch}.dmg`];
}

export const rustTarget = (arch: Arch) =>
  arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";

function run(cmd: string[]) {
  const result = Bun.spawnSync(cmd, { stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) throw new Error(`${cmd.join(" ")} exited ${result.exitCode}`);
}

// Ad hoc, as Electron's `identity: "-"` does: no certificate is needed, and the
// signature keeps the bundle valid once it is moved or unzipped
export function signAdHoc(app: string) {
  run(["codesign", "--force", "--deep", "--sign", "-", app]);
  run(["codesign", "--verify", "--deep", "--strict", app]);
}

// ditto keeps the bundle's symlinks, modes and signature, which zip does not
export function zipApp(app: string, zip: string) {
  run(["ditto", "-c", "-k", "--keepParent", app, zip]);
}

// hdiutil directly: the bundler's own dmg step drives Finder with AppleScript
export function makeDmg(app: string, dmg: string) {
  const stage = mkdtempSync(join(tmpdir(), "bmt-dmg-"));
  try {
    run(["ditto", app, join(stage, basename(app))]);
    symlinkSync("/Applications", join(stage, "Applications"));
    rmSync(dmg, { force: true });
    run([
      "hdiutil",
      "create",
      "-volname",
      APP_NAME,
      "-srcfolder",
      stage,
      "-ov",
      "-format",
      "UDZO",
      dmg,
    ]);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

export function packageMac(tauriDir: string, arch: Arch, out: string): string[] {
  const app = join(
    tauriDir,
    "src-tauri/target",
    rustTarget(arch),
    "release/bundle/macos",
    `${APP_NAME}.app`,
  );
  if (!existsSync(app)) throw new Error(`No bundle at ${app}`);
  signAdHoc(app);
  const [zip, dmg] = assetNames("mac", arch).map((name) => join(out, name));
  zipApp(app, zip!);
  makeDmg(app, dmg!);
  return [zip!, dmg!];
}

export function packageWindows(tauriDir: string, out: string): string[] {
  const release = join(tauriDir, "src-tauri/target/release");
  const exe = [WINDOWS_BINARY, `${APP_NAME}.exe`]
    .map((name) => join(release, name))
    .find((path) => existsSync(path));
  if (!exe) throw new Error(`No binary in ${release}`);
  const [name] = assetNames("win", "x64");
  const dest = join(out, name!);
  copyFileSync(exe, dest);
  return [dest];
}

if (import.meta.main) {
  const { values } = (await import("node:util")).parseArgs({
    options: {
      platform: { type: "string" },
      arch: { type: "string" },
      out: { type: "string", default: "release-assets" },
    },
  });
  const platform = values.platform as Platform;
  const arch = (values.arch ?? "x64") as Arch;
  if (platform !== "mac" && platform !== "win") throw new Error("--platform mac|win");
  if (arch !== "arm64" && arch !== "x64") throw new Error("--arch arm64|x64");
  const out = resolve(values.out!);
  mkdirSync(out, { recursive: true });
  const tauriDir = resolve(import.meta.dir, "..");
  const files =
    platform === "mac" ? packageMac(tauriDir, arch, out) : packageWindows(tauriDir, out);
  for (const file of files) console.log(file);
}
