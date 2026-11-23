import { describe, expect, test } from "bun:test";
import { lint } from "./lint-fixture";

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

  for (const type of ["text", "search", "email", "url", "tel", "password", "number"]) {
    test(`fails onChange on an input of type ${type}`, () => {
      const r = lint(
        `export const A = (f: () => void) => <input type="${type}" onChange={f} />;\n`,
      );
      expect(r.code).not.toBe(0);
      expect(r.out).toContain("solid-input-events");
    });
  }

  test("fails onChange on an input whose type is a dynamic expression", () => {
    const r = lint(
      "export const A = (t: string, f: () => void) => <input type={t} onChange={f} />;\n",
    );
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("Use onInput for text entry");
  });

  for (const type of ["checkbox", "radio", "file", "range", "color", "date"]) {
    test(`passes onChange on an input of type ${type}`, () => {
      const r = lint(
        `export const A = (f: () => void) => <input type="${type}" onChange={f} />;\n`,
      );
      expect(r.out).not.toContain("solid-input-events");
      expect(r.code).toBe(0);
    });
  }

  test("passes onInput on an input", () => {
    const r = lint("export const A = (f: () => void) => <input onInput={f} />;\n");
    expect(r.out).not.toContain("solid-input-events");
    expect(r.code).toBe(0);
  });

  test("passes onChange on a select", () => {
    const r = lint("export const A = (f: () => void) => <select onChange={f} />;\n");
    expect(r.out).not.toContain("solid-input-events");
    expect(r.code).toBe(0);
  });
});

describe("solid rules from eslint-plugin-solid", () => {
  test("a destructured prop fails with solid/no-destructure", () => {
    const r = lint("export function B({ a }: { a: string }) {\n  return <div>{a}</div>;\n}\n");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("[Error/solid/no-destructure]");
  });

  test("a signal read outside a tracked scope fails with solid/reactivity", () => {
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
    expect(r.out).toContain("[Error/solid/reactivity]");
  });
});
