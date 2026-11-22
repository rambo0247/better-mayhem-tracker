import { useState, useEffect } from "react";
import { useBackfill } from "../hooks/useBackfill";
import { LOCALE } from "../lib/format";
import { XIcon } from "./icons";

// History imports run in the background, often on their own the first time an
// account connects, so their progress and outcome surface in a corner card
// instead of taking room in the header. The outcome stays for ten seconds.
export default function ActivityToast() {
  const { running, progress, percent } = useBackfill();
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    if (!result) return;
    const timer = setTimeout(() => setResult(null), 10_000);
    return () => clearTimeout(timer);
  }, [result]);

  useEffect(
    () =>
      window.api.onBackfillDone((done) => {
        if ("error" in done) {
          setResult(`Import failed: ${done.error}`);
        } else if (done.cancelled) {
          setResult(`Import stopped after ${done.added.toLocaleString(LOCALE)} game(s)`);
        } else if (done.added > 0) {
          setResult(`Imported ${done.added.toLocaleString(LOCALE)} past game(s)`);
        }
      }),
    [],
  );

  if (!running && !result) return null;

  return (
    <div
      role="status"
      className="menu view-in fixed right-6 bottom-5 z-40 w-80 overflow-hidden px-4 py-3"
    >
      {running ? (
        <>
          <div className="flex items-center gap-3">
            <span className="live-pulse h-1.5 w-1.5 shrink-0 rounded-full bg-lol-gold" />
            <span className="label min-w-0 flex-1 truncate text-lol-text-bright">
              Importing history
            </span>
            <button
              onClick={() => window.api.cancelBackfill()}
              className="btn btn-sm btn-ghost -mr-2 shrink-0"
            >
              Cancel
            </button>
          </div>
          <div className="mt-1.5 flex items-center gap-3">
            <div className="h-1.5 flex-1 overflow-hidden rounded-sm bg-white/[0.07]">
              <div
                className="h-full rounded-sm bg-gradient-to-r from-lol-gold/70 to-lol-gold-light transition-all duration-300"
                style={{ width: `${percent}%` }}
              />
            </div>
            <span className="shrink-0 font-num text-[13px] text-lol-text">
              {progress && progress.total > 0 ? (
                <>
                  <span className="font-semibold text-lol-text-bright">
                    {progress.current.toLocaleString(LOCALE)}
                  </span>
                  {" / "}
                  {progress.total.toLocaleString(LOCALE)}
                </>
              ) : (
                "..."
              )}
            </span>
          </div>
        </>
      ) : (
        <div className="flex items-center gap-3">
          <span
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${
              result?.startsWith("Import failed") ? "bg-lol-loss" : "bg-lol-win"
            }`}
          />
          <span
            className="min-w-0 flex-1 truncate text-[13px] text-lol-text-bright"
            title={result ?? undefined}
          >
            {result}
          </span>
          <button
            onClick={() => setResult(null)}
            title="Dismiss"
            aria-label="Dismiss"
            className="btn btn-sm btn-ghost btn-icon -mr-2 h-7 w-7 shrink-0"
          >
            <XIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}
