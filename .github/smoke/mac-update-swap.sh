#!/bin/sh
# Runs the script the macOS updater leaves behind (tauri/src-tauri/src/mac_update_script.rs)
# against throwaway folders: an "installed" bundle, and the packaged app staged
# beside it the way the updater stages a download. Checks it waits for the old
# process, swaps the bundles, cleans up, and relaunches with the right args.
#
# The script comes from the updater's own source file, built by swap-script.rs.
#
# Usage: mac-update-swap.sh <path to the packaged .app>
set -eu

app="$1"
here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# A folder name with a space and a quote, to exercise the script's quoting
apps="$work/It's Apps"
bundle="$apps/Better Mayhem Tracker.app"
staging="$apps/.Better Mayhem Tracker.app.update"
mkdir -p "$bundle/Contents" "$staging" "$work/bin" "$work/tmp"
echo old > "$bundle/Contents/MARKER"
/usr/bin/ditto "$app" "$staging/Better Mayhem Tracker.app"

# Stands in for `open`, so the test relaunches nothing
printf '#!/bin/sh\necho "$*" > "%s/open.log"\n' "$work" > "$work/bin/open"
chmod +x "$work/bin/open"

# From tauri/, where the pinned toolchain is
(cd "$here/../../tauri" && rustc --edition 2024 --crate-name swap_script \
  -o "$work/swap-script" "$here/swap-script.rs")

# The "running app" the script has to wait out
sleep 3 &
pid=$!

"$work/swap-script" "$pid" "$bundle" "$staging/Better Mayhem Tracker.app" "$staging" \
  "$staging.old" "$work/tmp" --hidden > "$work/update.sh"

start=$(date +%s)
PATH="$work/bin:$PATH" /bin/sh "$work/update.sh"
waited=$(( $(date +%s) - start ))

fail() { echo "FAIL: $1"; exit 1; }
[ "$waited" -ge 2 ] || fail "did not wait for the old process (${waited}s)"
[ ! -e "$bundle/Contents/MARKER" ] || fail "old bundle still in place"
[ -d "$bundle/Contents/MacOS" ] || fail "new bundle not in place"
[ ! -e "$staging" ] || fail "staging folder left behind"
[ ! -e "$staging.old" ] || fail "backup left behind"
[ ! -e "$work/tmp" ] || fail "temp folder left behind"
grep -qx "$bundle --args --hidden" "$work/open.log" || fail "relaunched with: $(cat "$work/open.log")"
codesign --verify --deep --strict "$bundle" || fail "signature broken by the swap"
echo "Update swap check passed"
