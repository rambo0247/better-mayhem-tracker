import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { createRouter } from "@solidjs/router";
import { fake } from "../../test/fakeApi";
import { mount, settle } from "../../test/render";
import { hashHistoryWithState } from "../lib/history";
import Header from "./Header";

let view: ReturnType<typeof mount> | undefined;
beforeEach(() => {
  fake.returns.set("checkForUpdate", { hasUpdate: true, latest: "9.9.9" });
  fake.returns.set("getSeasons", []);
  fake.returns.set("getLcuStatus", "disconnected");
  fake.returns.set("getProfile", null);
});
afterEach(() => {
  view?.dispose();
  fake.reset();
  setSystemTime();
});

const checks = () => fake.calls.filter((c) => c.method === "checkForUpdate").length;

test("update checks go on after the update button is pressed", async () => {
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
  // Coming back to the window after the recheck interval asks again
  setSystemTime(Date.now() + 11 * 60 * 1000);
  window.dispatchEvent(new Event("focus"));
  await settle();
  expect(checks()).toBe(2);
});
