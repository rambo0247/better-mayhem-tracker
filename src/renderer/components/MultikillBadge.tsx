interface MultikillBadgeProps {
  doubles: number;
  triples: number;
  quadras: number;
  pentas: number;
  // Initials instead of words, for a row that has a gap rather than a column to
  // spare. A double kill is common enough that spelling it out ten times over
  // would be the loudest thing on a scoreboard.
  compact?: boolean;
}

export default function MultikillBadge({
  doubles,
  triples,
  quadras,
  pentas,
  compact = false,
}: MultikillBadgeProps) {
  const badges: { label: string; count: number; color: string }[] = [];

  if (doubles > 0)
    badges.push({
      label: "DOUBLE",
      count: doubles,
      color: "bg-sky-400/14 text-sky-400 ring-1 ring-inset ring-sky-400/25",
    });
  if (triples > 0)
    badges.push({
      label: "TRIPLE",
      count: triples,
      color: "bg-amber-400/14 text-amber-400 ring-1 ring-inset ring-amber-400/25",
    });
  if (quadras > 0)
    badges.push({
      label: "QUADRA",
      count: quadras,
      color: "bg-purple-400/14 text-purple-400 ring-1 ring-inset ring-purple-400/25",
    });
  if (pentas > 0)
    badges.push({
      label: "PENTA",
      count: pentas,
      color: "bg-red-400/16 text-red-400 ring-1 ring-inset ring-red-400/35",
    });

  if (badges.length === 0) return null;

  if (compact) {
    return (
      <div className="flex gap-1 whitespace-nowrap">
        {badges.map(({ label, count, color }) => (
          <span
            key={label}
            title={`${label[0]}${label.slice(1).toLowerCase()} kill${count > 1 ? `s x${count}` : ""}`}
            className={`font-num rounded-[2px] px-1 py-[3px] text-[11px] font-bold leading-none ${color}`}
          >
            {label[0]}
            {count > 1 ? count : ""}
          </span>
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-wrap gap-1 whitespace-nowrap">
      {badges.map(({ label, count, color }) => (
        <span
          key={label}
          className={`font-display rounded-[2px] px-1.5 py-[3px] text-[11px] font-bold leading-none tracking-[0.06em] ${color}`}
        >
          {label}
          {count > 1 ? ` ×${count}` : ""}
        </span>
      ))}
    </div>
  );
}
