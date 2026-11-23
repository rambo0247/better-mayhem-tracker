import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { build } from "vite";

const TAURI = join(import.meta.dir, "..");

const specifier = (path: string, root = sep) => JSON.stringify(path.split(root).join("/"));
const tauri = (rel: string) => specifier(join(TAURI, rel));
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
    `import { settle } from ${tauri("test/render")}; console.log(settle);`,
    "is a test helper",
  ],
  [
    "a test file",
    "testfile",
    `import ${tauri("src/components/WinRateBar.test.tsx")};`,
    "is a test module",
  ],
])("the app build stops on %s", async (_label, name, code, message) => {
  await expect(buildEntry(name, code)).rejects.toThrow(message);
});

test("the app build passes app modules", async () => {
  await buildEntry(
    "app",
    `import { formatKDA } from ${tauri("src/lib/format")}; console.log(formatKDA);`,
  );
});

test("a specifier built from a Windows path with a space uses forward slashes inside one string", () => {
  const out = specifier("D:\\a\\b c\\x.ts", "\\");
  expect(out).toBe('"D:/a/b c/x.ts"');
  expect(JSON.parse(out)).toBe("D:/a/b c/x.ts");
});
