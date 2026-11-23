import { createSignal, For, Show } from "solid-js";
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

function ReleaseBody(props: { release: ReleaseNote }) {
  return (
    <Show
      when={props.release.body}
      fallback={<p class="text-[13px] italic text-lol-text">No notes for this release.</p>}
    >
      {(body) => (
        <div class="text-[13px] leading-[1.5] text-lol-text">
          <Markdown text={body()} />
        </div>
      )}
    </Show>
  );
}

// A scrolling box of release notes, newest first
export default function ReleaseNotes(props: { releases: ReleaseNote[] }) {
  // Only the newest is expanded up front: someone several versions behind gets a
  // scannable list of what they missed instead of a wall of bullets. Seeded
  // once, so a new list keeps what the reader opened and closed.
  const [openVersions, setOpenVersions] = createSignal<Set<string>>(
    (opened) => opened ?? new Set(props.releases.length ? [props.releases[0]!.version] : []),
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
    <div class="mt-4 min-h-0 flex-1 overflow-y-auto rounded-lg border border-lol-line bg-black/25">
      <For each={props.releases}>
        {(release, i) => (
          // A single release needs no accordion around it.
          <Show
            when={props.releases.length !== 1}
            fallback={
              <div class="px-4 py-3.5">
                <ReleaseBody release={release} />
              </div>
            }
          >
            <div class={{ "border-t border-lol-line": i() > 0 }}>
              <button
                onClick={() => toggleVersion(release.version)}
                aria-expanded={openVersions().has(release.version) ? "true" : "false"}
                class="flex h-10 w-full items-center gap-2.5 px-4 text-left transition-colors hover:bg-white/[0.03]"
              >
                <ChevronRightIcon
                  class={[
                    "h-3.5 w-3.5 shrink-0 text-lol-gold/70 transition-transform",
                    { "rotate-90": openVersions().has(release.version) },
                  ]}
                />
                <span
                  class={[
                    "font-num text-[15px] font-semibold",
                    openVersions().has(release.version)
                      ? "text-lol-gold-light"
                      : "text-lol-text-bright",
                  ]}
                >
                  v{release.version}
                </span>
                <Show when={i() === 0}>
                  <span class="chip bg-lol-gold/12 text-lol-gold">Latest</span>
                </Show>
                <span class="ml-auto font-num text-[13px] text-lol-text">
                  {formatReleaseDate(release.publishedAt)}
                </span>
              </button>
              <Show when={openVersions().has(release.version)}>
                <div class="pb-3.5 pl-10 pr-4">
                  <ReleaseBody release={release} />
                </div>
              </Show>
            </div>
          </Show>
        )}
      </For>
    </div>
  );
}
