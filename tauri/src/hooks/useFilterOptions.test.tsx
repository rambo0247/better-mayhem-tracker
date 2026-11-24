import { afterEach, beforeEach, expect, test } from "bun:test";
import { fake } from "../../test/fakeApi";
import { mount, settle } from "../../test/render";
import PatchSelect from "../components/PatchSelect";
import { EMPTY_FILTER_OPTIONS } from "./useFilterOptions";

let views: ReturnType<typeof mount>[] = [];
beforeEach(() => fake.reset());
afterEach(() => {
  for (const view of views) view.dispose();
  views = [];
});

const noop = () => {};
const requests = () => fake.calls.filter((c) => c.method === "getMatchFilterOptions").length;
const patchesShown = (view: ReturnType<typeof mount>) =>
  [...view.container.querySelectorAll("select")].map((select) =>
    [...select.options].map((o) => o.value).filter(Boolean),
  );

function answerLater() {
  let answer!: (patches: string[]) => void;
  fake.returns.set(
    "getMatchFilterOptions",
    new Promise((resolve) => {
      answer = (patches) => resolve({ ...EMPTY_FILTER_OPTIONS, patches });
    }),
  );
  return (patches: string[]) => answer(patches);
}

test("dropdowns mounted while the options are on their way share one request", async () => {
  const answer = answerLater();
  views.push(
    mount(() => (
      <>
        <PatchSelect value={undefined} onChange={noop} />
        <PatchSelect value={undefined} onChange={noop} />
      </>
    )),
  );
  expect(patchesShown(views[0]!)).toEqual([[], []]);
  views.push(mount(() => <PatchSelect value={undefined} onChange={noop} />));
  await settle();
  expect(requests()).toBe(1);

  answer(["16.2", "16.1"]);
  await settle();
  expect(views.map(patchesShown)).toEqual([
    [
      ["16.2", "16.1"],
      ["16.2", "16.1"],
    ],
    [["16.2", "16.1"]],
  ]);
});

test("a dropdown mounted after new games land never gets the options read before them", async () => {
  const before = answerLater();
  views.push(mount(() => <PatchSelect value={undefined} onChange={noop} />));
  await settle();

  const after = answerLater();
  fake.emit("onGamesUpdated");
  views.push(mount(() => <PatchSelect value={undefined} onChange={noop} />));
  await settle();

  before(["16.1"]);
  await settle();
  after(["16.2", "16.1"]);
  await settle();
  expect(views.map(patchesShown)).toEqual([[["16.2", "16.1"]], [["16.2", "16.1"]]]);
});

test("a dropdown mounted after the answer asks again, starting from no options", async () => {
  fake.returns.set("getMatchFilterOptions", { ...EMPTY_FILTER_OPTIONS, patches: ["16.1"] });
  views.push(mount(() => <PatchSelect value={undefined} onChange={noop} />));
  await settle();

  const later = answerLater();
  const view = mount(() => <PatchSelect value={undefined} onChange={noop} />);
  views.push(view);
  expect(patchesShown(view)).toEqual([[]]);
  later(["16.2"]);
  await settle();
  expect(requests()).toBe(2);
  expect(patchesShown(view)).toEqual([["16.2"]]);
});
