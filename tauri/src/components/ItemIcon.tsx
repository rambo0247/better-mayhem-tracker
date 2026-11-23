import { createMemo, createSignal, Show } from "solid-js";
import { useItemData } from "../hooks/useChampions";
import { GAME_ASSET_URL } from "../lib/constants";
import HoverCard from "./HoverCard";
import RiotText from "./RiotText";

interface ItemIconProps {
  itemId: number;
  size?: number;
  patch?: string | null;
}

// Some Mayhem item icons carry a texture-variant suffix that CommunityDragon
// doesn't export (e.g. "3153_Blade_of_the_Ruined_King.project_jade.png" 404s
// while "3153_Blade_of_the_Ruined_King.png" exists). The client serves them,
// but only for the current patch and only while it's running, so keep the base
// path as a fallback.
function stripIconVariant(iconPath: string): string | null {
  const stripped = iconPath.replace(/\.[^./]+(\.\w+)$/, "$1");
  return stripped === iconPath ? null : stripped;
}

export default function ItemIcon(props: ItemIconProps) {
  const items = useItemData(() => props.patch);
  const item = () => items()[props.itemId];
  const size = () => props.size ?? 24;

  // No tier below these: an item with no CommunityDragon mapping, or whose
  // icons all fail, falls through to the placeholder below.
  const sources = createMemo(
    () => {
      const found = item();
      const out: string[] = [];
      if (found?.iconPath) {
        out.push(GAME_ASSET_URL(found.branch, found.iconPath));
        const base = stripIconVariant(found.iconPath);
        if (base) out.push(GAME_ASSET_URL(found.branch, base));
      }
      return out;
    },
    { equals: (a, b) => a.join(" ") === b.join(" ") },
  );

  // New sources, from the item data landing or another patch, start the list
  // over
  const [attempt, setAttempt] = createSignal(() => (sources(), 0));
  const src = () => sources()[attempt()];

  return (
    <Show
      when={props.itemId && src()}
      fallback={
        <div
          class="rounded-[3px] bg-black/25 border border-white/[0.06]"
          style={{ width: `${size()}px`, height: `${size()}px` }}
        />
      }
    >
      <HoverCard
        content={
          item()?.name
            ? () => (
                <>
                  <div class="mb-1 font-semibold text-lol-gold-light">{item()?.name}</div>
                  <RiotText markup={item()?.description ?? ""} />
                </>
              )
            : null
        }
      >
        <Show when={src()} keyed>
          {(url) => (
            <img
              src={url}
              alt=""
              // No title= — the browser's own tooltip would surface a second later
              // and sit on top of the card showing the same name.
              width={size()}
              height={size()}
              class="rounded-[3px]"
              onError={() => setAttempt((a) => a + 1)}
            />
          )}
        </Show>
      </HoverCard>
    </Show>
  );
}
