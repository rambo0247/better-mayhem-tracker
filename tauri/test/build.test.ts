import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "vite";

const TAURI = join(import.meta.dir, "..");
const dir = await mkdtemp(join(tmpdir(), "bmt-build-guard-"));
afterAll(() => rm(dir, { recursive: true }));

async function buildEntry(name: string, code: string) {
  const entry = join(dir, `${name}.ts`);
  await Bun.write(entry, code);
  return build({
    configFile: join(TAURI, "vite.config.ts"),
    root: TAURI,
    logLevel: "silent",
    build: { write: false, rollupOptions: { input: entry } },
  });
}

test.each([
  [
    "a node: import",
    "node",
    'import { readFileSync } from "node:fs"; console.log(readFileSync);',
    "node:fs is not a browser module",
  ],
  [
    "a bun: import",
    "bun",
    'import { test } from "bun:test"; console.log(test);',
    "bun:test is not a browser module",
  ],
  [
    "a test helper",
    "helper",
    `import { settle } from "${TAURI}/test/render"; console.log(settle);`,
    "is a test helper",
  ],
  [
    "a test file",
    "testfile",
    `import "${TAURI}/src/components/WinRateBar.test.tsx";`,
    "is a test module",
  ],
])("the app build stops on %s", async (_label, name, code, message) => {
  await expect(buildEntry(name, code)).rejects.toThrow(message);
});

test("the app build passes app modules", async () => {
  await buildEntry(
    "app",
    `import { formatKDA } from "${TAURI}/src/lib/format"; console.log(formatKDA);`,
  );
});
