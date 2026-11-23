import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  onSettled,
  Show,
  Switch,
  untrack,
} from "solid-js";
import type { JSX } from "@solidjs/web";
import { useChampionData } from "../hooks/useChampions";
import { useIpc } from "../hooks/useIpc";
import { useLcuStatus } from "../hooks/useLcuStatus";
import { useLiveGame } from "../hooks/useLiveGame";
import { api } from "../lib/api-shim";
import type {
  ChampionData,
  GameRecap as GameRecapData,
  LcuStatus,
  LiveGameSnapshot,
} from "../lib/types";
import { formatDuration, formatTimeAgo } from "../lib/format";
import { reportFirstContent } from "../lib/perf";
import { queueLabel } from "../components/QueueSelect";
import GameRecap from "../components/GameRecap";
import LiveScoreboard, { LiveEventFeed } from "../components/LiveScoreboard";
import PageHeader from "../components/PageHeader";
import {
  HourglassIcon,
  MapPinIcon,
  RadioIcon,
  SwordsIcon,
  TrophyIcon,
  UsersIcon,
} from "../components/icons";
import { ExportImageButton, ExportImageMessage, useImageExport } from "../components/ExportImage";
import {
  RESULT_RETRY_MS,
  RESULT_WAIT_MS,
  isResolved,
  isWaiting,
  nextRecapGameId,
  pageView,
  recapScreen,
  standbyKind,
} from "./liveGameState";

export default function LiveGame() {
  const live = useLiveGame();
  const status = useLcuStatus();
  const champData = useChampionData();
  const puuids = useIpc(() => api.getAllSummonerPuuids());

  const view = createMemo(() => pageView(live().snapshot, live().lastGame));
  const kind = () => view().kind;
  const target = createMemo(() => {
    const current = view();
    return current.kind === "recap" ? current.target : null;
  });

  createEffect(
    () => kind() !== "loading",
    (ready) => {
      if (ready) reportFirstContent();
    },
  );

  return (
    <Switch>
      <Match when={kind() === "loading"}>
        <div class="label mt-20 text-center">Loading…</div>
      </Match>
      <Match when={kind() === "live"}>
        <LiveView
          snapshot={live().snapshot!}
          receivedAt={live().receivedAt}
          champData={champData()}
        />
      </Match>
      <Match when={kind() === "recap"}>
        <RecapView
          target={target()}
          champData={champData()}
          puuids={puuids.data()}
          status={status()}
        />
      </Match>
    </Switch>
  );
}

// ---- Live ----

function LiveView(props: {
  snapshot: LiveGameSnapshot;
  receivedAt: number;
  champData: ChampionData;
}) {
  // The clock runs between polls rather than jumping three seconds at a time
  const [now, setNow] = createSignal(untrack(() => props.receivedAt));
  onSettled(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  });
  const elapsed = () =>
    props.snapshot.gameTime + Math.max(0, Math.floor((now() - props.receivedAt) / 1000));

  const teamKills = createMemo(() => {
    const totals: Record<number, number> = { 100: 0, 200: 0 };
    for (const player of props.snapshot.players) totals[player.teamId] += player.kills;
    return totals;
  });

  const subtitle = () =>
    [
      props.snapshot.mapName,
      props.snapshot.queueId != null && props.snapshot.queueId > 0
        ? queueLabel(props.snapshot.queueId)
        : null,
    ]
      .filter(Boolean)
      .join(" · ");

  return (
    <div class="max-w-[1320px] space-y-6">
      <PageHeader
        kicker="Play"
        title="Live Game"
        subtitle={subtitle() || "Live scoreboard"}
        actions={<LiveTag inGame={props.snapshot.inGame} />}
        class="pb-0"
      />
      <Show
        when={props.snapshot.players.length > 0}
        fallback={
          <>
            <LiveHeader snapshot={props.snapshot} elapsed={0} teamKills={teamKills()} />
            <div class="panel flex flex-col items-center gap-3 px-8 py-14 text-center">
              <HourglassIcon class="h-8 w-8 text-lol-gold/60" />
              <div class="max-w-md text-[14px] text-lol-text">
                The game is loading. Champions, items and scores appear as soon as it starts.
              </div>
            </div>
          </>
        }
      >
        <LiveHeader snapshot={props.snapshot} elapsed={elapsed()} teamKills={teamKills()} />

        <div class="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_280px]">
          <LiveScoreboard players={props.snapshot.players} champData={props.champData} />

          <div class="panel overflow-hidden">
            <div class="panel-head">
              <span class="flex h-6 w-6 items-center justify-center rounded-md bg-lol-gold/12 text-lol-gold">
                <SwordsIcon class="h-3.5 w-3.5" />
              </span>
              <span class="section-title">Feed</span>
              <Show when={props.snapshot.events.length > 0}>
                <span class="font-num ml-auto text-[13px] text-lol-text/70">
                  {props.snapshot.events.length}
                </span>
              </Show>
            </div>
            <div class="p-3">
              <LiveEventFeed events={props.snapshot.events} />
            </div>
          </div>
        </div>
      </Show>
    </div>
  );
}

// The slanted red tag broadcasts put in the corner while a match is on air
function LiveTag(props: { inGame: boolean }) {
  return (
    <span
      class={[
        "slant inline-flex h-7 items-center gap-2 px-4 font-display text-[14px] font-extrabold italic tracking-[0.12em] uppercase",
        props.inGame ? "bg-lol-loss text-[#1a0508]" : "bg-amber-400 text-[#1a1204]",
      ]}
    >
      <span class="live-pulse h-1.5 w-1.5 rounded-full bg-current" />
      {props.inGame ? "Live" : "Starting"}
    </span>
  );
}

// The broadcast score bug: each side's kills either side of the game clock,
// with the player's own side marked.
function LiveHeader(props: {
  snapshot: LiveGameSnapshot;
  elapsed: number;
  teamKills: Record<number, number>;
}) {
  const ourTeam = () => props.snapshot.players.find((p) => p.isSelf)?.teamId ?? null;

  return (
    <div class="panel relative overflow-hidden">
      {/* Each side tinted in its own colour, fading toward the clock */}
      <span class="pointer-events-none absolute inset-y-0 left-0 w-1/2 bg-gradient-to-r from-sky-400/[0.10] to-transparent" />
      <span class="pointer-events-none absolute inset-y-0 right-0 w-1/2 bg-gradient-to-l from-lol-loss/[0.10] to-transparent" />
      <span class="pointer-events-none absolute inset-y-0 left-0 w-[3px] bg-sky-400" />
      <span class="pointer-events-none absolute inset-y-0 right-0 w-[3px] bg-lol-loss" />

      <div class="relative grid grid-cols-[1fr_auto_1fr] items-center gap-6 px-7 py-5">
        <Side
          teamId={100}
          ourTeam={ourTeam()}
          inGame={props.snapshot.inGame}
          kills={props.teamKills[100] ?? 0}
        />
        <div class="flex flex-col items-center">
          <span class="font-num text-[34px] font-semibold leading-none text-lol-text-bright">
            {formatDuration(props.elapsed)}
          </span>
          <span class="label mt-1.5 flex items-center gap-1 text-[11px] text-lol-text/70">
            <Show when={props.snapshot.mapName} fallback="Game time">
              <MapPinIcon class="h-3 w-3" />
              {props.snapshot.mapName}
            </Show>
          </span>
        </div>
        <Side
          teamId={200}
          ourTeam={ourTeam()}
          inGame={props.snapshot.inGame}
          kills={props.teamKills[200] ?? 0}
        />
      </div>
    </div>
  );
}

function Side(props: {
  teamId: 100 | 200;
  ourTeam: number | null;
  inGame: boolean;
  kills: number;
}) {
  const blue = () => props.teamId === 100;
  return (
    <div class={["flex items-center gap-5", blue() ? "" : "flex-row-reverse text-right"]}>
      <div class="min-w-0">
        <div
          class={[
            "font-display text-[20px] font-extrabold uppercase italic leading-none tracking-[0.04em]",
            blue() ? "text-sky-400" : "text-lol-loss",
          ]}
        >
          {blue() ? "Blue Team" : "Red Team"}
        </div>
        <div class="label mt-1.5 text-[11px] text-lol-text/70">
          {props.ourTeam === props.teamId
            ? "Your team"
            : props.ourTeam != null
              ? "Opponents"
              : "\u00a0"}
        </div>
      </div>
      <Show when={props.inGame}>
        <span
          class={[
            "font-num text-[44px] font-semibold leading-none",
            blue() ? "text-sky-400" : "text-lol-loss",
          ]}
        >
          {props.kills}
        </span>
      </Show>
    </div>
  );
}

// ---- Recap ----

function RecapView(props: {
  target: number | null;
  champData: ChampionData;
  puuids: string[] | null;
  status: LcuStatus;
}) {
  const [recap, setRecap] = createSignal<GameRecapData | null>(null);
  const [loading, setLoading] = createSignal(true);
  // Set when a game finished but its results never turned up, so the page can
  // say why it is showing an older one
  const [gaveUp, setGaveUp] = createSignal(false);
  const exporting = useImageExport();

  const input = () => ({
    target: props.target,
    recapGameId: recap()?.detail.game.game_id ?? null,
    loading: loading(),
    gaveUp: gaveUp(),
  });
  const resolved = createMemo(() => isResolved(input()));
  const waiting = createMemo(() => isWaiting(input()));
  const screen = createMemo(() => recapScreen(input()));

  const load = async (target: number | null) => {
    const result = await api.getGameRecap(target ?? undefined);
    setLoading(false);
    if (!result) return;
    setRecap((previous) =>
      nextRecapGameId(target, previous?.detail.game.game_id ?? null, result.detail.game.game_id) ===
      result.detail.game.game_id
        ? result
        : previous,
    );
  };

  // A new target starts a wait of its own. The recap already on screen stays
  // until the new one arrives, which is what lets it stand in meanwhile.
  createEffect(
    () => props.target,
    () => {
      setGaveUp(false);
      setLoading(true);
    },
    { defer: true },
  );

  createEffect(
    () => ({ target: props.target, resolved: resolved() }),
    ({ target, resolved }) => {
      let cancelled = false;
      const run = () => {
        if (!cancelled) void load(target);
      };
      run();

      // Nothing left to wait for once the game we asked about has landed
      if (resolved)
        return () => {
          cancelled = true;
        };

      const started = Date.now();
      const timer = setInterval(() => {
        if (Date.now() - started > RESULT_WAIT_MS) {
          clearInterval(timer);
          setGaveUp(true);
          return;
        }
        run();
      }, RESULT_RETRY_MS);
      const unsub = api.onGamesUpdated(run);

      return () => {
        cancelled = true;
        clearInterval(timer);
        unsub();
      };
    },
  );

  const offline = () => props.status === "disconnected";
  const state = () =>
    waiting()
      ? "Game over, fetching the results"
      : offline()
        ? "League client offline"
        : "Standing by for your next game";

  return (
    <Show
      when={screen() !== "loading"}
      fallback={<div class="label mt-20 text-center">Loading…</div>}
    >
      <div class="max-w-[1320px] space-y-6">
        <PageHeader
          kicker="Play"
          title="Live Game"
          subtitle={
            <>
              {state()}
              <Show when={recap()}>
                {(r) => ` · last game ${formatTimeAgo(r().detail.game.game_creation)}`}
              </Show>
            </>
          }
          actions={recap() ? <ExportActions recap={recap()!} exporting={exporting} /> : undefined}
          class="pb-0"
        />
        <Show
          when={waiting()}
          fallback={
            <StatusPanel
              kicker="Standby"
              title="Waiting for your next game"
              icon={<RadioIcon class="h-7 w-7" />}
              pulse={!offline()}
              aside={<ClientStatus status={props.status} />}
              features
            >
              {STANDBY_TEXT[standbyKind(props.status, recap() != null)]}
            </StatusPanel>
          }
        >
          <StatusPanel
            kicker="Game over"
            title="Fetching the results…"
            pulse
            icon={<HourglassIcon class="h-7 w-7" />}
          >
            The client publishes the scoreboard a few seconds after the nexus falls.
          </StatusPanel>
        </Show>
        <Show when={recap()}>
          {(r) => (
            <GameRecap
              recap={r()}
              champData={props.champData}
              puuids={props.puuids}
              heading={
                <Show
                  when={waiting()}
                  fallback={
                    <RecapHeading title="Last game">
                      {gaveUp()
                        ? "That game never produced results, so here is your most recent recorded one."
                        : "Your most recent recorded game"}
                    </RecapHeading>
                  }
                >
                  <RecapHeading title="Meanwhile">The game before it</RecapHeading>
                </Show>
              }
            />
          )}
        </Show>
        <ExportImageMessage message={exporting.message()} />
      </div>
    </Show>
  );
}

const STANDBY_TEXT = {
  offline: "Start the League client and this tab follows your next game live.",
  "next-game": "The moment your next game loads, this tab switches to a live scoreboard.",
  "no-games": "No recorded games yet. Play a Mayhem game and it shows up here the moment it ends.",
} as const;

// What a live game brings, so the page reads as waiting for something rather
// than as empty
const LIVE_FEATURES = [
  { icon: UsersIcon, text: "Both teams' levels, KDA, CS and items as they change" },
  { icon: TrophyIcon, text: "Your history with every player you've met" },
  { icon: SwordsIcon, text: "A running feed of kills and objectives" },
];

// The panel that stands in for the scoreboard when no game is running: what
// the page is waiting for, and whether the client it waits on is there at all.
function StatusPanel(props: {
  kicker: string;
  title: string;
  icon: JSX.Element;
  pulse?: boolean;
  aside?: JSX.Element;
  features?: boolean;
  children: JSX.Element;
}) {
  return (
    <div class="panel relative overflow-hidden">
      <span class="pointer-events-none absolute -left-20 -top-28 h-72 w-72 rounded-full bg-lol-gold/[0.06] blur-3xl" />
      <span class="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-lol-gold/70 via-lol-gold/25 to-transparent" />

      <div class="relative flex items-center gap-5 px-6 py-5">
        <div class="relative flex h-14 w-14 shrink-0 items-center justify-center rounded-lg border border-lol-gold/25 bg-lol-gold/[0.08] text-lol-gold">
          {props.icon}
          <Show when={props.pulse}>
            <span class="live-pulse absolute -top-1 -right-1 h-2.5 w-2.5 rounded-full border-2 border-lol-card bg-lol-gold" />
          </Show>
        </div>
        <div class="min-w-0 flex-1">
          <div class="kicker text-[12px]">{props.kicker}</div>
          <div class="mt-1.5 font-display text-[24px] font-bold uppercase leading-none tracking-[0.02em] text-lol-text-bright">
            {props.title}
          </div>
          <div class="mt-2 text-[14px] text-lol-text">{props.children}</div>
        </div>
        {props.aside}
      </div>

      <Show when={props.features}>
        <div class="relative grid grid-cols-3 border-t border-lol-line bg-black/15">
          <For each={LIVE_FEATURES}>
            {(feature) => (
              <div class="flex items-center gap-3 border-l border-lol-line px-6 py-3.5 first:border-l-0">
                <feature.icon class="h-4 w-4 shrink-0 text-lol-text/70" />
                <span class="text-[13px] text-lol-text">{feature.text}</span>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

const CLIENT_STATUS: Record<LcuStatus, { dot: string; label: string }> = {
  connected: { dot: "bg-lol-win", label: "Client connected" },
  ingame: { dot: "bg-sky-400", label: "In game" },
  connecting: { dot: "bg-amber-400", label: "Connecting…" },
  disconnected: { dot: "bg-lol-loss", label: "Client offline" },
};

function ClientStatus(props: { status: LcuStatus }) {
  const entry = () => CLIENT_STATUS[props.status];
  return (
    <span class="flex h-8 shrink-0 items-center gap-2 rounded-lg border border-lol-border bg-black/20 px-3">
      <span class={["h-2 w-2 rounded-full", entry().dot]} />
      <span class="label text-lol-text-bright">{entry().label}</span>
    </span>
  );
}

// Copy and save for the game on screen, in the page's toolbar
function ExportActions(props: {
  recap: GameRecapData;
  exporting: ReturnType<typeof useImageExport>;
}) {
  const card = () => ({ kind: "game", gameId: props.recap.detail.game.game_id }) as const;
  return (
    <>
      <ExportImageButton action="copy" card={card()} exporting={props.exporting} />
      <ExportImageButton action="save" card={card()} exporting={props.exporting} />
    </>
  );
}

// The line above the recap: which game this is, in the day-header style of
// Match History.
function RecapHeading(props: { title: string; children: JSX.Element }) {
  return (
    <div class="flex items-center gap-4 px-0.5">
      <span class="font-display text-[17px] font-bold uppercase italic tracking-[0.04em] text-lol-text-bright">
        {props.title}
      </span>
      <span class="text-[13px] text-lol-text">{props.children}</span>
      <span class="h-px flex-1 bg-gradient-to-r from-lol-border to-transparent" />
    </div>
  );
}
