import { formatDecimal, scoreColor } from "../lib/format";

type Badge = "MVP" | "ACE" | null;

// MVP on the winning team, ACE on the losing one. Sized to sit under a score in
// a table row; `large` is for the recap header, where it sits beside one.
export function ScoreBadge({ badge, large = false }: { badge: "MVP" | "ACE"; large?: boolean }) {
  return (
    <div
      className={`slant-sm font-display font-extrabold italic tracking-[0.06em] ${
        large
          ? "px-2.5 text-[13px] leading-[20px]"
          : "mx-auto w-fit px-1.5 text-[11px] leading-[15px]"
      } ${badge === "MVP" ? "bg-amber-400 text-[#2a1c00]" : "bg-purple-400 text-[#1b0b3a]"}`}
    >
      {badge}
    </div>
  );
}

// A game's score with its badge underneath, as the match rows draw it. An
// unscored game (a remake, or one stored before scoring existed) leaves the
// column empty rather than showing a zero.
export default function ScoreCell({ score, badge }: { score: number | null; badge: Badge }) {
  return (
    <div className="w-11 shrink-0 text-center">
      {score != null && (
        <>
          <div className={`font-num text-[20px] font-semibold leading-none ${scoreColor(score)}`}>
            {formatDecimal(score)}
          </div>
          <div className="mt-1">
            {badge ? (
              <ScoreBadge badge={badge} />
            ) : (
              <div className="label text-[11px] leading-[15px] text-lol-text/80">score</div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
