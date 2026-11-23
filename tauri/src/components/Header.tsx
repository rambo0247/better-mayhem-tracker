import { createMemo, createSignal, For, onSettled, Show } from "solid-js";
import { Dynamic, type JSX } from "@solidjs/web";
import { useLinkState } from "@solidjs/router";
import { api } from "../lib/api-shim";
import { useLcuStatus } from "../hooks/useLcuStatus";
import { useRecapBadge } from "../hooks/useRecapBadge";
import type { LcuStatus, SeasonSummary, UpdateInfo } from "../lib/types";
import BrandMark from "./BrandMark";
import SummonerIcon from "./SummonerIcon";
import RiotId from "./RiotId";
import { SettingsIcon, DownloadIcon, MinusIcon, MaximizeIcon, RestoreIcon, XIcon } from "./icons";
import { NAV_GROUPS, NAV_LINKS, type NavLinkDef } from "../lib/navLinks";
import { useHiddenNavLinks } from "../hooks/useHiddenNavLinks";

// The app is often left open in the tray for days, so a launch-only check would
// never surface a release cut in the meantime. A check is one small request to
// GitHub (well inside its 60-an-hour allowance), so it can run often.
const UPDATE_POLL_MS = 45 * 60 * 1000;
// Coming back to the window checks again once the last check is this old, so a
// release shows up when the app is reopened rather than at the next poll
const UPDATE_RECHECK_ON_RETURN_MS = 10 * 60 * 1000;

const statusDot: Record<LcuStatus, string> = {
  connected: "bg-lol-win",
  ingame: "bg-sky-400",
  connecting: "bg-amber-400",
  disconnected: "bg-lol-loss",
};

const statusLabels: Record<LcuStatus, string> = {
  connected: "Connected",
  ingame: "In Game",
  connecting: "Connecting...",
  disconnected: "Disconnected",
};

// macOS draws its own traffic lights into the top left of the window, so the
// custom controls are for every other platform, and the sidebar leaves the
// lights their space instead.
const isMac = () => api.platform === "darwin";

// Below this the sidebar folds down to a rail of icons, giving the page the room
const RAIL_QUERY = "(max-width: 1179px)";

function useRail() {
  const query = window.matchMedia(RAIL_QUERY);
  const [rail, setRail] = createSignal(query.matches);
  onSettled(() => {
    const onChange = () => setRail(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  });
  return rail;
}

// Plain hash links: the webview moves the hash and the router follows it.
// The router claims no plain anchor (explicitLinks), so an `<a state>` carries
// nothing; a link that needs location state calls navigate(to, { state }).
function hashHref(path: string) {
  return `#${path}`;
}

type NavEntry = NavLinkDef & {
  search?: string;
  title?: string;
  badge?: JSX.Element;
  onClick?: () => void;
};

const ACTIVE_LINK = "bg-gradient-to-r from-lol-gold/22 to-lol-gold/[0.04] text-lol-text-bright";
const IDLE_LINK = "text-lol-text-bright/85 hover:bg-white/[0.05] hover:text-lol-text-bright";

function ActiveEdge() {
  return (
    <span class="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-r-sm bg-lol-gold shadow-[0_0_10px_rgb(212_178_115/0.7)]" />
  );
}

function NavItem(props: { entry: NavEntry; rail: boolean; live: boolean }) {
  const link = useLinkState(() => props.entry.to);
  return (
    <a
      href={hashHref(props.entry.to + (props.entry.search ?? ""))}
      title={props.entry.title ?? (props.rail ? props.entry.label : undefined)}
      aria-label={props.entry.label}
      aria-current={link.active() ? "page" : undefined}
      onClick={() => props.entry.onClick?.()}
      class={[
        "group relative flex items-center gap-3 rounded-md text-[14px] font-medium transition-colors",
        props.rail ? "h-10 w-10 justify-center" : "h-9 px-3",
        link.active() ? ACTIVE_LINK : IDLE_LINK,
      ]}
    >
      <Show when={link.active()}>
        <ActiveEdge />
      </Show>
      <Dynamic
        component={props.entry.icon}
        class={[
          "h-[17px] w-[17px] shrink-0 transition-colors",
          link.active() ? "text-lol-gold" : "text-lol-text group-hover:text-lol-text-bright",
        ]}
      />
      <Show when={!props.rail}>
        <span class="truncate">{props.entry.label}</span>
      </Show>
      <Show when={props.live}>
        <span
          class={[
            "live-pulse h-2 w-2 rounded-full bg-lol-loss shadow-[0_0_8px_rgb(242_96_111/0.9)]",
            props.rail ? "absolute top-2 right-2" : "ml-auto",
          ]}
        />
      </Show>
      <Show when={props.entry.badge}>
        <Show when={props.rail} fallback={<span class="ml-auto">{props.entry.badge}</span>}>
          <span class="absolute top-2 right-2 h-1.5 w-1.5 rounded-full bg-lol-gold" />
        </Show>
      </Show>
    </a>
  );
}

// A season that has just ended, named beside the Season Recap link until the
// recap has been opened
function RecapBadge(props: { season: SeasonSummary }) {
  return (
    <span class="chip h-[18px] bg-lol-gold/15 text-[11px] text-lol-gold">{props.season.name}</span>
  );
}

// Who's signed in, and whether the client is there to listen to. The status
// keeps role="status" so assistive tech (and the packaged-build smoke check)
// can read it.
function ClientCard(props: { status: LcuStatus; rail: boolean }) {
  const [profile, setProfile] = createSignal<{
    name: string | null;
    profileIcon: number | null;
  } | null>(null);

  onSettled(() => {
    const load = () => api.getProfile().then(setProfile);
    void load();
    return api.onGamesUpdated(load);
  });

  const label = () => `League client: ${statusLabels[props.status]}`;
  return (
    <div
      class={[
        "flex items-center gap-2.5 rounded-md border border-lol-line bg-black/20",
        props.rail ? "justify-center p-1.5" : "px-2.5 py-2",
      ]}
    >
      <div class="relative shrink-0">
        <SummonerIcon iconId={profile()?.profileIcon ?? null} size={props.rail ? 30 : 32} />
        <span
          role="status"
          aria-label={label()}
          title={label()}
          class={[
            "absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-lol-deep",
            statusDot[props.status],
          ]}
        />
      </div>
      <Show when={!props.rail}>
        <div class="min-w-0 leading-tight">
          <div class="truncate text-[13px] font-semibold text-lol-text-bright">
            <Show when={profile()?.name} fallback="Summoner">
              {(name) => <RiotId id={name()} />}
            </Show>
          </div>
          <div class="mt-0.5 flex items-center gap-1.5 text-[12px] text-lol-text">
            {statusLabels[props.status] === "In Game" ? "In game" : statusLabels[props.status]}
          </div>
        </div>
      </Show>
    </div>
  );
}

function WindowControls() {
  const [maximized, setMaximized] = createSignal(false);

  onSettled(() => {
    void api.isWindowMaximized().then(setMaximized);
    return api.onMaximizedChanged(setMaximized);
  });

  const btn =
    "w-11 flex items-center justify-center text-lol-text hover:bg-white/5 hover:text-lol-text-bright transition-colors";
  return (
    <div data-tauri-drag-region="false" class="titlebar-no-drag flex items-stretch self-stretch">
      <button onClick={() => api.minimizeWindow()} title="Minimize" class={btn}>
        <MinusIcon class="w-3.5 h-3.5" />
      </button>
      <button
        onClick={() => api.toggleMaximizeWindow()}
        title={maximized() ? "Restore" : "Maximize"}
        class={btn}
      >
        <Show when={maximized()} fallback={<MaximizeIcon class="w-3 h-3" />}>
          <RestoreIcon class="w-3 h-3" />
        </Show>
      </button>
      <button
        onClick={() => api.closeWindow()}
        title="Close"
        class="w-11 flex items-center justify-center text-lol-text hover:bg-lol-loss hover:text-white transition-colors"
      >
        <XIcon class="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

// The strip across the top of the page column: somewhere to drag the window by,
// and the window controls off macOS
export function TitleBar() {
  return (
    <div
      data-tauri-drag-region="deep"
      class="titlebar-drag relative z-10 flex h-8 shrink-0 items-center justify-end"
    >
      <Show when={!isMac()}>
        <WindowControls />
      </Show>
    </div>
  );
}

function SettingsLink(props: { rail: boolean }) {
  const link = useLinkState(() => "/settings");
  return (
    <a
      href={hashHref("/settings")}
      title="Settings"
      aria-label="Settings"
      aria-current={link.active() ? "page" : undefined}
      class={[
        "relative flex items-center gap-3 rounded-md text-[14px] font-medium transition-colors",
        props.rail ? "mx-auto h-10 w-10 justify-center" : "h-9 px-3",
        link.active() ? ACTIVE_LINK : IDLE_LINK,
      ]}
    >
      <Show when={link.active()}>
        <ActiveEdge />
      </Show>
      <SettingsIcon class={["h-[17px] w-[17px] shrink-0", { "text-lol-gold": link.active() }]} />
      <Show when={!props.rail}>
        <span>Settings</span>
      </Show>
    </a>
  );
}

export default function Header() {
  const status = useLcuStatus();
  const recapBadge = useRecapBadge();
  const hiddenLinks = useHiddenNavLinks();
  const rail = useRail();
  const [update, setUpdate] = createSignal<UpdateInfo | null>(null);

  onSettled(() => {
    let lastCheck = 0;
    let inFlight = false;
    const check = () => {
      if (inFlight) return;
      inFlight = true;
      lastCheck = Date.now();
      void api
        .checkForUpdate()
        .then((info) => {
          // A failed poll shouldn't clear a badge an earlier check earned
          setUpdate((prev) => (info.error && prev ? prev : info));
        })
        .finally(() => {
          inFlight = false;
        });
    };
    // Reopening the window from the tray, or switching back to it
    const onReturn = () => {
      if (
        document.visibilityState !== "hidden" &&
        Date.now() - lastCheck > UPDATE_RECHECK_ON_RETURN_MS
      ) {
        check();
      }
    };

    check();
    const timer = setInterval(check, UPDATE_POLL_MS);
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onReturn);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onReturn);
      document.removeEventListener("visibilitychange", onReturn);
    };
  });

  const entries = createMemo(() =>
    NAV_LINKS.filter((link) => !hiddenLinks().has(link.to)).map((link): NavEntry => {
      const season = recapBadge.season();
      return link.to === "/season" && season
        ? {
            ...link,
            // Straight to the season that ended, whichever one the page would
            // otherwise open on
            search: `?season=${encodeURIComponent(season.id)}`,
            title: `Your ${season.name} recap is ready to share`,
            badge: <RecapBadge season={season} />,
            onClick: recapBadge.dismiss,
          }
        : link;
    }),
  );

  const groups = createMemo(() =>
    NAV_GROUPS.map((group) => ({
      group,
      items: entries().filter((e) => e.group === group),
    })).filter((g) => g.items.length > 0),
  );

  return (
    <aside
      class={[
        "relative z-20 flex h-full shrink-0 flex-col border-r border-lol-line bg-lol-deep/85",
        rail() ? "w-[68px] items-center" : "w-[228px]",
      ]}
    >
      {/* The traffic lights sit in this strip on macOS; it drags the window */}
      <div
        data-tauri-drag-region="deep"
        class={["titlebar-drag shrink-0", isMac() ? "h-10" : "h-3"]}
      />

      <header
        data-tauri-drag-region="deep"
        class={[
          "titlebar-drag flex shrink-0 items-center gap-2.5 pb-5",
          rail() ? "justify-center pt-1" : "px-5 pt-1",
        ]}
        title={rail() ? "Better Mayhem Tracker" : undefined}
      >
        <BrandMark class="h-9 w-9 shrink-0 drop-shadow-[0_4px_12px_rgb(212_178_115/0.25)]" />
        <span
          class={[
            "font-display italic font-extrabold uppercase leading-[0.95] tracking-[0.04em]",
            rail() ? "sr-only" : "flex flex-col text-[17px]",
          ]}
        >
          <span class="text-lol-text-bright">Better Mayhem</span>{" "}
          <span class="text-[13px] tracking-[0.26em] text-lol-gold">Tracker</span>
        </span>
      </header>

      <nav
        class={[
          "flex min-h-0 flex-1 scroll-py-2 flex-col overflow-y-auto pb-3",
          rail() ? "items-center gap-1 px-2" : "px-3",
        ]}
      >
        <For each={groups()} keyed={(g) => g.group}>
          {(group, i) => (
            <div class={rail() ? "flex flex-col items-center gap-1" : i() > 0 ? "pt-5" : ""}>
              <Show
                when={rail()}
                fallback={
                  <div class="label px-3 pb-1.5 text-[11px] text-lol-text">{group().group}</div>
                }
              >
                <Show when={i() > 0}>
                  <div class="my-3 h-px w-7 bg-lol-border" />
                </Show>
              </Show>
              <div class={rail() ? "flex flex-col items-center gap-1" : "space-y-0.5"}>
                <For each={group().items} keyed={(entry) => entry.to}>
                  {(entry) => (
                    <NavItem
                      entry={entry()}
                      rail={rail()}
                      live={entry().to === "/live" && status() === "ingame"}
                    />
                  )}
                </For>
              </div>
            </div>
          )}
        </For>
      </nav>

      <div
        class={["shrink-0 space-y-2 border-t border-lol-line pb-3 pt-3", rail() ? "px-2" : "px-3"]}
      >
        <Show when={update()?.hasUpdate ? update() : null}>
          {(info) => (
            <button
              title={`Update to version ${info().latest}`}
              aria-label={`Update to version ${info().latest}`}
              class={[
                "flex w-full items-center gap-2.5 rounded-md border border-lol-gold/35 bg-lol-gold/10 text-left text-lol-gold transition-colors hover:bg-lol-gold/18",
                rail() ? "h-10 justify-center" : "px-3 py-2",
              ]}
            >
              <DownloadIcon class="h-4 w-4 shrink-0" />
              <Show when={!rail()}>
                <span class="min-w-0 leading-tight">
                  <span class="block text-[13px] font-semibold">Update available</span>
                  <span class="block text-[11px] text-lol-gold/75">Version {info().latest}</span>
                </span>
              </Show>
            </button>
          )}
        </Show>
        <SettingsLink rail={rail()} />
        <ClientCard status={status()} rail={rail()} />
      </div>
    </aside>
  );
}
