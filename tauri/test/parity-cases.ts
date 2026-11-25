// The prop combinations each shared component is rendered with, once from the
// 1.2.1 React tree (recorded in test/v1-dom-snapshots.json) and once from
// tauri/src (src/components/v1-parity.test.tsx), so the two renders can be
// compared. Props are written the Solid way (`class`). Every value here is made up.

export interface ParityCase {
  id: string;
  // The component file under components/, and its export ("default" or a name)
  file: string;
  name: string;
  props: Record<string, unknown>;
  // Attributes the two renders are allowed to differ on, by design
  ignore?: string[];
}

const noop = () => {};

const MATCH = {
  game_id: 7001,
  game_creation: Date.UTC(2025, 8, 12, 18, 30),
  game_duration: 1100,
  queue_id: 2400,
  champion_id: 1,
  win: 1,
  kills: 21,
  deaths: 3,
  assists: 14,
};

// What the fake window.api answers with on both sides
export const FAKE_API: Record<string, unknown> = {
  getChampionData: { 1: { name: "Annie", key: "Annie", class: "Mage" } },
  getItemData: {
    1001: {
      name: "Boots",
      description:
        "<mainText><stats><attention>25</attention> Move Speed</stats><br><br><passive>Quick:</passive> Gain <speed>Move Speed</speed> %i:scaleMS% out of combat.<li>Stacks once.<rules>Limited to 1.</rules></mainText>",
      iconPath: "/lol-game-data/assets/ASSETS/Items/Icons2D/1001_Class_T1_BootsofSpeed.png",
      branch: "latest",
      boots: true,
    },
  },
  getAugmentData: {
    201: {
      name: "Back To Basics",
      desc: "Gain <scaleAP>20% Ability Power</scaleAP>, and <b>more</b>.",
      iconPath: "/lol-game-data/assets/ASSETS/UX/Cherry/Augments/Icons/BackToBasics_small.png",
      rarity: "kGold",
      branch: "latest",
    },
    202: {
      name: "",
      desc: "",
      iconPath: "/lol-game-data/assets/ASSETS/UX/Cherry/Augments/Icons/Pentakill_small.png",
      rarity: "kPrismatic",
      branch: "16.14",
    },
  },
  getSummonerSpellData: {
    4: { name: "Flash", iconPath: "/lol-game-data/assets/DATA/Spells/Icons2D/Summoner_Flash.png" },
  },
  getMatchFilterOptions: {
    patches: ["15.20", "15.19"],
    champions: [],
    queues: [2400, 2450],
    seasons: ["s1", "s2"],
    accounts: [
      { puuid: "puuid-a", name: "First#NA1" },
      { puuid: "puuid-b", name: null },
    ],
    hasFavorites: false,
  },
};

const RELEASES = [
  {
    version: "1.2.1",
    publishedAt: "2026-11-01T12:00:00Z",
    body: "## Fixed\n- The **card** export\n  - nested `code` item\n- See https://github.com/example/x\n\nA [link](https://example.com/page) in prose.",
    url: "https://example.com/1.2.1",
  },
  {
    version: "1.2.0",
    publishedAt: "2026-10-01T12:00:00Z",
    body: "",
    url: "https://example.com/1.2.0",
  },
];

const DAY = 86_400_000;
const FIRST = new Date(2026, 8, 1).getTime();

// A four-player match for the tier 3 scoreboards: two a side, one of them us
function participant(participantId: number, teamId: number, extra: Record<string, unknown>) {
  return {
    participantId,
    puuid: null,
    gameName: null,
    tagLine: null,
    championId: 1,
    teamId,
    win: teamId === 100,
    kills: 4,
    deaths: 6,
    assists: 9,
    doubleKills: 0,
    tripleKills: 0,
    quadraKills: 0,
    pentaKills: 0,
    totalDamageDealtToChampions: 18_400,
    totalDamageTaken: 22_100,
    goldEarned: 11_200,
    totalHeal: 2_300,
    largestKillingSpree: 2,
    spell1Id: 4,
    spell2Id: null,
    items: [1001, 0, 0, 0, 0, 0, 0],
    augments: [201, 202],
    ...extra,
  };
}

const DETAIL = {
  game: {
    game_id: 7001,
    queue_id: 2400,
    game_mode: "KIWI",
    game_creation: MATCH.game_creation,
    game_duration: 1100,
    game_version: "15.20.711.1234",
  },
  stats: MATCH,
  augments: [],
  participants: [
    participant(1, 100, {
      puuid: "puuid-a",
      gameName: "First",
      tagLine: "NA1",
      kills: 21,
      deaths: 3,
      assists: 14,
      doubleKills: 3,
      tripleKills: 1,
      pentaKills: 1,
      totalDamageDealtToChampions: 61_000,
    }),
    participant(2, 100, { gameName: "Second", tagLine: "EUW", deaths: 0 }),
    participant(3, 200, { gameName: "Third", tagLine: "KR1", kills: 0, items: [] }),
    participant(4, 200, { totalHeal: 0, augments: [] }),
  ],
};

function livePlayer(key: string, teamId: number, extra: Record<string, unknown>) {
  return {
    key,
    name: key,
    tagLine: null,
    puuid: null,
    championId: 1,
    championName: "Annie",
    teamId,
    isSelf: false,
    isBot: false,
    level: 11,
    kills: 3,
    deaths: 2,
    assists: 5,
    creepScore: 40,
    items: [1001, 0, 0, 0, 0, 0, 0],
    isDead: false,
    respawnTimer: 0,
    spell1Id: 4,
    spell2Id: 4,
    championRecord: null,
    overallRecord: null,
    gamesWithUs: 0,
    friendKey: null,
    ...extra,
  };
}

// the old router marks its Link for route discovery, which is no part of the UI
const LINK_DISCOVERY = ["data-discover"];

const RECORD = { games: 12, wins: 7, kills: 80, deaths: 40, assists: 120, lastPlayed: FIRST };

const LIVE_PLAYERS = [
  livePlayer("Me#NA1", 100, {
    isSelf: true,
    puuid: "puuid-a",
    championRecord: RECORD,
    overallRecord: { ...RECORD, games: 140, wins: 71 },
  }),
  livePlayer("Pal#EUW", 100, {
    gamesWithUs: 9,
    friendKey: "Pal#EUW",
    isDead: true,
    respawnTimer: 12.4,
  }),
  livePlayer("Bot Annie", 200, { isBot: true, championId: 0, championName: "Annie" }),
  livePlayer("Rival#KR1", 200, { kills: 0, deaths: 0, assists: 0, overallRecord: RECORD }),
];

export const CASES: ParityCase[] = [
  { id: "BrandMark", file: "BrandMark", name: "default", props: { class: "h-9 w-9" } },
  { id: "Kda", file: "Kda", name: "default", props: { kills: 12, deaths: 0, assists: "7" } },
  ...[
    { doubles: 0, triples: 0, quadras: 0, pentas: 0 },
    { doubles: 3, triples: 1, quadras: 0, pentas: 1 },
    { doubles: 1, triples: 2, quadras: 1, pentas: 0, compact: true },
  ].map((props, i) => ({
    id: `MultikillBadge ${i}`,
    file: "MultikillBadge",
    name: "default",
    props,
  })),
  {
    id: "PageHeader full",
    file: "PageHeader",
    name: "default",
    props: {
      kicker: "Analyze",
      title: "Champions",
      subtitle: "Every pick",
      actions: "x",
      class: "pb-2",
    },
  },
  { id: "PageHeader bare", file: "PageHeader", name: "default", props: { title: "Records" } },
  {
    id: "StatCard full",
    file: "StatCard",
    name: "default",
    props: {
      label: "Games",
      value: 42,
      subtext: "this set",
      icon: "i",
      accent: "gold",
      children: "foot",
    },
  },
  { id: "StatCard bare", file: "StatCard", name: "default", props: { label: "Win rate" } },
  {
    id: "Panel",
    file: "Panel",
    name: "default",
    props: { title: "Best", subtitle: "of 3", icon: "i", accent: "sky", children: "body" },
  },
  { id: "RiotId tagged", file: "RiotId", name: "default", props: { id: "Name With Space#EUW" } },
  { id: "RiotId bare", file: "RiotId", name: "default", props: { id: "#leading" } },
  {
    id: "RiotText",
    file: "RiotText",
    name: "default",
    props: {
      markup: (FAKE_API.getItemData as Record<number, { description: string }>)[1001]!.description,
    },
  },
  {
    id: "RiotText font",
    file: "RiotText",
    name: "default",
    props: {
      markup: "<font color='#ffd700'>Gold</font> <unknownTag>kept</unknownTag><br><br><br><br>end",
    },
  },
  { id: "RiotText empty", file: "RiotText", name: "default", props: { markup: "   " } },
  {
    id: "HoverCard closed",
    file: "HoverCard",
    name: "default",
    props: { content: "card text", children: "trigger" },
  },
  {
    id: "SearchInput empty",
    file: "SearchInput",
    name: "default",
    props: { value: "", onChange: noop, placeholder: "Search" },
  },
  {
    id: "SearchInput typed",
    file: "SearchInput",
    name: "default",
    props: { value: "ann", onChange: noop, placeholder: "Search" },
  },
  ...(["all", "kSilver", "kGold", "kPrismatic"] as const).map((value) => ({
    id: `RarityFilter ${value}`,
    file: "RarityFilter",
    name: "default",
    props: { value, onChange: noop },
  })),
  { id: "ScoreCell none", file: "ScoreCell", name: "default", props: { score: null, badge: null } },
  {
    id: "ScoreCell plain",
    file: "ScoreCell",
    name: "default",
    props: { score: 6.25, badge: null },
  },
  { id: "ScoreCell mvp", file: "ScoreCell", name: "default", props: { score: 9.4, badge: "MVP" } },
  {
    id: "ScoreBadge large",
    file: "ScoreCell",
    name: "ScoreBadge",
    props: { badge: "ACE", large: true },
  },
  {
    id: "StatBars",
    file: "StatBars",
    name: "default",
    props: {
      damage: 31250,
      taken: 0,
      heal: 900,
      max: { dmg: 40000, taken: 20000, heal: 0 },
      class: "w-40",
    },
  },
  { id: "WinRateBar win", file: "WinRateBar", name: "default", props: { wins: 6, total: 10 } },
  { id: "WinRateBar empty", file: "WinRateBar", name: "default", props: { wins: 0, total: 0 } },
  { id: "Markdown", file: "Markdown", name: "default", props: { text: RELEASES[0]!.body } },
  {
    id: "ActivityCalendar",
    file: "ActivityCalendar",
    name: "default",
    props: {
      days: new Map([
        [FIRST + 2 * DAY, { games: 1, wins: 1 }],
        [FIRST + 3 * DAY, { games: 4, wins: 2 }],
        [FIRST + 20 * DAY, { games: 2, wins: 0 }],
      ]),
      first: FIRST,
      last: FIRST + 40 * DAY,
      through: FIRST + 30 * DAY,
      cell: 14,
    },
  },
  {
    id: "ChampionIcon",
    file: "ChampionIcon",
    name: "default",
    props: { championId: 1, size: 40, title: "Annie", class: "border-2" },
  },
  {
    id: "ChampionIcon square",
    file: "ChampionIcon",
    name: "default",
    props: { championId: 1, rounded: false },
  },
  {
    id: "SummonerIcon",
    file: "SummonerIcon",
    name: "default",
    props: { iconId: 29, size: 30, lazy: true },
  },
  { id: "SummonerIcon none", file: "SummonerIcon", name: "default", props: { iconId: null } },
  {
    id: "SummonerSpellIcon",
    file: "SummonerSpellIcon",
    name: "default",
    props: { spellId: 4, size: 18 },
  },
  {
    id: "SummonerSpellIcon none",
    file: "SummonerSpellIcon",
    name: "default",
    props: { spellId: 0 },
  },
  {
    id: "ChallengeToken",
    file: "ChallengeToken",
    name: "default",
    props: {
      iconPath: "/lol-game-data/assets/challenges/config/1/tokens/gold.png",
      dim: true,
      title: "Gold",
    },
  },
  {
    id: "ChallengeToken none",
    file: "ChallengeToken",
    name: "default",
    props: { iconPath: "", size: 24 },
  },
  { id: "ItemIcon", file: "ItemIcon", name: "default", props: { itemId: 1001, size: 22 } },
  { id: "ItemIcon empty", file: "ItemIcon", name: "default", props: { itemId: 0 } },
  {
    id: "AugmentIcon named",
    file: "AugmentIcon",
    name: "default",
    props: { augmentId: 201, showName: true },
  },
  {
    id: "AugmentIcon blank name",
    file: "AugmentIcon",
    name: "default",
    props: { augmentId: 202, size: 22, showName: true, nameClass: "text-sm" },
  },
  {
    id: "FilterMenu",
    file: "FilterMenu",
    name: "default",
    props: { active: 2, onReset: noop, children: "fields" },
  },
  {
    id: "FilterMenu idle",
    file: "FilterMenu",
    name: "default",
    props: { active: 0, onReset: noop, children: "fields" },
  },
  {
    id: "FilterField",
    file: "FilterMenu",
    name: "FilterField",
    props: { label: "Patch", children: "select" },
  },
  {
    id: "SortHeader active",
    file: "SortHeader",
    name: "default",
    props: {
      sortKey: "games",
      sortDir: "asc",
      onSort: noop,
      label: "Games",
      field: "games",
      numeric: true,
      hint: "Games played",
    },
  },
  {
    id: "SortHeader idle",
    file: "SortHeader",
    name: "default",
    props: {
      sortKey: "games",
      sortDir: "desc",
      onSort: noop,
      label: "Name",
      field: "name",
      compact: true,
    },
  },
  {
    id: "CycleSortHeader",
    file: "SortHeader",
    name: "CycleSortHeader",
    props: {
      sortKey: "doubles",
      sortDir: "desc",
      onSort: noop,
      steps: [
        { field: "multikills", label: "Multikills" },
        { field: "doubles", label: "Doubles" },
      ],
    },
  },
  {
    id: "DialogFrame",
    file: "DialogFrame",
    name: "default",
    props: {
      kicker: "Update",
      title: "Version 1.2.1",
      footer: "buttons",
      children: "body",
      onDismiss: noop,
    },
  },
  {
    id: "VersionJump",
    file: "DialogFrame",
    name: "VersionJump",
    props: { from: "1.2.0", to: "1.2.1" },
  },
  { id: "ReleaseNotes many", file: "ReleaseNotes", name: "default", props: { releases: RELEASES } },
  {
    id: "ReleaseNotes one",
    file: "ReleaseNotes",
    name: "default",
    props: { releases: RELEASES.slice(0, 1) },
  },
  {
    id: "MinGamesFilter",
    file: "MinGamesFilter",
    name: "default",
    props: { value: 5, onChange: noop, max: 30 },
  },
  {
    id: "RecordTogetherCard",
    file: "SharedStats",
    name: "RecordTogetherCard",
    props: {
      wins: 7,
      games: 11,
      recent: [
        { game_id: 5, win: 1 },
        { game_id: 4, win: 1 },
        { game_id: 3, win: 0 },
      ],
    },
  },
  {
    id: "TaggedRiotId",
    file: "SharedStats",
    name: "TaggedRiotId",
    props: { id: "Pal#KR1", tagClass: "text-xs" },
  },
  { id: "ScoreMeter", file: "SharedStats", name: "ScoreMeter", props: { score: 7.3 } },
  {
    id: "BadgeCounts",
    file: "SharedStats",
    name: "BadgeCounts",
    props: { mvps: 3, aces: 1, scoredWins: 9, scoredLosses: 0 },
  },
  {
    id: "ScoreValue",
    file: "SharedStats",
    name: "ScoreValue",
    props: { score: 8.04, color: "text-sky-400" },
  },
  {
    id: "ScoreValue none",
    file: "SharedStats",
    name: "ScoreValue",
    props: { score: null, color: "text-sky-400" },
  },
  { id: "GamesHeading", file: "SharedStats", name: "GamesHeading", props: { games: 1 } },
  {
    id: "RowScore caption",
    file: "SharedStats",
    name: "RowScore",
    props: { score: 5.5, badge: null },
  },
  {
    id: "RowScore bare",
    file: "SharedStats",
    name: "RowScore",
    props: { score: 9.9, badge: "MVP", caption: false },
  },
  {
    id: "RowPlayer",
    file: "SharedStats",
    name: "RowPlayer",
    props: { name: "Pal", you: true, children: "Annie" },
  },
  {
    id: "KdaTotals",
    file: "SharedStats",
    name: "KdaTotals",
    props: { kills: 1200, deaths: 3, assists: 45 },
  },
  {
    id: "RecordCard",
    file: "RecordCard",
    name: "RecordCard",
    props: {
      label: "Most Kills",
      icon: "SwordsIcon",
      accent: "gold",
      value: 21,
      sub: "we don't talk about this one",
      match: MATCH,
      champData: FAKE_API.getChampionData,
      onOpen: noop,
    },
  },
  {
    id: "RecordCard plain",
    file: "RecordCard",
    name: "RecordCard",
    props: {
      label: "Fastest Win",
      icon: "TimerIcon",
      accent: "win",
      value: "18:20",
      match: { ...MATCH, win: 0 },
      champData: {},
    },
  },
  {
    id: "MatchScoreboard",
    file: "MatchScoreboard",
    name: "default",
    props: { detail: DETAIL, champData: FAKE_API.getChampionData, puuids: ["puuid-a"] },
  },
  {
    id: "MatchScoreboard multikills",
    file: "MatchScoreboard",
    name: "default",
    props: { detail: DETAIL, champData: {}, puuids: null, multikills: true },
  },
  {
    id: "MatchScoreboard no players",
    file: "MatchScoreboard",
    name: "default",
    props: { detail: { ...DETAIL, participants: [] }, champData: {}, puuids: null },
  },
  {
    id: "LiveScoreboard",
    file: "LiveScoreboard",
    name: "default",
    props: { players: LIVE_PLAYERS, champData: FAKE_API.getChampionData },
    ignore: LINK_DISCOVERY,
  },
  {
    id: "LiveScoreboard one side",
    file: "LiveScoreboard",
    name: "default",
    props: { players: LIVE_PLAYERS.slice(0, 2), champData: {} },
    ignore: LINK_DISCOVERY,
  },
];

// Every icon each icon module exports, rendered the way callers draw them
export const ICON_FILES = ["icons", "SettingsIcons"] as const;
export const ICON_PROPS = { class: "h-4 w-4" };

// What each case renders from, written beside the 1.2.1 snapshots, so a
// snapshot file made from other cases is caught
function fingerprint(value: unknown): string {
  const text = JSON.stringify(value, (_key, v: unknown) =>
    v instanceof Map ? [...v] : typeof v === "function" ? "fn" : v,
  );
  return Bun.hash(text).toString(36);
}

export function caseFingerprints(): Record<string, string> {
  return {
    ...Object.fromEntries(CASES.map((c) => [c.id, fingerprint(c)])),
    icons: fingerprint([ICON_FILES, ICON_PROPS]),
  };
}
