import { createEffect, createMemo, createSignal, For, onSettled, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { useSearchParams } from "@solidjs/router";
import { CARD_WIDTH, type CardSpec } from "@shared/card";
import { api } from "../lib/api-shim";
import { useIpc } from "../hooks/useIpc";
import { useViewState } from "../hooks/useViewState";
import { useChampionData } from "../hooks/useChampions";
import type { SeasonSummary } from "../lib/types";
import { LOCALE } from "../lib/format";
import { reportFirstContent } from "../lib/perf";
import SeasonRecapCard from "../components/SeasonRecapCard";
import PageHeader from "../components/PageHeader";
import QueueSelect from "../components/QueueSelect";
import AccountSelect from "../components/AccountSelect";
import { ExportImageButton, ExportImageMessage, useImageExport } from "../components/ExportImage";
import { CalendarIcon, EyeOffIcon } from "../components/icons";

// The preview frame around the card at full size: the card plus a 1px border
// either side
const FRAME_WIDTH = CARD_WIDTH + 2;

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
  const [params, setParams] = useSearchParams<{ season?: string }>();
  const linked = createMemo(() => params.season || undefined);
  createEffect(
    () => ({ season: linked(), current: seasonId() }),
    ({ season, current }) => {
      if (!season) return;
      if (season !== current) setSeasonId(season);
      setParams({ season: undefined }, { replace: true });
    },
  );
  // The link wins from the first fetch, before the effect above has moved the
  // selection over, so a badge click doesn't first load the remembered season
  const requested = createMemo(() => linked() ?? seasonId());

  const { data, loading, refetch } = useIpc(
    ([season, queue, account]) => api.getSeasonRecap(season, queue, account),
    () => [requested(), queue(), account()] as const,
  );
  const champData = useChampionData();
  const exporting = useImageExport();

  onSettled(() => api.onGamesUpdated(() => void refetch()));

  // A pick that isn't on offer, a remembered season this build no longer lists
  // say, goes back to the default
  createEffect(
    () => ({ loading: loading(), data: data(), seasonId: seasonId() }),
    (state) => {
      if (!state.loading && state.data === null && state.seasonId !== undefined) {
        setSeasonId(undefined);
      }
    },
  );

  createEffect(
    () => data() != null,
    (loaded) => {
      if (loaded) reportFirstContent();
    },
  );

  return (
    <Show
      when={data()}
      fallback={<div class="mt-20 text-center text-[14px] text-lol-text">Loading...</div>}
    >
      {(recap) => {
        // The season on show, which is the one picked or the default while
        // none has been
        const card = createMemo<CardSpec>(() => ({
          kind: "season",
          seasonId: recap().season.id,
          queue: queue(),
          account: account(),
          hideFriends: hideFriends(),
        }));

        return (
          // As wide as the card preview at full size, so the controls line up
          // with its right edge instead of running past it
          <div style={{ "max-width": `${FRAME_WIDTH}px` }}>
            <PageHeader
              kicker="Achieve"
              title="Season Recap"
              subtitle="Your season on one card, ready to copy or save as an image"
              actions={
                <>
                  <select
                    value={recap().season.id}
                    onChange={(e) => setSeasonId(e.currentTarget.value)}
                    class="select"
                  >
                    <For each={recap().seasons}>
                      {(season) => (
                        <option
                          value={season.id}
                          disabled={season.games === 0 && season.id !== recap().season.id}
                        >
                          {seasonOption(season)}
                        </option>
                      )}
                    </For>
                  </select>
                  <AccountSelect value={account()} onChange={setAccount} />
                  <QueueSelect value={queue()} onChange={setQueue} />
                  <Show when={recap().friends.length > 0}>
                    <button
                      onClick={() => setHideFriends((v) => !v)}
                      aria-pressed={hideFriends() ? "true" : "false"}
                      title={
                        hideFriends()
                          ? "Your friends' names are hidden on the card"
                          : "Hide your friends' names on the card, for sharing"
                      }
                      class={["btn", { "btn-active": hideFriends() }]}
                    >
                      <EyeOffIcon class="h-4 w-4" />
                      Hide friends
                    </button>
                  </Show>
                  <Show when={recap().games > 0}>
                    <ExportImageButton action="copy" card={card()} exporting={exporting} />
                    <ExportImageButton action="save" card={card()} exporting={exporting} />
                  </Show>
                </>
              }
            />

            <Show
              when={recap().games > 0}
              fallback={
                <div class="panel flex flex-col items-center gap-3 py-16 text-center">
                  <CalendarIcon class="h-8 w-8 text-lol-gold/60" />
                  <p class="text-[14px] text-lol-text">
                    {account() || queue() != null
                      ? "No games in this season match this filter."
                      : "No games recorded in this season."}
                  </p>
                </div>
              }
            >
              <CardPreview>
                <SeasonRecapCard
                  recap={recap()}
                  champData={champData()}
                  hideFriends={hideFriends()}
                />
              </CardPreview>
            </Show>

            <ExportImageMessage message={exporting.message()} />
          </div>
        );
      }}
    </Show>
  );
}

// The card at the width it is exported at, zoomed down to whatever room the
// page has. Reflowing it to fit instead would preview a different layout from
// the image that gets saved.
function CardPreview(props: { children: JSX.Element }) {
  let frame: HTMLDivElement | undefined;
  const [zoom, setZoom] = createSignal(1);

  onSettled(() => {
    const el = frame;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      setZoom(Math.min(1, entry.contentRect.width / CARD_WIDTH));
    });
    observer.observe(el);
    return () => observer.disconnect();
  });

  return (
    <div
      ref={(el) => {
        frame = el;
      }}
      class="overflow-hidden rounded-xl border border-lol-border bg-lol-dark shadow-[0_30px_60px_-30px_rgb(0_0_0/0.85)]"
    >
      {/* WebKit leaves rem lengths in flex and grid gaps unzoomed, so the card's spacing scale is
          pinned in px, the same 0.25rem Tailwind's default resolves to at a 16px root. */}
      <div style={{ width: `${CARD_WIDTH}px`, zoom: zoom(), "--spacing": "4px" }}>
        {props.children}
      </div>
    </div>
  );
}
