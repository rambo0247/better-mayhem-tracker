#!/bin/sh
# The parity driver logs these sentinels and nothing else compiles them in, so a release
# binary holding one carries the driver.
#
# Usage: no-driver.sh <release binary>
set -eu

for marker in bmt-parity-driver BMT_PARITY_TOKEN; do
  if grep -a -q "$marker" "$1"; then
    echo "release binary contains $marker"
    exit 1
  fi
  echo "release binary: no $marker"
done
