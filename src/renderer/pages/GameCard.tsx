import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import type { GameCardData } from "../lib/types";
import { useChampionData } from "../hooks/useChampions";
import { useCardCapture, useLookupGrace } from "../hooks/useCardCapture";
import { formatDateTime, formatDuration } from "../lib/format";
import MatchScoreboard from "../components/MatchScoreboard";
import SummonerIcon from "../components/SummonerIcon";
import BrandMark from "../components/BrandMark";
import { queueLabel } from "../components/QueueSelect";

/**
 * The scoreboard on its own, with no sidebar, no scrolling and nothing
 * interactive: this route exists so the main process can photograph it.
 */
export default function GameCard() {
  const { gameId } = useParams<{ gameId: string }>();
  const id = Number(gameId);
  const validId = Number.isFinite(id);
  const champData = useChampionData();
  const [card, setCard] = useState<GameCardData | null>(null);
  const [puuids, setPuuids] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(
    validId ? null : "That game isn't in the database",
  );

  useEffect(() => {
    if (!validId) return;
    let active = true;
    Promise.all([window.api.getGameCard(id), window.api.getAllSummonerPuuids()]).then(
      ([result, ids]) => {
        if (!active) return;
        setPuuids(ids);
        if (result) setCard(result);
        else setError("That game isn't in the database");
      },
      (err) => {
        if (active) setError(err.message);
      },
    );
    return () => {
      active = false;
    };
  }, [id, validId]);

  const namesOverdue = useLookupGrace();
  const drawn =
    card != null && puuids != null && (Object.keys(champData).length > 0 || namesOverdue);
  const root = useCardCapture(drawn, error);

  if (error) {
    return <div className="p-6 text-[13px] text-lol-text">{error}</div>;
  }

  if (!drawn) return <div className="p-6 text-[13px] text-lol-text">Drawing...</div>;

  // The two team panels are the card, so they get the width to themselves —
  // a panel around them would only draw a box around a box. The stage behind
  // them is painted here because the card window has no app layout to lend it.
  return (
    <div ref={root} className="app-stage relative w-full p-6">
      <div className="relative">
        <CardHeading card={card} puuids={puuids} />
        <div className="mt-5">
          <MatchScoreboard detail={card.detail} champData={champData} puuids={puuids} multikills />
        </div>
      </div>
    </div>
  );
}

// Whose game this was, when, where and how long it ran — everything the
// scoreboard itself doesn't say, which the app never has to state because the
// answer is always "yours, and you were there". An image outlives both.
function CardHeading({ card, puuids }: { card: GameCardData; puuids: string[] | null }) {
  const { game, participants } = card.detail;
  const self = participants?.find(
    (p) => p.puuid != null && (p.puuid === game.puuid || puuids?.includes(p.puuid)),
  );
  const remake = !!game.is_remake;
  const tag = remake
    ? "bg-white/10 text-lol-text"
    : self?.win
      ? "bg-lol-win/15 text-lol-win"
      : "bg-lol-loss/15 text-lol-loss";

  // Set like the season card's banner — kicker, italic display name, the brand
  // in the corner — so every image the app exports carries one identity.
  return (
    <div className="flex items-center gap-5 border-b border-lol-line pb-5">
      <div className="shrink-0 rounded-full bg-gradient-to-b from-lol-gold-light via-lol-gold to-lol-gold/30 p-[2px] shadow-[0_8px_24px_-8px_rgb(212_178_115/0.45)]">
        <SummonerIcon iconId={card.profileIcon} size={60} className="border-2 border-lol-card" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2.5">
          <span className="kicker">{queueLabel(game.queue_id)}</span>
          {self && (
            <span
              className={`slant-sm px-2 font-display text-[13px] font-extrabold uppercase italic leading-5 tracking-[0.08em] ${tag}`}
            >
              {remake ? "Remake" : self.win ? "Victory" : "Defeat"}
            </span>
          )}
        </div>
        {self?.gameName && (
          <div className="mt-2 truncate font-display text-[38px] font-extrabold uppercase italic leading-[0.9] tracking-[0.005em] text-lol-text-bright">
            <bdi>{self.gameName}</bdi>
            {self.tagLine && (
              <span className="ml-2 text-[22px] font-bold text-lol-text/70">
                #<bdi>{self.tagLine}</bdi>
              </span>
            )}
          </div>
        )}
        <div className="mt-2 flex items-center gap-2 text-[14px] text-lol-text">
          <span>{formatDateTime(game.game_creation)}</span>
          {card.mapName && (
            <>
              <Dot />
              <span>{card.mapName}</span>
            </>
          )}
          <Dot />
          <span className="font-num text-[15px]">{formatDuration(game.game_duration)}</span>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2.5 self-start">
        <BrandMark className="h-9 w-9 drop-shadow-[0_4px_12px_rgb(212_178_115/0.3)]" />
        <span className="flex flex-col font-display text-[17px] font-extrabold uppercase italic leading-[0.95] tracking-[0.04em]">
          <span className="text-lol-text-bright">Better Mayhem</span>
          <span className="text-[13px] tracking-[0.26em] text-lol-gold">Tracker</span>
        </span>
      </div>
    </div>
  );
}

function Dot() {
  return <span className="text-lol-text/40">·</span>;
}
