import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GOLDEN_FORMAT, type IpcGolden, type Json, type Outcome } from "../golden-format.ts";
import { CaseBook, STATE_SEQ, recordState, type Call } from "../record-states.ts";
import type { StateRow } from "../states.ts";

const CHANNEL = "db:match-filters";
let dir: string;

const golden = (id: string, seq: number, args: Json[], result: Json): IpcGolden => ({
  format: GOLDEN_FORMAT,
  channel: CHANNEL,
  method: "getMatchFilterOptions",
  registered: true,
  case: id,
  description: id,
  group: "read",
  seq,
  args,
  outcome: { kind: "value", result },
  events: [],
  effects: [],
  files: [],
  nonFinite: [],
});

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bmt-states-"));
  const folder = path.join(dir, "ipc", "db.match-filters");
  fs.mkdirSync(folder, { recursive: true });
  const write = (g: IpcGolden) =>
    fs.writeFileSync(path.join(folder, `${g.case}.json`), JSON.stringify(g));
  write(golden("default", 3, [], { seasons: ["a"], queues: [2400] }));
  write(golden("queues-hidden", 9, [], { seasons: [], queues: [] }));
});

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const state = { id: "s", group: "default", route: "/", viewport: { width: 1, height: 1 } };
const call = (result: Json): Call => ({
  channel: CHANNEL,
  args: [],
  outcome: { kind: "value", result } as Outcome,
  nonFinite: [],
});

test("two cases share arguments, and a call is matched to the one with its outcome", () => {
  const book = new CaseBook(dir);
  const index = recordState(
    state as StateRow,
    [call({ seasons: [], queues: [] }), call({ queues: [2400], seasons: ["a"] })],
    book,
    new Map([[CHANNEL, "getMatchFilterOptions"]]),
    dir,
    dir,
  );
  expect(index.calls.map((c) => c.case)).toEqual(["queues-hidden", "default"]);
});

test("an outcome no case holds becomes a state case that replay by arguments never prefers", () => {
  const book = new CaseBook(dir);
  const index = recordState(
    state as StateRow,
    [call({ seasons: ["z"], queues: [] })],
    book,
    new Map([[CHANNEL, "getMatchFilterOptions"]]),
    dir,
    dir,
  );
  const id = index.calls[0]!.case;
  expect(id).toMatch(/^state-[0-9a-f]{10}$/);
  const written = JSON.parse(
    fs.readFileSync(path.join(dir, "ipc", "db.match-filters", `${id}.json`), "utf8"),
  ) as IpcGolden;
  expect(written.seq).toBe(STATE_SEQ);
  expect(STATE_SEQ).toBeGreaterThan(9);
});
