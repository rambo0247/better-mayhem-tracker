import { createEffect, createMemo, createSignal, Show } from "solid-js";
import { useParams } from "@solidjs/router";
import type { GameCardData } from "../lib/types";
import { api } from "../lib/api-shim";
import { useChampionData } from "../hooks/useChampions";
import { useCardCapture, useLookupGrace } from "../hooks/useCardCapture";
import { formatDateTime, formatDuration } from "../lib/format";
import MatchScoreboard from "../components/MatchScoreboard";
import SummonerIcon from "../components/SummonerIcon";
import BrandMark from "../components/BrandMark";
import { queueLabel } from "../components/QueueSelect";

const MISSING = "That game isn't in the database";

/**
 * The scoreboard on its own, with no sidebar, no scrolling and nothing
 * interactive: this route exists so the main process can photograph it.
 */
export default function GameCard() {
  const params = useParams<{ gameId: string }>();
  const champData = useChampionData();
  const [card, setCard] = createSignal<GameCardData | null>(null);
  const [puuids, setPuuids] = createSignal<string[] | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  createEffect(
    () => Number(params.gameId),
    (id) => {
      if (!Number.isFinite(id)) {
        setError(MISSING);
        return;
      }
      let active = true;
      Promise.all([api.getGameCard(id), api.getAllSummonerPuuids()]).then(
        ([result, ids]) => {
          if (!active) return;
          setPuuids(() => ids);
          if (result) setCard(() => result);
          else setError(MISSING);
        },
        (err: Error) => {
          if (active) setError(err.message);
        },
      );
      return () => {
        active = false;
      };
    },
  );

  const namesOverdue = useLookupGrace();
  const drawn = createMemo(
    () =>
      card() != null && puuids() != null && (Object.keys(champData()).length > 0 || namesOverdue()),
  );
  const root = useCardCapture(drawn, error);

  return (
    <Show when={!error()} fallback={<div class="p-6 text-[13px] text-lol-text">{error()}</div>}>
      <Show when={drawn()} fallback={<div class="p-6 text-[13px] text-lol-text">Drawing...</div>}>
        {/* The two team panels are the card, so they get the width to themselves
            — a panel around them would only draw a box around a box. The stage
            behind them is painted here because the card window has no app layout
            to lend it. */}
        <div ref={root} class="app-stage relative w-full p-6">
          <div class="relative">
            <CardHeading card={card()!} puuids={puuids()} />
            <div class="mt-5">
              <MatchScoreboard
                detail={card()!.detail}
                champData={champData()}
                puuids={puuids()}
                multikills
              />
            </div>
          </div>
        </div>
      </Show>
    </Show>
  );
}

// Whose game this was, when, where and how long it ran — everything the
// scoreboard itself doesn't say, which the app never has to state because the
// answer is always "yours, and you were there". An image outlives both.
function CardHeading(props: { card: GameCardData; puuids: string[] | null }) {
  const game = () => props.card.detail.game;
  const self = createMemo(() =>
    props.card.detail.participants?.find(
      (p) => p.puuid != null && (p.puuid === game().puuid || props.puuids?.includes(p.puuid)),
    ),
  );
  const remake = () => !!game().is_remake;
  const tag = () =>
    remake()
      ? "bg-white/10 text-lol-text"
      : self()?.win
        ? "bg-lol-win/15 text-lol-win"
        : "bg-lol-loss/15 text-lol-loss";

  // Set like the season card's banner — kicker, italic display name, the brand
  // in the corner — so every image the app exports carries one identity.
  return (
    <div class="flex items-center gap-5 border-b border-lol-line pb-5">
      <div class="shrink-0 rounded-full bg-gradient-to-b from-lol-gold-light via-lol-gold to-lol-gold/30 p-[2px] shadow-[0_8px_24px_-8px_rgb(212_178_115/0.45)]">
        <SummonerIcon iconId={props.card.profileIcon} size={60} class="border-2 border-lol-card" />
      </div>
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2.5">
          <span class="kicker">{queueLabel(game().queue_id)}</span>
          <Show when={self()}>
            {(player) => (
              <span
                class={[
                  "slant-sm px-2 font-display text-[13px] font-extrabold uppercase italic leading-5 tracking-[0.08em]",
                  tag(),
                ]}
              >
                {remake() ? "Remake" : player().win ? "Victory" : "Defeat"}
              </span>
            )}
          </Show>
        </div>
        <Show when={self()?.gameName}>
          <div class="mt-2 truncate font-display text-[38px] font-extrabold uppercase italic leading-[0.9] tracking-[0.005em] text-lol-text-bright">
            <bdi>{self()!.gameName}</bdi>
            <Show when={self()!.tagLine}>
              <span class="ml-2 text-[22px] font-bold text-lol-text/70">
                #<bdi>{self()!.tagLine}</bdi>
              </span>
            </Show>
          </div>
        </Show>
        <div class="mt-2 flex items-center gap-2 text-[14px] text-lol-text">
          <span>{formatDateTime(game().game_creation)}</span>
          <Show when={props.card.mapName}>
            <Dot />
            <span>{props.card.mapName}</span>
          </Show>
          <Dot />
          <span class="font-num text-[15px]">{formatDuration(game().game_duration)}</span>
        </div>
      </div>
      <div class="flex shrink-0 items-center gap-2.5 self-start">
        <BrandMark class="h-9 w-9 drop-shadow-[0_4px_12px_rgb(212_178_115/0.3)]" />
        <span class="flex flex-col font-display text-[17px] font-extrabold uppercase italic leading-[0.95] tracking-[0.04em]">
          <span class="text-lol-text-bright">Better Mayhem</span>
          <span class="text-[13px] tracking-[0.26em] text-lol-gold">Tracker</span>
        </span>
      </div>
    </div>
  );
}

function Dot() {
  return <span class="text-lol-text/40">·</span>;
}
