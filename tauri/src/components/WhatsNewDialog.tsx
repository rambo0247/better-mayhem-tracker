import { Show } from "solid-js";
import { api } from "../lib/api-shim";
import type { UpdateNotes } from "../lib/types";
import ReleaseNotes from "./ReleaseNotes";
import DialogFrame, { VersionJump } from "./DialogFrame";
import { GithubIcon } from "./SettingsIcons";

// Shown on the first launch after an update, with every release it brought in
export default function WhatsNewDialog(props: { notes: UpdateNotes; onClose: () => void }) {
  return (
    <DialogFrame
      kicker="Better Mayhem Tracker"
      title="What's New"
      onDismiss={props.onClose}
      footer={
        <>
          <button onClick={() => api.openUrl(props.notes.url)} class="btn btn-ghost -ml-2">
            <GithubIcon class="h-4 w-4" />
            View on GitHub
          </button>
          <button onClick={() => props.onClose()} class="btn btn-primary min-w-[96px]">
            Got It
          </button>
        </>
      }
    >
      <VersionJump from={props.notes.from} to={props.notes.to} />
      <Show when={props.notes.releases.length > 1}>
        <p class="mt-3 text-[14px] leading-[1.5] text-lol-text">
          {props.notes.releases.length} versions of changes since your last launch.
        </p>
      </Show>

      <Show
        when={props.notes.releases.length > 0}
        fallback={
          <p class="mt-4 rounded-lg border border-lol-line bg-black/25 px-4 py-3 text-[13px] text-lol-text">
            The release notes couldn't be loaded. They're on GitHub instead.
          </p>
        }
      >
        <ReleaseNotes releases={props.notes.releases} />
      </Show>
    </DialogFrame>
  );
}
