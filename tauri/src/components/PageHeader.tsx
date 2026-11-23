import { children, Show } from "solid-js";
import type { JSX } from "@solidjs/web";

// The head of every page: a small gold kicker naming what the page is part of,
// the title in the display face, an optional line under it, and the page's
// controls on the right.
export default function PageHeader(props: {
  kicker?: JSX.Element;
  title: JSX.Element;
  subtitle?: JSX.Element;
  actions?: JSX.Element;
  class?: string;
}) {
  // Resolved once: each read of a JSX prop would build its nodes again
  const kicker = children(() => props.kicker);
  const subtitle = children(() => props.subtitle);
  const actions = children(() => props.actions);
  return (
    <div
      class={["flex flex-wrap items-end justify-between gap-x-6 gap-y-3 pb-5", props.class ?? ""]}
    >
      <div class="min-w-0">
        <Show when={kicker()}>
          <div class="kicker mb-2">{kicker()}</div>
        </Show>
        <h1 class="page-title truncate">{props.title}</h1>
        <Show when={subtitle()}>
          <div class="mt-2 text-[13px] text-lol-text">{subtitle()}</div>
        </Show>
      </div>
      <Show when={actions()}>
        <div class="flex flex-wrap items-center gap-2">{actions()}</div>
      </Show>
    </div>
  );
}
