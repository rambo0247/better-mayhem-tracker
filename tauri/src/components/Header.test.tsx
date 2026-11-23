import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { createRouter } from "@solidjs/router";
import { fake } from "../../test/fakeApi";
import { mount, settle } from "../../test/render";
import { hashHistoryWithState } from "../lib/history";
import Header from "./Header";
import Layout from "./Layout";

let view: ReturnType<typeof mount> | undefined;
beforeEach(() => {
  fake.returns.set("checkForUpdate", { hasUpdate: true, latest: "9.9.9" });
  fake.returns.set("getSeasons", []);
  fake.returns.set("getLcuStatus", "disconnected");
  fake.returns.set("getProfile", null);
  window.history.replaceState(null, "", "#/");
});
afterEach(() => {
  view?.dispose();
  fake.reset();
  setSystemTime();
  (window.api as { platform: string }).platform = "darwin";
});

const checks = () => fake.calls.filter((c) => c.method === "checkForUpdate").length;

test("update checks pause while the update dialog is open and go on once it closes", async () => {
  const Router = createRouter({
    routes: [{ path: "/*", component: Header }],
    history: hashHistoryWithState(),
    explicitLinks: true,
  });
  view = mount(() => <Router>{(props) => props.children}</Router>);
  await settle();
  expect(checks()).toBe(1);

  view.container
    .querySelector<HTMLButtonElement>('button[title="Update to version 9.9.9"]')!
    .click();
  await settle();
  // Coming back to the window after the recheck interval asks again, but not
  // while the dialog is up, as React's poll skips then
  const returnLater = async () => {
    setSystemTime(Date.now() + 11 * 60 * 1000);
    window.dispatchEvent(new Event("focus"));
    await settle();
  };
  await returnLater();
  expect(checks()).toBe(1);

  const notNow = [...document.querySelectorAll("button")].find((b) => b.textContent === "Not Now");
  notNow!.click();
  await settle();
  await returnLater();
  expect(checks()).toBe(2);
});

// WKWebView ignores -webkit-app-region, so every area Electron dragged by also
// carries Tauri's attribute, and nothing clickable starts a drag
for (const platform of ["darwin", "win32"]) {
  test(`the window drags by the title bar and sidebar top on ${platform}, never by a control`, async () => {
    (window.api as { platform: string }).platform = platform;
    const Router = createRouter({
      routes: [{ path: "/", component: Layout, children: [{ path: "/", component: () => null }] }],
      history: hashHistoryWithState(),
      explicitLinks: true,
    });
    view = mount(() => <Router>{(props) => props.children}</Router>);
    await settle();
    const c = view.container;

    const drag = [...c.querySelectorAll(".titlebar-drag")];
    expect(drag.length).toBe(3);
    for (const el of drag) expect(el.getAttribute("data-tauri-drag-region")).toBe("deep");

    const noDrag = [...c.querySelectorAll(".titlebar-no-drag")];
    expect(noDrag.length).toBe(platform === "darwin" ? 0 : 1);
    for (const el of noDrag) expect(el.getAttribute("data-tauri-drag-region")).toBe("false");
    if (platform !== "darwin") expect(noDrag[0]!.querySelectorAll("button").length).toBe(3);

    const controls = [...c.querySelectorAll("a, button, input, select")];
    expect(controls.length).toBeGreaterThan(0);
    for (const el of controls) {
      expect(el.hasAttribute("data-tauri-drag-region")).toBe(false);
      const region = el.closest("[data-tauri-drag-region]");
      expect(region?.getAttribute("data-tauri-drag-region") ?? "none").not.toBe("deep");
    }
  });
}
