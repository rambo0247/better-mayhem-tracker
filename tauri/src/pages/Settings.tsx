import {
  children,
  createEffect,
  createSignal,
  For,
  onSettled,
  Show,
  type Component,
  type Accessor,
} from "solid-js";
import { Dynamic, type JSX } from "@solidjs/web";
import {
  DEFAULT_SESSION_GROUPING,
  SESSION_GROUPING_SETTING,
  parseSessionGrouping,
  type SessionGrouping,
} from "@shared/session";
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
import { queueLabel } from "../components/QueueSelect";
import { useBackfill } from "../hooks/useBackfill";
import { useHiddenNavLinks } from "../hooks/useHiddenNavLinks";
import { api } from "../lib/api-shim";
import { LOCALE, formatDecimal, formatShortDate, formatDateTime } from "../lib/format";
import { NAV_LINKS, HOME_PATH, toggleNavLink } from "../lib/navLinks";
import { reportFirstContent } from "../lib/perf";
import type { BackupInfo, ImportProgress } from "../lib/types";
import { setRemembering } from "../lib/viewState";
import {
  backfillOutcome,
  backfillProgressLine,
  flipQueue,
  importProgressLine,
  parseHiddenQueues,
  toggleWrite,
} from "./settings-model";

const REPO_URL = "https://github.com/rambo0247/better-mayhem-tracker";

const IS_MAC = api.platform === "darwin";
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

const count = (value: number) => value.toLocaleString(LOCALE);

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// A crisp-cornered switch in the toolbar's language: a dark outlined trough
// with a muted knob when off, gold with a dark knob when on. A switch held on
// (the home page, the last queue) reads as on, in dimmed gold with a lock in
// the knob; one that is `unavailable` here fades right back with a lock beside
// it. Either way `lockedNote` says why as a tooltip, and `shortNote` in a few
// words beside it.
function Switch(props: {
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
  const disabled = () => props.disabled ?? false;
  const lockedOn = () => disabled() && props.checked && !props.unavailable;
  return (
    <span
      class="inline-flex shrink-0 items-center gap-2"
      title={disabled() ? props.lockedNote : undefined}
    >
      <Show when={disabled() && (props.shortNote || !lockedOn())}>
        <span class="flex items-center gap-1.5 text-[13px] text-lol-text">
          <LockIcon class="h-4 w-4 shrink-0" aria-hidden="true" />
          {props.shortNote}
        </span>
      </Show>
      <button
        type="button"
        role="switch"
        aria-checked={props.checked ? "true" : "false"}
        aria-label={props.label}
        disabled={disabled()}
        onClick={() => props.onChange()}
        class={[
          "relative inline-flex h-[22px] w-10 shrink-0 rounded-md border transition-colors duration-200 focus-visible:outline-offset-2",
          disabled() ? "cursor-not-allowed" : "cursor-pointer",
          lockedOn() ? "opacity-60" : disabled() ? "opacity-40" : "",
          props.checked
            ? "border-lol-gold bg-gradient-to-b from-[#e2c487] to-lol-gold"
            : `border-[#3a4680] bg-[#1a2247] ${disabled() ? "" : "hover:border-[#4d5a9c] hover:bg-[#1f2853]"}`,
        ]}
      >
        <span
          class={[
            "pointer-events-none absolute top-[2px] left-[2px] flex h-4 w-4 items-center justify-center rounded-sm transition-transform duration-200 ease-snap",
            props.checked
              ? "translate-x-[18px] bg-[#1a1407] text-lol-gold shadow-[0_1px_2px_rgb(0_0_0/0.4)]"
              : "translate-x-0 bg-[#8a90b0] shadow-[0_1px_2px_rgb(0_0_0/0.45)]",
          ]}
        />
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

type IconComponent = Component<JSX.SvgSVGAttributes<SVGSVGElement>>;

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
function Section(props: { id: SectionId; actions?: JSX.Element; children: JSX.Element }) {
  const meta = () => SECTIONS.find((s) => s.id === props.id)!;
  const actions = children(() => props.actions);
  return (
    <section id={sectionDomId(props.id)} class="panel scroll-mt-4 overflow-hidden">
      <header class="panel-head gap-3 px-5">
        <span class="flex h-7 w-7 items-center justify-center rounded-md bg-lol-gold/10 text-lol-gold">
          <Dynamic component={meta().icon} class="h-4 w-4" />
        </span>
        <h2 class="section-title">{meta().title}</h2>
        <Show when={actions()}>
          <div class="ml-auto flex items-center gap-2">{actions()}</div>
        </Show>
      </header>
      <div class="divide-y divide-lol-line">{props.children}</div>
    </section>
  );
}

// A setting: what it is and what it does on the left, its control on the right,
// and room underneath for anything it reports back
function Row(props: {
  title: JSX.Element;
  description?: JSX.Element;
  control?: JSX.Element;
  children?: JSX.Element;
}) {
  const description = children(() => props.description);
  const control = children(() => props.control);
  return (
    <div class="px-5 py-4">
      <div class="flex items-center justify-between gap-10">
        <div class="min-w-0 max-w-[600px]">
          <p class="text-[14px] font-semibold leading-5 text-lol-text-bright">{props.title}</p>
          <Show when={description()}>
            <p class="mt-1 text-[13px] leading-[1.5] text-lol-text">{description()}</p>
          </Show>
        </div>
        <Show when={control()}>
          <div class="flex shrink-0 items-center gap-2">{control()}</div>
        </Show>
      </div>
      {props.children}
    </div>
  );
}

// The line a data action leaves behind: how far it has got while it runs, then
// how it went
function Status(props: { text: string | null; running?: boolean }) {
  const failed = () => props.text?.startsWith("Error") ?? false;
  return (
    <Show when={props.text}>
      {(text) => (
        <p
          class={[
            "mt-3 flex items-start gap-2.5 rounded-md border px-3 py-2 text-[13px] leading-[1.45]",
            failed()
              ? "border-lol-loss/30 bg-lol-loss/[0.07] text-lol-loss"
              : "border-lol-line bg-black/20 text-lol-text-bright/90",
          ]}
        >
          <span
            class={[
              "mt-[6px] h-1.5 w-1.5 shrink-0 rounded-full",
              failed() ? "bg-lol-loss" : props.running ? "live-pulse bg-lol-gold" : "bg-lol-win",
            ]}
          />
          <span class="min-w-0 break-words">{text()}</span>
        </p>
      )}
    </Show>
  );
}

export default function Settings() {
  // Shared so a backfill started automatically on first connect shows here too
  const { running: backfilling, progress } = useBackfill();
  const hiddenNavLinks = useHiddenNavLinks();
  const [autoStart, setAutoStart] = createSignal(false);
  // Only the packaged program has a durable exe to register at sign-in or to
  // swap for a new version, so those switches say so instead of pretending in a
  // dev build
  const [packaged, setPackaged] = createSignal(false);
  const [autoUpdate, setAutoUpdate] = createSignal(true);
  const [showReleaseNotes, setShowReleaseNotes] = createSignal(true);
  const [minimizeToTray, setMinimizeToTray] = createSignal(true);
  // Every queue with games stored, and the subset the user has switched off
  const [queues, setQueues] = createSignal<number[]>([]);
  const [hiddenQueues, setHiddenQueues] = createSignal<ReadonlySet<number>>(new Set());
  const [hideRemakes, setHideRemakes] = createSignal(false);
  const [sessionGrouping, setSessionGrouping] =
    createSignal<SessionGrouping>(DEFAULT_SESSION_GROUPING);
  const [autoBackup, setAutoBackup] = createSignal(true);
  const [rememberFilters, setRememberFilters] = createSignal(false);
  const [version, setVersion] = createSignal("");
  const [loading, setLoading] = createSignal(true);
  const [exportStatus, setExportStatus] = createSignal<string | null>(null);
  const [importStatus, setImportStatus] = createSignal<string | null>(null);
  const [importing, setImporting] = createSignal(false);
  const [importProgress, setImportProgress] = createSignal<ImportProgress | null>(null);
  const [repairStatus, setRepairStatus] = createSignal<string | null>(null);
  const [backfillStatus, setBackfillStatus] = createSignal<string | null>(null);
  const [backups, setBackups] = createSignal<BackupInfo[]>([]);
  const [backupStatus, setBackupStatus] = createSignal<string | null>(null);
  const [backupBusy, setBackupBusy] = createSignal(false);
  // Restoring replaces the whole database, so the row asks a second time
  const [confirmRestore, setConfirmRestore] = createSignal<string | null>(null);

  const refreshBackups = () => {
    void api.listBackups().then(setBackups);
  };

  onSettled(() => {
    void Promise.all([
      api.getSetting("auto_start"),
      api.isAutoStartSupported(),
      api.getSetting("minimize_to_tray"),
      api.getSetting("hidden_queues"),
      api.getSetting("hide_remakes"),
      api.getSetting("auto_backup"),
      api.getSetting("remember_filters"),
      api.getSetting(SESSION_GROUPING_SETTING),
      api.getVersion(),
      api.getSetting("auto_update"),
      api.getSetting("show_release_notes"),
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
        setHiddenQueues(parseHiddenQueues(hidden));
        setHideRemakes(remakes === "true");
        setAutoBackup(backup !== "false");
        setRememberFilters(remember === "true");
        setSessionGrouping(parseSessionGrouping(grouping));
        setVersion(v);
        setLoading(false);
      },
    );

    // Kept current the same way the queue dropdown is: a game from a queue that
    // wasn't in the database yet adds a switch for it without a reload.
    const fetchQueues = () => void api.getStoredQueues().then(setQueues);
    fetchQueues();
    const offGames = api.onGamesUpdated(fetchQueues);
    const offImport = api.onImportProgress((p) => setImportProgress(p));
    refreshBackups();
    return () => {
      offGames();
      offImport();
    };
  });

  createEffect(
    () => loading(),
    (isLoading) => {
      if (!isLoading) reportFirstContent();
    },
  );

  // Every switch on this page flips one boolean setting and writes it back, so
  // they share one handler. `also` is for the one that has somewhere else to
  // be: remember_filters is acted on by the pages already mounted.
  const toggle =
    (
      key: string,
      value: Accessor<boolean>,
      setValue: (next: boolean) => void,
      also?: (next: boolean) => void,
    ) =>
    async () => {
      const [, written] = toggleWrite(key, value());
      const next = written === "true";
      setValue(next);
      also?.(next);
      await api.setSetting(key, written);
    };

  const handleQueueToggle = async (queueId: number) => {
    const { next, setting } = flipQueue(hiddenQueues(), queueId);
    setHiddenQueues(next);
    await api.setSetting("hidden_queues", setting);
  };

  const handleSessionGroupingChange = async (next: SessionGrouping) => {
    setSessionGrouping(next);
    await api.setSetting(SESSION_GROUPING_SETTING, next);
  };

  const handleBackupNow = async () => {
    setBackupBusy(true);
    setBackupStatus(null);
    try {
      const result = await api.createBackup();
      setBackupStatus(
        result.success
          ? `Backed up ${result.backup?.games?.toLocaleString(LOCALE)} game(s)`
          : `Error: ${result.error ?? "backup failed"}`,
      );
      refreshBackups();
    } catch (err) {
      setBackupStatus(`Error: ${errorMessage(err)}`);
    } finally {
      setBackupBusy(false);
    }
  };

  const handleRestore = async (file: string) => {
    setConfirmRestore(null);
    setBackupBusy(true);
    setBackupStatus(null);
    try {
      const result = await api.restoreBackup(file);
      setBackupStatus(
        result.success
          ? `Restored ${result.games?.toLocaleString(LOCALE)} game(s) from ${file}`
          : `Error: ${result.error ?? "restore failed"}`,
      );
      refreshBackups();
    } catch (err) {
      setBackupStatus(`Error: ${errorMessage(err)}`);
    } finally {
      setBackupBusy(false);
    }
  };

  const handleExport = async () => {
    setExportStatus(null);
    try {
      const result = await api.exportData();
      if (result.success) {
        setExportStatus(
          `Exported ${result.games?.toLocaleString(LOCALE)} game(s) to ${result.path}`,
        );
      } else {
        // No error means the file dialog was dismissed, which needs no message
        setExportStatus(result.error ? `Error: ${result.error}` : null);
      }
    } catch (err) {
      setExportStatus(`Error: ${errorMessage(err)}`);
    }
  };

  const handleImport = async () => {
    setImportStatus(null);
    setImporting(true);
    try {
      const result = await api.importData();
      if (result.success) {
        setImportStatus(`Imported ${result.imported?.toLocaleString(LOCALE)} new game(s)`);
      } else {
        setImportStatus(result.error ? `Error: ${result.error}` : null);
      }
      // An import takes a snapshot on its way in
      refreshBackups();
    } catch (err) {
      setImportStatus(`Error: ${errorMessage(err)}`);
    } finally {
      setImporting(false);
      setImportProgress(null);
    }
  };

  // Like the backfill line: how far the import has got while it runs, then the
  // outcome
  const importLine = () => {
    const p = importProgress();
    return importing() && p ? importProgressLine(p, count) : importStatus();
  };

  // A run in progress reports how far it has got; the outcome takes over once
  // it is done
  const backfillLine = () => {
    const p = progress();
    if (!p) return backfillStatus();
    return backfillProgressLine(p, count);
  };

  const handleBackfill = async () => {
    setBackfillStatus("Fetching your match list from Riot...");
    try {
      const result = await api.backfillHistory();
      if ("error" in result) {
        setBackfillStatus(`Error: ${result.error}`);
      } else {
        setBackfillStatus(backfillOutcome(result, count, formatHistoryStart));
      }
    } catch (err) {
      setBackfillStatus(`Error: ${errorMessage(err)}`);
    }
  };

  const handleRepair = async () => {
    setRepairStatus(null);
    try {
      const result = await api.repairPuuids();
      setRepairStatus(
        `Repaired ${result.repairedGames.toLocaleString(LOCALE)} game(s), found ${result.discoveredAccounts} account(s), rebuilt stats and scores for ${result.rebuiltGames.toLocaleString(LOCALE)} game(s)`,
      );
      // A repair takes a snapshot on its way in
      refreshBackups();
    } catch (err) {
      setRepairStatus(`Error: ${errorMessage(err)}`);
    }
  };

  const shownQueueCount = () => queues().filter((id) => !hiddenQueues().has(id)).length;

  return (
    <Show when={!loading()}>
      <div class="max-w-[1320px]">
        <PageHeader
          kicker="App"
          title="Settings"
          subtitle="How the tracker runs, what it shows, and where your match data lives"
        />

        <div class="xl:grid xl:grid-cols-[200px_minmax(0,1fr)] xl:items-start xl:gap-8">
          <SectionNav />

          <div class="space-y-6">
            <Section id="general">
              <Row
                title={IS_MAC ? "Open at login" : "Start with Windows"}
                // WebKit shapes each text node on its own, which made this line wrap a word earlier
                // than Chromium, so the description is a single text node
                description={`Open the program in the ${IS_MAC ? "menu bar" : "system tray"} when you sign in to ${IS_MAC ? "your Mac" : "Windows"}, so your games are recorded without having to remember to start it.${packaged() ? "" : NOT_INSTALLED_NOTE}`}
                control={
                  <Switch
                    label={IS_MAC ? "Open at login" : "Start with Windows"}
                    checked={autoStart()}
                    onChange={toggle("auto_start", autoStart, setAutoStart)}
                    disabled={!packaged()}
                    lockedNote={NOT_INSTALLED_NOTE.trim()}
                    unavailable
                    shortNote={NOT_INSTALLED_SHORT}
                  />
                }
              />
              <Row
                title={
                  IS_MAC ? "Keep running in the menu bar on close" : "Minimize to tray on close"
                }
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
                    checked={minimizeToTray()}
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
                    checked={rememberFilters()}
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
                    checked={hideRemakes()}
                    onChange={toggle("hide_remakes", hideRemakes, setHideRemakes)}
                  />
                }
              />
              <Row
                title="Group match history by"
                description="Break the match list into sessions, each under a heading with its own record and averages. Days start at 5am."
                control={
                  <select
                    class="select w-[148px]"
                    aria-label="Group match history by"
                    value={sessionGrouping()}
                    onChange={(e) =>
                      void handleSessionGroupingChange(e.currentTarget.value as SessionGrouping)
                    }
                  >
                    <For each={SESSION_GROUPING_OPTIONS}>
                      {(option) => <option value={option.value}>{option.label}</option>}
                    </For>
                  </select>
                }
              />
              {/* A single queue has nothing to choose between, so the whole block
                  waits until a second one shows up in the database */}
              <Show when={queues().length > 1}>
                <Row
                  title="Queues to include"
                  description="Stats and match history only count the queues switched on here. Games from the others are still recorded, and can be counted again by switching their queue back on."
                >
                  <div class="mt-3 divide-y divide-lol-line overflow-hidden rounded-lg border border-lol-line bg-black/15">
                    <For each={queues()}>
                      {(q) => {
                        const shown = () => !hiddenQueues().has(q);
                        return (
                          <div class="flex h-11 items-center justify-between gap-6 px-4">
                            <span
                              class={[
                                "text-[14px] font-medium",
                                shown() ? "text-lol-text-bright" : "text-lol-text",
                              ]}
                            >
                              {queueLabel(q)}
                            </span>
                            {/* Switching off the last one would empty every page */}
                            <Switch
                              label={queueLabel(q)}
                              checked={shown()}
                              disabled={shown() && shownQueueCount() === 1}
                              lockedNote="At least one queue has to stay on"
                              shortNote="Last one on"
                              onChange={() => void handleQueueToggle(q)}
                            />
                          </div>
                        );
                      }}
                    </For>
                  </div>
                </Row>
              </Show>
            </Section>

            <Section id="sidebar">
              <Row
                title="Pages in the sidebar"
                description="Switch off the pages you never visit. A hidden page keeps recording, and Match History always stays since it's where the app opens."
              >
                <div class="mt-4 grid gap-2 sm:grid-cols-2">
                  <For each={NAV_LINKS}>
                    {(link) => {
                      const shown = () => !hiddenNavLinks().has(link.to);
                      return (
                        <div
                          class={[
                            "flex h-12 items-center gap-3 rounded-lg border px-3 transition-colors",
                            shown()
                              ? "border-lol-line bg-white/[0.025]"
                              : "border-dashed border-lol-border/70 bg-transparent",
                          ]}
                        >
                          <span
                            class={[
                              "flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors",
                              shown()
                                ? "bg-lol-gold/10 text-lol-gold"
                                : "bg-white/[0.04] text-lol-text/75",
                            ]}
                          >
                            <link.icon class="h-4 w-4" />
                          </span>
                          <span
                            class={[
                              "min-w-0 flex-1 truncate text-[14px] font-medium",
                              shown() ? "text-lol-text-bright" : "text-lol-text",
                            ]}
                          >
                            {link.label}
                          </span>
                          <Switch
                            label={link.label}
                            checked={shown()}
                            disabled={link.to === HOME_PATH}
                            lockedNote="Match History is where the app opens, so it always stays"
                            shortNote="Always shown"
                            onChange={() => void toggleNavLink(link.to)}
                          />
                        </div>
                      );
                    }}
                  </For>
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
                    {!packaged() && NOT_INSTALLED_NOTE}
                  </>
                }
                control={
                  <Switch
                    label="Install updates automatically"
                    checked={autoUpdate()}
                    onChange={toggle("auto_update", autoUpdate, setAutoUpdate)}
                    disabled={!packaged()}
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
                    checked={showReleaseNotes()}
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
                  <button
                    onClick={() => void handleBackfill()}
                    disabled={backfilling()}
                    class="btn w-[124px]"
                  >
                    <RefreshIcon class={backfilling() ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
                    {backfilling() ? "Working..." : "Backfill"}
                  </button>
                }
              >
                <Status text={backfillLine()} running={backfilling()} />
              </Row>
              <Row
                title="Export data"
                description="Save all match data to a JSON file for backup"
                control={
                  <button onClick={() => void handleExport()} class="btn w-[124px]">
                    <UploadIcon class="h-4 w-4" />
                    Export
                  </button>
                }
              >
                <Status text={exportStatus()} />
              </Row>
              <Row
                title="Import data"
                description="Load match data from a previously exported file"
                control={
                  <button
                    onClick={() => void handleImport()}
                    disabled={importing()}
                    class="btn w-[124px]"
                  >
                    <DownloadIcon class="h-4 w-4" />
                    {importing() ? "Working..." : "Import"}
                  </button>
                }
              >
                <Status text={importLine()} running={importing()} />
              </Row>
              <Row
                title="Repair account data"
                description="Re-detect which accounts are yours by analyzing game history, then rebuild stored stats, augments, and performance scores from the raw game data. Use this if games are attributed to the wrong account or scores look stale."
                control={
                  <button onClick={() => void handleRepair()} class="btn w-[124px]">
                    <WrenchIcon class="h-4 w-4" />
                    Repair
                  </button>
                }
              >
                <Status text={repairStatus()} />
              </Row>
            </Section>

            <Section
              id="backups"
              actions={
                <>
                  <button onClick={() => void api.openBackupFolder()} class="btn btn-sm btn-ghost">
                    <FolderOpenIcon class="h-3.5 w-3.5" />
                    Open folder
                  </button>
                  <button
                    onClick={() => void handleBackupNow()}
                    disabled={backupBusy()}
                    class="btn btn-sm"
                  >
                    <ArchiveIcon class="h-3.5 w-3.5" />
                    {backupBusy() ? "Working..." : "Back up now"}
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
                    checked={autoBackup()}
                    onChange={toggle("auto_backup", autoBackup, setAutoBackup)}
                  />
                }
              >
                <Status text={backupStatus()} running={backupBusy()} />
              </Row>

              <div>
                <div class="flex items-center gap-2 bg-black/15 px-5 py-2.5">
                  <span class="label">Saved copies</span>
                  <span class="font-num text-[13px] text-lol-text">{backups().length}</span>
                </div>
                <Show
                  when={backups().length > 0}
                  fallback={
                    <p class="border-t border-lol-line px-5 py-4 text-[13px] text-lol-text">
                      No backups yet.
                    </p>
                  }
                >
                  <For each={backups()}>
                    {(backup) => (
                      <div
                        class={[
                          "flex min-h-[56px] items-center gap-4 border-t border-lol-line px-5 py-2.5 transition-colors",
                          confirmRestore() === backup.file
                            ? "bg-lol-loss/[0.05]"
                            : "hover:bg-white/[0.02]",
                        ]}
                      >
                        <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-white/[0.04] text-lol-text">
                          <HistoryIcon class="h-4 w-4" />
                        </span>
                        <div class="min-w-0 flex-1">
                          <p
                            class="font-num text-[15px] font-semibold leading-5 text-lol-text-bright"
                            title={formatDateTime(backup.created)}
                          >
                            {formatTaken(backup.created)}
                          </p>
                          <p class="mt-0.5 flex items-center gap-1.5 text-[13px] text-lol-text">
                            <span>{BACKUP_REASONS[backup.reason] ?? backup.reason}</span>
                            <span class="text-lol-text/50">·</span>
                            <Show
                              when={backup.games !== null}
                              fallback={<span class="text-lol-loss">unreadable</span>}
                            >
                              <span class="font-num text-[13px]">
                                {backup.games?.toLocaleString(LOCALE)} games
                              </span>
                            </Show>
                            <span class="text-lol-text/50">·</span>
                            <span class="font-num text-[13px]">{formatSize(backup.size)}</span>
                          </p>
                        </div>
                        <Show
                          when={confirmRestore() === backup.file}
                          fallback={
                            <button
                              onClick={() => setConfirmRestore(backup.file)}
                              disabled={backupBusy() || backup.games === null}
                              class="btn btn-sm shrink-0"
                            >
                              Restore
                            </button>
                          }
                        >
                          <div class="flex shrink-0 items-center gap-2">
                            <span class="mr-1 text-[13px] text-lol-text-bright">
                              Replace current data?
                            </span>
                            <button
                              onClick={() => setConfirmRestore(null)}
                              class="btn btn-sm btn-ghost"
                            >
                              Cancel
                            </button>
                            <button
                              onClick={() => void handleRestore(backup.file)}
                              disabled={backupBusy()}
                              class="btn btn-sm btn-danger"
                            >
                              Restore
                            </button>
                          </div>
                        </Show>
                      </div>
                    )}
                  </For>
                </Show>
              </div>
            </Section>

            <Section id="troubleshooting">
              <Row
                title="Log file"
                description="A record of what the program does in the background, like connecting to the client and recording games. If something goes wrong, main.log is the file to attach to a bug report."
                control={
                  <button onClick={() => void api.openLogsFolder()} class="btn w-[124px]">
                    <FolderOpenIcon class="h-4 w-4" />
                    Open folder
                  </button>
                }
              />
            </Section>

            <Section id="about">
              <div class="flex flex-wrap items-center justify-between gap-6 px-5 py-5">
                <div class="flex items-center gap-4">
                  <BrandMark class="h-12 w-12 shrink-0 drop-shadow-[0_4px_14px_rgb(212_178_115/0.25)]" />
                  <div>
                    <p class="font-display text-[20px] font-extrabold uppercase italic leading-none tracking-[0.03em] text-lol-text-bright">
                      Better Mayhem Tracker
                    </p>
                    <p class="mt-1.5 flex items-center gap-2 text-[13px] text-lol-text">
                      <span class="chip bg-lol-gold/12 font-num normal-case text-lol-gold">
                        v{version()}
                      </span>
                      Your ARAM Mayhem games, kept on this computer
                    </p>
                  </div>
                </div>
                <div class="flex shrink-0 items-center gap-2">
                  <button onClick={() => void api.openUrl(REPO_URL)} class="btn">
                    <GithubIcon class="h-4 w-4" />
                    GitHub
                  </button>
                  <button
                    onClick={() => void api.openUrl(`${REPO_URL}/releases/tag/v${version()}`)}
                    class="btn"
                  >
                    <ExternalLinkIcon class="h-4 w-4" />
                    Release notes
                  </button>
                </div>
              </div>
            </Section>
          </div>
        </div>
      </div>
    </Show>
  );
}

// Jump links down the side of a wide window, marking the section in view
function SectionNav() {
  const [active, setActive] = createSignal<SectionId>("general");

  onSettled(() => {
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
  });

  return (
    <nav class="sticky top-4 hidden xl:block" aria-label="Settings sections">
      <div class="space-y-0.5">
        <For each={SECTIONS}>
          {(section) => {
            const isActive = () => active() === section.id;
            return (
              <button
                onClick={() =>
                  document
                    .getElementById(sectionDomId(section.id))
                    ?.scrollIntoView({ behavior: "smooth", block: "start" })
                }
                aria-current={isActive() ? "true" : undefined}
                class={[
                  "relative flex h-9 w-full items-center gap-3 rounded-md px-3 text-left text-[14px] font-medium transition-colors",
                  isActive()
                    ? "bg-gradient-to-r from-lol-gold/16 to-lol-gold/[0.03] text-lol-text-bright"
                    : "text-lol-text hover:bg-white/[0.04] hover:text-lol-text-bright",
                ]}
              >
                <Show when={isActive()}>
                  <span class="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-r-sm bg-lol-gold shadow-[0_0_10px_rgb(212_178_115/0.7)]" />
                </Show>
                <section.icon
                  class={isActive() ? "h-4 w-4 shrink-0 text-lol-gold" : "h-4 w-4 shrink-0"}
                />
                {section.title}
              </button>
            );
          }}
        </For>
      </div>
      <p class="mt-4 border-t border-lol-line px-3 pt-3.5 text-[12px] text-lol-text">
        Changes save automatically
      </p>
    </nav>
  );
}
