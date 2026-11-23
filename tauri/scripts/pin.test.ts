import { describe, expect, test } from "bun:test";
import { isExactPin, pinnedVersion } from "./pin";

describe("isExactPin", () => {
  test("a crate needs the = operator, because a bare version is a caret range", () => {
    expect(isExactPin("crate", "=3.0.0-alpha.6")).toBe(true);
    expect(isExactPin("crate", "3.0.0-alpha.6")).toBe(false);
    expect(isExactPin("crate", "^3.0.0")).toBe(false);
    expect(isExactPin("crate", "~3.0.0")).toBe(false);
    expect(isExactPin("crate", "3")).toBe(false);
  });

  test("an npm dependency needs an exact version", () => {
    expect(isExactPin("npm", "2.0.3")).toBe(true);
    expect(isExactPin("npm", "8.4.0-beta.1")).toBe(true);
    expect(isExactPin("npm", "^2.0.3")).toBe(false);
    expect(isExactPin("npm", "~2.0.3")).toBe(false);
    expect(isExactPin("npm", "2.x")).toBe(false);
    expect(isExactPin("npm", "latest")).toBe(false);
  });
});

describe("pinnedVersion", () => {
  test("drops only the crate = operator", () => {
    expect(pinnedVersion("crate", "=3.0.0-alpha.6")).toBe("3.0.0-alpha.6");
    expect(pinnedVersion("npm", "2.0.3")).toBe("2.0.3");
  });
});
