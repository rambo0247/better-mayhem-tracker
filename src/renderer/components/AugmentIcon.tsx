import { useEffect, useMemo, useState } from "react";
import { nameFromIconPath, useAugmentData } from "../hooks/useChampions";
import { GAME_ASSET_URL } from "../lib/constants";
import HoverCard from "./HoverCard";
import RiotText from "./RiotText";

interface AugmentIconProps {
  augmentId: number;
  size?: number;
  showName?: boolean;
  // Type size and weight of the name, when it's shown
  nameClassName?: string;
  patch?: string | null;
}

// The ring around the icon carries the rarity, so a name beside it can stay in
// the page's own text colour instead of shouting in gold or pink. The colours
// match the rarity filter's.
const rarityBorder: Record<string, string> = {
  kSilver: "ring-1 ring-[#c9d1e8]/45",
  kGold: "ring-1 ring-amber-400/75",
  kPrismatic: "ring-1 ring-fuchsia-400/80",
};

const rarityLabelColor: Record<string, string> = {
  kSilver: "text-[#c9d1e8]",
  kGold: "text-amber-400",
  kPrismatic: "bg-gradient-to-r from-fuchsia-400 to-sky-400 bg-clip-text text-transparent",
};

// One lookup per augment for the whole renderer: a retired augment shows up on
// every row of the stats pages, and they'd otherwise each ask the main process.
// Keyed by patch as well, because a lookup that started from the live export
// searches different branches than one that knows the game it's drawing.
const fallbackLookups = new Map<string, Promise<string | null>>();
// The settled result of those lookups, so a remount can start on the archived
// URL instead of waiting a tick for the promise to come back around.
const fallbackResults = new Map<string, string | null>();
// Live "latest" URLs already known to 404. Without this, every remount of a
// retired augment — re-sorting a list, reopening an expanded row — replays the
// dead paths and shows a broken <img> until the fallback lands, which is what
// made the icon flicker each time.
const deadSources = new Set<string>();

const fallbackKey = (augmentId: number, patch?: string | null) =>
  `${augmentId}|${patch || "latest"}`;

function lookupFallbackIcon(augmentId: number, patch?: string | null): Promise<string | null> {
  const key = fallbackKey(augmentId, patch);
  let promise = fallbackLookups.get(key);
  if (!promise) {
    promise = window.api.resolveAugmentIcon(augmentId, patch ?? undefined);
    fallbackLookups.set(key, promise);
    promise.then(
      (url) => fallbackResults.set(key, url),
      () => fallbackLookups.delete(key),
    );
  }
  return promise;
}

function getAugmentRarityLabel(rarity: string): string {
  if (rarity === "kSilver") return "Silver";
  if (rarity === "kGold") return "Gold";
  if (rarity === "kPrismatic") return "Prismatic";
  return "";
}

export default function AugmentIcon({
  augmentId,
  size = 28,
  showName = false,
  nameClassName = "text-xs",
  patch,
}: AugmentIconProps) {
  const augmentData = useAugmentData(patch);
  const aug = augmentData[augmentId];
  const [attempt, setAttempt] = useState(0);
  const cacheKey = fallbackKey(augmentId, patch);
  const [fallback, setFallback] = useState<string | null>(
    () => fallbackResults.get(cacheKey) ?? null,
  );

  const sources = useMemo(() => {
    if (!aug?.iconPath) return [];
    // Paths are only valid against the branch they were read from, and the
    // data names the small art with the large variant beside it under the
    // same name.
    const branch = aug.branch || "latest";
    const large = GAME_ASSET_URL(branch, aug.iconPath.replace("small", "large"));
    const small = GAME_ASSET_URL(branch, aug.iconPath);
    return [...new Set([large, small])].filter((url) => !deadSources.has(url));
  }, [aug]);

  // Augment data arrives after the first render, so the live paths appear late;
  // start over on them, keeping whatever fallback is already known.
  const sourcesKey = `${cacheKey} ${sources.join(" ")}`;
  const [attemptsFor, setAttemptsFor] = useState(sourcesKey);
  if (attemptsFor !== sourcesKey) {
    setAttemptsFor(sourcesKey);
    setAttempt(0);
    setFallback(fallbackResults.get(cacheKey) ?? null);
  }

  // Augments Riot has cut keep their name and rarity on "latest" but lose their
  // art, so once the live paths 404 ask the main process to dig the icon out of
  // an archived patch branch.
  const exhausted = attempt >= sources.length;
  const resolved = fallbackResults.has(cacheKey);
  useEffect(() => {
    if (!exhausted || resolved) return;
    let active = true;
    lookupFallbackIcon(augmentId, patch).then((url) => {
      if (active) setFallback(url);
    });
    return () => {
      active = false;
    };
  }, [exhausted, resolved, augmentId, patch]);

  const name =
    aug?.name?.trim() || nameFromIconPath(aug?.iconPath) || `Unknown augment ${augmentId}`;
  const borderClass = rarityBorder[aug?.rarity ?? ""] || "";
  const labelColor = rarityLabelColor[aug?.rarity ?? ""] || "text-lol-text";
  const src = sources[attempt] ?? fallback;

  const rarityLabel = getAugmentRarityLabel(aug?.rarity ?? "");

  return (
    <HoverCard
      content={
        aug ? (
          <>
            <div className="mb-1.5 flex items-baseline justify-between gap-3 border-b border-lol-line pb-1.5">
              <span className="font-display text-[15px] font-bold leading-tight text-lol-text-bright">
                {name}
              </span>
              {rarityLabel && (
                <span className={`label shrink-0 text-[11px] ${labelColor}`}>{rarityLabel}</span>
              )}
            </div>
            {aug.desc ? (
              <RiotText markup={aug.desc} />
            ) : (
              // Two Mayhem augments have no entry in the game data the
              // generator reads, and retired ones can outlive it.
              <span className="italic text-lol-text/50">No description available.</span>
            )}
          </>
        ) : null
      }
    >
      {/* The native tooltip stays for the moment before augment data lands. */}
      <div className="flex items-center gap-1.5 min-w-0" title={aug ? undefined : name}>
        {src ? (
          <img
            key={src}
            src={src}
            alt={name}
            width={size}
            height={size}
            className={`rounded-[3px] shrink-0 ${borderClass}`}
            onError={() => {
              // Step down the live paths first, remembering the dead one so no
              // other icon retries it; a failed fallback has nothing left to try,
              // so drop to the placeholder.
              if (attempt < sources.length) {
                deadSources.add(sources[attempt]);
                setAttempt((a) => a + 1);
              } else setFallback(null);
            }}
          />
        ) : (
          // Keeps the rarity ring and the hover tooltip so an augment with no art
          // anywhere still reads as an augment rather than a gap in the row.
          <div
            className={`flex shrink-0 items-center justify-center rounded-[3px] border border-white/[0.06] bg-black/25 font-display font-bold text-lol-text/70 ${borderClass}`}
            style={{ width: size, height: size, fontSize: Math.max(10, size * 0.45) }}
          >
            ?
          </div>
        )}
        {showName && (
          <span className={`truncate text-lol-text-bright ${nameClassName}`}>{name}</span>
        )}
      </div>
    </HoverCard>
  );
}
