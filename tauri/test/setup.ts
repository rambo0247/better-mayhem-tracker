import { plugin } from "bun";
import { afterEach } from "bun:test";
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

// happy-dom drops a falsy textContent, so the 0 Solid writes that way would
// show as nothing; a browser writes "0"
const textContent = Object.getOwnPropertyDescriptor(win.Element.prototype, "textContent")!;
Object.defineProperty(win.Element.prototype, "textContent", {
  ...textContent,
  set(value: unknown) {
    textContent.set!.call(this, value == null ? "" : String(value));
  },
});

// Solid's DOM builds, which `bun test` alone would pass over for the server
// ones. The development builds by default, since only they report misuse
// (a read that never updates, a write inside a computation); `bun run test`
// runs the suite again on the production builds that ship.
const DEV = process.env.SOLID_BUILD !== "production";
const modules = `${import.meta.dir}/../node_modules`;
const BUILDS: Record<string, string> = DEV
  ? {
      "solid-js": `${modules}/solid-js/dist/solid.dev.js`,
      "@solidjs/web": `${modules}/@solidjs/web/dist/web.dev.js`,
      "@solidjs/signals": `${modules}/@solidjs/signals/dist/dev.js`,
    }
  : {
      "solid-js": `${modules}/solid-js/dist/solid.js`,
      "@solidjs/web": `${modules}/@solidjs/web/dist/web.js`,
      "@solidjs/signals": `${modules}/@solidjs/signals/dist/prod/index.js`,
    };

// Solid's compiler turns the JSX into DOM calls and leaves the types, which
// Bun then strips as plain TypeScript
plugin({
  name: "solid-jsx",
  setup(build) {
    build.onResolve({ filter: /^(solid-js|@solidjs\/web|@solidjs\/signals)$/ }, (args) => ({
      path: BUILDS[args.path]!,
    }));
    build.onLoad({ filter: /[\\/]tauri[\\/]src[\\/].*\.tsx$/ }, async (args) => {
      const source = await Bun.file(args.path).text();
      const out = transform(source, { filename: args.path, dev: DEV });
      return { contents: out.code, loader: "ts" };
    });
  },
});

// Every Solid warning or error fails the test it came from
const findings: string[] = [];
const solid = await import("solid-js");
if (DEV) {
  solid.OBSERVE!.diagnostics.subscribe((event) => {
    if (event.severity !== "info") findings.push(`[${event.code}] ${event.message}`);
  });
}
afterEach(() => {
  if (findings.length > 0) throw new Error(`Solid reported:\n${findings.splice(0).join("\n")}`);
});

await import("./fakeApi");
