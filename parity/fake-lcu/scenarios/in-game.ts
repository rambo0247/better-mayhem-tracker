import { gameflowPhaseFrame, gameflowSessionFrame, type ScenarioFactory } from "../types.ts";
import { base, liveGameData, session } from "./shared.ts";

const scenario: ScenarioFactory = (context) => {
  const running = session(context, "InProgress");
  return {
    ...base("in-game", "A match is running and port 2999 serves it.", {
      phase: "InProgress",
      session: running,
      live: "on",
    }),
    liveData: liveGameData(context),
    timeline: [
      {
        at: 0,
        label: "the match is running",
        frames: [gameflowSessionFrame(running), gameflowPhaseFrame("InProgress")],
      },
    ],
  };
};

export default scenario;
