import { INVOKE_CHANNELS, type ElectronAPI } from "@shared/api";

declare global {
  interface Window {
    api?: ElectronAPI;
  }
}

// Every channel fails the way T08's Rust stubs do, so the shell still renders
// in a plain Tauri run with nothing behind it
function notPortedApi(): ElectronAPI {
  const api: Record<string, unknown> = {
    platform: navigator.userAgent.includes("Mac") ? "darwin" : "win32",
    locale: undefined,
  };
  for (const [method, channel] of Object.entries(INVOKE_CHANNELS)) {
    api[method] = () =>
      Promise.reject(new Error(`Error invoking remote method '${channel}': Error: not ported`));
  }
  return new Proxy(api, {
    get: (target, key) =>
      key in target || typeof key !== "string" || !key.startsWith("on")
        ? target[key as string]
        : () => () => {},
  }) as unknown as ElectronAPI;
}

// The preload's window.api until T08's generated api.ts replaces this module.
// Read at import, before any other module, because the locale and platform are.
export const api: ElectronAPI = window.api ?? notPortedApi();
