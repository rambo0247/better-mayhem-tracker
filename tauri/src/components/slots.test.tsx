import { afterEach, beforeEach, expect, test } from "bun:test";
import { fake } from "../../test/fakeApi";
import { mount, settle } from "../../test/render";
import PageHeader from "./PageHeader";
import QueueSelect from "./QueueSelect";
import StatCard from "./StatCard";

// React wraps a slot whenever its prop is set (`{actions && <div>…</div>}`),
// even when what the prop holds draws nothing, like Trends' QueueSelect on a
// database with one queue. The empty wrapper still takes a flex gap.

let view: ReturnType<typeof mount> | undefined;
beforeEach(() => {
  fake.returns.set("getMatchFilterOptions", { patches: [], queues: [2400], seasons: [] });
});
afterEach(() => {
  view?.dispose();
  fake.reset();
});

const noop = () => {};

test("PageHeader keeps each slot's wrapper when the slot draws nothing", async () => {
  view = mount(() => (
    <PageHeader
      kicker={<QueueSelect value={undefined} onChange={noop} />}
      title="Trends"
      subtitle={<QueueSelect value={undefined} onChange={noop} />}
      actions={<QueueSelect value={undefined} onChange={noop} />}
    />
  ));
  await settle();
  const c = view.container;
  expect(c.querySelector("select")).toBeNull();
  expect(c.querySelector(".kicker")?.innerHTML).toBe("");
  expect(c.querySelector(".mt-2")?.innerHTML).toBe("");
  expect(c.querySelector(".gap-2")?.innerHTML).toBe("");
});

test("PageHeader leaves out the wrapper of a slot set to null", async () => {
  view = mount(() => <PageHeader title="Trends" actions={null} subtitle={undefined} />);
  await settle();
  expect(view.container.querySelector(".gap-2")).toBeNull();
  expect(view.container.querySelector(".mt-2")).toBeNull();
});

test("StatCard keeps each slot's wrapper when the slot draws nothing", async () => {
  view = mount(() => (
    <StatCard
      label="Games"
      accent="gold"
      value={<QueueSelect value={undefined} onChange={noop} />}
      icon={<QueueSelect value={undefined} onChange={noop} />}
      subtext={<QueueSelect value={undefined} onChange={noop} />}
    >
      <QueueSelect value={undefined} onChange={noop} />
    </StatCard>
  ));
  await settle();
  const c = view.container;
  expect(c.querySelector("select")).toBeNull();
  expect(c.querySelector(".font-num")?.innerHTML).toBe("");
  expect(c.querySelector(".rounded-md")?.innerHTML).toBe("");
  expect(c.querySelector(".mt-2")?.innerHTML).toBe("");
  expect(c.querySelector(".mt-auto")?.innerHTML).toBe("");
});

test("StatCard shows a value of 0 and leaves out an unset one", async () => {
  view = mount(() => <StatCard label="Games" value={0} />);
  expect(view.container.querySelector(".font-num")?.textContent).toBe("0");
  view.dispose();
  view = mount(() => <StatCard label="Games" />);
  expect(view.container.querySelector(".font-num")).toBeNull();
});
