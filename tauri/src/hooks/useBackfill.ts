import { createSignal, onSettled } from "solid-js";
import { api } from "../lib/api-shim";
import type { BackfillProgress } from "../lib/types";

// Backfill can start on its own the first time an account connects, so the
// renderer has to be able to pick up a run already in flight rather than only
// tracking ones it kicked off itself.
export function useBackfill() {
  const [running, setRunning] = createSignal(false);
  const [progress, setProgress] = createSignal<BackfillProgress | null>(null);

  onSettled(() => {
    void api.isBackfillRunning().then(setRunning);

    const offProgress = api.onBackfillProgress((p) => {
      setRunning(true);
      setProgress(p);
    });
    const offDone = api.onBackfillDone(() => {
      setRunning(false);
      setProgress(null);
    });

    return () => {
      offProgress();
      offDone();
    };
  });

  const percent = () => {
    const p = progress();
    return p && p.total > 0 ? Math.round((p.current / p.total) * 100) : 0;
  };

  return { running, progress, percent };
}
