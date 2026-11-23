import type { ScenarioFactory } from "../types.ts";
import { backfill } from "./backfill.ts";

const scenario: ScenarioFactory = (context) => {
  const failing = backfill(
    context,
    "backfill-error",
    "A history import fails because the match-history service answers 500.",
  );
  return { ...failing, sgp: { ...failing.sgp, status: 500 } };
};

export default scenario;
