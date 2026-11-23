import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  checkContract,
  DEFAULT_BINDINGS,
  DEFAULT_SHARED,
  parseDiagnostics,
} from "./contract-check";

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

  test("a field's type, changed, is named with both types", () => {
    const bindings = bindingsWith((s) =>
      s.replace(
        /(export type MatchListItem = \{[^\n]*?)game_creation: number/,
        "$1game_creation: string",
      ),
    );
    expect(checkContract({ bindings }).problems).toContain(
      "getMatchHistory result.matches[].game_creation: number in api.ts, string in the bindings",
    );
  });

  test("a union member dropped is named as the lost branch", () => {
    const bindings = bindingsWith((s) =>
      s.replace(
        "export type BackfillOutcome = BackfillResult | { error: string, };",
        "export type BackfillOutcome = BackfillResult;",
      ),
    );
    expect(checkContract({ bindings }).problems).toEqual([
      "backfillHistory result: api.ts's member { error } has no match in the bindings",
      "event lcu:backfill-done: api.ts's member { error } has no match in the bindings",
    ]);
  });

  test("an enum member renamed shows both unions", () => {
    const bindings = bindingsWith((s) =>
      s.replace('"connected" | "ingame"', '"connected" | "inGame"'),
    );
    const text = checkContract({ bindings }).problems.join("\n");
    expect(text).toContain('getLcuStatus result: "ingame" | ');
    expect(text).toContain(
      '"inGame" | "disconnected" | "connecting" | "connected" in the bindings',
    );
  });

  test("an optional argument made required is named once, with its name", () => {
    const bindings = bindingsWith((s) =>
      s.replace(
        "getMatchSessions: (filters?: MatchFilters)",
        "getMatchSessions: (filters: MatchFilters)",
      ),
    );
    expect(checkContract({ bindings }).problems).toEqual([
      "getMatchSessions arguments[0] filters: optional in api.ts, required in the bindings",
    ]);
  });

  test("two arguments swapped, as a Rust-side swap regenerates them, fail", () => {
    const bindings = bindingsWith((s) =>
      s.replace(
        'setSetting: (key: string, value: string): Promise<void> =>\n    call<void>("settings:set", { key, value }, [key, value])',
        'setSetting: (value: string, key: string): Promise<void> =>\n    call<void>("settings:set", { value, key }, [value, key])',
      ),
    );
    expect(checkContract({ bindings }).problems).toEqual([
      "setSetting arguments: api.ts names (key, value), the bindings (value, key)",
    ]);
  });

  test("only the named keys swapped fail", () => {
    const bindings = bindingsWith((s) =>
      s.replace(
        'call<void>("settings:set", { key, value }, [key, value])',
        'call<void>("settings:set", { key: value, value: key }, [key, value])',
      ),
    );
    expect(checkContract({ bindings }).problems).toEqual([
      "setSetting: the wrapper sends { key: value, value: key }, not its arguments by name, { key, value }",
    ]);
  });
});

describe("parseDiagnostics", () => {
  test("a Check line's literal is split into its problems", () => {
    const line = `check.ts(3,1): error TS2344: Type '"a.b: missing from the bindings ;; c: not in api.ts"' does not satisfy the constraint 'never'.`;
    expect(parseDiagnostics(line, 2)).toEqual([
      "a.b: missing from the bindings",
      "c: not in api.ts",
    ]);
  });

  test("a Check line it cannot read is a problem, not a pass", () => {
    const line =
      "check.ts(3,1): error TS2344: Type 'Join<X>' does not satisfy the constraint 'never'.";
    expect(parseDiagnostics(line, 2)).toEqual([`tsc: ${line}`]);
  });

  test("any other error is a problem", () => {
    const line =
      "check.ts(1,10): error TS2305: Module './bindings' has no exported member 'createCommands'.";
    expect(parseDiagnostics(line, 2)).toEqual([`tsc: ${line}`]);
  });

  test("a failing exit with nothing it can read is a problem", () => {
    expect(parseDiagnostics("Segmentation fault", 139)[0]).toStartWith("tsc exited 139");
    expect(parseDiagnostics("", 0)).toEqual([]);
  });
});
