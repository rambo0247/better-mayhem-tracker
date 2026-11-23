import { winRateColor, winRatePercent } from "../lib/format";

interface WinRateBarProps {
  wins: number;
  total: number;
}

export default function WinRateBar(props: WinRateBarProps) {
  const rate = () => (props.total > 0 ? (props.wins / props.total) * 100 : 0);

  return (
    <div class="flex items-center gap-2.5">
      <div class="relative h-1.5 min-w-16 flex-1 overflow-hidden rounded-[2px] bg-lol-loss/25">
        <div
          class="h-full rounded-[2px] bg-gradient-to-r from-lol-win/70 to-lol-win transition-all"
          style={{ width: `${rate()}%` }}
        />
        {/* The even-odds line, so 49% and 51% don't read the same */}
        <span class="absolute inset-y-0 left-1/2 w-px bg-lol-dark/70" />
      </div>
      <span
        class={[
          "font-num min-w-11 text-right text-[14px] font-semibold",
          winRateColor(props.wins, props.total),
        ]}
      >
        {winRatePercent(props.wins, props.total)}
      </span>
    </div>
  );
}
