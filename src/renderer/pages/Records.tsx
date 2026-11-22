import { useEffect, useState } from "react";
import { useIpc } from "../hooks/useIpc";
import { useViewState } from "../hooks/useViewState";
import { useChampionData, getChampionName } from "../hooks/useChampions";
import type { ChampionData, MatchDetail, RecordMatchRef, RecordsData } from "../lib/types";
import ChampionIcon from "../components/ChampionIcon";
import MatchScoreboard from "../components/MatchScoreboard";
import QueueSelect, { queueLabel } from "../components/QueueSelect";
import AccountSelect from "../components/AccountSelect";
import {
  RecordCard,
  recordCards,
  recordDate,
  streakCard,
  type RecordCardDef,
} from "../components/RecordCard";
import { MedalIcon, XIcon } from "../components/icons";
import PageHeader from "../components/PageHeader";
import { LOCALE, formatDuration } from "../lib/format";
import Kda from "../components/Kda";

// ---- Match modal ----

// Records live outside the match list, so their games open here rather than
// deep-linking into an infinitely-scrolled page.
function MatchModal({
  match,
  champData,
  puuids,
  onClose,
}: {
  match: RecordMatchRef;
  champData: ChampionData;
  puuids: string[] | null;
  onClose: () => void;
}) {
  const { data: detail } = useIpc<MatchDetail | null>(
    () => window.api.getMatchDetail(match.game_id),
    [match.game_id],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-6 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        className="panel w-full max-w-[1240px] max-h-full overflow-y-auto shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="panel-head gap-3 py-3">
          <ChampionIcon championId={match.champion_id} size={40} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2.5">
              <span
                className={`slant-sm inline-block px-2 font-display text-[13px] font-extrabold italic leading-5 tracking-[0.08em] ${
                  match.win ? "bg-lol-win/15 text-lol-win" : "bg-lol-loss/15 text-lol-loss"
                }`}
              >
                {match.win ? "VICTORY" : "DEFEAT"}
              </span>
              <span className="truncate font-display text-[18px] font-bold text-lol-text-bright">
                {getChampionName(champData, match.champion_id)}
              </span>
              <span className="font-num text-[16px] font-semibold text-lol-text-bright">
                <Kda kills={match.kills} deaths={match.deaths} assists={match.assists} />
              </span>
            </div>
            <div className="mt-0.5 truncate text-[12px] text-lol-text">
              {queueLabel(match.queue_id)} ·{" "}
              <span className="font-num text-[13px]">{formatDuration(match.game_duration)}</span> ·{" "}
              <span className="font-num text-[13px]">{recordDate(match.game_creation)}</span>
            </div>
          </div>
          <button onClick={onClose} title="Close" className="btn btn-ghost btn-icon shrink-0">
            <XIcon className="h-4 w-4" />
          </button>
        </div>
        <div className="overflow-x-auto p-4">
          {detail ? (
            <MatchScoreboard detail={detail} champData={champData} puuids={puuids} />
          ) : (
            <div className="label py-8 text-center text-[12px]">Loading…</div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---- Page ----

export default function Records() {
  const [queue, setQueue] = useViewState<number | undefined>("records.queue", undefined);
  const [account, setAccount] = useViewState<string | undefined>("records.account", undefined);

  const { data, refetch } = useIpc<RecordsData>(
    () => window.api.getRecords(queue, account),
    [queue, account],
  );
  const champData = useChampionData();
  const [puuids, setPuuids] = useState<string[] | null>(null);
  const [openMatch, setOpenMatch] = useState<RecordMatchRef | null>(null);

  useEffect(() => {
    window.api.getAllSummonerPuuids().then(setPuuids);
  }, []);

  useEffect(() => {
    const unsub = window.api.onGamesUpdated(() => refetch());
    return unsub;
  }, [refetch]);

  if (!data) {
    return <div className="label mt-20 text-center text-[12px]">Loading…</div>;
  }

  // The filters stay on screen even with nothing to show, so a selection that
  // happens to hold no games can be undone
  const header = (
    <PageHeader
      kicker="Achieve"
      title="Records"
      subtitle={
        <>
          Personal bests across{" "}
          <span className="font-num text-[14px] font-semibold text-lol-text-bright">
            {data.totalGames.toLocaleString(LOCALE)}
          </span>{" "}
          {data.totalGames === 1 ? "game" : "games"}
        </>
      }
      actions={
        <>
          <AccountSelect value={account} onChange={setAccount} />
          <QueueSelect value={queue} onChange={setQueue} />
        </>
      }
      className="pb-0"
    />
  );

  if (data.totalGames === 0) {
    return (
      <div className="max-w-[1320px] space-y-6">
        {header}
        <div className="panel flex flex-col items-center gap-3 px-8 py-14 text-center">
          <MedalIcon className="h-8 w-8 text-lol-gold/60" />
          <div className="max-w-md text-[14px] text-lol-text">
            {account || queue != null
              ? "No games match this filter."
              : "No games recorded yet — sync your match history to start setting records."}
          </div>
        </div>
      </div>
    );
  }

  const cards = recordCards(data.bests);
  const streaks: RecordCardDef[] = [];
  if (data.winStreak) streaks.push(streakCard(data.winStreak, true));
  if (data.lossStreak && data.lossStreak.length > 1) {
    // A single loss is just a loss; it only becomes a "streak" worth
    // memorializing at two.
    streaks.push(streakCard(data.lossStreak, false));
  }

  const grid = "grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] items-stretch gap-4";

  return (
    <div className="max-w-[1320px] space-y-6">
      {header}

      {/* Single-game bests and streaks in sections of their own: a streak spans
          days of play, a best is one game */}
      {cards.length > 0 && (
        <section>
          <SectionHead title="Single-game bests" count={cards.length} />
          <div className={grid}>
            {cards.map(({ key, ...card }) => (
              <RecordCard key={key} {...card} champData={champData} onOpen={setOpenMatch} />
            ))}
          </div>
        </section>
      )}

      {streaks.length > 0 && (
        <section>
          <SectionHead title="Streaks" count={streaks.length} />
          {/* Two at most, so they split the row between them rather than
              leaving half of it empty */}
          <div className="grid grid-cols-1 items-stretch gap-4 md:grid-cols-2">
            {streaks.map(({ key, ...card }) => (
              <RecordCard key={key} {...card} champData={champData} onOpen={setOpenMatch} />
            ))}
          </div>
        </section>
      )}

      {openMatch && (
        <MatchModal
          match={openMatch}
          champData={champData}
          puuids={puuids}
          onClose={() => setOpenMatch(null)}
        />
      )}
    </div>
  );
}

// A section's title with its count beside it and a hairline running out to the
// right edge, as Match History heads its days
function SectionHead({ title, count }: { title: string; count: number }) {
  return (
    <div className="mb-3 flex items-center gap-3">
      <h2 className="section-title italic">{title}</h2>
      <span className="font-num text-[14px] text-lol-text">{count}</span>
      <span className="h-px flex-1 bg-lol-line" />
    </div>
  );
}
