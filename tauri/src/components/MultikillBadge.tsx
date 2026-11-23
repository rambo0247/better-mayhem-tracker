import { For, Show } from "solid-js";

interface MultikillBadgeProps {
  doubles: number;
  triples: number;
  quadras: number;
  pentas: number;
  // Initials instead of words, for a row that has a gap rather than a column to
  // spare. A double kill is common enough that spelling it out ten times over
  // would be the loudest thing on a scoreboard.
  compact?: boolean;
}

type Badge = { label: string; count: number; color: string };

export default function MultikillBadge(props: MultikillBadgeProps) {
  const badges = () => {
    const out: Badge[] = [];
    if (props.doubles > 0)
      out.push({
        label: "DOUBLE",
        count: props.doubles,
        color: "bg-sky-400/14 text-sky-400 ring-1 ring-inset ring-sky-400/25",
      });
    if (props.triples > 0)
      out.push({
        label: "TRIPLE",
        count: props.triples,
        color: "bg-amber-400/14 text-amber-400 ring-1 ring-inset ring-amber-400/25",
      });
    if (props.quadras > 0)
      out.push({
        label: "QUADRA",
        count: props.quadras,
        color: "bg-purple-400/14 text-purple-400 ring-1 ring-inset ring-purple-400/25",
      });
    if (props.pentas > 0)
      out.push({
        label: "PENTA",
        count: props.pentas,
        color: "bg-red-400/16 text-red-400 ring-1 ring-inset ring-red-400/35",
      });
    return out;
  };

  return (
    <Show when={badges().length > 0}>
      <Show
        when={props.compact}
        fallback={
          <div class="flex flex-wrap gap-1 whitespace-nowrap">
            <For each={badges()} keyed={(badge) => badge.label}>
              {(badge) => (
                <span
                  class={[
                    "font-display rounded-[2px] px-1.5 py-[3px] text-[11px] font-bold leading-none tracking-[0.06em]",
                    badge().color,
                  ]}
                >
                  {badge().label}
                  {badge().count > 1 ? ` ×${badge().count}` : ""}
                </span>
              )}
            </For>
          </div>
        }
      >
        <div class="flex gap-1 whitespace-nowrap">
          <For each={badges()} keyed={(badge) => badge.label}>
            {(badge) => (
              <span
                title={`${badge().label[0]}${badge().label.slice(1).toLowerCase()} kill${badge().count > 1 ? `s x${badge().count}` : ""}`}
                class={[
                  "font-num rounded-[2px] px-1 py-[3px] text-[11px] font-bold leading-none",
                  badge().color,
                ]}
              >
                {badge().label[0]}
                {badge().count > 1 ? badge().count : ""}
              </span>
            )}
          </For>
        </div>
      </Show>
    </Show>
  );
}
