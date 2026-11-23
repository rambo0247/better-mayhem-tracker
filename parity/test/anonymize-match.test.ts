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

describe("names match only as whole tokens", () => {
  test("a two-letter name matches alone and in any case", () => {
    expect(kinds("gg Al, see you")).toEqual(["name:Al"]);
    expect(kinds("AL")).toEqual(["name:AL"]);
    expect(kinds("(al)")).toEqual(["name:al"]);
  });

  test("a name inside an ordinary word is not a match", () => {
    expect(kinds("also metal salt Alpha")).toEqual([]);
    expect(kinds("theme other bathe")).toEqual([]);
    expect(kinds("the end")).toEqual(["name:the"]);
  });

  test("an underscore joins a name into an identifier, as in a map skin", () => {
    expect(kinds("mapskin_map12_bloom")).toEqual([]);
    expect(kinds("in bloom")).toEqual(["name:bloom"]);
  });

  test("an all-digit name never matches a piece of a version, date or longer number", () => {
    expect(kinds("16.23.1234.5555")).toEqual([]);
    expect(kinds("2026-1234")).toEqual([]);
    expect(kinds("12345 61234")).toEqual([]);
    expect(kinds("player 1234 won")).toEqual(["name:1234"]);
    expect(kinds("1234.")).toEqual(["name:1234"]);
  });

  test("a name with a space matches as one name", () => {
    expect(kinds("duo with Sundial Kid!")).toEqual(["name:Sundial Kid"]);
    expect(kinds("Sundial Kidd")).toEqual([]);
  });

  test("names in scripts written without spaces match inside a run of text", () => {
    expect(kinds("홍길동님 감사합니다")).toEqual(["name:홍길동"]);
    expect(kinds("和小明一起玩")).toEqual(["name:小明"]);
    expect(kinds("ok小明ok")).toEqual(["name:小明"]);
  });

  test("names in spaced non-Latin scripts match as whole tokens in any case", () => {
    expect(kinds("с Иван, привет")).toEqual(["name:Иван"]);
    expect(kinds("Иванов")).toEqual([]);
    expect(kinds("ΟΔΥΣΣΕΑΣ won")).toEqual(["name:ΟΔΥΣΣΕΑΣ"]);
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
    "<name>#<tag> and <name> in <puuid>, also bloom_x",
  );
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
});
