import { formatCompact } from "../lib/format";

interface StatBarsProps {
  damage: number;
  taken: number;
  heal: number;
  // Highest value any player in that game reached, so bars are comparable
  max: { dmg: number; taken: number; heal: number };
  className?: string;
}

// Damage dealt / taken / healed, each as a share of the game's best.
export default function StatBars({ damage, taken, heal, max, className = "" }: StatBarsProps) {
  return (
    <div className={`shrink-0 space-y-[3px] ${className}`}>
      <StatBar value={damage} max={max.dmg} color="bg-red-400" label="DMG" />
      <StatBar value={taken} max={max.taken} color="bg-sky-400" label="TKN" />
      <StatBar value={heal} max={max.heal} color="bg-emerald-400" label="HEL" />
    </div>
  );
}

function StatBar({
  value,
  max,
  color,
  label,
}: {
  value: number;
  max: number;
  color: string;
  label: string;
}) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className="flex items-center gap-2">
      <span className="font-display w-7 shrink-0 text-[11px] font-bold tracking-[0.04em] text-lol-text">
        {label}
      </span>
      <div className="relative h-1.5 flex-1 overflow-hidden rounded-[1px] bg-white/[0.06]">
        <div className={`h-full opacity-80 ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="font-num w-10 shrink-0 text-right text-[13px] font-semibold text-lol-text-bright">
        {value > 0 ? formatCompact(value) : "—"}
      </span>
    </div>
  );
}
