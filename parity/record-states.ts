import fs from "node:fs";
import path from "node:path";
import { openClientState } from "./capture-client.ts";
import { canonicalize } from "./canon.ts";
import {
  GOLDEN_FORMAT,
  channelDirName,
  type GoldenManifest,
  type IpcGolden,
  type Json,
  type Outcome,
  type StateIndex,
} from "./golden-format.ts";
import {
  dataDbSha256,
  drain,
  parseChannels,
  redact,
  writeJson,
  type SeamRecord,
} from "./record-ipc.ts";
import { PARITY_DIR, REPO_DIR } from "./lib/data.ts";
import { gameRunning } from "./lib/no-game.ts";
import { startElectron, type RunningElectron } from "./run-electron.ts";
import { STATES, applyState, resolveVars, selectStates, type StateRow } from "./states.ts";
import crypto from "node:crypto";
import type { Page } from "playwright";

const GOLDEN_DIR = path.join(PARITY_DIR, "out", "golden");
const QUIET_MS = 400;
const FIRST_TICK_TIMEOUT_MS = 45_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface Call {
  channel: string;
  args: Json[];
  outcome: Outcome;
  nonFinite: string[];
}

/** Start and end records of the invokes that ran, in the order the main process received them. */
export function callsFrom(records: SeamRecord[]): Call[] {
  const ends = new Map<number, SeamRecord>();
  for (const record of records) if (record.k === "end") ends.set(record.id!, record);
  const calls: Call[] = [];
  for (const record of records) {
    if (record.k !== "start") continue;
    const end = ends.get(record.id!);
    if (!end) continue;
    const channel = record.channel!;
    const outcome: Outcome = end.ok
      ? end.void
        ? { kind: "void" }
        : { kind: "value", result: end.result ?? null }
      : {
          kind: "error",
          name: end.name ?? "Error",
          message: end.message ?? "",
          invokeMessage: `Error invoking remote method '${channel}': ${end.name ?? "Error"}: ${end.message ?? ""}`,
        };
    calls.push({ channel, args: record.args ?? [], outcome, nonFinite: end.nonFinite ?? [] });
  }
  return calls;
}

/** The cases already on disk for a channel, lowest `seq` first, which is the order replay tries them. */
export class CaseBook {
  private byChannel = new Map<string, { id: string; seq: number; key: string; answer: string }[]>();
  constructor(private out: string) {}

  private load(channel: string) {
    let list = this.byChannel.get(channel);
    if (!list) {
      list = [];
      const dir = path.join(this.out, "ipc", channelDirName(channel));
      if (fs.existsSync(dir)) {
        for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
          const golden = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as IpcGolden;
          list.push({
            id: golden.case,
            seq: golden.seq,
            key: canonicalize(golden.args),
            answer: canonicalize(golden.outcome as unknown as Json),
          });
        }
        list.sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id));
      }
      this.byChannel.set(channel, list);
    }
    return list;
  }

  /** A case with the same arguments and the same outcome. Arguments alone are not enough, because one argument list can have several recorded answers. */
  find(channel: string, args: Json[], answer: string): string | undefined {
    const key = canonicalize(args);
    return this.load(channel).find((c) => c.key === key && c.answer === answer)?.id;
  }

  /** The cases replay picks by arguments alone: every case at the lowest `seq` with these arguments. */
  byArgs(channel: string, args: Json[]): { id: string; answer: string }[] {
    const key = canonicalize(args);
    const matches = this.load(channel).filter((c) => c.key === key);
    return matches.filter((c) => c.seq === matches[0]?.seq);
  }

  add(channel: string, id: string, args: Json[], answer: string) {
    this.load(channel).push({ id, seq: STATE_SEQ, key: canonicalize(args), answer });
  }
}

/** Above every hand-written case, so replay by arguments alone still picks the original answer. */
export const STATE_SEQ = 1_000_000;

function caseId(args: Json[], answer: string): string {
  return `state-${crypto
    .createHash("sha256")
    .update(canonicalize(args) + answer)
    .digest("hex")
    .slice(0, 10)}`;
}

export function recordState(
  state: StateRow,
  calls: Call[],
  book: CaseBook,
  methods: Map<string, string>,
  out: string,
  runDir: string,
): StateIndex {
  const index: StateIndex = {
    format: GOLDEN_FORMAT,
    state: state.id,
    group: state.group,
    route: state.route,
    viewport: state.viewport,
    calls: [],
  };
  for (const call of calls) {
    const answer = canonicalize(JSON.parse(redact(JSON.stringify(call.outcome), runDir)) as Json);
    let id = book.find(call.channel, call.args, answer);
    if (!id) {
      id = caseId(call.args, answer);
      const golden: IpcGolden = {
        format: GOLDEN_FORMAT,
        channel: call.channel,
        method: methods.get(call.channel) ?? null,
        registered: true,
        case: id,
        description: `the call the page made in state ${state.id}`,
        group: "state",
        seq: STATE_SEQ,
        args: call.args,
        outcome: call.outcome,
        events: [],
        effects: [],
        files: [],
        nonFinite: call.nonFinite,
      };
      writeJson(path.join(out, "ipc", channelDirName(call.channel), `${id}.json`), golden, runDir);
      book.add(call.channel, id, call.args, answer);
    }
    index.calls.push({
      seq: index.calls.length,
      channel: call.channel,
      method: methods.get(call.channel) ?? null,
      args: call.args,
      case: id,
    });
  }
  return index;
}

/**
 * The status reads "connecting" until the connect loop's first tick, about 5 s after launch.
 * Poller events are left out of the goldens, so a replay never sees that tick, and a page that
 * read "connecting" never settles there. A state that holds the loop keeps "connecting" by design.
 */
async function waitForFirstTick(page: Page, state: StateRow): Promise<string> {
  const deadline = Date.now() + FIRST_TICK_TIMEOUT_MS;
  for (;;) {
    const status = await page.evaluate(async () => {
      const api = window.api as unknown as Record<string, () => Promise<string>>;
      return api.getLcuStatus!();
    });
    if (status !== "connecting" || state.client?.hold) return status;
    if (Date.now() > deadline) throw new Error(`${state.id}: status still "connecting"`);
    await sleep(100);
  }
}

/**
 * A replay resolves a state's variables from the answers it picks by arguments alone, so each of
 * `resolveVars`' reads must pick exactly the answer Electron gave on this data. Otherwise a game
 * id from another state's answer, such as a fake client's new game, ends up in the route.
 */
export function varsReadMismatches(calls: Call[], book: CaseBook, runDir: string): string[] {
  return calls.flatMap((call) => {
    const answer = canonicalize(JSON.parse(redact(JSON.stringify(call.outcome), runDir)) as Json);
    const picks = book.byArgs(call.channel, call.args);
    const label = `${call.channel} ${canonicalize(call.args)}`;
    if (picks.length !== 1) return [`${label}: replay picks ${picks.length} cases`];
    return picks[0]!.answer === answer ? [] : [`${label}: replay picks ${picks[0]!.id}`];
  });
}

const SETTINGS_CHANNELS = new Set(["settings:get", "settings:set"]);

/** The page's own calls, without the driver's settings reads and writes. */
export const pageCalls = (index: StateIndex) =>
  index.calls
    .filter((call) => !SETTINGS_CHANNELS.has(call.channel))
    .map((call) => `${call.channel} ${canonicalize(call.args)} ${call.case}`);

/** Rows that seed `view:` keys, each paired with the default state of its route. */
export const viewKeyRows = (states: StateRow[]) =>
  states.flatMap((state) => {
    if (!state.pre?.some((step) => step.op === "local" && step.key.startsWith("view:"))) return [];
    const base = states.find((other) => other.group === "default" && other.route === state.route);
    return base ? [{ state: state.id, base: base.id }] : [];
  });

/** A view-key row whose page calls equal its route's default never applied its filters. */
export function unfilteredViewKeyRows(states: StateRow[], dir: string): string[] {
  const read = (id: string) => {
    const file = path.join(dir, `${id}.json`);
    return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as StateIndex) : null;
  };
  return viewKeyRows(states).flatMap(({ state, base }) => {
    const [mine, theirs] = [read(state), read(base)];
    if (!mine || !theirs) return [];
    const same = canonicalize(pageCalls(mine)) === canonicalize(pageCalls(theirs));
    return same ? [`${state}: page calls equal ${base}'s`] : [];
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const value = (flag: string) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
  const data = value("--data") ?? "fixture";
  const repo = value("--repo") ?? REPO_DIR;
  const out = path.resolve(value("--out") ?? GOLDEN_DIR);
  const states = selectStates(value("--states") ?? "all");
  if (!fs.existsSync(path.join(out, "ipc"))) {
    throw new Error(`${out} has no ipc goldens. Run record-ipc.ts first.`);
  }
  const recorded = (
    JSON.parse(fs.readFileSync(path.join(out, "manifest.json"), "utf8")) as GoldenManifest
  ).dbSha256;
  if (dataDbSha256(data) !== recorded) {
    throw new Error(`${data} is not the data the ipc goldens in ${out} were recorded on`);
  }
  process.env.SEAM_IPC = "1";

  const channels = parseChannels(
    fs.readFileSync(path.join(REPO_DIR, "src", "shared", "api.ts"), "utf8"),
  );
  const methods = new Map(Object.entries(channels).map(([method, channel]) => [channel, method]));
  const book = new CaseBook(out);
  for (const state of states)
    fs.rmSync(path.join(out, "states", `${state.id}.json`), { force: true });
  const scratch = path.join(PARITY_DIR, "out", "states-tmp");
  fs.mkdirSync(scratch, { recursive: true });

  const finish = (index: StateIndex, runDir: string) => {
    writeJson(path.join(out, "states", `${index.state}.json`), index, runDir);
    console.log(`state ${index.state}: ${index.calls.length} calls`);
  };

  const failures: string[] = [];
  const varsReads: { calls: Call[]; runDir: string }[] = [];
  let running: RunningElectron | undefined;
  let runData = "";
  let vars: Record<string, string> = {};
  const close = async () => {
    await running?.close();
    running = undefined;
  };

  try {
    for (const state of states) {
      if (state.client) {
        await close();
        const clientRun = await openClientState(state, { data, repo, dir: scratch });
        try {
          console.log(
            `state ${state.id}: status ${await waitForFirstTick(clientRun.running.page, state)}`,
          );
          await drain(clientRun.running);
          let error: string | undefined;
          try {
            await clientRun.drive();
          } catch (caught) {
            error = String(caught).split("\n")[0];
            failures.push(`${state.id}: ${error}`);
          }
          await sleep(QUIET_MS);
          const calls = callsFrom(await drain(clientRun.running));
          const index = recordState(state, calls, book, methods, out, clientRun.running.runDir);
          if (error) index.error = error;
          finish(index, clientRun.running.runDir);
        } finally {
          await clientRun.finish(scratch);
        }
        continue;
      }
      const wanted = state.data ?? data;
      if (running && (gameRunning() || wanted !== runData)) await close();
      if (!running) {
        runData = wanted;
        running = await startElectron({ data: wanted, repo });
        await drain(running);
        vars = await resolveVars(running.page);
        console.log(`vars ${wanted}: ${JSON.stringify(vars)}`);
        if (wanted === data)
          varsReads.push({ calls: callsFrom(await drain(running)), runDir: running.runDir });
      }
      console.log(`state ${state.id}: status ${await waitForFirstTick(running.page, state)}`);
      await drain(running);
      await applyState(running.ctx, state, vars);
      await sleep(QUIET_MS);
      const calls = callsFrom(await drain(running));
      finish(recordState(state, calls, book, methods, out, running.runDir), running.runDir);
    }
  } finally {
    await close();
    fs.rmSync(scratch, { recursive: true, force: true });
  }

  const finalBook = new CaseBook(out);
  for (const { calls, runDir } of varsReads) {
    for (const miss of varsReadMismatches(calls, finalBook, runDir))
      failures.push(`resolveVars ${miss}`);
  }
  failures.push(...unfilteredViewKeyRows(STATES, path.join(out, "states")));
  for (const failure of failures) console.log(`FAIL ${failure}`);
  const manifestFile = path.join(out, "manifest.json");
  if (fs.existsSync(manifestFile)) {
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as GoldenManifest;
    const dir = path.join(out, "states");
    manifest.states = fs.existsSync(dir)
      ? fs
          .readdirSync(dir)
          .filter((f) => f.endsWith(".json"))
          .map((f) => f.slice(0, -5))
          .sort()
      : [];
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + "\n");
  }
  if (failures.length) process.exitCode = 1;
}

if (import.meta.main) await main();
