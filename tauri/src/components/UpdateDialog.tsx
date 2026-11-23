import { createSignal, onSettled, Show } from "solid-js";
import { api } from "../lib/api-shim";
import { formatDecimal, formatPercent } from "../lib/format";
import type { UpdateInfo } from "../lib/types";
import { RefreshIcon } from "./icons";
import ReleaseNotes from "./ReleaseNotes";
import DialogFrame, { VersionJump } from "./DialogFrame";
import { AlertTriangleIcon, GithubIcon } from "./SettingsIcons";

export default function UpdateDialog(props: {
  update: UpdateInfo;
  // The main process started this install itself at launch, rather than the
  // user from this dialog
  installing?: boolean;
  onClose: () => void;
}) {
  const [downloading, setDownloading] = createSignal(() => props.installing ?? false);
  const [progress, setProgress] = createSignal(0);
  const [error, setError] = createSignal<string | null>(null);

  onSettled(() => {
    // A launch install has no button press awaiting its result, so a failure
    // arrives as an event instead
    const offFailed = api.onUpdateInstallFailed((message) => {
      setDownloading(false);
      setError(message);
    });
    const offProgress = api.onUpdateProgress(setProgress);
    return () => {
      offFailed();
      offProgress();
    };
  });

  const releases = () => props.update.releases ?? [];
  // A launch install that failed is back to an offer like any other
  const launchInstalling = () => (props.installing ?? false) && !error();

  const handleUpdate = async () => {
    const assetUrl = props.update.assetUrl;
    if (!assetUrl) {
      setError("No download found for this release");
      return;
    }
    setDownloading(true);
    setError(null);
    const result = await api.downloadUpdate(assetUrl);
    if (!result.success) {
      setDownloading(false);
      setError(result.error ?? "Update failed");
    }
    // On success the app restarts itself, no further action needed
  };

  const sizeMb = () =>
    props.update.assetSize ? formatDecimal(props.update.assetSize / 1024 / 1024) : null;

  return (
    <DialogFrame
      kicker="Better Mayhem Tracker"
      title={launchInstalling() ? "Updating" : "Update Available"}
      onDismiss={downloading() ? undefined : props.onClose}
      footer={
        <>
          <button onClick={() => api.openUrl(props.update.url!)} class="btn btn-ghost -ml-2">
            <GithubIcon class="h-4 w-4" />
            View on GitHub
          </button>
          <div class="flex gap-2">
            <button onClick={() => props.onClose()} disabled={downloading()} class="btn">
              Not Now
            </button>
            <button
              onClick={handleUpdate}
              disabled={downloading() || !props.update.assetUrl}
              class="btn btn-primary"
            >
              <RefreshIcon class={["h-4 w-4", { "animate-spin": downloading() }]} />
              {downloading() ? "Updating..." : "Update & Restart"}
            </button>
          </div>
        </>
      }
    >
      <VersionJump from={props.update.current} to={props.update.latest} />
      <p class="mt-3 text-[14px] leading-[1.5] text-lol-text">
        {launchInstalling()
          ? "The program restarts on its own when it's done."
          : `Version ${props.update.latest} is ready to install.`}
        <Show when={releases().length > 1}>
          {" "}
          {releases().length} versions of changes since your install
          {props.update.moreVersions ? ", plus earlier ones on GitHub" : ""}.
        </Show>
      </p>

      <Show when={releases().length > 0}>
        <ReleaseNotes releases={releases()} />
      </Show>

      <Show when={downloading()}>
        <div class="mt-4">
          <div class="flex items-baseline justify-between">
            <span class="label">Downloading</span>
            <span class="font-num text-[13px] text-lol-text">
              <span class="text-[15px] font-semibold text-lol-text-bright">
                {formatPercent(progress() / 100, 0)}
              </span>
              {sizeMb() ? ` of ${sizeMb()} MB` : ""}
            </span>
          </div>
          <div class="mt-1.5 h-1.5 w-full overflow-hidden rounded-sm bg-white/[0.07]">
            <div
              class="h-full rounded-sm bg-gradient-to-r from-lol-gold/70 to-lol-gold-light transition-all"
              style={{ width: `${progress()}%` }}
            />
          </div>
        </div>
      </Show>

      <Show when={error()}>
        {(message) => (
          <div class="mt-4 flex items-start gap-2.5 rounded-md border border-lol-loss/30 bg-lol-loss/[0.07] px-3 py-2 text-[13px] text-lol-loss">
            <AlertTriangleIcon class="mt-[2px] h-4 w-4 shrink-0" />
            <span class="min-w-0">
              {message()}
              <Show when={props.update.url}>
                <button
                  onClick={() => api.openUrl(props.update.url!)}
                  class="ml-1.5 font-semibold text-lol-gold transition-colors hover:text-lol-gold-light"
                >
                  Download manually
                </button>
              </Show>
            </span>
          </div>
        )}
      </Show>
    </DialogFrame>
  );
}
