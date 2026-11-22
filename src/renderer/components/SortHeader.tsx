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
  className?: string;
}

// A clickable column header. Spread what useSort returns to wire one up:
// <SortHeader {...sort} label="Games" field="games" />.
export default function SortHeader<K extends string>({
  label,
  field,
  sortKey,
  sortDir,
  onSort,
  ...cell
}: SortProps<K> & { label: string; field: K }) {
  const active = sortKey === field;

  return (
    <HeaderCell
      {...cell}
      label={label}
      active={active}
      sortDir={sortDir}
      onClick={() => onSort(field)}
      title={withHint(
        cell.hint,
        active ? (sortDir === "desc" ? "Sorted descending" : "Sorted ascending") : undefined,
      )}
    />
  );
}

// A header over a column that sorts by several related fields, like the
// multikill total and then each kind on its own. A click on a field sorted
// high-to-low flips it low-to-high; the click after that steps to the next
// field, high-to-low. So every field can be read in either direction, and the
// label names the field in use.
export function CycleSortHeader<K extends string>({
  steps,
  sortKey,
  sortDir,
  onSort,
  ...cell
}: SortProps<K> & { steps: readonly { field: K; label: string }[] }) {
  const index = steps.findIndex((s) => s.field === sortKey);
  const current = steps[Math.max(index, 0)];
  const next = steps[(index + 1) % steps.length];
  const flipsNext = index >= 0 && sortDir === "desc";

  return (
    <HeaderCell
      {...cell}
      label={current.label}
      active={index >= 0}
      sortDir={sortDir}
      onClick={() => onSort(flipsNext ? current.field : next.field)}
      title={withHint(
        cell.hint,
        index < 0
          ? `Click to sort by ${current.label}`
          : flipsNext
            ? `Sorted by ${current.label}, highest first. Click for lowest first`
            : `Sorted by ${current.label}, lowest first. Click for ${next.label}`,
      )}
    />
  );
}

function withHint(hint: string | undefined, state: string | undefined) {
  return [hint, state].filter(Boolean).join("\n") || undefined;
}

function HeaderCell({
  label,
  active,
  sortDir,
  onClick,
  title,
  compact = false,
  numeric = false,
  className = "",
}: {
  label: string;
  active: boolean;
  sortDir: SortDir;
  onClick: () => void;
  title: string | undefined;
  compact?: boolean;
  numeric?: boolean;
  hint?: string;
  className?: string;
}) {
  return (
    <th
      onClick={onClick}
      title={title}
      className={`font-display relative ${compact ? "px-2 py-2.5 text-[11px]" : "px-3 py-3 text-[12px]"} ${
        numeric ? "text-right" : "text-left"
      } font-bold uppercase tracking-[0.07em] cursor-pointer select-none whitespace-nowrap transition-colors ${
        active
          ? "text-lol-gold-light bg-lol-gold/[0.07]"
          : "text-lol-text hover:text-lol-text-bright hover:bg-white/[0.03]"
      } ${className}`}
    >
      {label}
      {/* The sort shows as a bar on the cell's edge rather than a glyph beside the
          label, so it takes no room and cannot shift anything. It sits on the
          edge the order runs toward: the bottom for descending, the top for
          ascending. */}
      {active && (
        <span
          className={`absolute inset-x-0 h-0.5 bg-lol-gold ${
            sortDir === "desc" ? "bottom-0" : "top-0"
          }`}
        />
      )}
    </th>
  );
}
