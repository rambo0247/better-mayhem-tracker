import type { UpdateNotes } from "../lib/types";
import ReleaseNotes from "./ReleaseNotes";
import DialogFrame, { VersionJump } from "./DialogFrame";
import { GithubIcon } from "./SettingsIcons";

// Shown on the first launch after an update, with every release it brought in
export default function WhatsNewDialog({
  notes,
  onClose,
}: {
  notes: UpdateNotes;
  onClose: () => void;
}) {
  const { releases } = notes;
  return (
    <DialogFrame
      kicker="Better Mayhem Tracker"
      title="What's New"
      onDismiss={onClose}
      footer={
        <>
          <button onClick={() => window.api.openUrl(notes.url)} className="btn btn-ghost -ml-2">
            <GithubIcon className="h-4 w-4" />
            View on GitHub
          </button>
          <button onClick={onClose} className="btn btn-primary min-w-[96px]">
            Got It
          </button>
        </>
      }
    >
      <VersionJump from={notes.from} to={notes.to} />
      {releases.length > 1 && (
        <p className="mt-3 text-[14px] leading-[1.5] text-lol-text">
          {releases.length} versions of changes since your last launch.
        </p>
      )}

      {releases.length > 0 ? (
        <ReleaseNotes releases={releases} />
      ) : (
        <p className="mt-4 rounded-lg border border-lol-line bg-black/25 px-4 py-3 text-[13px] text-lol-text">
          The release notes couldn't be loaded. They're on GitHub instead.
        </p>
      )}
    </DialogFrame>
  );
}
