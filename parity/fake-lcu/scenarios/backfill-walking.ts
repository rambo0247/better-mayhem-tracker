import type { ScenarioFactory } from "../types.ts";
import { backfill } from "./backfill.ts";

const scenario: ScenarioFactory = (context) => {
  const walking = backfill(
    context,
    "backfill-walking",
    "A history import has started and the match-history service never answers.",
  );
  return { ...walking, sgp: { ...walking.sgp, stall: true } };
};

export default scenario;
