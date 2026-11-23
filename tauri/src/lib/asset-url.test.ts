import { describe, expect, test } from "bun:test";
import * as shared from "../../../src/shared/game-assets";
import { WEBVIEW2_BASE, forWebview, isWebView2 } from "./asset-url";

const urls = [
  shared.championIconUrl(266),
  shared.profileIconUrl(29),
  shared.championSplashUrl(1),
  shared.gameAssetUrl(
    "16.22",
    "/lol-game-data/assets/ASSETS/Items/Icons2D/1001_Class_T1_BootsofSpeed.png",
  ),
  shared.gameAssetUrl("pbe", "v1/champion-icons/950.png"),
];

describe("asset-url", () => {
  test("WebKit keeps the URLs Electron's renderer builds", () => {
    for (const url of urls) expect(forWebview(url, false)).toBe(url);
  });

  test("WebView2 moves the scheme to http://asset.localhost and keeps the rest", () => {
    for (const url of urls) {
      const routed = forWebview(url, true);
      expect(routed.startsWith(WEBVIEW2_BASE)).toBe(true);
      expect(routed.slice(WEBVIEW2_BASE.length)).toBe(url.slice("asset://".length));
    }
    expect(forWebview(shared.championSplashUrl(7), true)).toBe("http://asset.localhost/splash/7");
  });

  test("other URLs pass through", () => {
    expect(forWebview("data:image/png;base64,AA", true)).toBe("data:image/png;base64,AA");
    expect(forWebview("https://example.com/a.png", true)).toBe("https://example.com/a.png");
  });

  test("only WebView2 counts as Windows", () => {
    expect(isWebView2("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Edg/140")).toBe(true);
    expect(isWebView2("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605")).toBe(
      false,
    );
  });
});
