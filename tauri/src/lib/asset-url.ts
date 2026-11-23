// The renderer's League art URLs, from the same builders the Electron renderer uses, in the form
// this platform's webview routes. WebKit serves the app's `asset:` scheme as `asset://...`.
// WebView2 routes custom schemes only as `http://<scheme>.localhost`, so on Windows the URL
// becomes `http://asset.localhost/...` and the kind ("game-data", "splash") moves from the host
// to the first path segment, which `assets.rs` reads either way.
import * as shared from "../shared/game-assets";

export { ASSET_SCHEME, gameDataPath, isPatchBranch } from "../shared/game-assets";

const SCHEME_BASE = `${shared.ASSET_SCHEME}://`;
export const WEBVIEW2_BASE = `http://${shared.ASSET_SCHEME}.localhost/`;

export const isWebView2 = (userAgent: string = globalThis.navigator?.userAgent ?? ""): boolean =>
  userAgent.includes("Windows");

/** An `asset://` URL as this webview routes it. Any other URL is returned as it is. */
export function forWebview(url: string, webView2: boolean = isWebView2()): string {
  return webView2 && url.startsWith(SCHEME_BASE)
    ? WEBVIEW2_BASE + url.slice(SCHEME_BASE.length)
    : url;
}

export const gameAssetUrl = (branch: string, iconPath: string): string =>
  forWebview(shared.gameAssetUrl(branch, iconPath));

export const championIconUrl = (id: number): string => forWebview(shared.championIconUrl(id));

export const profileIconUrl = (id: number): string => forWebview(shared.profileIconUrl(id));

export const championSplashUrl = (id: number): string => forWebview(shared.championSplashUrl(id));
