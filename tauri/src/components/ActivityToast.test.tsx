import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { flush } from "solid-js";
import { render } from "@solidjs/web";
import { fake } from "../../test/fakeApi";
import ActivityToast from "./ActivityToast";

let host: HTMLDivElement;
let dispose: () => void;

const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
  flush();
};
const toast = () => host.querySelector('[role="status"]');

async function mount(running = false) {
  fake.returns.set("isBackfillRunning", running);
  dispose = render(() => <ActivityToast />, host);
  flush();
  await settle();
}

beforeEach(() => {
  jest.useFakeTimers();
  fake.reset();
  host = document.createElement("div");
  document.body.append(host);
});
afterEach(() => {
  dispose();
  host.remove();
  jest.useRealTimers();
});

describe("ActivityToast", () => {
  test("renders nothing while idle", async () => {
    await mount();
    expect(toast()).toBeNull();
  });

  test("running: shows the bar and the count", async () => {
    await mount();
    fake.emit("onBackfillProgress", { current: 1200, total: 4000, added: 3 });
    flush();
    expect(toast()?.textContent).toContain("Importing history");
    expect(toast()?.textContent).toContain("1,200");
    expect(toast()?.textContent).toContain("4,000");
    const bar = toast()!.querySelector<HTMLElement>("div[style]")!;
    expect(bar.style.width).toBe("30%");
  });

  test("done: shows the result and hides after 10 s", async () => {
    await mount();
    fake.emit("onBackfillProgress", { current: 5, total: 10, added: 5 });
    flush();
    fake.emit("onBackfillDone", { added: 1234, cancelled: false });
    flush();
    expect(toast()?.textContent).toContain("Imported 1,234 past game(s)");
    jest.advanceTimersByTime(9_900);
    flush();
    expect(toast()).not.toBeNull();
    jest.advanceTimersByTime(200);
    flush();
    expect(toast()).toBeNull();
  });

  test("cancelled and error results hide after 10 s too", async () => {
    await mount();
    fake.emit("onBackfillDone", { added: 7, cancelled: true });
    flush();
    expect(toast()?.textContent).toContain("Import stopped after 7 game(s)");
    jest.advanceTimersByTime(10_000);
    flush();
    expect(toast()).toBeNull();

    fake.emit("onBackfillDone", { error: "Client closed" });
    flush();
    expect(toast()?.textContent).toContain("Import failed: Client closed");
    expect(toast()?.querySelector(".bg-lol-loss")).not.toBeNull();
    jest.advanceTimersByTime(10_000);
    flush();
    expect(toast()).toBeNull();
  });

  test("a run that added nothing leaves no toast", async () => {
    await mount();
    fake.emit("onBackfillDone", { added: 0, cancelled: false });
    flush();
    expect(toast()).toBeNull();
  });
});
