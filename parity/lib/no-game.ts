import { spawnSync } from "node:child_process";

const GAME_PROCESS = "LeagueofLegends";
const POLL_MS = 30_000;
const AFTER_GAME_MS = 120_000;

/**
 * True while the League game process runs. When the process list cannot be read the answer
 * is true, so a broken pgrep or tasklist holds a run instead of letting it open windows.
 */
export function gameRunning(
  platform: NodeJS.Platform = process.platform,
  processName: string = GAME_PROCESS,
  log: (line: string) => void = console.error,
): boolean {
  const win = platform === "win32";
  const out = win
    ? spawnSync("tasklist", ["/FI", `IMAGENAME eq ${processName}.exe`, "/NH"], { encoding: "utf8" })
    : spawnSync("pgrep", ["-x", processName], { encoding: "utf8" });
  if (out.error || out.status === null || (win ? out.status !== 0 : out.status > 1)) {
    log(
      `wait-no-game: cannot read the process list (${out.error?.message ?? `exit ${out.status}`}), assuming a game is running`,
    );
    return true;
  }
  return win ? out.stdout.toLowerCase().includes(processName.toLowerCase()) : out.status === 0;
}

/**
 * The operator plays on this machine, so runs hold while a game runs and for 2 more minutes
 * for the post-game screen.
 */
export async function waitForNoGame(log: (line: string) => void = console.log) {
  if (!gameRunning()) return;
  log("wait-no-game: League game running, holding");
  const started = Date.now();
  while (gameRunning()) await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  log(
    `wait-no-game: game over after ${Math.round((Date.now() - started) / 1000)}s, waiting 120s more`,
  );
  await new Promise((resolve) => setTimeout(resolve, AFTER_GAME_MS));
  log("wait-no-game: clear");
}
