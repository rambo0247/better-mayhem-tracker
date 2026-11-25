import { afterEach, beforeAll, expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { mount, settle } from "../../test/render";
import { fake } from "../../test/fakeApi";
import { FAKE_API } from "../../test/parity-cases";
import { dropdown, dropdowns, open, optionLabels, pick, shown } from "../../test/select";
import Select from "./Select";
import FilterMenu from "./FilterMenu";
import QueueSelect from "./QueueSelect";
import PatchSelect from "./PatchSelect";
import SeasonSelect from "./SeasonSelect";
import AccountSelect from "./AccountSelect";

let view: ReturnType<typeof mount> | undefined;
afterEach(() => {
  view?.dispose();
  view = undefined;
});

beforeAll(() => {
  for (const [method, value] of Object.entries(FAKE_API)) fake.returns.set(method, value);
});

const OPTIONS = [
  { value: undefined, label: "All Queues" },
  { value: 2400, label: "ARAM Mayhem" },
  { value: 450, label: "ARAM", disabled: true },
  { value: 2450, label: "Mayhem Classic" },
];

function setup(initial?: number) {
  const [value, setValue] = createSignal<number | undefined>(initial);
  const picked: (number | undefined)[] = [];
  view = mount(() => (
    <Select
      value={value()}
      options={OPTIONS}
      onChange={(v) => {
        picked.push(v);
        setValue(v);
      }}
      aria-label="Queue"
    />
  ));
  return { button: dropdowns(view.container)[0]!, picked, value };
}

// One key press, applied before the next, as separate presses are
const key = async (el: Element, k: string) => {
  el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  await settle();
};

test("shows the chosen option, and the first one until the value's option exists", async () => {
  const { button } = setup(2450);
  expect(shown(button)).toBe("Mayhem Classic");
  view!.dispose();
  const unknown = setup(9999);
  expect(shown(unknown.button)).toBe("All Queues");
});

test("a click opens the app's own list, marks the choice, and picking closes it", async () => {
  const { button, picked } = setup(2400);
  const list = await open(button);
  expect(button.getAttribute("aria-expanded")).toBe("true");
  expect(list.getAttribute("role")).toBe("listbox");
  expect(list.parentElement).toBe(document.body);
  const selected = list.querySelector('[aria-selected="true"]')!;
  expect(selected.textContent).toBe("ARAM Mayhem");

  await pick(button, "Mayhem Classic");
  expect(picked).toEqual([2450]);
  expect(button.getAttribute("aria-expanded")).toBe("false");
  expect(shown(button)).toBe("Mayhem Classic");
});

test("a disabled option can't be picked, and picking the current one changes nothing", async () => {
  const { button, picked } = setup(2400);
  await pick(button, "ARAM");
  expect(picked).toEqual([]);
  await pick(button, "ARAM Mayhem");
  expect(picked).toEqual([]);
});

test("the keyboard walks past disabled options, and Escape closes without picking", async () => {
  const { button, picked } = setup(2400);
  await key(button, "ArrowDown");
  expect(button.getAttribute("aria-expanded")).toBe("true");
  await key(button, "ArrowDown");
  await key(button, "Enter");
  // ARAM is skipped
  expect(picked).toEqual([2450]);

  await key(button, "ArrowDown");
  await key(button, "Home");
  await key(button, "Escape");
  expect(button.getAttribute("aria-expanded")).toBe("false");
  expect(picked).toEqual([2450]);
});

test("typing a letter jumps to the option it starts", async () => {
  const { button, picked } = setup(undefined);
  await key(button, "m");
  expect(picked).toEqual([2450]);
});

test("a click outside closes the list", async () => {
  const { button } = setup(2400);
  await open(button);
  document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  await settle();
  expect(button.getAttribute("aria-expanded")).toBe("false");
});

test("inside the Filters menu, picking and Escape close the list, not the menu", async () => {
  view = mount(() => (
    <FilterMenu active={0} onReset={() => {}}>
      <QueueSelect value={undefined} onChange={() => {}} label="Queue" />
    </FilterMenu>
  ));
  await settle();
  const toggle = view.container.querySelector<HTMLButtonElement>('button[title="Filters"]')!;
  toggle.click();
  await settle();
  const queue = dropdown(view.container, "All Queues");

  const list = await open(queue);
  const option = list.querySelector<HTMLElement>('[role="option"]:last-child')!;
  option.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  option.click();
  await settle();
  expect(toggle.getAttribute("aria-expanded")).toBe("true");

  await open(queue);
  await key(queue, "Escape");
  expect(queue.getAttribute("aria-expanded")).toBe("false");
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
});

// What test/v1-dom-snapshots.json held for these before they left the
// system's select behind: the same choices, in the same order
test("the filter dropdowns list the same choices as before", async () => {
  view = mount(() => (
    <>
      <QueueSelect value={2450} onChange={() => {}} />
      <PatchSelect value="15.19" onChange={() => {}} label="Patch" />
      <SeasonSelect value={undefined} onChange={() => {}} />
      <AccountSelect value="puuid-b" onChange={() => {}} />
    </>
  ));
  await settle();
  const [queue, patch, season, account] = dropdowns(view.container);
  expect(shown(queue!)).toBe("Mayhem Classic");
  expect(await optionLabels(queue!)).toEqual(["All Queues", "ARAM Mayhem", "Mayhem Classic"]);
  expect(shown(patch!)).toBe("Patch 25.19");
  expect(await optionLabels(patch!)).toEqual(["All Patches", "Patch 25.20", "Patch 25.19"]);
  expect(view.container.textContent).toContain("Patch");
  expect(shown(season!)).toBe("All Sets");
  expect(await optionLabels(season!)).toEqual(["All Sets", "s1", "s2"]);
  expect(shown(account!)).toBe("Unknown account");
  expect(await optionLabels(account!)).toEqual(["All Accounts", "First#NA1", "Unknown account"]);
});
