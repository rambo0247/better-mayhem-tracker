import type { ReactNode } from "react";
import { ACCENTS, type StatAccent } from "./StatCard";

// A titled section in the StatCard palette: the post-game recap and the season
// recap are both built out of these. The body takes whatever height the panel
// is stretched to, so a list beside a taller neighbour can spread out into it.
export default function Panel({
  title,
  subtitle,
  icon,
  accent,
  className = "",
  children,
}: {
  title: string;
  subtitle?: string;
  icon: ReactNode;
  accent: StatAccent;
  className?: string;
  children: ReactNode;
}) {
  const a = ACCENTS[accent];
  return (
    <div className={`panel flex flex-col overflow-hidden p-4 ${className}`}>
      <div className="mb-3 flex items-center gap-2">
        <span className={`flex h-6 w-6 items-center justify-center rounded-md ${a.chip}`}>
          {icon}
        </span>
        <span className="section-title">{title}</span>
        {subtitle && <span className="text-xs text-lol-text">{subtitle}</span>}
      </div>
      <div className="flex-1">{children}</div>
    </div>
  );
}
