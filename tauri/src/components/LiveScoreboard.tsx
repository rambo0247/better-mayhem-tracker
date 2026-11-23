import { For, Show } from "solid-js";
import type { ChampionData, LiveEvent, LivePlayer } from "../lib/types";
import { getChampionName } from "../hooks/useChampions";
import { formatDuration, kdaHighlight, kdaRatio, winRateColor } from "../lib/format";
import ChampionIcon from "./ChampionIcon";
import ItemIcon from "./ItemIcon";
import SummonerSpellIcon from "./SummonerSpellIcon";
import Kda from "./Kda";
import RiotId from "./RiotId";

const GRID_COLS = "grid-cols-[62px_minmax(110px,1fr)_40px_84px_48px_minmax(190px,auto)_112px]";

export default function LiveScoreboard(props: { players: LivePlayer[]; champData: ChampionData }) {
  const team = (teamId: number) => props.players.filter((p) => p.teamId === teamId);

  return (
    <div class="space-y-4">
      <For each={[100, 200]}>
        {(teamId) => (
          <Show when={team(teamId).length > 0}>
            <LiveTeam teamId={teamId} players={team(teamId)} champData={props.champData} />
          </Show>
        )}
      </For>
    </div>
  );
}

function LiveTeam(props: { teamId: number; players: LivePlayer[]; champData: ChampionData }) {
  const ours = () => props.players.some((p) => p.isSelf);
  const sum = (stat: "kills" | "deaths" | "assists") =>
    props.players.reduce((total, p) => total + p[stat], 0);
  const blue = () => props.teamId === 100;

  return (
    <div class="panel overflow-hidden">
      {/* Team header in the side's own colour, the way the score bug above draws it */}
      <div class="relative flex min-h-[52px] items-center gap-3 border-b border-lol-line bg-black/20 py-2 pl-5 pr-4">
        <span
          class={["absolute inset-y-0 left-0 w-[3px]", blue() ? "bg-sky-400" : "bg-lol-loss"]}
        />
        <span
          class={[
            "pointer-events-none absolute inset-y-0 left-0 w-1/2 bg-gradient-to-r to-transparent",
            blue() ? "from-sky-400/[0.10]" : "from-lol-loss/[0.10]",
          ]}
        />
        <span
          class={[
            "relative font-display text-[20px] font-extrabold uppercase italic leading-none tracking-[0.03em]",
            blue() ? "text-sky-400" : "text-lol-loss",
          ]}
        >
          {blue() ? "Blue Team" : "Red Team"}
        </span>
        <Show when={ours()}>
          <span class="chip relative bg-lol-gold/12 text-lol-gold">Yours</span>
        </Show>
        <div class="relative ml-auto text-right">
          <div class="label text-[11px] leading-3 text-lol-text/80">Team K / D / A</div>
          <div class="font-num mt-1 text-[17px] font-semibold leading-none text-lol-text-bright">
            <Kda kills={sum("kills")} deaths={sum("deaths")} assists={sum("assists")} />
          </div>
        </div>
      </div>

      <div class={["grid", GRID_COLS, "tbl-head h-8 items-center gap-2.5 bg-black/10 px-4"]}>
        <span />
        <span>Player</span>
        <span class="text-right">Lvl</span>
        <span class="text-center">KDA</span>
        <span class="text-right">CS</span>
        <span>Items</span>
        <span class="text-right">On this champ</span>
      </div>

      {/* Keyed by player, so a poll updates each row in place */}
      <For each={props.players} keyed={(player) => player.key}>
        {(player) => <LivePlayerRow player={player()} champData={props.champData} />}
      </For>
    </div>
  );
}

function LivePlayerRow(props: { player: LivePlayer; champData: ChampionData }) {
  const player = () => props.player;
  const championName = () =>
    player().championId > 0
      ? getChampionName(props.champData, player().championId)
      : player().championName;

  return (
    <div
      class={[
        "relative grid",
        GRID_COLS,
        "min-h-[54px] items-center gap-2.5 border-t border-lol-line px-4 py-2 transition-colors",
        player().isSelf
          ? "bg-gradient-to-r from-lol-gold/[0.13] via-lol-gold/[0.04] to-lol-gold/[0.02]"
          : "hover:bg-white/[0.025]",
      ]}
    >
      <Show when={player().isSelf}>
        <span class="absolute inset-y-0 left-0 w-[3px] bg-lol-gold" />
      </Show>

      {/* Champion and spells, dimmed while they wait to respawn. The timer
          stays at full strength over the dimmed portrait. */}
      <div class="flex items-center gap-1">
        <div class="relative">
          <ChampionIcon
            championId={player().championId}
            size={38}
            class={player().isDead ? "opacity-40 grayscale" : ""}
          />
          <Show when={player().isDead && player().respawnTimer > 0}>
            <span class="font-num absolute inset-0 flex items-center justify-center rounded-md bg-black/55 text-[15px] font-bold text-lol-loss">
              {player().respawnTimer}
            </span>
          </Show>
        </div>
        <div class={["flex flex-col gap-0.5", { "opacity-40": player().isDead }]}>
          <SummonerSpellIcon spellId={player().spell1Id} size={18} />
          <SummonerSpellIcon spellId={player().spell2Id} size={18} />
        </div>
      </div>

      <div class="min-w-0">
        <div
          class={[
            "truncate font-display text-[16px] font-semibold leading-tight",
            player().isSelf ? "text-lol-gold-light" : "text-lol-text-bright",
          ]}
        >
          <Show when={player().friendKey} fallback={<RiotId id={player().name} />}>
            {(friendKey) => (
              <a
                href={`#/friends/${encodeURIComponent(friendKey())}`}
                class="transition-colors hover:text-lol-gold"
                title={`${player().gamesWithUs} games on your team`}
              >
                <RiotId id={player().name} />
              </a>
            )}
          </Show>
        </div>
        <div class="truncate text-[12px] text-lol-text">{championName()}</div>
      </div>

      <div class="font-num text-right text-[15px] font-semibold text-lol-text-bright">
        {player().level || "-"}
      </div>

      <div class="text-center">
        <div class="font-num text-[15px] font-semibold leading-tight text-lol-text-bright">
          <Kda kills={player().kills} deaths={player().deaths} assists={player().assists} />
        </div>
        <div
          class={[
            "font-num text-[12px] font-semibold",
            kdaHighlight(player().kills, player().deaths, player().assists),
          ]}
        >
          {kdaRatio(player().kills, player().deaths, player().assists)}
        </div>
      </div>

      <div class="font-num text-right text-[14px] text-lol-text-bright/85">
        {player().creepScore}
      </div>

      {/* Items, with the trinket set a little apart */}
      <div class="flex items-center gap-[3px]">
        <For each={player().items.slice(0, 6)} keyed={false}>
          {(itemId) => <ItemIcon itemId={itemId()} size={22} />}
        </For>
        <div class="ml-1">
          <ItemIcon itemId={player().items[6] ?? 0} size={22} />
        </div>
      </div>

      <ChampionRecordCell player={player()} />
    </div>
  );
}

// Everyone in a random lobby is a stranger, so this is a dash far more often
// than it is a record. It earns its column on the handful of rows where the
// person on the other side of the bridge is someone we have notes on.
function ChampionRecordCell(props: { player: LivePlayer }) {
  const record = () => props.player.championRecord;
  const seen = () => props.player.overallRecord;

  return (
    <Show
      when={record()?.games ? record() : null}
      fallback={
        <div class="font-num text-right text-[14px] text-lol-text/40" title="No games on record">
          -
        </div>
      }
    >
      {(found) => (
        <div
          class="text-right"
          title={
            seen()
              ? `${seen()!.games} games seen on any champion` +
                (props.player.gamesWithUs > 0 ? `, ${props.player.gamesWithUs} on your team` : "")
              : undefined
          }
        >
          <div
            class={[
              "font-num text-[15px] font-semibold leading-tight",
              winRateColor(found().wins, found().games),
            ]}
          >
            {found().wins}W {found().games - found().wins}L
          </div>
          <div class="font-num text-[12px] text-lol-text">
            {kdaRatio(found().kills, found().deaths, found().assists)}{" "}
            <span class="text-[11px] tracking-[0.08em]">KDA</span>
          </div>
        </div>
      )}
    </Show>
  );
}

const EVENT_TONES: Record<LiveEvent["tone"], { text: string; mark: string }> = {
  kill: { text: "text-lol-text-bright", mark: "bg-lol-text/50" },
  objective: { text: "text-sky-400", mark: "bg-sky-400" },
  special: { text: "text-lol-gold", mark: "bg-lol-gold" },
};

// Newest at the top, because the interesting one is always the one that just
// happened.
export function LiveEventFeed(props: { events: LiveEvent[] }) {
  return (
    <Show
      when={props.events.length > 0}
      fallback={
        <div class="py-8 text-center text-[13px] text-lol-text">Nothing has happened yet.</div>
      }
    >
      <div class="flex flex-col">
        <For each={props.events.slice().reverse()} keyed={(event) => event.id}>
          {(event) => (
            <div class="flex items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-white/[0.03]">
              <span class="font-num w-9 shrink-0 text-[13px] text-lol-text/60">
                {formatDuration(Math.floor(event().time))}
              </span>
              <span
                class={["h-3 w-[3px] shrink-0 rounded-[1px]", EVENT_TONES[event().tone].mark]}
              />
              <span
                class={["truncate text-[13px]", EVENT_TONES[event().tone].text]}
                title={event().text}
              >
                {event().text}
              </span>
            </div>
          )}
        </For>
      </div>
    </Show>
  );
}
