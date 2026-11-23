import { createEffect, createSignal, type Accessor, type Setter } from "solid-js";
import { readViewState, writeViewState } from "../lib/viewState";

// A drop-in for createSignal that restores the last value and stores every new
// one, for filter and sort controls that should survive a relaunch. Both halves
// are no-ops unless the user has turned remembering on, so callers get plain
// signal behaviour by default.
//
// With restore off it starts from `initial` whatever was stored, for a page
// opened on filters of its own (a link from another page) that should win over
// the remembered ones. New values are still stored either way.
export function useViewState<T>(key: string, initial: T, restore = true): [Accessor<T>, Setter<T>] {
  const [value, setValue] = createSignal<T>(() =>
    restore ? readViewState(key, initial) : initial,
  );
  createEffect(value, (current) => writeViewState(key, current));
  return [value, setValue];
}
