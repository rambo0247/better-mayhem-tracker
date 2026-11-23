import { createEffect, createSignal, onSettled, Show } from "solid-js";
import { Portal, type JSX } from "@solidjs/web";

// A hover tooltip rich enough to hold markup, for the places a native title=
// attribute can only show a name.
//
// It renders into document.body rather than beside its trigger: every caller
// sits inside a scrolling table or an expanded match row, and an absolutely
// positioned card would be clipped by that container's overflow. Body-level
// means fixed coordinates, so the card is measured after mount and flipped to
// whichever side of the trigger it fits on.

const GAP = 8;
const MARGIN = 8;
// Long enough that skimming a row of items doesn't flash six cards, short
// enough that pausing on one feels immediate.
const OPEN_DELAY_MS = 260;

type Position = { top: number; left: number };

/**
 * `content` is a render function rather than markup, so a table of icons
 * builds no card until one is hovered. Leave it out for an icon with nothing
 * to say yet.
 */
export default function HoverCard(props: {
  content?: (() => JSX.Element) | null;
  children: JSX.Element;
  width?: number;
}) {
  let trigger: HTMLSpanElement | undefined;
  let card: HTMLDivElement | undefined;
  const [open, setOpen] = createSignal(false);
  const [pos, setPos] = createSignal<Position | null>(null);
  let timer: ReturnType<typeof setTimeout> | null = null;

  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  onSettled(() => cancel);

  const show = () => {
    if (!props.content) return;
    cancel();
    timer = setTimeout(() => setOpen(true), OPEN_DELAY_MS);
  };

  const hide = () => {
    cancel();
    setOpen(false);
    setPos(null);
  };

  // Measured rather than guessed: the card's height depends on how much text
  // the item has, which decides whether it goes above or below.
  createEffect(open, (isOpen) => {
    if (!isOpen || !trigger || !card) return;

    // The wrapper is display:contents so it can sit inside the grids and flex
    // rows that hold the icons without adding a box of its own — which also
    // means it has no box to measure, and its own rect is all zeros. The
    // child is what the cursor is actually over.
    const anchored = trigger.firstElementChild ?? trigger;
    const anchor = anchored.getBoundingClientRect();
    const { width: cardW, height: cardH } = card.getBoundingClientRect();

    const below = anchor.bottom + GAP;
    const above = anchor.top - GAP - cardH;
    // Prefer below, flip up when it would run off the bottom, and give up on
    // flipping if neither side fits — clamping keeps it on screen either way.
    const top = below + cardH <= window.innerHeight - MARGIN || above < MARGIN ? below : above;

    const left = anchor.left + anchor.width / 2 - cardW / 2;
    const maxLeft = window.innerWidth - cardW - MARGIN;

    setPos({
      top: Math.min(Math.max(top, MARGIN), Math.max(window.innerHeight - cardH - MARGIN, MARGIN)),
      left: Math.min(Math.max(left, MARGIN), Math.max(maxLeft, MARGIN)),
    });
  });

  // A card pinned to viewport coordinates goes stale the moment the list under
  // it moves, and there's no trigger left under the cursor to close it.
  createEffect(open, (isOpen) => {
    if (!isOpen) return;
    const onScroll = () => hide();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  });

  return (
    <>
      <span
        ref={(el) => (trigger = el)}
        class="contents"
        onMouseEnter={show}
        onMouseLeave={hide}
        onPointerDown={hide}
      >
        {props.children}
      </span>
      <Show when={open() ? props.content : null}>
        {(content) => (
          <Portal mount={document.body}>
            <div
              ref={(el) => (card = el)}
              role="tooltip"
              // Rendered off-screen for the first frame so measuring it doesn't
              // flash the card at the wrong spot.
              style={{
                top: `${pos()?.top ?? -9999}px`,
                left: `${pos()?.left ?? -9999}px`,
                width: `${props.width ?? 300}px`,
                visibility: pos() ? "visible" : "hidden",
              }}
              class="menu fixed z-50 pointer-events-none max-w-80 px-3.5 py-2.5 text-[13px] leading-relaxed text-lol-text"
            >
              {content()()}
            </div>
          </Portal>
        )}
      </Show>
    </>
  );
}
