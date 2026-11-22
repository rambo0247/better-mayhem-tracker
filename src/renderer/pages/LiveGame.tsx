import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useChampionData } from "../hooks/useChampions";
import { useLcuStatus } from "../hooks/useLcuStatus";
import { useLiveGame } from "../hooks/useLiveGame";
import type {
  ChampionData,
  GameRecap as GameRecapData,
  LcuStatus,
  LiveGameSnapshot,
} from "../lib/types";
import { MAYHEM_QUEUE_IDS } from "../../shared/queues";
import { formatDuration, formatTimeAgo } from "../lib/format";
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

// How long to keep waiting for a finished game's results before giving up and
// showing the most recent recorded one instead. The post-game capture normally
// lands within seconds; this only matters when the client never publishes the
// game at all, which a dodged or unfinished match manages.
const RESULT_WAIT_MS = 90_000;
const RESULT_RETRY_MS = 4_000;

// Whether a finished game is one the app would have stored, so the page knows
// whether to wait for results at all. A game in some other queue is recorded
// nowhere and would leave the page waiting forever.
function isTrackedQueue(queueId: number | null): boolean {
  return queueId != null && MAYHEM_QUEUE_IDS.includes(queueId);
}

export default function LiveGame() {
  const { snapshot, receivedAt, lastGame } = useLiveGame();
  const status = useLcuStatus();
  const champData = useChampionData();
  const [puuids, setPuuids] = useState<string[] | null>(null);

  useEffect(() => {
    window.api.getAllSummonerPuuids().then(setPuuids);
  }, []);

  // Nothing has been asked yet, as opposed to asked and answered with no game
  if (!snapshot) return <div className="label mt-20 text-center">Loading…</div>;

  if (snapshot.inGame || snapshot.starting) {
    return <LiveView snapshot={snapshot} receivedAt={receivedAt} champData={champData} />;
  }

  // Null means "whatever the newest recorded game is", which is what the page
  // falls back to on a fresh launch and after a game that was never stored.
  // The snapshot carries the last game the main process saw, which is what
  // covers leaving the tab and coming back before the results have landed.
  const watching =
    lastGame ??
    (snapshot.gameId != null ? { gameId: snapshot.gameId, queueId: snapshot.queueId } : null);
  const target = watching && isTrackedQueue(watching.queueId) ? watching.gameId : null;

  return <RecapView target={target} champData={champData} puuids={puuids} status={status} />;
}

// ---- Live ----

function LiveView({
  snapshot,
  receivedAt,
  champData,
}: {
  snapshot: LiveGameSnapshot;
  receivedAt: number;
  champData: ChampionData;
}) {
  // The clock runs between polls rather than jumping three seconds at a time
  const [now, setNow] = useState(receivedAt);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const elapsed = snapshot.gameTime + Math.max(0, Math.floor((now - receivedAt) / 1000));

  const teamKills = useMemo(() => {
    const totals = { 100: 0, 200: 0 } as Record<number, number>;
    for (const player of snapshot.players) totals[player.teamId] += player.kills;
    return totals;
  }, [snapshot.players]);

  const subtitle = [
    snapshot.mapName,
    snapshot.queueId != null && snapshot.queueId > 0 ? queueLabel(snapshot.queueId) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const header = (
    <PageHeader
      kicker="Play"
      title="Live Game"
      subtitle={subtitle || "Live scoreboard"}
      actions={<LiveTag inGame={snapshot.inGame} />}
      className="pb-0"
    />
  );

  if (snapshot.players.length === 0) {
    return (
      <div className="max-w-[1320px] space-y-6">
        {header}
        <LiveHeader snapshot={snapshot} elapsed={0} teamKills={teamKills} />
        <div className="panel flex flex-col items-center gap-3 px-8 py-14 text-center">
          <HourglassIcon className="h-8 w-8 text-lol-gold/60" />
          <div className="max-w-md text-[14px] text-lol-text">
            The game is loading. Champions, items and scores appear as soon as it starts.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-[1320px] space-y-6">
      {header}
      <LiveHeader snapshot={snapshot} elapsed={elapsed} teamKills={teamKills} />

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_280px]">
        <LiveScoreboard players={snapshot.players} champData={champData} />

        <div className="panel overflow-hidden">
          <div className="panel-head">
            <span className="flex h-6 w-6 items-center justify-center rounded-md bg-lol-gold/12 text-lol-gold">
              <SwordsIcon className="h-3.5 w-3.5" />
            </span>
            <span className="section-title">Feed</span>
            {snapshot.events.length > 0 && (
              <span className="font-num ml-auto text-[13px] text-lol-text/70">
                {snapshot.events.length}
              </span>
            )}
          </div>
          <div className="p-3">
            <LiveEventFeed events={snapshot.events} />
          </div>
        </div>
      </div>
    </div>
  );
}

// The slanted red tag broadcasts put in the corner while a match is on air
function LiveTag({ inGame }: { inGame: boolean }) {
  return (
    <span
      className={`slant inline-flex h-7 items-center gap-2 px-4 font-display text-[14px] font-extrabold italic tracking-[0.12em] uppercase ${
        inGame ? "bg-lol-loss text-[#1a0508]" : "bg-amber-400 text-[#1a1204]"
      }`}
    >
      <span className="live-pulse h-1.5 w-1.5 rounded-full bg-current" />
      {inGame ? "Live" : "Starting"}
    </span>
  );
}

// The broadcast score bug: each side's kills either side of the game clock,
// with the player's own side marked.
function LiveHeader({
  snapshot,
  elapsed,
  teamKills,
}: {
  snapshot: LiveGameSnapshot;
  elapsed: number;
  teamKills: Record<number, number>;
}) {
  const ourTeam = snapshot.players.find((p) => p.isSelf)?.teamId ?? null;

  const side = (teamId: 100 | 200) => {
    const blue = teamId === 100;
    return (
      <div className={`flex items-center gap-5 ${blue ? "" : "flex-row-reverse text-right"}`}>
        <div className="min-w-0">
          <div
            className={`font-display text-[20px] font-extrabold uppercase italic leading-none tracking-[0.04em] ${
              blue ? "text-sky-400" : "text-lol-loss"
            }`}
          >
            {blue ? "Blue Team" : "Red Team"}
          </div>
          <div className="label mt-1.5 text-[11px] text-lol-text/70">
            {ourTeam === teamId ? "Your team" : ourTeam != null ? "Opponents" : " "}
          </div>
        </div>
        {snapshot.inGame && (
          <span
            className={`font-num text-[44px] font-semibold leading-none ${
              blue ? "text-sky-400" : "text-lol-loss"
            }`}
          >
            {teamKills[teamId] ?? 0}
          </span>
        )}
      </div>
    );
  };

  return (
    <div className="panel relative overflow-hidden">
      {/* Each side tinted in its own colour, fading toward the clock */}
      <span className="pointer-events-none absolute inset-y-0 left-0 w-1/2 bg-gradient-to-r from-sky-400/[0.10] to-transparent" />
      <span className="pointer-events-none absolute inset-y-0 right-0 w-1/2 bg-gradient-to-l from-lol-loss/[0.10] to-transparent" />
      <span className="pointer-events-none absolute inset-y-0 left-0 w-[3px] bg-sky-400" />
      <span className="pointer-events-none absolute inset-y-0 right-0 w-[3px] bg-lol-loss" />

      <div className="relative grid grid-cols-[1fr_auto_1fr] items-center gap-6 px-7 py-5">
        {side(100)}
        <div className="flex flex-col items-center">
          <span className="font-num text-[34px] font-semibold leading-none text-lol-text-bright">
            {formatDuration(elapsed)}
          </span>
          <span className="label mt-1.5 flex items-center gap-1 text-[11px] text-lol-text/70">
            {snapshot.mapName ? (
              <>
                <MapPinIcon className="h-3 w-3" />
                {snapshot.mapName}
              </>
            ) : (
              "Game time"
            )}
          </span>
        </div>
        {side(200)}
      </div>
    </div>
  );
}

// ---- Recap ----

function RecapView({
  target,
  champData,
  puuids,
  status,
}: {
  target: number | null;
  champData: ChampionData;
  puuids: string[] | null;
  status: LcuStatus;
}) {
  const [recap, setRecap] = useState<GameRecapData | null>(null);
  const [loading, setLoading] = useState(true);
  const exporting = useImageExport();
  // Set when a game finished but its results never turned up, so the page can
  // say why it is showing an older one
  const [gaveUp, setGaveUp] = useState(false);

  const resolved = target == null ? recap != null : recap?.detail.game.game_id === target;

  const load = useCallback(async () => {
    const result = await window.api.getGameRecap(target ?? undefined);
    setLoading(false);
    if (!result) return;
    setRecap((previous) => {
      // While waiting on one specific game, an older one is worth showing only
      // until the real answer arrives, never in place of it
      if (target != null && result.detail.game.game_id !== target && previous != null) {
        return previous;
      }
      return result;
    });
  }, [target]);

  // A new target starts a wait of its own. The recap already on screen stays
  // until the new one arrives, which is what lets it stand in meanwhile.
  const [waitingFor, setWaitingFor] = useState(target);
  if (waitingFor !== target) {
    setWaitingFor(target);
    setGaveUp(false);
    setLoading(true);
  }

  useEffect(() => {
    let cancelled = false;
    const run = () => {
      if (!cancelled) void load();
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
    const unsub = window.api.onGamesUpdated(run);

    return () => {
      cancelled = true;
      clearInterval(timer);
      unsub();
    };
  }, [load, resolved]);

  const waiting = target != null && !resolved && !gaveUp;

  if (loading && !recap && !waiting) {
    return <div className="label mt-20 text-center">Loading…</div>;
  }

  const state = waiting
    ? "Game over, fetching the results"
    : status === "disconnected"
      ? "League client offline"
      : "Standing by for your next game";
  const header = (
    <PageHeader
      kicker="Play"
      title="Live Game"
      subtitle={
        <>
          {state}
          {recap && ` · last game ${formatTimeAgo(recap.detail.game.game_creation)}`}
        </>
      }
      actions={recap ? <ExportActions recap={recap} exporting={exporting} /> : undefined}
      className="pb-0"
    />
  );

  if (waiting) {
    return (
      <div className="max-w-[1320px] space-y-6">
        {header}
        <StatusPanel
          kicker="Game over"
          title="Fetching the results…"
          pulse
          icon={<HourglassIcon className="h-7 w-7" />}
        >
          The client publishes the scoreboard a few seconds after the nexus falls.
        </StatusPanel>
        {recap && (
          <GameRecap
            recap={recap}
            champData={champData}
            puuids={puuids}
            heading={<RecapHeading title="Meanwhile">The game before it</RecapHeading>}
          />
        )}
        <ExportImageMessage message={exporting.message} />
      </div>
    );
  }

  const offline = status === "disconnected";
  const standby = (
    <StatusPanel
      kicker="Standby"
      title="Waiting for your next game"
      icon={<RadioIcon className="h-7 w-7" />}
      pulse={!offline}
      aside={<ClientStatus status={status} />}
      features
    >
      {offline
        ? "Start the League client and this tab follows your next game live."
        : recap
          ? "The moment your next game loads, this tab switches to a live scoreboard."
          : "No recorded games yet. Play a Mayhem game and it shows up here the moment it ends."}
    </StatusPanel>
  );

  if (!recap) {
    return (
      <div className="max-w-[1320px] space-y-6">
        {header}
        {standby}
      </div>
    );
  }

  return (
    <div className="max-w-[1320px] space-y-6">
      {header}
      {standby}
      <GameRecap
        recap={recap}
        champData={champData}
        puuids={puuids}
        heading={
          <RecapHeading title="Last game">
            {gaveUp
              ? "That game never produced results, so here is your most recent recorded one."
              : "Your most recent recorded game"}
          </RecapHeading>
        }
      />
      <ExportImageMessage message={exporting.message} />
    </div>
  );
}

// What a live game brings, so the page reads as waiting for something rather
// than as empty
const LIVE_FEATURES = [
  { icon: UsersIcon, text: "Both teams' levels, KDA, CS and items as they change" },
  { icon: TrophyIcon, text: "Your history with every player you've met" },
  { icon: SwordsIcon, text: "A running feed of kills and objectives" },
];

// The panel that stands in for the scoreboard when no game is running: what
// the page is waiting for, and whether the client it waits on is there at all.
function StatusPanel({
  kicker,
  title,
  icon,
  pulse = false,
  aside,
  features = false,
  children,
}: {
  kicker: string;
  title: string;
  icon: ReactNode;
  pulse?: boolean;
  aside?: ReactNode;
  features?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="panel relative overflow-hidden">
      <span className="pointer-events-none absolute -left-20 -top-28 h-72 w-72 rounded-full bg-lol-gold/[0.06] blur-3xl" />
      <span className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-lol-gold/70 via-lol-gold/25 to-transparent" />

      <div className="relative flex items-center gap-5 px-6 py-5">
        <div className="relative flex h-14 w-14 shrink-0 items-center justify-center rounded-lg border border-lol-gold/25 bg-lol-gold/[0.08] text-lol-gold">
          {icon}
          {pulse && (
            <span className="live-pulse absolute -top-1 -right-1 h-2.5 w-2.5 rounded-full border-2 border-lol-card bg-lol-gold" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="kicker text-[12px]">{kicker}</div>
          <div className="mt-1.5 font-display text-[24px] font-bold uppercase leading-none tracking-[0.02em] text-lol-text-bright">
            {title}
          </div>
          <div className="mt-2 text-[14px] text-lol-text">{children}</div>
        </div>
        {aside}
      </div>

      {features && (
        <div className="relative grid grid-cols-3 border-t border-lol-line bg-black/15">
          {LIVE_FEATURES.map(({ icon: Icon, text }) => (
            <div
              key={text}
              className="flex items-center gap-3 border-l border-lol-line px-6 py-3.5 first:border-l-0"
            >
              <Icon className="h-4 w-4 shrink-0 text-lol-text/70" />
              <span className="text-[13px] text-lol-text">{text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const CLIENT_STATUS: Record<LcuStatus, { dot: string; label: string }> = {
  connected: { dot: "bg-lol-win", label: "Client connected" },
  ingame: { dot: "bg-sky-400", label: "In game" },
  connecting: { dot: "bg-amber-400", label: "Connecting…" },
  disconnected: { dot: "bg-lol-loss", label: "Client offline" },
};

function ClientStatus({ status }: { status: LcuStatus }) {
  const { dot, label } = CLIENT_STATUS[status];
  return (
    <span className="flex h-8 shrink-0 items-center gap-2 rounded-lg border border-lol-border bg-black/20 px-3">
      <span className={`h-2 w-2 rounded-full ${dot}`} />
      <span className="label text-lol-text-bright">{label}</span>
    </span>
  );
}

// Copy and save for the game on screen, in the page's toolbar
function ExportActions({
  recap,
  exporting,
}: {
  recap: GameRecapData;
  exporting: ReturnType<typeof useImageExport>;
}) {
  const card = { kind: "game", gameId: recap.detail.game.game_id } as const;
  return (
    <>
      <ExportImageButton action="copy" card={card} exporting={exporting} />
      <ExportImageButton action="save" card={card} exporting={exporting} />
    </>
  );
}

// The line above the recap: which game this is, in the day-header style of
// Match History.
function RecapHeading({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-4 px-0.5">
      <span className="font-display text-[17px] font-bold uppercase italic tracking-[0.04em] text-lol-text-bright">
        {title}
      </span>
      <span className="text-[13px] text-lol-text">{children}</span>
      <span className="h-px flex-1 bg-gradient-to-r from-lol-border to-transparent" />
    </div>
  );
}
