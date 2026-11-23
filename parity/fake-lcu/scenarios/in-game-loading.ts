import { gameflowPhaseFrame, gameflowSessionFrame, type ScenarioFactory } from "../types.ts";
import { base, session } from "./shared.ts";

const scenario: ScenarioFactory = (context) => {
  const loading = session(context, "InProgress");
  return {
    ...base("in-game-loading", "The game has started and its own API is not answering yet.", {
      phase: "InProgress",
      session: loading,
      live: "loading",
    }),
    timeline: [
      {
        at: 0,
        label: "the loading screen opens",
        frames: [gameflowSessionFrame(loading), gameflowPhaseFrame("InProgress")],
      },
    ],
  };
};

export default scenario;
