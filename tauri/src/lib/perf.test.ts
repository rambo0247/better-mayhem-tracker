import { afterEach, expect, test } from "bun:test";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { reportFirstContent } from "./perf";

const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));

afterEach(() => {
  clearMocks();
  document.body.innerHTML = "";
});

test("first content names the first match-history row, which T06's probe checks", async () => {
  const sent: unknown[] = [];
  mockIPC((cmd, args) => {
    if (cmd === "page_event") sent.push(args);
  });
  document.body.innerHTML = `<button class="group relative flex w-full">VICTORY Kog'Maw</button>`;
  reportFirstContent();
  await frame();
  await frame();
  await frame();
  expect(sent).toEqual([{ name: "first-content", row: "VICTORY Kog'Maw" }]);
});
