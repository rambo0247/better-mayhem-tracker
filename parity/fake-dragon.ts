import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { refuseRealFolder } from "./lib/real-folder.ts";

/**
 * A loopback stand-in for Data Dragon and CommunityDragon. A Tauri parity build with
 * BMT_PARITY_WEB=<base> fetches every `https://<host>/<path>` as `<base>/<host>/<path>`, so a
 * lane can run with the network "open" while nothing leaves 127.0.0.1.
 *
 * It answers from a data root's `asset-cache/` and `data/champion-cache.json`, the files
 * Electron wrote from the real hosts, in the shapes those hosts serve them.
 */

export const DDRAGON = "ddragon.leagueoflegends.com";
export const CDRAGON = "raw.communitydragon.org";
export const CDRAGON_CDN = "cdn.communitydragon.org";
export type Host = typeof DDRAGON | typeof CDRAGON | typeof CDRAGON_CDN;

/** `ok` answers; `503` answers every request with a 503, which the app counts as an outage. */
export type HostMode = "ok" | "503";

export interface FakeRequest {
  at: number;
  host: string;
  path: string;
  status: number;
  userAgent: string | null;
}

export interface FakeDragon {
  base: string;
  requests: FakeRequest[];
  setMode(host: Host, mode: HostMode): void;
  stop(): void;
}

const GAME_DATA = "/plugins/rcp-be-lol-game-data/global/default/";
const isPatch = (name: string) => /^[0-9]+\.[0-9]+$/.test(name);
const byNewest = (a: string, b: string) => {
  const [aMajor, aMinor] = a.split(".").map(Number);
  const [bMajor, bMinor] = b.split(".").map(Number);
  return bMajor! - aMajor! || bMinor! - aMinor!;
};

/** Where Electron filed a game path (game-assets.ts `cacheFile`). */
export function cacheName(gamePath: string): string {
  return crypto.createHash("sha1").update(gamePath).digest("hex") + path.extname(gamePath);
}

function contentType(file: string): string {
  const ext = path.extname(file);
  if (ext === ".json") return "application/json";
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  return "image/jpeg";
}

export function startFakeDragon(options: { source: string; port?: number }): FakeDragon {
  const source = path.resolve(options.source);
  refuseRealFolder(source, "fake Data Dragon source");
  const cache = path.join(source, "asset-cache");
  const patches = fs.readdirSync(cache).filter(isPatch).sort(byNewest);
  const latest = patches[0];
  if (!latest) throw new Error(`${cache} holds no patch folder`);
  const champions = JSON.parse(
    fs.readFileSync(path.join(source, "data", "champion-cache.json"), "utf8"),
  ) as {
    version: string;
    champions: Record<string, { name: string; key: string; class?: string }>;
  };
  const modes = new Map<string, HostMode>();
  const requests: FakeRequest[] = [];

  const file = (branch: string, gamePath: string) => {
    const patch = branch === "latest" ? latest : isPatch(branch) ? branch : null;
    const copy = patch && path.join(cache, patch, cacheName(gamePath));
    return copy && fs.existsSync(copy) ? copy : null;
  };

  // champion.json, rebuilt from the cache Electron wrote from it
  const championJson = () => ({
    type: "champion",
    format: "standAloneComplex",
    version: champions.version,
    data: Object.fromEntries(
      Object.entries(champions.champions).map(([id, c]) => [
        c.key,
        {
          version: champions.version,
          id: c.key,
          key: id,
          name: c.name,
          tags: c.class ? [c.class] : [],
        },
      ]),
    ),
  });

  const route = (host: string, rest: string): Response | string | null => {
    if (host === DDRAGON) {
      if (rest === "api/versions.json") return Response.json([champions.version]);
      if (rest === `cdn/${champions.version}/data/en_US/champion.json`) {
        return Response.json(championJson());
      }
      return null;
    }
    if (host === CDRAGON) {
      if (rest === "latest/content-metadata.json") {
        return Response.json({ version: `${latest}.1.0` });
      }
      if (rest === "json/") {
        return Response.json(
          [...patches, "latest", "pbe"].map((name) => ({ name, type: "directory" })),
        );
      }
      const slash = rest.indexOf("/");
      const branch = rest.slice(0, slash);
      const tail = rest.slice(slash);
      if (tail.startsWith(GAME_DATA)) return file(branch, tail.slice(GAME_DATA.length));
      if (tail.startsWith("/game/")) return file(branch, tail.slice("/game/".length));
      return null;
    }
    if (host === CDRAGON_CDN) {
      const splash = rest.match(/^latest\/champion\/([0-9]+)\/splash-art\/centered$/);
      return splash ? file("latest", `splash/${splash[1]}.jpg`) : null;
    }
    return null;
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? 0,
    fetch(request) {
      const url = new URL(request.url);
      const [, host = "", ...parts] = url.pathname.split("/");
      const rest = parts.join("/");
      const answer = (): Response => {
        if (modes.get(host) === "503") return new Response("", { status: 503 });
        const found = route(host, rest);
        if (found === null) return new Response("", { status: 404 });
        if (typeof found !== "string") return found;
        return new Response(fs.readFileSync(found), {
          headers: { "Content-Type": contentType(found) },
        });
      };
      const response = answer();
      requests.push({
        at: Date.now(),
        host,
        path: rest,
        status: response.status,
        userAgent: request.headers.get("user-agent"),
      });
      return response;
    },
  });

  return {
    base: `http://127.0.0.1:${server.port}`,
    requests,
    setMode: (host, mode) => modes.set(host, mode),
    stop: () => server.stop(true),
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const value = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
  const source = value("--source");
  if (!source) {
    console.error(
      "usage: bun parity/fake-dragon.ts --source <data root copy> [--port N] [--down ddragon|cdragon]",
    );
    process.exit(2);
  }
  const fake = startFakeDragon({ source, port: Number(value("--port") ?? 0) });
  const down = value("--down");
  if (down === "ddragon") fake.setMode(DDRAGON, "503");
  if (down === "cdragon") fake.setMode(CDRAGON, "503");
  console.log(`BMT_PARITY_WEB=${fake.base}`);
}
