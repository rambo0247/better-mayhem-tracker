import { createEffect, createSignal, onSettled, Show } from "solid-js";
import { api } from "../lib/api-shim";
import { useBackfill } from "../hooks/useBackfill";
import { LOCALE } from "../lib/format";
import { XIcon } from "./icons";

export const RESULT_MS = 10_000;

// History imports run in the background, often on their own the first time an
// account connects, so their progress and outcome surface in a corner card
// instead of taking room in the header. The outcome stays for ten seconds.
export default function ActivityToast() {
  const backfill = useBackfill();
  const [result, setResult] = createSignal<string | null>(null);

  createEffect(
    () => result(),
    (message) => {
      if (!message) return;
      const timer = setTimeout(() => setResult(null), RESULT_MS);
      return () => clearTimeout(timer);
    },
  );

  onSettled(() =>
    api.onBackfillDone((done) => {
      if ("error" in done) {
        setResult(`Import failed: ${done.error}`);
      } else if (done.cancelled) {
        setResult(`Import stopped after ${done.added.toLocaleString(LOCALE)} game(s)`);
      } else if (done.added > 0) {
        setResult(`Imported ${done.added.toLocaleString(LOCALE)} past game(s)`);
      }
    }),
  );

  return (
    <Show when={backfill.running() || result()}>
      <div
        role="status"
        class="menu view-in fixed right-6 bottom-5 z-40 w-80 overflow-hidden px-4 py-3"
      >
        <Show
          when={backfill.running()}
          fallback={
            <div class="flex items-center gap-3">
              <span
                class={[
                  "h-1.5 w-1.5 shrink-0 rounded-full",
                  result()?.startsWith("Import failed") ? "bg-lol-loss" : "bg-lol-win",
                ]}
              />
              <span
                class="min-w-0 flex-1 truncate text-[13px] text-lol-text-bright"
                title={result() ?? undefined}
              >
                {result()}
              </span>
              <button
                onClick={() => setResult(null)}
                title="Dismiss"
                aria-label="Dismiss"
                class="btn btn-sm btn-ghost btn-icon -mr-2 h-7 w-7 shrink-0"
              >
                <XIcon class="h-3.5 w-3.5" />
              </button>
            </div>
          }
        >
          <div class="flex items-center gap-3">
            <span class="live-pulse h-1.5 w-1.5 shrink-0 rounded-full bg-lol-gold" />
            <span class="label min-w-0 flex-1 truncate text-lol-text-bright">
              Importing history
            </span>
            <button
              onClick={() => api.cancelBackfill()}
              class="btn btn-sm btn-ghost -mr-2 shrink-0"
            >
              Cancel
            </button>
          </div>
          <div class="mt-1.5 flex items-center gap-3">
            <div class="h-1.5 flex-1 overflow-hidden rounded-sm bg-white/[0.07]">
              <div
                class="h-full rounded-sm bg-gradient-to-r from-lol-gold/70 to-lol-gold-light transition-all duration-300"
                style={{ width: `${backfill.percent()}%` }}
              />
            </div>
            <span class="shrink-0 font-num text-[13px] text-lol-text">
              <Show when={backfill.progress()?.total ? backfill.progress() : null} fallback="...">
                {(p) => (
                  <>
                    <span class="font-semibold text-lol-text-bright">
                      {p().current.toLocaleString(LOCALE)}
                    </span>
                    {" / "}
                    {p().total.toLocaleString(LOCALE)}
                  </>
                )}
              </Show>
            </span>
          </div>
        </Show>
      </div>
    </Show>
  );
}
