import type { ScenarioFactory } from "../types.ts";
import { backfill } from "./backfill.ts";

const scenario: ScenarioFactory = (context) => {
  const done = backfill(
    context,
    "backfill-done",
    "A history import finds a few games and finishes.",
    {},
    3,
  );
  return { ...done, sgp: { ...done.sgp, gated: true } };
};

export default scenario;
