import { createEffect, createSignal, For, onSettled, Show } from "solid-js";
import { Portal } from "@solidjs/web";
import { CheckIcon } from "./SettingsIcons";

// A dropdown in the app's own colors. The closed control is the same `.select`
// box as before; the list it opens is one of the app's menus rather than the
// system's, which WebKit draws in its own light style whatever the page asks.
//
// The list renders into document.body with fixed coordinates, as HoverCard
// does: a dropdown near the bottom of a settings card would otherwise be cut
// off by the card's overflow. Scrolling or resizing closes it, since the
// coordinates go stale.

export type SelectOption<T> = { value: T; label: string; disabled?: boolean };

const GAP = 6;
const MARGIN = 8;
const MAX_HEIGHT = 320;
// How long typed letters keep adding to one search, as a native select does
const TYPEAHEAD_MS = 600;

let nextId = 0;

export default function Select<T>(props: {
  value: T;
  options: readonly SelectOption<T>[];
  onChange: (value: T) => void;
  // Width and corner overrides for the closed box, e.g. "w-full"
  class?: string;
  "aria-label"?: string;
}) {
  const id = `select-${++nextId}`;
  let button: HTMLButtonElement | undefined;
  let list: HTMLDivElement | undefined;
  const [open, setOpen] = createSignal(false);
  const [highlight, setHighlight] = createSignal(-1);
  const [pos, setPos] = createSignal<{
    top?: number;
    bottom?: number;
    left: number;
    minWidth: number;
    maxHeight: number;
  } | null>(null);
  let typed = "";
  let typedAt = 0;

  const selectedIndex = () => props.options.findIndex((o) => o.value === props.value);
  // A value can arrive before the options that name it; the first option, the
  // "All ..." choice everywhere this is used, stands in until they do
  const label = () => props.options[Math.max(selectedIndex(), 0)]?.label ?? "";

  const enabled = (i: number) => i >= 0 && i < props.options.length && !props.options[i].disabled;

  const step = (from: number, by: number) => {
    let i = from;
    for (let n = 0; n < props.options.length; n++) {
      i += by;
      if (i < 0 || i >= props.options.length) return from;
      if (enabled(i)) return i;
    }
    return from;
  };

  const show = () => {
    if (open()) return;
    setHighlight(enabled(selectedIndex()) ? selectedIndex() : step(-1, 1));
    setOpen(true);
  };

  const close = (refocus = false) => {
    setOpen(false);
    setPos(null);
    if (refocus) button?.focus();
  };

  const choose = (i: number) => {
    if (!enabled(i)) return;
    close(true);
    const option = props.options[i];
    if (option.value !== props.value) props.onChange(option.value);
  };

  // Placed below the box, or above it when the room below runs short, and
  // never off the side of the window
  createEffect(open, (isOpen) => {
    if (!isOpen || !button || !list) return;
    const box = button.getBoundingClientRect();
    const height = Math.min(list.scrollHeight, MAX_HEIGHT);
    const below = window.innerHeight - box.bottom - GAP - MARGIN;
    const above = box.top - GAP - MARGIN;
    const flip = below < height && above > below;
    const width = Math.max(list.scrollWidth, box.width);
    const left = Math.min(box.left, window.innerWidth - width - MARGIN);
    setPos({
      ...(flip ? { bottom: window.innerHeight - box.top + GAP } : { top: box.bottom + GAP }),
      left: Math.max(left, MARGIN),
      minWidth: box.width,
      maxHeight: Math.min(MAX_HEIGHT, flip ? above : below),
    });
  });

  // The highlighted row stays in view as the arrow keys walk a long list
  createEffect(
    () => (open() && pos() ? highlight() : -1),
    (i) => {
      if (i < 0) return;
      list?.querySelector(`#${id}-${i}`)?.scrollIntoView({ block: "nearest" });
    },
  );

  createEffect(open, (isOpen) => {
    if (!isOpen) return;
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!button?.contains(target) && !list?.contains(target)) close();
    };
    const onScroll = (e: Event) => {
      if (!list?.contains(e.target as Node)) close();
    };
    const onResize = () => close();
    document.addEventListener("pointerdown", onPointer);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    window.addEventListener("blur", onResize);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("blur", onResize);
    };
  });

  onSettled(() => () => close());

  // Typing jumps to the next option that starts with what was typed
  const typeahead = (key: string) => {
    const now = Date.now();
    typed = now - typedAt > TYPEAHEAD_MS ? key : typed + key;
    typedAt = now;
    const from = open() ? highlight() : selectedIndex();
    const count = props.options.length;
    const start = typed.length === 1 ? from + 1 : Math.max(from, 0);
    for (let n = 0; n < count; n++) {
      const i = (start + n) % count;
      if (enabled(i) && props.options[i].label.toLowerCase().startsWith(typed)) {
        if (open()) setHighlight(i);
        else choose(i);
        return;
      }
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const last = props.options.length;
    // Kept from the page around it: an Escape here closes this list, not the
    // filter menu it sits in
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (!open()) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
        handled();
        show();
      } else if (e.key.length === 1 && /\S/.test(e.key) && !e.metaKey && !e.ctrlKey) {
        handled();
        typeahead(e.key.toLowerCase());
      }
      return;
    }
    switch (e.key) {
      case "ArrowDown":
        handled();
        setHighlight((i) => step(i, 1));
        return;
      case "ArrowUp":
        handled();
        setHighlight((i) => step(i, -1));
        return;
      case "Home":
        handled();
        setHighlight(step(-1, 1));
        return;
      case "End":
        handled();
        setHighlight(step(last, -1));
        return;
      case "Enter":
      case " ":
        handled();
        choose(highlight());
        return;
      case "Escape":
        handled();
        close(true);
        return;
      case "Tab":
        close();
        return;
      default:
        if (e.key.length === 1 && /\S/.test(e.key) && !e.metaKey && !e.ctrlKey) {
          handled();
          typeahead(e.key.toLowerCase());
        }
    }
  };

  return (
    <>
      <button
        ref={(el) => (button = el)}
        type="button"
        onClick={() => (open() ? close() : show())}
        onKeyDown={onKeyDown}
        aria-haspopup="listbox"
        aria-expanded={open() ? "true" : "false"}
        aria-controls={open() ? id : undefined}
        aria-label={props["aria-label"]}
        class={["select grid grid-cols-[minmax(0,1fr)] text-left", props.class]}
      >
        <span class="col-start-1 row-start-1 truncate">{label()}</span>
        {/* Sized by its longest option, as a native select is, so the toolbar
            doesn't shift as the choice changes */}
        <For each={props.options}>
          {(option) => (
            <span
              aria-hidden="true"
              class="invisible col-start-1 row-start-1 h-0 overflow-hidden whitespace-nowrap"
            >
              {option.label}
            </span>
          )}
        </For>
      </button>
      <Show when={open()}>
        <Portal mount={document.body}>
          <div
            ref={(el) => {
              list = el;
              // A pick inside a filter menu is not a click outside it: the
              // menu listens on the document, so the press stops here
              el.addEventListener("pointerdown", (e) => e.stopPropagation());
            }}
            id={id}
            role="listbox"
            aria-label={props["aria-label"]}
            aria-activedescendant={highlight() >= 0 ? `${id}-${highlight()}` : undefined}
            // Clicks land on the rows without taking focus from the box, so the
            // keyboard keeps working and a filter menu doesn't see focus leave
            onMouseDown={(e) => e.preventDefault()}
            style={{
              top: pos()?.top !== undefined ? `${pos()!.top}px` : undefined,
              bottom: pos()?.bottom !== undefined ? `${pos()!.bottom}px` : undefined,
              left: `${pos()?.left ?? -9999}px`,
              "min-width": `${pos()?.minWidth ?? 0}px`,
              "max-height": `${pos()?.maxHeight ?? MAX_HEIGHT}px`,
              visibility: pos() ? "visible" : "hidden",
            }}
            class="menu fixed z-50 max-w-[22rem] overflow-y-auto py-1"
          >
            <For each={props.options}>
              {(option, i) => {
                const isSelected = () => i() === selectedIndex();
                const isHighlighted = () => i() === highlight();
                return (
                  <div
                    id={`${id}-${i()}`}
                    role="option"
                    aria-selected={isSelected() ? "true" : "false"}
                    aria-disabled={option.disabled ? "true" : undefined}
                    onMouseMove={() => enabled(i()) && setHighlight(i())}
                    onClick={() => choose(i())}
                    class={[
                      "mx-1 flex items-center gap-2.5 rounded-[3px] py-1.5 pl-2.5 pr-2 text-[13px] font-medium whitespace-nowrap",
                      option.disabled
                        ? "cursor-default text-lol-text/45"
                        : isSelected()
                          ? "cursor-pointer text-lol-gold"
                          : "cursor-pointer text-lol-text-bright",
                      isHighlighted() && !option.disabled && "bg-white/[0.06]",
                    ]}
                  >
                    <span class="flex-1">{option.label}</span>
                    <CheckIcon
                      class={["h-3.5 w-3.5 shrink-0", isSelected() ? "opacity-100" : "opacity-0"]}
                    />
                  </div>
                );
              }}
            </For>
          </div>
        </Portal>
      </Show>
    </>
  );
}
