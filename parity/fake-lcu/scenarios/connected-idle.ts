import type { ScenarioFactory } from "../types.ts";
import { base } from "./shared.ts";

const scenario: ScenarioFactory = () =>
  base("connected-idle", "The client is open, signed in, and not in a game.");

export default scenario;
