import { createEffect, createMemo, createSignal, For, onSettled, Show } from "solid-js";
import { useIpc } from "../hooks/useIpc";
import { useViewState } from "../hooks/useViewState";
import { useSort } from "../hooks/useSort";
import {
  useChampionData,
  getChampionName,
  useAugmentData,
  getAugmentName,
} from "../hooks/useChampions";
import { api } from "../lib/api-shim";
import { reportFirstContent } from "../lib/perf";
import type { AugmentStatsDetailedResult } from "../lib/types";
import { LOCALE, formatPercent } from "../lib/format";
import { matchesSearch } from "../lib/search";
import AugmentIcon from "../components/AugmentIcon";
import ChampionIcon from "../components/ChampionIcon";
import WinRateBar from "../components/WinRateBar";
import PatchSelect from "../components/PatchSelect";
import QueueSelect from "../components/QueueSelect";
import SortHeader from "../components/SortHeader";
import SearchInput from "../components/SearchInput";
import FilterMenu from "../components/FilterMenu";
import MinGamesFilter from "../components/MinGamesFilter";
import SeasonSelect from "../components/SeasonSelect";
import RarityFilter, { type Rarity } from "../components/RarityFilter";
import PageHeader from "../components/PageHeader";
import { ChevronRightIcon, SparklesIcon } from "../components/icons";

type SortKey = "picks" | "winRate" | "name";

// The rarity tag beside each augment. The icon's ring already carries the
// colour, so the name itself can stay in the table's one bright text colour.
const RARITY_TAGS: Record<string, { label: string; tone: string }> = {
  kSilver: { label: "Silver", tone: "bg-slate-300/10 text-slate-300 ring-slate-300/20" },
  kGold: { label: "Gold", tone: "bg-amber-400/12 text-amber-400 ring-amber-400/25" },
  kPrismatic: {
    label: "Prismatic",
    tone: "bg-fuchsia-400/12 text-fuchsia-300 ring-fuchsia-400/30",
  },
};

// Portraits shown in the collapsed row, before the rest fold into a count
const TOP_CHAMPIONS = 5;
// The order localeCompare gives with no arguments
const NAME_ORDER = new Intl.Collator();

export default function Augments() {
  const champData = useChampionData();
  const augmentData = useAugmentData();
  const [patch, setPatch] = useViewState<string | undefined>("augments.patch", undefined);
  const [queue, setQueue] = useViewState<number | undefined>("augments.queue", undefined);
  const [season, setSeason] = useViewState<string | undefined>("augments.season", undefined);
  const { data, refetch } = useIpc<
    AugmentStatsDetailedResult,
    readonly [string | undefined, number | undefined, string | undefined]
  >(
    ([p, q, s]) => api.getAugmentStatsDetailed(p, q, s),
    () => [patch(), queue(), season()] as const,
  );
  const [search, setSearch] = useViewState("augments.search", "");
  const [minPicks, setMinPicks] = useViewState<number | undefined>("augments.minPicks", undefined);
  const sort = useSort<SortKey>("augments", "picks");
  const [expanded, setExpanded] = createSignal<ReadonlySet<number>>(new Set());
  const [rarityFilter, setRarityFilter] = useViewState<Rarity>("augments.rarity", "all");

  onSettled(() => api.onGamesUpdated(() => void refetch()));

  createEffect(data, (d) => {
    if (d) reportFirstContent();
  });

  const totalGames = () => data()?.totalGames ?? 0;

  const toggleExpand = (augmentId: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(augmentId)) next.delete(augmentId);
      else next.add(augmentId);
      return next;
    });
  };

  const sorted = createMemo(() => {
    const d = data();
    if (!d) return [];
    const aug = augmentData();
    const key = sort.sortKey();
    const dir = sort.sortDir();
    const names = new Map<number, string>();
    const filtered = d.augments.filter((a) => {
      const name = getAugmentName(aug, a.augment_id);
      if (!matchesSearch(name, search())) return false;
      if (rarityFilter() !== "all" && aug[a.augment_id]?.rarity !== rarityFilter()) return false;
      const min = minPicks();
      if (min !== undefined && a.picks < min) return false;
      names.set(a.augment_id, name);
      return true;
    });

    filtered.sort((a, b) => {
      let av: number, bv: number;
      if (key === "name") {
        const cmp = NAME_ORDER.compare(names.get(a.augment_id)!, names.get(b.augment_id)!);
        return dir === "asc" ? cmp : -cmp;
      } else if (key === "winRate") {
        av = a.picks > 0 ? a.wins / a.picks : 0;
        bv = b.picks > 0 ? b.wins / b.picks : 0;
      } else {
        av = a.picks;
        bv = b.picks;
      }
      return dir === "desc" ? bv - av : av - bv;
    });

    return filtered;
  });

  return (
    <Show when={data()} fallback={<div class="text-lol-text text-center mt-20">Loading...</div>}>
      {(d) => (
        <div class="max-w-[1320px] space-y-6">
          <PageHeader
            kicker="Analyze"
            title="Augments"
            subtitle={
              <>
                <span class="font-num text-[14px] font-semibold text-lol-text-bright">
                  {sorted().length.toLocaleString(LOCALE)}
                </span>{" "}
                {sorted().length === 1 ? "augment" : "augments"}
                <span class="mx-2 text-lol-text/40">·</span>
                <span class="font-num text-[14px] font-semibold text-lol-text-bright">
                  {totalGames().toLocaleString(LOCALE)}
                </span>{" "}
                {totalGames() === 1 ? "game" : "games"}
              </>
            }
            actions={
              <>
                <RarityFilter value={rarityFilter()} onChange={setRarityFilter} />
                <FilterMenu
                  active={
                    [season(), patch(), queue(), minPicks()].filter((v) => v !== undefined).length
                  }
                  onReset={() => {
                    setSeason(undefined);
                    setPatch(undefined);
                    setQueue(undefined);
                    setMinPicks(undefined);
                  }}
                >
                  <SeasonSelect value={season()} onChange={setSeason} label="Set" />
                  <PatchSelect value={patch()} onChange={setPatch} label="Patch" />
                  <QueueSelect value={queue()} onChange={setQueue} label="Queue" />
                  <MinGamesFilter
                    value={minPicks()}
                    onChange={setMinPicks}
                    max={Math.max(...d().augments.map((a) => a.picks))}
                    label="Min picks"
                  />
                </FilterMenu>
                <SearchInput
                  value={search()}
                  onChange={setSearch}
                  placeholder="Search augment..."
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
                  <th class="w-11" aria-label="Expand" />
                  <SortHeader
                    sortKey={sort.sortKey()}
                    sortDir={sort.sortDir()}
                    onSort={sort.onSort}
                    label="Augment"
                    field="name"
                  />
                  <th class="tbl-head w-28 px-3 py-3 text-left">Rarity</th>
                  <th
                    class="tbl-head w-[208px] px-3 py-3 text-left"
                    title="The champions this augment was picked on, most picks first"
                  >
                    Played on
                  </th>
                  <SortHeader
                    sortKey={sort.sortKey()}
                    sortDir={sort.sortDir()}
                    onSort={sort.onSort}
                    numeric
                    label="Picks"
                    field="picks"
                    class="w-20"
                  />
                  <th class="tbl-head w-24 px-3 py-3 text-right">Pick Rate</th>
                  <SortHeader
                    sortKey={sort.sortKey()}
                    sortDir={sort.sortDir()}
                    onSort={sort.onSort}
                    numeric
                    label="Win Rate"
                    field="winRate"
                    class="w-44"
                  />
                </tr>
              </thead>
              <tbody>
                <For each={sorted()}>{(a) => <AugmentRows row={a} />}</For>
              </tbody>
            </table>
            <Show when={sorted().length === 0}>
              <div class="flex flex-col items-center gap-3 border-t border-lol-line py-14 text-center">
                <SparklesIcon class="h-7 w-7 text-lol-gold/60" />
                <div class="text-[14px] text-lol-text">
                  No augments match these filters. Try another rarity or search.
                </div>
              </div>
            </Show>
          </div>
        </div>
      )}
    </Show>
  );

  function AugmentRows(props: { row: AugmentStatsDetailedResult["augments"][number] }) {
    const isExpanded = () => expanded().has(props.row.augment_id);
    const pickRate = () => formatPercent(totalGames() > 0 ? props.row.picks / totalGames() : 0);
    const rarity = () => RARITY_TAGS[augmentData()[props.row.augment_id]?.rarity ?? ""];
    const champions = createMemo(() => [...props.row.champions].sort((x, y) => y.picks - x.picks));
    const hidden = () => champions().length - TOP_CHAMPIONS;

    return (
      <>
        <tr
          onClick={() => toggleExpand(props.row.augment_id)}
          aria-expanded={isExpanded() ? "true" : "false"}
          class={[
            "group cursor-pointer border-t border-lol-line transition-colors",
            isExpanded() ? "bg-white/[0.045]" : "hover:bg-white/[0.03]",
          ]}
        >
          <td
            class={[
              "py-2.5 pl-4",
              isExpanded() ? "shadow-[inset_2px_0_0_var(--color-lol-gold)]" : "",
            ]}
          >
            <ChevronRightIcon
              class={[
                "h-4 w-4 transition-all",
                isExpanded()
                  ? "rotate-90 text-lol-gold"
                  : "text-lol-text/50 group-hover:text-lol-text-bright",
              ]}
            />
          </td>
          <td class="px-3 py-2.5">
            <AugmentIcon
              augmentId={props.row.augment_id}
              size={36}
              showName
              nameClass="ml-1.5 font-display text-[16px] font-semibold text-lol-text-bright!"
            />
          </td>
          <td class="px-3 py-2.5">
            <Show when={rarity()}>
              {(r) => <span class={["chip ring-1 ring-inset", r().tone]}>{r().label}</span>}
            </Show>
          </td>
          <td class="px-3 py-2.5">
            <div class="flex items-center">
              <div class="flex -space-x-1">
                <For each={champions().slice(0, TOP_CHAMPIONS)}>
                  {(c) => (
                    <ChampionIcon
                      championId={c.champion_id}
                      size={28}
                      title={`${getChampionName(champData(), c.champion_id)} · ${c.picks.toLocaleString(LOCALE)} picks`}
                      class="ring-2 ring-lol-card"
                    />
                  )}
                </For>
              </div>
              <Show when={hidden() > 0}>
                <span class="font-num ml-2.5 text-[14px] font-semibold text-lol-text-bright/80">
                  +{hidden()}
                </span>
              </Show>
            </div>
          </td>
          <td class="font-num px-3 py-2.5 text-right text-[16px] font-semibold text-lol-text-bright">
            {props.row.picks.toLocaleString(LOCALE)}
          </td>
          <td class="font-num px-3 py-2.5 text-right text-[15px] text-slate-300">{pickRate()}</td>
          <td class="px-3 py-2.5">
            <WinRateBar wins={props.row.wins} total={props.row.picks} />
          </td>
        </tr>
        <Show when={isExpanded()}>
          <For each={champions()}>
            {(c, i) => (
              <tr class={["bg-black/25", i() === 0 ? "border-t border-lol-line" : ""]}>
                <td class="shadow-[inset_2px_0_0_var(--color-lol-gold)]" />
                <td colspan={3} class="py-1.5 pr-3 pl-8">
                  <div class="flex items-center gap-2.5">
                    <span class="h-px w-3 bg-lol-text/25" />
                    <ChampionIcon championId={c.champion_id} size={26} />
                    <span class="font-display text-[15px] font-medium text-lol-text-bright/85">
                      {getChampionName(champData(), c.champion_id)}
                    </span>
                  </div>
                </td>
                <td class="font-num px-3 py-1.5 text-right text-[14px] text-slate-300">
                  {c.picks.toLocaleString(LOCALE)}
                </td>
                <td />
                <td class="px-3 py-1.5">
                  <WinRateBar wins={c.wins} total={c.picks} />
                </td>
              </tr>
            )}
          </For>
        </Show>
      </>
    );
  }
}
