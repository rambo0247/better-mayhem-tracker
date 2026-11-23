import { onSettled } from "solid-js";
import type { JSX } from "@solidjs/web";
import BrandMark from "./BrandMark";

const FOCUSABLE =
  'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

// The shell the update and what's-new dialogs share: a dark blurred scrim, and
// a panel with a titled head, a body that can shrink to fit the window (the
// release notes inside it scroll), and a footer strip of actions. A click on the
// scrim dismisses, unless `onDismiss` is left out to keep the dialog up.
export default function DialogFrame(props: {
  // The control the user pressed to open the dialog. WebKit on macOS leaves a
  // clicked button unfocused, so focus alone can't say where to return.
  opener?: HTMLElement;
  kicker: JSX.Element;
  title: JSX.Element;
  onDismiss?: () => void;
  footer: JSX.Element;
  children: JSX.Element;
}) {
  let panel: HTMLDivElement | undefined;

  // Modal in fact as well as in name: focus moves into the dialog, Tab cycles
  // through its controls instead of wandering to the page behind the scrim,
  // Escape does what a click on the scrim does, and focus goes back where it
  // was once the dialog closes.
  onSettled(() => {
    const active = document.activeElement as HTMLElement | null;
    const previous = !active || active === document.body ? (props.opener ?? active) : active;
    panel?.focus();
    const onKey = (e: KeyboardEvent) => {
      const root = panel;
      if (!root) return;
      if (e.key === "Escape" && props.onDismiss) {
        e.preventDefault();
        props.onDismiss();
        return;
      }
      if (e.key !== "Tab") return;
      const controls = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (el) => el.offsetParent !== null,
      );
      if (controls.length === 0) {
        e.preventDefault();
        return;
      }
      const first = controls[0]!;
      const last = controls[controls.length - 1]!;
      const at = document.activeElement;
      if (e.shiftKey && (at === first || at === root || !root.contains(at))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (at === last || !root.contains(at))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (previous?.isConnected) previous.focus();
    };
  });

  return (
    <div
      class="fixed inset-0 z-50 flex items-center justify-center bg-[#03060f]/70 backdrop-blur-[6px]"
      onClick={() => props.onDismiss?.()}
    >
      <div
        ref={(el) => (panel = el)}
        role="dialog"
        aria-modal="true"
        // Holds focus while the dialog opens, without a ring around all of it
        tabindex={-1}
        class="panel view-in outline-none flex max-h-[85vh] w-[34rem] max-w-[90vw] flex-col overflow-hidden shadow-[0_30px_80px_-20px_rgb(0_0_0/0.85)]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* A hairline of gold along the top edge, as the stat cards carry */}
        <span class="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-lol-gold/70 via-lol-gold/25 to-transparent" />
        <div class="flex items-center gap-3.5 px-6 pt-6">
          <BrandMark class="h-10 w-10 shrink-0 drop-shadow-[0_4px_12px_rgb(212_178_115/0.25)]" />
          <div class="min-w-0">
            <div class="kicker mb-1.5">{props.kicker}</div>
            <h2 class="font-display text-[26px] font-extrabold uppercase italic leading-none tracking-[0.01em] text-lol-text-bright">
              {props.title}
            </h2>
          </div>
        </div>
        <div class="flex min-h-0 flex-1 flex-col px-6 pt-4 pb-5">{props.children}</div>
        <div class="flex items-center justify-between gap-2 border-t border-lol-line bg-black/20 px-6 py-3.5">
          {props.footer}
        </div>
      </div>
    </div>
  );
}

// The version you have and the one you're getting, side by side
export function VersionJump(props: { from?: string; to?: string }) {
  return (
    <div class="flex items-center gap-2.5">
      <span class="chip h-6 bg-white/[0.05] px-2 font-num normal-case text-[13px] text-lol-text">
        v{props.from}
      </span>
      <svg viewBox="0 0 24 12" class="h-3 w-6 text-lol-gold/70" fill="none" aria-hidden="true">
        <path d="M1 6h20m-5-4.5L21 6l-5 4.5" stroke="currentColor" stroke-width="1.8" />
      </svg>
      <span class="chip h-6 bg-lol-gold/14 px-2 font-num normal-case text-[13px] text-lol-gold-light">
        v{props.to}
      </span>
    </div>
  );
}
