import { Show } from "solid-js";
import { GAME_ASSET_URL } from "../lib/constants";

interface ChallengeTokenProps {
  // Game-data path to the tier's token, as the client names it
  iconPath: string;
  size?: number;
  // An unstarted challenge borrows the IRON token, drawn faint so it doesn't
  // read as earned
  dim?: boolean;
  // Hover text, for the tokens that stand on their own without a label beside
  // them
  title?: string;
  class?: string;
}

export default function ChallengeToken(props: ChallengeTokenProps) {
  const size = () => props.size ?? 40;
  return (
    <Show
      when={props.iconPath}
      fallback={
        <div
          style={{ width: `${size()}px`, height: `${size()}px` }}
          title={props.title}
          class={[
            "rounded-full border border-lol-border/60 bg-white/5 shrink-0",
            props.class ?? "",
          ]}
        />
      }
    >
      <img
        src={GAME_ASSET_URL("latest", props.iconPath)}
        alt=""
        title={props.title}
        width={size()}
        height={size()}
        class={["shrink-0", { "opacity-25 grayscale": props.dim }, props.class ?? ""]}
        onError={(e) => {
          e.currentTarget.style.visibility = "hidden";
        }}
      />
    </Show>
  );
}
