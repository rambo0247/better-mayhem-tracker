import { afterEach, expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { CARD_STATUS_KEY } from "@shared/card";
import { mount } from "../../test/render";
import { useCardCapture } from "./useCardCapture";

let view: ReturnType<typeof mount> | undefined;
afterEach(() => {
  view?.dispose();
  delete (window as unknown as Record<string, unknown>)[CARD_STATUS_KEY];
});

const status = () =>
  (window as unknown as Record<string, { state: string } | undefined>)[CARD_STATUS_KEY];
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a drawn card settles while what it was drawn from keeps changing", async () => {
  const [games, setGames] = createSignal(1);
  function Card() {
    const ref = useCardCapture(
      () => games() > 0,
      () => null,
    );
    return <div ref={ref} />;
  }
  view = mount(() => <Card />);
  // Faster than the settle check looks, for longer than it takes to settle
  for (let i = 0; i < 12; i++) {
    setGames((n) => n + 1);
    await wait(60);
  }
  expect(status()?.state).toBe("ready");
});
