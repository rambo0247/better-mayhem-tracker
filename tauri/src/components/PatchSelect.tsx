import { createEffect, Show } from "solid-js";
import { useFilterOptions } from "../hooks/useFilterOptions";
import { formatPatch } from "../lib/format";
import { FilterField } from "./FilterMenu";
import Select from "./Select";

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

  const select = () => (
    <Select
      value={props.value}
      options={[
        { value: undefined, label: "All Patches" },
        ...patches().map((p) => ({ value: p, label: `Patch ${formatPatch(p)}` })),
      ]}
      onChange={props.onChange}
      class={props.label ? "w-full" : undefined}
    />
  );

  return (
    <Show when={props.label} fallback={select()}>
      {(label) => <FilterField label={label()}>{select()}</FilterField>}
    </Show>
  );
}
