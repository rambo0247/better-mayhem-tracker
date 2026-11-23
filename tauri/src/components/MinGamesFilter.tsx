import { createSignal } from "solid-js";
import { FilterField } from "./FilterMenu";

// The fewest games a row needs to be listed, so a champion played twice can't
// top a sorted table on a lucky streak. The slider spans the counts the page
// has; the field beside it takes any number. Undefined is off: the slider's
// far left, or an empty field, lists every row.
export default function MinGamesFilter(props: {
  value: number | undefined;
  onChange: (min: number | undefined) => void;
  // The largest count among the page's rows
  max: number;
  label?: string;
}) {
  // The field follows the slider and Reset, but a number still being typed is
  // left alone while it means the same minimum: typing 15 passes through 1.
  const [draft, setDraft] = createSignal<string>((typed) =>
    typed !== undefined && parseMin(typed) === props.value
      ? typed
      : (props.value?.toString() ?? ""),
  );

  return (
    <FilterField label={props.label ?? "Min games"}>
      <div class="flex items-center gap-3">
        <input
          type="range"
          min={1}
          max={Math.max(props.max, props.value ?? 1, 2)}
          value={props.value ?? 1}
          onInput={(e) => props.onChange(parseMin(e.currentTarget.value))}
          class="min-w-0 flex-1 accent-lol-gold"
        />
        <input
          type="number"
          min={1}
          value={draft()}
          placeholder="Off"
          onInput={(e) => {
            setDraft(e.currentTarget.value);
            props.onChange(parseMin(e.currentTarget.value));
          }}
          class="input w-16 px-2 text-right tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        />
      </div>
    </FilterField>
  );
}

// Every row has at least one game, so a minimum of one is no minimum
function parseMin(text: string): number | undefined {
  const n = Number.parseInt(text, 10);
  return n > 1 ? n : undefined;
}
