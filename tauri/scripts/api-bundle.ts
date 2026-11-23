// Builds `src/api.ts` as one script that sets `window.api`, for a webview
// initialization script. Parity lanes load Electron's own renderer over it,
// so the renderer calls the Rust commands in place of the replayed goldens.
import fs from "node:fs";
import path from "node:path";

const TAURI_DIR = path.resolve(import.meta.dir, "..");

export async function buildApiBundle(): Promise<string> {
  const scratch = fs.mkdtempSync(path.join(TAURI_DIR, "node_modules", ".api-bundle-"));
  try {
    const entry = path.join(scratch, "entry.ts");
    const api = path.relative(scratch, path.join(TAURI_DIR, "src", "api.ts")).replace(/\\/g, "/");
    fs.writeFileSync(entry, `import { install } from "${api}";\ninstall();\n`);
    const result = await Bun.build({ entrypoints: [entry], format: "iife", target: "browser" });
    if (!result.success) throw new AggregateError(result.logs, "api.ts did not bundle");
    return await result.outputs[0].text();
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const out = process.argv[2];
  const bundle = await buildApiBundle();
  if (out) {
    fs.writeFileSync(out, bundle);
    console.log(`wrote ${out}, ${bundle.length} bytes`);
  } else {
    process.stdout.write(bundle);
  }
}
