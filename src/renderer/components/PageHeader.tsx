import type { ReactNode } from "react";

// The head of every page: a small gold kicker naming what the page is part of,
// the title in the display face, an optional line under it, and the page's
// controls on the right.
export default function PageHeader({
  kicker,
  title,
  subtitle,
  actions,
  className = "",
}: {
  kicker?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex flex-wrap items-end justify-between gap-x-6 gap-y-3 pb-5 ${className}`}>
      <div className="min-w-0">
        {kicker && <div className="kicker mb-2">{kicker}</div>}
        <h1 className="page-title truncate">{title}</h1>
        {subtitle && <div className="mt-2 text-[13px] text-lol-text">{subtitle}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
