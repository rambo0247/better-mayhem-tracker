import { createEffect, createSignal, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { FunnelIcon } from "./icons";

// A page's filters folded behind one button, so the toolbar keeps to search and
// sort. The badge counts the filters in use, and Reset clears every one of them.
//
// The panel stays mounted while it is closed: some controls inside drop their
// own selection when new data leaves it with no games, and that has to keep
// happening with the menu shut.
export default function FilterMenu(props: {
  active: number;
  onReset: () => void;
  children: JSX.Element;
}) {
  const [open, setOpen] = createSignal(false);
  let root: HTMLDivElement | undefined;
  let toggle: HTMLButtonElement | undefined;
  // WebKit on macOS leaves a clicked button unfocused, where Chromium focuses
  // it on the press, so a click can open the menu with focus on nothing
  let openedUnfocused = false;
  const focusOnNothing = () => !document.activeElement || document.activeElement === document.body;

  createEffect(open, (isOpen) => {
    if (!isOpen) return;
    const onPointer = (e: PointerEvent) => {
      if (!root?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Focus inside the menu would be left on a control that is now hidden,
      // and focus still on nothing is where Chromium has it on the toggle
      if (root?.contains(document.activeElement) || (openedUnfocused && focusOnNothing())) {
        toggle?.focus();
      }
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  });

  return (
    <div
      ref={(el) => (root = el)}
      class="relative"
      // Tabbing on past the last filter closes the menu, rather than leaving it
      // open over whatever took the focus. Only a move to somewhere else: a
      // click on the menu's own background sends focus nowhere and keeps it open.
      // React's onBlur bubbles, so this listens to focusout.
      onFocusOut={(e) => {
        const to = e.relatedTarget as Node | null;
        if (open() && to && !e.currentTarget.contains(to)) setOpen(false);
      }}
    >
      <button
        ref={(el) => (toggle = el)}
        onClick={() => {
          openedUnfocused = !open() && focusOnNothing();
          setOpen((o) => !o);
        }}
        title="Filters"
        aria-expanded={open() ? "true" : "false"}
        class={["btn relative", { "btn-active": props.active > 0 || open() }]}
      >
        <FunnelIcon class="h-3.5 w-3.5" />
        <span>Filters</span>
        <Show when={props.active > 0}>
          <span class="font-num flex h-[18px] min-w-[18px] items-center justify-center rounded-[3px] bg-lol-gold px-1 text-[12px] font-bold text-lol-dark">
            {props.active}
          </span>
        </Show>
      </button>

      <div
        class={[
          { hidden: !open() },
          "menu absolute right-0 top-full z-30 mt-2 w-76 space-y-3.5 p-4",
        ]}
      >
        <div class="flex items-center justify-between">
          <span class="section-title">Filters</span>
          <button
            onClick={() => props.onReset()}
            disabled={props.active === 0}
            class="label text-[11px] transition-colors hover:text-lol-gold disabled:opacity-40 disabled:hover:text-lol-text"
          >
            Reset
          </button>
        </div>
        {props.children}
      </div>
    </div>
  );
}

// One labelled control in a filter menu
export function FilterField(props: { label: string; children: JSX.Element }) {
  return (
    <div class="space-y-1.5">
      <div class="label text-[11px]">{props.label}</div>
      {props.children}
    </div>
  );
}
