import { Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { useLocation } from "@solidjs/router";
import Header, { TitleBar } from "./Header";

export default function Layout(props: { children?: JSX.Element }) {
  const location = useLocation();
  return (
    <div class="flex h-full w-full bg-lol-deep">
      <Header />
      <div class="app-stage relative flex min-w-0 flex-1 flex-col">
        <TitleBar />
        {/* Pages cap their own width; on a window wider than that they sit in
            the middle rather than against the left edge */}
        {/* Scroll padding so a control Tab scrolls into view stops clear of the
            edge, and clear of the sticky table headers, with its focus ring whole */}
        <main class="scrollbar-edge relative flex-1 scroll-pt-14 scroll-pb-6 overflow-y-auto px-8 pb-10 pt-2">
          {/* Keyed by path so each page eases in as it's opened */}
          <Show when={location.pathname} keyed>
            <div class="view-in [&>*]:mx-auto">{props.children}</div>
          </Show>
        </main>
      </div>
    </div>
  );
}
