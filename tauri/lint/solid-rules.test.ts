import { describe, expect, test } from "bun:test";
import { lint } from "./lint-fixture";

describe("the solid v2 recommended set", () => {
  test("every rule the plugin's v2 config enables is an error in bunfig.toml", async () => {
    const plugin = (await import("eslint-plugin-solid")).default as unknown as {
      configs: Record<string, { rules: Record<string, unknown> }>;
    };
    const ours = (await import("../bunfig.toml")).default.lint.rules as Record<string, string>;
    const enabled = Object.entries(plugin.configs["v2"].rules)
      .filter(([name, setting]) => {
        const level = Array.isArray(setting) ? setting[0] : setting;
        return name.startsWith("solid/") && level !== 0 && level !== "off";
      })
      .map(([name]) => name);
    expect(enabled.length).toBeGreaterThan(20);
    const missing = enabled.filter((name) => ours[name] !== "error");
    expect(missing).toEqual([]);
  });
});

const fixtures: [rule: string, source: string][] = [
  ["event-handlers", "export const A = () => <button onclick={() => 1}>x</button>;\n"],
  [
    "components-return-once",
    "export function B(props: { a: boolean }) {\n  if (props.a) return <div>a</div>;\n  return <div>b</div>;\n}\n",
  ],
  ["style-prop", 'export const C = () => <div style="color: red" />;\n'],
  ["jsx-no-duplicate-props", 'export const D = () => <div id="a" id="b" />;\n'],
  ["jsx-no-script-url", 'export const E = () => <a href="javascript:void(0)">x</a>;\n'],
  ["no-innerhtml", "export const F = (h: string) => <div innerHTML={h} />;\n"],
  ["validate-jsx-nesting", "export const G = () => <p><div /></p>;\n"],
  ["self-closing-comp", "export const H = () => <div></div>;\n"],
  ["no-react-specific-props", 'export const I = () => <div className="a" />;\n'],
  ["no-unknown-namespaces", "export const J = () => <div use:foo />;\n"],
];

describe("solid rules fire under bun lint", () => {
  for (const [rule, source] of fixtures) {
    test(`${rule} fails its fixture`, () => {
      const r = lint(source);
      expect(r.code).not.toBe(0);
      expect(r.out).toContain(`[Error/solid/${rule}]`);
    });
  }
});
