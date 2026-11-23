import { createEffect, createMemo, createSignal, onSettled, type Accessor } from "solid-js";
import { api } from "../lib/api-shim";
import type { ChampionData, AugmentData, ItemData, SummonerSpellData } from "../lib/types";

let champCache: ChampionData | null = null;
let spellCache: SummonerSpellData | null = null;
const augCaches = new Map<string, AugmentData>();
const augPromises = new Map<string, Promise<AugmentData>>();
const itemCaches = new Map<string, ItemData>();
const itemPromises = new Map<string, Promise<ItemData>>();

function hasData<T extends object>(obj: T | null): obj is T {
  return obj !== null && Object.keys(obj).length > 0;
}

export function useChampionData(): Accessor<ChampionData> {
  const [data, setData] = createSignal<ChampionData>(champCache || {});

  onSettled(() => {
    if (hasData(champCache)) return;
    void api.getChampionData().then((d) => {
      if (Object.keys(d).length > 0) champCache = d;
      setData(d);
    });
  });

  return data;
}

// One patch's record from a per-patch cache, asked for once per patch however
// many components want it. A patch still being fetched yields an empty record.
function usePatchData<T extends object>(
  patch: Accessor<string | null | undefined>,
  caches: Map<string, T>,
  promises: Map<string, Promise<T>>,
  fetch: (patch: string | undefined) => Promise<T>,
): Accessor<T> {
  const key = createMemo(() => patch() || "latest");
  // Another patch starts from whatever is already cached for it, and from
  // nothing while it loads
  const [data, setData] = createSignal<T>(() => caches.get(key()) ?? ({} as T));

  createEffect(key, (current) => {
    const cached = caches.get(current);
    if (cached && Object.keys(cached).length > 0) return;
    let promise = promises.get(current);
    if (!promise) {
      // "latest" is exactly what the main process substitutes for no patch
      promise = fetch(current === "latest" ? undefined : current);
      promises.set(current, promise);
    }
    let active = true;
    void promise.then((d) => {
      if (Object.keys(d).length > 0) caches.set(current, d);
      else promises.delete(current);
      if (active) setData(() => d);
    });
    return () => {
      active = false;
    };
  });

  return data;
}

// Augment data is keyed by patch so a historical game reports the name, rarity
// and art it was played with — Riot reworks augments under the same id, so the
// live export is only correct for the current patch. Aggregate views that span
// patches pass nothing and get "latest", which is what they want anyway.
export function useAugmentData(
  patch: Accessor<string | null | undefined> = () => undefined,
): Accessor<AugmentData> {
  return usePatchData(patch, augCaches, augPromises, (p) => api.getAugmentData(p));
}

export function useSummonerSpellData(): Accessor<SummonerSpellData> {
  const [data, setData] = createSignal<SummonerSpellData>(spellCache || {});

  onSettled(() => {
    if (hasData(spellCache)) return;
    void api.getSummonerSpellData().then((d) => {
      if (Object.keys(d).length > 0) spellCache = d;
      setData(d);
    });
  });

  return data;
}

// Item data is keyed by patch so icons come from the same patch as the game.
// A patch still being fetched yields an empty record, which renders as the same
// placeholder as an item CommunityDragon has no entry for.
export function useItemData(
  patch: Accessor<string | null | undefined> = () => undefined,
): Accessor<ItemData> {
  return usePatchData(patch, itemCaches, itemPromises, (p) => api.getItemData(p));
}

export function getChampionName(data: ChampionData, id: number): string {
  return data[id]?.name || `Champion ${id}`;
}

export function getAugmentName(data: AugmentData, id: number): string {
  const aug = data[id];
  return aug?.name?.trim() || nameFromIconPath(aug?.iconPath) || `Unknown augment ${id}`;
}

// Riot ships a few augments with a blank name; their icon file still says what
// they are ("…/Pentakill_small.png" → "Pentakill")
export function nameFromIconPath(iconPath: string | undefined): string | null {
  const file = iconPath?.split("/").pop();
  const words = file
    ?.replace(/\.[^.]+$/, "")
    .replace(/_(small|large)$/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim();
  return words || null;
}
