import { createSignal, onSettled } from "solid-js";
import { api } from "../lib/api-shim";
import type { MatchFilterOptions } from "../lib/types";

// What the dropdowns offer until the database has answered
export const EMPTY_FILTER_OPTIONS: MatchFilterOptions = {
  patches: [],
  champions: [],
  queues: [],
  seasons: [],
  accounts: [],
  hasFavorites: false,
};

// Dropdowns that mount while a request is out share it. New games always ask
// afresh, so an answer read before they landed is never handed out after.
let pending: Promise<MatchFilterOptions> | null = null;

function requestOptions(fresh: boolean): Promise<MatchFilterOptions> {
  if (fresh || !pending) {
    const request = api.getMatchFilterOptions().finally(() => {
      if (pending === request) pending = null;
    });
    pending = request;
  }
  return pending;
}

// What the filter dropdowns can offer, refreshed whenever new games land — a
// game from a queue the database had never seen adds its option without a
// reload. Unnarrowed: a dropdown that filtered itself could hide its own
// selection, so the pages that narrow these ask for them directly instead.
export function useFilterOptions() {
  const [options, setOptions] = createSignal<MatchFilterOptions>(EMPTY_FILTER_OPTIONS);

  onSettled(() => {
    void requestOptions(false).then(setOptions);
    return api.onGamesUpdated(() => requestOptions(true).then(setOptions));
  });

  return options;
}
