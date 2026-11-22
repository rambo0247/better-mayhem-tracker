import { useEffect, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { useIpc } from "../hooks/useIpc";
import { useViewState } from "../hooks/useViewState";
import { useChampionData } from "../hooks/useChampions";
import type { SeasonRecap as SeasonRecapData, SeasonSummary } from "../lib/types";
import { CARD_WIDTH, type CardSpec } from "../../shared/card";

// The preview frame around the card at full size: the card plus a 1px border
// either side
const FRAME_WIDTH = CARD_WIDTH + 2;
import { LOCALE } from "../lib/format";
import SeasonRecapCard from "../components/SeasonRecapCard";
import PageHeader from "../components/PageHeader";
import QueueSelect from "../components/QueueSelect";
import AccountSelect from "../components/AccountSelect";
import { ExportImageButton, ExportImageMessage, useImageExport } from "../components/ExportImage";
import { CalendarIcon, EyeOffIcon } from "../components/icons";

function seasonOption(season: SeasonSummary): string {
  const games = `${season.games.toLocaleString(LOCALE)} ${season.games === 1 ? "game" : "games"}`;
  return `${season.name} (${games})`;
}

export default function SeasonRecap() {
  // Unset until chosen, which asks for the latest season with games in it
  const [seasonId, setSeasonId] = useViewState<string | undefined>("season.id", undefined);
  const [queue, setQueue] = useViewState<number | undefined>("season.queue", undefined);
  const [account, setAccount] = useViewState<string | undefined>("season.account", undefined);
  const [hideFriends, setHideFriends] = useViewState("season.hideFriends", false);

  // The sidebar's badge links here naming the season that just ended. That
  // becomes the selection like any other pick, then leaves the address so a
  // later pick from the menu isn't overridden by it.
  const [params, setParams] = useSearchParams();
  const linked = params.get("season");
  if (linked && linked !== seasonId) setSeasonId(linked);
  useEffect(() => {
    if (linked) setParams({}, { replace: true });
  }, [linked, setParams]);

  const { data, loading, refetch } = useIpc<SeasonRecapData | null>(
    () => window.api.getSeasonRecap(seasonId, queue, account),
    [seasonId, queue, account],
  );
  const champData = useChampionData();
  const exporting = useImageExport();

  useEffect(() => {
    const unsub = window.api.onGamesUpdated(() => refetch());
    return unsub;
  }, [refetch]);

  // A pick that isn't on offer, a remembered season this build no longer lists
  // say, goes back to the default
  useEffect(() => {
    if (!loading && data === null && seasonId !== undefined) setSeasonId(undefined);
  }, [loading, data, seasonId, setSeasonId]);

  if (!data) {
    return <div className="mt-20 text-center text-[14px] text-lol-text">Loading...</div>;
  }

  // The season on show, which is the one picked or the default while none has
  // been
  const card: CardSpec = {
    kind: "season",
    seasonId: data.season.id,
    queue,
    account,
    hideFriends,
  };

  return (
    // As wide as the card preview at full size, so the controls line up with
    // its right edge instead of running past it
    <div style={{ maxWidth: FRAME_WIDTH }}>
      <PageHeader
        kicker="Achieve"
        title="Season Recap"
        subtitle="Your season on one card, ready to copy or save as an image"
        actions={
          <>
            <select
              value={data.season.id}
              onChange={(e) => setSeasonId(e.target.value)}
              className="select"
            >
              {data.seasons.map((season) => (
                <option
                  key={season.id}
                  value={season.id}
                  disabled={season.games === 0 && season.id !== data.season.id}
                >
                  {seasonOption(season)}
                </option>
              ))}
            </select>
            <AccountSelect value={account} onChange={setAccount} />
            <QueueSelect value={queue} onChange={setQueue} />
            {data.friends.length > 0 && (
              <button
                onClick={() => setHideFriends((v) => !v)}
                aria-pressed={hideFriends}
                title={
                  hideFriends
                    ? "Your friends' names are hidden on the card"
                    : "Hide your friends' names on the card, for sharing"
                }
                className={`btn ${hideFriends ? "btn-active" : ""}`}
              >
                <EyeOffIcon className="h-4 w-4" />
                Hide friends
              </button>
            )}
            {data.games > 0 && (
              <>
                <ExportImageButton action="copy" card={card} exporting={exporting} />
                <ExportImageButton action="save" card={card} exporting={exporting} />
              </>
            )}
          </>
        }
      />

      {data.games === 0 ? (
        <div className="panel flex flex-col items-center gap-3 py-16 text-center">
          <CalendarIcon className="h-8 w-8 text-lol-gold/60" />
          <p className="text-[14px] text-lol-text">
            {account || queue != null
              ? "No games in this season match this filter."
              : "No games recorded in this season."}
          </p>
        </div>
      ) : (
        <CardPreview>
          <SeasonRecapCard recap={data} champData={champData} hideFriends={hideFriends} />
        </CardPreview>
      )}

      <ExportImageMessage message={exporting.message} />
    </div>
  );
}

// The card at the width it is exported at, zoomed down to whatever room the
// page has. Reflowing it to fit instead would preview a different layout from
// the image that gets saved.
function CardPreview({ children }: { children: ReactNode }) {
  const frame = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      setZoom(Math.min(1, entry.contentRect.width / CARD_WIDTH));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={frame}
      className="overflow-hidden rounded-xl border border-lol-border bg-lol-dark shadow-[0_30px_60px_-30px_rgb(0_0_0/0.85)]"
    >
      <div style={{ width: CARD_WIDTH, zoom }}>{children}</div>
    </div>
  );
}
