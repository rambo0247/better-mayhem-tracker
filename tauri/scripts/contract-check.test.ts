import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { checkContract, DEFAULT_BINDINGS, DEFAULT_SHARED } from "./contract-check";

const scratch = fs.mkdtempSync(path.join(import.meta.dir, "..", "node_modules", ".contract-test-"));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

function bindingsWith(edit: (source: string) => string): string {
  const file = path.join(scratch, `bindings-${crypto.randomUUID()}.ts`);
  const source = fs.readFileSync(DEFAULT_BINDINGS, "utf8");
  const edited = edit(source);
  expect(edited).not.toBe(source);
  fs.writeFileSync(file, edited);
  return file;
}

describe("contract-check", () => {
  test("the committed bindings match api.ts", () => {
    const result = checkContract();
    expect(result.problems).toEqual([]);
    expect(result.commands).toBe(61);
    expect(result.events).toBe(11);
  });

  test("a renamed field fails and is named", () => {
    const bindings = bindingsWith((s) =>
      s.replace(/(export type MatchListItem = \{[^\n]*?)game_creation:/, "$1game_created:"),
    );
    const result = checkContract({ bindings });
    expect(result.ok).toBe(false);
    const text = result.problems.join("\n");
    expect(text).toContain(
      "getMatchHistory result.matches[].game_creation: missing from the bindings",
    );
    expect(text).toContain("game_created: not in api.ts");
  });

  test("a field made nullable fails and is named", () => {
    const bindings = bindingsWith((s) =>
      s.replace(/(export type UpdateNotes = \{[^\n]*?)from: string/, "$1from: string | null"),
    );
    const result = checkContract({ bindings });
    expect(result.problems.join("\n")).toContain("getUpdateNotes result.from");
  });

  test("a renamed channel fails and is named", () => {
    const bindings = bindingsWith((s) =>
      s.replace('getVersion: "app:version"', 'getVersion: "app:get-version"'),
    );
    const result = checkContract({ bindings });
    expect(result.problems).toContain(
      "getVersion: channel app:get-version, api.ts has app:version",
    );
  });

  test("a channel added to api.ts fails and is named", () => {
    const shared = path.join(scratch, "api.ts");
    fs.copyFileSync(
      path.join(path.dirname(DEFAULT_SHARED), "card.ts"),
      path.join(scratch, "card.ts"),
    );
    fs.copyFileSync(
      path.join(path.dirname(DEFAULT_SHARED), "challenges.ts"),
      path.join(scratch, "challenges.ts"),
    );
    fs.writeFileSync(
      shared,
      fs
        .readFileSync(DEFAULT_SHARED, "utf8")
        .replace(
          '  getVersion: "app:version",',
          '  getVersion: "app:version",\n  getUptime: "app:uptime",',
        ),
    );
    const result = checkContract({ shared });
    expect(result.problems).toContain("getUptime: missing from the bindings");
  });
});
