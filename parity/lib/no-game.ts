import { spawnSync } from "node:child_process";

const GAME_PROCESS = "LeagueofLegends";
const POLL_MS = 30_000;
const AFTER_GAME_MS = 120_000;

/** True while the League game process runs. Only the process list is read. */
export function gameRunning(
  platform: NodeJS.Platform = process.platform,
  processName: string = GAME_PROCESS,
): boolean {
  if (platform === "win32") {
    const out = spawnSync("tasklist", ["/FI", `IMAGENAME eq ${processName}.exe`, "/NH"], {
      encoding: "utf8",
    });
    return (out.stdout ?? "").toLowerCase().includes(processName.toLowerCase());
  }
  return spawnSync("pgrep", ["-x", processName]).status === 0;
}

/**
 * Captures open windows and load the machine, so they wait while the operator is in a
 * game, then 2 more minutes for the post-game screen. Returns at once when no game runs.
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
