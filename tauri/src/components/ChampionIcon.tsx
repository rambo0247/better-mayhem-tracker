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
// 1/0.88 of the tile's size and the tile clips the frame away.
const CROP_SCALE = "calc(100% / 0.88)";
const CROP_OFFSET = "calc(-6% / 0.88)";

export default function ChampionIcon(props: ChampionIconProps) {
  const [failed, setFailed] = createSignal(false);
  const size = () => `${props.size ?? 32}px`;
  return (
    <span
      title={props.title}
      style={{ width: size(), height: size(), display: failed() ? "none" : undefined }}
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
          width: CROP_SCALE,
          height: CROP_SCALE,
          left: CROP_OFFSET,
          top: CROP_OFFSET,
          "max-width": "none",
        }}
        onError={() => setFailed(true)}
      />
    </span>
  );
}
