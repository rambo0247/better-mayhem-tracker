import { createEffect, createMemo, createSignal, For, onSettled, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { useLocation, useNavigate } from "@solidjs/router";
import { useQueryFilters } from "../hooks/useQueryFilters";
import { useIpc } from "../hooks/useIpc";
import { useViewState } from "../hooks/useViewState";
import { useSort } from "../hooks/useSort";
import { readViewState, writeViewState } from "../lib/viewState";
import {
  LOCALE,
  formatDecimal,
  formatPercent,
  kdaColor,
  kdaRatio,
  winRateColor,
  winRatePercent,
} from "../lib/format";
import { api } from "../lib/api-shim";
import { reportFirstContent } from "../lib/perf";
import {
  championFilterQuery,
  findLeaders,
  sortAugments,
  sortChampions,
  sortItems,
  type ChampSortKey,
  type PickSortKey,
} from "../lib/globalStats";
import {
  useChampionData,
  getChampionName,
  useAugmentData,
  getAugmentName,
  useItemData,
} from "../hooks/useChampions";
import Kda from "../components/Kda";
import ChampionIcon from "../components/ChampionIcon";
import AugmentIcon from "../components/AugmentIcon";
import ItemIcon from "../components/ItemIcon";
import WinRateBar from "../components/WinRateBar";
import PatchSelect from "../components/PatchSelect";
import QueueSelect from "../components/QueueSelect";
import RarityFilter, { type Rarity } from "../components/RarityFilter";
import SortHeader from "../components/SortHeader";
import SearchInput from "../components/SearchInput";
import StatCard, { type StatAccent } from "../components/StatCard";
import PageHeader from "../components/PageHeader";
import {
  ChevronRightIcon,
  FunnelIcon,
  GlobeIcon,
  SparklesIcon,
  TrophyIcon,
  UsersIcon,
} from "../components/icons";

type Tab = "champions" | "augments" | "items";
type ItemSortKey = "picks" | "winRate" | "name";

const TABS: { key: Tab; label: string }[] = [
  { key: "champions", label: "Champions" },
  { key: "augments", label: "Augments" },
  { key: "items", label: "Items" },
];

export default function GlobalStatsPage() {
  const champData = useChampionData();
  const augmentData = useAugmentData();
  const navigate = useNavigate();
  const location = useLocation();
  // Filters and tab live in the URL so returning from a champion page lands
  // back on the same view
  const { searchParams, setSearchParams, setParam, patch, queue } = useQueryFilters();
  const tab = (): Tab =>
    searchParams.tab === "augments" || searchParams.tab === "items"
      ? searchParams.tab
      : "champions";

  const setPatch = (p: string | undefined) => setParam("patch", p);
  const setQueue = (q: number | undefined) => setParam("queue", q);
  const setTab = (t: Tab) => setParam("tab", t === "champions" ? undefined : t);

  // Those three live in the URL, so remembering them means putting the query
  // string back on the way in. Arriving with one already set — the back link
  // from a champion page — wins over whatever was stored.
  const [restored, setRestored] = createSignal(false);
  onSettled(() => {
    const saved = readViewState("global.params", "");
    if (saved && !location.search) {
      setSearchParams(Object.fromEntries(new URLSearchParams(saved)), { replace: true });
    }
    setRestored(true);
  });
  createEffect(
    () => (restored() ? location.search : null),
    (search) => {
      if (search !== null) writeViewState("global.params", search.replace(/^\?/, ""));
    },
  );

  // Carried into the champion page so it opens with the same filters, and
  // comes back on its back link
  const filterQuery = createMemo(() => championFilterQuery(patch(), queue()));

  const { data, refetch } = useIpc(
    ([p, q]) => api.getGlobalStats(p, q),
    () => [patch(), queue()] as const,
  );
  onSettled(() => api.onGamesUpdated(() => void refetch()));

  // Champion tab state
  const [champSearch, setChampSearch] = useViewState("global.champSearch", "");
  const champSort = useSort<ChampSortKey>("global.champ", "games");

  // Augment tab state
  const [augSearch, setAugSearch] = useViewState("global.augSearch", "");
  const augSort = useSort<PickSortKey>("global.aug", "picks");
  const [rarityFilter, setRarityFilter] = useViewState<Rarity>("global.augRarity", "all");

  // Item tab state
  const itemData = useItemData(patch);
  const [itemSearch, setItemSearch] = useViewState("global.itemSearch", "");
  const itemSort = useSort<ItemSortKey>("global.item", "picks");

  const getItemName = (id: number) => itemData()[id]?.name ?? `Item ${id}`;

  const sortedChampions = createMemo(() => {
    const d = data();
    if (!d) return [];
    const names = champData();
    return sortChampions(
      d,
      (id) => getChampionName(names, id),
      champSearch(),
      champSort.sortKey(),
      champSort.sortDir(),
    );
  });

  const sortedAugments = createMemo(() => {
    const d = data();
    if (!d) return [];
    const augments = augmentData();
    return sortAugments(
      d,
      {
        name: (id) => getAugmentName(augments, id),
        rarity: (id) => augments[id]?.rarity,
      },
      augSearch(),
      rarityFilter(),
      augSort.sortKey(),
      augSort.sortDir(),
    );
  });

  const sortedItems = createMemo(() => {
    const d = data();
    if (!d) return [];
    return sortItems(d, getItemName, itemSearch(), itemSort.sortKey(), itemSort.sortDir());
  });

  const leaders = createMemo(() => {
    const d = data();
    return d ? findLeaders(d) : null;
  });

  createEffect(
    () => sortedChampions().length > 0,
    (has) => {
      if (has) reportFirstContent();
    },
  );

  const openChampion = (id: number) => navigate(`/global/champion/${id}${filterQuery()}`);

  return (
    <Show when={data()} fallback={<div class="text-lol-text text-center mt-20">Loading...</div>}>
      {(stats) => {
        const slots = () => stats().totalParticipantSlots;
        const totalGames = () => leaders()?.totalGames ?? 0;
        const rateOf = (n: number) => formatPercent(slots() > 0 ? n / slots() : 0);
        // The pick-rate bars are drawn against each table's most picked row
        const maxChampGames = () => Math.max(0, ...stats().champions.map((c) => c.games));
        const maxAugPicks = () => Math.max(0, ...stats().augments.map((a) => a.picks));
        const maxItemPicks = () => Math.max(0, ...stats().items.map((it) => it.picks));

        const counts = (): Record<Tab, number> => ({
          champions: stats().champions.length,
          augments: stats().augments.length,
          items: stats().items.length,
        });
        // The tab already carries the full count, so this only speaks up once a
        // search or filter has narrowed the list
        const shown = () => {
          const t = tab();
          const count =
            t === "champions"
              ? sortedChampions().length
              : t === "augments"
                ? sortedAugments().length
                : sortedItems().length;
          return { count, total: counts()[t] };
        };

        return (
          <div class="max-w-[1320px] space-y-6">
            <PageHeader
              kicker="Analyze"
              title="Total Stats"
              class="pb-0"
              subtitle={
                <>
                  Every player in your games <Dot />
                  <Count n={totalGames()} /> games <Dot />
                  <Count n={stats().champions.length} /> champions <Dot />
                  <Count n={stats().augments.length} /> augments <Dot />
                  <Count n={stats().items.length} /> items
                </>
              }
              actions={
                <>
                  <QueueSelect value={queue()} onChange={setQueue} />
                  <PatchSelect value={patch()} onChange={setPatch} />
                </>
              }
            />

            <Show when={totalGames() > 0 ? leaders() : null}>
              {(lead) => (
                <div class="grid grid-cols-4 items-stretch gap-4">
                  <StatCard
                    label="Games"
                    accent="gold"
                    icon={<GlobeIcon class="h-3.5 w-3.5" />}
                    value={totalGames().toLocaleString(LOCALE)}
                    subtext={
                      <>
                        <span class="font-num text-[14px] text-lol-text-bright/80">
                          {slots().toLocaleString(LOCALE)}
                        </span>{" "}
                        champion picks
                      </>
                    }
                  />
                  <LeaderCard
                    label="Most Picked"
                    accent="sky"
                    icon={<UsersIcon class="h-3.5 w-3.5" />}
                  >
                    <Show when={lead().mostPicked}>
                      {(c) => (
                        <ChampionLeader
                          championId={c().champion_id}
                          name={getChampionName(champData(), c().champion_id)}
                          onOpen={() => openChampion(c().champion_id)}
                        >
                          <span class="font-num text-[15px] font-semibold text-lol-text-bright">
                            {c().games.toLocaleString(LOCALE)}
                          </span>{" "}
                          games <Dot />{" "}
                          <span class="font-num text-[15px]">{rateOf(c().games)}</span> pick rate
                        </ChampionLeader>
                      )}
                    </Show>
                  </LeaderCard>
                  <LeaderCard
                    label="Best Win Rate"
                    accent="win"
                    icon={<TrophyIcon class="h-3.5 w-3.5" />}
                    hint={`Min ${lead().minGames} games`}
                  >
                    <Show
                      when={lead().bestWinRate}
                      fallback={
                        <div class="text-[13px] text-lol-text">
                          No champion has enough games yet
                        </div>
                      }
                    >
                      {(c) => (
                        <ChampionLeader
                          championId={c().champion_id}
                          name={getChampionName(champData(), c().champion_id)}
                          onOpen={() => openChampion(c().champion_id)}
                        >
                          <span
                            class={[
                              "font-num text-[15px] font-semibold",
                              winRateColor(c().wins, c().games),
                            ]}
                          >
                            {winRatePercent(c().wins, c().games)}
                          </span>{" "}
                          in{" "}
                          <span class="font-num text-[15px]">
                            {c().games.toLocaleString(LOCALE)}
                          </span>{" "}
                          games
                        </ChampionLeader>
                      )}
                    </Show>
                  </LeaderCard>
                  <LeaderCard
                    label="Top Augment"
                    accent="purple"
                    icon={<SparklesIcon class="h-3.5 w-3.5" />}
                  >
                    <Show when={lead().topAugment}>
                      {(a) => (
                        <div class="flex min-w-0 items-center gap-3">
                          <AugmentIcon augmentId={a().augment_id} size={44} />
                          <div class="min-w-0">
                            <div class="truncate font-display text-[19px] font-bold leading-tight text-lol-text-bright">
                              {getAugmentName(augmentData(), a().augment_id)}
                            </div>
                            <div class="truncate text-[13px] text-lol-text">
                              <span class="font-num text-[15px] font-semibold text-lol-text-bright">
                                {a().picks.toLocaleString(LOCALE)}
                              </span>{" "}
                              picks <Dot />{" "}
                              <span
                                class={[
                                  "font-num text-[15px] font-semibold",
                                  winRateColor(a().wins, a().picks),
                                ]}
                              >
                                {winRatePercent(a().wins, a().picks)}
                              </span>{" "}
                              win rate
                            </div>
                          </div>
                        </div>
                      )}
                    </Show>
                  </LeaderCard>
                </div>
              )}
            </Show>

            <div class="space-y-3">
              <div class="flex flex-wrap items-center gap-3">
                <div class="seg" role="group" aria-label="Stats to show">
                  <For each={TABS}>
                    {(t) => (
                      <button
                        onClick={() => setTab(t.key)}
                        aria-pressed={tab() === t.key ? "true" : "false"}
                        class="seg-item px-4"
                      >
                        {t.label}
                        <span class="font-num text-[13px] font-semibold opacity-60">
                          {counts()[t.key].toLocaleString(LOCALE)}
                        </span>
                      </button>
                    )}
                  </For>
                </div>
                <Show when={tab() === "augments"}>
                  <RarityFilter value={rarityFilter()} onChange={setRarityFilter} />
                </Show>
                <div class="ml-auto flex items-center gap-3">
                  <Show when={shown().count !== shown().total}>
                    <span class="text-[13px] text-lol-text">
                      <span class="font-num text-[15px] font-semibold text-lol-text-bright">
                        {shown().count.toLocaleString(LOCALE)}
                      </span>{" "}
                      of{" "}
                      <span class="font-num text-[15px]">
                        {shown().total.toLocaleString(LOCALE)}
                      </span>
                    </span>
                  </Show>
                  <Show when={tab() === "champions"}>
                    <SearchInput
                      value={champSearch()}
                      onChange={setChampSearch}
                      placeholder="Search champion..."
                    />
                  </Show>
                  <Show when={tab() === "augments"}>
                    <SearchInput
                      value={augSearch()}
                      onChange={setAugSearch}
                      placeholder="Search augment..."
                    />
                  </Show>
                  <Show when={tab() === "items"}>
                    <SearchInput
                      value={itemSearch()}
                      onChange={setItemSearch}
                      placeholder="Search item..."
                    />
                  </Show>
                </div>
              </div>

              <Show when={tab() === "champions"}>
                <div class="panel overflow-clip">
                  <table class="w-full table-fixed">
                    <TableHead>
                      <th class="tbl-head w-14 px-3 py-3 text-right">#</th>
                      {/* The name column is held to its content's width; the win-rate
                          bar's column takes whatever room the window has left */}
                      <Col sort={champSort} label="Champion" field="name" class="w-[9.5rem]" />
                      <Col sort={champSort} numeric label="Games" field="games" class="w-16" />
                      <RecordHead class="w-[7.5rem]" />
                      <Col
                        sort={champSort}
                        numeric
                        label="Pick %"
                        field="pickRate"
                        hint={PICK_RATE_HINT}
                        class="w-44"
                      />
                      <Col sort={champSort} numeric label="Win %" field="winRate" />
                      <Col
                        sort={champSort}
                        numeric
                        label="KDA"
                        field="kda"
                        hint="Kills plus assists over deaths, with the average kills / deaths / assists under it"
                        class="w-32"
                      />
                      <Col
                        sort={champSort}
                        numeric
                        label="Avg Dmg"
                        field="avgDamage"
                        hint="Average damage to champions per game"
                        class="w-24"
                      />
                      <th class="w-10" aria-hidden="true" />
                    </TableHead>
                    <tbody>
                      <For each={sortedChampions()}>
                        {(c, i) => (
                          <tr
                            onClick={() => openChampion(c.champion_id)}
                            class="group cursor-pointer border-t border-lol-line transition-colors hover:bg-white/[0.03]"
                          >
                            <RankCell rank={i() + 1} />
                            <td class="px-3 py-2">
                              <div class="flex min-w-0 items-center gap-3">
                                <ChampionIcon championId={c.champion_id} size={36} />
                                <span
                                  title={getChampionName(champData(), c.champion_id)}
                                  class="truncate font-display text-[16px] font-semibold text-lol-text-bright transition-colors group-hover:text-lol-gold-light"
                                >
                                  {getChampionName(champData(), c.champion_id)}
                                </span>
                              </div>
                            </td>
                            <StatCells
                              games={c.games}
                              wins={c.wins}
                              slots={slots()}
                              maxGames={maxChampGames()}
                            />
                            <KdaCell
                              kills={c.kills}
                              deaths={c.deaths}
                              assists={c.assists}
                              games={c.games}
                            />
                            <td class="font-num px-3 py-2 text-right text-[15px] text-lol-text-bright/85">
                              {c.avgDamage.toLocaleString(LOCALE)}
                            </td>
                            <td class="pr-3 text-right">
                              <ChevronRightIcon class="ml-auto h-4 w-4 text-lol-text/30 transition-colors group-hover:text-lol-gold" />
                            </td>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                  <Show when={sortedChampions().length === 0}>
                    <EmptyRows>No champions match your search.</EmptyRows>
                  </Show>
                </div>
              </Show>

              <Show when={tab() === "items"}>
                <div class="panel overflow-clip">
                  <table class="w-full table-fixed">
                    <TableHead>
                      <th class="tbl-head w-14 px-3 py-3 text-right">#</th>
                      <Col sort={itemSort} label="Item" field="name" />
                      <Col sort={itemSort} numeric label="Picks" field="picks" class="w-24" />
                      <RecordHead />
                      <th class="tbl-head w-64 px-3 py-3 text-right" title={PICK_RATE_HINT}>
                        Pick %
                      </th>
                      <Col sort={itemSort} numeric label="Win %" field="winRate" class="w-64" />
                      <th class="w-12" aria-hidden="true" />
                    </TableHead>
                    <tbody>
                      <For each={sortedItems()}>
                        {(item, i) => (
                          <tr class="border-t border-lol-line transition-colors hover:bg-white/[0.03]">
                            <RankCell rank={i() + 1} />
                            <td class="px-3 py-2">
                              <div class="flex min-w-0 items-center gap-3">
                                <ItemIcon itemId={item.item_id} size={36} patch={patch()} />
                                <span class="truncate font-display text-[16px] font-semibold text-lol-text-bright">
                                  {getItemName(item.item_id)}
                                </span>
                              </div>
                            </td>
                            <StatCells
                              games={item.picks}
                              wins={item.wins}
                              slots={slots()}
                              maxGames={maxItemPicks()}
                            />
                            <td />
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                  <Show when={sortedItems().length === 0}>
                    <EmptyRows>No items match your search.</EmptyRows>
                  </Show>
                </div>
              </Show>

              <Show when={tab() === "augments"}>
                <div class="panel overflow-clip">
                  <table class="w-full table-fixed">
                    <TableHead>
                      <th class="tbl-head w-14 px-3 py-3 text-right">#</th>
                      <Col sort={augSort} label="Augment" field="name" />
                      <Col sort={augSort} numeric label="Picks" field="picks" class="w-24" />
                      <RecordHead />
                      <Col
                        sort={augSort}
                        numeric
                        label="Pick %"
                        field="pickRate"
                        hint={PICK_RATE_HINT}
                        class="w-64"
                      />
                      <Col sort={augSort} numeric label="Win %" field="winRate" class="w-64" />
                      <th class="w-12" aria-hidden="true" />
                    </TableHead>
                    <tbody>
                      <For each={sortedAugments()}>
                        {(a, i) => (
                          <tr class="border-t border-lol-line transition-colors hover:bg-white/[0.03]">
                            <RankCell rank={i() + 1} />
                            <td class="max-w-0 px-3 py-2">
                              <AugmentIcon
                                augmentId={a.augment_id}
                                size={36}
                                showName
                                nameClass="ml-1.5 font-display text-[16px] font-semibold"
                              />
                            </td>
                            <StatCells
                              games={a.picks}
                              wins={a.wins}
                              slots={slots()}
                              maxGames={maxAugPicks()}
                            />
                            <td />
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                  <Show when={sortedAugments().length === 0}>
                    <EmptyRows>No augments match these filters.</EmptyRows>
                  </Show>
                </div>
              </Show>
            </div>
          </div>
        );
      }}
    </Show>
  );
}

const PICK_RATE_HINT = "Share of every player's picks across these games";

// A SortHeader wired to one table's useSort
function Col<K extends string>(props: {
  sort: ReturnType<typeof useSort<K>>;
  label: string;
  field: K;
  numeric?: boolean;
  hint?: string;
  class?: string;
}) {
  return (
    <SortHeader
      sortKey={props.sort.sortKey()}
      sortDir={props.sort.sortDir()}
      onSort={props.sort.onSort}
      label={props.label}
      field={props.field}
      numeric={props.numeric}
      hint={props.hint}
      class={props.class}
    />
  );
}

// The header row stays pinned to the top of the page while a long table
// scrolls under it, so it needs a solid fill rather than the usual tint
function TableHead(props: { children?: JSX.Element }) {
  return (
    <thead class="sticky -top-2 z-10 bg-[#0e142c] [&_th]:shadow-[inset_0_-1px_0_rgb(255_255_255/0.07)]">
      <tr>{props.children}</tr>
    </thead>
  );
}

function RecordHead(props: { class?: string }) {
  return (
    <th class={["tbl-head px-3 py-3 text-right", props.class ?? "w-36"]} title="Wins and losses">
      Record
    </th>
  );
}

// The numbers every table shares: count, win-loss record, pick rate against the
// most picked row, and win rate
function StatCells(props: { games: number; wins: number; slots: number; maxGames: number }) {
  const losses = () => props.games - props.wins;
  return (
    <>
      <td class="font-num px-3 py-2 text-right text-[15px] font-semibold text-lol-text-bright">
        {props.games.toLocaleString(LOCALE)}
      </td>
      <td class="font-num px-3 py-2 text-right text-[14px]">
        <span class="text-lol-win/90">{props.wins.toLocaleString(LOCALE)}</span>
        <span class="ml-0.5 text-[12px] text-lol-win/60">W</span>
        <span class="ml-2 text-lol-loss/85">{losses().toLocaleString(LOCALE)}</span>
        <span class="ml-0.5 text-[12px] text-lol-loss/60">L</span>
      </td>
      <td class="px-3 py-2 pl-6">
        <div class="flex items-center gap-2.5">
          <div class="h-1.5 flex-1 overflow-hidden rounded-[2px] bg-white/[0.06]">
            <div
              class="h-full rounded-[2px] bg-gradient-to-r from-sky-500/35 to-sky-400/70"
              style={{
                width: `${props.maxGames > 0 ? (props.games / props.maxGames) * 100 : 0}%`,
              }}
            />
          </div>
          <span class="font-num min-w-11 text-right text-[14px] font-semibold text-lol-text-bright/85">
            {formatPercent(props.slots > 0 ? props.games / props.slots : 0)}
          </span>
        </div>
      </td>
      <td class="px-3 py-2 pl-6">
        <WinRateBar wins={props.wins} total={props.games} />
      </td>
    </>
  );
}

function Dot() {
  return <span class="mx-1 text-lol-text/40">·</span>;
}

function Count(props: { n: number }) {
  return (
    <span class="font-num text-[14px] font-semibold text-lol-text-bright/85">
      {props.n.toLocaleString(LOCALE)}
    </span>
  );
}

function RankCell(props: { rank: number }) {
  return <td class="font-num px-3 py-2 text-right text-[14px] text-lol-text/60">{props.rank}</td>;
}

function EmptyRows(props: { children?: JSX.Element }) {
  return (
    <div class="flex flex-col items-center gap-3 border-t border-lol-line px-8 py-14 text-center">
      <FunnelIcon class="h-7 w-7 text-lol-gold/60" />
      <div class="text-[14px] text-lol-text">{props.children}</div>
    </div>
  );
}

// A StatCard whose headline is a champion or augment rather than a number
function LeaderCard(props: {
  label: string;
  accent: StatAccent;
  icon: JSX.Element;
  hint?: string;
  children?: JSX.Element;
}) {
  return (
    <StatCard
      label={props.label}
      accent={props.accent}
      icon={props.icon}
      value={
        <>
          <Show when={props.hint}>
            <span class="label absolute right-4 top-[1.1rem] text-[11px] text-lol-text/60">
              {props.hint}
            </span>
          </Show>
          <div class="pt-1 font-sans text-[14px] font-normal leading-normal tracking-normal">
            {props.children}
          </div>
        </>
      }
    />
  );
}

function ChampionLeader(props: {
  championId: number;
  name: string;
  onOpen: () => void;
  children?: JSX.Element;
}) {
  return (
    <button
      onClick={() => props.onOpen()}
      class="group flex w-full min-w-0 items-center gap-3 text-left"
    >
      <ChampionIcon
        championId={props.championId}
        size={44}
        class="ring-1 ring-white/10 transition-shadow group-hover:ring-lol-gold/60"
      />
      <div class="min-w-0">
        <div class="truncate font-display text-[19px] font-bold leading-tight text-lol-text-bright transition-colors group-hover:text-lol-gold-light">
          {props.name}
        </div>
        <div class="truncate text-[13px] text-lol-text">{props.children}</div>
      </div>
    </button>
  );
}

// The pooled KDA ratio in its quality colour, with the per-game averages it
// comes from in small type under it
function KdaCell(props: { kills: number; deaths: number; assists: number; games: number }) {
  const ratio = () => (props.deaths > 0 ? (props.kills + props.assists) / props.deaths : Infinity);
  const avg = (n: number) => formatDecimal(props.games > 0 ? n / props.games : 0);
  return (
    <td class="px-3 py-2 text-right">
      <div class={["font-num text-[15px] font-semibold leading-tight", kdaColor(ratio())]}>
        {kdaRatio(props.kills, props.deaths, props.assists)}
      </div>
      <div class="font-num text-[12px] leading-tight text-lol-text">
        <Kda kills={avg(props.kills)} deaths={avg(props.deaths)} assists={avg(props.assists)} />
      </div>
    </td>
  );
}
