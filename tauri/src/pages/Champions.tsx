import { createEffect, createMemo, createSignal, For, onSettled, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { useNavigate } from "@solidjs/router";
import { api } from "../lib/api-shim";
import { reportFirstContent } from "../lib/perf";
import { useIpc } from "../hooks/useIpc";
import { useViewState } from "../hooks/useViewState";
import { useSort } from "../hooks/useSort";
import {
  useChampionData,
  getChampionName,
  useAugmentData,
  useItemData,
} from "../hooks/useChampions";
import type { MatchHistoryLink } from "../lib/types";
import ChampionIcon from "../components/ChampionIcon";
import AugmentIcon from "../components/AugmentIcon";
import ItemIcon from "../components/ItemIcon";
import WinRateBar from "../components/WinRateBar";
import PatchSelect from "../components/PatchSelect";
import QueueSelect from "../components/QueueSelect";
import SortHeader, { CycleSortHeader } from "../components/SortHeader";
import FilterMenu from "../components/FilterMenu";
import MinGamesFilter from "../components/MinGamesFilter";
import SeasonSelect from "../components/SeasonSelect";
import PageHeader from "../components/PageHeader";
import { ChevronRightIcon, TrophyIcon } from "../components/icons";
import {
  LOCALE,
  formatCompact,
  formatDecimal,
  formatDuration,
  formatTimeAgo,
  kdaRatio,
  kdaColor,
  scoreColor,
} from "../lib/format";
import { matchesSearch } from "../lib/search";
import Kda from "../components/Kda";
import SearchInput from "../components/SearchInput";
import { filterAndSort, type SortKey } from "./Champions.rows";

// The badge, multikill and K/D/A columns sort by their headline figure first,
// then by each part on its own
const BADGE_STEPS: { field: SortKey; label: string }[] = [
  { field: "badges", label: "MVP / ACE" },
  { field: "mvps", label: "MVP" },
  { field: "aces", label: "ACE" },
];
const MULTIKILL_STEPS: { field: SortKey; label: string }[] = [
  { field: "multikills", label: "Multikills" },
  { field: "double_kills", label: "Doubles" },
  { field: "triple_kills", label: "Triples" },
  { field: "quadra_kills", label: "Quadras" },
  { field: "penta_kills", label: "Pentas" },
];
// The averages share one cell with the ratio under them, the way a game row
// shows them, so one header steps through all four
const KDA_STEPS: { field: SortKey; label: string }[] = [
  { field: "kda", label: "KDA" },
  { field: "avg_kills", label: "Avg Kills" },
  { field: "avg_deaths", label: "Avg Deaths" },
  { field: "avg_assists", label: "Avg Assists" },
];

// The multikill slots, in MultikillBadge's compact look, hues and rule: the
// letter alone for one, the letter and count for more. Each kind keeps its own
// slot, empty or not, so the counts line up down the table.
const MULTIKILL_SLOTS = [
  {
    key: "double_kills",
    letter: "D",
    name: "Double",
    tone: "bg-sky-400/14 text-sky-400 ring-sky-400/25",
  },
  {
    key: "triple_kills",
    letter: "T",
    name: "Triple",
    tone: "bg-amber-400/14 text-amber-400 ring-amber-400/25",
  },
  {
    key: "quadra_kills",
    letter: "Q",
    name: "Quadra",
    tone: "bg-purple-400/14 text-purple-400 ring-purple-400/25",
  },
  {
    key: "penta_kills",
    letter: "P",
    name: "Penta",
    tone: "bg-red-400/16 text-red-400 ring-red-400/35",
  },
] as const;

// One side of the MVP / ACE pair: its badge colour when earned, the same dim
// as the separator's neighbours when not, whichever side it is
function BadgeCount(props: { count: number; tone: string }) {
  return (
    <span class={props.count > 0 ? props.tone : "text-lol-text/45"}>
      {props.count.toLocaleString(LOCALE)}
    </span>
  );
}

// Table columns, for the expanded row's colSpan
const COLUMN_COUNT = 10;

// One of the three lists in an expanded row: a labelled block on the darker
// floor the row opens onto
function DetailBlock(props: { title: string; aside?: JSX.Element; children: JSX.Element }) {
  return (
    <section class="min-w-0 rounded-lg border border-lol-line bg-white/[0.018]">
      <div class="flex h-9 items-center justify-between border-b border-lol-line px-3">
        <h3 class="label">{props.title}</h3>
        {props.aside}
      </div>
      <div class="space-y-0.5 p-1.5">{props.children}</div>
    </section>
  );
}

function EmptyLine(props: { children: JSX.Element }) {
  return <div class="px-2 py-3 text-[13px] text-lol-text/70">{props.children}</div>;
}

// Picks and win rate at the end of an augment or item line
function PickStats(props: { picks: number; wins: number }) {
  return (
    <>
      <span class="font-num ml-auto shrink-0 text-[13px] text-lol-text">
        {props.picks.toLocaleString(LOCALE)}
        <span class="text-lol-text/50">×</span>
      </span>
      <div class="w-30 shrink-0">
        <WinRateBar wins={props.wins} total={props.picks} />
      </div>
    </>
  );
}

function ChampionExpanded(props: {
  championId: number;
  patch?: string;
  queue?: number;
  season?: string;
}) {
  const navigate = useNavigate();
  const augData = useAugmentData();
  const itemData = useItemData(() => props.patch);
  const deps = () => [props.championId, props.patch, props.queue, props.season] as const;
  const augStats = useIpc(
    ([id, patch, queue, season]) => api.getAugmentStats(id, patch, queue, season),
    deps,
  );
  const itemStats = useIpc(
    ([id, patch, queue, season]) => api.getChampionItemStats(id, patch, queue, season),
    deps,
  );
  const recent = useIpc(
    ([id, patch, queue, season]) => api.getChampionMatchHistory(id, 5, 0, patch, queue, season),
    deps,
  );

  const ready = () => augStats.data() && itemStats.data() && recent.data();
  const topAugments = () => augStats.data()?.slice(0, 6) ?? [];
  const topItems = () => itemStats.data()?.slice(0, 6) ?? [];
  const matches = () => recent.data()?.matches ?? [];

  return (
    <Show
      when={ready()}
      fallback={
        <td colspan={COLUMN_COUNT} class="bg-black/25 px-5 py-10">
          <div class="text-center text-[13px] text-lol-text">Loading…</div>
        </td>
      }
    >
      <td
        colspan={COLUMN_COUNT}
        class="bg-black/25 px-5 pt-4 pb-5 shadow-[inset_0_10px_14px_-12px_rgb(0_0_0/0.7)]"
      >
        <div class="grid grid-cols-3 gap-4">
          <DetailBlock title="Top Augments">
            <Show
              when={topAugments().length > 0}
              fallback={<EmptyLine>No augments recorded</EmptyLine>}
            >
              <For each={topAugments()} keyed={(a) => a.augment_id}>
                {(a) => (
                  <div class="flex h-9 items-center gap-2.5 rounded-[3px] px-1.5 hover:bg-white/[0.03]">
                    <div class="shrink-0">
                      <AugmentIcon augmentId={a().augment_id} size={26} />
                    </div>
                    <span class="min-w-0 truncate text-[13px] font-medium text-lol-text-bright">
                      {augData()[a().augment_id]?.name ?? `Augment ${a().augment_id}`}
                    </span>
                    <PickStats picks={a().picks} wins={a().wins} />
                  </div>
                )}
              </For>
            </Show>
          </DetailBlock>

          <DetailBlock title="Top Items">
            <Show when={topItems().length > 0} fallback={<EmptyLine>No items recorded</EmptyLine>}>
              <For each={topItems()} keyed={(item) => item.item_id}>
                {(item) => (
                  <div class="flex h-9 items-center gap-2.5 rounded-[3px] px-1.5 hover:bg-white/[0.03]">
                    <div class="shrink-0">
                      <ItemIcon itemId={item().item_id} size={26} patch={props.patch} />
                    </div>
                    <span class="min-w-0 truncate text-[13px] font-medium text-lol-text-bright">
                      {itemData()[item().item_id]?.name ?? ""}
                    </span>
                    <PickStats picks={item().picks} wins={item().wins} />
                  </div>
                )}
              </For>
            </Show>
          </DetailBlock>

          <DetailBlock
            title="Recent Games"
            aside={
              <Show when={matches().length > 0}>
                <button
                  onClick={() =>
                    navigate("/", {
                      state: {
                        championId: props.championId,
                        patch: props.patch,
                        queue: props.queue,
                        season: props.season,
                      } satisfies MatchHistoryLink,
                    })
                  }
                  class="label flex items-center gap-0.5 text-[11px] text-lol-gold transition-colors hover:text-lol-gold-light"
                >
                  View all in Match History
                  <ChevronRightIcon class="h-3 w-3" />
                </button>
              </Show>
            }
          >
            <Show when={matches().length > 0} fallback={<EmptyLine>No games</EmptyLine>}>
              <For each={matches()} keyed={(m) => m.game_id}>
                {(m) => (
                  <div
                    class={[
                      "flex h-9 items-center gap-3 rounded-[3px] border-l-2 bg-gradient-to-r to-transparent pr-2 pl-2",
                      m().is_remake
                        ? "border-lol-text/30 from-white/[0.03]"
                        : m().win
                          ? "border-lol-win from-lol-win/[0.11]"
                          : "border-lol-loss from-lol-loss/[0.11]",
                    ]}
                  >
                    <span
                      class={[
                        "slant-sm font-display w-12 shrink-0 py-px text-center text-[11px] font-extrabold tracking-[0.08em] uppercase italic",
                        m().is_remake
                          ? "bg-white/[0.06] text-lol-text"
                          : m().win
                            ? "bg-lol-win/15 text-lol-win"
                            : "bg-lol-loss/15 text-lol-loss",
                      ]}
                    >
                      {m().is_remake ? "Remake" : m().win ? "Win" : "Loss"}
                    </span>
                    <span class="font-num shrink-0 text-[14px] font-semibold text-lol-text-bright">
                      <Kda kills={m().kills} deaths={m().deaths} assists={m().assists} />
                    </span>
                    <Show when={m().score != null && !m().is_remake}>
                      <span
                        class={[
                          "font-num shrink-0 text-[14px] font-semibold",
                          scoreColor(m().score!),
                        ]}
                      >
                        {formatDecimal(m().score!)}
                      </span>
                    </Show>
                    <span class="font-num ml-auto shrink-0 text-[13px] text-lol-text">
                      {formatDuration(m().game_duration)}
                    </span>
                    <span class="font-num w-14 shrink-0 text-right text-[13px] text-lol-text/70">
                      {formatTimeAgo(m().game_creation)}
                    </span>
                  </div>
                )}
              </For>
            </Show>
          </DetailBlock>
        </div>
      </td>
    </Show>
  );
}

export default function Champions() {
  const champData = useChampionData();
  const [patch, setPatch] = useViewState<string | undefined>("champions.patch", undefined);
  const [queue, setQueue] = useViewState<number | undefined>("champions.queue", undefined);
  const [season, setSeason] = useViewState<string | undefined>("champions.season", undefined);
  const { data, refetch } = useIpc(
    ([patch, queue, season]) => api.getChampionStats(patch, queue, season),
    () => [patch(), queue(), season()] as const,
  );
  const [search, setSearch] = useViewState("champions.search", "");
  const [minGames, setMinGames] = useViewState<number | undefined>("champions.minGames", undefined);
  const sort = useSort<SortKey>("champions", "games");
  const [expandedId, setExpandedId] = createSignal<number | null>(null);

  onSettled(() => api.onGamesUpdated(() => void refetch()));

  createEffect(
    () => data() !== null,
    (loaded) => {
      if (loaded) reportFirstContent();
    },
  );

  const toggleExpand = (championId: number) => {
    setExpandedId((prev) => (prev === championId ? null : championId));
  };

  const sorted = createMemo(() =>
    filterAndSort(data() ?? [], {
      minGames: minGames(),
      sortKey: sort.sortKey(),
      sortDir: sort.sortDir(),
      matches: (c) => matchesSearch(getChampionName(champData(), c.champion_id), search()),
    }),
  );

  const shownGames = () => sorted().reduce((sum, c) => sum + c.games, 0);
  const sortProps = () => ({
    sortKey: sort.sortKey(),
    sortDir: sort.sortDir(),
    onSort: sort.onSort,
  });

  return (
    <Show when={data()} fallback={<div class="text-lol-text text-center mt-20">Loading...</div>}>
      {(rows) => (
        <div class="max-w-[1320px] space-y-6">
          <PageHeader
            kicker="Analyze"
            title="Champions"
            subtitle={
              <>
                <span class="font-num text-[14px] font-semibold text-lol-text-bright">
                  {sorted().length.toLocaleString(LOCALE)}
                </span>{" "}
                {sorted().length === 1 ? "champion" : "champions"}
                <span class="mx-2 text-lol-text/40">·</span>
                <span class="font-num text-[14px] font-semibold text-lol-text-bright">
                  {shownGames().toLocaleString(LOCALE)}
                </span>{" "}
                {shownGames() === 1 ? "game" : "games"}
              </>
            }
            actions={
              <>
                <FilterMenu
                  active={
                    [season(), patch(), queue(), minGames()].filter((v) => v !== undefined).length
                  }
                  onReset={() => {
                    setSeason(undefined);
                    setPatch(undefined);
                    setQueue(undefined);
                    setMinGames(undefined);
                  }}
                >
                  <SeasonSelect value={season()} onChange={setSeason} label="Set" />
                  <PatchSelect value={patch()} onChange={setPatch} label="Patch" />
                  <QueueSelect value={queue()} onChange={setQueue} label="Queue" />
                  <MinGamesFilter
                    value={minGames()}
                    onChange={setMinGames}
                    max={Math.max(...rows().map((c) => c.games))}
                  />
                </FilterMenu>
                <SearchInput
                  value={search()}
                  onChange={setSearch}
                  placeholder="Search champion..."
                />
              </>
            }
          />

          {/* Clipped rather than hidden, so the header row can stick while the
              long list scrolls under it. It sticks at -top-2 to cover the page's
              top padding, which would otherwise show rows above it. */}
          <div class="panel overflow-clip">
            <table class="w-full table-fixed">
              <thead class="sticky -top-2 z-10 bg-[#0e142b] shadow-[0_1px_0_var(--color-lol-line)]">
                <tr>
                  <th class="tbl-head w-12 px-3 py-3 text-right">#</th>
                  <th class="tbl-head px-3 py-3 text-left">Champion</th>
                  <SortHeader
                    {...sortProps()}
                    numeric
                    label="Games"
                    field="games"
                    class="w-[76px]"
                  />
                  <SortHeader
                    {...sortProps()}
                    numeric
                    label="Win Rate"
                    field="wins"
                    class="w-[168px]"
                  />
                  <CycleSortHeader
                    {...sortProps()}
                    numeric
                    steps={KDA_STEPS}
                    hint="Average kills / deaths / assists, with the KDA ratio under them"
                    class="w-32"
                  />
                  <SortHeader
                    {...sortProps()}
                    numeric
                    label="Score"
                    field="avg_score"
                    class="w-[72px]"
                  />
                  <CycleSortHeader
                    {...sortProps()}
                    numeric
                    steps={BADGE_STEPS}
                    hint="MVP / ACE: games as the best player on the winning team / on the losing team"
                    class="w-24"
                  />
                  <SortHeader
                    {...sortProps()}
                    numeric
                    label="Dmg"
                    field="avg_damage"
                    class="w-[76px]"
                  />
                  <SortHeader
                    {...sortProps()}
                    numeric
                    label="Gold"
                    field="avg_gold"
                    class="w-[76px]"
                  />
                  <CycleSortHeader
                    {...sortProps()}
                    steps={MULTIKILL_STEPS}
                    hint="Multikills: D double, T triple, Q quadra, P penta kills"
                    class="w-46"
                  />
                </tr>
              </thead>
              <tbody>
                <For each={sorted()} keyed={(c) => c.champion_id}>
                  {(row, i) => {
                    const isExpanded = () => expandedId() === row().champion_id;
                    const ratio = () =>
                      row().deaths > 0 ? (row().kills + row().assists) / row().deaths : Infinity;
                    return (
                      <>
                        <tr
                          onClick={() => toggleExpand(row().champion_id)}
                          class={[
                            "group cursor-pointer border-t border-lol-line transition-colors",
                            isExpanded() ? "bg-white/[0.045]" : "hover:bg-white/[0.03]",
                          ]}
                        >
                          <td
                            class={[
                              "font-num px-3 py-2.5 text-right text-[14px] text-lol-text/60",
                              isExpanded() ? "shadow-[inset_2px_0_0_var(--color-lol-gold)]" : "",
                            ]}
                          >
                            {i() + 1}
                          </td>
                          <td class="px-3 py-2.5">
                            <div class="flex items-center gap-3">
                              <ChampionIcon championId={row().champion_id} size={36} />
                              <div class="min-w-0">
                                <div class="font-display truncate text-[16px] leading-tight font-semibold text-lol-text-bright">
                                  {getChampionName(champData(), row().champion_id)}
                                </div>
                                <div class="font-num text-[12px] leading-tight text-lol-text">
                                  {row().wins.toLocaleString(LOCALE)}W
                                  <span class="mx-1 text-lol-text/35">·</span>
                                  {(row().games - row().wins).toLocaleString(LOCALE)}L
                                </div>
                              </div>
                              <ChevronRightIcon
                                class={[
                                  "ml-auto h-4 w-4 shrink-0 transition-all",
                                  isExpanded()
                                    ? "rotate-90 text-lol-gold"
                                    : "text-lol-text/0 group-hover:text-lol-text/60",
                                ]}
                              />
                            </div>
                          </td>
                          <td class="font-num px-3 py-2.5 text-right text-[16px] font-semibold text-lol-text-bright">
                            {row().games.toLocaleString(LOCALE)}
                          </td>
                          <td class="px-3 py-2.5">
                            <WinRateBar wins={row().wins} total={row().games} />
                          </td>
                          <td class="px-3 py-2.5 text-right">
                            <div class="font-num text-[15px] leading-tight text-slate-300">
                              <Kda
                                kills={formatDecimal(row().avg_kills)}
                                deaths={formatDecimal(row().avg_deaths)}
                                assists={formatDecimal(row().avg_assists)}
                              />
                            </div>
                            <div
                              class={[
                                "font-num text-[12px] leading-tight font-semibold",
                                kdaColor(ratio()),
                              ]}
                            >
                              {kdaRatio(row().kills, row().deaths, row().assists)}
                              <span class="ml-1 text-[11px] tracking-[0.06em] text-lol-text/70">
                                KDA
                              </span>
                            </div>
                          </td>
                          <td
                            class={[
                              "font-num px-3 py-2.5 text-right text-[16px] font-semibold",
                              row().avg_score != null
                                ? scoreColor(row().avg_score!)
                                : "text-lol-text/40",
                            ]}
                          >
                            {row().avg_score != null ? formatDecimal(row().avg_score!) : "—"}
                          </td>
                          <td class="font-num px-3 py-2.5 text-right text-[15px] whitespace-nowrap">
                            <BadgeCount count={row().mvps} tone="text-amber-300" />
                            <span class="mx-1 text-lol-text/30">/</span>
                            <BadgeCount count={row().aces} tone="text-purple-400" />
                          </td>
                          <td
                            class="font-num px-3 py-2.5 text-right text-[15px] text-slate-300"
                            title={(row().avg_damage ?? 0).toLocaleString(LOCALE)}
                          >
                            {formatCompact(row().avg_damage ?? 0)}
                          </td>
                          <td
                            class="font-num px-3 py-2.5 text-right text-[15px] text-slate-300"
                            title={(row().avg_gold ?? 0).toLocaleString(LOCALE)}
                          >
                            {formatCompact(row().avg_gold ?? 0)}
                          </td>
                          <td class="px-3 py-2.5">
                            <div class="flex gap-1.5">
                              <For each={MULTIKILL_SLOTS}>
                                {(slot) => {
                                  const count = () => row()[slot.key];
                                  return (
                                    <span class="w-[34px] shrink-0">
                                      <Show when={count() > 0}>
                                        <span
                                          title={`${slot.name} kill${count() > 1 ? `s x${count().toLocaleString(LOCALE)}` : ""}`}
                                          class={[
                                            "font-num inline-block rounded-[2px] px-1.5 py-1 text-[13px] leading-none font-bold whitespace-nowrap ring-1 ring-inset",
                                            slot.tone,
                                          ]}
                                        >
                                          {slot.letter}
                                          {count() > 1 ? count().toLocaleString(LOCALE) : ""}
                                        </span>
                                      </Show>
                                    </span>
                                  );
                                }}
                              </For>
                            </div>
                          </td>
                        </tr>
                        <Show when={isExpanded()}>
                          <tr class="border-t border-lol-line">
                            <ChampionExpanded
                              championId={row().champion_id}
                              patch={patch()}
                              queue={queue()}
                              season={season()}
                            />
                          </tr>
                        </Show>
                      </>
                    );
                  }}
                </For>
              </tbody>
            </table>
            <Show when={sorted().length === 0}>
              <div class="flex flex-col items-center gap-3 border-t border-lol-line py-14 text-center">
                <TrophyIcon class="h-7 w-7 text-lol-gold/60" />
                <div class="text-[14px] text-lol-text">
                  No champions match these filters. Try a different search or reset the filters.
                </div>
              </div>
            </Show>
          </div>
        </div>
      )}
    </Show>
  );
}
