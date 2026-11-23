import { describe, expect, test } from "bun:test";
import { IdentityMatcher } from "../lib/anonymize-match.ts";

const REAL_PUUID = "11111111-aaaa-4bbb-8ccc-222222222222";
const OTHER_UUID = "99999999-1234-4bbb-8ccc-000000004000";
const matcher = new IdentityMatcher({
  names: ["al", "bloom", "1234", "sundial kid", "홍길동", "小明", "иван", "οδυσσεας", "the"],
  tags: ["na1", "0042"],
  puuids: [REAL_PUUID, "r4nd0m-n0t-a-uuid-shaped-puuid-xyz"],
});
const kinds = (text: string) => matcher.find(text).map((m) => `${m.kind}:${m.text}`);

describe("a name is an identity only before #tag or as a whole value", () => {
  test("a whole value matches in any case, with a space in it, and in any script", () => {
    expect(kinds("AL")).toEqual(["name:AL"]);
    expect(kinds("  al ")).toEqual(["name:al"]);
    expect(kinds("Sundial Kid")).toEqual(["name:Sundial Kid"]);
    expect(kinds("홍길동")).toEqual(["name:홍길동"]);
    expect(kinds("小明")).toEqual(["name:小明"]);
    expect(kinds("Иван")).toEqual(["name:Иван"]);
    expect(kinds("ΟΔΥΣΣΕΑΣ")).toEqual(["name:ΟΔΥΣΣΕΑΣ"]);
  });

  test("a name among other words is game text and never matches", () => {
    expect(kinds("gg Al, see you")).toEqual([]);
    expect(kinds("also metal salt Alpha")).toEqual([]);
    expect(kinds("the end")).toEqual([]);
    expect(kinds("in bloom")).toEqual([]);
    expect(kinds("mapskin_map12_bloom")).toEqual([]);
    expect(kinds("duo with Sundial Kid!")).toEqual([]);
    expect(kinds("홍길동님 감사합니다")).toEqual([]);
    expect(kinds("와 小明 일")).toEqual([]);
    expect(kinds("player 1234 won")).toEqual([]);
    expect(kinds("16.23.1234.5555")).toEqual([]);
  });

  test("a name right before # and a tag matches, with any tag", () => {
    expect(kinds("gg Al#NA1")).toEqual(["name:Al", "tag:NA1"]);
    expect(kinds("Al#9999")).toEqual(["name:Al"]);
    expect(kinds("duo with Sundial Kid#0042!")).toEqual(["name:Sundial Kid", "tag:0042"]);
    expect(kinds("和小明#NA1")).toEqual(["name:小明", "tag:NA1"]);
    expect(kinds("ΟΔΥΣΣΕΑΣ#NA1 won")).toEqual(["name:ΟΔΥΣΣΕΑΣ", "tag:NA1"]);
  });

  test("a name that ends inside a longer word is not a name before a tag", () => {
    expect(kinds("metal#NA1")).toEqual(["tag:NA1"]);
    expect(kinds("Sundial Kidd#NA1")).toEqual(["tag:NA1"]);
    expect(kinds("Иванов#NA1")).toEqual(["tag:NA1"]);
  });

  test("bare names are counted so the audit can report them", () => {
    expect(matcher.countBareNames("gg Al, in bloom, the end")).toBe(3);
    expect(matcher.countBareNames("Al#NA1")).toBe(0);
    expect(matcher.countBareNames("Al")).toBe(0);
  });
});

describe("tag lines match only in the name#tag form", () => {
  test("a bare tag line is a region code or a number, not a person", () => {
    expect(kinds("NA1")).toEqual([]);
    expect(kinds("platform NA1 lane 0042")).toEqual([]);
  });

  test("a tag line after <word># matches, whatever the name before it", () => {
    expect(kinds("Al#NA1")).toEqual(["name:Al", "tag:NA1"]);
    expect(kinds("Stranger#0042 joined")).toEqual(["tag:0042"]);
    expect(kinds("#NA1")).toEqual([]);
    expect(kinds("Al#NA12")).toEqual(["name:Al"]);
  });
});

describe("PUUIDs", () => {
  test("a real PUUID matches anywhere, in any case and any shape", () => {
    expect(kinds(`backfill_complete_${REAL_PUUID.toUpperCase()}`)).toEqual([
      `puuid:${REAL_PUUID.toUpperCase()}`,
    ]);
    expect(kinds("xr4nd0m-n0t-a-uuid-shaped-puuid-xyzx")).toEqual([
      "puuid:r4nd0m-n0t-a-uuid-shaped-puuid-xyz",
    ]);
  });

  test("no name is found inside a UUID that is not a real PUUID", () => {
    expect(matcher.find(`id ${OTHER_UUID}`)).toEqual([]);
  });
});

test("object keys are searched for PUUIDs and name#tag forms, not bare names", () => {
  const found = (key: string) => matcher.findInKey(key).map((m) => m.kind);
  expect(found("name")).toEqual([]);
  expect(found("al")).toEqual([]);
  expect(found(REAL_PUUID)).toEqual(["puuid"]);
  expect(found("al#na1")).toEqual(["tag"]);
});

test("replace swaps each match for its fake and keeps the text around it", () => {
  const fake = (m: { kind: string; text: string }) => `<${m.kind}>`;
  expect(matcher.replace(`Al#NA1 and 小明 in ${REAL_PUUID}, also bloom_x`, fake)).toBe(
    "<name>#<tag> and 小明 in <puuid>, also bloom_x",
  );
  expect(matcher.replace("Sundial Kid", fake)).toBe("<name>");
  expect(matcher.replaceInKey(`stats_${REAL_PUUID}`, fake)).toBe("stats_<puuid>");
});

test("findPuuids reads raw bytes for PUUIDs only", () => {
  const bytes = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x23]),
    Buffer.from(` al#na1 ${REAL_PUUID} `),
  ]).toString("latin1");
  expect(matcher.findPuuids(bytes).map((m) => m.kind)).toEqual(["puuid"]);
});

test("an empty identity set matches nothing", () => {
  const empty = new IdentityMatcher({ names: [], tags: [], puuids: [] });
  expect(empty.find("anything at all#na1")).toEqual([]);
  expect(empty.countBareNames("anything")).toBe(0);
});
