import { createEffect, createMemo, createSignal, type Accessor } from "solid-js";
import { api } from "../lib/api-shim";
import type { MatchFilters, MultikillType } from "../lib/types";
import type { MatchListItem } from "../lib/types";

const PAGE_SIZE = 20;

export function useMatches(filters: Accessor<MatchFilters> = () => ({})) {
  // The filters the list is for, compared by value: the caller builds a new
  // object whenever any one of them is read again
  const query = createMemo(
    () => {
      const f = filters();
      const multikills = f.multikills?.join(",") ?? "";
      const values: MatchFilters = {
        championId: f.championId,
        patch: f.patch,
        queue: f.queue,
        account: f.account,
        season: f.season,
        sort: f.sort,
        sortDir: f.sortDir,
        favorites: f.favorites,
        multikills: multikills ? (multikills.split(",") as MultikillType[]) : [],
      };
      const key = JSON.stringify([
        f.championId,
        f.patch,
        f.queue,
        f.account,
        f.season,
        f.sort,
        f.sortDir,
        multikills,
        f.favorites,
      ]);
      return { key, values };
    },
    { equals: (a, b) => a.key === b.key },
  );

  const [matches, setMatches] = createSignal<MatchListItem[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [hasMore, setHasMore] = createSignal(false);

  // How many rows are already loaded, and the filters they were loaded for
  let offsetLoaded = 0;
  let current: MatchFilters = {};

  // Whoever starts a load has already marked the list as loading
  const load = async (reset = false) => {
    const offset = reset ? 0 : offsetLoaded;
    try {
      const result = await api.getMatchHistory(PAGE_SIZE, offset, current);
      if (reset) {
        setMatches(result.matches);
      } else {
        setMatches((prev) => [...prev, ...result.matches]);
      }
      offsetLoaded = offset + result.matches.length;
      setHasMore(offset + result.matches.length < result.total);
    } finally {
      setLoading(false);
    }
  };

  // Loads the first page, and resets to it whenever the filters move
  createEffect(query, (q) => {
    current = q.values;
    setLoading(true);
    void load(true);

    return api.onGamesUpdated(() => {
      setLoading(true);
      void load(true);
    });
  });

  const loadMore = () => {
    if (loading() || !hasMore()) return;
    setLoading(true);
    void load(false);
  };

  const reload = () => {
    setLoading(true);
    return load(true);
  };

  return { matches, loading, hasMore, loadMore, reload };
}
