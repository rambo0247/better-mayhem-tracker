import { plugin } from "bun";
import { Window } from "happy-dom";
import { transform } from "@solidjs/compiler";

const win = new Window({ url: "http://localhost/" });
for (const key of [
  "window",
  "document",
  "navigator",
  "localStorage",
  "HTMLElement",
  "Element",
  "Node",
  "Text",
  "DocumentFragment",
  "SVGElement",
  "HTMLInputElement",
  "Event",
  "KeyboardEvent",
  "MouseEvent",
  "PointerEvent",
  "FocusEvent",
  "MutationObserver",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "getComputedStyle",
  "matchMedia",
] as const) {
  Object.defineProperty(globalThis, key, {
    value: key === "window" ? win : (win as never)[key],
    configurable: true,
    writable: true,
  });
}

// Solid's compiler turns the JSX into DOM calls and leaves the types, which
// Bun then strips as plain TypeScript.
plugin({
  name: "solid-jsx",
  setup(build) {
    build.onLoad({ filter: /[\\/]tauri[\\/]src[\\/].*\.tsx$/ }, async (args) => {
      const source = await Bun.file(args.path).text();
      const out = transform(source, { filename: args.path });
      return { contents: out.code, loader: "ts" };
    });
  },
});

await import("./fakeApi");
