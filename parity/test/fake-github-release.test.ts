import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFakeGithub } from "../fake-github.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-github-test-"));
const zip = path.join(dir, "app.zip");
fs.writeFileSync(zip, Buffer.alloc(70_000, 7));
const digest = new Bun.CryptoHasher("sha256").update(fs.readFileSync(zip)).digest("hex");
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const NAME = "BetterMayhemTracker-mac-arm64.zip";

test("serves a real file under its asset name, digest, and a redirect to the objects host", async () => {
  const fake = startFakeGithub({
    release: { latest: "1.3.0", assets: [{ name: NAME, file: zip }] },
  });
  try {
    for (const prefix of ["", "/api.github.com"]) {
      const page = await (
        await fetch(
          `${fake.url}${prefix}/repos/rambo0247/better-mayhem-tracker/releases?per_page=20`,
        )
      ).json();
      expect(page[0].tag_name).toBe("v1.3.0");
      expect(page[0].assets[0]).toEqual({
        name: NAME,
        size: 70_000,
        digest: `sha256:${digest}`,
        browser_download_url: `https://github.com/rambo0247/better-mayhem-tracker/releases/download/v1.3.0/${NAME}`,
      });
      expect(page.slice(1).every((r: { assets: unknown[] }) => r.assets.length === 0)).toBe(true);
    }
    const download = `${fake.url}/github.com/rambo0247/better-mayhem-tracker/releases/download/v1.3.0/${NAME}`;
    const hop = await fetch(download, { redirect: "manual" });
    expect(hop.status).toBe(302);
    expect(hop.headers.get("location")).toStartWith("http://localhost:");
    const body = await fetch(download);
    expect(body.headers.get("content-length")).toBe("70000");
    expect(new Bun.CryptoHasher("sha256").update(await body.arrayBuffer()).digest("hex")).toBe(
      digest,
    );
  } finally {
    fake.close();
  }
});

test("a bad digest is served as all zeros", async () => {
  const fake = startFakeGithub({
    release: { latest: "1.3.0", assets: [{ name: NAME, file: zip }], badDigest: true },
  });
  try {
    const page = await (
      await fetch(`${fake.url}/repos/rambo0247/better-mayhem-tracker/releases`)
    ).json();
    expect(page[0].assets[0].digest).toBe(`sha256:${"0".repeat(64)}`);
  } finally {
    fake.close();
  }
});
