import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import solid from "@solidjs/vite-plugin";
import { defineConfig, normalizePath, type Plugin } from "vite";

// Resolved ids use forward slashes on Windows too
const TEST_DIR = normalizePath(fileURLToPath(new URL("./test/", import.meta.url)));

// The webview has no node: or bun: modules, and test code has no place in the
// app. Vite turns such an import into an empty browser-external stub instead
// of failing, so the build has to stop on the stub itself.
export const appOnly: Plugin = {
  name: "app-only",
  apply: "build",
  enforce: "pre",
  async resolveId(source, importer, options) {
    const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
    const id = resolved?.id ?? "";
    const why = id.includes("__vite-browser-external")
      ? "is not a browser module"
      : id.startsWith(TEST_DIR)
        ? "is a test helper"
        : /\.test\.tsx?(\?|$)/.test(id)
          ? "is a test module"
          : null;
    if (why) this.error(`${source} ${why}, imported by ${importer ?? "the entry"}`);
    return resolved;
  },
};

export default defineConfig({
  plugins: [appOnly, solid(), tailwindcss()],
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ["**/src-tauri/**"] } },
  build: { target: "safari16", outDir: "dist" },
});
