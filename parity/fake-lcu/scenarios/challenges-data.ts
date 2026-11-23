const LEVELS = [
  "IRON",
  "BRONZE",
  "SILVER",
  "GOLD",
  "PLATINUM",
  "DIAMOND",
  "MASTER",
  "GRANDMASTER",
  "CHALLENGER",
] as const;

const tokenRoot = (id: number) => `/lol-game-data/assets/ASSETS/Challenges/Config/${id}/Tokens`;

interface Spec {
  id: number;
  name: string;
  description: string;
  level: (typeof LEVELS)[number] | "NONE";
  value: number;
  thresholds: number[];
  percentile?: number;
  children?: number[];
  champions?: number[];
  retired?: boolean;
}

function raw(spec: Spec) {
  const levelIndex = spec.level === "NONE" ? -1 : LEVELS.indexOf(spec.level);
  const next = LEVELS[levelIndex + 1];
  const reached = spec.thresholds[levelIndex] ?? 0;
  const ahead = next ? spec.thresholds[levelIndex + 1] : undefined;
  return {
    id: spec.id,
    name: spec.name,
    description: spec.description,
    descriptionShort: spec.description,
    currentLevel: spec.level,
    nextLevel: ahead === undefined ? "NONE" : next,
    currentValue: spec.value,
    currentThreshold: reached,
    nextThreshold: ahead ?? 0,
    percentile: spec.percentile ?? 0.5,
    pointsAwarded: levelIndex < 0 ? 0 : (levelIndex + 1) * 10,
    gameModes: ["ARAM", "KIWI", "KIWI_JADE"],
    retireTimestamp: spec.retired ? 1_700_000_000_000 : 0,
    childrenIds: spec.children ?? [],
    idListType: spec.champions ? "CHAMPION" : "NONE",
    completedIds: spec.champions ?? [],
    levelToIconPath: Object.fromEntries(LEVELS.map((l) => [l, `${tokenRoot(spec.id)}/${l}.png`])),
    thresholds: Object.fromEntries(
      LEVELS.map((l, i) => [
        l,
        {
          value: spec.thresholds[i] ?? 0,
          rewards: [{ category: "CHALLENGE_POINTS", name: "", quantity: (i + 1) * 10 }],
        },
      ]),
    ),
  };
}

/**
 * An invented ARAM challenge tree in the shape the client answers with: the capstone, its
 * three groups, a few challenges each, and one retired seasonal. Names and numbers are made
 * up, so nothing here comes from a real account.
 */
export function challengesTree() {
  const specs: Spec[] = [
    {
      id: 101000,
      name: "Parity Authority",
      description: "Earn points across every group of the tree.",
      level: "GOLD",
      value: 1820,
      thresholds: [100, 400, 800, 1200, 2400, 4000, 6000, 8000, 10000],
      percentile: 0.18,
      children: [101100, 101200, 101300],
    },
    {
      id: 101100,
      name: "Damage Dealer",
      description: "Hurt the other team a great deal.",
      level: "GOLD",
      value: 540,
      thresholds: [60, 150, 300, 450, 700, 1000, 1400, 1800, 2200],
      percentile: 0.2,
      children: [101101, 101102, 101103, 101104],
    },
    {
      id: 101200,
      name: "Team Player",
      description: "Win fights together.",
      level: "SILVER",
      value: 310,
      thresholds: [60, 150, 300, 450, 700, 1000, 1400, 1800, 2200],
      percentile: 0.4,
      children: [101201, 101202, 101203],
    },
    {
      id: 101300,
      name: "Roster Explorer",
      description: "Play and win on many champions.",
      level: "BRONZE",
      value: 120,
      thresholds: [60, 150, 300, 450, 700, 1000, 1400, 1800, 2200],
      percentile: 0.7,
      children: [101301, 101302],
    },
    {
      id: 101101,
      name: "Heavy Hitter",
      description: "Deal more than 1800 damage per minute in a game.",
      level: "PLATINUM",
      value: 940,
      thresholds: [10, 50, 150, 400, 800, 1500, 2500, 4000, 6000],
      percentile: 0.1,
    },
    {
      id: 101102,
      name: "Glass Cannon",
      description: "Win a game with more kills than the rest of your team.",
      level: "GOLD",
      value: 310,
      thresholds: [10, 50, 150, 300, 600, 1000, 1500, 2500, 4000],
      percentile: 0.25,
    },
    {
      id: 101103,
      name: "Multikill Collector",
      description: "Get a multikill in ten different games.",
      level: "SILVER",
      value: 140,
      thresholds: [10, 50, 100, 200, 400, 800, 1200, 1800, 2400],
      percentile: 0.35,
    },
    {
      id: 101104,
      name: "Last Stand",
      description: "Win after your nexus took damage.",
      level: "NONE",
      value: 3,
      thresholds: [10, 25, 50, 100, 200, 400, 800, 1200, 1600],
    },
    {
      id: 101201,
      name: "Healing Hands",
      description: "Heal your teammates for a lot in one game.",
      level: "SILVER",
      value: 220,
      thresholds: [10, 50, 150, 200, 400, 800, 1200, 1800, 2400],
      percentile: 0.45,
    },
    {
      id: 101202,
      name: "Wall of Steel",
      description: "Absorb damage for your team.",
      level: "BRONZE",
      value: 90,
      thresholds: [10, 50, 150, 300, 600, 1000, 1500, 2500, 4000],
      percentile: 0.6,
    },
    {
      id: 101203,
      name: "Flawless Finish",
      description: "Win a game without losing a tower.",
      level: "IRON",
      value: 22,
      thresholds: [10, 50, 100, 200, 400, 800, 1200, 1800, 2400],
      percentile: 0.8,
    },
    {
      id: 101301,
      name: "Many Faces",
      description: "Win a game on this many different champions.",
      level: "BRONZE",
      value: 31,
      thresholds: [10, 25, 50, 75, 100, 125, 150, 165, 170],
      percentile: 0.7,
      champions: [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24],
    },
    {
      id: 101302,
      name: "All Random",
      description: "Earn an S- or better on a champion you have not before.",
      level: "NONE",
      value: 0,
      thresholds: [5, 15, 30, 60, 100, 125, 150, 165, 170],
    },
    {
      id: 202301,
      name: "Seasonal Sprint",
      description: "A limited-time challenge from a past season.",
      level: "SILVER",
      value: 60,
      thresholds: [10, 25, 50, 100, 200, 400, 800, 1200, 1600],
      percentile: 0.5,
      retired: true,
    },
  ];

  const all = Object.fromEntries(specs.map((spec) => [String(spec.id), raw(spec)]));
  const summary = {
    overallChallengeLevel: "GOLD",
    categoryProgress: [{ current: 540 }, { current: 310 }, { current: 120 }],
    pointsUntilNextRank: 580,
    positionPercentile: 0.18,
    title: { name: "Mayhem Veteran" },
    selectedChallengesString: "101101,101201,101301",
  };
  return { all, summary };
}
