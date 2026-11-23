import type { ScenarioFactory } from "../types.ts";
import { backfill } from "./backfill.ts";

const scenario: ScenarioFactory = (context) =>
  backfill(context, "backfill-done", "A history import finds a few games and finishes.", {}, 3);

export default scenario;
