"""Compares two matches.db files read-only: user_version, sqlite_master text, and
every table's rows. raw_gz compares as the gunzipped text, since Electron's zlib
and Rust's zlib-rs write different deflate streams for the same text.

--ignore-scores leaves out the columns and settings Electron's score backfill
writes at startup, which T12 ports and T11 does not.

Usage: python3 -I compare-dbs.py <a.db> <b.db> [--ignore-scores]
"""

import gzip
import os
import sqlite3
import sys

SCORE_COLUMNS = {"score", "score_raw", "score_badge"}
STARTUP_SETTINGS = {"score_formula_version", "last_run_version"}


def connect(path):
    # A WAL file opened read-only needs its -shm, which a clean close removes.
    # With no -wal beside it, the file is the whole database and reads as immutable.
    mode = "mode=ro" if os.path.exists(path + "-wal") else "immutable=1"
    return sqlite3.connect(f"file:{path}?{mode}", uri=True)


def table_rows(conn, table, ignore_scores):
    cols = [r[1] for r in conn.execute(f"PRAGMA table_info({table})")]
    if ignore_scores:
        cols = [c for c in cols if c not in SCORE_COLUMNS]
    pk = [r[1] for r in sorted(conn.execute(f"PRAGMA table_info({table})"), key=lambda r: r[5]) if r[5]]
    order = ", ".join(pk or cols)
    rows = conn.execute(f"SELECT {', '.join(cols)} FROM {table} ORDER BY {order}").fetchall()
    out = []
    for row in rows:
        row = dict(zip(cols, row))
        if "raw_gz" in row and row["raw_gz"] is not None:
            row["raw_gz"] = gzip.decompress(row["raw_gz"])
        if table == "settings" and ignore_scores and row["key"] in STARTUP_SETTINGS:
            continue
        out.append(row)
    return out


def main():
    a_path, b_path = sys.argv[1], sys.argv[2]
    ignore_scores = "--ignore-scores" in sys.argv
    a, b = connect(a_path), connect(b_path)
    failures = []

    va = a.execute("PRAGMA user_version").fetchone()[0]
    vb = b.execute("PRAGMA user_version").fetchone()[0]
    print(f"user_version {va} {vb}")
    if va != vb:
        failures.append("user_version")

    master = "SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name"
    ma, mb = a.execute(master).fetchall(), b.execute(master).fetchall()
    print(f"sqlite_master {len(ma)} objects, {'identical' if ma == mb else 'DIFFERENT'}")
    if ma != mb:
        failures.append("sqlite_master")
        for x, y in zip(ma, mb):
            if x != y:
                print(f"  first difference:\n  {x}\n  {y}")
                break

    tables = [r[0] for r in a.execute("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")]
    for table in tables:
        ra, rb = table_rows(a, table, ignore_scores), table_rows(b, table, ignore_scores)
        same = ra == rb
        print(f"{table}: {len(ra)} rows, {len(rb)} rows, {'identical' if same else 'DIFFERENT'}")
        if not same:
            failures.append(table)
            for x, y in zip(ra, rb):
                if x != y:
                    keys = [k for k in x if x.get(k) != y.get(k)]
                    print(f"  first differing row, columns {keys}")
                    break

    print("PASS" if not failures else f"FAIL {failures}")
    sys.exit(0 if not failures else 1)


main()
