#!/bin/bash
# Opens a data root in trunk Electron 1.2.1 through parity/run-electron.ts, takes
# a screenshot, quits, and records what the database looks like afterwards.
# Usage: electron-open.sh <data root> <out dir> [state id]
set -euo pipefail
repo=$(cd "$(dirname "$0")/../../../.." && pwd)
tools=/Users/leinierperez/dev/bmt-wt/_tools
data=$1
out=$2
state=${3:-}
mkdir -p "$out"
run="$out/run"
args=(--data "$data" --out "$run")
if [ -n "$state" ]; then args+=(--state "$state"); fi

"$tools/wait-no-game.sh"
ulimit -u $(( $(ps -U "$(id -u)" -o pid= | wc -l) + 200 ))
"$tools/capture-slot.sh" bun "$repo/parity/run-electron.ts" "${args[@]}" > "$out/electron.log" 2>&1 &
pid=$!

waited=0
until grep -q '^ready ' "$out/electron.log"; do
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "run-electron.ts exited before its ready line"
    cat "$out/electron.log"
    exit 1
  fi
  if [ "$waited" -ge 3900 ]; then
    echo "no ready line after ${waited}s"
    kill "$pid"
    exit 1
  fi
  sleep 3
  waited=$((waited + 3))
done

bun "$repo/parity/drive.ts" --run "$run" shot "$out/screen.png"
bun "$repo/parity/drive.ts" --run "$run" quit
waited=0
while kill -0 "$pid" 2>/dev/null; do
  if [ "$waited" -ge 60 ]; then
    echo "Electron still running ${waited}s after quit"
    kill "$pid"
    exit 1
  fi
  sleep 1
  waited=$((waited + 1))
done

# A WAL database opened read-only needs its -shm, which a clean close removes,
# so the checks read a copy of what Electron left
mkdir -p "$out/after"
cp "$run/data/matches.db" "$out/after/"
for side in wal shm; do
  if [ -e "$run/data/matches.db-$side" ]; then cp "$run/data/matches.db-$side" "$out/after/"; fi
done
db="$out/after/matches.db"
sqlite3 "$db" "PRAGMA user_version" > "$out/user_version.txt"
sqlite3 "$db" "PRAGMA integrity_check" > "$out/integrity.txt"
sqlite3 "$db" .dump > "$out/dump.sql"
python3 -I - "$db" "$out/schema.json" <<'PY'
import json, sqlite3, sys
conn = sqlite3.connect(sys.argv[1])
rows = conn.execute("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").fetchall()
version = conn.execute("PRAGMA user_version").fetchone()[0]
json.dump({"user_version": version, "sqlite_master": [list(r) for r in rows]}, open(sys.argv[2], "w"), indent=1)
PY
awk '/blocked-write/ { n++ } END { print n + 0 }' "$run/seam.log" > "$out/blocked-writes.txt"
echo "user_version $(cat "$out/user_version.txt"), integrity $(cat "$out/integrity.txt"), blocked writes $(cat "$out/blocked-writes.txt")"
