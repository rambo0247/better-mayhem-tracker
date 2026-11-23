import { option, type ScenarioFactory } from "../types.ts";
import { endOfGame } from "./end-of-game.ts";

const scenario: ScenarioFactory = (context) =>
  endOfGame(
    context,
    "results-late",
    "A match ends and the client answers 404 for its stats until the fourth request.",
    option(context, "misses", 3),
  );

export default scenario;
