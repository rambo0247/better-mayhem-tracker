import type { ScenarioFactory } from "../types.ts";
import { challengesTree } from "./challenges-data.ts";
import { base } from "./shared.ts";

const scenario: ScenarioFactory = () => ({
  ...base("challenges-loaded", "The client is idle and answers the challenge tree."),
  challenges: challengesTree(),
});

export default scenario;
