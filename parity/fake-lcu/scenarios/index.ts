import type { Scenario, ScenarioContext, ScenarioFactory } from "../types.ts";
import backfillDone from "./backfill-done.ts";
import backfillError from "./backfill-error.ts";
import backfillRunning from "./backfill-running.ts";
import backfillWalking from "./backfill-walking.ts";
import challengesLoaded from "./challenges-loaded.ts";
import champSelect from "./champ-select.ts";
import connectedIdle from "./connected-idle.ts";
import endOfGame from "./end-of-game.ts";
import inGame from "./in-game.ts";
import inGameLoading from "./in-game-loading.ts";
import resultsLate from "./results-late.ts";

export const SCENARIOS: Record<string, ScenarioFactory> = {
  "connected-idle": connectedIdle,
  "champ-select": champSelect,
  "in-game-loading": inGameLoading,
  "in-game": inGame,
  "end-of-game": endOfGame,
  "results-late": resultsLate,
  "challenges-loaded": challengesLoaded,
  "backfill-running": backfillRunning,
  "backfill-walking": backfillWalking,
  "backfill-done": backfillDone,
  "backfill-error": backfillError,
};

export function buildScenario(name: string, context: ScenarioContext): Scenario {
  const factory = SCENARIOS[name];
  if (!factory) {
    throw new Error(`unknown scenario ${name}. Known: ${Object.keys(SCENARIOS).join(", ")}`);
  }
  return factory(context);
}
