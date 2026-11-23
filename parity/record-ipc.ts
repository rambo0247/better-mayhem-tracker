import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import {
  GOLDEN_FORMAT,
  RUN_TOKEN,
  UNREGISTERED_CHANNEL,
  channelDirName,
  type EffectRecord,
  type EventLine,
  type EventRecord,
  type FileRecord,
  type GoldenManifest,
  type IpcGolden,
  type Json,
  type Outcome,
} from "./golden-format.ts";
import { RENDERER_CALLS } from "./renderer-calls.ts";
import { IPC_CASES, READ_GROUP, type IpcCase, type Prior, type Vars } from "./ipc-cases.ts";
import { startFakeLcu } from "./fake-lcu.ts";
import { loadContext } from "./fake-lcu/context.ts";
import { PARITY_DIR, REPO_DIR, resolveDataRoot } from "./lib/data.ts";
import { FIXED_TIME, TIME_ZONE, startElectron, type RunningElectron } from "./run-electron.ts";

const GOLDEN_DIR = path.join(PARITY_DIR, "out", "golden");
const API_PATH = path.join(REPO_DIR, "src", "shared", "api.ts");
/** Events that fire after a handler returns still belong to it. */
const QUIET_MS = 150;

// --- What the app declares ---

/** Method to channel, read from the `INVOKE_CHANNELS` block of an `api.ts`. */
export function parseChannels(apiText: string): Record<string, string> {
  const block = /export const INVOKE_CHANNELS = \{([\s\S]*?)\} as const/.exec(apiText);
  if (!block) throw new Error("no INVOKE_CHANNELS block in api.ts");
  const out: Record<string, string> = {};
  for (const [, method, channel] of block[1]!.matchAll(/(\w+):\s*"([^"]+)"/g)) {
    out[method!] = channel!;
  }
  return out;
}

/** Event names, read from the `RendererEvents` interface of an `api.ts`. */
export function parseEvents(apiText: string): string[] {
  const block = /export interface RendererEvents \{([\s\S]*?)\n\}/.exec(apiText);
  if (!block) throw new Error("no RendererEvents interface in api.ts");
  return [...block[1]!.matchAll(/"([^"]+)":/g)].map((m) => m[1]!);
}

export interface Coverage {
  channels: { covered: string[]; missing: string[] };
  events: { covered: string[]; missing: string[] };
}

/** A channel is covered by any golden file in its folder, an event by any line in any scenario file. */
export function checkCoverage(goldenDir: string, apiText: string): Coverage {
  const channels = Object.values(parseChannels(apiText));
  const events = parseEvents(apiText);
  const has = (channel: string) => {
    const dir = path.join(goldenDir, "ipc", channelDirName(channel));
    return fs.existsSync(dir) && fs.readdirSync(dir).some((f) => f.endsWith(".json"));
  };
  const seen = new Set<string>();
  const eventsDir = path.join(goldenDir, "events");
  if (fs.existsSync(eventsDir)) {
    for (const file of fs.readdirSync(eventsDir)) {
      if (!file.endsWith(".jsonl")) continue;
      for (const line of fs.readFileSync(path.join(eventsDir, file), "utf8").split("\n")) {
        if (line.trim()) seen.add((JSON.parse(line) as EventLine).event);
      }
    }
  }
  return {
    channels: {
      covered: channels.filter(has),
      missing: channels.filter((c) => !has(c)),
    },
    events: {
      covered: events.filter((e) => seen.has(e)),
      missing: events.filter((e) => !seen.has(e)),
    },
  };
}

export function coverageLine(coverage: Coverage): string {
  const { channels, events } = coverage;
  return `coverage ${channels.covered.length}/${channels.covered.length + channels.missing.length} channels, ${events.covered.length}/${events.covered.length + events.missing.length} events`;
}

// --- Talking to the seam ---

export interface SeamRecord {
  k: "start" | "end" | "send" | "effect" | "card";
  t: number;
  id?: number;
  call?: number | null;
  channel?: string;
  args?: Json[];
  ok?: boolean;
  void?: boolean;
  result?: Json;
  nonFinite?: string[];
  name?: string;
  message?: string;
  hasPayload?: boolean;
  payload?: Json;
  api?: string;
  /** For `card`: the ids the card drew where a name belongs. */
  placeholders?: string[];
}

interface RawResult {
  ok: boolean;
  name?: string;
  message?: string;
}

export const drain = (run: RunningElectron) =>
  run.app.evaluate(() => (globalThis as any).__bmtIpc.drain()) as Promise<SeamRecord[]>;

async function invokeRaw(
  run: RunningElectron,
  channel: string,
  args: unknown[],
): Promise<RawResult> {
  try {
    return await run.page.evaluate(
      ([c, a]) => (window as any).__bmtRawInvoke(c, ...(a as unknown[])),
      [channel, args] as const,
    );
  } catch (error) {
    // The page is gone, as after closeWindow. The main process still recorded the call.
    return { ok: true, name: "PageGone", message: String(error) };
  }
}

async function launch(data: string, repo: string, runDir?: string): Promise<RunningElectron> {
  const run = await startElectron({ data, repo, runDir });
  await run.page.goto("about:blank");
  const ready = await run.page.evaluate(() => typeof (window as any).__bmtRawInvoke);
  if (ready !== "function") throw new Error("the raw invoke preload did not load");
  return run;
}

const FIRST_TICK_TIMEOUT_MS = 45_000;

/**
 * Everything main records from launch until the connect loop's first tick, about 5 s in, moves
 * the status off "connecting". That tick sends `lcu:status-changed` on a timer, so a case it
 * landed in would hold the event on one run and not the next.
 */
async function untilFirstTick(run: RunningElectron, statusChannel: string): Promise<SeamRecord[]> {
  const records: SeamRecord[] = [];
  const deadline = Date.now() + FIRST_TICK_TIMEOUT_MS;
  for (;;) {
    await invokeRaw(run, statusChannel, []);
    const batch = await drain(run);
    records.push(...batch);
    if (batch.find((r) => r.k === "end" && r.ok)?.result !== "connecting") return records;
    if (Date.now() > deadline) throw new Error('the status stayed "connecting"');
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function resolveVars(run: RunningElectron): Promise<Vars> {
  const ask = async (channel: string, ...args: unknown[]): Promise<any> => {
    await invokeRaw(run, channel, args);
    const records = await drain(run);
    const end = records.find((r) => r.k === "end" && r.ok);
    return end?.result;
  };
  const history = await ask("db:match-history", 50, 0);
  const options = await ask("db:match-filters");
  const teammates = await ask("db:teammate-stats");
  const groups = await ask("db:teammate-groups");
  const matches = history.matches as { game_id: number; champion_id: number }[];
  const seasons = options.seasons as string[];
  const patches = options.patches as string[];
  return {
    gameId: matches[0]!.game_id,
    olderGameId: matches[matches.length - 1]!.game_id,
    championId: matches[0]!.champion_id,
    otherChampionId: matches[1]!.champion_id,
    patch: patches[0]!,
    olderPatch: patches[Math.min(3, patches.length - 1)]!,
    queue: (options.queues as number[])[0]!,
    season: seasons[0]!,
    olderSeason: seasons[Math.min(2, seasons.length - 1)]!,
    account: (options.accounts as { puuid: string }[])[0]!.puuid,
    teammateKey: teammates[0]?.key ?? "no-teammates",
    groupKey: groups[0]?.key ?? "no-groups",
  };
}

/**
 * A card page asks main for the item and augment tables of its season's patch, and main loads a
 * patch it has not seen on that first ask. The card photographs itself before a late table
 * arrives, so whether item and augment names appear depends on timing. Every patch's tables are
 * loaded before the first card.
 */
async function warmCardPatches(run: RunningElectron, channels: Record<string, string>) {
  const ask = async (channel: string, ...args: unknown[]): Promise<any> => {
    await invokeRaw(run, channel, args);
    return (await drain(run)).find((r) => r.k === "end" && r.ok)?.result;
  };
  const options = await ask(channels.getMatchFilterOptions!);
  for (const patch of options.patches as string[]) {
    for (const channel of [channels.getItemData!, channels.getAugmentData!]) {
      for (let attempt = 0; attempt < 20; attempt++) {
        const table = await ask(channel, patch);
        if (table && Object.keys(table).length > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  }
  // Icon lookups walk archived patches one at a time, so a card that asks for a dozen at once
  // photographs itself while the walk is part way. Done here, the card finds every answer cached.
  for (const [method, args] of RENDERER_CALLS) {
    if (method === "resolveAugmentIcon") await ask(channels.resolveAugmentIcon!, ...args);
  }
}

// --- One case ---

export function redact(text: string, runDir: string): string {
  let out = text;
  const forms = new Set([runDir, fs.realpathSync(runDir), runDir.replaceAll("\\", "/")]);
  for (const form of forms) out = out.replaceAll(JSON.stringify(form).slice(1, -1), RUN_TOKEN);
  return out;
}

const expandRun = (value: string, runDir: string) => value.replaceAll(RUN_TOKEN, runDir);

function readFileRecord(file: string, runDir: string): FileRecord | null {
  if (!fs.existsSync(file)) return null;
  const bytes = fs.readFileSync(file);
  const record: FileRecord = {
    path: file.replaceAll(runDir, RUN_TOKEN),
    size: bytes.length,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
  };
  const text = bytes.toString("utf8");
  if (Buffer.from(text, "utf8").equals(bytes)) record.text = text;
  else record.base64 = bytes.toString("base64");
  return record;
}

interface Recorded {
  golden: IpcGolden;
  sends: { record: SeamRecord; callId: number | null }[];
  /** Ids a card this call photographed drew in place of names. */
  placeholders: string[];
}

async function runCase(
  run: RunningElectron,
  testCase: IpcCase,
  channel: string | null,
  seq: number,
  vars: Vars,
  prior: Prior,
): Promise<Recorded> {
  const wireChannel = channel ?? UNREGISTERED_CHANNEL;
  const args = testCase.args(vars, prior);
  testCase.prepare?.(run.runDir);
  await run.app.evaluate(
    (_electron, control) => Object.assign((globalThis as any).__bmtIpc.control, control),
    {
      save: testCase.dialogs?.save ? expandRun(testCase.dialogs.save, run.runDir) : null,
      open: testCase.dialogs?.open ? expandRun(testCase.dialogs.open, run.runDir) : null,
    },
  );
  await drain(run);
  const raw = await invokeRaw(run, wireChannel, args);
  await new Promise((resolve) => setTimeout(resolve, QUIET_MS));
  const records = await drain(run);

  const start = records.find((r) => r.k === "start" && r.channel === wireChannel);
  const end = start && records.find((r) => r.k === "end" && r.id === start.id);
  let outcome: Outcome;
  let nonFinite: string[] = [];
  if (end?.ok) {
    nonFinite = end.nonFinite ?? [];
    outcome = end.void ? { kind: "void" } : { kind: "value", result: end.result ?? null };
  } else if (end) {
    outcome = {
      kind: "error",
      name: end.name ?? "Error",
      message: end.message ?? "",
      invokeMessage: raw.message ?? "",
    };
  } else if (!raw.ok) {
    const message = (raw.message ?? "").replace(
      /^Error invoking remote method '[^']*': (\w+): /,
      "",
    );
    outcome = {
      kind: "error",
      name: raw.name ?? "Error",
      message,
      invokeMessage: raw.message ?? "",
    };
  } else {
    outcome = { kind: "void" };
  }

  const callId = start?.id ?? null;
  const events: EventRecord[] = [];
  const effects: EffectRecord[] = [];
  const sends: Recorded["sends"] = [];
  const placeholders: string[] = [];
  for (const record of records) {
    if (record.k === "card" && callId !== null && record.call === callId) {
      placeholders.push(...(record.placeholders ?? []));
    }
    if (record.k === "send") {
      sends.push({ record, callId: record.call ?? null });
      if (callId !== null && record.call === callId) {
        const event: EventRecord = { seq: events.length, event: record.channel! };
        if (record.hasPayload) event.payload = record.payload ?? null;
        events.push(event);
      }
    } else if (record.k === "effect" && callId !== null && record.call === callId) {
      effects.push({ seq: effects.length, api: record.api!, args: record.args ?? [] });
    }
  }

  const files: FileRecord[] = [];
  for (const file of testCase.files?.(vars, outcome) ?? []) {
    const record = readFileRecord(expandRun(file, run.runDir), run.runDir);
    if (record) files.push(record);
  }

  const golden: IpcGolden = {
    format: GOLDEN_FORMAT,
    channel: wireChannel,
    method: channel === null ? null : testCase.method,
    registered: channel !== null,
    case: testCase.id,
    description: testCase.description,
    group: testCase.group,
    seq,
    args: args.map((a) => (a === undefined ? null : (a as Json))),
    outcome,
    events,
    effects,
    files,
    nonFinite,
  };
  return { golden, sends, placeholders };
}

export const UNREGISTERED_CASE: IpcCase = {
  id: "unregistered",
  method: "(none)",
  description: "a channel no handler registered",
  group: READ_GROUP,
  args: () => ["probe"],
};

// --- A group: one launch ---

const CARD_ATTEMPTS = 5;

interface GroupResult {
  goldens: IpcGolden[];
  scenario: EventLine[];
  startup: EventLine[];
  runDir: string;
}

const sendLine = (record: SeamRecord, seq: number, cause: EventLine["cause"]): EventLine => {
  const line: EventLine = { seq, event: record.channel!, cause };
  if (record.hasPayload) line.payload = record.payload ?? null;
  return line;
};

async function runGroup(
  group: string,
  cases: IpcCase[],
  channels: Record<string, string>,
  data: string,
  repo: string,
): Promise<GroupResult> {
  const run = await launch(data, repo);
  try {
    const startupRecords = await untilFirstTick(run, channels.getLcuStatus!);
    const startup = startupRecords
      .filter((r) => r.k === "send")
      .map((r, i) => sendLine(r, i, "scenario"));
    const vars = await resolveVars(run);
    if (group === "export-card") await warmCardPatches(run, channels);
    const prior: Prior = {};
    const goldens: IpcGolden[] = [];
    const scenario: EventLine[] = [];
    let seq = 0;
    for (const testCase of cases) {
      const channel = testCase.method === "(none)" ? null : channels[testCase.method];
      if (channel === undefined) throw new Error(`no channel for ${testCase.method}`);
      let recorded = await runCase(run, testCase, channel, seq, vars, prior);
      for (let attempt = 1; recorded.placeholders.length && attempt < CARD_ATTEMPTS; attempt++) {
        console.log(`case ${testCase.id}: card drew ${recorded.placeholders.join(", ")}, again`);
        recorded = await runCase(run, testCase, channel, seq, vars, prior);
      }
      if (recorded.placeholders.length) {
        throw new Error(
          `case ${testCase.id}: card still draws ${recorded.placeholders.join(", ")}`,
        );
      }
      seq++;
      const { golden, sends } = recorded;
      goldens.push(golden);
      prior[testCase.id] = golden.outcome;
      for (const { record, callId } of sends) {
        scenario.push(
          sendLine(
            record,
            scenario.length,
            callId === null ? "scenario" : { channel: golden.channel, case: golden.case },
          ),
        );
      }
    }
    return { goldens, scenario, startup, runDir: run.runDir };
  } finally {
    await run.close();
  }
}

// --- The update scenario ---

const UPDATE_CHUNKS = 4;
const UPDATE_CHUNK_BYTES = 100;
const UPDATE_CHUNK_GAP_MS = 120;

/**
 * A stand-in for GitHub that offers one newer release whose digest the asset cannot match.
 * The app announces the install, reports progress while it downloads, then fails the integrity
 * check, which is the path that never reaches the code that swaps the app.
 */
function fakeGithub(): Promise<{ url: string; stop: () => void }> {
  const arch = process.arch;
  const assetName =
    process.platform === "darwin"
      ? `BetterMayhemTracker-mac-${arch}.zip`
      : "BetterMayhemTracker.exe";
  const base = "https://github.com/rambo0247/better-mayhem-tracker";
  const size = UPDATE_CHUNKS * UPDATE_CHUNK_BYTES;
  const server = http.createServer(async (request, response) => {
    const { pathname } = new URL(request.url ?? "/", "http://127.0.0.1");
    if (pathname.startsWith("/api.github.com/") && pathname.endsWith("/releases")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify([
          {
            tag_name: "v9.9.9",
            html_url: `${base}/releases/tag/v9.9.9`,
            published_at: "2026-11-01T00:00:00Z",
            body: "A release the recording offers.",
            draft: false,
            prerelease: false,
            assets: [
              {
                name: assetName,
                browser_download_url: `${base}/releases/download/v9.9.9/${assetName}`,
                size,
                digest: `sha256:${"0".repeat(64)}`,
              },
            ],
          },
        ]),
      );
    } else if (pathname.includes("/releases/download/")) {
      // One chunk per gap, so the app reads them one at a time and reports each
      response.writeHead(200, { "content-length": String(size) });
      for (let i = 0; i < UPDATE_CHUNKS; i++) {
        response.write(Buffer.alloc(UPDATE_CHUNK_BYTES, i));
        await new Promise((resolve) => setTimeout(resolve, UPDATE_CHUNK_GAP_MS));
      }
      response.end();
    } else {
      response.writeHead(404).end();
    }
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({
        url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        stop: () => server.close(),
      }),
    ),
  );
}

async function recordUpdateScenario(data: string, repo: string): Promise<EventLine[]> {
  const github = await fakeGithub();
  process.env.SEAM_GITHUB = github.url;
  if (process.platform === "win32") process.env.PORTABLE_EXECUTABLE_FILE = "C:\\seam\\fake.exe";
  let run: RunningElectron | null = null;
  try {
    run = await launch(data, repo);
    const lines: EventLine[] = [];
    const deadline = Date.now() + 40_000;
    while (Date.now() < deadline) {
      for (const record of await drain(run)) {
        if (record.k === "send" && record.channel!.startsWith("update:")) {
          lines.push(sendLine(record, lines.length, "scenario"));
        }
      }
      if (lines.some((l) => l.event === "update:install-failed")) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return lines;
  } finally {
    delete process.env.SEAM_GITHUB;
    delete process.env.PORTABLE_EXECUTABLE_FILE;
    await run?.close();
    github.stop();
  }
}

// --- The client scenarios ---

/** Each fake-client scenario, and the event that says the app has finished reacting to it. */
export const CLIENT_SCENARIOS: Record<string, { until: string; options?: Record<string, number> }> =
  {
    "end-of-game": { until: "lcu:games-updated" },
    "backfill-running": { until: "lcu:backfill-progress" },
    "backfill-done": { until: "lcu:backfill-done" },
    "in-game": { until: "live:changed" },
    "challenges-loaded": { until: "challenges:changed" },
  };

const CLIENT_SETTLE_MS = 1500;
const CLIENT_DEADLINE_MS = 90_000;

/**
 * Runs the app against T03's fake League client and records every event the main process
 * pushes, from launch to the scenario's last event.
 */
async function recordClientScenario(
  name: string,
  data: string,
  repo: string,
): Promise<{ lines: EventLine[]; runDir: string }> {
  const spec = CLIENT_SCENARIOS[name];
  if (!spec) throw new Error(`no client scenario ${name}`);
  const fakeDir = path.join(PARITY_DIR, "out", "runs", `fake-${name}-${process.pid}`);
  fs.rmSync(fakeDir, { recursive: true, force: true });
  fs.mkdirSync(fakeDir, { recursive: true });
  const run = await startElectron({ data, repo, seamEnv: { SEAM_FAKE_DIR: fakeDir } });
  const fake = await startFakeLcu({
    scenario: name,
    context: loadContext(resolveDataRoot(data), spec.options ?? {}, FIXED_TIME.getTime()),
    dir: fakeDir,
  });
  try {
    await run.page.goto("about:blank");
    const lines: EventLine[] = [];
    const take = async () => {
      for (const record of await drain(run)) {
        if (record.k === "send") lines.push(sendLine(record, lines.length, "scenario"));
      }
    };
    await Promise.race([
      fake.subscribed,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`${name}: the app never subscribed`)), 60_000),
      ),
    ]);
    fake.play();
    await fake.finished;
    const deadline = Date.now() + CLIENT_DEADLINE_MS;
    let quietSince = 0;
    while (Date.now() < deadline) {
      await take();
      if (lines.some((l) => l.event === spec.until)) {
        quietSince ||= Date.now();
        if (Date.now() - quietSince > CLIENT_SETTLE_MS) break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await take();
    if (!lines.some((l) => l.event === spec.until)) {
      throw new Error(`${name}: ${spec.until} never arrived`);
    }
    return { lines, runDir: run.runDir };
  } finally {
    await fake.stop();
    await run.close();
    fs.rmSync(fakeDir, { recursive: true, force: true });
  }
}

// --- Writing ---

export function writeJson(file: string, value: unknown, runDir: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, redact(JSON.stringify(value, null, 2), runDir) + "\n");
}

function writeJsonl(file: string, lines: EventLine[], runDir: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((l) => redact(JSON.stringify(l), runDir)).join("\n") + "\n");
}

/** T02's final fixture. Goldens recorded on any other `matches.db` would mislead every replay. */
export const FIXTURE_DB_SHA256 = "32f91f0a88b50ea3f53bc1970b9d7247443a1a389bfe5c0f73a4a35ee7641136";
/** The `--lang` run-electron passes, so dates and numbers format as in the goldens. */
export const LOCALE = "en-US";

/** The sha256 of the data source's `matches.db`. Refuses the fixture when it is not T02's final one. */
export function dataDbSha256(data: string): string {
  const sha = sha256File(path.join(resolveDataRoot(data), "data", "matches.db"));
  if (data === "fixture" && sha !== FIXTURE_DB_SHA256) {
    throw new Error(`fixture matches.db is ${sha}, not T02's final ${FIXTURE_DB_SHA256}`);
  }
  return sha;
}

function sha256File(file: string) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

// --- Timing ---

export interface TimingEntry {
  n: number;
  medianMs: number;
  p95Ms: number;
}
export type Timing = Record<string, Record<string, TimingEntry>>;

const quantile = (sorted: number[], q: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;

async function recordTiming(
  data: string,
  repo: string,
  channels: Record<string, string>,
  repeat: number,
): Promise<Timing> {
  const run = await launch(data, repo);
  try {
    await drain(run);
    const vars = await resolveVars(run);
    const reads = IPC_CASES.filter((c) => c.group === READ_GROUP && !c.untimed);
    const samples = new Map<IpcCase, number[]>(reads.map((c) => [c, []]));
    for (let rep = 0; rep < repeat; rep++) {
      for (const testCase of reads) {
        const channel = channels[testCase.method]!;
        const ms = await run.page.evaluate(
          ([c, a]) => (window as any).__bmtTimedInvoke(c, ...(a as unknown[])) as Promise<number>,
          [channel, testCase.args(vars, {})] as const,
        );
        samples.get(testCase)!.push(ms);
      }
      await drain(run);
    }
    const timing: Timing = {};
    for (const [testCase, values] of samples) {
      const sorted = [...values].sort((a, b) => a - b);
      (timing[channels[testCase.method]!] ??= {})[testCase.id] = {
        n: sorted.length,
        medianMs: Number(quantile(sorted, 0.5).toFixed(3)),
        p95Ms: Number(quantile(sorted, 0.95).toFixed(3)),
      };
    }
    return timing;
  } finally {
    await run.close();
  }
}

/** The median of a channel's case medians, which is what two timing runs are compared on. */
export function channelMedians(timing: Timing): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [channel, cases] of Object.entries(timing)) {
    const medians = Object.values(cases)
      .map((c) => c.medianMs)
      .sort((a, b) => a - b);
    out[channel] = medians[Math.floor(medians.length / 2)]!;
  }
  return out;
}

/** Channels whose medians differ by more than `tolerance` between two runs, beyond `floorMs` of jitter. */
export function timingDisagreements(a: Timing, b: Timing, tolerance = 0.2, floorMs = 0.25) {
  const ma = channelMedians(a);
  const mb = channelMedians(b);
  return Object.keys(ma).flatMap((channel) => {
    const x = ma[channel]!;
    const y = mb[channel] ?? NaN;
    const diff = Math.abs(x - y);
    return diff > floorMs && diff / Math.max(x, y) > tolerance ? [{ channel, a: x, b: y }] : [];
  });
}

// --- Main ---

if (import.meta.main) {
  const args = process.argv.slice(2);
  const value = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
  const data = value("--data") ?? "fixture";
  const repo = value("--repo") ?? REPO_DIR;
  const out = path.resolve(value("--out") ?? GOLDEN_DIR);
  const apiPath = path.resolve(value("--api") ?? API_PATH);
  const apiText = fs.readFileSync(apiPath, "utf8");

  if (args.includes("--check")) {
    const coverage = checkCoverage(out, apiText);
    console.log(coverageLine(coverage));
    for (const channel of coverage.channels.missing) console.log(`missing channel ${channel}`);
    for (const event of coverage.events.missing) console.log(`missing event ${event}`);
    process.exit(coverage.channels.missing.length + coverage.events.missing.length ? 1 : 0);
  }

  const dbSha256 = dataDbSha256(data);
  process.env.SEAM_IPC = "1";
  const channels = parseChannels(fs.readFileSync(API_PATH, "utf8"));

  if (args.includes("--timing")) {
    const repeat = Number(value("--repeat") ?? 50);
    const timing = await recordTiming(data, repo, channels, repeat);
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, "timing.json"), JSON.stringify(timing, null, 2) + "\n");
    const previous = value("--compare");
    if (previous) {
      const bad = timingDisagreements(JSON.parse(fs.readFileSync(previous, "utf8")), timing);
      for (const row of bad) console.log(`timing disagrees ${row.channel} ${row.a}ms ${row.b}ms`);
      console.log(bad.length ? "timing FAIL" : "timing stable");
      process.exit(bad.length ? 1 : 0);
    }
    console.log(`timing recorded for ${Object.keys(timing).length} channels, ${repeat} repeats`);
    process.exit(0);
  }

  const only = value("--group");
  const scenario = value("--scenario");
  const groups = scenario
    ? []
    : [...new Set(IPC_CASES.map((c) => c.group))].filter((g) => !only || g === only);
  if (!only && !scenario) {
    fs.rmSync(path.join(out, "ipc"), { recursive: true, force: true });
    fs.rmSync(path.join(out, "events"), { recursive: true, force: true });
    fs.rmSync(path.join(out, "states"), { recursive: true, force: true });
  }

  let appVersion = "";
  for (const group of groups) {
    const cases = IPC_CASES.filter((c) => c.group === group);
    const withUnregistered = group === READ_GROUP ? [...cases, UNREGISTERED_CASE] : cases;
    console.log(`group ${group}: ${withUnregistered.length} cases`);
    const result = await runGroup(group, withUnregistered, channels, data, repo);
    for (const golden of result.goldens) {
      writeJson(
        path.join(out, "ipc", channelDirName(golden.channel), `${golden.case}.json`),
        golden,
        result.runDir,
      );
    }
    // The client poller's own events land when its timer fires, which differs between runs, so a
    // group file keeps only what an invoke caused. The launch events are in startup.jsonl.
    const caused = result.scenario
      .filter((line) => line.cause !== "scenario")
      .map((line, seq) => ({ ...line, seq }));
    if (caused.length) {
      writeJsonl(path.join(out, "events", `${group}.jsonl`), caused, result.runDir);
    }
    if (group === READ_GROUP && result.startup.length) {
      writeJsonl(path.join(out, "events", "startup.jsonl"), result.startup, result.runDir);
    }
    appVersion = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")).version;
  }

  if ((!only && !scenario) || scenario === "update-install-failed") {
    console.log("scenario update-install-failed");
    const lines = await recordUpdateScenario(data, repo);
    if (lines.length) {
      writeJsonl(path.join(out, "events", "update-install-failed.jsonl"), lines, out);
    }
  }

  const clientNames = scenario
    ? [scenario].filter((n) => n in CLIENT_SCENARIOS)
    : only
      ? []
      : Object.keys(CLIENT_SCENARIOS);
  for (const name of clientNames) {
    console.log(`scenario ${name}`);
    const { lines, runDir } = await recordClientScenario(name, data, repo);
    writeJsonl(path.join(out, "events", `${name}.jsonl`), lines, runDir);
  }

  const coverage = checkCoverage(out, apiText);
  const manifest: GoldenManifest = {
    format: GOLDEN_FORMAT,
    appVersion,
    platform: process.platform,
    fixedTime: FIXED_TIME.toISOString(),
    timeZone: TIME_ZONE,
    locale: LOCALE,
    data,
    dbSha256,
    channels: coverage.channels.covered.sort(),
    events: coverage.events.covered.sort(),
  };
  fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(coverageLine(coverage));
  for (const channel of coverage.channels.missing) console.log(`missing channel ${channel}`);
  for (const event of coverage.events.missing) console.log(`missing event ${event}`);
  process.exit(coverage.channels.missing.length + coverage.events.missing.length ? 1 : 0);
}
