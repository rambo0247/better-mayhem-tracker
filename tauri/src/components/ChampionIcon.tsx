import { createSignal } from "solid-js";
import { CHAMPION_ICON_URL } from "../lib/constants";

interface ChampionIconProps {
  championId: number;
  size?: number;
  // Sharp square art instead of the usual softened tile, for grids that read
  // as a collection rather than as a player in a row
  rounded?: boolean;
  title?: string;
  class?: string;
}

// The art carries a dark frame of its own; cropping 6% off each side lets the
// tile sit edge to edge with the app's own borders. Electron did that with
// object-view-box, which the system WKWebView ignores, so the image is drawn
// 1/0.88 of the tile's size and the tile clips the frame away. The parity
// geometry dump reads the tile as the img Electron drew.

export default function ChampionIcon(props: ChampionIconProps) {
  const [failed, setFailed] = createSignal(false);
  return (
    <span
      data-parity-skip
      title={props.title}
      style={{
        width: `${props.size ?? 32}px`,
        height: `${props.size ?? 32}px`,
        display: failed() ? "none" : undefined,
      }}
      class={[
        "relative block shrink-0 overflow-hidden",
        props.rounded === false ? "rounded-sm" : "rounded-md",
        props.class ?? "",
      ]}
    >
      <img
        src={CHAMPION_ICON_URL(props.championId)}
        alt=""
        style={{
          position: "absolute",
          width: "calc(100% / 0.88)",
          height: "calc(100% / 0.88)",
          left: "calc(-6% / 0.88)",
          top: "calc(-6% / 0.88)",
          "max-width": "none",
        }}
        onError={() => setFailed(true)}
      />
    </span>
  );
}
