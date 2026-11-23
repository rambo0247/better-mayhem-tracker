import { afterAll, describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { DOWNLOAD_PATH, RELEASES_PATH, SCENARIOS, startFakeGithub, type Scenario } from "../fake-github.ts";

const { rewriteGithubUrl } = createRequire(import.meta.url)("../seam-overlays.cjs") as {
  rewriteGithubUrl: (url: string, base: string, scenario: string) => string | null;
};

const server = startFakeGithub();
afterAll(() => server.close());

const fetchReleases = async (scenario: Scenario) => {
  const response = await fetch(`${server.url}${RELEASES_PATH}?per_page=20&scenario=${scenario}`);
  return (await response.json()) as {
    tag_name: string;
    assets: { name: string; browser_download_url: string }[];
  }[];
};

describe("fake GitHub", () => {
  test("every scenario serves a newest-first list with a tag on each release", async () => {
    for (const scenario of SCENARIOS) {
      const releases = await fetchReleases(scenario);
      expect(releases.length).toBeGreaterThan(0);
      expect(releases.every((r) => /^v\d+\.\d+\.\d+$/.test(r.tag_name))).toBe(true);
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

  test("the seam sends a github.com asset URL to the fake, which stalls the download", async () => {
    const [newest] = await fetchReleases("downloading");
    const url = newest!.assets[0]!.browser_download_url;
    const target = rewriteGithubUrl(url, server.url, "downloading");
    expect(target).toBe(server.url + url.slice("https://github.com".length));
    expect(new URL(target!).pathname.startsWith(DOWNLOAD_PATH)).toBe(true);
    const response = await fetch(target!);
    expect(response.headers.get("content-length")).toBe("91234567");
    await response.body?.cancel();
  });

  test("the seam sends the releases page to the fake with the scenario, and leaves other URLs alone", () => {
    const page = rewriteGithubUrl(
      "https://api.github.com/repos/rambo0247/better-mayhem-tracker/releases?per_page=20",
      server.url,
      "update-multi",
    );
    expect(page).toBe(`${server.url}${RELEASES_PATH}?per_page=20&scenario=update-multi`);
    expect(rewriteGithubUrl("https://github.com/other/repo/releases/download/v1/x", server.url, "x")).toBeNull();
    expect(rewriteGithubUrl("https://example.com/", server.url, "x")).toBeNull();
  });

  test("an unknown scenario is a 400, not an empty list", async () => {
    const response = await fetch(`${server.url}${RELEASES_PATH}?scenario=nope`);
    expect(response.status).toBe(400);
  });
});
