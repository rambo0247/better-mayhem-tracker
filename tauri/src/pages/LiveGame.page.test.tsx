import { afterEach, expect, test } from "bun:test";
import { fake } from "../../test/fakeApi";
import { FAKE_API } from "../../test/parity-cases";
import { mount, settle } from "../../test/render";
import LiveGame from "./LiveGame";

let view: ReturnType<typeof mount> | undefined;
afterEach(() => {
  view?.dispose();
  fake.reset();
});

test("with no recorded game the header carries no actions box, as React's has none", async () => {
  fake.returns.set("getChampionData", FAKE_API.getChampionData);
  fake.returns.set("getAugmentData", FAKE_API.getAugmentData);
  fake.returns.set("getAllSummonerPuuids", []);
  fake.returns.set("getLcuStatus", "disconnected");
  fake.returns.set("getGameRecap", null);
  fake.returns.set("getLiveGame", {
    inGame: false,
    starting: false,
    gameId: null,
    queueId: null,
    mapId: null,
    mapName: null,
    mapSkin: null,
    gameTime: 0,
    players: [],
    events: [],
  });
  view = mount(() => <LiveGame />);
  await settle();
  const header = view.container.querySelector("h1")!.parentElement!.parentElement!;
  expect(view.container.textContent).toContain("League client offline");
  expect(header.children.length).toBe(1);
});
