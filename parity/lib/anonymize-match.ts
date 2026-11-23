import { UUID_SOURCE } from "./uuid.ts";

/** The real identities of a source snapshot, folded to lower case. */
export interface Identities {
  names: string[];
  tags: string[];
  puuids: string[];
}

export type MatchKind = "puuid" | "name" | "tag";

export interface Match {
  kind: MatchKind;
  /** The matched text, as it appears in the input. */
  text: string;
  index: number;
}

const WORD = "\\p{L}\\p{N}\\p{M}_";
const isWord = (char: string) => new RegExp(`^[${WORD}]$`, "u").test(char);
// Scripts written without spaces between words, plus Hangul, which attaches particles to a
// name. A boundary rule would miss every mention of a name in them.
const isUnspaced = (char: string) =>
  /^[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}\p{sc=Thai}\p{sc=Lao}\p{sc=Khmer}\p{sc=Myanmar}]$/u.test(
    char,
  );
const isDigit = (char: string) => /^\p{Nd}$/u.test(char);
export const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/**
 * A name matches only as a whole token: a word character beside it means it is part of a
 * longer word. An edge that is a digit also refuses `.`, `,`, `:`, `-` or `/` and another
 * digit beside it, so an all-digit name never matches a piece of a version, date or number.
 */
function bounded(value: string) {
  const first = /^./su.exec(value)![0];
  const last = /.$/su.exec(value)![0];
  let left = "";
  let right = "";
  if (isWord(first) && !isUnspaced(first)) {
    left = isDigit(first) ? `(?<![${WORD}])(?<!\\p{Nd}[.,:\\-/])` : `(?<![${WORD}])`;
  }
  if (isWord(last) && !isUnspaced(last)) {
    right = isDigit(last) ? `(?![${WORD}])(?![.,:\\-/]\\p{Nd})` : `(?![${WORD}])`;
  }
  return `${left}${escapeRegExp(value)}${right}`;
}

const alternation = (values: string[], wrap: (value: string) => string) =>
  values.length
    ? [...values]
        .sort((a, b) => b.length - a.length)
        .map(wrap)
        .join("|")
    : "(?!)";

/**
 * Finds real PUUIDs, names and tag lines in text, by exact match against a known identity set.
 *
 * - A PUUID matches anywhere, in any case. A UUID that is not a known PUUID is skipped whole,
 *   so a name is never found inside one.
 * - A name matches as an identity in two places only: right before `#` and a tag, the `name#tag`
 *   form the app stores, and as the whole value of a string. A name among other words is
 *   ordinary text, since a player can be called "you" or "Snow" and the game says both.
 * - A tag line matches only right after `<word>#`. A bare tag line is a region code or a number
 *   and identifies nobody.
 */
export class IdentityMatcher {
  private readonly text: RegExp;
  private readonly structure: RegExp;
  private readonly puuids: RegExp;
  private readonly bare: RegExp;
  private readonly whole: Set<string>;

  constructor(identities: Identities) {
    const puuid = alternation(identities.puuids, escapeRegExp);
    const name = alternation(identities.names, bounded);
    const tag = `(?<=[${WORD}])#(?<tag>${alternation(identities.tags, escapeRegExp)})(?![${WORD}])`;
    const uuid = `(?<uuid>${UUID_SOURCE})`;
    const beforeTag = `(?=#[${WORD}])`;
    this.text = new RegExp(`(?<puuid>${puuid})|${uuid}|(?<name>${name})${beforeTag}|${tag}`, "giu");
    this.bare = new RegExp(`(?<name>${name})`, "giu");
    this.whole = new Set(identities.names.map((value) => value.toLowerCase()));
    this.structure = new RegExp(`(?<puuid>${puuid})|${uuid}|${tag}`, "giu");
    this.puuids = new RegExp(`(?<puuid>${puuid})`, "gi");
  }

  /** Every real PUUID in raw bytes, read as latin1. Names are not searched in binary data. */
  findPuuids(bytes: string): Match[] {
    return collect(this.puuids, bytes);
  }

  /** Every real identity in free text. */
  find(text: string): Match[] {
    const hits = this.cached(this.textHits, this.text, text);
    const whole = this.wholeName(text);
    return whole && !hits.some((hit) => hit.kind === "name") ? [...hits, whole] : hits;
  }

  /** Names among other words, which are text and not identities. Counted for the audit's report. */
  countBareNames(text: string): number {
    let count = this.bareCounts.get(text);
    if (count === undefined) {
      const named = this.find(text).filter((hit) => hit.kind === "name").length;
      this.bareCounts.set(text, (count = Math.max(0, collect(this.bare, text).length - named)));
    }
    return count;
  }
  private readonly bareCounts = new Map<string, number>();

  private wholeName(text: string): Match | null {
    const trimmed = text.trim();
    if (!trimmed || !this.whole.has(trimmed.toLowerCase())) return null;
    return { kind: "name", text: trimmed, index: text.indexOf(trimmed) };
  }

  /** Every real identity in an object key, where only PUUIDs and `name#tag` forms count. */
  findInKey(key: string): Match[] {
    return this.cached(this.structureHits, this.structure, key);
  }

  // A fixture repeats the same short strings (enums, versions, keys) about a million times.
  private readonly textHits = new Map<string, Match[]>();
  private readonly structureHits = new Map<string, Match[]>();
  private cached(cache: Map<string, Match[]>, pattern: RegExp, text: string) {
    let hits = cache.get(text);
    if (!hits) cache.set(text, (hits = collect(pattern, text)));
    return hits;
  }

  replace(text: string, fake: (match: Match) => string): string {
    const whole = this.wholeName(text);
    if (whole) return text.replace(whole.text, fake(whole));
    return substitute(this.text, text, fake);
  }

  /** Text safe to print: every identity and every bare name in it is masked. */
  redact(text: string, mask: string): string {
    return substitute(this.text, text, () => mask).replace(this.bare, mask);
  }

  replaceInKey(key: string, fake: (match: Match) => string): string {
    return substitute(this.structure, key, fake);
  }
}

function toMatch(groups: Record<string, string | undefined>, index: number): Match | null {
  if (groups.puuid !== undefined) return { kind: "puuid", text: groups.puuid, index };
  if (groups.name !== undefined) return { kind: "name", text: groups.name, index };
  if (groups.tag !== undefined) return { kind: "tag", text: groups.tag, index: index + 1 };
  return null;
}

function collect(pattern: RegExp, text: string): Match[] {
  const out: Match[] = [];
  for (const found of text.matchAll(pattern)) {
    const match = toMatch(found.groups ?? {}, found.index);
    if (match) out.push(match);
  }
  return out;
}

function substitute(pattern: RegExp, text: string, fake: (match: Match) => string): string {
  return text.replace(pattern, (...args) => {
    const groups = args.at(-1) as Record<string, string | undefined>;
    const index = args.at(-3) as number;
    const whole = args[0] as string;
    const match = toMatch(groups, index);
    if (!match) return whole;
    return match.kind === "tag" ? `#${fake(match)}` : fake(match);
  });
}
