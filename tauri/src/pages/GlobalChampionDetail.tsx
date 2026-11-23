import { createMemo, createSignal, For, onSettled, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { useLocation, useParams } from "@solidjs/router";
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
import { api } from "../lib/api-shim";
import { sortPickRows } from "../lib/globalStats";
import type { ItemStats, AugmentStats } from "../lib/types";
import ChampionIcon from "../components/ChampionIcon";
import AugmentIcon from "../components/AugmentIcon";
import ItemIcon from "../components/ItemIcon";
import WinRateBar from "../components/WinRateBar";
import StatCard from "../components/StatCard";
import PatchSelect from "../components/PatchSelect";
import QueueSelect from "../components/QueueSelect";
import RarityFilter, { type Rarity } from "../components/RarityFilter";
import SortHeader from "../components/SortHeader";
import { useSort } from "../hooks/useSort";
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
import { reportFirstContent } from "../lib/perf";

type SortKey = "picks" | "winRate" | "name";

// One figure in the strip under the headline cards
function MiniStat(props: { label: string; children?: JSX.Element }) {
  return (
    <div class="flex flex-col justify-center px-5 py-3">
      <div class="label mb-1.5 text-[11px]">{props.label}</div>
      <div class="font-num text-[22px] font-semibold leading-none text-lol-text-bright">
        {props.children}
      </div>
    </div>
  );
}

// Doubles / triples / quadras / pentas in the same colors the other pages use
function MultikillCounts(props: {
  doubles: number;
  triples: number;
  quadras: number;
  pentas: number;
}) {
  const counts = () => [
    { count: props.doubles, label: "D", name: "Double kills", color: "text-sky-400" },
    { count: props.triples, label: "T", name: "Triple kills", color: "text-amber-400" },
    { count: props.quadras, label: "Q", name: "Quadra kills", color: "text-purple-400" },
    { count: props.pentas, label: "P", name: "Penta kills", color: "text-red-400" },
  ];
  // The tile row from Match History's multikill card: each count over its
  // letter, in that kind's hue
  return (
    <div class="grid grid-cols-4 gap-1">
      <For each={counts()}>
        {(tile) => (
          <div
            title={tile.name}
            class="rounded-[3px] border border-lol-line bg-black/15 px-1 py-0.5 text-center"
          >
            <div
              class={[
                "font-num text-[17px] font-bold leading-tight",
                tile.count > 0 ? tile.color : "text-lol-text/40",
              ]}
            >
              {tile.count.toLocaleString(LOCALE)}
            </div>
            <div class="label text-[11px] leading-3 text-lol-text/80">{tile.label}</div>
          </div>
        )}
      </For>
    </div>
  );
}

function ItemSection(props: { items: ItemStats[]; games: number; patch: string | undefined }) {
  const itemData = useItemData(() => props.patch);
  const sort = useSort<SortKey>("globalChampion.items", "picks");
  const itemName = (i: ItemStats) => itemData()[i.item_id]?.name ?? `Item ${i.item_id}`;
  const sorted = createMemo(() =>
    sortPickRows(props.items, sort.sortKey(), sort.sortDir(), itemName),
  );

  return (
    <PickTable
      title="Items"
      count={props.items.length}
      nameLabel="Item"
      pickHint="Share of this champion's games that built the item"
      sort={sort}
      games={props.games}
      empty="No items recorded"
      rows={sorted()}
      rowKey={(item) => item.item_id}
      renderName={(item) => (
        <div class="flex min-w-0 items-center gap-2.5">
          <ItemIcon itemId={item.item_id} size={30} patch={props.patch} />
          <span class="truncate font-display text-[15px] font-semibold text-lol-text-bright">
            {itemName(item)}
          </span>
        </div>
      )}
    />
  );
}

function AugmentSection(props: { augments: AugmentStats[]; games: number }) {
  const augmentData = useAugmentData();
  const sort = useSort<SortKey>("globalChampion.augments", "picks");
  const [rarity, setRarity] = useViewState<Rarity>("globalChampion.augRarity", "all");

  const sorted = createMemo(() => {
    const names = augmentData();
    const filtered = props.augments.filter(
      (a) => rarity() === "all" || names[a.augment_id]?.rarity === rarity(),
    );
    return sortPickRows(filtered, sort.sortKey(), sort.sortDir(), (a) =>
      getAugmentName(names, a.augment_id),
    );
  });

  return (
    <PickTable
      title="Augments"
      count={sorted().length}
      nameLabel="Augment"
      pickHint="Share of this champion's games that took the augment"
      sort={sort}
      games={props.games}
      empty="No augments recorded"
      controls={<RarityFilter value={rarity()} onChange={setRarity} />}
      rows={sorted()}
      rowKey={(a) => a.augment_id}
      renderName={(a) => (
        <AugmentIcon
          augmentId={a.augment_id}
          size={30}
          showName
          nameClass="ml-1 font-display text-[15px] font-semibold"
        />
      )}
    />
  );
}

// How many rows a breakdown shows before it asks to be opened up
const PREVIEW_ROWS = 12;

// The items or augments this champion's games used: how many games, what share
// of the champion's games, and how they went. Only the top rows show until the
// whole list is asked for, so the two tables stay a glance rather than a scroll.
function PickTable<T extends { picks: number; wins: number }>(props: {
  title: string;
  count: number;
  nameLabel: string;
  pickHint: string;
  sort: ReturnType<typeof useSort<SortKey>>;
  games: number;
  empty: string;
  controls?: JSX.Element;
  rows: T[];
  rowKey: (row: T) => number;
  renderName: (row: T) => JSX.Element;
}) {
  const [showAll, setShowAll] = createSignal(false);
  const shown = () => (showAll() ? props.rows : props.rows.slice(0, PREVIEW_ROWS));
  const sortProps = () => ({
    sortKey: props.sort.sortKey(),
    sortDir: props.sort.sortDir(),
    onSort: props.sort.onSort,
  });

  return (
    <section class="panel overflow-clip">
      <div class="panel-head min-h-[3.25rem] flex-wrap">
        <h2 class="section-title">{props.title}</h2>
        <span class="font-num text-[14px] text-lol-text/70">
          {props.count.toLocaleString(LOCALE)}
        </span>
        <Show when={props.controls}>
          <div class="ml-auto">{props.controls}</div>
        </Show>
      </div>
      <table class="w-full table-fixed">
        <thead class="sticky -top-2 z-10 bg-[#0e142c] [&_th]:shadow-[inset_0_-1px_0_rgb(255_255_255/0.07)]">
          <tr>
            <SortHeader
              sortKey={sortProps().sortKey}
              sortDir={sortProps().sortDir}
              onSort={sortProps().onSort}
              label={props.nameLabel}
              field="name"
              compact
              class="pl-4"
            />
            <SortHeader
              sortKey={sortProps().sortKey}
              sortDir={sortProps().sortDir}
              onSort={sortProps().onSort}
              label="Games"
              field="picks"
              compact
              numeric
              class="w-[4.5rem]"
            />
            <th
              title={props.pickHint}
              class="tbl-head w-[4.5rem] px-2 py-2.5 text-right text-[11px]"
            >
              Pick %
            </th>
            <SortHeader
              sortKey={sortProps().sortKey}
              sortDir={sortProps().sortDir}
              onSort={sortProps().onSort}
              label="Win %"
              field="winRate"
              compact
              numeric
              class="w-40 pr-4"
            />
          </tr>
        </thead>
        <tbody>
          <For each={shown()}>
            {(row) => (
              <tr class="border-t border-lol-line transition-colors hover:bg-white/[0.03]">
                <td class="max-w-0 py-2 pl-4 pr-2">{props.renderName(row)}</td>
                <td class="font-num px-2 py-2 text-right text-[15px] font-semibold text-lol-text-bright">
                  {row.picks.toLocaleString(LOCALE)}
                </td>
                <td class="font-num px-2 py-2 text-right text-[15px] text-lol-text">
                  {formatPercent(props.games > 0 ? row.picks / props.games : 0)}
                </td>
                <td class="py-2 pl-3 pr-4">
                  <WinRateBar wins={row.wins} total={row.picks} />
                </td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
      <Show when={props.rows.length === 0}>
        <div class="px-6 py-12 text-center text-[14px] text-lol-text">{props.empty}</div>
      </Show>
      <Show when={props.rows.length > PREVIEW_ROWS}>
        <div class="border-t border-lol-line p-1.5">
          <button
            onClick={() => setShowAll((v) => !v)}
            aria-expanded={showAll() ? "true" : "false"}
            class="btn btn-ghost btn-sm w-full"
          >
            {showAll()
              ? `Show top ${PREVIEW_ROWS}`
              : `Show all ${props.rows.length.toLocaleString(LOCALE)}`}
            <ChevronDownIcon
              class={["h-3.5 w-3.5 transition-transform", showAll() ? "rotate-180" : ""]}
            />
          </button>
        </div>
      </Show>
    </section>
  );
}

export default function GlobalChampionDetailPage() {
  const params = useParams();
  const id = () => Number(params.championId ?? "");
  const champData = useChampionData();
  const location = useLocation();
  // Filters live in the URL so the back link returns to the same view
  const { setParam, patch, queue } = useQueryFilters();

  const { data, refetch } = useIpc(
    ([champion, p, q]) => api.getGlobalChampionDetail(champion, p, q),
    () => [id(), patch(), queue()] as const,
  );
  onSettled(() => api.onGamesUpdated(() => void refetch()));

  const backQuery = () => location.search.replace(/^\?/, "");
  const backLink = (
    <a
      href={`#/global${backQuery() ? `?${backQuery()}` : ""}`}
      class="group inline-flex items-center gap-1 text-lol-gold transition-colors hover:text-lol-gold-light"
    >
      <ChevronLeftIcon class="h-3.5 w-3.5 transition-transform group-hover:-translate-x-0.5" />
      Total Stats
    </a>
  );

  return (
    <Show when={data()} fallback={<div class="text-lol-text text-center mt-20">Loading...</div>}>
      {(detail) => {
        const losses = () => detail().games - detail().wins;
        const winRate = () => (detail().games > 0 ? detail().wins / detail().games : 0);
        const pickRate = () =>
          detail().totalParticipantSlots > 0 ? detail().games / detail().totalParticipantSlots : 0;
        const presence = () => Math.min(1, pickRate() * 10);
        const avg = (total: number) =>
          formatDecimal(detail().games > 0 ? total / detail().games : 0);
        const ratio = () =>
          detail().deaths > 0 ? (detail().kills + detail().assists) / detail().deaths : Infinity;

        onSettled(() => reportFirstContent());

        return (
          <div class="max-w-[1320px] space-y-6">
            {/* The champion's splash runs behind the head of the page, fading out
                under the name so the title never sits on a busy part of the art */}
            <div class="panel relative overflow-hidden">
              <img
                src={CHAMPION_SPLASH_URL(id())}
                alt=""
                class="pointer-events-none absolute inset-y-0 right-0 h-full w-[72%] object-cover object-[center_22%] opacity-55"
                onError={(e) => {
                  e.currentTarget.style.display = "none";
                }}
              />
              <div class="pointer-events-none absolute inset-0 bg-gradient-to-r from-lol-card from-30% via-lol-card/75 via-55% to-lol-card/5" />
              <div class="pointer-events-none absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-lol-card/80 to-transparent" />
              <span class="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-lol-gold/80 via-lol-gold/30 to-transparent" />

              <div class="relative flex items-end gap-6 px-7 pb-7 pt-8">
                <div class="shrink-0 rounded-lg bg-gradient-to-b from-lol-gold-light to-lol-gold/30 p-[2px] shadow-[0_12px_30px_-12px_rgb(0_0_0/0.9)]">
                  <ChampionIcon
                    championId={id()}
                    size={112}
                    class="rounded-[5px] border-2 border-lol-card"
                  />
                </div>
                <PageHeader
                  class="min-w-0 flex-1 pb-1"
                  kicker={backLink}
                  title={getChampionName(champData(), id())}
                  subtitle={
                    <>
                      <span class="font-num text-[15px] font-semibold text-lol-text-bright">
                        {detail().games.toLocaleString(LOCALE)}
                      </span>{" "}
                      {detail().games === 1 ? "game" : "games"} played across all stored matches
                    </>
                  }
                  actions={
                    // Backed so the selects keep their edge over the brightest part
                    // of the splash
                    <div class="flex items-center gap-2 rounded-lg border border-lol-border bg-lol-deep/90 p-1.5 shadow-[0_10px_28px_-10px_rgb(0_0_0/0.9)] backdrop-blur-sm">
                      <QueueSelect value={queue()} onChange={(q) => setParam("queue", q)} />
                      <PatchSelect value={patch()} onChange={(p) => setParam("patch", p)} />
                    </div>
                  }
                />
              </div>
            </div>

            <Show
              when={detail().games > 0}
              fallback={
                <div class="panel flex flex-col items-center gap-3 px-8 py-14 text-center">
                  <SwordsIcon class="h-8 w-8 text-lol-gold/60" />
                  <div class="max-w-md text-[14px] text-lol-text">
                    No games with this champion for the selected filters.
                  </div>
                </div>
              }
            >
              <div class="grid grid-cols-4 items-stretch gap-4">
                <StatCard
                  label="Win Rate"
                  accent="win"
                  icon={<TrophyIcon class="h-3.5 w-3.5" />}
                  value={
                    <span class={winRateColor(detail().wins, detail().games)}>
                      {formatPercent(winRate())}
                    </span>
                  }
                  subtext={
                    <span class="font-num text-[15px] font-semibold">
                      <span class="text-lol-win">{detail().wins.toLocaleString(LOCALE)}</span>
                      <span class="ml-0.5 text-[12px] text-lol-win/70">W</span>
                      <span class="ml-2 text-lol-loss/85">{losses().toLocaleString(LOCALE)}</span>
                      <span class="ml-0.5 text-[12px] text-lol-loss/60">L</span>
                    </span>
                  }
                >
                  <Meter ratio={winRate()} class="from-lol-win/70 to-lol-win" even />
                </StatCard>
                <StatCard
                  label="Avg KDA"
                  accent="sky"
                  icon={<SwordsIcon class="h-3.5 w-3.5" />}
                  value={
                    <span class="text-[28px]">
                      <Kda
                        kills={avg(detail().kills)}
                        deaths={avg(detail().deaths)}
                        assists={avg(detail().assists)}
                      />
                    </span>
                  }
                  subtext={
                    <span class={["font-num text-[15px] font-semibold", kdaColor(ratio())]}>
                      {kdaRatio(detail().kills, detail().deaths, detail().assists)}{" "}
                      <span class="text-[12px] tracking-[0.08em]">KDA</span>
                    </span>
                  }
                >
                  <div class="text-[12px] text-lol-text">
                    <span class="font-num text-[13px] text-lol-text-bright/80">
                      <Kda
                        kills={detail().kills.toLocaleString(LOCALE)}
                        deaths={detail().deaths.toLocaleString(LOCALE)}
                        assists={detail().assists.toLocaleString(LOCALE)}
                      />
                    </span>{" "}
                    total
                  </div>
                </StatCard>
                <StatCard
                  label="Avg Damage"
                  accent="purple"
                  icon={<FlameIcon class="h-3.5 w-3.5" />}
                  value={detail().avgDamage.toLocaleString(LOCALE)}
                  subtext={
                    <>
                      <span class="font-num text-[15px] font-semibold text-lol-text-bright/85">
                        {formatPercent(detail().damageShare)}
                      </span>{" "}
                      of team damage
                    </>
                  }
                >
                  <Meter ratio={detail().damageShare} class="from-purple-500/70 to-purple-400" />
                </StatCard>
                <StatCard
                  label="Pick Rate"
                  accent="gold"
                  icon={<CrosshairIcon class="h-3.5 w-3.5" />}
                  value={formatPercent(pickRate())}
                  subtext={
                    <>
                      <span class="font-num text-[15px] font-semibold text-lol-text-bright/85">
                        {detail().games.toLocaleString(LOCALE)}
                      </span>{" "}
                      of{" "}
                      <span class="font-num text-[15px]">
                        {detail().totalParticipantSlots.toLocaleString(LOCALE)}
                      </span>{" "}
                      picks
                    </>
                  }
                >
                  {/* Ten picks a game, so this is the share of games the champion
                      turned up in, which a bar can actually show at this scale */}
                  <div class="mb-1.5 text-[12px] text-lol-text">
                    In{" "}
                    <span class="font-num text-[13px] font-semibold text-lol-text-bright/85">
                      {formatPercent(presence())}
                    </span>{" "}
                    of games
                  </div>
                  <Meter ratio={presence()} class="from-lol-gold/60 to-lol-gold" />
                </StatCard>
              </div>

              <div class="panel grid grid-cols-5 divide-x divide-lol-line">
                <MiniStat label="Kill Participation">
                  {formatPercent(detail().killParticipation)}
                </MiniStat>
                <MiniStat label="Avg Gold">{detail().avgGold.toLocaleString(LOCALE)}</MiniStat>
                <MiniStat label="Avg Damage Taken">
                  {detail().avgDamageTaken.toLocaleString(LOCALE)}
                </MiniStat>
                <MiniStat label="Avg Healing">{detail().avgHeal.toLocaleString(LOCALE)}</MiniStat>
                <MiniStat label="Multikills">
                  <MultikillCounts
                    doubles={detail().doubleKills}
                    triples={detail().tripleKills}
                    quadras={detail().quadraKills}
                    pentas={detail().pentaKills}
                  />
                </MiniStat>
              </div>

              <div class="grid grid-cols-2 items-start gap-4">
                <ItemSection items={detail().items} games={detail().games} patch={patch()} />
                <AugmentSection augments={detail().augments} games={detail().games} />
              </div>
            </Show>
          </div>
        );
      }}
    </Show>
  );
}

// A thin 0-1 track for a card's footer; `even` marks the halfway line so a
// win rate either side of it reads at a glance
function Meter(props: { ratio: number; class: string; even?: boolean }) {
  return (
    <div class="relative h-1.5 overflow-hidden rounded-[2px] bg-white/[0.06]">
      <div
        class={["h-full rounded-[2px] bg-gradient-to-r transition-all", props.class]}
        style={{ width: `${Math.min(100, Math.max(0, props.ratio * 100))}%` }}
      />
      <Show when={props.even}>
        <span class="absolute inset-y-0 left-1/2 w-px bg-lol-dark/70" />
      </Show>
    </div>
  );
}
