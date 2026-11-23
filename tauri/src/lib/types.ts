// The contract is generated from the Rust commands into bindings.ts. Re-exported here
// because the pages name this module everywhere.
import type { AugmentEntry, ChampionEntry, ItemEntry, SummonerSpellEntry } from "../bindings";
export * from "../bindings";
export { MIN_GROUP_MEMBER_GAMES, MIN_SHARED_GAMES } from "../shared/teammates";

export type ChampionData = { [id: number]: ChampionEntry };
export type AugmentData = { [id: number]: AugmentEntry };
export type ItemData = { [id: number]: ItemEntry };
export type SummonerSpellData = { [id: number]: SummonerSpellEntry };

export interface ParsedParticipant {
  participantId: number;
  championId: number;
  teamId: number;
  puuid: string | null;
  summonerName: string;
  kills: number;
  deaths: number;
  assists: number;
  doubleKills: number;
  tripleKills: number;
  quadraKills: number;
  pentaKills: number;
  totalDamageDealtToChampions: number;
  totalDamageTaken: number;
  goldEarned: number;
  totalHeal: number;
  largestKillingSpree: number;
  spell1Id: number | null;
  spell2Id: number | null;
  items: number[];
  augments: number[];
  win: boolean;
  isSelf: boolean;
}

// Filters another page opens the Match History on, carried in the navigation's
// state: the Champions page's link to every game on one champion
export interface MatchHistoryLink {
  championId: number;
  patch?: string;
  queue?: number;
  season?: string;
}

// The view another page returns to the Friends list on, carried in the
// navigation's state
export interface FriendsLink {
  view: "players" | "groups";
}
