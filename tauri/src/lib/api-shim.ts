import { INVOKE_CHANNELS, type ElectronAPI } from "@shared/api";
import { install } from "../api";

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

// window.api when something provides it (the replay API in parity runs), else
// T08's api.ts over the Rust commands once lib.rs's boot script has run. Read at
// import, before any other module, because the locale and platform are.
const provided = window.api as ElectronAPI | undefined;
export const api: ElectronAPI = provided ?? (window.__BMT_BOOT__ ? install() : notPortedApi());
