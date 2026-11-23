import { option, type ScenarioFactory } from "../types.ts";
import { backfill } from "./backfill.ts";

const scenario: ScenarioFactory = (context) => {
  const running = backfill(
    context,
    "backfill-running",
    "A history import is under way. Games after the served ones never answer.",
    { hangDetailsFrom: option(context, "served", 12) },
  );
  // Progress is a one-off event, so the import waits until the page is open to see it.
  return { ...running, sgp: { ...running.sgp, gated: true } };
};

export default scenario;
