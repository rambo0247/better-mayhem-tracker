import { Show } from "solid-js";
import type { SortDir } from "../hooks/useSort";

interface SortProps<K extends string> {
  sortKey: K;
  sortDir: SortDir;
  onSort: (field: K) => void;
  // Tighter for the two narrow tables that sit side by side on a champion page
  compact?: boolean;
  // Right-aligned, over a column of right-aligned numbers
  numeric?: boolean;
  // What the column holds, for headers whose label is an abbreviation
  hint?: string;
  class?: string;
}

// A clickable column header. Pass it what useSort returns, read:
// <SortHeader sortKey={sort.sortKey()} sortDir={sort.sortDir()} onSort={sort.onSort}
//   label="Games" field="games" />.
export default function SortHeader<K extends string>(
  props: SortProps<K> & { label: string; field: K },
) {
  const active = () => props.sortKey === props.field;

  return (
    <HeaderCell
      compact={props.compact}
      numeric={props.numeric}
      class={props.class}
      label={props.label}
      active={active()}
      sortDir={props.sortDir}
      onClick={() => props.onSort(props.field)}
      title={withHint(
        props.hint,
        active()
          ? props.sortDir === "desc"
            ? "Sorted descending"
            : "Sorted ascending"
          : undefined,
      )}
    />
  );
}

// A header over a column that sorts by several related fields, like the
// multikill total and then each kind on its own. A click on a field sorted
// high-to-low flips it low-to-high; the click after that steps to the next
// field, high-to-low. So every field can be read in either direction, and the
// label names the field in use.
export function CycleSortHeader<K extends string>(
  props: SortProps<K> & { steps: readonly { field: K; label: string }[] },
) {
  const index = () => props.steps.findIndex((s) => s.field === props.sortKey);
  const current = () => props.steps[Math.max(index(), 0)]!;
  const next = () => props.steps[(index() + 1) % props.steps.length]!;
  const flipsNext = () => index() >= 0 && props.sortDir === "desc";

  return (
    <HeaderCell
      compact={props.compact}
      numeric={props.numeric}
      class={props.class}
      label={current().label}
      active={index() >= 0}
      sortDir={props.sortDir}
      onClick={() => props.onSort(flipsNext() ? current().field : next().field)}
      title={withHint(
        props.hint,
        index() < 0
          ? `Click to sort by ${current().label}`
          : flipsNext()
            ? `Sorted by ${current().label}, highest first. Click for lowest first`
            : `Sorted by ${current().label}, lowest first. Click for ${next().label}`,
      )}
    />
  );
}

function withHint(hint: string | undefined, state: string | undefined) {
  return [hint, state].filter(Boolean).join("\n") || undefined;
}

function HeaderCell(props: {
  label: string;
  active: boolean;
  sortDir: SortDir;
  onClick: () => void;
  title: string | undefined;
  compact?: boolean;
  numeric?: boolean;
  class?: string;
}) {
  return (
    <th
      onClick={() => props.onClick()}
      title={props.title}
      class={[
        "font-display relative",
        props.compact ? "px-2 py-2.5 text-[11px]" : "px-3 py-3 text-[12px]",
        props.numeric ? "text-right" : "text-left",
        "font-bold uppercase tracking-[0.07em] cursor-pointer select-none whitespace-nowrap transition-colors",
        props.active
          ? "text-lol-gold-light bg-lol-gold/[0.07]"
          : "text-lol-text hover:text-lol-text-bright hover:bg-white/[0.03]",
        props.class ?? "",
      ]}
    >
      {props.label}
      {/* The sort shows as a bar on the cell's edge rather than a glyph beside the
          label, so it takes no room and cannot shift anything. It sits on the
          edge the order runs toward: the bottom for descending, the top for
          ascending. */}
      <Show when={props.active}>
        <span
          class={[
            "absolute inset-x-0 h-0.5 bg-lol-gold",
            props.sortDir === "desc" ? "bottom-0" : "top-0",
          ]}
        />
      </Show>
    </th>
  );
}
