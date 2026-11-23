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
// Solid's DOM build, which `bun test` alone would pass over for the server
// one; `--conditions browser` is then only a belt to these braces
const BROWSER_BUILDS: Record<string, string> = {
  "solid-js": `${import.meta.dir}/../node_modules/solid-js/dist/solid.js`,
  "@solidjs/web": `${import.meta.dir}/../node_modules/@solidjs/web/dist/web.js`,
};

plugin({
  name: "solid-jsx",
  setup(build) {
    build.onResolve({ filter: /^(solid-js|@solidjs\/web)$/ }, (args) => ({
      path: BROWSER_BUILDS[args.path]!,
    }));
    build.onLoad({ filter: /[\\/]tauri[\\/]src[\\/].*\.tsx$/ }, async (args) => {
      const source = await Bun.file(args.path).text();
      const out = transform(source, { filename: args.path });
      return { contents: out.code, loader: "ts" };
    });
  },
});

await import("./fakeApi");
