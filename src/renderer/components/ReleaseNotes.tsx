import { useState } from "react";
import { LOCALE } from "../lib/format";
import type { ReleaseNote } from "../lib/types";
import { ChevronRightIcon } from "./icons";
import Markdown from "./Markdown";

function formatReleaseDate(iso: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(LOCALE, { month: "short", day: "numeric" });
}

function ReleaseBody({ release }: { release: ReleaseNote }) {
  if (!release.body) {
    return <p className="text-[13px] italic text-lol-text">No notes for this release.</p>;
  }
  return (
    <div className="text-[13px] leading-[1.5] text-lol-text">
      <Markdown text={release.body} />
    </div>
  );
}

// A scrolling box of release notes, newest first
export default function ReleaseNotes({ releases }: { releases: ReleaseNote[] }) {
  // Only the newest is expanded up front: someone several versions behind gets a
  // scannable list of what they missed instead of a wall of bullets.
  const [openVersions, setOpenVersions] = useState<Set<string>>(
    () => new Set(releases.length ? [releases[0].version] : []),
  );

  const toggleVersion = (version: string) => {
    setOpenVersions((prev) => {
      const next = new Set(prev);
      if (next.has(version)) next.delete(version);
      else next.add(version);
      return next;
    });
  };

  return (
    <div className="mt-4 min-h-0 flex-1 overflow-y-auto rounded-lg border border-lol-line bg-black/25">
      {releases.map((release, i) => {
        // A single release needs no accordion around it.
        if (releases.length === 1) {
          return (
            <div key={release.version} className="px-4 py-3.5">
              <ReleaseBody release={release} />
            </div>
          );
        }
        const open = openVersions.has(release.version);
        return (
          <div key={release.version} className={i > 0 ? "border-t border-lol-line" : ""}>
            <button
              onClick={() => toggleVersion(release.version)}
              aria-expanded={open}
              className="flex h-10 w-full items-center gap-2.5 px-4 text-left transition-colors hover:bg-white/[0.03]"
            >
              <ChevronRightIcon
                className={`h-3.5 w-3.5 shrink-0 text-lol-gold/70 transition-transform ${open ? "rotate-90" : ""}`}
              />
              <span
                className={`font-num text-[15px] font-semibold ${open ? "text-lol-gold-light" : "text-lol-text-bright"}`}
              >
                v{release.version}
              </span>
              {i === 0 && <span className="chip bg-lol-gold/12 text-lol-gold">Latest</span>}
              <span className="ml-auto font-num text-[13px] text-lol-text">
                {formatReleaseDate(release.publishedAt)}
              </span>
            </button>
            {open && (
              <div className="pb-3.5 pl-10 pr-4">
                <ReleaseBody release={release} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
