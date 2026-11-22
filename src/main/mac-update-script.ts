// The shell script that finishes a macOS update once the app has quit. Kept
// apart from the updater, and free of Electron, so it can be exercised against
// throwaway folders.

// Single-quoted for sh, which takes everything literally inside but a quote
function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface MacSwap {
  // The process to wait out before touching its bundle
  pid: number;
  // The installed .app being replaced
  bundle: string;
  // The new .app, unpacked in a folder beside `bundle`
  stagedBundle: string;
  // That folder, removed once the swap is done
  stagingDir: string;
  // Where the old bundle waits until the new one is in place
  backup: string;
  // The download's temp folder, removed last
  tmpDir: string;
  // Extra arguments for the relaunched app
  relaunchArgs: string[];
}

// The running bundle can be renamed while it runs, but swapping it before the
// app has quit would leave a half-shut-down process holding files in the new
// one. So the script waits for the process to exit, moves the old bundle aside,
// moves the new one in, and relaunches whichever is in place, putting the old
// one back if the swap fails. An app that never exits is left alone.
export function macSwapScript(swap: MacSwap): string {
  const q = shQuote;
  const args = swap.relaunchArgs.length ? ` --args ${swap.relaunchArgs.map(q).join(" ")}` : "";
  return [
    "#!/bin/sh",
    `pid=${swap.pid}`,
    "tries=0",
    'while kill -0 "$pid" 2>/dev/null; do',
    "  tries=$((tries + 1))",
    '  if [ "$tries" -gt 120 ]; then',
    `    rm -rf ${q(swap.stagingDir)} ${q(swap.tmpDir)}`,
    "    exit 1",
    "  fi",
    "  sleep 1",
    "done",
    `rm -rf ${q(swap.backup)}`,
    `if mv ${q(swap.bundle)} ${q(swap.backup)}; then`,
    `  if mv ${q(swap.stagedBundle)} ${q(swap.bundle)}; then`,
    `    rm -rf ${q(swap.backup)}`,
    "  else",
    `    mv ${q(swap.backup)} ${q(swap.bundle)}`,
    "  fi",
    "fi",
    `rm -rf ${q(swap.stagingDir)}`,
    `open ${q(swap.bundle)}${args}`,
    `rm -rf ${q(swap.tmpDir)}`,
    "",
  ].join("\n");
}
