import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface ReleaseAsset {
  name: string;
  size: number;
}

export function releaseAssets(
  tag: string,
  repo = "rambo0247/better-mayhem-tracker",
): ReleaseAsset[] {
  const out = spawnSync("gh", ["release", "view", tag, "-R", repo, "--json", "assets"], {
    encoding: "utf8",
  });
  if (out.status !== 0) throw new Error(`gh release view ${tag} failed: ${out.stderr}`);
  const parsed = JSON.parse(out.stdout) as { assets: ReleaseAsset[] };
  return parsed.assets.map(({ name, size }) => ({ name, size }));
}

/** Sum of file lengths under a folder, symlinks counted as links and never followed. */
export function apparentBytes(dir: string): number {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const stat = fs.lstatSync(current);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(current)) stack.push(path.join(current, name));
    } else total += stat.size;
  }
  return total;
}

/** Bytes the folder occupies on disk, which is what `du -sk` and Finder's "on disk" report. */
export function allocatedBytes(dir: string): number {
  if (process.platform === "win32") return apparentBytes(dir);
  const out = spawnSync("du", ["-sk", dir], { encoding: "utf8" });
  if (out.status !== 0) throw new Error(`du failed: ${out.stderr}`);
  return Number(out.stdout.split(/\s/)[0]) * 1024;
}

export interface SizeReport {
  downloadAssets: ReleaseAsset[];
  downloadBytes: number;
  downloadAsset: string;
  installedApparentBytes: number;
  installedAllocatedBytes: number;
  installedPath: string;
}

export function pickDownload(
  assets: ReleaseAsset[],
  platform: NodeJS.Platform,
  arch: string,
): ReleaseAsset {
  const wanted =
    platform === "darwin"
      ? `BetterMayhemTracker-mac-${arch === "arm64" ? "arm64" : "x64"}.dmg`
      : "BetterMayhemTracker.exe";
  const asset = assets.find((candidate) => candidate.name === wanted);
  if (!asset) throw new Error(`release has no ${wanted}: ${assets.map((a) => a.name).join(", ")}`);
  return asset;
}
