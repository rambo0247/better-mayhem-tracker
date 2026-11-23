import { createSignal, onSettled, Show } from "solid-js";
import { Dynamic } from "@solidjs/web";
import { cardRoute, type CardSpec } from "@shared/card";
import { api } from "../lib/api-shim";
import { CopyIcon, ImageIcon } from "./icons";

// Long enough to read where the file went, short enough that it doesn't sit
// over the page for the rest of the session
const MESSAGE_MS = 8_000;

// Saving the card asks where to put it; copying it just takes the clipboard.
type ImageAction = "save" | "copy";

// What each kind of card is called in the messages and tooltips about it
const SUBJECTS: Record<CardSpec["kind"], { image: string; noun: string }> = {
  game: { image: "the game image", noun: "game" },
  season: { image: "the season recap", noun: "recap" },
};

interface ExportMessage {
  text: string;
  failed: boolean;
}

interface Busy {
  // The card's route, which is as good an identity as a card has
  card: string;
  action: ImageAction;
}

/**
 * Turning a card into a PNG: the main process draws it and either runs the save
 * dialog or writes the clipboard, so all there is to hold here is which card is
 * in flight and what to say about the one that finished. Pages that offer this
 * from more than one place (a button and a context menu, say) share a single
 * instance so there is only ever one message on screen.
 */
export function useImageExport() {
  const [busy, setBusy] = createSignal<Busy | null>(null);
  const [message, setMessage] = createSignal<ExportMessage | null>(null);
  let timer: ReturnType<typeof setTimeout> | null = null;

  onSettled(() => () => {
    if (timer) clearTimeout(timer);
  });

  const say = (text: string, failed: boolean) => {
    setMessage({ text, failed });
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => setMessage(null), MESSAGE_MS);
  };

  const run = async (card: CardSpec, action: ImageAction) => {
    if (busy() != null) return;
    setBusy({ card: cardRoute(card), action });
    setMessage(null);
    try {
      if (action === "copy") {
        const result = await api.copyCardImage(card);
        if (result.success) say(`Copied ${SUBJECTS[card.kind].image} to the clipboard`, false);
        else if (result.error) say(result.error, true);
      } else {
        const result = await api.exportCardImage(card);
        if (result.success) say(`Saved to ${result.path}`, false);
        // Neither succeeded nor failed: the save dialog was dismissed
        else if (result.error) say(result.error, true);
      }
    } catch (err) {
      say(err instanceof Error ? err.message : String(err), true);
    } finally {
      setBusy(null);
    }
  };

  const busyWith = (card: CardSpec, action: ImageAction) => {
    const current = busy();
    return current != null && current.card === cardRoute(card) && current.action === action;
  };

  return { busyWith, message, run };
}

export function ExportImageMessage(props: { message: ExportMessage | null }) {
  return (
    <Show when={props.message}>
      {(message) => (
        <div class="pointer-events-none fixed bottom-5 left-1/2 z-50 -translate-x-1/2">
          <div
            role="status"
            class={[
              "menu view-in flex max-w-[600px] items-center gap-2.5 px-3.5 py-2.5 text-[13px]",
              message().failed ? "border-lol-loss/45 text-lol-loss" : "text-lol-text-bright",
            ]}
          >
            <span
              class={[
                "h-1.5 w-1.5 shrink-0 rounded-full",
                message().failed ? "bg-lol-loss" : "bg-lol-win",
              ]}
            />
            <span class="truncate">{message().text}</span>
          </div>
        </div>
      )}
    </Show>
  );
}

const LABELS: Record<ImageAction, { idle: string; busy: string; title: (noun: string) => string }> =
  {
    save: {
      idle: "Export PNG",
      busy: "Exporting...",
      title: (noun) => `Save this ${noun} as a PNG`,
    },
    copy: {
      idle: "Copy Image",
      busy: "Copying...",
      title: (noun) => `Copy this ${noun}'s image to the clipboard`,
    },
  };

export function ExportImageButton(props: {
  action: ImageAction;
  card: CardSpec;
  exporting: ReturnType<typeof useImageExport>;
}) {
  const labels = () => LABELS[props.action];
  const busy = () => props.exporting.busyWith(props.card, props.action);

  return (
    <button
      onClick={() => void props.exporting.run(props.card, props.action)}
      disabled={busy()}
      title={labels().title(SUBJECTS[props.card.kind].noun)}
      class="btn"
    >
      <Dynamic component={props.action === "copy" ? CopyIcon : ImageIcon} class="h-4 w-4" />
      {busy() ? labels().busy : labels().idle}
    </button>
  );
}
