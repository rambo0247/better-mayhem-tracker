import { useState, useEffect, useCallback, type ReactNode, type SVGProps } from "react";
import PageHeader from "../components/PageHeader";
import BrandMark from "../components/BrandMark";
import { DownloadIcon, RefreshIcon } from "../components/icons";
import {
  SlidersIcon,
  PanelLeftIcon,
  DatabaseIcon,
  ArchiveIcon,
  WrenchIcon,
  InfoIcon,
  UploadIcon,
  HistoryIcon,
  FolderOpenIcon,
  ExternalLinkIcon,
  GithubIcon,
  LockIcon,
} from "../components/SettingsIcons";
import { useBackfill } from "../hooks/useBackfill";
import { queueLabel } from "../components/QueueSelect";
import { LOCALE, formatDecimal, formatShortDate, formatDateTime } from "../lib/format";
import { setRemembering } from "../lib/viewState";
import { NAV_LINKS, HOME_PATH, toggleNavLink } from "../lib/navLinks";
import { useHiddenNavLinks } from "../hooks/useHiddenNavLinks";
import type { BackupInfo, ImportProgress } from "../lib/types";
import {
  DEFAULT_SESSION_GROUPING,
  SESSION_GROUPING_SETTING,
  parseSessionGrouping,
  type SessionGrouping,
} from "../../shared/session";

const REPO_URL = "https://github.com/rambo0247/better-mayhem-tracker";

const IS_MAC = window.api.platform === "darwin";
// Why the auto-start and auto-update switches are off: a dev build has no
// copy of itself to register or replace, and on macOS neither does an app run
// straight from a disk image or Downloads
const NOT_INSTALLED_NOTE = IS_MAC
  ? " Only available once the app is in your Applications folder."
  : " Only available in the packaged program.";

// The same, short enough to sit beside the switch
const NOT_INSTALLED_SHORT = IS_MAC ? "Needs the app in Applications" : "Packaged program only";

const SESSION_GROUPING_OPTIONS: { value: SessionGrouping; label: string }[] = [
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "patch", label: "Patch" },
  { value: "none", label: "Don't group" },
];

const BACKUP_REASONS: Record<string, string> = {
  auto: "Scheduled",
  manual: "Manual",
  "pre-import": "Before import",
  "pre-repair": "Before repair",
  "pre-restore": "Before restore",
};

function formatSize(bytes: number): string {
  return `${formatDecimal(bytes / 1024 / 1024)} MB`;
}

// A backup's date the way the rest of the app writes dates, with the time,
// since several can be taken on one day
function formatTaken(timestamp: number): string {
  return `${formatShortDate(timestamp)}, ${new Date(timestamp).toLocaleTimeString(LOCALE, {
    hour: "numeric",
    minute: "2-digit",
  })}`;
}

function formatHistoryStart(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString(LOCALE, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// A crisp-cornered switch in the toolbar's language: a dark outlined trough
// with a muted knob when off, gold with a dark knob when on. A switch held on
// (the home page, the last queue) reads as on, in dimmed gold with a lock in
// the knob; one that is `unavailable` here fades right back with a lock beside
// it. Either way `lockedNote` says why as a tooltip, and `shortNote` in a few
// words beside it.
function Switch({
  checked,
  onChange,
  disabled = false,
  label,
  lockedNote,
  shortNote,
  unavailable = false,
}: {
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
  label?: string;
  lockedNote?: string;
  // The reason in a few words, shown beside the switch while it can't be flipped
  shortNote?: string;
  // Can't be used here at all, rather than held in place
  unavailable?: boolean;
}) {
  const lockedOn = disabled && checked && !unavailable;
  return (
    <span
      className="inline-flex shrink-0 items-center gap-2"
      title={disabled ? lockedNote : undefined}
    >
      {disabled && (shortNote || !lockedOn) && (
        <span className="flex items-center gap-1.5 text-[13px] text-lol-text">
          <LockIcon className="h-4 w-4 shrink-0" aria-hidden />
          {shortNote}
        </span>
      )}
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={onChange}
        className={`relative inline-flex h-[22px] w-10 shrink-0 rounded-md border transition-colors duration-200 ${
          disabled ? "cursor-not-allowed" : "cursor-pointer"
        } ${lockedOn ? "opacity-60" : disabled ? "opacity-40" : ""} ${
          checked
            ? "border-lol-gold bg-gradient-to-b from-[#e2c487] to-lol-gold"
            : `border-[#3a4680] bg-[#1a2247] ${disabled ? "" : "hover:border-[#4d5a9c] hover:bg-[#1f2853]"}`
        }`}
      >
        <span
          className={`pointer-events-none absolute top-[2px] left-[2px] flex h-4 w-4 items-center justify-center rounded-sm transition-transform duration-200 ease-snap ${
            checked
              ? "translate-x-[18px] bg-[#1a1407] text-lol-gold shadow-[0_1px_2px_rgb(0_0_0/0.4)]"
              : "translate-x-0 bg-[#8a90b0] shadow-[0_1px_2px_rgb(0_0_0/0.45)]"
          }`}
        ></span>
      </button>
    </span>
  );
}

type SectionId =
  | "general"
  | "sidebar"
  | "updates"
  | "data"
  | "backups"
  | "troubleshooting"
  | "about";

type IconComponent = (props: SVGProps<SVGSVGElement>) => ReactNode;

const SECTIONS: { id: SectionId; title: string; icon: IconComponent }[] = [
  { id: "general", title: "General", icon: SlidersIcon },
  { id: "sidebar", title: "Sidebar", icon: PanelLeftIcon },
  { id: "updates", title: "Updates", icon: DownloadIcon },
  { id: "data", title: "Match Data", icon: DatabaseIcon },
  { id: "backups", title: "Backups", icon: ArchiveIcon },
  { id: "troubleshooting", title: "Troubleshooting", icon: WrenchIcon },
  { id: "about", title: "About", icon: InfoIcon },
];

const sectionDomId = (id: SectionId) => `settings-${id}`;

// One card of settings: a header strip naming the group, then its rows split
// by hairlines
function Section({
  id,
  actions,
  children,
}: {
  id: SectionId;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const { title, icon: Icon } = SECTIONS.find((s) => s.id === id)!;
  return (
    <section id={sectionDomId(id)} className="panel scroll-mt-4 overflow-hidden">
      <header className="panel-head gap-3 px-5">
        <span className="flex h-7 w-7 items-center justify-center rounded-md bg-lol-gold/10 text-lol-gold">
          <Icon className="h-4 w-4" />
        </span>
        <h2 className="section-title">{title}</h2>
        {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
      </header>
      <div className="divide-y divide-lol-line">{children}</div>
    </section>
  );
}

// A setting: what it is and what it does on the left, its control on the right,
// and room underneath for anything it reports back
function Row({
  title,
  description,
  control,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  control?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="px-5 py-4">
      <div className="flex items-center justify-between gap-10">
        <div className="min-w-0 max-w-[600px]">
          <p className="text-[14px] font-semibold leading-5 text-lol-text-bright">{title}</p>
          {description && (
            <p className="mt-1 text-[13px] leading-[1.5] text-lol-text">{description}</p>
          )}
        </div>
        {control && <div className="flex shrink-0 items-center gap-2">{control}</div>}
      </div>
      {children}
    </div>
  );
}

// The line a data action leaves behind: how far it has got while it runs, then
// how it went
function Status({ text, running = false }: { text: string | null; running?: boolean }) {
  if (!text) return null;
  const failed = text.startsWith("Error");
  return (
    <p
      className={`mt-3 flex items-start gap-2.5 rounded-md border px-3 py-2 text-[13px] leading-[1.45] ${
        failed
          ? "border-lol-loss/30 bg-lol-loss/[0.07] text-lol-loss"
          : "border-lol-line bg-black/20 text-lol-text-bright/90"
      }`}
    >
      <span
        className={`mt-[6px] h-1.5 w-1.5 shrink-0 rounded-full ${
          failed ? "bg-lol-loss" : running ? "live-pulse bg-lol-gold" : "bg-lol-win"
        }`}
      />
      <span className="min-w-0 break-words">{text}</span>
    </p>
  );
}

export default function Settings() {
  // Shared so a backfill started automatically on first connect shows here too
  const { running: backfilling, progress } = useBackfill();
  const hiddenNavLinks = useHiddenNavLinks();
  const [autoStart, setAutoStart] = useState(false);
  // Only the packaged program has a durable exe to register at sign-in or to
  // swap for a new version, so those switches say so instead of pretending in a
  // dev build
  const [packaged, setPackaged] = useState(false);
  const [autoUpdate, setAutoUpdate] = useState(true);
  const [showReleaseNotes, setShowReleaseNotes] = useState(true);
  const [minimizeToTray, setMinimizeToTray] = useState(true);
  // Every queue with games stored, and the subset the user has switched off
  const [queues, setQueues] = useState<number[]>([]);
  const [hiddenQueues, setHiddenQueues] = useState<Set<number>>(new Set());
  const [hideRemakes, setHideRemakes] = useState(false);
  const [sessionGrouping, setSessionGrouping] = useState<SessionGrouping>(DEFAULT_SESSION_GROUPING);
  const [autoBackup, setAutoBackup] = useState(true);
  const [rememberFilters, setRememberFilters] = useState(false);
  const [version, setVersion] = useState("");
  const [loading, setLoading] = useState(true);
  const [exportStatus, setExportStatus] = useState<string | null>(null);
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(null);
  const [repairStatus, setRepairStatus] = useState<string | null>(null);
  const [backfillStatus, setBackfillStatus] = useState<string | null>(null);
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [backupStatus, setBackupStatus] = useState<string | null>(null);
  const [backupBusy, setBackupBusy] = useState(false);
  // Restoring replaces the whole database, so the row asks a second time
  const [confirmRestore, setConfirmRestore] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      window.api.getSetting("auto_start"),
      window.api.isAutoStartSupported(),
      window.api.getSetting("minimize_to_tray"),
      window.api.getSetting("hidden_queues"),
      window.api.getSetting("hide_remakes"),
      window.api.getSetting("auto_backup"),
      window.api.getSetting("remember_filters"),
      window.api.getSetting(SESSION_GROUPING_SETTING),
      window.api.getVersion(),
      window.api.getSetting("auto_update"),
      window.api.getSetting("show_release_notes"),
    ]).then(
      ([
        startup,
        isPackaged,
        tray,
        hidden,
        remakes,
        backup,
        remember,
        grouping,
        v,
        update,
        notes,
      ]) => {
        setAutoStart(startup === "true");
        setPackaged(isPackaged);
        setAutoUpdate(update !== "false");
        setShowReleaseNotes(notes !== "false");
        setMinimizeToTray(tray !== "false");
        setHiddenQueues(new Set(hidden ? hidden.split(",").map(Number) : []));
        setHideRemakes(remakes === "true");
        setAutoBackup(backup !== "false");
        setRememberFilters(remember === "true");
        setSessionGrouping(parseSessionGrouping(grouping));
        setVersion(v);
        setLoading(false);
      },
    );
  }, []);

  // Kept current the same way the queue dropdown is: a game from a queue that
  // wasn't in the database yet adds a switch for it without a reload.
  useEffect(() => {
    const fetchQueues = () => window.api.getStoredQueues().then(setQueues);
    fetchQueues();
    return window.api.onGamesUpdated(fetchQueues);
  }, []);

  const refreshBackups = useCallback(() => {
    window.api.listBackups().then(setBackups);
  }, []);

  useEffect(refreshBackups, [refreshBackups]);

  // Every switch on this page flips one boolean setting and writes it back, so
  // they share one handler. `also` is for the two that have somewhere else to
  // be: auto_start is acted on by the main process, remember_filters by the
  // pages already mounted.
  const toggle =
    (
      key: string,
      value: boolean,
      setValue: (next: boolean) => void,
      also?: (next: boolean) => void,
    ) =>
    async () => {
      const next = !value;
      setValue(next);
      also?.(next);
      await window.api.setSetting(key, String(next));
    };

  const handleQueueToggle = useCallback(
    async (queueId: number) => {
      const next = new Set(hiddenQueues);
      if (!next.delete(queueId)) next.add(queueId);
      setHiddenQueues(next);
      await window.api.setSetting("hidden_queues", [...next].join(","));
    },
    [hiddenQueues],
  );

  const handleSessionGroupingChange = useCallback(async (next: SessionGrouping) => {
    setSessionGrouping(next);
    await window.api.setSetting(SESSION_GROUPING_SETTING, next);
  }, []);

  const handleBackupNow = useCallback(async () => {
    setBackupBusy(true);
    setBackupStatus(null);
    try {
      const result = await window.api.createBackup();
      setBackupStatus(
        result.success
          ? `Backed up ${result.backup?.games?.toLocaleString(LOCALE)} game(s)`
          : `Error: ${result.error ?? "backup failed"}`,
      );
      refreshBackups();
    } catch (err: any) {
      setBackupStatus(`Error: ${err.message}`);
    } finally {
      setBackupBusy(false);
    }
  }, [refreshBackups]);

  const handleRestore = useCallback(
    async (file: string) => {
      setConfirmRestore(null);
      setBackupBusy(true);
      setBackupStatus(null);
      try {
        const result = await window.api.restoreBackup(file);
        setBackupStatus(
          result.success
            ? `Restored ${result.games?.toLocaleString(LOCALE)} game(s) from ${file}`
            : `Error: ${result.error ?? "restore failed"}`,
        );
        refreshBackups();
      } catch (err: any) {
        setBackupStatus(`Error: ${err.message}`);
      } finally {
        setBackupBusy(false);
      }
    },
    [refreshBackups],
  );

  const handleExport = useCallback(async () => {
    setExportStatus(null);
    try {
      const result = await window.api.exportData();
      if (result.success) {
        setExportStatus(
          `Exported ${result.games?.toLocaleString(LOCALE)} game(s) to ${result.path}`,
        );
      } else {
        // No error means the file dialog was dismissed, which needs no message
        setExportStatus(result.error ? `Error: ${result.error}` : null);
      }
    } catch (err: any) {
      setExportStatus(`Error: ${err.message}`);
    }
  }, []);

  useEffect(() => window.api.onImportProgress(setImportProgress), []);

  const handleImport = useCallback(async () => {
    setImportStatus(null);
    setImporting(true);
    try {
      const result = await window.api.importData();
      if (result.success) {
        setImportStatus(`Imported ${result.imported?.toLocaleString(LOCALE)} new game(s)`);
      } else {
        setImportStatus(result.error ? `Error: ${result.error}` : null);
      }
      // An import takes a snapshot on its way in
      refreshBackups();
    } catch (err: any) {
      setImportStatus(`Error: ${err.message}`);
    } finally {
      setImporting(false);
      setImportProgress(null);
    }
  }, [refreshBackups]);

  // Like the backfill line: how far the import has got while it runs, then the
  // outcome
  const importLine =
    importing && importProgress
      ? `Importing game ${importProgress.current.toLocaleString(LOCALE)} of ${importProgress.total.toLocaleString(LOCALE)}, ${importProgress.imported.toLocaleString(LOCALE)} new so far`
      : importStatus;

  // A run in progress reports how far it has got; the outcome takes over once
  // it is done
  const backfillLine = progress
    ? progress.total === 0
      ? "Nothing new to check"
      : `Checking game ${progress.current.toLocaleString(LOCALE)} of ${progress.total.toLocaleString(LOCALE)}, ${progress.added.toLocaleString(LOCALE)} added so far`
    : backfillStatus;

  const handleBackfill = useCallback(async () => {
    setBackfillStatus("Fetching your match list from Riot...");
    try {
      const result = await window.api.backfillHistory();
      if ("error" in result) {
        setBackfillStatus(`Error: ${result.error}`);
      } else {
        const summary =
          result.added > 0
            ? `Added ${result.added.toLocaleString(LOCALE)} game(s) from ${result.scanned.toLocaleString(LOCALE)} found in your Riot history`
            : `No new Mayhem games found (${result.scanned.toLocaleString(LOCALE)} games checked)`;
        setBackfillStatus(
          result.cancelled
            ? `Stopped after adding ${result.added.toLocaleString(LOCALE)} game(s). Run it again to finish.`
            : result.limit?.kind === "service"
              ? `${summary}. Riot's match history for this account only goes back to ${formatHistoryStart(result.limit.historyStart)}, so older games can't be imported, but every new game from here on is kept.`
              : result.limit?.kind === "paging"
                ? `${summary}. Stopped at the ${result.scanned.toLocaleString(LOCALE)}-game paging limit, so anything older was not checked.`
                : summary,
        );
      }
    } catch (err: any) {
      setBackfillStatus(`Error: ${err.message}`);
    }
  }, []);

  const handleRepair = useCallback(async () => {
    setRepairStatus(null);
    try {
      const result = await window.api.repairPuuids();
      setRepairStatus(
        `Repaired ${result.repairedGames.toLocaleString(LOCALE)} game(s), found ${result.discoveredAccounts} account(s), rebuilt stats and scores for ${result.rebuiltGames.toLocaleString(LOCALE)} game(s)`,
      );
      // A repair takes a snapshot on its way in
      refreshBackups();
    } catch (err: any) {
      setRepairStatus(`Error: ${err.message}`);
    }
  }, [refreshBackups]);

  if (loading) return null;

  const shownQueueCount = queues.filter((id) => !hiddenQueues.has(id)).length;

  return (
    <div className="max-w-[1320px]">
      <PageHeader
        kicker="App"
        title="Settings"
        subtitle="How the tracker runs, what it shows, and where your match data lives"
      />

      <div className="xl:grid xl:grid-cols-[200px_minmax(0,1fr)] xl:items-start xl:gap-8">
        <SectionNav />

        <div className="space-y-6">
          <Section id="general">
            <Row
              title={IS_MAC ? "Open at login" : "Start with Windows"}
              description={
                <>
                  Open the program in the {IS_MAC ? "menu bar" : "system tray"} when you sign in to{" "}
                  {IS_MAC ? "your Mac" : "Windows"}, so your games are recorded without having to
                  remember to start it.
                  {!packaged && NOT_INSTALLED_NOTE}
                </>
              }
              control={
                <Switch
                  label={IS_MAC ? "Open at login" : "Start with Windows"}
                  checked={autoStart}
                  onChange={toggle("auto_start", autoStart, setAutoStart)}
                  disabled={!packaged}
                  lockedNote={NOT_INSTALLED_NOTE.trim()}
                  unavailable
                  shortNote={NOT_INSTALLED_SHORT}
                />
              }
            />
            <Row
              title={IS_MAC ? "Keep running in the menu bar on close" : "Minimize to tray on close"}
              description={
                <>
                  When enabled, the program can keep storing your games even when the window is
                  closed. You can still close the program from the{" "}
                  {IS_MAC ? "menu bar icon or with ⌘Q" : "system tray"}.
                </>
              }
              control={
                <Switch
                  label={
                    IS_MAC ? "Keep running in the menu bar on close" : "Minimize to tray on close"
                  }
                  checked={minimizeToTray}
                  onChange={toggle("minimize_to_tray", minimizeToTray, setMinimizeToTray)}
                />
              }
            />
            <Row
              title="Remember filters and sorting"
              description="Reopen every page with the filters, search, and sort order you last used. When off, each page starts on its defaults again every time the program opens."
              control={
                <Switch
                  label="Remember filters and sorting"
                  checked={rememberFilters}
                  onChange={toggle(
                    "remember_filters",
                    rememberFilters,
                    setRememberFilters,
                    setRemembering,
                  )}
                />
              }
            />
            <Row
              title="Hide remakes"
              description="Leave remade games out of the match history. They are still recorded, and were never counted toward your stats either way."
              control={
                <Switch
                  label="Hide remakes"
                  checked={hideRemakes}
                  onChange={toggle("hide_remakes", hideRemakes, setHideRemakes)}
                />
              }
            />
            <Row
              title="Group match history by"
              description="Break the match list into sessions, each under a heading with its own record and averages. Days start at 5am."
              control={
                <select
                  className="select w-[148px]"
                  aria-label="Group match history by"
                  value={sessionGrouping}
                  onChange={(e) => handleSessionGroupingChange(e.target.value as SessionGrouping)}
                >
                  {SESSION_GROUPING_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              }
            />
            {/* A single queue has nothing to choose between, so the whole block
                waits until a second one shows up in the database */}
            {queues.length > 1 && (
              <Row
                title="Queues to include"
                description="Stats and match history only count the queues switched on here. Games from the others are still recorded, and can be counted again by switching their queue back on."
              >
                <div className="mt-3 divide-y divide-lol-line overflow-hidden rounded-lg border border-lol-line bg-black/15">
                  {queues.map((q) => {
                    const shown = !hiddenQueues.has(q);
                    return (
                      <div key={q} className="flex h-11 items-center justify-between gap-6 px-4">
                        <span
                          className={`text-[14px] font-medium ${shown ? "text-lol-text-bright" : "text-lol-text"}`}
                        >
                          {queueLabel(q)}
                        </span>
                        {/* Switching off the last one would empty every page */}
                        <Switch
                          label={queueLabel(q)}
                          checked={shown}
                          disabled={shown && shownQueueCount === 1}
                          lockedNote="At least one queue has to stay on"
                          shortNote="Last one on"
                          onChange={() => handleQueueToggle(q)}
                        />
                      </div>
                    );
                  })}
                </div>
              </Row>
            )}
          </Section>

          <Section id="sidebar">
            <Row
              title="Pages in the sidebar"
              description="Switch off the pages you never visit. A hidden page keeps recording, and Match History always stays since it's where the app opens."
            >
              <div className="mt-4 grid gap-2 sm:grid-cols-2">
                {NAV_LINKS.map(({ to, label, icon: Icon }) => {
                  const shown = !hiddenNavLinks.has(to);
                  return (
                    <div
                      key={to}
                      className={`flex h-12 items-center gap-3 rounded-lg border px-3 transition-colors ${
                        shown
                          ? "border-lol-line bg-white/[0.025]"
                          : "border-dashed border-lol-border/70 bg-transparent"
                      }`}
                    >
                      <span
                        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors ${
                          shown
                            ? "bg-lol-gold/10 text-lol-gold"
                            : "bg-white/[0.04] text-lol-text/75"
                        }`}
                      >
                        <Icon className="h-4 w-4" />
                      </span>
                      <span
                        className={`min-w-0 flex-1 truncate text-[14px] font-medium ${
                          shown ? "text-lol-text-bright" : "text-lol-text"
                        }`}
                      >
                        {label}
                      </span>
                      <Switch
                        label={label}
                        checked={shown}
                        disabled={to === HOME_PATH}
                        lockedNote="Match History is where the app opens, so it always stays"
                        shortNote="Always shown"
                        onChange={() => toggleNavLink(to)}
                      />
                    </div>
                  );
                })}
              </div>
            </Row>
          </Section>

          <Section id="updates">
            <Row
              title="Install updates automatically"
              description={
                <>
                  Install new versions on their own: when the program starts, and while it sits in
                  the tray or minimized. Never while you're using it, in champion select or in a
                  game. When it's off, new versions show up in the sidebar to install yourself.
                  {!packaged && NOT_INSTALLED_NOTE}
                </>
              }
              control={
                <Switch
                  label="Install updates automatically"
                  checked={autoUpdate}
                  onChange={toggle("auto_update", autoUpdate, setAutoUpdate)}
                  disabled={!packaged}
                  lockedNote={NOT_INSTALLED_NOTE.trim()}
                  unavailable
                  shortNote={NOT_INSTALLED_SHORT}
                />
              }
            />
            <Row
              title="Show what's new after updating"
              description="Open the release notes for the versions you just got the first time the program starts on a new version."
              control={
                <Switch
                  label="Show what's new after updating"
                  checked={showReleaseNotes}
                  onChange={toggle("show_release_notes", showReleaseNotes, setShowReleaseNotes)}
                />
              }
            />
          </Section>

          <Section id="data">
            <Row
              title="Backfill match history"
              description="Pull your older Mayhem games from Riot and add any that aren't stored yet. This runs automatically the first time an account connects; use this to run it again, or to finish an import you cancelled."
              control={
                <button onClick={handleBackfill} disabled={backfilling} className="btn w-[124px]">
                  <RefreshIcon className={`h-4 w-4 ${backfilling ? "animate-spin" : ""}`} />
                  {backfilling ? "Working..." : "Backfill"}
                </button>
              }
            >
              <Status text={backfillLine} running={backfilling} />
            </Row>
            <Row
              title="Export data"
              description="Save all match data to a JSON file for backup"
              control={
                <button onClick={handleExport} className="btn w-[124px]">
                  <UploadIcon className="h-4 w-4" />
                  Export
                </button>
              }
            >
              <Status text={exportStatus} />
            </Row>
            <Row
              title="Import data"
              description="Load match data from a previously exported file"
              control={
                <button onClick={handleImport} disabled={importing} className="btn w-[124px]">
                  <DownloadIcon className="h-4 w-4" />
                  {importing ? "Working..." : "Import"}
                </button>
              }
            >
              <Status text={importLine} running={importing} />
            </Row>
            <Row
              title="Repair account data"
              description="Re-detect which accounts are yours by analyzing game history, then rebuild stored stats, augments, and performance scores from the raw game data. Use this if games are attributed to the wrong account or scores look stale."
              control={
                <button onClick={handleRepair} className="btn w-[124px]">
                  <WrenchIcon className="h-4 w-4" />
                  Repair
                </button>
              }
            >
              <Status text={repairStatus} />
            </Row>
          </Section>

          <Section
            id="backups"
            actions={
              <>
                <button
                  onClick={() => window.api.openBackupFolder()}
                  className="btn btn-sm btn-ghost"
                >
                  <FolderOpenIcon className="h-3.5 w-3.5" />
                  Open folder
                </button>
                <button onClick={handleBackupNow} disabled={backupBusy} className="btn btn-sm">
                  <ArchiveIcon className="h-3.5 w-3.5" />
                  {backupBusy ? "Working..." : "Back up now"}
                </button>
              </>
            }
          >
            <Row
              title="Automatic backups"
              description="Keep a daily copy of your database on this computer, plus one before any import or repair. Older copies thin out to weekly and monthly. If the database ever goes missing or won't open, the newest working copy is restored on startup."
              control={
                <Switch
                  label="Automatic backups"
                  checked={autoBackup}
                  onChange={toggle("auto_backup", autoBackup, setAutoBackup)}
                />
              }
            >
              <Status text={backupStatus} running={backupBusy} />
            </Row>

            <div>
              <div className="flex items-center gap-2 bg-black/15 px-5 py-2.5">
                <span className="label">Saved copies</span>
                <span className="font-num text-[13px] text-lol-text">{backups.length}</span>
              </div>
              {backups.length === 0 ? (
                <p className="border-t border-lol-line px-5 py-4 text-[13px] text-lol-text">
                  No backups yet.
                </p>
              ) : (
                backups.map((backup) => (
                  <div
                    key={backup.file}
                    className={`flex min-h-[56px] items-center gap-4 border-t border-lol-line px-5 py-2.5 transition-colors ${
                      confirmRestore === backup.file
                        ? "bg-lol-loss/[0.05]"
                        : "hover:bg-white/[0.02]"
                    }`}
                  >
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-white/[0.04] text-lol-text">
                      <HistoryIcon className="h-4 w-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p
                        className="font-num text-[15px] font-semibold leading-5 text-lol-text-bright"
                        title={formatDateTime(backup.created)}
                      >
                        {formatTaken(backup.created)}
                      </p>
                      <p className="mt-0.5 flex items-center gap-1.5 text-[13px] text-lol-text">
                        <span>{BACKUP_REASONS[backup.reason] ?? backup.reason}</span>
                        <span className="text-lol-text/50">·</span>
                        {backup.games === null ? (
                          <span className="text-lol-loss">unreadable</span>
                        ) : (
                          <span className="font-num text-[13px]">
                            {backup.games.toLocaleString(LOCALE)} games
                          </span>
                        )}
                        <span className="text-lol-text/50">·</span>
                        <span className="font-num text-[13px]">{formatSize(backup.size)}</span>
                      </p>
                    </div>
                    {confirmRestore === backup.file ? (
                      <div className="flex shrink-0 items-center gap-2">
                        <span className="mr-1 text-[13px] text-lol-text-bright">
                          Replace current data?
                        </span>
                        <button
                          onClick={() => setConfirmRestore(null)}
                          className="btn btn-sm btn-ghost"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={() => handleRestore(backup.file)}
                          disabled={backupBusy}
                          className="btn btn-sm btn-danger"
                        >
                          Restore
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setConfirmRestore(backup.file)}
                        disabled={backupBusy || backup.games === null}
                        className="btn btn-sm shrink-0"
                      >
                        Restore
                      </button>
                    )}
                  </div>
                ))
              )}
            </div>
          </Section>

          <Section id="troubleshooting">
            <Row
              title="Log file"
              description="A record of what the program does in the background, like connecting to the client and recording games. If something goes wrong, main.log is the file to attach to a bug report."
              control={
                <button onClick={() => window.api.openLogsFolder()} className="btn w-[124px]">
                  <FolderOpenIcon className="h-4 w-4" />
                  Open folder
                </button>
              }
            />
          </Section>

          <Section id="about">
            <div className="flex flex-wrap items-center justify-between gap-6 px-5 py-5">
              <div className="flex items-center gap-4">
                <BrandMark className="h-12 w-12 shrink-0 drop-shadow-[0_4px_14px_rgb(212_178_115/0.25)]" />
                <div>
                  <p className="font-display text-[20px] font-extrabold uppercase italic leading-none tracking-[0.03em] text-lol-text-bright">
                    Better Mayhem Tracker
                  </p>
                  <p className="mt-1.5 flex items-center gap-2 text-[13px] text-lol-text">
                    <span className="chip bg-lol-gold/12 font-num normal-case text-lol-gold">
                      v{version}
                    </span>
                    Your ARAM Mayhem games, kept on this computer
                  </p>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button onClick={() => window.api.openUrl(REPO_URL)} className="btn">
                  <GithubIcon className="h-4 w-4" />
                  GitHub
                </button>
                <button
                  onClick={() => window.api.openUrl(`${REPO_URL}/releases/tag/v${version}`)}
                  className="btn"
                >
                  <ExternalLinkIcon className="h-4 w-4" />
                  Release notes
                </button>
              </div>
            </div>
          </Section>
        </div>
      </div>
    </div>
  );
}

// Jump links down the side of a wide window, marking the section in view
function SectionNav() {
  const [active, setActive] = useState<SectionId>("general");

  useEffect(() => {
    const scroller = document.getElementById(sectionDomId("general"))?.closest("main");
    if (!scroller) return;
    // The section in view is the last one whose top has passed a line a little
    // below the top of the page, or the last section once the page bottoms out
    const update = () => {
      const top = scroller.getBoundingClientRect().top + 120;
      const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4;
      let current: SectionId = SECTIONS[0].id;
      for (const { id } of SECTIONS) {
        const el = document.getElementById(sectionDomId(id));
        if (el && el.getBoundingClientRect().top <= top) current = id;
      }
      setActive(atBottom ? SECTIONS[SECTIONS.length - 1].id : current);
    };
    update();
    scroller.addEventListener("scroll", update, { passive: true });
    return () => scroller.removeEventListener("scroll", update);
  }, []);

  return (
    <nav className="sticky top-4 hidden xl:block" aria-label="Settings sections">
      <div className="space-y-0.5">
        {SECTIONS.map(({ id, title, icon: Icon }) => {
          const isActive = active === id;
          return (
            <button
              key={id}
              onClick={() =>
                document
                  .getElementById(sectionDomId(id))
                  ?.scrollIntoView({ behavior: "smooth", block: "start" })
              }
              aria-current={isActive ? "true" : undefined}
              className={`relative flex h-9 w-full items-center gap-3 rounded-md px-3 text-left text-[14px] font-medium transition-colors ${
                isActive
                  ? "bg-gradient-to-r from-lol-gold/16 to-lol-gold/[0.03] text-lol-text-bright"
                  : "text-lol-text hover:bg-white/[0.04] hover:text-lol-text-bright"
              }`}
            >
              {isActive && (
                <span className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-r-sm bg-lol-gold shadow-[0_0_10px_rgb(212_178_115/0.7)]" />
              )}
              <Icon className={`h-4 w-4 shrink-0 ${isActive ? "text-lol-gold" : ""}`} />
              {title}
            </button>
          );
        })}
      </div>
      <p className="mt-4 border-t border-lol-line px-3 pt-3.5 text-[12px] text-lol-text">
        Changes save automatically
      </p>
    </nav>
  );
}
