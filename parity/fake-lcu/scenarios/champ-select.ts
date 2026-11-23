import { gameflowPhaseFrame, type ScenarioFactory } from "../types.ts";
import { base, session } from "./shared.ts";

const scenario: ScenarioFactory = (context) => {
  const champSelect = session(context, "ChampSelect") as any;
  champSelect.gameData.gameId = 0;
  return {
    ...base("champ-select", "The client is in champion select.", {
      phase: "ChampSelect",
      session: champSelect,
    }),
    timeline: [
      {
        at: 0,
        label: "champion select opens",
        frames: [gameflowPhaseFrame("ChampSelect")],
      },
    ],
  };
};

export default scenario;
