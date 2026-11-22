import { useState, useEffect } from "react";
import type { RecoveryReport } from "../lib/types";
import { AlertTriangleIcon } from "./SettingsIcons";

// Shown when the app had to rebuild its database at startup. Silently restoring
// and carrying on would leave the user with no way to tell that anything
// happened — and, if the restore came from an older snapshot, no explanation
// for the games that are suddenly missing.
export default function RecoveryBanner() {
  const [report, setReport] = useState<RecoveryReport | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    window.api.getRecoveryReport().then(setReport);
  }, []);

  if (!report || dismissed) return null;

  const cause =
    report.problem === "missing"
      ? "Your match database was missing at startup."
      : "Your match database could not be opened at startup.";
  const outcome = report.restoredFrom
    ? `It was restored from the most recent working backup (${report.restoredFrom}). Any games recorded after that backup will be re-fetched the next time the client is running.`
    : "There was no usable backup to restore from, so the app started with an empty database. Connect your client and run a backfill from Settings to pull your history from Riot again.";
  const kept = report.quarantined
    ? ` The old file was kept as ${report.quarantined} in your data folder.`
    : "";

  return (
    <div
      role="alert"
      className="mx-8 mt-3 mb-3 flex items-start gap-3.5 rounded-lg border border-amber-400/35 bg-gradient-to-r from-amber-400/[0.12] to-amber-400/[0.04] px-4 py-3.5 shadow-[0_10px_30px_-18px_rgb(0_0_0/0.7)]"
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-amber-400/15 text-amber-300">
        <AlertTriangleIcon className="h-[18px] w-[18px]" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="section-title text-[15px] text-amber-300">Database recovered</p>
        <p className="mt-1 text-[13px] leading-[1.5] text-lol-text-bright/85">
          {cause} {outcome}
          {kept}
        </p>
      </div>
      <button onClick={() => setDismissed(true)} className="btn btn-sm btn-ghost shrink-0">
        Dismiss
      </button>
    </div>
  );
}
