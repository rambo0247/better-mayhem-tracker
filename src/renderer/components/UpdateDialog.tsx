import { useEffect, useState } from "react";
import { formatDecimal, formatPercent } from "../lib/format";
import type { UpdateInfo } from "../lib/types";
import { RefreshIcon } from "./icons";
import ReleaseNotes from "./ReleaseNotes";
import DialogFrame, { VersionJump } from "./DialogFrame";
import { AlertTriangleIcon, GithubIcon } from "./SettingsIcons";

export default function UpdateDialog({
  update,
  installing = false,
  onClose,
}: {
  update: UpdateInfo;
  // The main process started this install itself at launch, rather than the
  // user from this dialog
  installing?: boolean;
  onClose: () => void;
}) {
  const [downloading, setDownloading] = useState(installing);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // A launch install has no button press awaiting its result, so a failure
  // arrives as an event instead
  useEffect(() => {
    return window.api.onUpdateInstallFailed((message) => {
      setDownloading(false);
      setError(message);
    });
  }, []);

  const releases = update.releases ?? [];
  // A launch install that failed is back to an offer like any other
  const launchInstalling = installing && !error;

  useEffect(() => {
    return window.api.onUpdateProgress(setProgress);
  }, []);

  const handleUpdate = async () => {
    if (!update.assetUrl) {
      setError("No download found for this release");
      return;
    }
    setDownloading(true);
    setError(null);
    const result = await window.api.downloadUpdate(update.assetUrl);
    if (!result.success) {
      setDownloading(false);
      setError(result.error ?? "Update failed");
    }
    // On success the app restarts itself, no further action needed
  };

  const sizeMb = update.assetSize ? formatDecimal(update.assetSize / 1024 / 1024) : null;

  return (
    <DialogFrame
      kicker="Better Mayhem Tracker"
      title={launchInstalling ? "Updating" : "Update Available"}
      onDismiss={downloading ? undefined : onClose}
      footer={
        <>
          <button onClick={() => window.api.openUrl(update.url!)} className="btn btn-ghost -ml-2">
            <GithubIcon className="h-4 w-4" />
            View on GitHub
          </button>
          <div className="flex gap-2">
            <button onClick={onClose} disabled={downloading} className="btn">
              Not Now
            </button>
            <button
              onClick={handleUpdate}
              disabled={downloading || !update.assetUrl}
              className="btn btn-primary"
            >
              <RefreshIcon className={`h-4 w-4 ${downloading ? "animate-spin" : ""}`} />
              {downloading ? "Updating..." : "Update & Restart"}
            </button>
          </div>
        </>
      }
    >
      <VersionJump from={update.current} to={update.latest} />
      <p className="mt-3 text-[14px] leading-[1.5] text-lol-text">
        {launchInstalling
          ? "The program restarts on its own when it's done."
          : `Version ${update.latest} is ready to install.`}
        {releases.length > 1 && (
          <>
            {" "}
            {releases.length} versions of changes since your install
            {update.moreVersions ? ", plus earlier ones on GitHub" : ""}.
          </>
        )}
      </p>

      {releases.length > 0 && <ReleaseNotes releases={releases} />}

      {downloading && (
        <div className="mt-4">
          <div className="flex items-baseline justify-between">
            <span className="label">Downloading</span>
            <span className="font-num text-[13px] text-lol-text">
              <span className="text-[15px] font-semibold text-lol-text-bright">
                {formatPercent(progress / 100, 0)}
              </span>
              {sizeMb ? ` of ${sizeMb} MB` : ""}
            </span>
          </div>
          <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-sm bg-white/[0.07]">
            <div
              className="h-full rounded-sm bg-gradient-to-r from-lol-gold/70 to-lol-gold-light transition-all"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}

      {error && (
        <div className="mt-4 flex items-start gap-2.5 rounded-md border border-lol-loss/30 bg-lol-loss/[0.07] px-3 py-2 text-[13px] text-lol-loss">
          <AlertTriangleIcon className="mt-[2px] h-4 w-4 shrink-0" />
          <span className="min-w-0">
            {error}
            {update.url && (
              <button
                onClick={() => window.api.openUrl(update.url!)}
                className="ml-1.5 font-semibold text-lol-gold transition-colors hover:text-lol-gold-light"
              >
                Download manually
              </button>
            )}
          </span>
        </div>
      )}
    </DialogFrame>
  );
}
