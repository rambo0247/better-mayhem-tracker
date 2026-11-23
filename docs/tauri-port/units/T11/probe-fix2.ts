// Fix round 2's answers from trunk Electron's own main process (Node 24, V8 15.2):
// Number() and parseInt() of radix literals from 2^53 to past 2^1024, zlib.gunzipSync
// on gzip framings, JSON.stringify key order, and what getSetting hands the page for a
// value that is not text. The data root's settings table must take any value type
// (`prepare` below rebuilds it that way) and its augment_slots must be a blob.
//   bun probe-fix2.ts <worktree> <data root> <run dir> <out dir> [seed]
import fs from "node:fs";
import path from "node:path";

const [repo, data, runDir, out, seedArg] = process.argv.slice(2);
fs.mkdirSync(out!, { recursive: true });
const { startElectron } = await import(path.join(repo!, "parity", "run-electron.ts"));
const run = await startElectron({ data: data!, runDir: runDir!, repo: repo! });
try {
  const seed = Number(seedArg ?? 20261123);
  const main = await run.app.evaluate(
    (_electron, { out, seed }) => {
      const req = (process as any).mainModule.require;
      const fs = req("fs");
      const zlib = req("zlib");
      let s = seed >>> 0;
      const rnd = () => {
        s = (s + 0x6d2b79f5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return (t ^ (t >>> 14)) >>> 0;
      };
      const pick = <T,>(a: T[]): T => a[rnd() % a.length]!;
      const dv = new DataView(new ArrayBuffer(8));
      const bits = (x: number) => {
        if (Number.isNaN(x)) return "nan";
        dv.setFloat64(0, x);
        return dv.getBigUint64(0).toString(16);
      };

      // A value of `width` bits whose low bits past the 53rd sit at, just below or
      // just above the rounding midpoint as often as at random
      const valueBits = (width: number) => {
        const tail = width - 53;
        const shape = rnd() % 6;
        let b = "1";
        for (let i = 1; i < 53; i++) b += rnd() % 2;
        if (tail <= 0) return b.slice(0, width);
        if (shape === 0) b += "1" + "0".repeat(tail - 1);
        else if (shape === 1) b += "0" + "1".repeat(tail - 1);
        else if (shape === 2) b += "1" + "0".repeat(Math.max(0, tail - 2)) + (tail > 1 ? "1" : "");
        else if (shape === 3) b += "1".repeat(tail);
        else for (let i = 0; i < tail; i++) b += rnd() % 2;
        return b;
      };
      const RADIX: [string[], number][] = [
        [["0x", "0X"], 4],
        [["0o", "0O"], 3],
        [["0b", "0B"], 1],
      ];
      const digitsOf = (b: string, log2: number, upper: boolean) => {
        const pad = (log2 - (b.length % log2)) % log2;
        const padded = "0".repeat(pad) + b;
        let d = "";
        for (let i = 0; i < padded.length; i += log2) {
          const c = parseInt(padded.slice(i, i + log2), 2).toString(1 << log2);
          d += upper && rnd() % 2 ? c.toUpperCase() : c;
        }
        return d;
      };
      const literals = new Set<string>();
      while (literals.size < 30000) {
        const [prefixes, log2] = pick(RADIX);
        const width =
          rnd() % 10 === 0 ? 1018 + (rnd() % 16) : 54 + (rnd() % (1024 - 54 + 16));
        const zeros = rnd() % 8 === 0 ? "0".repeat(1 + (rnd() % 6)) : "";
        literals.add(pick(prefixes) + zeros + digitsOf(valueBits(width), log2, true));
      }
      const max = "1".repeat(53);
      for (const b of [
        "1" + "0".repeat(53),
        max + "0".repeat(971),
        max + "0".repeat(970) + "1",
        max + "1" + "0".repeat(970),
        max + "0" + "1".repeat(970),
        max + "1".repeat(971),
        "1" + "0".repeat(1024),
      ])
        for (const [prefixes, log2] of RADIX) literals.add(prefixes[0] + digitsOf(b, log2, false));
      literals.add("0x11a257fAC6fCDe80169eA9C7db46Ed77f400419e0");
      literals.add("0o316505013466432226411246113651225023013230346");
      const toNumber = [...literals].map((t) => [t, bits(Number(t))]);
      fs.writeFileSync(`${out}/to-number.json`, JSON.stringify(toNumber));

      const hex = [...literals].filter((t) => /^0x/i.test(t));
      const parseInts = new Set<string>();
      for (const t of hex) {
        const k = rnd() % 4;
        if (k === 0) parseInts.add(t);
        else if (k === 1) parseInts.add(pick(["-", "+", " ", "\t-", " "]) + t);
        else if (k === 2) parseInts.add(t + pick(["g", ".5", " 1", "z9", "_1"]));
        else parseInts.add(t.slice(0, 2) + "0".repeat(rnd() % 4) + t.slice(2));
      }
      for (let i = 0; i < 2000; i++) {
        let d = String(1 + (rnd() % 9));
        for (let n = rnd() % 330; n > 0; n--) d += rnd() % 10;
        parseInts.add(pick(["", "-", "+", " ", "0000"]) + d + pick(["", "e5", ".9", "x"]));
      }
      for (const t of ["0XAcAB4CAfab4AD45E6905b82dcff4", "0x", "-0x", "0x g", "0xg", "0x0", "-0", "-0x0", "", "  ", "0X1F", "+0x10"]) parseInts.add(t);
      const parseInt_ = [...parseInts].map((t) => [t, bits(parseInt(t))]);
      fs.writeFileSync(`${out}/parse-int.json`, JSON.stringify(parseInt_));

      const gz = (b: Buffer) => zlib.gzipSync(b);
      const texts = ['{"n":"a"}', '{"gameId":7,"b":[1.5,"x"]}', "[]", '"x"'];
      const frames: { frame: string; blob: string; want: string }[] = [];
      const push = (frame: string, blob: Buffer) => {
        let want: string;
        try {
          want = JSON.stringify(JSON.parse(zlib.gunzipSync(blob).toString("utf8")));
        } catch {
          want = "null";
        }
        frames.push({ frame, blob: blob.toString("hex"), want });
      };
      for (let i = 0; i < 600; i++) {
        const raw = Buffer.from(pick(texts));
        const other = Buffer.from(pick(texts));
        const z = (n: number) => Buffer.alloc(n);
        const cut = (b: Buffer) => b.subarray(0, -(1 + (rnd() % 12)));
        const n = 1 + (rnd() % 16);
        push("single", gz(raw));
        push("trailing-zeros", Buffer.concat([gz(raw), z(n)]));
        push("zero-then-garbage", Buffer.concat([gz(raw), z(1), Buffer.from("garbage")]));
        push("zero-then-member", Buffer.concat([gz(raw), z(n), gz(other)]));
        push("two-members", Buffer.concat([gz(raw.subarray(0, 3)), gz(raw.subarray(3))]));
        push("two-members-zeros", Buffer.concat([gz(raw.subarray(0, 2)), gz(raw.subarray(2)), z(n)]));
        push("trailing-garbage", Buffer.concat([gz(raw), Buffer.from(pick(["garbage", "\x01", "x\0\0"]))]));
        push("trailing-magic", Buffer.concat([gz(raw), Buffer.from([0x1f, 0x8b])]));
        push("trailing-1f", Buffer.concat([gz(raw), Buffer.from([0x1f])]));
        push("truncated", cut(gz(raw)));
        push("truncated-second", Buffer.concat([gz(raw), cut(gz(other))]));
        push("zeros-then-truncated", Buffer.concat([gz(raw), z(n), cut(gz(other))]));
        const crc = Buffer.from(gz(raw));
        crc[crc.length - 6] ^= 1 << rnd() % 8;
        push("bad-crc", crc);
        const size = Buffer.from(gz(raw));
        size[size.length - 2] ^= 1;
        push("bad-isize", size);
        push("leading-zero", Buffer.concat([z(1), gz(raw)]));
        push("empty-member-zeros", Buffer.concat([gz(Buffer.alloc(0)), z(n)]));
      }
      for (const b of [Buffer.alloc(0), Buffer.alloc(4), Buffer.from("not gzip"), gz(Buffer.alloc(0))]) push("special", b);
      fs.writeFileSync(`${out}/frames.json`, JSON.stringify(frames));

      const stringifyTexts = [
        '{"b":1,"10":"ten","2":"two","0":"zero","4294967294":"max","01":"lead"}',
        '{"a":{"b":1,"10":"ten","2":"two","0":"zero","4294967294":"max","01":"lead"},"9":[{"z":0,"3":1,"1":2}]}',
        '{"b":1,"2":2,"0":0}',
        '{"x":{"y":{"z":{"5":5,"k":1,"4294967295":2,"4":4}}}}',
      ];
      const stringify = stringifyTexts.map((text) => [text, JSON.stringify(JSON.parse(text))]);
      fs.writeFileSync(`${out}/stringify.json`, JSON.stringify(stringify));
      return {
        toNumber: toNumber.length,
        parseInt: parseInt_.length,
        frames: frames.length,
        node: process.versions.node,
        v8: process.versions.v8,
        electron: process.versions.electron,
      };
    },
    { out: out!, seed },
  );

  // A second connection to the database Electron has open writes each value, and the
  // page reads it back through settings:get, or through a query hidden_queues filters
  const db = path.join(run.runDir, "data", "matches.db");
  const write = (key: string, sql: string) =>
    run.app.evaluate(
      (_electron, { db, key, sql }) => {
        const base = (process as any).mainModule.require;
        const req = base("module").createRequire(base("path").join(process.cwd(), "out", "main", "index.js"));
        const Database = req("better-sqlite3");
        const conn = new Database(db);
        try {
          conn.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ${sql})`).run(key);
          return conn.prepare("SELECT typeof(value) AS t, quote(value) AS q FROM settings WHERE key = ?").get(key);
        } finally {
          conn.close();
        }
      },
      { db, key, sql },
    );
  const VALUES: [string, string][] = [
    ["blob", "x'74727565'"],
    ["empty-blob", "x''"],
    ["integer", "42"],
    ["zero", "0"],
    ["big-integer", "9007199254740993"],
    ["real", "1.5"],
    ["text", "'true'"],
    ["text-number", "'42'"],
  ];
  const settings = [];
  for (const [name, sql] of VALUES) {
    const stored = await write("remember_filters", sql);
    const answer = await run.page.evaluate(async () => {
      const v: unknown = await window.api.getSetting("remember_filters");
      return {
        type: typeof v,
        constructor: v === null ? null : (v as object).constructor?.name,
        value: v instanceof Uint8Array ? Array.from(v) : v,
      };
    });
    settings.push({ name, sql, stored, answer });
  }
  const hiddenQueues = [];
  for (const [name, sql] of VALUES) {
    const stored = await write("hidden_queues", sql);
    const answer = await run.page.evaluate(async () => {
      try {
        const page = await window.api.getMatchHistory(5, 0);
        return { total: page.total };
      } catch (e) {
        return { threw: (e as Error).message };
      }
    });
    hiddenQueues.push({ name, sql, stored, answer });
  }
  await write("hidden_queues", "''");
  const augmentSlots = await run.app.evaluate(
    (_electron, { db }) => {
      const base = (process as any).mainModule.require;
      const req = base("module").createRequire(base("path").join(process.cwd(), "out", "main", "index.js"));
      const Database = req("better-sqlite3");
      const conn = new Database(db, { readonly: true });
      try {
        return {
          games: conn.prepare("SELECT COUNT(*) AS n FROM games").get().n,
          augmentSlots: conn.prepare("SELECT typeof(value) AS t, quote(value) AS q FROM settings WHERE key = 'augment_slots'").get(),
          gameAugments: conn.prepare("SELECT COUNT(*) AS n FROM game_augments").get().n,
        };
      } finally {
        conn.close();
      }
    },
    { db },
  );
  const report = await run.page.evaluate(() => window.api.getRecoveryReport());
  const result = { main, settings, hiddenQueues, augmentSlots, recoveryReport: report };
  fs.writeFileSync(path.join(out!, "electron.json"), JSON.stringify(result, null, 1) + "\n");
  console.log("electron fix2", JSON.stringify(main), JSON.stringify(augmentSlots));
} finally {
  await run.close();
}
