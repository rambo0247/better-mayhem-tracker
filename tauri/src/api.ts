// `window.api` on Tauri: the same object Electron's preload builds, method for
// method, so a page calls what it called under Electron. Requests go through
// the generated wrappers in bindings.ts; events are the main window's own.
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { createCommands, type RendererEvents, type Transport } from "./bindings";

export type { RendererEvents, Transport };

type Unsubscribe = () => void;

/** `window.api`: every command, the boot values, and one `on*` subscription per window event. */
export interface Api extends ReturnType<typeof createCommands> {
  /** The OS the page matches: the title bar draws window controls only where the OS has none. */
  platform: string;
  /** Windows' regional format, for every date and number the page prints; undefined for a tag that is no locale. */
  locale: string | undefined;
  onBackfillDone: (callback: (result: RendererEvents["lcu:backfill-done"]) => void) => Unsubscribe;
  onBackfillProgress: (
    callback: (progress: RendererEvents["lcu:backfill-progress"]) => void,
  ) => Unsubscribe;
  onLiveGame: (callback: (snapshot: RendererEvents["live:changed"]) => void) => Unsubscribe;
  onChallengesChanged: (
    callback: (result: RendererEvents["challenges:changed"]) => void,
  ) => Unsubscribe;
  onStatusChanged: (
    callback: (status: RendererEvents["lcu:status-changed"]) => void,
  ) => Unsubscribe;
  onGamesUpdated: (callback: () => void) => Unsubscribe;
  onUpdateProgress: (callback: (percent: number) => void) => Unsubscribe;
  onUpdateInstalling: (
    callback: (update: RendererEvents["update:installing"]) => void,
  ) => Unsubscribe;
  onUpdateInstallFailed: (callback: (error: string) => void) => Unsubscribe;
  onImportProgress: (
    callback: (progress: RendererEvents["data:import-progress"]) => void,
  ) => Unsubscribe;
  onMaximizedChanged: (callback: (maximized: boolean) => void) => Unsubscribe;
}

// What lib.rs's boot script sets before any page script runs
interface Boot {
  platform: string;
  locale: string | null;
}

declare global {
  interface Window {
    __BMT_BOOT__?: Boot;
    api: Api;
  }
}

/** `Error.prototype.toString`, which Electron's invoke message is built from. */
const errorText = (name: string, message: string) =>
  name === "" ? message : message === "" ? name : `${name}: ${message}`;

/** The error Electron's `ipcRenderer.invoke` rejects with, with `code` set for an unported command. */
export class InvokeError extends Error {
  readonly code: string | undefined;
  constructor(channel: string, name: string, message: string, code?: string) {
    super(`Error invoking remote method '${channel}': ${errorText(name, message)}`);
    this.code = code;
  }
}

interface CommandError {
  name: string;
  message: string;
  code?: string;
}

const isCommandError = (value: unknown): value is CommandError =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as CommandError).name === "string" &&
  typeof (value as CommandError).message === "string";

/**
 * Rebuilds Electron's rejection. A command rejects with its `CommandError`; Tauri itself
 * rejects with a string, for a bad argument, or for a command that does not exist or that
 * the ACL refuses (`<channel> not allowed ...` in debug builds), both of which Electron
 * reports as an unregistered handler. tests/golden.rs's `renderer_message` mirrors this.
 */
export function invokeError(channel: string, reason: unknown): InvokeError {
  if (isCommandError(reason))
    return new InvokeError(channel, reason.name, reason.message, reason.code);
  const text = String(reason);
  const unregistered =
    text === `Command ${channel} not found` ||
    text === `Command ${channel} not allowed by ACL` ||
    text.startsWith(`${channel} not allowed`);
  if (unregistered) {
    return new InvokeError(channel, "Error", `No handler registered for '${channel}'`);
  }
  return new InvokeError(channel, "Error", text);
}

/** js_arg.rs's `NON_FINITE_KEY`. */
const NON_FINITE_KEY = "$bmtNum";

/**
 * Tauri sends arguments as JSON, which writes NaN and the infinities as `null`, and a handler
 * reads `null` as absent. Electron's structured clone keeps the number, so `Number("x")` from
 * a route still filters by it there. Each such number goes as `{ $bmtNum: "NaN" }`, which
 * `Js` in js_arg.rs reads back as the number.
 */
export function encodeNonFinite(value: unknown): unknown {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : { [NON_FINITE_KEY]: String(value) };
  }
  if (Array.isArray(value)) return value.map(encodeNonFinite);
  if (
    typeof value === "object" &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encodeNonFinite(v)]));
  }
  return value;
}

/** db/js.rs's `Cell` writes a blob as `{ $bytes: base64 }`. */
const BYTES_KEY = "$bytes";

/**
 * The answer side of [`encodeNonFinite`]: a non-finite number Rust wrote as `{ $bmtNum }`
 * becomes the number, and a blob written as `{ $bytes }` the Uint8Array Electron's IPC hands
 * the page for a Buffer. An object with any other key stays as it is.
 */
export function decodeAnswer(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeAnswer);
  if (typeof value !== "object" || value === null) return value;
  const entries = Object.entries(value);
  if (entries.length === 1) {
    const [key, inner] = entries[0]!;
    if (key === NON_FINITE_KEY && typeof inner === "string") return Number(inner);
    if (key === BYTES_KEY && typeof inner === "string") {
      return Uint8Array.from(atob(inner), (c) => c.charCodeAt(0));
    }
  }
  return Object.fromEntries(entries.map(([k, v]) => [k, decodeAnswer(v)]));
}

export const tauriTransport: Transport = <T>(channel: string, args: Record<string, unknown>) =>
  invoke<T>(channel, encodeNonFinite(args) as Record<string, unknown>).then(
    (answer) => decodeAnswer(answer) as T,
    (reason: unknown) => {
      throw invokeError(channel, reason);
    },
  );

/** Registers a listener for one event of the main window, resolving to its unlisten. */
export type Listen = <T>(event: string, handler: (payload: T) => void) => Promise<Unsubscribe>;

/** Rust emits payloads with the same `{ $bmtNum }` and `{ $bytes }` sentinels it answers with. */
export const windowListen: Listen = (event, handler) =>
  getCurrentWebviewWindow().listen(event, (e) => handler(decodeAnswer(e.payload) as never));

/**
 * Electron's `on*` hands back its unsubscribe at once; Tauri's `listen` resolves to one.
 * Unsubscribing before it resolves still removes the listener when it does. Electron's
 * `on*` never rejects, so a failed `listen` is logged, not left unhandled.
 */
function subscriber(listen: Listen) {
  return <E extends keyof RendererEvents>(event: E) =>
    (callback: (payload: RendererEvents[E]) => void): Unsubscribe => {
      let cancelled = false;
      let unlisten: Unsubscribe | undefined;
      listen<RendererEvents[E]>(event, callback)
        .then((stop) => {
          if (cancelled) stop();
          else unlisten = stop;
        })
        .catch((error: unknown) => console.error(`listening for ${event} failed`, error));
      return () => {
        cancelled = true;
        unlisten?.();
        unlisten = undefined;
      };
    };
}

export function createApi(
  transport: Transport = tauriTransport,
  listen: Listen = windowListen,
): Api {
  const boot = window.__BMT_BOOT__;
  // lib.rs sets it before any page script; without it platform would read as ""
  if (!boot) throw new Error("window.__BMT_BOOT__ is not set; lib.rs's boot script did not run");
  const commands = createCommands(transport);
  const subscribe = subscriber(listen);
  const onGamesUpdated = subscribe("lcu:games-updated");
  return {
    platform: boot.platform,
    locale: boot.locale ?? undefined,
    ...commands,
    onBackfillDone: subscribe("lcu:backfill-done"),
    onBackfillProgress: subscribe("lcu:backfill-progress"),
    onLiveGame: subscribe("live:changed"),
    onChallengesChanged: subscribe("challenges:changed"),
    onStatusChanged: subscribe("lcu:status-changed"),
    onGamesUpdated: (callback) => onGamesUpdated(() => callback()),
    onUpdateProgress: subscribe("update:progress"),
    onUpdateInstalling: subscribe("update:installing"),
    onUpdateInstallFailed: subscribe("update:install-failed"),
    onImportProgress: subscribe("data:import-progress"),
    onMaximizedChanged: subscribe("window:maximized-changed"),
  };
}

/** Sets `window.api`, for a page that reads it as Electron's renderer does. */
export function install(transport?: Transport, listen?: Listen): Api {
  const api = createApi(transport, listen);
  window.api = api;
  return api;
}
