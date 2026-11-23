import { Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { ACCENTS, type StatAccent } from "./StatCard";

// A titled section in the StatCard palette: the post-game recap and the season
// recap are both built out of these. The body takes whatever height the panel
// is stretched to, so a list beside a taller neighbour can spread out into it.
export default function Panel(props: {
  title: string;
  subtitle?: string;
  icon: JSX.Element;
  accent: StatAccent;
  class?: string;
  children: JSX.Element;
}) {
  return (
    <div class={["panel flex flex-col overflow-hidden p-4", props.class ?? ""]}>
      <div class="mb-3 flex items-center gap-2">
        <span
          class={[
            "flex h-6 w-6 items-center justify-center rounded-md",
            ACCENTS[props.accent].chip,
          ]}
        >
          {props.icon}
        </span>
        <span class="section-title">{props.title}</span>
        <Show when={props.subtitle}>
          <span class="text-xs text-lol-text">{props.subtitle}</span>
        </Show>
      </div>
      <div class="flex-1">{props.children}</div>
    </div>
  );
}
