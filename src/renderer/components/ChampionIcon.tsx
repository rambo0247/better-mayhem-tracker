import type { CSSProperties } from "react";
import { CHAMPION_ICON_URL } from "../lib/constants";

interface ChampionIconProps {
  championId: number;
  size?: number;
  // Sharp square art instead of the usual softened tile, for grids that read
  // as a collection rather than as a player in a row
  rounded?: boolean;
  title?: string;
  className?: string;
}

export default function ChampionIcon({
  championId,
  size = 32,
  rounded = true,
  title,
  className = "",
}: ChampionIconProps) {
  return (
    <img
      src={CHAMPION_ICON_URL(championId)}
      alt=""
      title={title}
      width={size}
      height={size}
      // The art carries a dark frame of its own; cropping it off lets the tile
      // sit edge to edge with the app's own borders
      style={{ objectViewBox: "inset(6%)" } as CSSProperties}
      className={`shrink-0 ${rounded ? "rounded-md" : "rounded-sm"} ${className}`}
      onError={(e) => {
        (e.target as HTMLImageElement).style.display = "none";
      }}
    />
  );
}
