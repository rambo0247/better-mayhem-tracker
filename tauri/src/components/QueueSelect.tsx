import { createEffect, For, Show } from "solid-js";
import { QUEUE_LABELS } from "@shared/queues";
import { useFilterOptions } from "../hooks/useFilterOptions";
import { FilterField } from "./FilterMenu";

export function queueLabel(queueId: number): string {
  return QUEUE_LABELS[queueId] ?? `Queue ${queueId}`;
}

export default function QueueSelect(props: {
  value: number | undefined;
  onChange: (queue: number | undefined) => void;
  // Set inside a filter menu, where the select fills a labelled field
  label?: string;
}) {
  const options = useFilterOptions();
  const queues = () => options().queues;

  // Clear the selection if new data leaves it without any matching games
  createEffect(
    () => ({ queues: queues(), value: props.value }),
    ({ queues, value }) => {
      if (value !== undefined && queues.length > 0 && !queues.includes(value)) {
        props.onChange(undefined);
      }
    },
  );

  // Each option says whether it is the one chosen: the value can arrive before
  // the options it names do
  const select = () => (
    <select
      value={String(props.value ?? "")}
      onChange={(e) =>
        props.onChange(e.currentTarget.value === "" ? undefined : Number(e.currentTarget.value))
      }
      class={props.label ? "select w-full" : "select"}
    >
      <option value="">All Queues</option>
      <For each={queues()}>
        {(q) => (
          <option value={q} selected={props.value === q}>
            {queueLabel(q)}
          </option>
        )}
      </For>
    </select>
  );

  // A queue dropdown is noise while the database only holds one queue
  return (
    <Show when={queues().length >= 2}>
      <Show when={props.label} fallback={select()}>
        {(label) => <FilterField label={label()}>{select()}</FilterField>}
      </Show>
    </Show>
  );
}
