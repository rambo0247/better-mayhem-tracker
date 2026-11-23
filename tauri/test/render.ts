import { flush } from "solid-js";
import { render, type JSX } from "@solidjs/web";

// Mounts a view into a fresh container on document.body, with its first
// updates applied, and hands back the container and a way to take it down
export function mount(view: () => JSX.Element) {
  const container = document.createElement("div");
  document.body.append(container);
  const dispose = render(view, container);
  flush();
  return {
    container,
    dispose() {
      dispose();
      container.remove();
    },
  };
}

// Lets pending promises (window.api answers) land and applies what they wrote
export async function settle() {
  for (let i = 0; i < 3; i++) {
    flush();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  flush();
}
