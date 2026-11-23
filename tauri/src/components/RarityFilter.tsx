import { For } from "solid-js";

export type Rarity = "all" | "kSilver" | "kGold" | "kPrismatic";

const filters: { key: Rarity; label: string; color: string; activeColor: string }[] = [
  {
    key: "all",
    label: "All",
    color: "text-lol-text",
    activeColor: "bg-lol-text-bright text-[#0a0f24]",
  },
  {
    key: "kSilver",
    label: "Silver",
    color: "text-[#c9d1e8]",
    activeColor: "bg-[#c9d1e8] text-[#0a0f24]",
  },
  {
    key: "kGold",
    label: "Gold",
    color: "text-amber-400",
    activeColor: "bg-amber-400 text-[#2a1c00]",
  },
  {
    key: "kPrismatic",
    label: "Prismatic",
    color: "text-fuchsia-400",
    activeColor: "bg-gradient-to-r from-fuchsia-400 to-sky-400 text-[#140a2a]",
  },
];

// One segmented control; the caller places it in its row
export default function RarityFilter(props: { value: Rarity; onChange: (rarity: Rarity) => void }) {
  return (
    <div class="seg" role="group" aria-label="Rarity">
      <For each={filters}>
        {(f) => (
          <button
            onClick={() => props.onChange(f.key)}
            aria-pressed={props.value === f.key ? "true" : "false"}
            class={["seg-item", props.value === f.key ? f.activeColor : f.color]}
          >
            {f.label}
          </button>
        )}
      </For>
    </div>
  );
}
