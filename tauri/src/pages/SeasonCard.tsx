import { createEffect, createMemo, createSignal, Show } from "solid-js";
import { useParams, useSearchParams } from "@solidjs/router";
import type { SeasonRecap } from "../lib/types";
import { api } from "../lib/api-shim";
import { useAugmentData, useChampionData, useItemData } from "../hooks/useChampions";
import { useCardCapture, useLookupGrace } from "../hooks/useCardCapture";
import SeasonRecapCard from "../components/SeasonRecapCard";

const loaded = (data: object) => Object.keys(data).length > 0;

/**
 * The season recap card on its own, for the main process to photograph. The
 * filters ride in the route, so the image is of exactly what the Season Recap
 * page had selected.
 */
export default function SeasonCard() {
  const params = useParams<{ seasonId: string }>();
  const [search] = useSearchParams<Record<string, string>>();

  const [recap, setRecap] = createSignal<SeasonRecap | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  const request = createMemo(() => {
    const queueParam = search.queue;
    return {
      seasonId: params.seasonId ?? "",
      queue: queueParam != null && queueParam !== "" ? Number(queueParam) : undefined,
      account: search.account || undefined,
    };
  });
  const hideFriends = () => search.hideFriends !== undefined;

  createEffect(request, ({ seasonId, queue, account }) => {
    let active = true;
    api.getSeasonRecap(seasonId, queue, account).then(
      (result) => {
        if (!active) return;
        if (!result) setError("That season isn't available");
        else if (result.games === 0) setError("There are no games in that season to recap");
        else setRecap(() => result);
      },
      (err: Error) => {
        if (active) setError(err.message);
      },
    );
    return () => {
      active = false;
    };
  });

  // Names, and the item data the boots are told apart by, are text rather than
  // images, so the settle check can't see them arrive: wait for them here
  const champData = useChampionData();
  const augmentData = useAugmentData(() => recap()?.patch);
  const itemData = useItemData(() => recap()?.patch);
  const overdue = useLookupGrace();
  const drawn = createMemo(
    () =>
      recap() != null &&
      ((loaded(champData()) && loaded(augmentData()) && loaded(itemData())) || overdue()),
  );
  const root = useCardCapture(drawn, error);

  return (
    <Show when={!error()} fallback={<div class="p-6 text-sm text-lol-text">{error()}</div>}>
      <Show when={drawn()} fallback={<div class="p-6 text-sm text-lol-text">Drawing...</div>}>
        {/* No margin around the card: it paints its own background edge to edge */}
        <div ref={root} class="w-full">
          <SeasonRecapCard recap={recap()!} champData={champData()} hideFriends={hideFriends()} />
        </div>
      </Show>
    </Show>
  );
}
