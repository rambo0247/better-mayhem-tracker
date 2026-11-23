// `window.api` on Tauri: the same object Electron's preload builds, method for
// method, so a page calls what it called under Electron. Requests go through
// the generated wrappers in bindings.ts; events are the main window's own.
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { ElectronAPI } from "../../src/shared/api";
import { createCommands, type RendererEvents, type Transport } from "./bindings";

export type { RendererEvents, Transport };

// What lib.rs's boot script sets before any page script runs
interface Boot {
  platform: string;
  locale: string | null;
}

declare global {
  interface Window {
    __BMT_BOOT__?: Boot;
    api: ElectronAPI;
  }
}

/** The error Electron's `ipcRenderer.invoke` rejects with, with `code` set for an unported command. */
export class InvokeError extends Error {
  readonly code: string | undefined;
  constructor(channel: string, name: string, message: string, code?: string) {
    super(`Error invoking remote method '${channel}': ${name}: ${message}`);
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
 * rejects with a string, for a bad argument or for a command that does not exist, which
 * Electron reports as an unregistered handler.
 */
export function invokeError(channel: string, reason: unknown): InvokeError {
  if (isCommandError(reason)) return new InvokeError(channel, reason.name, reason.message, reason.code);
  const text = String(reason);
  if (text === `Command ${channel} not found`) {
    return new InvokeError(channel, "Error", `No handler registered for '${channel}'`);
  }
  return new InvokeError(channel, "Error", text);
}

export const tauriTransport: Transport = <T>(channel: string, args: Record<string, unknown>) =>
  invoke<T>(channel, args).catch((reason: unknown) => {
    throw invokeError(channel, reason);
  });

/** Calls any channel by name, registered or not, as `ipcRenderer.invoke` can. */
export const invokeChannel = <T>(channel: string, args: Record<string, unknown> = {}) =>
  tauriTransport<T>(channel, args, []);

type Unsubscribe = () => void;

/**
 * Electron's `on*` hands back its unsubscribe at once; Tauri's `listen` resolves to one.
 * Unsubscribing before it resolves still removes the listener when it does.
 */
function subscribe<E extends keyof RendererEvents>(event: E) {
  return (callback: (payload: RendererEvents[E]) => void): Unsubscribe => {
    let cancelled = false;
    let unlisten: Unsubscribe | undefined;
    void getCurrentWebviewWindow()
      .listen<RendererEvents[E]>(event, (e) => callback(e.payload))
      .then((stop) => {
        if (cancelled) stop();
        else unlisten = stop;
      });
    return () => {
      cancelled = true;
      unlisten?.();
      unlisten = undefined;
    };
  };
}

export function createApi(transport: Transport = tauriTransport): ElectronAPI {
  const boot = window.__BMT_BOOT__;
  const commands = createCommands(transport);
  const onGamesUpdated = subscribe("lcu:games-updated");
  return {
    platform: boot?.platform ?? "",
    locale: boot?.locale ?? undefined,
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
export function install(transport?: Transport): ElectronAPI {
  const api = createApi(transport);
  window.api = api;
  return api;
}
