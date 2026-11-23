import { invoke } from "@tauri-apps/api/core";

let reported = false;

// T06's launch probe reads this line: the moment the first page put its first
// row on screen. Two frames, so the row has been painted and not only laid out.
export function reportFirstContent(): void {
  if (reported) return;
  reported = true;
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      invoke("page_event", { name: "first-content" }).catch((error: unknown) =>
        console.warn("first-content was not logged:", error),
      );
    }),
  );
}
