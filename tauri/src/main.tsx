import { invoke } from "@tauri-apps/api/core";
import { render } from "@solidjs/web";
import { api } from "./lib/api-shim";
import { initViewState } from "./lib/viewState";
import App from "./App";
import "./global.css";

// Pages read their remembered filters as they mount, so whether to remember at
// all has to be settled before the first render.
void api
  .getSetting("remember_filters")
  .catch(() => null)
  .then((remember) => {
    initViewState(remember === "true");
    render(() => <App />, document.getElementById("root")!);
  });

// A webview throttles animation frames while its window is covered, so the
// load event gives a timing that still arrives then.
window.addEventListener("load", () => void invoke("page_event", { name: "load" }));
requestAnimationFrame(() => {
  requestAnimationFrame(() => void invoke("page_event", { name: "first-paint" }));
});
