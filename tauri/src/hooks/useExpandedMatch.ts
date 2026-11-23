import { createSignal, onSettled } from "solid-js";
import { api } from "../lib/api-shim";
import type { MatchDetail } from "../lib/types";

// The one game open in a list of shared games, with the scoreboard to show for
// it and whose rows on that scoreboard are ours
export function useExpandedMatch() {
  const [puuids, setPuuids] = createSignal<string[] | null>(null);
  const [expandedId, setExpandedId] = createSignal<number | null>(null);
  const [detail, setDetail] = createSignal<MatchDetail | null>(null);
  const [detailLoading, setDetailLoading] = createSignal(false);

  onSettled(() => {
    void api.getAllSummonerPuuids().then(setPuuids);
  });

  const toggleExpand = async (gameId: number) => {
    if (expandedId() === gameId) {
      setExpandedId(null);
      setDetail(null);
      return;
    }
    setExpandedId(gameId);
    setDetailLoading(true);
    try {
      setDetail(await api.getMatchDetail(gameId));
    } finally {
      setDetailLoading(false);
    }
  };

  return { puuids, expandedId, detail, detailLoading, toggleExpand };
}
