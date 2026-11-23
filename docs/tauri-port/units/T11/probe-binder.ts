// Runs better-sqlite3 13.0.3's binder in trunk Electron's main process over a
// :memory: database, one case per argument shape, and records each outcome.
//   bun probe-binder.ts <worktree> <data root> <run dir> <out.json>
import fs from "node:fs";
import path from "node:path";

const GAMES = `CREATE TABLE games (
      game_id       INTEGER PRIMARY KEY,
      queue_id      INTEGER NOT NULL,
      game_mode     TEXT NOT NULL,
      game_creation INTEGER NOT NULL,
      game_duration INTEGER NOT NULL,
      is_remake     INTEGER NOT NULL DEFAULT 0,
      puuid         TEXT NOT NULL DEFAULT '',
      game_version  TEXT,
      favorite      INTEGER NOT NULL DEFAULT 0,
      raw_gz        BLOB
    )`;
const SQL: Record<string, string> = {
  ingest: "INSERT OR IGNORE INTO games (game_id, queue_id, game_mode, game_creation, game_duration, is_remake, puuid, game_version, raw_gz) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  anon: "INSERT INTO r VALUES (?, ?)",
  named: "INSERT INTO r VALUES (@a, @b)",
  mixed: "INSERT INTO r VALUES (?, @a)",
  namedFirst: "INSERT INTO r VALUES (:a, ?)",
};
const base = ["5", "2400", "'KIWI'", "1790000000000", "1500", "0", "'p'", "'16.23'", "Buffer.from('x')"];
const ingest = (id: string, at: Record<number, string>, extra?: { drop?: number; add?: string[] }) => {
  let args = base.map((a, i) => at[i + 1] ?? a);
  if (extra?.drop) args = args.slice(0, args.length - extra.drop);
  if (extra?.add) args = [...args, ...extra.add];
  return { id, stmt: "ingest", args: args.join(", ") };
};
const CASES = [
  ingest("ingest_ok", {}),
  ingest("object_empty", { 1: "{}" }),
  ingest("object_with_keys", { 1: "{ a: 1 }" }),
  ingest("object_last", { 9: "{}" }),
  ingest("two_objects", { 1: "{}", 3: "{}" }),
  ingest("object_then_boolean", { 1: "{}", 3: "true" }),
  ingest("boolean_then_object", { 1: "true", 3: "{}" }),
  ingest("array_of_one", { 1: "[5]" }),
  ingest("array_of_two", { 1: "[5, 6]" }),
  ingest("array_empty", { 1: "[]" }),
  ingest("array_nested", { 1: "[[5]]" }),
  ingest("array_holding_object", { 1: "[{}]" }),
  ingest("array_holding_boolean", { 1: "[true]" }),
  ingest("array_holding_null", { 1: "[null]" }),
  ingest("boolean_true", { 1: "true" }),
  ingest("boolean_false", { 2: "false" }),
  ingest("undefined_nullable", { 8: "undefined" }),
  ingest("undefined_not_null", { 2: "undefined" }),
  ingest("null_id", { 1: "null" }),
  ingest("fractional_id", { 1: "1.5" }),
  ingest("string_id", { 1: "'77'" }),
  ingest("date", { 1: "new Date(0)" }),
  ingest("buffer", { 9: "Buffer.from([1, 2])" }),
  ingest("uint8array", { 9: "new Uint8Array([1, 2])" }),
  ingest("arraybuffer", { 9: "new ArrayBuffer(2)" }),
  ingest("string_object", { 3: "new String('x')" }),
  ingest("bigint", { 1: "5n" }),
  ingest("bigint_creation", { 4: "1790000000000n" }),
  ingest("bigint_too_big", { 1: "2n ** 70n" }),
  ingest("nan_not_null", { 4: "NaN" }),
  ingest("nan_nullable", { 8: "NaN" }),
  ingest("infinity", { 4: "Infinity", 5: "-Infinity" }),
  ingest("negative_zero", { 4: "-0" }),
  ingest("too_many", {}, { add: ["1"] }),
  ingest("too_few", {}, { drop: 1 }),
  { id: "no_arguments", stmt: "ingest", args: "" },
  { id: "anon_numbers", stmt: "anon", args: "5, 5.5" },
  { id: "anon_bigint", stmt: "anon", args: "5n, -1n" },
  { id: "anon_nan_infinity", stmt: "anon", args: "NaN, Infinity" },
  { id: "anon_negative_zero", stmt: "anon", args: "-0, 1e300" },
  { id: "anon_blobs", stmt: "anon", args: "Buffer.from([0, 255]), new Uint8Array([7])" },
  { id: "anon_strings", stmt: "anon", args: "'', 'é😀'" },
  { id: "named_ok", stmt: "named", args: "{ a: 1, b: 'x' }" },
  { id: "named_missing", stmt: "named", args: "{ a: 1 }" },
  { id: "named_extra_keys", stmt: "named", args: "{ a: 1, b: 2, c: 3 }" },
  { id: "named_undefined_value", stmt: "named", args: "{ a: undefined, b: 2 }" },
  { id: "named_none", stmt: "named", args: "" },
  { id: "named_positional", stmt: "named", args: "1, 2" },
  { id: "named_date", stmt: "named", args: "new Date(0)" },
  { id: "named_two_objects", stmt: "named", args: "{ a: 1 }, { b: 2 }" },
  { id: "named_object_value", stmt: "named", args: "{ a: {}, b: 1 }" },
  { id: "named_array_value", stmt: "named", args: "{ a: [1], b: 1 }" },
  { id: "named_boolean_value", stmt: "named", args: "{ a: true, b: 1 }" },
  { id: "named_in_array", stmt: "named", args: "[{ a: 1, b: 2 }]" },
  { id: "named_null_prototype", stmt: "named", args: "Object.assign(Object.create(null), { a: 1, b: 2 })" },
  { id: "mixed_ok", stmt: "mixed", args: "1, { a: 2 }" },
  { id: "mixed_object_first", stmt: "mixed", args: "{ a: 2 }, 1" },
  { id: "mixed_only_object", stmt: "mixed", args: "{ a: 2 }" },
  { id: "mixed_only_positional", stmt: "mixed", args: "1" },
  { id: "mixed_array", stmt: "mixed", args: "[1], { a: 2 }" },
  { id: "named_first_ok", stmt: "namedFirst", args: "{ a: 1 }, 2" },
  { id: "named_first_positional", stmt: "namedFirst", args: "2, { a: 1 }" },
];

const [repo, data, runDir, out] = process.argv.slice(2);
const { startElectron } = await import(path.join(repo!, "parity", "run-electron.ts"));
const run = await startElectron({ data: data!, runDir: runDir!, repo: repo! });
try {
  const result = await run.app.evaluate(
    (_electron, { cases, sql, games }) => {
      const base = (process as any).mainModule.require;
      const req = base("module").createRequire(base("path").join(process.cwd(), "out", "main", "index.js"));
      const Database = req("better-sqlite3");
      const read = (db: any, table: string) => {
        const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c: any) => c.name);
        const parts = cols.map((c: string) => `typeof(${c}), quote(${c})`).join(", ");
        return db.prepare(`SELECT ${parts} FROM ${table} ORDER BY rowid`).raw().all();
      };
      return cases.map((c: any) => {
        const db = new Database(":memory:");
        db.exec(games);
        db.exec("CREATE TABLE r (a, b)");
        const args = new Function(`return [${c.args}]`)();
        try {
          const info = db.prepare(sql[c.stmt]).run(...args);
          const table = c.stmt === "ingest" ? "games" : "r";
          return { ...c, outcome: { kind: "ok", changes: info.changes, rows: read(db, table) } };
        } catch (e: any) {
          return { ...c, outcome: { kind: "error", name: e.constructor.name, message: e.message, code: e.code ?? null } };
        } finally {
          db.close();
        }
      });
    },
    { cases: CASES, sql: SQL, games: GAMES },
  );
  fs.writeFileSync(out!, JSON.stringify({ sql: SQL, games: GAMES, cases: result }, null, 1));
  console.log("wrote", out, result.length, "cases");
} finally {
  await run.close();
}
