/**
 * Stands in for GitHub's releases API so the updater and the What's New dialog get
 * release data without the network. The seam rewrites the app's requests to
 * api.github.com and the asset downloads on github.com onto this server. The release page
 * gets the scenario as a query parameter. Every download URL it hands out is a github.com
 * one, as the real API's are, so the app's prefix check on download URLs passes.
 */
export const SCENARIOS = [
  "up-to-date",
  "update-available",
  "update-multi",
  "update-many",
  "update-no-asset",
  "downloading",
  "notes-single",
  "notes-multi",
] as const;
export type Scenario = (typeof SCENARIOS)[number];
export const isScenario = (value: string): value is Scenario =>
  (SCENARIOS as readonly string[]).includes(value);

export const RELEASES_PATH = "/repos/rambo0247/better-mayhem-tracker/releases";
export const DOWNLOAD_PATH = "/rambo0247/better-mayhem-tracker/releases/download/";
const REPO_URL = "https://github.com/rambo0247/better-mayhem-tracker";
// What the releases page reports for the update dialog's size line. The download itself is
// PAYLOAD, small and real, so its digest and content-length are honest.
const ASSET_BYTES = 91_234_567;
const PAYLOAD = new TextEncoder().encode("better-mayhem-tracker fake update payload\n");
export const PAYLOAD_DIGEST =
  "sha256:" + new Bun.CryptoHasher("sha256").update(PAYLOAD).digest("hex");

interface Release {
  tag: string;
  date: string;
  body: string;
  draft: boolean;
  prerelease: boolean;
}

/** A tag, or a tag GitHub lists as a draft or a prerelease. */
type Entry = string | { tag: string; draft?: true; prerelease?: true };

const NOTES: Record<string, string> = {
  "1.3.0": [
    "## What's new",
    "",
    "- The Trends page draws win rate by hour of day.",
    "- Match History remembers which session groups you collapsed.",
    "- Fixed a crash when a game ended while the import was running.",
    "",
    "**Full Changelog**: https://github.com/rambo0247/better-mayhem-tracker/compare/v1.2.1...v1.3.0",
  ].join("\n"),
  "1.2.1": [
    "- Focus rings stay inside the control they belong to.",
    "- Card images wait until the champion art has painted.",
    "- The Windows and macOS releases build side by side.",
  ].join("\n"),
  "1.2.0": [
    "## Season recap",
    "",
    "- A shareable recap card for every finished season.",
    "  - Copy it to the clipboard or save it as a PNG.",
    "- `Settings` has a switch to hide friends' names on the card.",
  ].join("\n"),
  "1.1.2": "- Backups now run once an hour while the app is open.",
  "1.1.1": "- Repair PUUIDs from Settings when an account was renamed.",
  "1.1.0": [
    "## Backups",
    "",
    "- Automatic backups with a restore button in Settings.",
    "- Export and import your whole history as a file.",
  ].join("\n"),
  "1.0.0": "First public release.",
};

const note = (version: string) => NOTES[version] ?? `- Fixes and small improvements in ${version}.`;
const stamp = (index: number) => new Date(Date.UTC(2026, 10, 20 - index * 9)).toISOString();

function releaseList(entries: Entry[]): Release[] {
  return entries.map((entry, index) => {
    const {
      tag,
      draft = false,
      prerelease = false,
    } = typeof entry === "string" ? { tag: entry } : entry;
    return { tag, date: stamp(index), body: note(tag), draft, prerelease };
  });
}

const MANY = Array.from({ length: 20 }, (_, i) => `1.${3 + 20 - i}.0`);

const TAGS: Record<Scenario, Entry[]> = {
  "up-to-date": ["1.2.1", "1.2.0", "1.1.2", "1.1.1", "1.1.0", "1.0.0"],
  "update-available": ["1.3.0", "1.2.1", "1.2.0", "1.1.2", "1.1.1", "1.1.0", "1.0.0"],
  "update-multi": ["1.4.0", "1.3.1", "1.3.0", "1.2.1", "1.2.0", "1.1.2", "1.1.1", "1.1.0", "1.0.0"],
  "update-many": MANY,
  "update-no-asset": ["1.3.0", "1.2.1", "1.2.0", "1.1.0"],
  downloading: ["1.3.0", "1.2.1", "1.2.0", "1.1.0"],
  // A prerelease of the installed version parses as 1.2.1, so only the filter keeps it out
  "notes-single": [
    "1.2.1",
    { tag: "1.2.1-rc.1", prerelease: true },
    "1.2.0",
    "1.1.2",
    "1.1.1",
    "1.1.0",
    "1.0.0",
  ],
  "notes-multi": [
    "1.2.1",
    { tag: "1.2.0-rc.1", prerelease: true },
    "1.2.0",
    { tag: "1.1.3", draft: true },
    "1.1.2",
    "1.1.1",
    "1.1.0",
    "1.0.0",
  ],
};

const ASSET_NAMES = [
  "BetterMayhemTracker.exe",
  "BetterMayhemTracker-mac-arm64.zip",
  "BetterMayhemTracker-mac-x64.zip",
  "BetterMayhemTracker-mac-arm64.dmg",
  "BetterMayhemTracker-mac-x64.dmg",
];

export function releasesFor(scenario: Scenario) {
  return releaseList(TAGS[scenario]).map((release, index) => {
    const newest = index === 0;
    const assets =
      scenario === "update-no-asset" && newest
        ? []
        : ASSET_NAMES.map((name) => ({
            name,
            size: ASSET_BYTES,
            digest: PAYLOAD_DIGEST,
            browser_download_url: `${REPO_URL}/releases/download/v${release.tag}/${name}`,
          }));
    return {
      tag_name: `v${release.tag}`,
      name: `Better Mayhem Tracker ${release.tag}`,
      draft: release.draft,
      prerelease: release.prerelease,
      published_at: release.date,
      html_url: `${REPO_URL}/releases/tag/v${release.tag}`,
      body: release.body,
      assets,
    };
  });
}

export interface FakeGithub {
  url: string;
  close(): void;
}

export function startFakeGithub(options: { scenario?: Scenario; port?: number } = {}): FakeGithub {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === RELEASES_PATH) {
        const asked = url.searchParams.get("scenario") ?? options.scenario ?? "up-to-date";
        if (!isScenario(asked)) return new Response(`unknown scenario ${asked}`, { status: 400 });
        return Response.json(releasesFor(asked));
      }
      if (url.pathname.startsWith(DOWNLOAD_PATH)) return new Response(PAYLOAD);
      return new Response("not found", { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    close: () => void server.stop(true),
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const value = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
  const scenario = value("--scenario") ?? "up-to-date";
  if (!isScenario(scenario)) {
    console.error(`unknown scenario ${scenario}. Known: ${SCENARIOS.join(", ")}`);
    process.exit(2);
  }
  const port = value("--port");
  const server = startFakeGithub({ scenario, port: port ? Number(port) : undefined });
  console.log(`ready ${server.url} scenario=${scenario}`);
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
}
