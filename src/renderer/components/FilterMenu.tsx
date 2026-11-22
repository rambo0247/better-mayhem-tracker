import { useEffect, useRef, useState, type ReactNode } from "react";
import { FunnelIcon } from "./icons";

// A page's filters folded behind one button, so the toolbar keeps to search and
// sort. The badge counts the filters in use, and Reset clears every one of them.
//
// The panel stays mounted while it is closed: some controls inside drop their
// own selection when new data leaves it with no games, and that has to keep
// happening with the menu shut.
export default function FilterMenu({
  active,
  onReset,
  children,
}: {
  active: number;
  onReset: () => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        title="Filters"
        aria-expanded={open}
        className={`btn relative ${active > 0 || open ? "btn-active" : ""}`}
      >
        <FunnelIcon className="h-3.5 w-3.5" />
        <span>Filters</span>
        {active > 0 && (
          <span className="font-num flex h-[18px] min-w-[18px] items-center justify-center rounded-[3px] bg-lol-gold px-1 text-[12px] font-bold text-lol-dark">
            {active}
          </span>
        )}
      </button>

      <div
        className={`${open ? "" : "hidden"} menu absolute right-0 top-full z-30 mt-2 w-76 space-y-3.5 p-4`}
      >
        <div className="flex items-center justify-between">
          <span className="section-title">Filters</span>
          <button
            onClick={onReset}
            disabled={active === 0}
            className="label text-[11px] transition-colors hover:text-lol-gold disabled:opacity-40 disabled:hover:text-lol-text"
          >
            Reset
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

// One labelled control in a filter menu
export function FilterField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="label text-[11px]">{label}</div>
      {children}
    </div>
  );
}
