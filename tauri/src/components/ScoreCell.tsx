import { Show } from "solid-js";
import { formatDecimal, scoreColor } from "../lib/format";

type Badge = "MVP" | "ACE" | null;

// MVP on the winning team, ACE on the losing one. Sized to sit under a score in
// a table row; `large` is for the recap header, where it sits beside one.
export function ScoreBadge(props: { badge: "MVP" | "ACE"; large?: boolean }) {
  return (
    <div
      class={[
        "slant-sm font-display font-extrabold italic tracking-[0.06em]",
        props.large
          ? "px-2.5 text-[13px] leading-[20px]"
          : "mx-auto w-fit px-1.5 text-[11px] leading-[15px]",
        props.badge === "MVP" ? "bg-amber-400 text-[#2a1c00]" : "bg-purple-400 text-[#1b0b3a]",
      ]}
    >
      {props.badge}
    </div>
  );
}

// A game's score with its badge underneath, as the match rows draw it. An
// unscored game (a remake, or one stored before scoring existed) leaves the
// column empty rather than showing a zero.
export default function ScoreCell(props: { score: number | null; badge: Badge }) {
  return (
    <div class="w-11 shrink-0 text-center">
      <Show when={props.score != null}>
        <div class={["font-num text-[20px] font-semibold leading-none", scoreColor(props.score!)]}>
          {formatDecimal(props.score!)}
        </div>
        <div class="mt-1">
          <Show
            when={props.badge}
            fallback={<div class="label text-[11px] leading-[15px] text-lol-text/80">score</div>}
          >
            {(badge) => <ScoreBadge badge={badge()} />}
          </Show>
        </div>
      </Show>
    </div>
  );
}
