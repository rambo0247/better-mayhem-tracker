import { createEffect, createSignal } from "solid-js";

/**
 * One IPC read and the state a page shows around it. `deps` is the tracked
 * half, the caller's statement of what changes the result, and its value is
 * handed to `fetcher`: `useIpc(([queue]) => api.getRecords(queue), () => [queue()])`.
 */
export function useIpc<T, D = undefined>(
  fetcher: (deps: D) => Promise<T>,
  deps: () => D = () => undefined as D,
) {
  const [data, setData] = createSignal<T | null>(null);
  const [loading, setLoading] = createSignal(true);

  // Only the newest request may write state. Two can be in flight at once
  // whenever a filter changes mid-fetch, and IPC gives no ordering guarantee —
  // without this the slower, older response lands last and leaves the view
  // showing data for a filter that is no longer selected.
  let requestId = 0;
  let latest: D;

  const run = async (input: D) => {
    const id = ++requestId;
    setLoading(true);
    try {
      const result = await fetcher(input);
      if (id !== requestId) return;
      setData(() => result);
    } catch (err) {
      console.error("IPC request failed:", err);
    } finally {
      if (id === requestId) setLoading(false);
    }
  };

  createEffect(deps, (input) => {
    latest = input;
    void run(input);
  });

  const refetch = () => run(latest);

  return { data, loading, refetch };
}
