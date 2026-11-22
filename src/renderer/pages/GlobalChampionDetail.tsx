import { useMemo, useEffect, useState, type ReactNode } from "react";
import { useParams, Link } from "react-router-dom";
import { useIpc } from "../hooks/useIpc";
import { useQueryFilters } from "../hooks/useQueryFilters";
import { useViewState } from "../hooks/useViewState";
import {
  useChampionData,
  getChampionName,
  useAugmentData,
  getAugmentName,
  useItemData,
} from "../hooks/useChampions";
import type { GlobalChampionDetail, ItemStats, AugmentStats } from "../lib/types";
import ChampionIcon from "../components/ChampionIcon";
import AugmentIcon from "../components/AugmentIcon";
import ItemIcon from "../components/ItemIcon";
import WinRateBar from "../components/WinRateBar";
import StatCard from "../components/StatCard";
import PatchSelect from "../components/PatchSelect";
import QueueSelect from "../components/QueueSelect";
import RarityFilter, { type Rarity } from "../components/RarityFilter";
import SortHeader from "../components/SortHeader";
import { useSort, type SortDir } from "../hooks/useSort";
import {
  LOCALE,
  formatDecimal,
  formatPercent,
  kdaColor,
  kdaRatio,
  winRateColor,
} from "../lib/format";
import { CHAMPION_SPLASH_URL } from "../lib/constants";
import Kda from "../components/Kda";
import PageHeader from "../components/PageHeader";
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  CrosshairIcon,
  FlameIcon,
  SwordsIcon,
  TrophyIcon,
} from "../components/icons";

type SortKey = "picks" | "winRate" | "name";

// One figure in the strip under the headline cards
function MiniStat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col justify-center px-5 py-3">
      <div className="label mb-1.5 text-[11px]">{label}</div>
      <div className="font-num text-[22px] font-semibold leading-none text-lol-text-bright">
        {children}
      </div>
    </div>
  );
}

// Doubles / triples / quadras / pentas in the same colors the other pages use
function MultikillCounts({
  doubles,
  triples,
  quadras,
  pentas,
}: {
  doubles: number;
  triples: number;
  quadras: number;
  pentas: number;
}) {
  const counts: {
    count: number;
    label: string;
    name: string;
    color: string;
  }[] = [
    { count: doubles, label: "D", name: "Double kills", color: "text-sky-400" },
    {
      count: triples,
      label: "T",
      name: "Triple kills",
      color: "text-amber-400",
    },
    {
      count: quadras,
      label: "Q",
      name: "Quadra kills",
      color: "text-purple-400",
    },
    { count: pentas, label: "P", name: "Penta kills", color: "text-red-400" },
  ];
  // The tile row from Match History's multikill card: each count over its
  // letter, in that kind's hue
  return (
    <div className="grid grid-cols-4 gap-1">
      {counts.map(({ count, label, name, color }) => (
        <div
          key={label}
          title={name}
          className="rounded-[3px] border border-lol-line bg-black/15 px-1 py-0.5 text-center"
        >
          <div
            className={`font-num text-[17px] font-bold leading-tight ${count > 0 ? color : "text-lol-text/40"}`}
          >
            {count.toLocaleString(LOCALE)}
          </div>
          <div className="label text-[11px] leading-3 text-lol-text/80">{label}</div>
        </div>
      ))}
    </div>
  );
}

function sortRows<T extends { picks: number; wins: number }>(
  rows: T[],
  sortKey: SortKey,
  sortDir: SortDir,
  nameOf: (row: T) => string,
): T[] {
  return [...rows].sort((a, b) => {
    if (sortKey === "name") {
      const cmp = nameOf(a).localeCompare(nameOf(b));
      return sortDir === "asc" ? cmp : -cmp;
    }
    const av = sortKey === "winRate" ? (a.picks > 0 ? a.wins / a.picks : 0) : a.picks;
    const bv = sortKey === "winRate" ? (b.picks > 0 ? b.wins / b.picks : 0) : b.picks;
    return sortDir === "desc" ? bv - av : av - bv;
  });
}

function ItemSection({
  items,
  games,
  patch,
}: {
  items: ItemStats[];
  games: number;
  patch?: string;
}) {
  const itemData = useItemData(patch);
  const sort = useSort<SortKey>("globalChampion.items", "picks");
  const sorted = useMemo(
    () =>
      sortRows(
        items,
        sort.sortKey,
        sort.sortDir,
        (i) => itemData[i.item_id]?.name ?? `Item ${i.item_id}`,
      ),
    [items, sort.sortKey, sort.sortDir, itemData],
  );

  return (
    <PickTable
      title="Items"
      count={items.length}
      nameLabel="Item"
      pickHint="Share of this champion's games that built the item"
      sort={sort}
      games={games}
      empty="No items recorded"
      rows={sorted.map((item) => ({
        key: item.item_id,
        picks: item.picks,
        wins: item.wins,
        name: (
          <div className="flex min-w-0 items-center gap-2.5">
            <ItemIcon itemId={item.item_id} size={30} patch={patch} />
            <span className="truncate font-display text-[15px] font-semibold text-lol-text-bright">
              {itemData[item.item_id]?.name ?? `Item ${item.item_id}`}
            </span>
          </div>
        ),
      }))}
    />
  );
}

function AugmentSection({ augments, games }: { augments: AugmentStats[]; games: number }) {
  const augmentData = useAugmentData();
  const sort = useSort<SortKey>("globalChampion.augments", "picks");
  const [rarity, setRarity] = useViewState<Rarity>("globalChampion.augRarity", "all");

  const sorted = useMemo(() => {
    const filtered = augments.filter(
      (a) => rarity === "all" || augmentData[a.augment_id]?.rarity === rarity,
    );
    return sortRows(filtered, sort.sortKey, sort.sortDir, (a) =>
      getAugmentName(augmentData, a.augment_id),
    );
  }, [augments, sort.sortKey, sort.sortDir, augmentData, rarity]);

  return (
    <PickTable
      title="Augments"
      count={sorted.length}
      nameLabel="Augment"
      pickHint="Share of this champion's games that took the augment"
      sort={sort}
      games={games}
      empty="No augments recorded"
      controls={<RarityFilter value={rarity} onChange={setRarity} />}
      rows={sorted.map((a) => ({
        key: a.augment_id,
        picks: a.picks,
        wins: a.wins,
        name: (
          <AugmentIcon
            augmentId={a.augment_id}
            size={30}
            showName
            nameClassName="ml-1 font-display text-[15px] font-semibold"
          />
        ),
      }))}
    />
  );
}

// How many rows a breakdown shows before it asks to be opened up
const PREVIEW_ROWS = 12;

// The items or augments this champion's games used: how many games, what share
// of the champion's games, and how they went. Only the top rows show until the
// whole list is asked for, so the two tables stay a glance rather than a scroll.
function PickTable({
  title,
  count,
  nameLabel,
  pickHint,
  sort,
  games,
  empty,
  controls,
  rows,
}: {
  title: string;
  count: number;
  nameLabel: string;
  pickHint: string;
  sort: ReturnType<typeof useSort<SortKey>>;
  games: number;
  empty: string;
  controls?: ReactNode;
  rows: { key: number; picks: number; wins: number; name: ReactNode }[];
}) {
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? rows : rows.slice(0, PREVIEW_ROWS);

  return (
    <section className="panel overflow-clip">
      <div className="panel-head min-h-[3.25rem] flex-wrap">
        <h2 className="section-title">{title}</h2>
        <span className="font-num text-[14px] text-lol-text/70">
          {count.toLocaleString(LOCALE)}
        </span>
        {controls && <div className="ml-auto">{controls}</div>}
      </div>
      <table className="w-full table-fixed">
        <thead className="sticky -top-2 z-10 bg-[#0e142c] [&_th]:shadow-[inset_0_-1px_0_rgb(255_255_255/0.07)]">
          <tr>
            <SortHeader {...sort} label={nameLabel} field="name" compact className="pl-4" />
            <SortHeader
              {...sort}
              label="Games"
              field="picks"
              compact
              numeric
              className="w-[4.5rem]"
            />
            <th title={pickHint} className="tbl-head w-[4.5rem] px-2 py-2.5 text-right text-[11px]">
              Pick %
            </th>
            <SortHeader
              {...sort}
              label="Win %"
              field="winRate"
              compact
              numeric
              className="w-40 pr-4"
            />
          </tr>
        </thead>
        <tbody>
          {shown.map((row) => (
            <tr
              key={row.key}
              className="border-t border-lol-line transition-colors hover:bg-white/[0.03]"
            >
              <td className="max-w-0 py-2 pl-4 pr-2">{row.name}</td>
              <td className="font-num px-2 py-2 text-right text-[15px] font-semibold text-lol-text-bright">
                {row.picks.toLocaleString(LOCALE)}
              </td>
              <td className="font-num px-2 py-2 text-right text-[15px] text-lol-text">
                {formatPercent(games > 0 ? row.picks / games : 0)}
              </td>
              <td className="py-2 pl-3 pr-4">
                <WinRateBar wins={row.wins} total={row.picks} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && (
        <div className="px-6 py-12 text-center text-[14px] text-lol-text">{empty}</div>
      )}
      {rows.length > PREVIEW_ROWS && (
        <div className="border-t border-lol-line p-1.5">
          <button
            onClick={() => setShowAll((v) => !v)}
            aria-expanded={showAll}
            className="btn btn-ghost btn-sm w-full"
          >
            {showAll
              ? `Show top ${PREVIEW_ROWS}`
              : `Show all ${rows.length.toLocaleString(LOCALE)}`}
            <ChevronDownIcon
              className={`h-3.5 w-3.5 transition-transform ${showAll ? "rotate-180" : ""}`}
            />
          </button>
        </div>
      )}
    </section>
  );
}

export default function GlobalChampionDetailPage() {
  const { championId = "" } = useParams();
  const id = Number(championId);
  const champData = useChampionData();
  // Filters live in the URL so the back link returns to the same view
  const { searchParams, setParam, patch, queue } = useQueryFilters();

  const { data, refetch } = useIpc<GlobalChampionDetail>(
    () => window.api.getGlobalChampionDetail(id, patch, queue),
    [id, patch, queue],
  );

  useEffect(() => {
    const unsub = window.api.onGamesUpdated(() => refetch());
    return unsub;
  }, [refetch]);

  const backQuery = searchParams.toString();
  const backLink = (
    <Link
      to={`/global${backQuery ? `?${backQuery}` : ""}`}
      className="group inline-flex items-center gap-1 text-lol-gold transition-colors hover:text-lol-gold-light"
    >
      <ChevronLeftIcon className="h-3.5 w-3.5 transition-transform group-hover:-translate-x-0.5" />
      Total Stats
    </Link>
  );

  if (!data) {
    return <div className="text-lol-text text-center mt-20">Loading...</div>;
  }

  const losses = data.games - data.wins;
  const winRate = data.games > 0 ? data.wins / data.games : 0;
  const pickRate = data.totalParticipantSlots > 0 ? data.games / data.totalParticipantSlots : 0;
  const presence = Math.min(1, pickRate * 10);
  const avg = (total: number) => formatDecimal(data.games > 0 ? total / data.games : 0);
  const ratio = data.deaths > 0 ? (data.kills + data.assists) / data.deaths : Infinity;

  return (
    <div className="max-w-[1320px] space-y-6">
      {/* The champion's splash runs behind the head of the page, fading out
          under the name so the title never sits on a busy part of the art */}
      <div className="panel relative overflow-hidden">
        <img
          src={CHAMPION_SPLASH_URL(id)}
          alt=""
          className="pointer-events-none absolute inset-y-0 right-0 h-full w-[72%] object-cover object-[center_22%] opacity-55"
          onError={(e) => {
            (e.target as HTMLImageElement).style.display = "none";
          }}
        />
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-lol-card from-30% via-lol-card/75 via-55% to-lol-card/5" />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-lol-card/80 to-transparent" />
        <span className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-lol-gold/80 via-lol-gold/30 to-transparent" />

        <div className="relative flex items-end gap-6 px-7 pb-7 pt-8">
          <div className="shrink-0 rounded-lg bg-gradient-to-b from-lol-gold-light to-lol-gold/30 p-[2px] shadow-[0_12px_30px_-12px_rgb(0_0_0/0.9)]">
            <ChampionIcon
              championId={id}
              size={112}
              className="rounded-[5px] border-2 border-lol-card"
            />
          </div>
          <PageHeader
            className="min-w-0 flex-1 pb-1"
            kicker={backLink}
            title={getChampionName(champData, id)}
            subtitle={
              <>
                <span className="font-num text-[15px] font-semibold text-lol-text-bright">
                  {data.games.toLocaleString(LOCALE)}
                </span>{" "}
                {data.games === 1 ? "game" : "games"} played across all stored matches
              </>
            }
            actions={
              // Backed so the selects keep their edge over the brightest part
              // of the splash
              <div className="flex items-center gap-2 rounded-lg border border-lol-border bg-lol-deep/90 p-1.5 shadow-[0_10px_28px_-10px_rgb(0_0_0/0.9)] backdrop-blur-sm">
                <QueueSelect value={queue} onChange={(q) => setParam("queue", q)} />
                <PatchSelect value={patch} onChange={(p) => setParam("patch", p)} />
              </div>
            }
          />
        </div>
      </div>

      {data.games === 0 ? (
        <div className="panel flex flex-col items-center gap-3 px-8 py-14 text-center">
          <SwordsIcon className="h-8 w-8 text-lol-gold/60" />
          <div className="max-w-md text-[14px] text-lol-text">
            No games with this champion for the selected filters.
          </div>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-4 items-stretch gap-4">
            <StatCard
              label="Win Rate"
              accent="win"
              icon={<TrophyIcon className="h-3.5 w-3.5" />}
              value={
                <span className={winRateColor(data.wins, data.games)}>
                  {formatPercent(winRate)}
                </span>
              }
              subtext={
                <span className="font-num text-[15px] font-semibold">
                  <span className="text-lol-win">{data.wins.toLocaleString(LOCALE)}</span>
                  <span className="ml-0.5 text-[12px] text-lol-win/70">W</span>
                  <span className="ml-2 text-lol-loss/85">{losses.toLocaleString(LOCALE)}</span>
                  <span className="ml-0.5 text-[12px] text-lol-loss/60">L</span>
                </span>
              }
            >
              <Meter ratio={winRate} className="from-lol-win/70 to-lol-win" even />
            </StatCard>
            <StatCard
              label="Avg KDA"
              accent="sky"
              icon={<SwordsIcon className="h-3.5 w-3.5" />}
              value={
                <span className="text-[28px]">
                  <Kda
                    kills={avg(data.kills)}
                    deaths={avg(data.deaths)}
                    assists={avg(data.assists)}
                  />
                </span>
              }
              subtext={
                <span className={`font-num text-[15px] font-semibold ${kdaColor(ratio)}`}>
                  {kdaRatio(data.kills, data.deaths, data.assists)}{" "}
                  <span className="text-[12px] tracking-[0.08em]">KDA</span>
                </span>
              }
            >
              <div className="text-[12px] text-lol-text">
                <span className="font-num text-[13px] text-lol-text-bright/80">
                  <Kda
                    kills={data.kills.toLocaleString(LOCALE)}
                    deaths={data.deaths.toLocaleString(LOCALE)}
                    assists={data.assists.toLocaleString(LOCALE)}
                  />
                </span>{" "}
                total
              </div>
            </StatCard>
            <StatCard
              label="Avg Damage"
              accent="purple"
              icon={<FlameIcon className="h-3.5 w-3.5" />}
              value={data.avgDamage.toLocaleString(LOCALE)}
              subtext={
                <>
                  <span className="font-num text-[15px] font-semibold text-lol-text-bright/85">
                    {formatPercent(data.damageShare)}
                  </span>{" "}
                  of team damage
                </>
              }
            >
              <Meter ratio={data.damageShare} className="from-purple-500/70 to-purple-400" />
            </StatCard>
            <StatCard
              label="Pick Rate"
              accent="gold"
              icon={<CrosshairIcon className="h-3.5 w-3.5" />}
              value={formatPercent(pickRate)}
              subtext={
                <>
                  <span className="font-num text-[15px] font-semibold text-lol-text-bright/85">
                    {data.games.toLocaleString(LOCALE)}
                  </span>{" "}
                  of{" "}
                  <span className="font-num text-[15px]">
                    {data.totalParticipantSlots.toLocaleString(LOCALE)}
                  </span>{" "}
                  picks
                </>
              }
            >
              {/* Ten picks a game, so this is the share of games the champion
                  turned up in, which a bar can actually show at this scale */}
              <div className="mb-1.5 text-[12px] text-lol-text">
                In{" "}
                <span className="font-num text-[13px] font-semibold text-lol-text-bright/85">
                  {formatPercent(presence)}
                </span>{" "}
                of games
              </div>
              <Meter ratio={presence} className="from-lol-gold/60 to-lol-gold" />
            </StatCard>
          </div>

          <div className="panel grid grid-cols-5 divide-x divide-lol-line">
            <MiniStat label="Kill Participation">{formatPercent(data.killParticipation)}</MiniStat>
            <MiniStat label="Avg Gold">{data.avgGold.toLocaleString(LOCALE)}</MiniStat>
            <MiniStat label="Avg Damage Taken">
              {data.avgDamageTaken.toLocaleString(LOCALE)}
            </MiniStat>
            <MiniStat label="Avg Healing">{data.avgHeal.toLocaleString(LOCALE)}</MiniStat>
            <MiniStat label="Multikills">
              <MultikillCounts
                doubles={data.doubleKills}
                triples={data.tripleKills}
                quadras={data.quadraKills}
                pentas={data.pentaKills}
              />
            </MiniStat>
          </div>

          <div className="grid grid-cols-2 items-start gap-4">
            <ItemSection items={data.items} games={data.games} patch={patch} />
            <AugmentSection augments={data.augments} games={data.games} />
          </div>
        </>
      )}
    </div>
  );
}

// A thin 0-1 track for a card's footer; `even` marks the halfway line so a
// win rate either side of it reads at a glance
function Meter({
  ratio,
  className,
  even = false,
}: {
  ratio: number;
  className: string;
  even?: boolean;
}) {
  return (
    <div className="relative h-1.5 overflow-hidden rounded-[2px] bg-white/[0.06]">
      <div
        className={`h-full rounded-[2px] bg-gradient-to-r transition-all ${className}`}
        style={{ width: `${Math.min(100, Math.max(0, ratio * 100))}%` }}
      />
      {even && <span className="absolute inset-y-0 left-1/2 w-px bg-lol-dark/70" />}
    </div>
  );
}
