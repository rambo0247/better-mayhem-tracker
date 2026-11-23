import type { BackfillProgress, BackfillResult, ImportProgress } from "@shared/api";

type Count = (value: number) => string;
type Day = (timestamp: number) => string;

/** The pair `setSetting` receives when a switch holding `current` is flipped */
export function toggleWrite(key: string, current: boolean): [key: string, value: string] {
  return [key, String(!current)];
}

/** The queues switched off after flipping `queueId`, and the stored setting value */
export function flipQueue(
  hidden: ReadonlySet<number>,
  queueId: number,
): { next: Set<number>; setting: string } {
  const next = new Set(hidden);
  if (!next.delete(queueId)) next.add(queueId);
  return { next, setting: [...next].join(",") };
}

export function parseHiddenQueues(raw: string | null | undefined): Set<number> {
  return new Set(raw ? raw.split(",").map(Number) : []);
}

export function importProgressLine(progress: ImportProgress, count: Count): string {
  return `Importing game ${count(progress.current)} of ${count(progress.total)}, ${count(progress.imported)} new so far`;
}

export function backfillProgressLine(progress: BackfillProgress, count: Count): string {
  return progress.total === 0
    ? "Nothing new to check"
    : `Checking game ${count(progress.current)} of ${count(progress.total)}, ${count(progress.added)} added so far`;
}

export function backfillOutcome(result: BackfillResult, count: Count, day: Day): string {
  const summary =
    result.added > 0
      ? `Added ${count(result.added)} game(s) from ${count(result.scanned)} found in your Riot history`
      : `No new Mayhem games found (${count(result.scanned)} games checked)`;
  if (result.cancelled) {
    return `Stopped after adding ${count(result.added)} game(s). Run it again to finish.`;
  }
  if (result.limit?.kind === "service") {
    return `${summary}. Riot's match history for this account only goes back to ${day(result.limit.historyStart)}, so older games can't be imported, but every new game from here on is kept.`;
  }
  if (result.limit?.kind === "paging") {
    return `${summary}. Stopped at the ${count(result.scanned)}-game paging limit, so anything older was not checked.`;
  }
  return summary;
}
