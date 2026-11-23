import { afterEach, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { generatePki } from "../fake-lcu/ca.ts";
import { syntheticContext } from "../fake-lcu/context.ts";
import { buildScenario, SCENARIOS } from "../fake-lcu/scenarios/index.ts";
import { startFakeLcu, type FakeLcu } from "../fake-lcu.ts";

const SCALE = 0.02;
const running: FakeLcu[] = [];
const folders: string[] = [];

afterEach(async () => {
  for (const fake of running.splice(0)) await fake.stop();
  for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
});

async function start(name: string, options: Record<string, string | number | boolean> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bmt-fake-lcu-"));
  folders.push(dir);
  const fake = await startFakeLcu({
    scenario: name,
    context: syntheticContext(options),
    dir,
    timeScale: SCALE,
    autoplay: true,
  });
  running.push(fake);
  return fake;
}

function get(fake: FakeLcu, urlPath: string, auth = true): Promise<{ status: number; body: any }> {
  const password = fs.readFileSync(path.join(fake.lockfileDir, "lockfile"), "utf8").split(":")[3]!;
  return new Promise((resolve, reject) => {
    https
      .get(
        {
          host: "127.0.0.1",
          port: fake.port,
          path: urlPath,
          ca: fake.caPem,
          headers: auth
            ? { Authorization: "Basic " + Buffer.from(`riot:${password}`).toString("base64") }
            : {},
        },
        (response) => {
          let text = "";
          response.on("data", (chunk) => (text += chunk));
          response.on("end", () => {
            let body: unknown = text;
            try {
              body = JSON.parse(text);
            } catch {
              // an empty or plain-text body stays as it is
            }
            resolve({ status: response.statusCode!, body });
          });
        },
      )
      .on("error", reject);
  });
}

function subscribe(fake: FakeLcu): Promise<{ at: number; frame: any }[]> {
  const password = fs.readFileSync(path.join(fake.lockfileDir, "lockfile"), "utf8").split(":")[3]!;
  const received: { at: number; frame: any }[] = [];
  const socket = new WebSocket(`wss://127.0.0.1:${fake.port}`, {
    headers: { Authorization: "Basic " + Buffer.from(`riot:${password}`).toString("base64") },
    tls: { ca: fake.caPem },
  } as never);
  const opened = Date.now();
  socket.onopen = () => socket.send(JSON.stringify([5, "OnJsonApiEvent"]));
  socket.onmessage = (event) => {
    if (event.data === "") return;
    received.push({ at: Date.now() - opened, frame: JSON.parse(String(event.data)) });
  };
  return fake.finished.then(async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    socket.close();
    return received;
  });
}

describe("the fake CA", () => {
  test("a leaf for 127.0.0.1 chains to a CA that is not Riot's", () => {
    const pki = generatePki();
    const ca = new crypto.X509Certificate(pki.caPem);
    const leaf = new crypto.X509Certificate(pki.leafPem);
    expect(ca.ca).toBe(true);
    expect(leaf.ca).toBe(false);
    expect(leaf.verify(ca.publicKey)).toBe(true);
    expect(leaf.checkIP("127.0.0.1")).toBe("127.0.0.1");
    expect(leaf.subjectAltName).toContain("DNS:localhost");
    expect(ca.subject).not.toContain("Riot Games");
  });

  test("two runs make different keys", () => {
    expect(generatePki().caPem).not.toBe(generatePki().caPem);
  });
});

describe("the fake client", () => {
  test("answers only with the client's own password", async () => {
    const fake = await start("connected-idle");
    expect((await get(fake, "/lol-gameflow/v1/gameflow-phase", false)).status).toBe(401);
    const answer = await get(fake, "/lol-gameflow/v1/gameflow-phase");
    expect(answer).toEqual({ status: 200, body: "None" });
  });

  test("is not trusted without its own CA", async () => {
    const fake = await start("connected-idle");
    const outcome = await new Promise<string>((resolve) => {
      https
        .get({ host: "127.0.0.1", port: fake.port, path: "/" }, () => resolve("answered"))
        .on("error", (error) => resolve((error as NodeJS.ErrnoException).code ?? error.message));
    });
    expect(outcome).not.toBe("answered");
  });

  test("writes a lockfile in the client's format and removes it on stop", async () => {
    const fake = await start("connected-idle");
    const lockfile = path.join(fake.lockfileDir, "lockfile");
    const match = fs.readFileSync(lockfile, "utf8").match(/^[^:]+:(\d+):(\d+):(.+):https?$/);
    expect(Number(match![2])).toBe(fake.port);
    await fake.stop();
    expect(fs.existsSync(lockfile)).toBe(false);
  });

  test("lists the summoner and serves a known game by id", async () => {
    const fake = await start("connected-idle");
    const summoner = await get(fake, "/lol-summoner/v1/current-summoner");
    expect(summoner.body.puuid).toBe(syntheticContext().summoner.puuid);
    const known = syntheticContext().known[0]!.gameId;
    expect((await get(fake, `/lol-match-history/v1/games/${known}`)).body.gameId).toBe(known);
    expect((await get(fake, "/lol-match-history/v1/games/1")).status).toBe(404);
  });

  test("answers 404 for the first misses of a late game, then the game", async () => {
    const fake = await start("results-late");
    const gameId = fake.scenario.games[0]!.id;
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      statuses.push((await get(fake, `/lol-match-history/v1/games/${gameId}`)).status);
    }
    expect(statuses).toEqual([404, 404, 404, 200, 200]);
  });

  test("serves a challenge token as a PNG", async () => {
    const fake = await start("challenges-loaded");
    const tree = await get(fake, "/lol-challenges/v1/challenges/local-player");
    expect(Object.keys(tree.body)).toContain("101000");
    const token = await get(
      fake,
      "/lol-game-data/assets/assets/challenges/config/101101/tokens/gold.png",
    );
    expect(token.status).toBe(200);
  });
});

describe("scenario timelines", () => {
  for (const name of Object.keys(SCENARIOS)) {
    test(`${name} sends its frames in order at their recorded delays`, async () => {
      const fake = await start(name);
      const expected = buildScenario(name, syntheticContext())
        .timeline.slice()
        .sort((a, b) => a.at - b.at)
        .flatMap((step) => (step.frames ?? []).map((frame) => ({ at: step.at, frame })));
      const received = await subscribe(fake);

      expect(received.map((r) => r.frame)).toEqual(
        expected.map((e) => [8, "OnJsonApiEvent", e.frame]),
      );
      const timeline = fake.sent.map((s) => s.at);
      expect(timeline).toEqual([...timeline].sort((a, b) => a - b));
      fake.sent.forEach((sent, i) => {
        const due = expected[i]!.at * SCALE;
        expect(sent.at).toBeGreaterThanOrEqual(due - 5);
        // Lanes run at background priority beside a game, where a timer fires up to ~120 ms late.
        expect(sent.at).toBeLessThan(due + 1000);
      });
    });
  }
});
