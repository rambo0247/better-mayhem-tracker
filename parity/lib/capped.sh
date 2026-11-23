#!/usr/bin/env bash
# usage: capped.sh <headroom> <command...>
# Runs the command under RLIMIT_NPROC, and exits 99 if anything in it was refused a process.
# macOS counts every process the user owns against the limit, Linux every thread, so the cap is
# the current count plus the headroom. A bare `ulimit -u 50` would refuse the first fork.
set -u
headroom=$1
shift
case "$(uname -s)" in
  Darwin) used=$(ps -U "$(id -u)" -o pid= | wc -l) ;;
  Linux) used=$(ps -L -U "$(id -u)" -o lwp= | wc -l) ;;
  *) exec "$@" ;;
esac
cap=$((used + headroom))
ulimit -u "$cap" || exit 1
log=$(mktemp)
{ "$@" 2>&1 1>&3 3>&- | tee "$log" >&2; } 3>&1
status=${PIPESTATUS[0]}
if grep -qiE "EAGAIN|resource temporarily unavailable|fork failed" "$log"; then
  echo "process cap hit: $headroom processes over the $used already running" >&2
  rm -f "$log"
  exit 99
fi
rm -f "$log"
exit "$status"
