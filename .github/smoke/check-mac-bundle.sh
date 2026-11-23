#!/bin/sh
# The identity the 1.2.1 updater and the data folder depend on: the bundle id, the
# executable's name, the version, and a signature that holds.
#
# Usage: check-mac-bundle.sh <.app> <version>
set -eu

app="$1"
plist="$app/Contents/Info.plist"
codesign --verify --deep --strict "$app"
test "$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$plist")" = com.better-mayhem-tracker.app
test "$(/usr/libexec/PlistBuddy -c 'Print CFBundleExecutable' "$plist")" = "Better Mayhem Tracker"
test "$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$plist")" = "$2"
test -f "$app/Contents/MacOS/Better Mayhem Tracker"
echo "bundle identity: ok"
