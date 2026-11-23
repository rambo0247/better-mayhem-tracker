import { afterEach, beforeEach, expect, test } from "bun:test";
import { createSignal, flush } from "solid-js";
import type { MatchDetail, MatchParticipantRecord } from "@shared/api";
import { FAKE_API } from "../../test/parity-cases";
import { fake } from "../../test/fakeApi";
import { mount, settle } from "../../test/render";
import ActivityCalendar, { type CalendarDay } from "./ActivityCalendar";
import MatchScoreboard from "./MatchScoreboard";
import MultikillBadge from "./MultikillBadge";
import { KdaTotals, RecordTogetherCard } from "./SharedStats";

// React keeps a list row by its key when the data is rebuilt with equal
// records, so the row's DOM, focus and hover state survive a refetch. Each
// list here is handed freshly built items for the same keys, and its rows
// must be the same nodes afterwards.

let view: ReturnType<typeof mount> | undefined;
beforeEach(() => {
  for (const [method, value] of Object.entries(FAKE_API)) fake.returns.set(method, value);
});
afterEach(() => {
  view?.dispose();
  fake.reset();
});

function nodes(selector: string) {
  return [...view!.container.querySelectorAll(selector)];
}

test("MultikillBadge keeps a badge when another count changes", () => {
  const [pentas, setPentas] = createSignal(1);
  view = mount(() => <MultikillBadge doubles={2} triples={1} quadras={0} pentas={pentas()} />);
  const before = nodes("span");
  setPentas(2);
  flush();
  const after = nodes("span");
  expect(after[0]).toBe(before[0]!);
  expect(after[2]).toBe(before[2]!);
  expect(after[2]!.textContent).toBe("PENTA ×2");
});

test("ActivityCalendar keeps its cells and month labels when the days are fetched again", () => {
  const DAY = 86_400_000;
  const first = new Date(2026, 8, 1).getTime();
  const [days, setDays] = createSignal(
    new Map<number, CalendarDay>([[first, { games: 1, wins: 1 }]]),
  );
  view = mount(() => (
    <ActivityCalendar
      days={days()}
      first={first}
      last={first + 40 * DAY}
      through={first + 30 * DAY}
      cell={14}
    />
  ));
  const cells = nodes("[class*='aspect-square']");
  const months = nodes(".w-0");
  setDays(new Map([[first, { games: 3, wins: 2 }]]));
  flush();
  expect(nodes("[class*='aspect-square']")[0]).toBe(cells[0]!);
  expect(nodes(".w-0")[0]).toBe(months[0]!);
  expect(cells[0]!.getAttribute("title")).toContain("3 games");
});

test("StatTiles keeps a tile when its value changes", () => {
  const [kills, setKills] = createSignal(10);
  view = mount(() => <KdaTotals kills={kills()} deaths={2} assists={5} />);
  const before = nodes(".rounded-\\[3px\\]");
  setKills(11);
  flush();
  const after = nodes(".rounded-\\[3px\\]");
  expect(after[0]).toBe(before[0]!);
  expect(after[0]!.textContent).toContain("11");
});

test("RecordTogetherCard keeps the recent-game pips when the games are fetched again", () => {
  const games = () => [
    { game_id: 5, win: 1 },
    { game_id: 4, win: 0 },
  ];
  const [recent, setRecent] = createSignal(games());
  view = mount(() => <RecordTogetherCard wins={1} games={2} recent={recent()} />);
  const before = nodes(".slant-sm");
  setRecent(games());
  flush();
  expect(nodes(".slant-sm")[0]).toBe(before[0]!);
});

function participant(participantId: number, teamId: number, puuid: string): MatchParticipantRecord {
  return {
    participantId,
    puuid,
    gameName: `Player${participantId}`,
    tagLine: "NA1",
    championId: 1,
    teamId,
    win: teamId === 100,
    kills: 5,
    deaths: 2,
    assists: 7,
    doubleKills: 0,
    tripleKills: 0,
    quadraKills: 0,
    pentaKills: 0,
    totalDamageDealtToChampions: 20_000,
    totalDamageTaken: 15_000,
    goldEarned: 12_000,
    totalHeal: 3_000,
    largestKillingSpree: 2,
    spell1Id: 4,
    spell2Id: 4,
    items: [1001],
    augments: [201],
  };
}

test("MatchScoreboard keeps its team panels and player rows when the players are parsed again", async () => {
  const detail = {
    game: { game_id: 1, game_version: "15.20.1" },
    participants: [participant(1, 100, "a"), participant(2, 100, "b"), participant(3, 200, "c")],
  } as unknown as MatchDetail;
  const [puuids, setPuuids] = createSignal<string[] | null>(["c"]);
  view = mount(() => <MatchScoreboard detail={detail} champData={{}} puuids={puuids()} />);
  await settle();
  const panels = [...view.container.querySelector(".space-y-3")!.children];
  const rows = nodes("[class*='grid-cols-']").filter((r) => /Player\d/.test(r.textContent ?? ""));
  expect(rows.length).toBe(3);

  setPuuids(["c", "x"]);
  await settle();
  expect(view.container.querySelector(".space-y-3")!.children[0]).toBe(panels[0]!);
  const after = nodes("[class*='grid-cols-']").filter((r) => /Player\d/.test(r.textContent ?? ""));
  expect(after[0]).toBe(rows[0]!);
});
