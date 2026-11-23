import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import { generatePki, type FakePki } from "./fake-lcu/ca.ts";
import { loadContext, syntheticContext } from "./fake-lcu/context.ts";
import { buildScenario, SCENARIOS } from "./fake-lcu/scenarios/index.ts";
import type { ClientState, Frame, Scenario, ScenarioContext, Step } from "./fake-lcu/types.ts";
import { startFakeLiveClient, type FakeLiveClient } from "./fake-live-client.ts";
import { PARITY_DIR, resolveDataRoot } from "./lib/data.ts";
import { refuseRealFolder } from "./lib/real-folder.ts";

export interface FakeLcuOptions {
  scenario: string;
  context: ScenarioContext;
  /** Where the lockfile folder, the CA, and the discovery file go. Never the real data folder. */
  dir: string;
  /** Scales every step's delay. Tests use a small value, capture uses 1. */
  timeScale?: number;
  /** Start the timeline at the first subscribe. Capture starts it by hand. */
  autoplay?: boolean;
}

export interface RequestRecord {
  t: number;
  server: "lcu" | "sgp" | "live";
  method: string;
  path: string;
  /** Null until the response is sent, and for good when the fake never answers. */
  status: number | null;
  /** Set at stop for a request that never got its answer. */
  hung?: true;
}

export interface SentFrame {
  label: string;
  /** Milliseconds from play() to the frame reaching the socket. */
  at: number;
  frame: Frame;
}

export interface FakeLcu {
  dir: string;
  lockfileDir: string;
  port: number;
  livePort: number;
  sgpUrl: string;
  caPem: string;
  scenario: Scenario;
  requests: RequestRecord[];
  sent: SentFrame[];
  /** Resolves when a client has sent the subscribe frame. */
  subscribed: Promise<void>;
  /** Resolves after the last timeline step has run. */
  finished: Promise<void>;
  play(): void;
  /** Lets a gated match-history service answer. */
  releaseSgp(): void;
  stop(): Promise<void>;
}

const PASSWORD_BYTES = 12;
const SUBSCRIBE = "OnJsonApiEvent";

const NOT_FOUND = { errorCode: "RPC_ERROR", httpStatus: 404, message: "Not found" };
const TOKEN_COLORS: Record<string, [number, number, number]> = {
  IRON: [110, 100, 96],
  BRONZE: [160, 98, 52],
  SILVER: [170, 178, 186],
  GOLD: [214, 170, 60],
  PLATINUM: [70, 168, 160],
  DIAMOND: [96, 126, 224],
  MASTER: [166, 90, 210],
  GRANDMASTER: [200, 70, 80],
  CHALLENGER: [90, 200, 240],
};

/** A round token in the level's color, standing in for art the client would serve. */
function tokenPng(level: string): Buffer {
  const [r, g, b] = TOKEN_COLORS[level.toUpperCase()] ?? TOKEN_COLORS.IRON!;
  const size = 96;
  const png = new PNG({ width: size, height: size });
  const middle = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const distance = Math.hypot(x - middle, y - middle);
      const at = (y * size + x) * 4;
      const ring = distance > 38 && distance <= 46;
      const inside = distance <= 38;
      png.data[at] = ring ? 245 : r;
      png.data[at + 1] = ring ? 235 : g;
      png.data[at + 2] = ring ? 200 : b;
      png.data[at + 3] = inside || ring ? 255 : 0;
    }
  }
  return PNG.sync.write(png);
}

const never = () => new Promise<Response>(() => {});

export async function startFakeLcu(options: FakeLcuOptions): Promise<FakeLcu> {
  const { context, dir } = options;
  refuseRealFolder(dir, "fake client folder");
  const scale = options.timeScale ?? 1;
  const scenario = buildScenario(options.scenario, context);
  const pki: FakePki = generatePki();
  const password = crypto.randomBytes(PASSWORD_BYTES).toString("hex");
  const basic = "Basic " + Buffer.from(`riot:${password}`).toString("base64");
  const started = Date.now();

  fs.mkdirSync(dir, { recursive: true });
  const lockfileDir = path.join(dir, "league");
  fs.mkdirSync(lockfileDir, { recursive: true });

  const requests: RequestRecord[] = [];
  /** Logs a request as it arrives. The returned function sets its status once it is answered. */
  const record =
    (server: RequestRecord["server"]) =>
    (method: string, p: string, status: number | null = null) => {
      const entry: RequestRecord = { t: Date.now() - started, server, method, path: p, status };
      requests.push(entry);
      return (answered: number) => void (entry.status = answered);
    };
  const recordLcu = record("lcu");

  let state: ClientState = { ...scenario.state };
  const hits = new Map<number, number>();
  const subscribers = new Set<{ send(data: string): unknown }>();
  const sent: SentFrame[] = [];
  const timers: ReturnType<typeof setTimeout>[] = [];
  let playedAt = 0;
  let playing = false;

  let markSubscribed!: () => void;
  const subscribed = new Promise<void>((resolve) => (markSubscribed = resolve));
  let markFinished!: () => void;
  const finished = new Promise<void>((resolve) => (markFinished = resolve));

  const publish = (label: string, frame: Frame) => {
    const text = JSON.stringify([8, SUBSCRIBE, frame]);
    for (const socket of subscribers) socket.send(text);
    sent.push({ label, at: Date.now() - playedAt, frame });
  };

  const run = (step: Step) => {
    state = { ...state, ...step.state };
    for (const frame of step.frames ?? []) publish(step.label, frame);
  };

  function play() {
    if (playing) return;
    playing = true;
    playedAt = Date.now();
    const steps = [...scenario.timeline].sort((a, b) => a.at - b.at);
    if (steps.length === 0) markFinished();
    steps.forEach((step, i) => {
      timers.push(
        setTimeout(() => {
          run(step);
          if (i === steps.length - 1) markFinished();
        }, step.at * scale),
      );
    });
  }

  const detailOf = (gameId: number) =>
    scenario.games.find((g) => g.id === gameId)?.payload ?? context.gameDetail(gameId);

  const lcuBody = async (pathname: string, search: URLSearchParams): Promise<Response> => {
    const json = (body: unknown, status = 200) => Response.json(body, { status });
    const missing = () => json(NOT_FOUND, 404);
    const summoner = context.summoner;
    let match: RegExpMatchArray | null;

    if (pathname === "/lol-summoner/v1/current-summoner") {
      return json({
        accountId: summoner.accountId,
        displayName: summoner.gameName,
        gameName: summoner.gameName,
        internalName: summoner.gameName,
        tagLine: summoner.tagLine,
        puuid: summoner.puuid,
        summonerId: summoner.summonerId,
        profileIconId: summoner.profileIconId,
        summonerLevel: 412,
        unnamed: false,
      });
    }
    if (pathname === "/lol-gameflow/v1/gameflow-phase") return json(state.phase);
    if (pathname === "/lol-gameflow/v1/session") {
      return state.session ? json(state.session) : missing();
    }
    if (pathname === "/lol-rso-auth/v1/authorization/access-token") {
      return json({ token: "parity-fake-token", expiry: 4_102_444_800 });
    }
    if (pathname === "/lol-league-session/v1/league-session-token") return json("parity-fake");
    if (pathname === "/riotclient/region-locale") {
      return json({ region: "NA", locale: "en_US", webLanguage: "en", webRegion: "NA" });
    }
    if (pathname === "/data-store/v1/install-dir") return json("/parity/fake/League of Legends");
    if (pathname === "/lol-patch/v1/game-version") return json(context.patch);

    if (/^\/lol-match-history\/v1\/products\/lol\/[^/]+\/matches$/.test(pathname)) {
      const end = Number(search.get("endIndex") ?? 19);
      const games = context.known
        .slice(0, Math.min(end + 1, 20))
        .map((g) => ({ ...g, gameMode: "KIWI", gameType: "MATCHED_GAME" }));
      return json({ games: { gameIndexBegin: 0, gameIndexEnd: games.length, games } });
    }
    if ((match = pathname.match(/^\/lol-match-history\/v1\/games\/(\d+)$/))) {
      const gameId = Number(match[1]);
      const index = scenario.sgp.ids.indexOf(gameId);
      // The app reads the oldest id's date to see where Riot's history starts, before it imports
      // anything, so that one answers or the import never reaches its first progress report.
      const probed = index === scenario.sgp.ids.length - 1;
      if (scenario.hangDetailsFrom !== undefined && index >= scenario.hangDetailsFrom && !probed) {
        return never();
      }
      const count = hits.get(gameId) ?? 0;
      hits.set(gameId, count + 1);
      if (count < (scenario.misses?.[gameId] ?? 0)) return missing();
      const payload = detailOf(gameId);
      return payload ? json(payload) : missing();
    }

    if (pathname === "/lol-challenges/v1/challenges/local-player") {
      return scenario.challenges ? json(scenario.challenges.all) : missing();
    }
    if (pathname === "/lol-challenges/v1/summary-player-data/local-player") {
      return scenario.challenges ? json(scenario.challenges.summary) : missing();
    }
    if (pathname.startsWith("/lol-challenges/v1/my-updated-challenges/")) return missing();

    if (
      (match = pathname.match(
        /^\/lol-game-data\/assets\/assets\/challenges\/config\/\d+\/tokens\/([a-z]+)\.png$/i,
      ))
    ) {
      return new Response(new Uint8Array(tokenPng(match[1]!)), {
        headers: { "Content-Type": "image/png" },
      });
    }
    return missing();
  };

  const server = Bun.serve<undefined>({
    hostname: "127.0.0.1",
    port: 0,
    tls: { key: pki.leafKeyPem, cert: pki.leafPem },
    async fetch(request, self) {
      const url = new URL(request.url);
      const answered = recordLcu(request.method, url.pathname);
      if (request.headers.get("authorization") !== basic) {
        answered(401);
        return new Response("Unauthorized", { status: 401 });
      }
      if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        if (self.upgrade(request)) return undefined as unknown as Response;
        return new Response("upgrade failed", { status: 400 });
      }
      if (request.method !== "GET") {
        answered(405);
        return new Response("Method Not Allowed", { status: 405 });
      }
      const response = await lcuBody(url.pathname, url.searchParams);
      answered(response.status);
      return response;
    },
    websocket: {
      message(socket, message) {
        let frame: unknown;
        try {
          frame = JSON.parse(String(message));
        } catch {
          return;
        }
        if (!Array.isArray(frame) || frame[0] !== 5 || frame[1] !== SUBSCRIBE) return;
        subscribers.add(socket);
        recordLcu("WS", `subscribe ${SUBSCRIBE}`, 101);
        socket.send("");
        markSubscribed();
        if (options.autoplay) play();
      },
      close(socket) {
        subscribers.delete(socket);
      },
    },
  });

  let releaseSgp: () => void = () => {};
  const sgpGate = new Promise<void>((resolve) => (releaseSgp = resolve));
  const recordSgp = record("sgp");
  const sgp = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const answered = recordSgp(request.method, url.pathname + url.search);
      const reply = (status: number, body: unknown) => {
        answered(status);
        return Response.json(body, { status });
      };
      if (!request.headers.get("authorization")?.startsWith("Bearer ")) return reply(401, {});
      if (!/^\/match-history-query\/v1\/products\/lol\/player\/[^/]+$/.test(url.pathname)) {
        return reply(404, {});
      }
      if (scenario.sgp.gated) await sgpGate;
      if (scenario.sgp.stall) return never();
      if (scenario.sgp.status) return reply(scenario.sgp.status, { message: "parity fake" });
      const start = Number(url.searchParams.get("startIndex") ?? 0);
      const count = Number(url.searchParams.get("count") ?? 20);
      return reply(
        200,
        scenario.sgp.ids.slice(start, start + count).map((id) => `NA1_${id}`),
      );
    },
  });

  const live: FakeLiveClient = startFakeLiveClient(
    pki,
    { mode: () => state.live, data: () => scenario.liveData },
    record("live"),
  );

  const port = server.port!;
  const info = {
    scenario: scenario.name,
    lockfileDir,
    caPem: pki.caPem,
    livePort: live.port,
    sgpUrl: `http://127.0.0.1:${sgp.port}`,
    ports: [port, live.port, sgp.port],
  };
  fs.writeFileSync(path.join(dir, "ca.pem"), pki.caPem);
  // The discovery file lands before the lockfile, so nothing finds the client half set up
  fs.writeFileSync(path.join(dir, "fake.json"), JSON.stringify(info, null, 1));
  const lockfile = path.join(lockfileDir, "lockfile");
  fs.writeFileSync(lockfile, `LeagueClient:${process.pid}:${port}:${password}:https`);

  return {
    dir,
    lockfileDir,
    port,
    livePort: live.port,
    sgpUrl: info.sgpUrl,
    caPem: pki.caPem,
    scenario,
    requests,
    sent,
    subscribed,
    finished,
    play,
    releaseSgp,
    async stop() {
      for (const timer of timers) clearTimeout(timer);
      fs.rmSync(lockfile, { force: true });
      for (const entry of requests) if (entry.status === null) entry.hung = true;
      fs.writeFileSync(path.join(dir, "requests.json"), JSON.stringify(requests, null, 1));
      live.stop();
      await sgp.stop(true);
      await server.stop(true);
      fs.rmSync(path.join(dir, "ca.pem"), { force: true });
    },
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const value = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
  const name = value("--scenario");
  if (!name || !(name in SCENARIOS)) {
    const sample = syntheticContext();
    const listing = Object.keys(SCENARIOS)
      .map((key) => `  ${key}: ${buildScenario(key, sample).description}`)
      .join("\n");
    console.error(
      `usage: bun parity/fake-lcu.ts --scenario <name> [--data <fixture|snapshot|folder>] [--out <folder>] [--set key=value ...]\nscenarios:\n${listing}`,
    );
    process.exit(2);
  }
  const options: Record<string, string> = {};
  args.forEach((arg, i) => {
    if (arg !== "--set") return;
    const [key, ...rest] = args[i + 1]!.split("=");
    options[key!] = rest.join("=");
  });
  const { FIXED_TIME } = await import("./run-electron.ts");
  const dataRoot = resolveDataRoot(value("--data") ?? "fixture");
  const context = loadContext(dataRoot, options, FIXED_TIME.getTime());
  const dir = path.resolve(
    value("--out") ?? path.join(PARITY_DIR, "out", "fake-lcu", `${name}-${Date.now()}`),
  );
  const fake = await startFakeLcu({ scenario: name, context, dir, autoplay: true });
  console.log(
    `ready dir=${dir} port=${fake.port} live=${fake.livePort} sgp=${fake.sgpUrl} scenario=${name}`,
  );
  void fake.finished.then(() => console.log("timeline finished"));
  const shutdown = async () => {
    await fake.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
