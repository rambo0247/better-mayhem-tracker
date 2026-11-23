import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { createSignal, flush } from "solid-js";
import { CARD_STATUS_KEY, type CardStatus } from "@shared/card";
import { mount } from "../../test/render";
import { useCardCapture, useLookupGrace } from "./useCardCapture";

let view: ReturnType<typeof mount> | undefined;

const status = () => (window as unknown as Record<string, CardStatus | undefined>)[CARD_STATUS_KEY];

function fakeImage(src: string, complete: boolean) {
  const img = document.createElement("img");
  img.setAttribute("src", src);
  let done = complete;
  Object.defineProperty(img, "complete", { get: () => done });
  return { img, finish: () => (done = true) };
}

// A card with the images given, drawn once `drawn` says so
function card(opts: { images: ReturnType<typeof fakeImage>[]; height?: number }) {
  const [drawn, setDrawn] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const el = document.createElement("div");
  for (const { img } of opts.images) el.append(img);
  el.getBoundingClientRect = () => ({ height: opts.height ?? 640.3 }) as DOMRect;
  view = mount(() => {
    useCardCapture(drawn, error)(el);
    return el;
  });
  return {
    draw() {
      setDrawn(true);
      flush();
    },
    fail(message: string) {
      setError(message);
      flush();
    },
  };
}

// The check polls every 150 ms
const POLL = 150;
const tick = (ms: number) => jest.advanceTimersByTime(ms);

beforeEach(() => {
  jest.useFakeTimers();
  delete (window as unknown as Record<string, unknown>)[CARD_STATUS_KEY];
});

afterEach(() => {
  view?.dispose();
  view = undefined;
  jest.useRealTimers();
});

test("marks the page as a card window while it is mounted", () => {
  card({ images: [] });
  expect(document.body.classList.contains("card-window")).toBe(true);
  view!.dispose();
  view = undefined;
  expect(document.body.classList.contains("card-window")).toBe(false);
});

test("publishes nothing until the page says it has drawn", () => {
  card({ images: [fakeImage("a.png", true)] });
  tick(POLL * 5);
  expect(status()).toBeUndefined();
});

test("is ready only once every image has arrived, with the card's height", () => {
  const a = fakeImage("a.png", false);
  const b = fakeImage("b.png", true);
  const page = card({ images: [a, b], height: 640.3 });
  page.draw();

  tick(POLL);
  tick(POLL);
  tick(POLL);
  expect(status()).toBeUndefined();

  a.finish();
  tick(POLL);
  expect(status()).toEqual({ state: "ready", height: 641 });
});

test("an image switching to another source restarts the wait", () => {
  const a = fakeImage("a.png", true);
  const page = card({ images: [a] });
  page.draw();

  tick(POLL);
  a.img.setAttribute("src", "a-fallback.png");
  tick(POLL);
  expect(status()).toBeUndefined();
  tick(POLL);
  expect(status()).toEqual({ state: "ready", height: 641 });
});

test("stops checking once ready", () => {
  const page = card({ images: [fakeImage("a.png", true)], height: 500 });
  page.draw();
  tick(POLL * 2);
  expect(status()).toEqual({ state: "ready", height: 500 });
  delete (window as unknown as Record<string, unknown>)[CARD_STATUS_KEY];
  tick(POLL * 5);
  expect(status()).toBeUndefined();
});

test("gives up waiting on an image that never arrives and is ready anyway", () => {
  const page = card({ images: [fakeImage("slow.png", false)], height: 700 });
  page.draw();
  tick(9_000);
  expect(status()).toBeUndefined();
  tick(2_000);
  expect(status()).toEqual({ state: "ready", height: 700 });
});

test("publishes an error, with no height, and never goes ready", () => {
  const page = card({ images: [fakeImage("a.png", true)] });
  page.fail("That season isn't available");
  expect(status()).toEqual({ state: "error", height: 0, error: "That season isn't available" });
  page.draw();
  tick(POLL * 5);
  expect(status()).toEqual({ state: "error", height: 0, error: "That season isn't available" });
});

test("the lookup grace lapses after three seconds", () => {
  let overdue!: () => boolean;
  view = mount(() => {
    overdue = useLookupGrace();
    return document.createElement("div");
  });
  expect(overdue()).toBe(false);
  tick(2_900);
  flush();
  expect(overdue()).toBe(false);
  tick(200);
  flush();
  expect(overdue()).toBe(true);
});
