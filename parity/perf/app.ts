import { Database } from "bun:sqlite";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveDataRoot } from "../lib/data.ts";
import { gameRunning } from "../lib/no-game.ts";
import { realDataRoots, refuseRealFolder } from "../lib/real-folder.ts";
import { wallClockMs, type TimedLine } from "./first-content.ts";

export const VERSION = "1.2.1";

const CLIENT_PROCESSES = ["LeagueClient", "LeagueClientUx", "RiotClientServices"];

export function leagueClientRunning(platform: NodeJS.Platform = process.platform): boolean {
  if (platform === "win32") {
    const out = spawnSync("tasklist", ["/NH"], { encoding: "utf8" });
    return /LeagueClient|RiotClientServices/i.test(out.stdout ?? "");
  }
  return CLIENT_PROCESSES.some((name) => spawnSync("pgrep", ["-x", name]).status === 0);
}

/**
 * A packaged app has no seam, so nothing hides the League client from it. Wait for no
 * game and no client, which is also what the metric asks for.
 */
export async function waitForQuietClient(log: (line: string) => void = console.log) {
  let announced = false;
  while (gameRunning() || leagueClientRunning()) {
    if (!announced) log("perf: League game or client is running, holding the launch");
    announced = true;
    await Bun.sleep(30_000);
  }
  if (announced) {
    log("perf: clear, waiting 2 more minutes");
    await Bun.sleep(120_000);
  }
}

export type Isolation = "sandbox" | "none";

/**
 * The packaged app has no seam, so on macOS it runs under a Seatbelt profile that denies
 * what the seam hides. Reads of the League install and the Riot records fail, so the app
 * cannot find the client, and `ps` cannot run, so its fallback scan fails too. Any access
 * to the real data folder fails. Nothing else is changed: the network, the GPU and the
 * packaged-app code paths are production's.
 */
export function sandboxProfile(realRoots: string[] = realDataRoots()): string {
  const quote = (value: string) => JSON.stringify(value);
  return [
    "(version 1)",
    "(allow default)",
    `(deny file* (subpath ${quote("/Applications/League of Legends.app")}))`,
    `(deny file* (subpath ${quote("/Users/Shared/Riot Games")}))`,
    `(deny process-exec (literal ${quote("/bin/ps")}))`,
    ...realRoots.map((root) => `(deny file* (subpath ${quote(root)}))`),
    "",
  ].join("\n");
}

export function sandboxed(
  command: string,
  args: string[],
  profileFile: string,
): { command: string; args: string[] } {
  fs.writeFileSync(profileFile, sandboxProfile());
  return { command: "/usr/bin/sandbox-exec", args: ["-f", profileFile, command, ...args] };
}

export interface PreparedData {
  userData: string;
  newest: { kills: number; deaths: number; assists: number; durationSeconds: number } | null;
}

/**
 * Copies a snapshot or the fixture into a fresh user-data folder and turns the update
 * check off in the copy. A newer release would replace the scratch app mid-run, and the
 * copy's `auto_start` is absent so nothing writes a login item.
 */
export function prepareUserData(options: { data: string; runDir: string }): PreparedData {
  const { runDir } = options;
  refuseRealFolder(runDir, "run folder");
  const root = resolveDataRoot(options.data);
  const userData = path.join(runDir, "userdata");
  fs.rmSync(runDir, { recursive: true, force: true });
  fs.mkdirSync(userData, { recursive: true });
  for (const name of ["data", "asset-cache", "backups"]) {
    const from = path.join(root, name);
    if (fs.existsSync(from)) fs.cpSync(from, path.join(userData, name), { recursive: true });
  }
  fs.mkdirSync(path.join(userData, "logs"), { recursive: true });

  const db = new Database(path.join(userData, "data", "matches.db"));
  try {
    const put = db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");
    put.run("last_run_version", VERSION);
    put.run("auto_update", "false");
    put.run("show_release_notes", "false");
    db.run("DELETE FROM settings WHERE key IN ('auto_start', 'auto_start_path')");
    const newest = db
      .query(
        `SELECT p.kills, p.deaths, p.assists, g.game_duration AS duration
           FROM games g JOIN match_participants p ON p.game_id = g.game_id AND p.puuid = g.puuid
          ORDER BY g.game_creation DESC LIMIT 1`,
      )
      .get() as { kills: number; deaths: number; assists: number; duration: number } | null;
    return {
      userData,
      newest: newest && {
        kills: newest.kills,
        deaths: newest.deaths,
        assists: newest.assists,
        durationSeconds: newest.duration,
      },
    };
  } finally {
    db.close();
  }
}

/** True when the first row's text carries the newest game's kills, deaths and assists in order. */
export function rowIsNewestGame(rowText: string, newest: PreparedData["newest"]): boolean {
  if (!newest) return false;
  const { kills, deaths, assists } = newest;
  const text = rowText.replace(/\s+/g, " ");
  return new RegExp(`(^|\\D)${kills}\\D+${deaths}\\D+${assists}(\\D|$)`).test(text);
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

export interface RunningApp {
  pid: number;
  spawnedAtMs: number;
  lines: TimedLine[];
  exited: Promise<number>;
  hasExited(): boolean;
  stop(): Promise<void>;
}

/** Starts the app as a plain child. No activation, no LaunchServices, no window calls. */
export function spawnApp(options: {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
}): RunningApp {
  const spawnedAtMs = wallClockMs();
  const child = Bun.spawn([options.command, ...options.args], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env } as Record<string, string>,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const lines: TimedLine[] = [];
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of stream) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        lines.push({ atMs: wallClockMs(), text: buffer.slice(0, newline).trimEnd() });
        buffer = buffer.slice(newline + 1);
      }
    }
  };
  void pump(child.stdout);
  void pump(child.stderr);
  let done = false;
  const exited = child.exited.then((code) => {
    done = true;
    return code;
  });
  return {
    pid: child.pid,
    spawnedAtMs,
    lines,
    exited,
    hasExited: () => done,
    async stop() {
      if (done) return;
      child.kill("SIGTERM");
      const winner = await Promise.race([exited, Bun.sleep(15_000).then(() => "timeout")]);
      if (winner === "timeout") child.kill("SIGKILL");
      await exited;
    },
  };
}

export function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function waitForGone(pids: number[], timeoutMs: number): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  let alive = pids.filter(pidExists);
  while (alive.length > 0 && Date.now() < deadline) {
    await Bun.sleep(200);
    alive = alive.filter(pidExists);
  }
  return alive;
}
