import { afterEach, expect, test } from "bun:test";
import { mount } from "../../test/render";
import WinRateBar from "./WinRateBar";

let view: ReturnType<typeof mount> | undefined;
afterEach(() => view?.dispose());

test("WinRateBar fills to the win rate and colours a winning record", () => {
  view = mount(() => <WinRateBar wins={6} total={10} />);
  const fill = view.container.querySelector<HTMLElement>(".bg-gradient-to-r")!;
  expect(fill.style.width).toBe("60%");
  const label = view.container.querySelector(".font-num")!;
  expect(label.textContent).toBe("60.0%");
  expect(label.classList.contains("text-lol-win")).toBe(true);
});
