#!/bin/sh
# Runs the script the macOS updater leaves behind (src/main/mac-update-script.ts)
# against throwaway folders: an "installed" bundle, and the packaged app staged
# beside it the way the updater stages a download. Checks it waits for the old
# process, swaps the bundles, cleans up, and relaunches with the right args.
#
# Usage: mac-update-swap.sh <path to the packaged .app>
set -eu

app="$1"
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

npx esbuild src/main/mac-update-script.ts --format=esm --log-level=error \
  --outfile="$work/script.mjs"

# The "running app" the script has to wait out
sleep 3 &
pid=$!

node --input-type=module -e '
const { macSwapScript } = await import(process.argv[1]);
const [bundle, staging, tmp, pid] = process.argv.slice(2);
process.stdout.write(macSwapScript({
  pid: Number(pid),
  bundle,
  stagedBundle: staging + "/Better Mayhem Tracker.app",
  stagingDir: staging,
  backup: staging + ".old",
  tmpDir: tmp,
  relaunchArgs: ["--hidden"],
}));
' "$work/script.mjs" "$bundle" "$staging" "$work/tmp" "$pid" > "$work/update.sh"

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
