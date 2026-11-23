// Records the errors better-sqlite3 13.0.3 throws in trunk Electron's main
// process: SQLite failures, and its transaction wrapper's edge cases.
//   bun probe-errors.ts <worktree> <data root> <run dir> <out.json>
import fs from "node:fs";
import path from "node:path";

const [repo, data, runDir, out] = process.argv.slice(2);
const { startElectron } = await import(path.join(repo!, "parity", "run-electron.ts"));
const run = await startElectron({ data: data!, runDir: runDir!, repo: repo! });
try {
  const result = await run.app.evaluate(() => {
    const base = (process as any).mainModule.require;
    const req = base("module").createRequire(
      base("path").join(process.cwd(), "out", "main", "index.js"),
    );
    const Database = req("better-sqlite3");
    const p = req("path");
    const fs = req("fs");
    const scratch = p.join(process.cwd(), "probe-errors");
    fs.mkdirSync(scratch, { recursive: true });
    const attempt = (f: () => unknown) => {
      try {
        return { kind: "ok", value: f() ?? null };
      } catch (e: any) {
        return {
          kind: "error",
          name: e.constructor.name,
          code: e.code ?? null,
          message: e.message,
        };
      }
    };
    const mem = () => {
      const db = new Database(":memory:");
      db.exec("CREATE TABLE t (a INTEGER PRIMARY KEY, b TEXT NOT NULL, c INTEGER UNIQUE)");
      db.exec("INSERT INTO t VALUES (1, 'x', 1)");
      return db;
    };
    const cases: Record<string, unknown> = {};
    cases.cantopen_missing_dir = attempt(
      () => new Database(p.join(scratch, "no-such-dir", "matches.db")),
    );
    cases.cantopen_directory = attempt(() => new Database(scratch).prepare("SELECT 1").get());
    cases.no_such_table = attempt(() => mem().prepare("SELECT * FROM nowhere").all());
    cases.syntax = attempt(() => mem().prepare("SELEC 1").all());
    cases.unique = attempt(() => mem().prepare("INSERT INTO t VALUES (2, 'y', 1)").run());
    cases.primary_key = attempt(() => mem().prepare("INSERT INTO t VALUES (1, 'y', 2)").run());
    cases.not_null = attempt(() => mem().prepare("INSERT INTO t (a, c) VALUES (3, 3)").run());
    cases.mismatch = attempt(() => mem().prepare("INSERT INTO t VALUES (1.5, 'y', 4)").run());
    cases.exec_no_such_table = attempt(() => mem().exec("SELECT * FROM nowhere"));
    cases.busy = attempt(() => {
      const file = p.join(scratch, "busy.db");
      const a = new Database(file, { timeout: 0 });
      a.exec("CREATE TABLE IF NOT EXISTS x (v)");
      const b = new Database(file, { timeout: 0 });
      a.exec("BEGIN IMMEDIATE");
      try {
        return b.prepare("INSERT INTO x VALUES (1)").run();
      } finally {
        a.exec("ROLLBACK");
      }
    });
    cases.not_a_database = attempt(() => {
      const file = p.join(scratch, "garbage.db");
      fs.writeFileSync(file, Buffer.alloc(4096, 7));
      return new Database(file).prepare("SELECT * FROM sqlite_master").all();
    });
    cases.closed = attempt(() => {
      const db = mem();
      db.close();
      return db.prepare("SELECT 1").get();
    });
    // The transaction wrapper
    cases.tx_inner_commits_outer = attempt(() => {
      const db = mem();
      return db.transaction(() => db.transaction(() => db.exec("COMMIT"))())();
    });
    cases.tx_rolls_back_itself = attempt(() => {
      const db = mem();
      return db.transaction(() => db.exec("ROLLBACK"))();
    });
    cases.tx_inner_rolls_back_outer = attempt(() => {
      const db = mem();
      return db.transaction(() => db.transaction(() => db.exec("ROLLBACK"))())();
    });
    cases.tx_inner_throw_keeps_outer = attempt(() => {
      const db = mem();
      db.transaction(() => {
        db.prepare("INSERT INTO t VALUES (10, 'outer', 10)").run();
        try {
          db.transaction(() => {
            db.prepare("INSERT INTO t VALUES (11, 'inner', 11)").run();
            throw new Error("inner");
          })();
        } catch {}
      })();
      return db
        .prepare("SELECT a FROM t ORDER BY a")
        .all()
        .map((r: any) => r.a);
    });
    cases.tx_savepoint_sql = attempt(() => {
      const db = mem();
      const seen: string[] = [];
      const t = new Database(":memory:", { verbose: (s: string) => seen.push(s) });
      t.transaction(() => t.transaction(() => 1)())();
      db.close();
      return seen;
    });
    return { cases };
  });
  fs.writeFileSync(out!, JSON.stringify(result, null, 1));
  console.log("wrote", out);
} finally {
  await run.close();
}
