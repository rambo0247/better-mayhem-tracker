import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import solid from "@solidjs/vite-plugin";
import { defineConfig, type Plugin } from "vite";

// A test module reaching the app bundle would ship bun:test and node:fs to
// the webview, so the build stops on one
const noTestModules: Plugin = {
  name: "no-test-modules",
  apply: "build",
  transform(_code, id) {
    if (/\.test\.tsx?(\?|$)/.test(id)) this.error(`${id} is a test module`);
  },
  generateBundle(_options, bundle) {
    for (const chunk of Object.values(bundle)) {
      if (chunk.type !== "chunk") continue;
      const leaked = chunk.imports.filter((id) => id.startsWith("bun:") || id.startsWith("node:"));
      if (leaked.length > 0) this.error(`${chunk.fileName} imports ${leaked.join(", ")}`);
    }
  },
};

export default defineConfig({
  plugins: [noTestModules, solid(), tailwindcss()],
  resolve: { alias: { "@shared": fileURLToPath(new URL("../src/shared", import.meta.url)) } },
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ["**/src-tauri/**"] } },
  build: { target: "safari16", outDir: "dist" },
});
