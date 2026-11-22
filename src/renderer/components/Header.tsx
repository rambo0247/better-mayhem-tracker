import { NavLink } from "react-router-dom";
import { useState, useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { useLcuStatus } from "../hooks/useLcuStatus";
import { useRecapBadge } from "../hooks/useRecapBadge";
import type { LcuStatus, SeasonSummary, UpdateInfo, UpdateNotes } from "../lib/types";
import UpdateDialog from "./UpdateDialog";
import WhatsNewDialog from "./WhatsNewDialog";
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

// macOS draws its own traffic lights into the top left of the window (see
// createWindow), so the custom controls are for every other platform, and the
// sidebar leaves the lights their space instead.
const IS_MAC = window.api.platform === "darwin";

// Below this the sidebar folds down to a rail of icons, giving the page the room
const RAIL_QUERY = "(max-width: 1179px)";

function subscribeRail(onChange: () => void) {
  const mq = window.matchMedia(RAIL_QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

function useRail() {
  return useSyncExternalStore(subscribeRail, () => window.matchMedia(RAIL_QUERY).matches);
}

type NavEntry = NavLinkDef & {
  search?: string;
  title?: string;
  badge?: ReactNode;
  onClick?: () => void;
};

function NavItem({ entry, rail, live }: { entry: NavEntry; rail: boolean; live: boolean }) {
  const { to, label, icon: Icon, search, title, badge, onClick } = entry;
  return (
    <NavLink
      to={search ? { pathname: to, search } : to}
      end={to === "/"}
      title={title ?? (rail ? label : undefined)}
      aria-label={label}
      onClick={onClick}
      className={({ isActive }) =>
        `group relative flex items-center gap-3 rounded-md text-[14px] font-medium transition-colors ${
          rail ? "h-10 w-10 justify-center" : "h-9 px-3"
        } ${
          isActive
            ? "bg-gradient-to-r from-lol-gold/22 to-lol-gold/[0.04] text-lol-text-bright"
            : "text-lol-text-bright/85 hover:bg-white/[0.05] hover:text-lol-text-bright"
        }`
      }
    >
      {({ isActive }) => (
        <>
          {isActive && (
            <span className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-r-sm bg-lol-gold shadow-[0_0_10px_rgb(212_178_115/0.7)]" />
          )}
          <Icon
            className={`h-[17px] w-[17px] shrink-0 transition-colors ${
              isActive ? "text-lol-gold" : "text-lol-text group-hover:text-lol-text-bright"
            }`}
          />
          {!rail && <span className="truncate">{label}</span>}
          {live && (
            <span
              className={`live-pulse h-2 w-2 rounded-full bg-lol-loss shadow-[0_0_8px_rgb(242_96_111/0.9)] ${
                rail ? "absolute top-2 right-2" : "ml-auto"
              }`}
            />
          )}
          {badge &&
            (rail ? (
              <span className="absolute top-2 right-2 h-1.5 w-1.5 rounded-full bg-lol-gold" />
            ) : (
              <span className="ml-auto">{badge}</span>
            ))}
        </>
      )}
    </NavLink>
  );
}

// A season that has just ended, named beside the Season Recap link until the
// recap has been opened
function RecapBadge({ season }: { season: SeasonSummary }) {
  return (
    <span className="chip h-[18px] bg-lol-gold/15 text-[11px] text-lol-gold">{season.name}</span>
  );
}

// Who's signed in, and whether the client is there to listen to. The status
// keeps role="status" so assistive tech (and the packaged-build smoke check)
// can read it.
function ClientCard({ status, rail }: { status: LcuStatus; rail: boolean }) {
  const [profile, setProfile] = useState<{
    name: string | null;
    profileIcon: number | null;
  } | null>(null);

  useEffect(() => {
    const load = () => window.api.getProfile().then(setProfile);
    load();
    return window.api.onGamesUpdated(load);
  }, []);

  const label = `League client: ${statusLabels[status]}`;
  return (
    <div
      className={`flex items-center gap-2.5 rounded-md border border-lol-line bg-black/20 ${
        rail ? "justify-center p-1.5" : "px-2.5 py-2"
      }`}
    >
      <div className="relative shrink-0">
        <SummonerIcon iconId={profile?.profileIcon ?? null} size={rail ? 30 : 32} />
        <span
          role="status"
          aria-label={label}
          title={label}
          className={`absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-lol-deep ${statusDot[status]}`}
        />
      </div>
      {!rail && (
        <div className="min-w-0 leading-tight">
          <div className="truncate text-[13px] font-semibold text-lol-text-bright">
            {profile?.name ? <RiotId id={profile.name} /> : "Summoner"}
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[12px] text-lol-text">
            {statusLabels[status] === "In Game" ? "In game" : statusLabels[status]}
          </div>
        </div>
      )}
    </div>
  );
}

function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    window.api.isWindowMaximized().then(setMaximized);
    return window.api.onMaximizedChanged(setMaximized);
  }, []);

  const btn =
    "w-11 flex items-center justify-center text-lol-text hover:bg-white/5 hover:text-lol-text-bright transition-colors";
  return (
    <div className="titlebar-no-drag flex items-stretch self-stretch">
      <button onClick={() => window.api.minimizeWindow()} title="Minimize" className={btn}>
        <MinusIcon className="w-3.5 h-3.5" />
      </button>
      <button
        onClick={() => window.api.toggleMaximizeWindow()}
        title={maximized ? "Restore" : "Maximize"}
        className={btn}
      >
        {maximized ? <RestoreIcon className="w-3 h-3" /> : <MaximizeIcon className="w-3 h-3" />}
      </button>
      <button
        onClick={() => window.api.closeWindow()}
        title="Close"
        className="w-11 flex items-center justify-center text-lol-text hover:bg-lol-loss hover:text-white transition-colors"
      >
        <XIcon className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

// The strip across the top of the page column: somewhere to drag the window by,
// and the window controls off macOS
export function TitleBar() {
  return (
    <div className="titlebar-drag relative z-10 flex h-8 shrink-0 items-center justify-end">
      {!IS_MAC && <WindowControls />}
    </div>
  );
}

export default function Header() {
  const status = useLcuStatus();
  const recapBadge = useRecapBadge();
  const hiddenLinks = useHiddenNavLinks();
  const rail = useRail();
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [showUpdateDialog, setShowUpdateDialog] = useState(false);

  // Read inside the poll instead of as an effect dep, so opening the dialog
  // doesn't restart the interval
  const dialogOpenRef = useRef(false);
  useEffect(() => {
    dialogOpenRef.current = showUpdateDialog;
  }, [showUpdateDialog]);

  useEffect(() => {
    let lastCheck = 0;
    let inFlight = false;
    const check = () => {
      // Skip while the dialog is up: swapping the release out from under an
      // in-progress download would invalidate the URL being installed
      if (inFlight || dialogOpenRef.current) return;
      inFlight = true;
      lastCheck = Date.now();
      window.api
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
  }, []);

  // The launch check installs on its own; the dialog is just there to show it
  // happening. Asked for as well as listened for, since the install can begin
  // before this window has loaded.
  const [installing, setInstalling] = useState(false);
  useEffect(() => {
    const show = (info: UpdateInfo) => {
      setUpdate(info);
      setInstalling(true);
      setShowUpdateDialog(true);
    };
    window.api.getLaunchInstall().then((info) => info && show(info));
    return window.api.onUpdateInstalling(show);
  }, []);

  const closeUpdateDialog = () => {
    setShowUpdateDialog(false);
    setInstalling(false);
  };

  const [updateNotes, setUpdateNotes] = useState<UpdateNotes | null>(null);
  useEffect(() => {
    window.api.getUpdateNotes().then(setUpdateNotes);
  }, []);

  const entries: NavEntry[] = NAV_LINKS.filter((link) => !hiddenLinks.has(link.to)).map((link) =>
    link.to === "/season" && recapBadge.season
      ? {
          ...link,
          // Straight to the season that ended, whichever one the page would
          // otherwise open on
          search: `?season=${encodeURIComponent(recapBadge.season.id)}`,
          title: `Your ${recapBadge.season.name} recap is ready to share`,
          badge: <RecapBadge season={recapBadge.season} />,
          onClick: recapBadge.dismiss,
        }
      : link,
  );

  return (
    <>
      <aside
        className={`relative z-20 flex h-full shrink-0 flex-col border-r border-lol-line bg-lol-deep/85 ${
          rail ? "w-[68px] items-center" : "w-[228px]"
        }`}
      >
        {/* The traffic lights sit in this strip on macOS; it drags the window */}
        <div className={`titlebar-drag shrink-0 ${IS_MAC ? "h-10" : "h-3"}`} />

        <header
          className={`titlebar-drag flex shrink-0 items-center gap-2.5 pb-5 ${
            rail ? "justify-center pt-1" : "px-5 pt-1"
          }`}
          title={rail ? "Better Mayhem Tracker" : undefined}
        >
          <BrandMark className="h-9 w-9 shrink-0 drop-shadow-[0_4px_12px_rgb(212_178_115/0.25)]" />
          <span
            className={`font-display italic font-extrabold uppercase leading-[0.95] tracking-[0.04em] ${
              rail ? "sr-only" : "flex flex-col text-[17px]"
            }`}
          >
            <span className="text-lol-text-bright">Better Mayhem</span>{" "}
            <span className="text-[13px] tracking-[0.26em] text-lol-gold">Tracker</span>
          </span>
        </header>

        <nav
          className={`flex min-h-0 flex-1 flex-col overflow-y-auto pb-3 ${
            rail ? "items-center gap-1 px-2" : "px-3"
          }`}
        >
          {NAV_GROUPS.map((group, i) => {
            const items = entries.filter((e) => e.group === group);
            if (items.length === 0) return null;
            return (
              <div
                key={group}
                className={rail ? "flex flex-col items-center gap-1" : i > 0 ? "pt-5" : ""}
              >
                {rail ? (
                  i > 0 && <div className="my-3 h-px w-7 bg-lol-border" />
                ) : (
                  <div className="label px-3 pb-1.5 text-[11px] text-lol-text">{group}</div>
                )}
                <div className={rail ? "flex flex-col items-center gap-1" : "space-y-0.5"}>
                  {items.map((entry) => (
                    <NavItem
                      key={entry.to}
                      entry={entry}
                      rail={rail}
                      live={entry.to === "/live" && status === "ingame"}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </nav>

        <div
          className={`shrink-0 space-y-2 border-t border-lol-line pb-3 pt-3 ${rail ? "px-2" : "px-3"}`}
        >
          {update?.hasUpdate && (
            <button
              onClick={() => setShowUpdateDialog(true)}
              title={`Update to version ${update.latest}`}
              aria-label={`Update to version ${update.latest}`}
              className={`flex w-full items-center gap-2.5 rounded-md border border-lol-gold/35 bg-lol-gold/10 text-left text-lol-gold transition-colors hover:bg-lol-gold/18 ${
                rail ? "h-10 justify-center" : "px-3 py-2"
              }`}
            >
              <DownloadIcon className="h-4 w-4 shrink-0" />
              {!rail && (
                <span className="min-w-0 leading-tight">
                  <span className="block text-[13px] font-semibold">Update available</span>
                  <span className="block text-[11px] text-lol-gold/75">
                    Version {update.latest}
                  </span>
                </span>
              )}
            </button>
          )}
          <NavLink
            to="/settings"
            title="Settings"
            aria-label="Settings"
            className={({ isActive }) =>
              `relative flex items-center gap-3 rounded-md text-[14px] font-medium transition-colors ${
                rail ? "mx-auto h-10 w-10 justify-center" : "h-9 px-3"
              } ${
                isActive
                  ? "bg-gradient-to-r from-lol-gold/22 to-lol-gold/[0.04] text-lol-text-bright"
                  : "text-lol-text-bright/85 hover:bg-white/[0.05] hover:text-lol-text-bright"
              }`
            }
          >
            {({ isActive }) => (
              <>
                {isActive && (
                  <span className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-r-sm bg-lol-gold shadow-[0_0_10px_rgb(212_178_115/0.7)]" />
                )}
                <SettingsIcon
                  className={`h-[17px] w-[17px] shrink-0 ${isActive ? "text-lol-gold" : ""}`}
                />
                {!rail && <span>Settings</span>}
              </>
            )}
          </NavLink>
          <ClientCard status={status} rail={rail} />
        </div>
      </aside>
      {showUpdateDialog && update && (
        // Keyed so a launch install taking over an open dialog starts it afresh
        <UpdateDialog
          key={installing ? "installing" : "manual"}
          update={update}
          installing={installing}
          onClose={closeUpdateDialog}
        />
      )}
      {/* An update installing right now outranks notes on the last one */}
      {updateNotes && !showUpdateDialog && (
        <WhatsNewDialog notes={updateNotes} onClose={() => setUpdateNotes(null)} />
      )}
    </>
  );
}
