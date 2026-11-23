// Asks trunk Electron's own better-sqlite3, in its main process, how it builds
// SQLite and how it binds and reads strings. Uses a :memory: database only.
//   bun probe-sqlite.ts <worktree> <data root> <run dir> <out.json>
import fs from "node:fs";
import path from "node:path";

const [repo, data, runDir, out] = process.argv.slice(2);
const { startElectron } = await import(path.join(repo!, "parity", "run-electron.ts"));
const run = await startElectron({ data: data!, runDir: runDir!, repo: repo! });
try {
  const result = await run.app.evaluate(() => {
    const base = (process as any).mainModule.require;
    const req = base("module").createRequire(base("path").join(process.cwd(), "out", "main", "index.js"));
    const Database = req("better-sqlite3");
    const zlib = req("zlib");
    const db = new Database(":memory:");
    const attempt = (f: () => unknown) => {
      try {
        return { ok: f() };
      } catch (e: any) {
        return { name: e?.constructor?.name, code: e?.code, message: e?.message };
      }
    };
    const texts = [
      '"A\\ud83d"', '"\\udc00NA"', '"\\ud83d\\ud83d"', '"B\\ud83d\\nC"', '"\\ud83d\\u0041"',
      '"\\uD83D\\uDE00 ok"', '"\\ud83d\\ud83d\\ude00"', '"\\ude00\\ud83d"', '"x\\udbff\\udfff\\udc00"',
    ];
    db.exec("CREATE TABLE t (s TEXT)");
    const strings = texts.map((t) => {
      const s = JSON.parse(t);
      db.prepare("DELETE FROM t").run();
      db.prepare("INSERT INTO t VALUES (?)").run(s);
      const named = db.prepare("SELECT hex(@s) AS h").get({ s }).h;
      return {
        json: t,
        units: [...Array(s.length).keys()].map((i) => s.charCodeAt(i).toString(16)),
        boundHex: db.prepare("SELECT hex(?) AS h").get(s).h,
        namedHex: named,
        storedHex: db.prepare("SELECT hex(s) AS h FROM t").get().h,
        readBackUnits: [...db.prepare("SELECT s FROM t").get().s].map((c: string) => c.codePointAt(0)!.toString(16)),
        stringify: JSON.stringify(s),
        bufferHex: Buffer.from(s, "utf8").toString("hex"),
        gzipTextHex: zlib.gunzipSync(zlib.gzipSync(s)).toString("hex"),
      };
    });
    const badBytes = ["43eda0bd44", "45f09f9846", "c080", "f4908080", "e282", "80", "edbfbf", "f08f8080"];
    const decoded = badBytes.map((hex) => {
      const s = Buffer.from(hex, "hex").toString("utf8");
      const fromSqlite = db.prepare(`SELECT CAST(x'${hex}' AS TEXT) AS s`).get().s as string;
      const units = (x: string) => [...Array(x.length).keys()].map((i) => x.charCodeAt(i).toString(16));
      return { hex, buffer: units(s), sqlite: units(fromSqlite) };
    });
    return {
      versions: { sqlite: db.prepare("SELECT sqlite_version() AS v").get().v, node: process.versions.node, electron: process.versions.electron, v8: process.versions.v8 },
      compileOptions: db.prepare("PRAGMA compile_options").all().map((r: any) => r.compile_options),
      dqsSelect: attempt(() => db.prepare('SELECT "abc"').get()),
      dqsInsert: attempt(() => db.prepare('INSERT INTO t VALUES ("abc")').run()),
      dqsCreateIndex: attempt(() => db.exec('CREATE INDEX i ON t("nosuch")')),
      likeBlob: db.prepare("SELECT x'616263' LIKE 'abc' AS v").get().v,
      math: attempt(() => db.prepare("SELECT sqrt(16) AS a, pi() AS b, log10(1000) AS c").get()),
      median: attempt(() => db.prepare("SELECT median(v) AS m, percentile(v, 25) AS p FROM (SELECT 1 v UNION ALL SELECT 3 UNION ALL SELECT 10)").get()),
      deleteLimit: attempt(() => db.prepare("DELETE FROM t LIMIT 1").run().changes),
      geopoly: attempt(() => db.prepare("SELECT geopoly_area('[[0,0],[1,0],[1,1],[0,0]]') AS a").get()),
      tclVariable: attempt(() => db.prepare("SELECT $abc AS v").get({ abc: 5 })),
      defensive: attempt(() => db.exec("PRAGMA writable_schema = ON; UPDATE sqlite_master SET sql = sql")),
      cacheSize: db.pragma("cache_size", { simple: true }),
      walSync: (() => { const f = new Database(req("path").join(process.cwd(), "probe-wal.db")); f.pragma("journal_mode = WAL"); const v = f.pragma("synchronous", { simple: true }); f.close(); return v; })(),
      strings,
      decoded,
    };
  });
  fs.writeFileSync(out!, JSON.stringify(result, null, 1));
  console.log("wrote", out);
} finally {
  await run.close();
}
