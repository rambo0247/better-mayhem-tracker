import { createEffect, createMemo, createSignal, For, onSettled, Show } from "solid-js";
import { useIpc } from "../hooks/useIpc";
import { useViewState } from "../hooks/useViewState";
import { useChampionData, getChampionName } from "../hooks/useChampions";
import { api } from "../lib/api-shim";
import { reportFirstContent } from "../lib/perf";
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
function MatchModal(props: {
  match: RecordMatchRef;
  champData: ChampionData;
  puuids: string[] | null;
  onClose: () => void;
}) {
  const { data: detail } = useIpc<MatchDetail | null, [number]>(
    ([gameId]) => api.getMatchDetail(gameId),
    () => [props.match.game_id],
  );

  onSettled(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-6 backdrop-blur-[2px]"
      onClick={() => props.onClose()}
    >
      <div
        class="panel w-full max-w-[1240px] max-h-full overflow-y-auto shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div class="panel-head gap-3 py-3">
          <ChampionIcon championId={props.match.champion_id} size={40} />
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2.5">
              <span
                class={[
                  "slant-sm inline-block px-2 font-display text-[13px] font-extrabold italic leading-5 tracking-[0.08em]",
                  props.match.win ? "bg-lol-win/15 text-lol-win" : "bg-lol-loss/15 text-lol-loss",
                ]}
              >
                {props.match.win ? "VICTORY" : "DEFEAT"}
              </span>
              <span class="truncate font-display text-[18px] font-bold text-lol-text-bright">
                {getChampionName(props.champData, props.match.champion_id)}
              </span>
              <span class="font-num text-[16px] font-semibold text-lol-text-bright">
                <Kda
                  kills={props.match.kills}
                  deaths={props.match.deaths}
                  assists={props.match.assists}
                />
              </span>
            </div>
            <div class="mt-0.5 truncate text-[12px] text-lol-text">
              {queueLabel(props.match.queue_id)} ·{" "}
              <span class="font-num text-[13px]">{formatDuration(props.match.game_duration)}</span>{" "}
              · <span class="font-num text-[13px]">{recordDate(props.match.game_creation)}</span>
            </div>
          </div>
          <button
            onClick={() => props.onClose()}
            title="Close"
            class="btn btn-ghost btn-icon shrink-0"
          >
            <XIcon class="h-4 w-4" />
          </button>
        </div>
        <div class="overflow-x-auto p-4">
          <Show
            when={detail()}
            fallback={<div class="label py-8 text-center text-[12px]">Loading…</div>}
          >
            {(d) => (
              <MatchScoreboard detail={d()} champData={props.champData} puuids={props.puuids} />
            )}
          </Show>
        </div>
      </div>
    </div>
  );
}

// ---- Page ----

export default function Records() {
  const [queue, setQueue] = useViewState<number | undefined>("records.queue", undefined);
  const [account, setAccount] = useViewState<string | undefined>("records.account", undefined);

  const { data, refetch } = useIpc<RecordsData, readonly [number | undefined, string | undefined]>(
    ([q, a]) => api.getRecords(q, a),
    () => [queue(), account()] as const,
  );
  const champData = useChampionData();
  const [puuids, setPuuids] = createSignal<string[] | null>(null);
  const [openMatch, setOpenMatch] = createSignal<RecordMatchRef | null>(null);

  onSettled(() => {
    void api.getAllSummonerPuuids().then((p) => setPuuids(() => p));
    return api.onGamesUpdated(() => void refetch());
  });

  createEffect(data, (d) => {
    if (d) reportFirstContent();
  });

  const cards = createMemo(() => {
    const d = data();
    return d ? recordCards(d.bests) : [];
  });
  const streaks = createMemo(() => {
    const d = data();
    const list: RecordCardDef[] = [];
    if (d?.winStreak) list.push(streakCard(d.winStreak, true));
    // A single loss is just a loss; it only becomes a "streak" worth
    // memorializing at two.
    if (d?.lossStreak && d.lossStreak.length > 1) list.push(streakCard(d.lossStreak, false));
    return list;
  });

  const grid = "grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] items-stretch gap-4";

  return (
    <Show when={data()} fallback={<div class="label mt-20 text-center text-[12px]">Loading…</div>}>
      {(d) => (
        <div class="max-w-[1320px] space-y-6">
          {/* The filters stay on screen even with nothing to show, so a selection
              that happens to hold no games can be undone */}
          <PageHeader
            kicker="Achieve"
            title="Records"
            subtitle={
              <>
                Personal bests across{" "}
                <span class="font-num text-[14px] font-semibold text-lol-text-bright">
                  {d().totalGames.toLocaleString(LOCALE)}
                </span>{" "}
                {d().totalGames === 1 ? "game" : "games"}
              </>
            }
            actions={
              <>
                <AccountSelect value={account()} onChange={setAccount} />
                <QueueSelect value={queue()} onChange={setQueue} />
              </>
            }
            class="pb-0"
          />

          <Show
            when={d().totalGames > 0}
            fallback={
              <div class="panel flex flex-col items-center gap-3 px-8 py-14 text-center">
                <MedalIcon class="h-8 w-8 text-lol-gold/60" />
                <div class="max-w-md text-[14px] text-lol-text">
                  {account() || queue() != null
                    ? "No games match this filter."
                    : "No games recorded yet — sync your match history to start setting records."}
                </div>
              </div>
            }
          >
            {/* Single-game bests and streaks in sections of their own: a streak
                spans days of play, a best is one game */}
            <Show when={cards().length > 0}>
              <section>
                <SectionHead title="Single-game bests" count={cards().length} />
                <div class={grid}>
                  <For each={cards()}>
                    {(card) => (
                      <RecordCard {...card} champData={champData()} onOpen={setOpenMatch} />
                    )}
                  </For>
                </div>
              </section>
            </Show>

            <Show when={streaks().length > 0}>
              <section>
                <SectionHead title="Streaks" count={streaks().length} />
                {/* Two at most, so they split the row between them rather than
                    leaving half of it empty */}
                <div class="grid grid-cols-1 items-stretch gap-4 md:grid-cols-2">
                  <For each={streaks()}>
                    {(card) => (
                      <RecordCard {...card} champData={champData()} onOpen={setOpenMatch} />
                    )}
                  </For>
                </div>
              </section>
            </Show>

            <Show when={openMatch()}>
              {(match) => (
                <MatchModal
                  match={match()}
                  champData={champData()}
                  puuids={puuids()}
                  onClose={() => setOpenMatch(null)}
                />
              )}
            </Show>
          </Show>
        </div>
      )}
    </Show>
  );
}

// A section's title with its count beside it and a hairline running out to the
// right edge, as Match History heads its days
function SectionHead(props: { title: string; count: number }) {
  return (
    <div class="mb-3 flex items-center gap-3">
      <h2 class="section-title italic">{props.title}</h2>
      <span class="font-num text-[14px] text-lol-text">{props.count}</span>
      <span class="h-px flex-1 bg-lol-line" />
    </div>
  );
}
