import { createEffect, For, Show } from "solid-js";
import { findSeason } from "@shared/seasons";
import { useFilterOptions } from "../hooks/useFilterOptions";
import { FilterField } from "./FilterMenu";

export function seasonName(id: string): string {
  return findSeason(id)?.name ?? id;
}

// The Mayhem set to narrow a page to, by the date window its pass ran in
export default function SeasonSelect(props: {
  value: string | undefined;
  onChange: (season: string | undefined) => void;
  // Set inside a filter menu, where the select fills a labelled field
  label?: string;
}) {
  const options = useFilterOptions();
  const seasons = () => options().seasons;

  // Clear the selection if new data leaves it without any matching games
  createEffect(
    () => ({ seasons: seasons(), value: props.value }),
    ({ seasons, value }) => {
      if (value !== undefined && seasons.length > 0 && !seasons.includes(value)) {
        props.onChange(undefined);
      }
    },
  );

  // Each option says whether it is the one chosen: the value can arrive before
  // the options it names do
  const select = () => (
    <select
      value={props.value ?? ""}
      onChange={(e) =>
        props.onChange(e.currentTarget.value === "" ? undefined : e.currentTarget.value)
      }
      class={props.label ? "select w-full" : "select"}
    >
      <option value="">All Sets</option>
      <For each={seasons()}>
        {(s) => (
          <option value={s} selected={props.value === s}>
            {seasonName(s)}
          </option>
        )}
      </For>
    </select>
  );

  return (
    <Show when={props.label} fallback={select()}>
      {(label) => <FilterField label={label()}>{select()}</FilterField>}
    </Show>
  );
}
