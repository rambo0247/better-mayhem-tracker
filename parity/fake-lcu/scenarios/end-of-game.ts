import {
  gameflowPhaseFrame,
  gameflowSessionFrame,
  option,
  type Scenario,
  type ScenarioContext,
} from "../types.ts";
import { base, liveGameData, session } from "./shared.ts";

/** A match that ends, then the post-game screen publishes the stats. */
export function endOfGame(
  context: ScenarioContext,
  name: string,
  description: string,
  misses: number,
): Scenario {
  const running = session(context, "InProgress");
  const over = session(context, "EndOfGame");
  const { gameId, payload } = context.newGame(0, "recent");
  const endsAt = option(context, "endsAt", 3000);
  return {
    ...base(name, description, { phase: "InProgress", session: running, live: "on" }),
    liveData: liveGameData(context),
    games: [{ id: gameId, payload }],
    misses: misses > 0 ? { [gameId]: misses } : undefined,
    timeline: [
      {
        at: 0,
        label: "the match is running",
        frames: [gameflowSessionFrame(running), gameflowPhaseFrame("InProgress")],
      },
      {
        at: endsAt,
        label: "the nexus falls",
        state: { phase: "EndOfGame", session: over, live: "off" },
        frames: [gameflowSessionFrame(over), gameflowPhaseFrame("EndOfGame")],
      },
      {
        at: endsAt + 600,
        label: "the post-game screen publishes the stats",
        frames: [
          {
            uri: "/lol-end-of-game/v1/eog-stats-block",
            eventType: "Create",
            data: { gameId, gameMode: "KIWI" },
          },
        ],
      },
    ],
  };
}

export default (context: ScenarioContext) =>
  endOfGame(
    context,
    "end-of-game",
    "A match ends and its stats are there on the first request.",
    0,
  );
