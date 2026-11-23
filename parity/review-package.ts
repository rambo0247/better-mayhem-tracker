/**
 * The operator's review package: for every review-gated unit, its review screenshots, a
 * labelled side-by-side for each, and a 30 to 60 s video, all from one Tauri build, under
 * `parity/out/review/`, with `index.md` listing each unit, what changed in its interaction, and
 * its files.
 *
 *   bun parity/review-package.ts --electron <capture dir> --tauri <capture dir>
 *     [--out parity/out/review] [--unit T27 | --units T27,T31] [--binary <driver build>]
 *     [--tools <dir>]
 *     [--trunk <rev>] [--no-capture]
 *
 * `--electron` and `--tauri` are one capture of each app, normally `report.ts run`'s
 * `electron-<platform>` and `tauri-<platform>` folders, so the package shows the same run the
 * parity report judges. A state either folder lacks is captured into it first, with
 * `--binary` for Tauri, unless `--no-capture` lists it as missing instead. T10's shell review runs its own script against the same build.
 *
 * Every frame is written as 8-bit RGB PNG: ffmpeg's fps filter drops frames where the input's
 * pixel format changes, and ImageMagick keeps a 16-bit source at 16 bits.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { CROSS_ENGINE, diffFiles } from "./diff.ts";
import { PARITY_DIR, REPO_DIR } from "./lib/data.ts";
import { underE1 } from "./report.ts";

/** One picture in a unit's review: a state both apps capture, and what it shows. */
export interface Shot {
  lane: number;
  state: string;
  slug: string;
  shows: string;
}

/** A lane the gate names that this package cannot show, with the reason. */
export interface Gap {
  lane: number;
  reason: string;
}

export interface ReviewUnit {
  id: string;
  title: string;
  /** What changed in the unit's interaction, for index.md. */
  change: string;
  shots: Shot[];
  gaps: Gap[];
  /** A unit whose review is its own script (window chrome and tray need native pictures). */
  script?: { file: string; args: (binary: string | undefined) => string[]; outputs: RegExp };
}

const WINDOWS_ONLY = "a Windows lane; this package runs on macOS";

export const REVIEW_UNITS: ReviewUnit[] = [
  {
    id: "T10",
    title: "Window, tray, single instance, and quit flow",
    change:
      "The window chrome, tray menu, close to tray, Show Window, second launch, hidden launch and quit now come from Rust in place of Electron's main process.",
    shots: [],
    gaps: [
      { lane: 2, reason: WINDOWS_ONLY },
      { lane: 8, reason: WINDOWS_ONLY },
    ],
    script: {
      file: "window-review.ts",
      args: () => ["--data", "fixture"],
      outputs: /^T10-review/,
    },
  },
  {
    id: "T23",
    title: "Autostart, the Start Menu shortcut, and the app id",
    change:
      "Turning Start with the system on or off writes the same LaunchAgent plist as Electron, now from Rust; the Settings toggle drives it.",
    shots: [
      {
        lane: 1,
        state: "settings-default",
        slug: "settings",
        shows: "Settings, at the top, with the Start with the system toggle",
      },
    ],
    gaps: [
      {
        lane: 4,
        reason:
          "moving the bundle needs autostart-review.ts on a release-profile lane build with its own bundle id; install_location counts only release builds as installed",
      },
      { lane: 6, reason: WINDOWS_ONLY },
      { lane: 7, reason: WINDOWS_ONLY },
    ],
  },
  {
    id: "T24",
    title: "The updater and the hand-off from Electron 1.2.1",
    change:
      "Update checks, the header's Update available button, the download with its progress bar, and What's New after a relaunch now run on the Rust updater.",
    shots: [
      {
        lane: 4,
        state: "overlay-update-button",
        slug: "update-button",
        shows: "Match History with Update available in the header",
      },
      {
        lane: 5,
        state: "overlay-update-downloading",
        slug: "update-downloading",
        shows: "The Update dialog downloading, its progress bar part way",
      },
      {
        lane: 8,
        state: "overlay-whats-new-multi",
        slug: "whats-new",
        shows: "What's New listing the release notes of several releases",
      },
    ],
    gaps: [
      {
        lane: 1,
        reason:
          "the hand-off installs packaged Electron 1.2.1 and relaunches into a Tauri release; it does not run on the parity driver build",
      },
      { lane: 2, reason: WINDOWS_ONLY },
    ],
  },
  {
    id: "T25",
    title: "Card image export",
    change:
      "Export as PNG and Copy render the game and season cards to an 1800 px image from the native webview in place of Electron's capturePage.",
    shots: [
      {
        lane: 1,
        state: "game-card-default",
        slug: "game-card",
        shows: "The newest game's card at /card/<id>, as the export renders it",
      },
      {
        lane: 2,
        state: "season-card-default",
        slug: "season-card",
        shows: "The season card at /season-card/<id>, as the export renders it",
      },
      {
        lane: 3,
        state: "overlay-export-copied",
        slug: "copied",
        shows: "The export pill after Copy",
      },
      {
        lane: 4,
        state: "overlay-export-saved",
        slug: "saved",
        shows: "The export pill after Export as PNG saved a file",
      },
    ],
    gaps: [{ lane: 7, reason: WINDOWS_ONLY }],
  },
  {
    id: "T27",
    title: "UI shell, styles, router, hooks, and shared components",
    change:
      "The header, nav, status dot, routing and shared components are Solid 2 in place of React 19; the champion portraits clip with a wrapper because WKWebView ignores object-view-box.",
    shots: [
      {
        lane: 1,
        state: "match-history-empty-waiting",
        slug: "chrome-mac",
        shows: "The Layout chrome on Match History's empty state",
      },
      {
        lane: 3,
        state: "match-history-rail-1179",
        slug: "chrome-rail",
        shows: "The rail layout at 1179 px wide",
      },
      {
        lane: 6,
        state: "champions-default",
        slug: "portraits",
        shows: "Champions, a grid of champion portraits",
      },
    ],
    gaps: [{ lane: 2, reason: WINDOWS_ONLY }],
  },
  {
    id: "T28",
    title: "Records and Augments",
    change:
      "The Records and Augments pages are Solid 2: record cards open their match, the Augments table filters, sorts and expands.",
    shots: [
      { lane: 1, state: "records-default", slug: "records", shows: "Records, loaded" },
      {
        lane: 4,
        state: "overlay-records-modal",
        slug: "records-modal",
        shows: "A record card's match open in the modal",
      },
      { lane: 6, state: "augments-default", slug: "augments", shows: "Augments, loaded" },
      {
        lane: 6,
        state: "overlay-hover-augment-prismatic",
        slug: "augments-prismatic",
        shows: "A Prismatic augment's hover card",
      },
    ],
    gaps: [{ lane: 9, reason: WINDOWS_ONLY }],
  },
  {
    id: "T29",
    title: "Season Recap and the two card routes",
    change:
      "Season Recap and the /card and /season-card routes are Solid 2; the preview scales without CSS zoom.",
    shots: [
      { lane: 1, state: "season-recap-default", slug: "season", shows: "Season Recap, loaded" },
      {
        lane: 5,
        state: "game-card-default",
        slug: "game-card",
        shows: "/card/<id> opened directly",
      },
      {
        lane: 6,
        state: "season-card-default",
        slug: "season-card",
        shows: "/season-card/<id> opened directly",
      },
      {
        lane: 6,
        state: "season-card-numbered",
        slug: "season-card-numbered",
        shows: "/season-card/<id> for a numbered season",
      },
    ],
    gaps: [{ lane: 4, reason: "no state in states.ts resizes Season Recap to 900 px" }],
  },
  {
    id: "T30",
    title: "Challenges",
    change: "The Challenges page is Solid 2, online and offline.",
    shots: [
      {
        lane: 1,
        state: "challenges-loaded",
        slug: "challenges",
        shows: "Challenges, loaded from the client",
      },
      {
        lane: 2,
        state: "challenges-offline-stored",
        slug: "challenges-offline",
        shows: "Challenges with the client offline, from stored data",
      },
      {
        lane: 2,
        state: "challenges-offline-empty",
        slug: "challenges-offline-empty",
        shows: "Challenges with the client offline and nothing stored",
      },
    ],
    gaps: [{ lane: 5, reason: "the tier-up push from the fake client has no capture state" }],
  },
  {
    id: "T31",
    title: "Champions",
    change: "The Champions table is Solid 2: sort, filter menu, search, expanded rows.",
    shots: [
      { lane: 1, state: "champions-default", slug: "champions", shows: "Champions, loaded" },
      {
        lane: 5,
        state: "champions-expanded",
        slug: "champions-expanded",
        shows: "Champions with a row expanded",
      },
      {
        lane: 5,
        state: "overlay-filter-menu-champions",
        slug: "champions-filter",
        shows: "Champions with the filter menu open",
      },
    ],
    gaps: [
      { lane: 4, reason: "typing a search one key at a time has no capture state" },
      { lane: 6, reason: "following a recent game to Match History has no capture state" },
    ],
  },
  {
    id: "T32",
    title: "Friends, friend detail, and group detail",
    change:
      "Friends, a friend's page and a group's page are Solid 2, with the sticky player heads on group detail.",
    shots: [
      { lane: 1, state: "friends-default", slug: "friends", shows: "Friends, the players view" },
      { lane: 4, state: "friend-detail-default", slug: "friend-detail", shows: "A friend's page" },
      { lane: 5, state: "group-detail-default", slug: "group-detail", shows: "A group's page" },
      {
        lane: 8,
        state: "overlay-filter-menu-friends",
        slug: "friends-filter",
        shows: "Friends with the filter menu open",
      },
    ],
    gaps: [],
  },
  {
    id: "T33",
    title: "Global Stats and champion detail",
    change: "Global Stats' three tabs and the champion detail page are Solid 2.",
    shots: [
      {
        lane: 1,
        state: "global-stats-default",
        slug: "global",
        shows: "Global Stats, the champions tab",
      },
      {
        lane: 4,
        state: "global-champion-detail-default",
        slug: "champion-detail",
        shows: "A champion's detail page",
      },
      {
        lane: 6,
        state: "global-stats-augments",
        slug: "global-augments",
        shows: "Global Stats, the augments tab",
      },
      {
        lane: 6,
        state: "global-stats-items",
        slug: "global-items",
        shows: "Global Stats, the items tab",
      },
    ],
    gaps: [],
  },
  {
    id: "T34",
    title: "Live Game",
    change:
      "The Live Game page is Solid 2: in game, waiting for results, standby, and the session recap.",
    shots: [
      { lane: 1, state: "live-in-game", slug: "live", shows: "Live Game during a game" },
      {
        lane: 3,
        state: "live-results-late",
        slug: "live-waiting",
        shows: "Live Game waiting for late results",
      },
      {
        lane: 4,
        state: "live-standby-connected",
        slug: "live-standby",
        shows: "Live Game on standby, client connected",
      },
      {
        lane: 6,
        state: "live-game-over-recorded",
        slug: "recap",
        shows: "The recap after a recorded game",
      },
    ],
    gaps: [],
  },
  {
    id: "T35",
    title: "Trends",
    change: "The Trends charts are Solid 2, with the same SVG paths and tooltips.",
    shots: [
      { lane: 1, state: "trends-default", slug: "trends", shows: "Trends, loaded" },
      {
        lane: 4,
        state: "overlay-hover-trends-chart",
        slug: "trends-tooltip",
        shows: "A point's tooltip on the first chart",
      },
      { lane: 5, state: "trends-weekly", slug: "trends-week", shows: "Trends by week" },
    ],
    gaps: [],
  },
  {
    id: "T36",
    title: "Settings",
    change:
      "The Settings page is Solid 2: every section, backups, import, autostart and tray toggles.",
    shots: [
      { lane: 1, state: "settings-default", slug: "settings-mac", shows: "Settings, at the top" },
    ],
    gaps: [
      { lane: 2, reason: WINDOWS_ONLY },
      { lane: 3, reason: "scrolling to each section has no capture state" },
      { lane: 5, reason: "the tray toggle's effect is a close, a log and not a picture" },
    ],
  },
  {
    id: "T37",
    title: "Match History",
    change:
      "Match History is Solid 2: rows, expanded scoreboards, filters, the context menu and the narrow layouts.",
    shots: [
      { lane: 1, state: "match-history-default", slug: "mh", shows: "Match History, loaded" },
      {
        lane: 4,
        state: "match-history-expanded",
        slug: "mh-expanded",
        shows: "Match History with a row expanded",
      },
      { lane: 5, state: "overlay-context-menu", slug: "mh-context", shows: "A row's context menu" },
      {
        lane: 6,
        state: "overlay-filter-menu-match-history",
        slug: "mh-filter",
        shows: "Match History with the filter menu open",
      },
      {
        lane: 8,
        state: "match-history-narrow-900",
        slug: "mh-narrow",
        shows: "Match History at 900 px wide",
      },
    ],
    gaps: [],
  },
  {
    id: "T38",
    title: "Dialogs, banners, and toasts",
    change:
      "The Update and What's New dialogs, the recovery banners and the activity toast are Solid 2.",
    shots: [
      {
        lane: 1,
        state: "overlay-update-dialog",
        slug: "update-dialog",
        shows: "The Update dialog, manual variant",
      },
      {
        lane: 3,
        state: "overlay-whats-new-multi",
        slug: "whats-new",
        shows: "What's New with several releases",
      },
      {
        lane: 4,
        state: "overlay-recovery-missing-restored-kept",
        slug: "recovery-restored",
        shows: "The recovery banner after a missing database was restored",
      },
      {
        lane: 4,
        state: "overlay-recovery-corrupt-empty-unkept",
        slug: "recovery-corrupt",
        shows: "The recovery banner after a corrupt database started empty",
      },
      {
        lane: 5,
        state: "backfill-toast-running",
        slug: "toast-running",
        shows: "The backfill toast while it runs",
      },
      {
        lane: 5,
        state: "backfill-toast-done",
        slug: "toast-done",
        shows: "The backfill toast when it is done",
      },
    ],
    gaps: [],
  },
];

// Pictures

const FONT = "/System/Library/Fonts/Supplemental/Arial.ttf";
const BG = "#0f1115";
const magick = (...argv: string[]) => execFileSync("magick", argv, { stdio: "pipe" });
const png8 = (target: string) => ["-alpha", "off", "-depth", "8", `PNG24:${target}`];

const textBox = (width: number, height: number, size: number, text: string) => [
  "(",
  "-size",
  `${width}x${height}`,
  "-background",
  BG,
  "-fill",
  "#e8e8e8",
  "-font",
  FONT,
  "-pointsize",
  String(size),
  "-gravity",
  "center",
  `caption:${text}`,
  ")",
];

/** A picture under its label, scaled to `width`. */
function labelled(src: string, label: string, width: number, target: string) {
  magick(
    ...textBox(width, 56, 22, label),
    "(",
    src,
    "-resize",
    `${width}x`,
    ")",
    "-background",
    BG,
    "-append",
    ...png8(target),
  );
  return target;
}

function beside(parts: string[], target: string) {
  magick(
    ...parts,
    "-background",
    BG,
    "-gravity",
    "west",
    "-splice",
    "16x0",
    "+append",
    ...png8(target),
  );
  return target;
}

/** A 1920 by 1080 video frame: the caption bar over the picture, letterboxed. */
function videoFrame(src: string, caption: string, target: string) {
  magick(
    ...textBox(1840, 80, 28, caption),
    "-gravity",
    "center",
    "-extent",
    "1920x80",
    "(",
    src,
    "-resize",
    "1920x1000",
    "-background",
    BG,
    "-gravity",
    "center",
    "-extent",
    "1920x1000",
    ")",
    "-append",
    ...png8(target),
  );
  return target;
}

export interface Frame {
  file: string;
  caption: string;
  seconds: number;
}

/** Seconds per frame so the whole video runs 30 to 60 s, near 5 s a frame. */
export function frameSeconds(frames: number): number {
  const total = Math.min(60, Math.max(30, frames * 5));
  return +(total / frames).toFixed(2);
}

function writeVideo(frames: Frame[], target: string) {
  // Each still is its own looped input cut to its length, so every frame plays for exactly its
  // seconds; the concat demuxer stretched the last one
  execFileSync("ffmpeg", [
    "-y",
    "-loglevel",
    "error",
    ...frames.flatMap((f) => [
      "-loop",
      "1",
      "-framerate",
      "30",
      "-t",
      String(f.seconds),
      "-i",
      f.file,
    ]),
    "-filter_complex",
    `${frames.map((_, i) => `[${i}:v]`).join("")}concat=n=${frames.length}:v=1:a=0,format=yuv420p[v]`,
    "-map",
    "[v]",
    "-c:v",
    "libx264",
    target,
  ]);
  const probe = spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-count_frames",
      "-show_entries",
      "stream=nb_read_frames:format=duration",
      "-of",
      "json",
      target,
    ],
    { encoding: "utf8" },
  );
  const parsed = JSON.parse(probe.stdout) as {
    streams: { nb_read_frames: string }[];
    format: { duration: string };
  };
  const seconds = frames.reduce((sum, f) => sum + f.seconds, 0);
  const expected = Math.round(seconds * 30);
  const read = Number(parsed.streams[0]?.nb_read_frames ?? 0);
  // The fps filter drops or duplicates frames on a format change; a whole video at 30 fps says
  // none did
  if (Math.abs(read - expected) > frames.length) {
    throw new Error(`${target}: ${read} frames, expected ${expected}`);
  }
  return { seconds: Number(parsed.format.duration), frames: read };
}

// Running

interface Options {
  electron: string;
  tauri: string;
  out: string;
  units: ReviewUnit[];
  binary?: string;
  tools?: string;
  heads: { electron: string; tauri: string };
}

function captureMissing(app: "electron" | "tauri", dir: string, states: string[], o: Options) {
  const missing = states.filter((s) => !fs.existsSync(path.join(dir, `${s}.png`)));
  if (missing.length === 0) return;
  const cmd = [
    "bun",
    "parity/capture.ts",
    "--app",
    app,
    ...(app === "tauri" ? ["--renderer", "solid"] : []),
    "--data",
    "fixture",
    "--states",
    missing.join(","),
    "--out",
    dir,
    ...(app === "tauri" && o.binary ? ["--binary", o.binary] : []),
  ];
  launch(cmd, o);
}

function launch(cmd: string[], o: Options, env: Record<string, string> = {}) {
  const prefix: string[] = [];
  if (o.tools) {
    execFileSync(path.join(o.tools, "wait-no-game.sh"), { stdio: "inherit" });
    prefix.push(path.join(o.tools, "capture-slot.sh"));
  } else if (process.platform === "darwin" && process.env.CI !== "true") {
    throw new Error("pass --tools <dir with wait-no-game.sh and capture-slot.sh>");
  }
  console.log(`review: ${[...prefix, ...cmd].join(" ")}`);
  const result = spawnSync(
    prefix[0] ?? cmd[0]!,
    [...prefix.slice(1), ...(prefix.length ? cmd : cmd.slice(1))],
    {
      cwd: REPO_DIR,
      stdio: "inherit",
      env: { ...process.env, ...env } as Record<string, string>,
    },
  );
  return result.status ?? 1;
}

interface UnitResult {
  unit: ReviewUnit;
  files: string[];
  missing: { what: string; reason: string }[];
  video?: { seconds: number; frames: number };
}

function packUnit(unit: ReviewUnit, o: Options): UnitResult {
  const work = path.join(o.out, `${unit.id}-work`);
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  const files: string[] = [];
  const missing: UnitResult["missing"] = [];
  const frames: Frame[] = [];
  const left = `Electron 1.2.1 (trunk ${o.heads.electron.slice(0, 7)})`;
  const right = `Tauri (head ${o.heads.tauri.slice(0, 7)})`;
  for (const shot of unit.shots) {
    const e = path.join(o.electron, `${shot.state}.png`);
    const t = path.join(o.tauri, `${shot.state}.png`);
    const absent = [e, t].filter((f) => !fs.existsSync(f));
    if (absent.length > 0) {
      missing.push({
        what: `lane ${shot.lane} ${shot.state}`,
        reason: `no capture: ${absent.map((f) => path.relative(REPO_DIR, f)).join(", ")}`,
      });
      continue;
    }
    const geometry = (dir: string) => path.join(dir, `${shot.state}.geometry.json`);
    const prefix = path.join(work, shot.slug);
    const result = diffFiles(e, t, {
      policy: "cross-engine",
      geometry:
        fs.existsSync(geometry(o.electron)) && fs.existsSync(geometry(o.tauri))
          ? [geometry(o.electron), geometry(o.tauri)]
          : undefined,
      scale: 2,
      outPrefix: prefix,
    });
    const verdict = `${underE1(result) ? "PASS" : "FAIL"} under E1, ${result.differingPct.toFixed(3)}% of pixels differ`;
    const base = `${unit.id}-review-${shot.slug}`;
    const screenshot = path.join(o.out, `${base}.png`);
    labelled(t, `${shot.shows}. ${right}`, 1280, screenshot);
    const pair = beside(
      [
        labelled(e, left, 940, path.join(work, `${shot.slug}-e.png`)),
        labelled(t, right, 940, path.join(work, `${shot.slug}-t.png`)),
      ],
      path.join(work, `${shot.slug}-pair.png`),
    );
    const diffPanel = labelled(
      `${prefix}.diff.png`,
      `Red: pixels that differ at threshold ${CROSS_ENGINE.threshold}. Yellow: anti-aliasing, not counted. ${verdict}`,
      940,
      path.join(work, `${shot.slug}-diff.png`),
    );
    const sideBySide = path.join(o.out, `${base}-side-by-side.png`);
    magick(
      ...textBox(2836, 64, 26, `${unit.id} lane ${shot.lane}: ${shot.shows}`),
      "(",
      beside([pair, diffPanel], path.join(work, `${shot.slug}-row.png`)),
      ")",
      "-background",
      BG,
      "-append",
      ...png8(sideBySide),
    );
    files.push(screenshot, sideBySide);
    const pairCaption = `${shot.shows}. Left: Electron 1.2.1. Right: Tauri.`;
    const diffCaption = `${shot.shows}. Red marks pixels Tauri draws differently from Electron 1.2.1.`;
    frames.push({
      file: videoFrame(pair, pairCaption, path.join(work, `frame-${frames.length}.png`)),
      caption: pairCaption,
      seconds: 0,
    });
    frames.push({
      file: videoFrame(diffPanel, diffCaption, path.join(work, `frame-${frames.length}.png`)),
      caption: diffCaption,
      seconds: 0,
    });
  }
  let video: UnitResult["video"];
  if (frames.length > 0) {
    // Beyond 12 pictures the diff frames go, so every pair still gets about 5 s within 60 s
    const kept = frames.length > 12 ? frames.filter((_, i) => i % 2 === 0) : frames;
    const seconds = frameSeconds(kept.length);
    for (const f of kept) f.seconds = seconds;
    const target = path.join(o.out, `${unit.id}-review.mp4`);
    video = writeVideo(kept, target);
    files.push(target);
  }
  return { unit, files, missing, video };
}

function runScript(unit: ReviewUnit, o: Options): UnitResult {
  const script = unit.script!;
  const file = path.join(PARITY_DIR, script.file);
  if (!fs.existsSync(file)) {
    return { unit, files: [], missing: [{ what: script.file, reason: "not in this tree" }] };
  }
  // The script launches through run-tauri.ts, which finds the build under CARGO_TARGET_DIR
  const env: Record<string, string> = {};
  if (o.binary) env.CARGO_TARGET_DIR = path.resolve(path.dirname(o.binary), "..");
  const code = launch(
    ["bun", path.relative(REPO_DIR, file), ...script.args(o.binary), "--out", o.out],
    o,
    env,
  );
  const files = fs
    .readdirSync(o.out)
    .filter((f) => script.outputs.test(f) && /\.(png|mp4)$/.test(f))
    .map((f) => path.join(o.out, f));
  const missing = code === 0 ? [] : [{ what: script.file, reason: `exited ${code}` }];
  return { unit, files, missing };
}

/** One unit's index.md section, kept in `<out>/sections/` so a one-unit run keeps the others. */
export function renderSection(r: UnitResult, o: Pick<Options, "heads" | "out">): string {
  const rel = (f: string) => path.relative(o.out, f);
  const lines = [
    `## ${r.unit.id}. ${r.unit.title}`,
    "",
    r.unit.change,
    "",
    `Made ${new Date().toISOString()} from Electron trunk ${o.heads.electron.slice(0, 10)} and Tauri head ${o.heads.tauri.slice(0, 10)}.`,
    "",
  ];
  if (r.video) {
    lines.push(
      `- Video: \`${rel(path.join(o.out, `${r.unit.id}-review.mp4`))}\`, ${r.video.seconds.toFixed(1)} s, ${r.video.frames} frames.`,
    );
  }
  for (const f of r.files.filter((f) => f.endsWith(".png"))) lines.push(`- \`${rel(f)}\``);
  for (const f of r.files.filter((f) => f.endsWith(".mp4") && !r.video)) {
    lines.push(`- Video: \`${rel(f)}\``);
  }
  for (const m of r.missing) lines.push(`- Missing, ${m.what}: ${m.reason}.`);
  for (const g of r.unit.gaps) lines.push(`- Not in this package, lane ${g.lane}: ${g.reason}.`);
  return `${lines.join("\n")}\n`;
}

/** index.md from every unit section on disk, in unit order. */
export function writeIndex(out: string) {
  const dir = path.join(out, "sections");
  const sections = REVIEW_UNITS.map((u) => path.join(dir, `${u.id}.md`))
    .filter((f) => fs.existsSync(f))
    .map((f) => fs.readFileSync(f, "utf8"));
  const pending = REVIEW_UNITS.filter((u) => !fs.existsSync(path.join(dir, `${u.id}.md`)));
  const lines = [
    "# Review package",
    "",
    "The operator accepted every review gate in advance on 2026-11-23, so these media are the record and nothing waits on them.",
    "",
    "Generated by `bun parity/review-package.ts`. Each `-side-by-side.png` is Electron 1.2.1, Tauri, and the cross-engine diff. Each `<unit>-review-<slug>.png` is Tauri's screenshot under what it shows.",
    "",
    ...(pending.length ? [`Not yet packaged: ${pending.map((u) => u.id).join(", ")}.`, ""] : []),
    ...sections,
  ];
  fs.writeFileSync(path.join(out, "index.md"), lines.join("\n"));
}

function git(rev: string) {
  return execFileSync("git", ["-C", REPO_DIR, "rev-parse", rev], { encoding: "utf8" }).trim();
}

async function main() {
  const argv = process.argv.slice(2);
  const value = (flag: string) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
  const noCapture = argv.includes("--no-capture");
  if (noCapture) argv.splice(argv.indexOf("--no-capture"), 1);
  const known = [
    "--electron",
    "--tauri",
    "--out",
    "--unit",
    "--units",
    "--binary",
    "--tools",
    "--trunk",
  ];
  for (let i = 0; i < argv.length; i += 2) {
    if (!known.includes(argv[i]!)) {
      console.error(
        `unknown flag ${argv[i]}. usage: bun parity/review-package.ts --electron <dir> --tauri <dir> [${known.slice(2).join(" ")}]`,
      );
      process.exit(2);
    }
  }
  const electron = value("--electron");
  const tauri = value("--tauri");
  if (!electron || !tauri) {
    console.error(
      "usage: bun parity/review-package.ts --electron <capture dir> --tauri <capture dir>",
    );
    process.exit(2);
  }
  const wanted = (value("--unit") ?? value("--units"))?.split(",");
  const unknown = wanted?.filter((id) => !REVIEW_UNITS.some((u) => u.id === id)) ?? [];
  if (unknown.length > 0) {
    console.error(
      `unknown unit ${unknown.join(", ")}. Gated units: ${REVIEW_UNITS.map((u) => u.id).join(", ")}`,
    );
    process.exit(2);
  }
  const o: Options = {
    electron: path.resolve(electron),
    tauri: path.resolve(tauri),
    out: path.resolve(value("--out") ?? path.join(PARITY_DIR, "out", "review")),
    units: REVIEW_UNITS.filter((u) => !wanted || wanted.includes(u.id)),
    binary: value("--binary") && path.resolve(value("--binary")!),
    tools: value("--tools") && path.resolve(value("--tools")!),
    heads: { electron: git(value("--trunk") ?? "main"), tauri: git("HEAD") },
  };
  fs.mkdirSync(o.out, { recursive: true });
  const states = [...new Set(o.units.flatMap((u) => u.shots.map((s) => s.state)))];
  if (!noCapture) {
    captureMissing("electron", o.electron, states, o);
    captureMissing("tauri", o.tauri, states, o);
  }
  const results = o.units.map((u) => (u.script ? runScript(u, o) : packUnit(u, o)));
  fs.mkdirSync(path.join(o.out, "sections"), { recursive: true });
  for (const r of results) {
    fs.writeFileSync(path.join(o.out, "sections", `${r.unit.id}.md`), renderSection(r, o));
  }
  writeIndex(o.out);
  for (const r of results) {
    console.log(
      `${r.unit.id}: ${r.files.length} files${r.video ? `, video ${r.video.seconds.toFixed(1)} s` : ""}${r.missing.length ? `, ${r.missing.length} missing` : ""}`,
    );
  }
  console.log(`review: wrote ${path.join(o.out, "index.md")}`);
}

if (import.meta.main) await main();
