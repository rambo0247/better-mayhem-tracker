import { createSignal, Show } from "solid-js";
import { PROFILE_ICON_URL } from "../lib/constants";

interface SummonerIconProps {
  iconId: number | null;
  size?: number;
  class?: string;
  // Fetched only as it scrolls near view, for lists long enough that loading
  // every icon up front would mean a request per player
  lazy?: boolean;
}

// Profile icons only exist for players we've seen a profileIcon for, and the
// CDN drops very old ones — fall back to a neutral placeholder either way so
// the column keeps its width.
export default function SummonerIcon(props: SummonerIconProps) {
  const [failed, setFailed] = createSignal(false);
  const size = () => props.size ?? 28;

  return (
    <Show
      when={props.iconId != null && !failed()}
      fallback={
        <div
          style={{ width: `${size()}px`, height: `${size()}px` }}
          class={["rounded-full bg-lol-border/60 shrink-0", props.class ?? ""]}
        />
      }
    >
      <img
        src={PROFILE_ICON_URL(props.iconId!)}
        alt=""
        width={size()}
        height={size()}
        loading={props.lazy ? "lazy" : undefined}
        class={["rounded-full shrink-0", props.class ?? ""]}
        onError={() => setFailed(true)}
      />
    </Show>
  );
}
