import { createMemo, Show } from "solid-js";
import type { JSX } from "@solidjs/web";

export type StatAccent = "gold" | "win" | "sky" | "purple";

// A tinted icon chip, so a row of cards reads as distinct tiles rather than one
// flat block. Exported so the Records page can build its clickable cards out of
// the same palette. `bar` is the hairline of colour along the card's top edge.
export const ACCENTS: Record<StatAccent, { chip: string; bar: string }> = {
  gold: { chip: "bg-lol-gold/12 text-lol-gold", bar: "from-lol-gold/70" },
  win: { chip: "bg-lol-win/12 text-lol-win", bar: "from-lol-win/70" },
  sky: { chip: "bg-sky-400/12 text-sky-400", bar: "from-sky-400/70" },
  purple: { chip: "bg-purple-400/12 text-purple-400", bar: "from-purple-400/70" },
};

interface StatCardProps {
  label: string;
  value?: JSX.Element;
  subtext?: JSX.Element;
  icon?: JSX.Element;
  accent?: StatAccent;
  class?: string;
  // Footer content — pinned to the bottom so cards in a grid line up
  children?: JSX.Element;
}

export default function StatCard(props: StatCardProps) {
  const a = () => (props.accent ? ACCENTS[props.accent] : null);
  // Read once and not resolved, as in PageHeader
  const value = createMemo(() => props.value);
  const icon = createMemo(() => props.icon);
  const subtext = createMemo(() => props.subtext);
  const footer = createMemo(() => props.children);

  return (
    <div class={["panel flex flex-col overflow-hidden p-4", props.class ?? ""]}>
      <Show when={a()}>
        {(accent) => (
          <span
            class={[
              "pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r to-transparent",
              accent().bar,
            ]}
          />
        )}
      </Show>
      <div class="mb-2 flex items-center gap-2">
        <Show when={icon() ? a() : null}>
          {(accent) => (
            <span class={["flex h-6 w-6 items-center justify-center rounded-md", accent().chip]}>
              {icon()}
            </span>
          )}
        </Show>
        <span class="label">{props.label}</span>
      </div>
      <Show when={value() !== undefined}>
        <div class="font-num text-[30px] font-semibold leading-none text-lol-text-bright">
          {value()}
        </div>
      </Show>
      <Show when={subtext()}>
        <div class="mt-2 text-[13px] text-lol-text">{subtext()}</div>
      </Show>
      <Show when={footer()}>
        <div class="mt-auto pt-3">{footer()}</div>
      </Show>
    </div>
  );
}
