"""Compares two matches.db files read-only, cell by cell with the SQLite storage
class and the f64 bits of every REAL. raw_gz compares as gunzipped text, and its
byte equality is counted separately.
Usage: python3 -I compare_typed.py <a.db> <b.db> [--skip col,col] [--skip-settings key,key]"""
import gzip, os, sqlite3, struct, sys

def connect(p):
    mode = "mode=ro" if os.path.exists(p + "-wal") else "immutable=1"
    return sqlite3.connect(f"file:{p}?{mode}", uri=True)

def key(v):
    if isinstance(v, float):
        return ("real", struct.pack("<d", v))
    return (type(v).__name__, v)

def arg(flag):
    return set(sys.argv[sys.argv.index(flag) + 1].split(",")) if flag in sys.argv else set()

a, b = connect(sys.argv[1]), connect(sys.argv[2])
skip, skip_settings = arg("--skip"), arg("--skip-settings")
fails = []
for pragma in ["user_version", "page_size", "encoding", "auto_vacuum", "application_id", "journal_mode", "freelist_count"]:
    va, vb = a.execute(f"PRAGMA {pragma}").fetchone()[0], b.execute(f"PRAGMA {pragma}").fetchone()[0]
    print(f"{pragma}: {va} | {vb}" + ("" if va == vb else "  DIFF"))
    if va != vb and pragma in ("user_version", "page_size", "encoding", "auto_vacuum", "application_id"):
        fails.append(pragma)
q = "SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name"
ma, mb = a.execute(q).fetchall(), b.execute(q).fetchall()
print("sqlite_master", len(ma), len(mb), "identical" if ma == mb else "DIFFERENT")
if ma != mb:
    fails.append("sqlite_master")
    print("  only a:", [m[1] for m in ma if m not in mb]); print("  only b:", [m[1] for m in mb if m not in ma])
tables = sorted({r[0] for r in a.execute("SELECT name FROM sqlite_master WHERE type='table'")} | {r[0] for r in b.execute("SELECT name FROM sqlite_master WHERE type='table'")})
gz_same = gz_total = 0
for t in tables:
    def rows(c):
        cols = [r[1] for r in c.execute(f"PRAGMA table_info({t})") if r[1] not in skip]
        pk = [r[1] for r in sorted(c.execute(f"PRAGMA table_info({t})"), key=lambda r: r[5]) if r[5]] or cols
        out = {}
        for r in c.execute(f"SELECT {', '.join(cols)} FROM {t}"):
            d = dict(zip(cols, r))
            if t == "settings" and d.get("key") in skip_settings: continue
            out[tuple(key(d[k]) for k in pk)] = d
        return out
    try:
        ra, rb = rows(a), rows(b)
    except sqlite3.OperationalError as e:
        print(f"{t}: {e}"); fails.append(t); continue
    diffs = []
    for k in sorted(set(ra) | set(rb), key=repr):
        x, y = ra.get(k), rb.get(k)
        if x is None or y is None:
            diffs.append((k, "missing in " + ("a" if x is None else "b"))); continue
        for col in x:
            vx, vy = x[col], y.get(col)
            if col == "raw_gz" and isinstance(vx, bytes) and isinstance(vy, bytes):
                gz_total += 1; gz_same += vx == vy
                vx, vy = gzip.decompress(vx), gzip.decompress(vy)
            if key(vx) != key(vy):
                diffs.append((k, col, vx if not isinstance(vx, bytes) else vx[:60], vy if not isinstance(vy, bytes) else vy[:60]))
    print(f"{t}: {len(ra)} | {len(rb)} rows, {'identical' if not diffs else f'{len(diffs)} DIFFERENT'}")
    for d in diffs[:int(os.environ.get("SHOW", "4"))]: print("   ", d)
    if diffs: fails.append(t)
print(f"raw_gz byte-identical {gz_same} of {gz_total}")
print("PASS" if not fails else f"FAIL {fails}")
