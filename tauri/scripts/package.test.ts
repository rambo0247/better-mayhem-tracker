import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_NAME, assetNames, zipApp } from "./package";

test("asset names match the ones electron-builder writes", () => {
  expect(assetNames("mac", "arm64")).toEqual([
    "BetterMayhemTracker-mac-arm64.zip",
    "BetterMayhemTracker-mac-arm64.dmg",
  ]);
  expect(assetNames("mac", "x64")).toEqual([
    "BetterMayhemTracker-mac-x64.zip",
    "BetterMayhemTracker-mac-x64.dmg",
  ]);
  expect(assetNames("win", "x64")).toEqual(["BetterMayhemTracker.exe"]);
  expect(() => assetNames("win", "arm64")).toThrow();
});

test.skipIf(process.platform !== "darwin")("a zip holds exactly one top-level .app", () => {
  const dir = mkdtempSync(join(tmpdir(), "bmt-package-test-"));
  try {
    const app = join(dir, `${APP_NAME}.app`);
    mkdirSync(join(app, "Contents/MacOS"), { recursive: true });
    writeFileSync(join(app, "Contents/MacOS", APP_NAME), "");
    const zip = join(dir, "out.zip");
    zipApp(app, zip);
    const listing = Bun.spawnSync(["unzip", "-Z1", zip]).stdout.toString().trim().split("\n");
    const top = new Set(listing.map((entry) => entry.split("/")[0]));
    expect([...top]).toEqual([`${APP_NAME}.app`]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
