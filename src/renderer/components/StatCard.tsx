import type { ReactNode } from "react";

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
  value?: ReactNode;
  subtext?: ReactNode;
  icon?: ReactNode;
  accent?: StatAccent;
  className?: string;
  // Footer content — pinned to the bottom so cards in a grid line up
  children?: ReactNode;
}

export default function StatCard({
  label,
  value,
  subtext,
  icon,
  accent,
  className = "",
  children,
}: StatCardProps) {
  const a = accent ? ACCENTS[accent] : null;

  return (
    <div className={`panel flex flex-col overflow-hidden p-4 ${className}`}>
      {a && (
        <span
          className={`pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r ${a.bar} to-transparent`}
        />
      )}
      <div className="mb-2 flex items-center gap-2">
        {icon && a && (
          <span className={`flex h-6 w-6 items-center justify-center rounded-md ${a.chip}`}>
            {icon}
          </span>
        )}
        <span className="label">{label}</span>
      </div>
      {value !== undefined && (
        <div className="font-num text-[30px] font-semibold leading-none text-lol-text-bright">
          {value}
        </div>
      )}
      {subtext && <div className="mt-2 text-[13px] text-lol-text">{subtext}</div>}
      {children && <div className="mt-auto pt-3">{children}</div>}
    </div>
  );
}
