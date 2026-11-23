import { Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { useExpandedMatch } from "../hooks/useExpandedMatch";
import type { ChampionData, MatchListItem } from "../lib/types";
import { formatDateTime, formatDuration, formatTimeAgo } from "../lib/format";
import MatchScoreboard from "./MatchScoreboard";
import { ChevronDownIcon } from "./icons";

// One game on a friend's or a group's page, drawn like a Match History row: the
// result, the players' lines as `children`, and when it was played. A click
// opens the full scoreboard.
export default function SharedGameRow(props: {
  match: MatchListItem;
  champData: ChampionData;
  expansion: ReturnType<typeof useExpandedMatch>;
  children: JSX.Element;
}) {
  const expanded = () => props.expansion.expandedId() === props.match.game_id;
  const isWin = () => !!props.match.win;

  return (
    <div
      class={[
        "overflow-hidden rounded-md border transition-colors",
        expanded() ? "border-lol-border bg-lol-card" : "border-lol-line bg-lol-card/80",
      ]}
    >
      <button
        onClick={() => void props.expansion.toggleExpand(props.match.game_id)}
        aria-expanded={expanded() ? "true" : "false"}
        class="group relative flex min-h-[72px] w-full items-center gap-4 py-3 pl-5 pr-4 text-left transition-colors hover:bg-white/[0.025]"
      >
        <span
          class={["absolute inset-y-0 left-0 w-[3px]", isWin() ? "bg-lol-win" : "bg-lol-loss"]}
        />
        <span
          class={[
            "pointer-events-none absolute inset-y-0 left-0 w-[45%] bg-gradient-to-r to-transparent",
            isWin() ? "from-lol-win/[0.11]" : "from-lol-loss/[0.11]",
          ]}
        />

        {/* Result and length */}
        <div class="relative w-[68px] shrink-0">
          <div
            class={[
              "slant-sm inline-block px-2 font-display text-[13px] font-extrabold italic leading-5 tracking-[0.08em]",
              isWin() ? "bg-lol-win/15 text-lol-win" : "bg-lol-loss/15 text-lol-loss",
            ]}
          >
            {isWin() ? "VICTORY" : "DEFEAT"}
          </div>
          <div class="font-num mt-1 text-[13px] text-lol-text">
            {formatDuration(props.match.game_duration)}
          </div>
        </div>

        {props.children}

        {/* A set width, so a long date can't shift this row's columns off the others' */}
        <div class="relative w-[4.5rem] shrink-0 text-right">
          <div
            class="ml-auto w-fit text-[13px] font-medium text-lol-text-bright/85"
            title={formatDateTime(props.match.game_creation)}
          >
            {formatTimeAgo(props.match.game_creation)}
          </div>
          <ChevronDownIcon
            class={[
              "ml-auto mt-1 h-3.5 w-3.5 text-lol-text/50 transition-transform group-hover:text-lol-text",
              { "rotate-180 text-lol-gold": expanded() },
            ]}
          />
        </div>
      </button>

      <Show when={expanded()}>
        <div class="overflow-x-auto border-t border-lol-line bg-black/20 p-4">
          <Show
            when={!props.expansion.detailLoading()}
            fallback={<div class="label py-6 text-center text-[12px]">Loading…</div>}
          >
            <Show when={props.expansion.detail()}>
              {(detail) => (
                <MatchScoreboard
                  detail={detail()}
                  champData={props.champData}
                  puuids={props.expansion.puuids()}
                />
              )}
            </Show>
          </Show>
        </div>
      </Show>
    </div>
  );
}

// Column heads over a list of these rows, laid out with the row's own fixed
// parts so whatever `children` lays out lines up with the rows' `children`
export function SharedGameHeader(props: { children: JSX.Element }) {
  return (
    <div class="flex items-end gap-4 border-x border-transparent pb-2 pl-5 pr-4">
      <div class="w-[68px] shrink-0" />
      {props.children}
      <div class="w-[4.5rem] shrink-0" />
    </div>
  );
}
