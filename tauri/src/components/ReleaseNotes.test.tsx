import { afterEach, expect, test } from "bun:test";
import { createSignal, flush } from "solid-js";
import { mount } from "../../test/render";
import ReleaseNotes from "./ReleaseNotes";

let view: ReturnType<typeof mount> | undefined;
afterEach(() => view?.dispose());

const releases = () => [
  { version: "1.2.1", publishedAt: "2026-11-01T12:00:00Z", body: "new", url: "" },
  { version: "1.2.0", publishedAt: "2026-10-01T12:00:00Z", body: "old", url: "" },
];

test("what the reader opened stays open when the list arrives again", () => {
  const [list, setList] = createSignal(releases());
  view = mount(() => <ReleaseNotes releases={list()} />);
  const expanded = () =>
    [...view!.container.querySelectorAll("button")].map((b) => b.getAttribute("aria-expanded"));
  expect(expanded()).toEqual(["true", "false"]);

  view.container.querySelectorAll("button")[1]!.click();
  flush();
  expect(expanded()).toEqual(["true", "true"]);

  setList(releases());
  flush();
  expect(expanded()).toEqual(["true", "true"]);
});
