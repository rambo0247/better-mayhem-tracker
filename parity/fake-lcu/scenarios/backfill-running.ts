import { option, type ScenarioFactory } from "../types.ts";
import { backfill } from "./backfill.ts";

const scenario: ScenarioFactory = (context) =>
  backfill(
    context,
    "backfill-running",
    "A history import is under way. Games after the served ones never answer.",
    { hangDetailsFrom: option(context, "served", 12) },
  );

export default scenario;
