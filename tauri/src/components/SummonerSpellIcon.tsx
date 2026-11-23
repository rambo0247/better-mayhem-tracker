import { Show } from "solid-js";
import { useSummonerSpellData } from "../hooks/useChampions";
import { GAME_ASSET_URL } from "../lib/constants";

interface SummonerSpellIconProps {
  spellId: number | null;
  size?: number;
}

export default function SummonerSpellIcon(props: SummonerSpellIconProps) {
  const spells = useSummonerSpellData();
  const spell = () => (props.spellId ? spells()[props.spellId] : undefined);
  const size = () => props.size ?? 16;

  return (
    <Show
      when={spell()?.iconPath ? spell() : null}
      fallback={
        <div
          class="rounded-[3px] bg-black/25 border border-white/[0.06]"
          style={{ width: `${size()}px`, height: `${size()}px` }}
        />
      }
    >
      {(found) => (
        <img
          src={GAME_ASSET_URL("latest", found().iconPath)}
          alt=""
          title={found().name}
          width={size()}
          height={size()}
          class="rounded-[3px]"
        />
      )}
    </Show>
  );
}
