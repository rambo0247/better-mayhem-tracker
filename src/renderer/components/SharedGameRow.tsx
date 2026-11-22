import type { ReactNode } from "react";
import type { useExpandedMatch } from "../hooks/useExpandedMatch";
import type { ChampionData, MatchListItem } from "../lib/types";
import { formatDateTime, formatDuration, formatTimeAgo } from "../lib/format";
import MatchScoreboard from "./MatchScoreboard";
import { ChevronDownIcon } from "./icons";

// One game on a friend's or a group's page, drawn like a Match History row: the
// result, the players' lines as `children`, and when it was played. A click
// opens the full scoreboard.
export default function SharedGameRow({
  match,
  champData,
  expansion,
  children,
}: {
  match: MatchListItem;
  champData: ChampionData;
  expansion: ReturnType<typeof useExpandedMatch>;
  children: ReactNode;
}) {
  const { puuids, expandedId, detail, detailLoading, toggleExpand } = expansion;
  const expanded = expandedId === match.game_id;
  const isWin = !!match.win;
  const edge = isWin ? "bg-lol-win" : "bg-lol-loss";
  const tint = isWin ? "from-lol-win/[0.11]" : "from-lol-loss/[0.11]";
  const tag = isWin ? "bg-lol-win/15 text-lol-win" : "bg-lol-loss/15 text-lol-loss";

  return (
    <div
      className={`overflow-hidden rounded-md border transition-colors ${
        expanded ? "border-lol-border bg-lol-card" : "border-lol-line bg-lol-card/80"
      }`}
    >
      <button
        onClick={() => toggleExpand(match.game_id)}
        aria-expanded={expanded}
        className="group relative flex min-h-[72px] w-full items-center gap-4 py-3 pl-5 pr-4 text-left transition-colors hover:bg-white/[0.025]"
      >
        <span className={`absolute inset-y-0 left-0 w-[3px] ${edge}`} />
        <span
          className={`pointer-events-none absolute inset-y-0 left-0 w-[45%] bg-gradient-to-r ${tint} to-transparent`}
        />

        {/* Result and length */}
        <div className="relative w-[68px] shrink-0">
          <div
            className={`slant-sm inline-block px-2 font-display text-[13px] font-extrabold italic leading-5 tracking-[0.08em] ${tag}`}
          >
            {isWin ? "VICTORY" : "DEFEAT"}
          </div>
          <div className="font-num mt-1 text-[13px] text-lol-text">
            {formatDuration(match.game_duration)}
          </div>
        </div>

        {children}

        {/* A set width, so a long date can't shift this row's columns off the others' */}
        <div className="relative w-[4.5rem] shrink-0 text-right">
          <div
            className="ml-auto w-fit text-[13px] font-medium text-lol-text-bright/85"
            title={formatDateTime(match.game_creation)}
          >
            {formatTimeAgo(match.game_creation)}
          </div>
          <ChevronDownIcon
            className={`ml-auto mt-1 h-3.5 w-3.5 text-lol-text/50 transition-transform group-hover:text-lol-text ${
              expanded ? "rotate-180 text-lol-gold" : ""
            }`}
          />
        </div>
      </button>

      {expanded && (
        <div className="overflow-x-auto border-t border-lol-line bg-black/20 p-4">
          {detailLoading ? (
            <div className="label py-6 text-center text-[12px]">Loading…</div>
          ) : detail ? (
            <MatchScoreboard detail={detail} champData={champData} puuids={puuids} />
          ) : null}
        </div>
      )}
    </div>
  );
}

// Column heads over a list of these rows, laid out with the row's own fixed
// parts so whatever `children` lays out lines up with the rows' `children`
export function SharedGameHeader({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-end gap-4 border-x border-transparent pb-2 pl-5 pr-4">
      <div className="w-[68px] shrink-0" />
      {children}
      <div className="w-[4.5rem] shrink-0" />
    </div>
  );
}
