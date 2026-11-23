import { beforeEach, describe, expect, mock, test } from "bun:test";

type Update = [Record<string, string | undefined>, { replace?: boolean } | undefined];

let params: Record<string, string> = {};
let updates: Update[] = [];

mock.module("@solidjs/router", () => ({
  useSearchParams: () => [
    params,
    (next: Record<string, string | undefined>, options?: { replace?: boolean }) => {
      updates.push([next, options]);
    },
  ],
}));

const { useQueryFilters } = await import("./useQueryFilters");

beforeEach(() => {
  params = {};
  updates = [];
});

describe("useQueryFilters", () => {
  test("reads the patch and the queue", () => {
    params = { patch: "16.22", queue: "2400" };
    const filters = useQueryFilters();
    expect(filters.patch()).toBe("16.22");
    expect(filters.queue()).toBe(2400);
  });

  test("reads absent parameters as undefined", () => {
    const filters = useQueryFilters();
    expect(filters.patch()).toBeUndefined();
    expect(filters.queue()).toBeUndefined();
  });

  test("writes a value as a string, replacing the history entry", () => {
    const filters = useQueryFilters();
    filters.setParam("queue", 2400);
    filters.setParam("tab", "items");
    expect(updates).toEqual([
      [{ queue: "2400" }, { replace: true }],
      [{ tab: "items" }, { replace: true }],
    ]);
  });

  test("clears a parameter on undefined or an empty string", () => {
    const filters = useQueryFilters();
    filters.setParam("patch", undefined);
    filters.setParam("tab", "");
    expect(updates.map(([next]) => next)).toEqual([{ patch: undefined }, { tab: undefined }]);
  });
});
