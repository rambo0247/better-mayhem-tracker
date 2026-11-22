import { Link } from "react-router-dom";
import type { ChampionData, LiveEvent, LivePlayer } from "../lib/types";
import { getChampionName } from "../hooks/useChampions";
import { formatDuration, kdaHighlight, kdaRatio, winRateColor } from "../lib/format";
import ChampionIcon from "./ChampionIcon";
import ItemIcon from "./ItemIcon";
import SummonerSpellIcon from "./SummonerSpellIcon";
import Kda from "./Kda";
import RiotId from "./RiotId";

const GRID_COLS = "grid-cols-[62px_minmax(110px,1fr)_40px_84px_48px_minmax(190px,auto)_112px]";

export default function LiveScoreboard({
  players,
  champData,
}: {
  players: LivePlayer[];
  champData: ChampionData;
}) {
  const teams = [100, 200].map((teamId) => players.filter((p) => p.teamId === teamId));

  return (
    <div className="space-y-4">
      {teams.map((team, index) =>
        team.length === 0 ? null : (
          <LiveTeam
            key={index}
            teamId={index === 0 ? 100 : 200}
            players={team}
            champData={champData}
          />
        ),
      )}
    </div>
  );
}

function LiveTeam({
  teamId,
  players,
  champData,
}: {
  teamId: number;
  players: LivePlayer[];
  champData: ChampionData;
}) {
  const ours = players.some((p) => p.isSelf);
  const kills = players.reduce((sum, p) => sum + p.kills, 0);
  const deaths = players.reduce((sum, p) => sum + p.deaths, 0);
  const assists = players.reduce((sum, p) => sum + p.assists, 0);
  const blue = teamId === 100;

  return (
    <div className="panel overflow-hidden">
      {/* Team header in the side's own colour, the way the score bug above draws it */}
      <div className="relative flex min-h-[52px] items-center gap-3 border-b border-lol-line bg-black/20 py-2 pl-5 pr-4">
        <span
          className={`absolute inset-y-0 left-0 w-[3px] ${blue ? "bg-sky-400" : "bg-lol-loss"}`}
        />
        <span
          className={`pointer-events-none absolute inset-y-0 left-0 w-1/2 bg-gradient-to-r ${
            blue ? "from-sky-400/[0.10]" : "from-lol-loss/[0.10]"
          } to-transparent`}
        />
        <span
          className={`relative font-display text-[20px] font-extrabold uppercase italic leading-none tracking-[0.03em] ${
            blue ? "text-sky-400" : "text-lol-loss"
          }`}
        >
          {blue ? "Blue Team" : "Red Team"}
        </span>
        {ours && <span className="chip relative bg-lol-gold/12 text-lol-gold">Yours</span>}
        <div className="relative ml-auto text-right">
          <div className="label text-[11px] leading-3 text-lol-text/80">Team K / D / A</div>
          <div className="font-num mt-1 text-[17px] font-semibold leading-none text-lol-text-bright">
            <Kda kills={kills} deaths={deaths} assists={assists} />
          </div>
        </div>
      </div>

      <div className={`grid ${GRID_COLS} tbl-head h-8 items-center gap-2.5 bg-black/10 px-4`}>
        <span />
        <span>Player</span>
        <span className="text-right">Lvl</span>
        <span className="text-center">KDA</span>
        <span className="text-right">CS</span>
        <span>Items</span>
        <span className="text-right">On this champ</span>
      </div>

      {players.map((player) => (
        <LivePlayerRow key={player.key} player={player} champData={champData} />
      ))}
    </div>
  );
}

function LivePlayerRow({ player, champData }: { player: LivePlayer; champData: ChampionData }) {
  const championName =
    player.championId > 0 ? getChampionName(champData, player.championId) : player.championName;

  return (
    <div
      className={`relative grid ${GRID_COLS} min-h-[54px] items-center gap-2.5 border-t border-lol-line px-4 py-2 transition-colors ${
        player.isSelf
          ? "bg-gradient-to-r from-lol-gold/[0.13] via-lol-gold/[0.04] to-lol-gold/[0.02]"
          : "hover:bg-white/[0.025]"
      }`}
    >
      {player.isSelf && <span className="absolute inset-y-0 left-0 w-[3px] bg-lol-gold" />}

      {/* Champion and spells, dimmed while they wait to respawn. The timer
          stays at full strength over the dimmed portrait. */}
      <div className="flex items-center gap-1">
        <div className="relative">
          <ChampionIcon
            championId={player.championId}
            size={38}
            className={player.isDead ? "opacity-40 grayscale" : ""}
          />
          {player.isDead && player.respawnTimer > 0 && (
            <span className="font-num absolute inset-0 flex items-center justify-center rounded-md bg-black/55 text-[15px] font-bold text-lol-loss">
              {player.respawnTimer}
            </span>
          )}
        </div>
        <div className={`flex flex-col gap-0.5 ${player.isDead ? "opacity-40" : ""}`}>
          <SummonerSpellIcon spellId={player.spell1Id} size={18} />
          <SummonerSpellIcon spellId={player.spell2Id} size={18} />
        </div>
      </div>

      <div className="min-w-0">
        <div
          className={`truncate font-display text-[16px] font-semibold leading-tight ${
            player.isSelf ? "text-lol-gold-light" : "text-lol-text-bright"
          }`}
        >
          {player.friendKey ? (
            <Link
              to={`/friends/${encodeURIComponent(player.friendKey)}`}
              className="transition-colors hover:text-lol-gold"
              title={`${player.gamesWithUs} games on your team`}
            >
              <RiotId id={player.name} />
            </Link>
          ) : (
            <RiotId id={player.name} />
          )}
        </div>
        <div className="truncate text-[12px] text-lol-text">{championName}</div>
      </div>

      <div className="font-num text-right text-[15px] font-semibold text-lol-text-bright">
        {player.level || "-"}
      </div>

      <div className="text-center">
        <div className="font-num text-[15px] font-semibold leading-tight text-lol-text-bright">
          <Kda kills={player.kills} deaths={player.deaths} assists={player.assists} />
        </div>
        <div
          className={`font-num text-[12px] font-semibold ${kdaHighlight(player.kills, player.deaths, player.assists)}`}
        >
          {kdaRatio(player.kills, player.deaths, player.assists)}
        </div>
      </div>

      <div className="font-num text-right text-[14px] text-lol-text-bright/85">
        {player.creepScore}
      </div>

      {/* Items, with the trinket set a little apart */}
      <div className="flex items-center gap-[3px]">
        {player.items.slice(0, 6).map((itemId, i) => (
          <ItemIcon key={i} itemId={itemId} size={22} />
        ))}
        <div className="ml-1">
          <ItemIcon itemId={player.items[6] ?? 0} size={22} />
        </div>
      </div>

      <ChampionRecordCell player={player} />
    </div>
  );
}

// Everyone in a random lobby is a stranger, so this is a dash far more often
// than it is a record. It earns its column on the handful of rows where the
// person on the other side of the bridge is someone we have notes on.
function ChampionRecordCell({ player }: { player: LivePlayer }) {
  const record = player.championRecord;

  if (!record || record.games === 0) {
    return (
      <div className="font-num text-right text-[14px] text-lol-text/40" title="No games on record">
        -
      </div>
    );
  }

  const losses = record.games - record.wins;
  const seen = player.overallRecord;

  return (
    <div
      className="text-right"
      title={
        seen
          ? `${seen.games} games seen on any champion` +
            (player.gamesWithUs > 0 ? `, ${player.gamesWithUs} on your team` : "")
          : undefined
      }
    >
      <div
        className={`font-num text-[15px] font-semibold leading-tight ${winRateColor(record.wins, record.games)}`}
      >
        {record.wins}W {losses}L
      </div>
      <div className="font-num text-[12px] text-lol-text">
        {kdaRatio(record.kills, record.deaths, record.assists)}{" "}
        <span className="text-[11px] tracking-[0.08em]">KDA</span>
      </div>
    </div>
  );
}

const EVENT_TONES: Record<LiveEvent["tone"], { text: string; mark: string }> = {
  kill: { text: "text-lol-text-bright", mark: "bg-lol-text/50" },
  objective: { text: "text-sky-400", mark: "bg-sky-400" },
  special: { text: "text-lol-gold", mark: "bg-lol-gold" },
};

// Newest at the top, because the interesting one is always the one that just
// happened.
export function LiveEventFeed({ events }: { events: LiveEvent[] }) {
  if (events.length === 0) {
    return (
      <div className="py-8 text-center text-[13px] text-lol-text">Nothing has happened yet.</div>
    );
  }

  return (
    <div className="flex flex-col">
      {events
        .slice()
        .reverse()
        .map((event) => {
          const tone = EVENT_TONES[event.tone];
          return (
            <div
              key={event.id}
              className="flex items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-white/[0.03]"
            >
              <span className="font-num w-9 shrink-0 text-[13px] text-lol-text/60">
                {formatDuration(Math.floor(event.time))}
              </span>
              <span className={`h-3 w-[3px] shrink-0 rounded-[1px] ${tone.mark}`} />
              <span className={`truncate text-[13px] ${tone.text}`} title={event.text}>
                {event.text}
              </span>
            </div>
          );
        })}
    </div>
  );
}
