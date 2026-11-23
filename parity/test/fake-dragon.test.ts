import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CDRAGON, DDRAGON, cacheName, startFakeDragon } from "../fake-dragon.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 2]);

const root = fs.mkdtempSync(path.join(os.tmpdir(), "bmt-fake-dragon-"));
const put = (patch: string, gamePath: string, bytes: Buffer | string) => {
  fs.mkdirSync(path.join(root, "asset-cache", patch), { recursive: true });
  fs.writeFileSync(path.join(root, "asset-cache", patch, cacheName(gamePath)), bytes);
};
put("16.22", "v1/champion-icons/1.png", PNG);
put("16.23", "v1/champion-icons/1.png", PNG);
put("16.23", "assets/items/icons2d/1001.png", PNG);
put("16.23", "splash/266.jpg", JPEG);
put("16.23", "v1/items.json", '[{"id":1001}]');
fs.mkdirSync(path.join(root, "data"));
fs.writeFileSync(
  path.join(root, "data", "champion-cache.json"),
  JSON.stringify({
    version: "16.23.1",
    champions: {
      "1": { name: "Annie", key: "Annie", class: "Mage" },
      "2": { name: "Olaf", key: "Olaf" },
    },
  }),
);

const fake = startFakeDragon({ source: root });
afterAll(() => {
  fake.stop();
  fs.rmSync(root, { recursive: true, force: true });
});
const get = (url: string) => fetch(`${fake.base}/${url.replace(/^https:\/\//, "")}`);

describe("fake Data Dragon and CommunityDragon", () => {
  test("listens on loopback only", () => {
    expect(fake.base).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  test("Data Dragon serves the versions and champion.json the cache was built from", async () => {
    expect(await (await get(`https://${DDRAGON}/api/versions.json`)).json()).toEqual(["16.23.1"]);
    const champions = (await (
      await get(`https://${DDRAGON}/cdn/16.23.1/data/en_US/champion.json`)
    ).json()) as any;
    expect(champions.data.Annie).toEqual({
      version: "16.23.1",
      id: "Annie",
      key: "1",
      name: "Annie",
      tags: ["Mage"],
    });
    expect(champions.data.Olaf.tags).toEqual([]);
  });

  test("CommunityDragon serves files where Electron's cache filed them", async () => {
    const meta = (await (await get(`https://${CDRAGON}/latest/content-metadata.json`)).json()) as {
      version: string;
    };
    expect(meta.version).toBe("16.23.1.0");
    const data = `https://${CDRAGON}/16.23/plugins/rcp-be-lol-game-data/global/default`;
    const icon = await get(`${data}/v1/champion-icons/1.png`);
    expect(icon.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await icon.arrayBuffer())).toEqual(PNG);
    expect((await get(`https://${CDRAGON}/latest/game/assets/items/icons2d/1001.png`)).status).toBe(
      200,
    );
    expect(await (await get(`${data}/v1/items.json`)).json()).toEqual([{ id: 1001 }]);
    const splash = await get(
      "https://cdn.communitydragon.org/latest/champion/266/splash-art/centered",
    );
    expect(Buffer.from(await splash.arrayBuffer())).toEqual(JPEG);
    const branches = (await (await get(`https://${CDRAGON}/json/`)).json()) as { name: string }[];
    expect(branches.map((b) => b.name)).toEqual(["16.23", "16.22", "latest", "pbe"]);
  });

  test("a file no patch holds, pbe, and unknown hosts are 404", async () => {
    expect((await get(`https://${CDRAGON}/16.22/game/assets/items/icons2d/1001.png`)).status).toBe(
      404,
    );
    expect((await get(`https://${CDRAGON}/pbe/game/assets/items/icons2d/1001.png`)).status).toBe(
      404,
    );
    expect((await get("https://example.com/x.png")).status).toBe(404);
  });

  test("a host set to 503 answers 503, and every request is logged", async () => {
    fake.setMode(DDRAGON, "503");
    expect((await get(`https://${DDRAGON}/api/versions.json`)).status).toBe(503);
    fake.setMode(DDRAGON, "ok");
    expect((await get(`https://${DDRAGON}/api/versions.json`)).status).toBe(200);
    const last = fake.requests.slice(-2);
    expect(last.map((r) => [r.host, r.path, r.status])).toEqual([
      [DDRAGON, "api/versions.json", 503],
      [DDRAGON, "api/versions.json", 200],
    ]);
  });
});
