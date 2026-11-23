import { createEffect, For, Show } from "solid-js";
import { useFilterOptions } from "../hooks/useFilterOptions";
import { formatPatch } from "../lib/format";
import { FilterField } from "./FilterMenu";

export default function PatchSelect(props: {
  value: string | undefined;
  onChange: (patch: string | undefined) => void;
  // Set inside a filter menu, where the select fills a labelled field
  label?: string;
}) {
  const options = useFilterOptions();
  const patches = () => options().patches;

  // Clear the selection if new data leaves it without any matching games
  createEffect(
    () => ({ patches: patches(), value: props.value }),
    ({ patches, value }) => {
      if (value !== undefined && patches.length > 0 && !patches.includes(value)) {
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
      <option value="">All Patches</option>
      <For each={patches()}>
        {(p) => (
          <option value={p} selected={props.value === p}>
            Patch {formatPatch(p)}
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
