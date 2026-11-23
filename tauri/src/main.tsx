import { invoke } from "@tauri-apps/api/core";
import { render } from "@solidjs/web";

render(() => <div />, document.getElementById("root")!);

// A webview throttles animation frames while its window is covered, so the
// load event gives a timing that still arrives then.
window.addEventListener("load", () => void invoke("page_event", { name: "load" }));
requestAnimationFrame(() => {
  requestAnimationFrame(() => void invoke("page_event", { name: "first-paint" }));
});
