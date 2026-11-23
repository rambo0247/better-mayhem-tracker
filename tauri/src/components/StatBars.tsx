import { formatCompact } from "../lib/format";

interface StatBarsProps {
  damage: number;
  taken: number;
  heal: number;
  // Highest value any player in that game reached, so bars are comparable
  max: { dmg: number; taken: number; heal: number };
  class?: string;
}

// Damage dealt / taken / healed, each as a share of the game's best.
export default function StatBars(props: StatBarsProps) {
  return (
    <div class={["shrink-0 space-y-[3px]", props.class ?? ""]}>
      <StatBar value={props.damage} max={props.max.dmg} color="bg-red-400" label="DMG" />
      <StatBar value={props.taken} max={props.max.taken} color="bg-sky-400" label="TKN" />
      <StatBar value={props.heal} max={props.max.heal} color="bg-emerald-400" label="HEL" />
    </div>
  );
}

function StatBar(props: { value: number; max: number; color: string; label: string }) {
  const pct = () => (props.max > 0 ? Math.round((props.value / props.max) * 100) : 0);
  return (
    <div class="flex items-center gap-2">
      <span class="font-display w-7 shrink-0 text-[11px] font-bold tracking-[0.04em] text-lol-text">
        {props.label}
      </span>
      <div class="relative h-1.5 flex-1 overflow-hidden rounded-[1px] bg-white/[0.06]">
        <div class={["h-full opacity-80", props.color]} style={{ width: `${pct()}%` }} />
      </div>
      <span class="font-num w-10 shrink-0 text-right text-[13px] font-semibold text-lol-text-bright">
        {props.value > 0 ? formatCompact(props.value) : "—"}
      </span>
    </div>
  );
}
