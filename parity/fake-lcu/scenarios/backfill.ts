import { option, type Scenario, type ScenarioContext } from "../types.ts";
import { base } from "./shared.ts";

/** The history walk against Riot's match-history service, which the seam points at the fake. */
export function backfill(
  context: ScenarioContext,
  name: string,
  description: string,
  extra: Partial<Scenario> = {},
  defaultTotal = 40,
): Scenario {
  const total = option(context, "total", defaultTotal);
  const games = Array.from({ length: total }, (_, n) => context.newGame(n + 1, "past"));
  return {
    ...base(name, description),
    sgp: { ids: games.map((g) => g.gameId) },
    games: games.map((g) => ({ id: g.gameId, payload: g.payload })),
    ...extra,
  };
}
