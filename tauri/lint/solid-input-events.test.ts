import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const config = resolve(import.meta.dir, "../.oxlintrc.json");
const scratch = mkdtempSync(join(tmpdir(), "bmt-lint-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let counter = 0;
function lint(source: string) {
  const file = join(scratch, `fixture-${counter++}.tsx`);
  writeFileSync(file, source);
  const run = Bun.spawnSync(["bunx", "oxlint", "-c", config, file], {
    cwd: resolve(import.meta.dir, ".."),
  });
  return { code: run.exitCode, out: run.stdout.toString() + run.stderr.toString() };
}

describe("solid-input-events", () => {
  test("fails onChange on an input", () => {
    const r = lint("export const A = (f: () => void) => <input onChange={f} />;\n");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("solid-input-events");
  });

  test("fails onChange on a textarea", () => {
    const r = lint("export const A = (f: () => void) => <textarea onChange={f} />;\n");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("solid-input-events");
  });

  test("passes onInput on an input", () => {
    const r = lint("export const A = (f: () => void) => <input onInput={f} />;\n");
    expect(r.out).not.toContain("solid-input-events");
    expect(r.code).toBe(0);
  });

  test("passes onChange on a select", () => {
    const r = lint("export const A = (f: () => void) => <select onChange={f}></select>;\n");
    expect(r.out).not.toContain("solid-input-events");
    expect(r.code).toBe(0);
  });
});

describe("solid rules from eslint-plugin-solid", () => {
  test("a destructured prop fails with solid(no-destructure)", () => {
    const r = lint("export function B({ a }: { a: string }) {\n  return <div>{a}</div>;\n}\n");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("solid(no-destructure)");
  });

  test("a signal read outside a tracked scope fails with solid(reactivity)", () => {
    const r = lint(
      [
        'import { createSignal } from "solid-js";',
        "export function C() {",
        "  const [n, setN] = createSignal(0);",
        "  const x = n();",
        "  return <button onClick={() => setN(x + 1)}>go</button>;",
        "}",
        "",
      ].join("\n"),
    );
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("solid(reactivity)");
  });
});
