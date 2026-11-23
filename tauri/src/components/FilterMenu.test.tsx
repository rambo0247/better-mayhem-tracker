import { afterEach, expect, test } from "bun:test";
import { mount, settle } from "../../test/render";
import FilterMenu from "./FilterMenu";

let view: ReturnType<typeof mount> | undefined;
afterEach(() => view?.dispose());

const escape = () =>
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

function setup() {
  view = mount(() => (
    <>
      <button id="elsewhere">Elsewhere</button>
      <FilterMenu active={0} onReset={() => {}}>
        <button id="item">Item</button>
      </FilterMenu>
    </>
  ));
  const toggle = view.container.querySelector<HTMLButtonElement>('button[title="Filters"]')!;
  const open = () => toggle.getAttribute("aria-expanded") === "true";
  return { toggle, open };
}

// A click leaves the toggle unfocused in WebKit on macOS and in this DOM, while
// Chromium focuses it on the press, so Escape leaves focus on it in Electron
test("Escape after a click opened the menu puts focus on the toggle", async () => {
  const { toggle, open } = setup();
  toggle.click();
  await settle();
  expect(open()).toBe(true);
  expect(document.activeElement).not.toBe(toggle);

  escape();
  await settle();
  expect(open()).toBe(false);
  expect(document.activeElement).toBe(toggle);
});

test("Escape from a control inside the menu puts focus on the toggle", async () => {
  const { toggle, open } = setup();
  toggle.focus();
  toggle.click();
  await settle();
  view!.container.querySelector<HTMLButtonElement>("#item")!.focus();

  escape();
  await settle();
  expect(open()).toBe(false);
  expect(document.activeElement).toBe(toggle);
});

test("Escape leaves focus alone when it is on a control outside the menu", async () => {
  const { toggle, open } = setup();
  toggle.click();
  await settle();
  const elsewhere = view!.container.querySelector<HTMLButtonElement>("#elsewhere")!;
  elsewhere.focus();
  await settle();
  expect(open()).toBe(true);

  escape();
  await settle();
  expect(document.activeElement).toBe(elsewhere);
});
