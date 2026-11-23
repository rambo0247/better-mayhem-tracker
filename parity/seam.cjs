// Loaded into Electron's main process with `-r`. Not app code.
// 1. Aborts on any write that would reach the app's real data folder.
// 2. Hides League and Riot paths so the client reads as closed.
// 3. Blocks main-process network except loopback.
// 4. Freezes the main process clock.
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");
const Module = require("module");

const realAppendFileSync = fs.appendFileSync;
const log = (...parts) => {
  if (process.env.SEAM_LOG) realAppendFileSync(process.env.SEAM_LOG, parts.join(" ") + "\n");
};

const NAMES = ["better-mayhem-tracker", "Better Mayhem Tracker"];
function defaultRoots() {
  const home = os.homedir();
  let base;
  if (process.platform === "darwin") base = path.join(home, "Library", "Application Support");
  else if (process.platform === "win32")
    base = process.env.APPDATA || path.join(home, "AppData", "Roaming");
  else base = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
  return NAMES.map((name) => path.join(base, name));
}
// The extra roots only ever add to the defaults, so an override cannot weaken the guard.
const ROOTS = [...defaultRoots(), ...JSON.parse(process.env.SEAM_REAL_ROOTS || "[]")].map((r) =>
  path.resolve(r).toLowerCase(),
);

const asString = (p) =>
  typeof p === "string"
    ? p
    : p instanceof URL
      ? p.pathname
      : Buffer.isBuffer(p)
        ? p.toString()
        : "";

function isReal(p) {
  const s = asString(p);
  if (!s) return false;
  const lower = path.resolve(s).toLowerCase();
  return ROOTS.some((root) => lower === root || lower.startsWith(root + path.sep));
}

function guard(op, ...targets) {
  for (const target of targets) {
    if (isReal(target)) {
      log("blocked-write", op, asString(target));
      throw new Error(`seam refused ${op} to ${asString(target)}`);
    }
  }
}

const WRITE_FLAG = /[wa+]/;
const writeFlags = (flags) => typeof flags === "string" && WRITE_FLAG.test(flags);
const writeMode = (flags) => typeof flags === "number" && (flags & 3) !== 0;

// [name, indexes of path arguments that are written to]
const MUTATORS = [
  ["writeFile", [0]],
  ["appendFile", [0]],
  ["mkdir", [0]],
  ["rm", [0]],
  ["rmdir", [0]],
  ["unlink", [0]],
  ["truncate", [0]],
  ["utimes", [0]],
  ["lutimes", [0]],
  ["chmod", [0]],
  ["chown", [0]],
  ["rename", [0, 1]],
  ["copyFile", [1]],
  ["cp", [1]],
  ["symlink", [1]],
  ["link", [1]],
  ["mkdtemp", [0]],
];

for (const [name, indexes] of MUTATORS) {
  const sync = fs[name + "Sync"];
  if (sync) {
    fs[name + "Sync"] = function (...args) {
      guard(name + "Sync", ...indexes.map((i) => args[i]));
      return sync.apply(this, args);
    };
  }
  const callback = fs[name];
  if (callback) {
    fs[name] = function (...args) {
      guard(name, ...indexes.map((i) => args[i]));
      return callback.apply(this, args);
    };
  }
  const promise = fs.promises[name];
  if (promise) {
    fs.promises[name] = async function (...args) {
      guard("promises." + name, ...indexes.map((i) => args[i]));
      return promise.apply(this, args);
    };
  }
}

const realOpenSync = fs.openSync;
fs.openSync = function (p, flags, ...rest) {
  if (writeFlags(flags) || writeMode(flags)) guard("openSync", p);
  return realOpenSync.call(this, p, flags, ...rest);
};
const realOpen = fs.open;
fs.open = function (p, flags, ...rest) {
  if (writeFlags(flags) || writeMode(flags)) guard("open", p);
  return realOpen.call(this, p, flags, ...rest);
};
const realPromiseOpen = fs.promises.open;
fs.promises.open = async function (p, flags, ...rest) {
  if (writeFlags(flags) || writeMode(flags)) guard("promises.open", p);
  return realPromiseOpen.call(this, p, flags, ...rest);
};
const realCreateWriteStream = fs.createWriteStream;
fs.createWriteStream = function (p, ...rest) {
  guard("createWriteStream", p);
  return realCreateWriteStream.call(this, p, ...rest);
};

const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  const loaded = realLoad.call(this, request, parent, isMain);
  if (request !== "better-sqlite3" || loaded.__seamGuarded) return loaded;
  class GuardedDatabase extends loaded {
    constructor(filename, options) {
      if (typeof filename === "string" && filename !== ":memory:" && !options?.readonly) {
        guard("sqlite-open", filename);
      }
      super(filename, options);
    }
  }
  GuardedDatabase.__seamGuarded = true;
  return GuardedDatabase;
};

const LEAGUE = /League of Legends|Riot Games/;
const hidden = (p) => LEAGUE.test(asString(p));
const enoent = (p) => Object.assign(new Error(`ENOENT: seam hid ${p}`), { code: "ENOENT" });

for (const name of [
  "readFileSync",
  "readdirSync",
  "statSync",
  "lstatSync",
  "openSync",
  "accessSync",
]) {
  const orig = fs[name];
  fs[name] = function (p, ...rest) {
    if (hidden(p)) {
      log("hide", name, asString(p));
      throw enoent(asString(p));
    }
    return orig.call(this, p, ...rest);
  };
}
const realExistsSync = fs.existsSync;
fs.existsSync = (p) => {
  if (hidden(p)) return /LeagueClient\.app$/.test(asString(p));
  return realExistsSync(p);
};
for (const name of ["readFile", "readdir", "stat", "lstat", "access"]) {
  const orig = fs.promises[name];
  fs.promises[name] = async function (p, ...rest) {
    if (hidden(p)) {
      log("hide", "promises." + name, asString(p));
      throw enoent(asString(p));
    }
    return orig.call(this, p, ...rest);
  };
}

for (const name of ["exec", "execFile", "spawn", "execSync", "execFileSync", "spawnSync"]) {
  const orig = cp[name];
  cp[name] = function (...args) {
    const command = JSON.stringify(args.slice(0, 2));
    if (/LeagueClient|\bps\b|powershell|wmic/i.test(command)) {
      log("block-process", name, command);
      throw new Error("seam blocked process scan");
    }
    return orig.apply(this, args);
  };
}

const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\])$/;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : (input.url ?? String(input));
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {}
  if (LOOPBACK.test(host)) return realFetch(input, init);
  log("fetch-blocked", url);
  throw new TypeError(`seam blocked network: ${url}`);
};
for (const lib of ["http", "https"]) {
  const mod = require(lib);
  for (const name of ["request", "get"]) {
    const orig = mod[name];
    mod[name] = function (...args) {
      const first = args[0];
      const host =
        typeof first === "string"
          ? new URL(first).hostname
          : first instanceof URL
            ? first.hostname
            : (first?.hostname ?? first?.host ?? "");
      if (!LOOPBACK.test(String(host).replace(/:\d+$/, ""))) {
        log("request-blocked", lib, String(host));
        throw new Error(`seam blocked network: ${host}`);
      }
      return orig.apply(this, args);
    };
  }
}

if (process.env.SEAM_FIXED_TIME) {
  const RealDate = Date;
  const fixed = Number(process.env.SEAM_FIXED_TIME);
  globalThis.Date = new Proxy(RealDate, {
    construct(target, args) {
      return args.length === 0 ? new target(fixed) : new target(...args);
    },
    apply(target) {
      return new target(fixed).toString();
    },
    get(target, key, receiver) {
      if (key === "now") return () => fixed;
      return Reflect.get(target, key, receiver);
    },
  });
}

try {
  const { app } = require("electron");
  app.whenReady().then(() => {
    const userData = app.getPath("userData");
    log("userData", userData);
    if (isReal(userData)) {
      log("userData-is-real", userData);
      app.exit(3);
    }
  });
} catch {}

log("seam loaded pid", process.pid);
