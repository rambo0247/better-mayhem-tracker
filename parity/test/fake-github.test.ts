import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import {
  DOWNLOAD_PATH,
  PAYLOAD_DIGEST,
  RELEASES_PATH,
  SCENARIOS,
  startFakeGithub,
  type Scenario,
} from "../fake-github.ts";

const { rewriteGithubUrl } = createRequire(import.meta.url)("../seam-overlays.cjs") as {
  rewriteGithubUrl: (url: string, base: string, scenario: string) => string | null;
};

const server = startFakeGithub();
afterAll(() => server.close());

const fetchReleases = async (scenario: Scenario) => {
  const response = await fetch(`${server.url}${RELEASES_PATH}?per_page=20&scenario=${scenario}`);
  return (await response.json()) as {
    tag_name: string;
    draft: boolean;
    prerelease: boolean;
    assets: { name: string; digest: string; browser_download_url: string }[];
  }[];
};

describe("fake GitHub", () => {
  test("every scenario serves a newest-first list with a tag on each release", async () => {
    for (const scenario of SCENARIOS) {
      const releases = await fetchReleases(scenario);
      expect(releases.length).toBeGreaterThan(0);
      expect(releases.every((r) => /^v\d+\.\d+\.\d+(-rc\.\d+)?$/.test(r.tag_name))).toBe(true);
    }
  });

  test("up-to-date tops out at the installed 1.2.1 and update-available is ahead of it", async () => {
    expect((await fetchReleases("up-to-date"))[0]?.tag_name).toBe("v1.2.1");
    expect((await fetchReleases("update-available"))[0]?.tag_name).toBe("v1.3.0");
  });

  test("update-many fills the page so older releases are left out", async () => {
    expect((await fetchReleases("update-many")).length).toBe(20);
  });

  test("update-no-asset leaves the newest release without a download", async () => {
    expect((await fetchReleases("update-no-asset"))[0]?.assets).toEqual([]);
  });

  test("every asset URL is a github.com release download, so the updater's prefix check passes", async () => {
    for (const scenario of SCENARIOS) {
      for (const release of await fetchReleases(scenario)) {
        for (const asset of release.assets) {
          expect(asset.browser_download_url).toBe(
            `https://github.com/rambo0247/better-mayhem-tracker/releases/download/${release.tag_name}/${asset.name}`,
          );
        }
      }
    }
  });

  test("notes-single and notes-multi list different releases, each with entries the notes must filter out", async () => {
    const single = await fetchReleases("notes-single");
    const multi = await fetchReleases("notes-multi");
    expect(single.map((r) => r.tag_name)).not.toEqual(multi.map((r) => r.tag_name));
    expect(single.some((r) => r.prerelease)).toBe(true);
    expect(multi.some((r) => r.prerelease)).toBe(true);
    expect(multi.some((r) => r.draft)).toBe(true);
  });

  test("the digest on every asset is the sha256 of the bytes the download serves", async () => {
    const [newest] = await fetchReleases("downloading");
    const asset = newest!.assets[0]!;
    const target = rewriteGithubUrl(asset.browser_download_url, server.url, "downloading");
    const bytes = new Uint8Array(await (await fetch(target!)).arrayBuffer());
    expect(asset.digest).toBe(
      `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`,
    );
    expect(PAYLOAD_DIGEST).toBe(asset.digest);
  });

  test("the seam sends a github.com asset URL to the fake, which serves the download", async () => {
    const [newest] = await fetchReleases("downloading");
    const url = newest!.assets[0]!.browser_download_url;
    const target = rewriteGithubUrl(url, server.url, "downloading");
    expect(target).toBe(server.url + url.slice("https://github.com".length));
    expect(new URL(target!).pathname.startsWith(DOWNLOAD_PATH)).toBe(true);
    const response = await fetch(target!);
    expect(response.status).toBe(200);
    await response.body?.cancel();
  });

  test("the seam sends the releases page to the fake with the scenario, and leaves other URLs alone", () => {
    const page = rewriteGithubUrl(
      "https://api.github.com/repos/rambo0247/better-mayhem-tracker/releases?per_page=20",
      server.url,
      "update-multi",
    );
    expect(page).toBe(`${server.url}${RELEASES_PATH}?per_page=20&scenario=update-multi`);
    expect(
      rewriteGithubUrl("https://github.com/other/repo/releases/download/v1/x", server.url, "x"),
    ).toBeNull();
    expect(rewriteGithubUrl("https://example.com/", server.url, "x")).toBeNull();
  });

  test("a release page asked for under the host, as the Tauri app asks, gets the scenario set last", async () => {
    const own = startFakeGithub();
    try {
      const page = async () =>
        (await (await fetch(`${own.url}/api.github.com${RELEASES_PATH}?per_page=20`)).json()) as {
          tag_name: string;
        }[];
      expect((await page())[0]!.tag_name).toBe("v1.2.1");
      own.setScenario("update-available");
      expect((await page())[0]!.tag_name).not.toBe("v1.2.1");
    } finally {
      own.close();
    }
  });

  test("an unknown scenario is a 400, not an empty list", async () => {
    const response = await fetch(`${server.url}${RELEASES_PATH}?scenario=nope`);
    expect(response.status).toBe(400);
  });
});

describe("seam-overlays.cjs under the seam", () => {
  const stub = path.resolve(import.meta.dir, "harness/electron-stub.cjs");
  const run = path.resolve(import.meta.dir, "harness/overlays-run.cjs");
  const parity = path.resolve(import.meta.dir, "..");

  type Outcome = {
    record: Record<string, any>;
    results: Record<string, any>;
  };

  // Plain node with a fake `electron` and the real seam.cjs, every hook driven. `seamDir` holds
  // the seam under test: parity/ itself, or a copy with its require moved.
  async function runUnderSeam(seamDir: string): Promise<Outcome> {
    const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bmt-overlays-")));
    const real = path.join(scratch, "real");
    const userData = path.join(scratch, "userdata");
    fs.mkdirSync(real);
    fs.mkdirSync(userData);
    const child = spawn("node", ["-r", stub, "-r", path.join(seamDir, "seam.cjs"), run], {
      cwd: scratch,
      env: {
        ...process.env,
        SEAM_REAL_ROOTS: JSON.stringify([real]),
        SEAM_GITHUB: server.url,
        HARNESS_USER_DATA: userData,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    if (code !== 0) throw new Error(`harness exited ${code}: ${stderr}`);
    return JSON.parse(stdout.trim().split("\n").at(-1)!) as Outcome;
  }

  test("loads after the write guard, and every hook it offers writes, spawns, copies and opens nothing", async () => {
    const { record, results } = await runUnderSeam(parity);
    expect(record.overlayLoad).toEqual({ guardActive: true });
    expect(record.writes).toEqual([]);
    expect(record.spawns).toEqual([]);
    expect(record.clipboard).toEqual([]);
    expect(record.dialogs).toEqual([]);
    expect(record.shell).toEqual([]);
    expect(record.tripped).toEqual([]);

    expect(results.defaultCopy).toMatchObject({ success: false });
    expect(results.defaultSave).toMatchObject({ success: false });
    expect(results.valueCopy).toEqual({ success: true });
    expect(results.holdSave).toBe("pending");
    expect(results.afterReset).toMatchObject({ success: false });
    expect(results.realCallOther.returned).toMatchObject({ hasUpdate: true });
    expect(results.launchInstall.returned).toMatchObject({ hasUpdate: true });
    expect(results.emitted).toEqual([["update:progress", 42]]);
    expect(results.probe).toEqual([
      expect.objectContaining({
        doubleClick: { registered: true, calls: ["show", "focus"] },
        items: [
          { label: "Show Window", calls: ["show", "focus"] },
          { label: "Quit", calls: ["app.quit"] },
        ],
      }),
    ]);
  });

  test("realCall refuses both export channels, so one step can never write the clipboard or open a save dialog", async () => {
    const { record, results } = await runUnderSeam(parity);
    expect(results.realCallCopy.threw).toMatch(/refuses copyCardImage/);
    expect(results.realCallSave.threw).toMatch(/refuses exportCardImage/);
    expect(record.tripped).toEqual([]);
    expect(record.clipboard).toEqual([]);
    expect(record.dialogs).toEqual([]);
  });

  test("the notes hook leaves out the draft and the prereleases the fake lists", async () => {
    const { results } = await runUnderSeam(parity);
    expect(results.notes.returned.releases.map((r: { version: string }) => r.version)).toEqual([
      "1.2.1",
      "1.2.0",
      "1.1.2",
      "1.1.1",
      "1.1.0",
    ]);
  });

  test("the guard check fails when seam.cjs requires the overlay hooks before its guards", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bmt-misordered-"));
    fs.mkdirSync(path.join(dir, "lib"));
    fs.copyFileSync(
      path.join(parity, "lib/real-folder.cjs"),
      path.join(dir, "lib/real-folder.cjs"),
    );
    fs.copyFileSync(path.join(parity, "seam-overlays.cjs"), path.join(dir, "seam-overlays.cjs"));
    const seam = fs.readFileSync(path.join(parity, "seam.cjs"), "utf8");
    const requireLine = 'require("./seam-overlays.cjs");\n';
    expect(seam).toContain(requireLine);
    const misordered = seam
      .replace(requireLine, "")
      .replace('const fs = require("fs");', requireLine + 'const fs = require("fs");');
    fs.writeFileSync(path.join(dir, "seam.cjs"), misordered);
    const { record } = await runUnderSeam(dir);
    expect(record.overlayLoad).toEqual({ guardActive: false });
  });
});
