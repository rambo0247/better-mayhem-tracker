import { afterEach, beforeEach, expect, test } from "bun:test";
import { createRouter, useLocation, useNavigate, type Navigator } from "@solidjs/router";
import { fake } from "../test/fakeApi";
import { mount, settle } from "../test/render";
import { createAppRouter } from "./App";
import { hashHistoryWithState } from "./lib/history";

let view: ReturnType<typeof mount> | undefined;
beforeEach(() => {
  fake.returns.set("checkForUpdate", { hasUpdate: false });
  fake.returns.set("getSeasons", []);
  fake.returns.set("getLcuStatus", "disconnected");
  fake.returns.set("getProfile", null);
  window.history.replaceState(null, "", "#/");
});
afterEach(() => {
  view?.dispose();
  fake.reset();
});

function currentLinks() {
  return [...view!.container.querySelectorAll("a[aria-current]")].map(
    (a) => `${a.getAttribute("href")} ${a.getAttribute("aria-current")}`,
  );
}

function link(href: string) {
  return view!.container.querySelector<HTMLAnchorElement>(`a[href="${href}"]`)!;
}

function openPage() {
  return view!.container.querySelector("[data-stub-page]")?.getAttribute("data-stub-page");
}

test("on an http origin only the open page's nav link is current", async () => {
  expect(window.location.origin).toBe("http://localhost");
  const Router = createAppRouter((name) => () => <p data-stub-page={name} />);
  view = mount(() => <Router>{(props) => props.children}</Router>);
  await settle();
  expect(openPage()).toBe("MatchHistory");
  expect(currentLinks()).toEqual(["#/ page"]);

  link("#/records").click();
  await settle();
  expect(window.location.hash).toBe("#/records");
  expect(openPage()).toBe("Records");
  expect(currentLinks()).toEqual(["#/records page"]);

  link("#/").click();
  await settle();
  expect(openPage()).toBe("MatchHistory");
  expect(currentLinks()).toEqual(["#/ page"]);
  expect(view.container.querySelector("[data-active]")).toBeNull();
});

test("location state survives Back and Forward", async () => {
  let navigate!: Navigator;
  function Probe() {
    navigate = useNavigate();
    const location = useLocation();
    return <p>{JSON.stringify(location.state ?? null)}</p>;
  }
  const Router = createRouter({
    routes: [{ path: "/*", component: Probe }],
    history: hashHistoryWithState(),
    explicitLinks: true,
  });
  view = mount(() => <Router>{(props) => props.children}</Router>);
  const shown = () => view!.container.textContent;

  navigate("/", { state: { championId: 7 } });
  await settle();
  expect(shown()).toBe('{"championId":7}');
  navigate("/records");
  await settle();
  expect(shown()).toBe("null");

  window.history.back();
  await settle();
  expect(window.location.hash).toBe("#/");
  expect(shown()).toBe('{"championId":7}');
  window.history.forward();
  await settle();
  expect(shown()).toBe("null");
});
