import { useEffect, useRef, type ReactNode } from "react";
import BrandMark from "./BrandMark";

const FOCUSABLE =
  'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

// The shell the update and what's-new dialogs share: a dark blurred scrim, and
// a panel with a titled head, a body that can shrink to fit the window (the
// release notes inside it scroll), and a footer strip of actions. A click on the
// scrim dismisses, unless `onDismiss` is left out to keep the dialog up.
export default function DialogFrame({
  kicker,
  title,
  onDismiss,
  footer,
  children,
}: {
  kicker: ReactNode;
  title: ReactNode;
  onDismiss?: () => void;
  footer: ReactNode;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  // The key handler is set up once; this keeps it calling the latest dismiss
  const dismiss = useRef(onDismiss);
  useEffect(() => {
    dismiss.current = onDismiss;
  });

  // Modal in fact as well as in name: focus moves into the dialog, Tab cycles
  // through its controls instead of wandering to the page behind the scrim,
  // Escape does what a click on the scrim does, and focus goes back where it
  // was once the dialog closes.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      const root = panel.current;
      if (!root) return;
      if (e.key === "Escape" && dismiss.current) {
        e.preventDefault();
        dismiss.current();
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
      const first = controls[0];
      const last = controls[controls.length - 1];
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
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[#03060f]/70 backdrop-blur-[6px]"
      onClick={onDismiss}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        // Holds focus while the dialog opens, without a ring around all of it
        tabIndex={-1}
        className="panel view-in outline-none flex max-h-[85vh] w-[34rem] max-w-[90vw] flex-col overflow-hidden shadow-[0_30px_80px_-20px_rgb(0_0_0/0.85)]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* A hairline of gold along the top edge, as the stat cards carry */}
        <span className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-lol-gold/70 via-lol-gold/25 to-transparent" />
        <div className="flex items-center gap-3.5 px-6 pt-6">
          <BrandMark className="h-10 w-10 shrink-0 drop-shadow-[0_4px_12px_rgb(212_178_115/0.25)]" />
          <div className="min-w-0">
            <div className="kicker mb-1.5">{kicker}</div>
            <h2 className="font-display text-[26px] font-extrabold uppercase italic leading-none tracking-[0.01em] text-lol-text-bright">
              {title}
            </h2>
          </div>
        </div>
        <div className="flex min-h-0 flex-1 flex-col px-6 pt-4 pb-5">{children}</div>
        <div className="flex items-center justify-between gap-2 border-t border-lol-line bg-black/20 px-6 py-3.5">
          {footer}
        </div>
      </div>
    </div>
  );
}

// The version you have and the one you're getting, side by side
export function VersionJump({ from, to }: { from?: string; to?: string }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="chip h-6 bg-white/[0.05] px-2 font-num normal-case text-[13px] text-lol-text">
        v{from}
      </span>
      <svg viewBox="0 0 24 12" className="h-3 w-6 text-lol-gold/70" fill="none" aria-hidden>
        <path d="M1 6h20m-5-4.5L21 6l-5 4.5" stroke="currentColor" strokeWidth="1.8" />
      </svg>
      <span className="chip h-6 bg-lol-gold/14 px-2 font-num normal-case text-[13px] text-lol-gold-light">
        v{to}
      </span>
    </div>
  );
}
