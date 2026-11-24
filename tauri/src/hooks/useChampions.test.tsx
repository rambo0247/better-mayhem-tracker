import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { fake } from "../../test/fakeApi";
import { mount, settle } from "../../test/render";

type Hooks = typeof import("./useChampions");

// Other files leave their answers in the shared module's caches, so each test
// loads its own copy of the hooks
let copies = 0;
const freshHooks = (): Promise<Hooks> => {
  const path = `./useChampions.ts?copy=${++copies}`;
  return import(path) as Promise<Hooks>;
};

let views: ReturnType<typeof mount>[] = [];
beforeEach(() => fake.reset());
afterEach(() => {
  for (const view of views) view.dispose();
  views = [];
});

function pending(method: string) {
  let answer!: (value: object) => void;
  fake.returns.set(method, new Promise((resolve) => (answer = resolve)));
  return (value: object) => answer(value);
}

const requests = (method: string) => fake.calls.filter((c) => c.method === method).length;

for (const [hook, method] of [
  ["useSummonerSpellData", "getSummonerSpellData"],
  ["useChampionData", "getChampionData"],
] as const) {
  describe(hook, () => {
    test("components mounted before the first answer share one request", async () => {
      const use = (await freshHooks())[hook];
      const answer = pending(method);
      const Names = () => {
        const data = use();
        return <span>{Object.keys(data()).join(",")}</span>;
      };

      views.push(
        mount(() => (
          <>
            <Names />
            <Names />
            <Names />
          </>
        )),
      );
      views.push(mount(() => <Names />));
      await settle();
      expect(requests(method)).toBe(1);

      answer({ 4: { name: "Flash" } });
      await settle();
      expect(views.map((v) => v.container.textContent)).toEqual(["444", "4"]);

      views.push(mount(() => <Names />));
      await settle();
      expect(requests(method)).toBe(1);
      expect(views[2]!.container.textContent).toBe("4");
    });

    test("an empty answer is not kept, so a later component asks again", async () => {
      const use = (await freshHooks())[hook];
      const answer = pending(method);
      const Probe = () => {
        use();
        return null;
      };

      views.push(mount(() => <Probe />));
      views.push(mount(() => <Probe />));
      await settle();
      answer({});
      await settle();
      expect(requests(method)).toBe(1);

      views.push(mount(() => <Probe />));
      await settle();
      expect(requests(method)).toBe(2);
    });
  });
}
