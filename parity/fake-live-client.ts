import type { FakePki } from "./fake-lcu/ca.ts";
import type { LiveMode } from "./fake-lcu/types.ts";

export interface LiveClientSource {
  mode(): LiveMode;
  data(): unknown;
}

export interface FakeLiveClient {
  port: number;
  stop(): void;
}

const GAME_UNAVAILABLE = {
  httpStatus: 404,
  errorCode: "RESOURCE_NOT_FOUND",
  message: "Resource not found",
};

/**
 * The in-game API the running match serves on port 2999: no auth, a self-signed certificate
 * the app does not verify. It listens on a port of its own, and the seam points the app's
 * port 2999 requests at it, so a real game on 2999 is never asked.
 */
export function startFakeLiveClient(
  pki: FakePki,
  source: LiveClientSource,
  record: (method: string, path: string, status: number) => void = () => {},
): FakeLiveClient {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: { key: pki.leafKeyPem, cert: pki.leafPem },
    fetch(request) {
      const path = new URL(request.url).pathname;
      const answer = (status: number, body: unknown) => {
        record(request.method, path, status);
        return Response.json(body, { status });
      };
      if (source.mode() !== "on")
        return answer(source.mode() === "off" ? 503 : 404, GAME_UNAVAILABLE);
      const data = source.data() as any;
      if (path === "/liveclientdata/allgamedata") return answer(200, data);
      if (path === "/liveclientdata/gamestats") return answer(200, data.gameData);
      if (path === "/liveclientdata/activeplayername") {
        return answer(200, data.activePlayer.summonerName);
      }
      return answer(404, GAME_UNAVAILABLE);
    },
  });
  return { port: server.port!, stop: () => void server.stop(true) };
}

if (import.meta.main) {
  console.error("fake-live-client.ts is started by fake-lcu.ts, which owns its scenario.");
  process.exit(2);
}
