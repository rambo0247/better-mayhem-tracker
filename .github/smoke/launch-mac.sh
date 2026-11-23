#!/bin/sh
# Unzips the packaged mac app and starts it from a temp folder. A runner has no display to
# speak of, so still running after 15 s is the check.
#
# Usage: launch-mac.sh <zip>
set -eu

dir="$(mktemp -d)"
trap 'rm -rf "$dir"' EXIT
ditto -x -k "$1" "$dir"
"$dir/Better Mayhem Tracker.app/Contents/MacOS/Better Mayhem Tracker" > "$dir/launch.log" 2>&1 &
pid=$!
sleep 15
alive=0
if kill -0 "$pid" 2>/dev/null; then alive=1; fi
kill "$pid" || true
cat "$dir/launch.log"
test "$alive" -eq 1
