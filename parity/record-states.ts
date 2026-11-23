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
import { drain, parseChannels, writeJson, type SeamRecord } from "./record-ipc.ts";
import { PARITY_DIR, REPO_DIR } from "./lib/data.ts";
import { gameRunning } from "./lib/no-game.ts";
import { startElectron, type RunningElectron } from "./run-electron.ts";
import { applyState, resolveVars, selectStates, type StateRow } from "./states.ts";
import crypto from "node:crypto";

const GOLDEN_DIR = path.join(PARITY_DIR, "out", "golden");
const QUIET_MS = 400;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Call {
  channel: string;
  args: Json[];
  outcome: Outcome;
  nonFinite: string[];
}

/** Start and end records of the invokes that ran, in the order the main process received them. */
function callsFrom(records: SeamRecord[]): Call[] {
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
class CaseBook {
  private byChannel = new Map<string, { id: string; seq: number; key: string }[]>();
  constructor(private out: string) {}

  private load(channel: string) {
    let list = this.byChannel.get(channel);
    if (!list) {
      list = [];
      const dir = path.join(this.out, "ipc", channelDirName(channel));
      if (fs.existsSync(dir)) {
        for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
          const golden = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as IpcGolden;
          list.push({ id: golden.case, seq: golden.seq, key: canonicalize(golden.args) });
        }
        list.sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id));
      }
      this.byChannel.set(channel, list);
    }
    return list;
  }

  find(channel: string, args: Json[]): string | undefined {
    const key = canonicalize(args);
    return this.load(channel).find((c) => c.key === key)?.id;
  }

  add(channel: string, id: string, args: Json[]) {
    this.load(channel).push({ id, seq: 0, key: canonicalize(args) });
  }
}

function caseId(args: Json[]): string {
  return `state-${crypto.createHash("sha256").update(canonicalize(args)).digest("hex").slice(0, 10)}`;
}

function recordState(
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
    let id = book.find(call.channel, call.args);
    if (!id) {
      id = caseId(call.args);
      const golden: IpcGolden = {
        format: GOLDEN_FORMAT,
        channel: call.channel,
        method: methods.get(call.channel) ?? null,
        registered: true,
        case: id,
        description: `the call the page made in state ${state.id}`,
        group: "state",
        seq: 0,
        args: call.args,
        outcome: call.outcome,
        events: [],
        effects: [],
        files: [],
        nonFinite: call.nonFinite,
      };
      writeJson(path.join(out, "ipc", channelDirName(call.channel), `${id}.json`), golden, runDir);
      book.add(call.channel, id, call.args);
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
        vars = await resolveVars(running.page);
      }
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
