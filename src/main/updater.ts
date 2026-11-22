import { app, BrowserWindow } from "electron";
import { spawn, spawnSync } from "child_process";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { HIDDEN_FLAG } from "./autostart";
import { getSetting, setSetting } from "./db";
import { hasDurableInstall, macAppBundle, portableExe, WINDOWS_EXE_NAME } from "./install-location";
import { macSwapScript } from "./mac-update-script";
import { sendToRenderer } from "./ipc";
import { isBackfillRunning, isMatchUnderway } from "./lcu";
import { isGameRunning } from "./live";
import type { ReleaseNote, UpdateInfo, UpdateNotes } from "../shared/api";

const CHECK_TIMEOUT_MS = 10_000;
// One page covers any realistic gap between installs, for a single request.
const RELEASE_PAGE_SIZE = 20;
// Release bodies are hand-written, but they still arrive over the network, so
// cap what the dialog is asked to lay out.
const MAX_BODY_CHARS = 4_000;
// Applied per chunk rather than to the whole download: the asset is ~90 MB, so
// a total-duration cap would abort a slow but perfectly healthy connection.
// What we actually want to catch is a transfer that has stopped moving.
const DOWNLOAD_STALL_TIMEOUT_MS = 30_000;
// A launch at sign-in can beat the network up, so a failed launch check
// gets a few more tries before the update is left to the header badge.
const LAUNCH_CHECK_ATTEMPTS = 3;
const LAUNCH_RETRY_MS = 60_000;

// The expected hash never leaves the main process: the renderer only echoes
// back an asset URL, so trusting a digest it supplied would verify nothing.
type CachedAsset = { assetUrl: string; sha256: string | null };
let lastCheckedAsset: CachedAsset | null = null;

function parseVersion(version: string): number[] | null {
  const m = version
    .trim()
    .replace(/^v/, "")
    .match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

// Positive when a is newer than b, negative when older, 0 when equal. An
// unparseable tag sorts as older, so a malformed release can never present
// itself as an update.
function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return pa ? 1 : pb ? -1 : 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

function toReleaseNote(release: any): ReleaseNote {
  const body = String(release.body ?? "")
    .replace(/\r\n/g, "\n")
    // GitHub appends this to every generated body; the dialog already links to
    // the release page, so in a small window it is pure noise.
    .replace(/^[ \t]*\*\*Full Changelog\*\*:.*$/gim, "")
    .trim();
  return {
    version: String(release.tag_name).replace(/^v/, ""),
    publishedAt: typeof release.published_at === "string" ? release.published_at : "",
    body: body.length > MAX_BODY_CHARS ? `${body.slice(0, MAX_BODY_CHARS)}…` : body,
    url: typeof release.html_url === "string" ? release.html_url : "",
  };
}

// The release asset this platform installs from: the portable exe on Windows,
// and on macOS the zipped app bundle for this machine's architecture (the dmg
// beside it is for first installs, which need a drag into Applications).
function isInstallAsset(name: unknown): boolean {
  if (typeof name !== "string") return false;
  if (process.platform === "darwin") return name === `BetterMayhemTracker-mac-${process.arch}.zip`;
  return name.endsWith(".exe");
}

// GitHub reports asset digests as "sha256:<hex>"
function parseDigest(digest: unknown): string | null {
  if (typeof digest !== "string") return null;
  const m = digest.match(/^sha256:([0-9a-f]{64})$/i);
  return m ? m[1].toLowerCase() : null;
}

// The newest page of releases, and the part of it that was actually published.
// Null when GitHub gave no usable answer.
async function fetchReleasePage(): Promise<{ page: any[]; published: any[] } | null> {
  const res = await fetch(
    `https://api.github.com/repos/rambo0247/better-mayhem-tracker/releases?per_page=${RELEASE_PAGE_SIZE}`,
    {
      headers: { "User-Agent": "better-mayhem-tracker" },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    },
  );
  if (!res.ok) return null;
  const body = (await res.json()) as unknown;
  const page: any[] = Array.isArray(body) ? body : [];
  // Unlike /releases/latest, this endpoint includes drafts and prereleases,
  // which were never meant to be offered as an update.
  const published = page.filter(
    (r) => r && !r.draft && !r.prerelease && typeof r.tag_name === "string",
  );
  return { page, published };
}

export async function checkForUpdate(): Promise<UpdateInfo> {
  try {
    const releases = await fetchReleasePage();
    if (!releases?.published.length) return { hasUpdate: false, error: "No releases found" };
    const { page, published } = releases;

    const newest = published[0];
    const latest = String(newest.tag_name).replace(/^v/, "");
    const current = app.getVersion();
    const asset = (newest.assets as any[])?.find((a) => isInstallAsset(a?.name));
    if (asset?.browser_download_url) {
      lastCheckedAsset = {
        assetUrl: asset.browser_download_url,
        sha256: parseDigest(asset.digest),
      };
    }
    // A local build can sit ahead of the newest release, so compare versions
    // rather than just testing them for inequality.
    // A release with nothing built for this platform is no update to it: on
    // macOS that would only ever point at a Windows exe.
    const hasUpdate =
      compareVersions(latest, current) > 0 && (process.platform !== "darwin" || !!asset);
    const missed = hasUpdate
      ? published.filter((r) => compareVersions(r.tag_name, current) > 0)
      : [];
    // Reaching a release at or below the installed version proves the page went
    // back far enough for the missed list to be complete. A short page means the
    // repo had nothing older to give, which proves it just as well — otherwise a
    // version older than the first ever release would claim missing notes.
    const reachedCurrent =
      page.length < RELEASE_PAGE_SIZE ||
      published.some((r) => compareVersions(r.tag_name, current) <= 0);
    return {
      hasUpdate,
      latest,
      current,
      url: newest.html_url as string,
      assetUrl: asset?.browser_download_url,
      assetSize: asset?.size,
      releases: missed.map(toReleaseNote),
      moreVersions: hasUpdate && !reachedCurrent,
    };
  } catch {
    return { hasUpdate: false, error: "Failed to check for updates" };
  }
}

type InstallResult = { success: boolean; error?: string };

// Two installs at once would race two swap scripts over the same exe
let installInProgress = false;

// `canRestart` is asked once the download is verified, just before the app
// quits, so an install that took a while can still back out of restarting.
export async function downloadAndInstall(
  win: BrowserWindow,
  assetUrl: string,
  canRestart?: () => Promise<boolean>,
): Promise<InstallResult> {
  if (installInProgress) return { success: false, error: "An update is already being installed" };
  installInProgress = true;
  const result = await install(win, assetUrl, canRestart);
  // Left set on success: the app is already on its way out
  if (!result.success) installInProgress = false;
  return result;
}

async function install(
  win: BrowserWindow,
  assetUrl: string,
  canRestart?: () => Promise<boolean>,
): Promise<InstallResult> {
  // Set by electron-builder's portable launcher; absent in dev and non-portable builds
  const exe = portableExe();
  const bundle = macAppBundle();
  if (!exe && !bundle) {
    return {
      success: false,
      error:
        process.platform === "darwin"
          ? "In-app update only works once the app is in your Applications folder"
          : "In-app update only works in the portable exe build",
    };
  }
  if (!assetUrl.startsWith("https://github.com/rambo0247/better-mayhem-tracker/")) {
    return { success: false, error: "Unexpected download URL" };
  }

  // Re-resolve the release if this URL isn't the one we last saw, so the hash
  // we check against always comes from GitHub rather than from the caller.
  if (lastCheckedAsset?.assetUrl !== assetUrl) {
    await checkForUpdate();
    if (lastCheckedAsset?.assetUrl !== assetUrl) {
      return { success: false, error: "That download is no longer the latest release" };
    }
  }
  const expectedSha256 = lastCheckedAsset.sha256;

  let tmpDir: string;
  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "better-mayhem-update-"));
  } catch (err: any) {
    return { success: false, error: `Failed to create temp dir: ${err.message}` };
  }

  const download = path.join(
    tmpDir,
    process.platform === "darwin"
      ? "better-mayhem-tracker-update.zip"
      : "better-mayhem-tracker-update.exe",
  );
  // Rearmed on every chunk, so the download is only abandoned once it has
  // genuinely stopped rather than merely being slow.
  const controller = new AbortController();
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  const armStallTimer = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => controller.abort(), DOWNLOAD_STALL_TIMEOUT_MS);
  };

  try {
    armStallTimer();
    const res = await fetch(assetUrl, {
      headers: { "User-Agent": "better-mayhem-tracker" },
      signal: controller.signal,
    });
    if (!res.ok || !res.body) {
      clearTimeout(stallTimer);
      fs.rmSync(tmpDir, { recursive: true, force: true });
      return { success: false, error: `Download failed (HTTP ${res.status})` };
    }
    const total = Number(res.headers.get("content-length")) || 0;
    const out = fs.createWriteStream(download);
    const reader = res.body.getReader();
    const hash = crypto.createHash("sha256");
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      armStallTimer();
      received += value.length;
      hash.update(value);
      if (!out.write(Buffer.from(value))) {
        await new Promise<void>((resolve) => out.once("drain", () => resolve()));
      }
      if (total) {
        sendToRenderer(win, "update:progress", Math.round((received / total) * 100));
      }
    }
    clearTimeout(stallTimer);
    await new Promise<void>((resolve, reject) => {
      out.end(() => resolve());
      out.on("error", reject);
    });
    if (total && received !== total) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      return { success: false, error: "Download incomplete, please try again" };
    }

    // A release published before GitHub reported digests has nothing to check
    // against; HTTPS and the pinned host still stand on their own.
    if (expectedSha256) {
      const actual = hash.digest("hex");
      if (actual !== expectedSha256) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        console.error(`Update hash mismatch: expected ${expectedSha256}, got ${actual}`);
        return { success: false, error: "Downloaded file failed its integrity check" };
      }
    } else {
      console.warn("Release asset has no digest; skipping hash verification");
    }
  } catch (err: any) {
    clearTimeout(stallTimer);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (err?.name === "AbortError" || err?.name === "TimeoutError") {
      return { success: false, error: "Download stalled, please try again" };
    }
    return { success: false, error: `Download failed: ${err.message}` };
  }

  if (canRestart && !(await canRestart())) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return {
      success: false,
      error: "A match started during the download. Install from here once it's over.",
    };
  }

  // Comes back the way it was left: an app updated from the tray reopens in the
  // tray rather than putting a window in front of whatever the user is doing.
  const relaunchHidden = !win.isVisible();

  const applied = bundle
    ? applyMacUpdate(bundle, download, tmpDir, relaunchHidden)
    : applyWindowsUpdate(exe!, download, tmpDir, relaunchHidden);
  if (!applied.success) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return applied;
  }

  // Let the IPC response reach the renderer before quitting
  setTimeout(() => app.quit(), 200);
  return { success: true };
}

function applyWindowsUpdate(
  currentExe: string,
  newExe: string,
  tmpDir: string,
  relaunchHidden: boolean,
): InstallResult {
  const relaunchArgs = relaunchHidden ? ` ${HIDDEN_FLAG}` : "";

  // Install under the artifact name regardless of the current filename, so an
  // exe the user renamed or downloaded under another name ends up as the one
  // the releases ship.
  const targetExe = path.join(path.dirname(currentExe), WINDOWS_EXE_NAME);
  const stagedExe = `${targetExe}.new`;

  // The running portable exe is locked by the OS until the app fully exits, so a
  // detached script stages the new exe next to the old one, waits for the lock to
  // release, swaps them, and relaunches. The old exe is only deleted once the
  // staged copy is in place, and ping is used as the delay because timeout errors
  // out when stdin is redirected.
  const script = path.join(tmpDir, "update.cmd");
  fs.writeFileSync(
    script,
    [
      "@echo off",
      `copy /y "${newExe}" "${stagedExe}" >nul 2>&1`,
      "if errorlevel 1 goto fail",
      "set tries=0",
      ":wait",
      "set /a tries+=1",
      "if %tries% gtr 120 goto fail",
      "ping -n 2 127.0.0.1 >nul",
      `del /f "${currentExe}" >nul 2>&1`,
      `if exist "${currentExe}" goto wait`,
      `move /y "${stagedExe}" "${targetExe}" >nul 2>&1`,
      `start "" "${targetExe}"${relaunchArgs}`,
      "goto cleanup",
      ":fail",
      `del /f "${stagedExe}" >nul 2>&1`,
      `start "" "${currentExe}"${relaunchArgs}`,
      ":cleanup",
      `rd /s /q "${tmpDir}"`,
      "",
    ].join("\r\n"),
  );

  spawn("cmd.exe", ["/c", script], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  return { success: true };
}

function applyMacUpdate(
  bundle: string,
  zip: string,
  tmpDir: string,
  relaunchHidden: boolean,
): InstallResult {
  // Unpacked beside the installed bundle rather than in the temp dir, so the
  // swap below is a rename within one folder and can't be left half-copied.
  const stagingDir = path.join(path.dirname(bundle), `.${path.basename(bundle)}.update`);
  try {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    fs.mkdirSync(stagingDir);
  } catch (err: any) {
    return {
      success: false,
      error: `Can't write next to ${path.basename(bundle)}: ${err.message}. Download it manually instead.`,
    };
  }

  // ditto is what Finder uses: it keeps the bundle's symlinks, permissions and
  // code signature intact, which a generic unzip can break.
  const unpacked = spawnSync("/usr/bin/ditto", ["-x", "-k", zip, stagingDir]);
  const staged = fs.existsSync(stagingDir)
    ? fs.readdirSync(stagingDir).find((name) => name.endsWith(".app"))
    : undefined;
  if (unpacked.status !== 0 || !staged) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    return { success: false, error: "The downloaded update couldn't be unpacked" };
  }

  const script = path.join(tmpDir, "update.sh");
  fs.writeFileSync(
    script,
    macSwapScript({
      pid: process.pid,
      bundle,
      stagedBundle: path.join(stagingDir, staged),
      stagingDir,
      backup: `${stagingDir}.old`,
      tmpDir,
      relaunchArgs: relaunchHidden ? [HIDDEN_FLAG] : [],
    }),
  );

  spawn("/bin/sh", [script], { detached: true, stdio: "ignore" }).unref();
  return { success: true };
}

// Either one alone can miss a match: the client may not be connected yet this
// early in a launch, and the game's own API is down through champion select.
async function matchUnderway(): Promise<boolean> {
  const [client, game] = await Promise.all([isMatchUnderway(), isGameRunning()]);
  return client || game;
}

// The release the launch check is installing, held so a window that loads
// after the install began still opens onto its progress.
let launchInstall: UpdateInfo | null = null;

export function getLaunchInstall(): UpdateInfo | null {
  return launchInstall;
}

// Runs once per launch and never again while the app stays up, so an update
// can only restart the app at a moment the user just started it, never in the
// middle of a session. A launch during a match leaves the update to the header
// badge instead.
export async function installUpdateOnLaunch(win: BrowserWindow): Promise<void> {
  if (!hasDurableInstall()) return;
  if (getSetting("auto_update") === "false") return;

  let info = await checkForUpdate();
  for (let attempt = 1; info.error && attempt < LAUNCH_CHECK_ATTEMPTS; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, LAUNCH_RETRY_MS));
    info = await checkForUpdate();
  }
  if (info.error) console.log("Launch update check failed:", info.error);
  if (!info.hasUpdate || !info.assetUrl) return;

  if (await matchUnderway()) {
    console.log(`Update ${info.latest} available; not installing during a match`);
    return;
  }

  console.log(`Installing update ${info.latest} on launch`);
  launchInstall = info;
  sendToRenderer(win, "update:installing", info);
  const result = await downloadAndInstall(win, info.assetUrl, async () => !(await matchUnderway()));
  if (!result.success) {
    launchInstall = null;
    const error = result.error ?? "Update failed";
    console.log("Launch update failed:", error);
    sendToRenderer(win, "update:install-failed", error);
  }
}

// While the app runs, a release that lands is installed in the background, but
// only at a moment nobody is using it: the window is in the tray or minimized,
// no match is on and no history import is running. With the window in view the
// update waits for the sidebar's "Update available" card instead, so the app
// never restarts under someone who is looking at it.
const BACKGROUND_CHECK_MS = 45 * 60 * 1000;
// How long the window has to stay put away before an update found earlier
// installs, so closing it for a moment doesn't set off a restart
const AWAY_SETTLE_MS = 2 * 60 * 1000;

function windowInUse(win: BrowserWindow): boolean {
  return !win.isDestroyed() && win.isVisible() && !win.isMinimized();
}

async function installInBackground(win: BrowserWindow): Promise<void> {
  if (installInProgress || win.isDestroyed() || windowInUse(win)) return;
  if (!hasDurableInstall() || getSetting("auto_update") === "false") return;
  if (isBackfillRunning()) return;

  const info = await checkForUpdate();
  if (!info.hasUpdate || !info.assetUrl) return;
  // Checked again after the request: the window may have come back meanwhile
  if (windowInUse(win) || (await matchUnderway())) return;

  console.log(`Installing update ${info.latest} in the background`);
  launchInstall = info;
  sendToRenderer(win, "update:installing", info);
  const result = await downloadAndInstall(win, info.assetUrl, async () => !(await matchUnderway()));
  if (!result.success) {
    launchInstall = null;
    const error = result.error ?? "Update failed";
    console.log("Background update failed:", error);
    sendToRenderer(win, "update:install-failed", error);
  }
}

export function startBackgroundUpdates(win: BrowserWindow): void {
  const run = () =>
    installInBackground(win).catch((err) => console.error("Background update failed:", err));
  setInterval(run, BACKGROUND_CHECK_MS);

  let settle: NodeJS.Timeout | null = null;
  const away = () => {
    if (settle) clearTimeout(settle);
    settle = setTimeout(run, AWAY_SETTLE_MS);
  };
  win.on("hide", away);
  win.on("minimize", away);
}

// The version this install ran as before the current one, when this launch is
// the first on a newer version. Set once at startup, before anything reads it.
let updatedFrom: string | null = null;

// Remembered across launches rather than written by the installer, so a version
// reached any way at all, a manual download included, counts as an update.
export function recordLaunchVersion(): void {
  const current = app.getVersion();
  const previous = getSetting("last_run_version");
  if (previous && compareVersions(current, previous) > 0) updatedFrom = previous;
  if (previous !== current) setSetting("last_run_version", current);
}

// Shared by every caller this launch, so a window that reloads asks GitHub once
let updateNotes: Promise<UpdateNotes | null> | null = null;

export function getUpdateNotes(): Promise<UpdateNotes | null> {
  updateNotes ??= loadUpdateNotes();
  return updateNotes;
}

async function loadUpdateNotes(): Promise<UpdateNotes | null> {
  const from = updatedFrom;
  if (!from || getSetting("show_release_notes") === "false") return null;
  const to = app.getVersion();
  const url = `https://github.com/rambo0247/better-mayhem-tracker/releases/tag/v${to}`;
  try {
    const page = await fetchReleasePage();
    const releases = (page?.published ?? []).filter(
      (r) => compareVersions(r.tag_name, from) > 0 && compareVersions(r.tag_name, to) <= 0,
    );
    return { from, to, url, releases: releases.map(toReleaseNote) };
  } catch {
    // Still worth saying the update landed; the dialog links out for the notes
    return { from, to, url, releases: [] };
  }
}
