const fs = require("fs");
const path = require("path");
const { fileURLToPath } = require("url");
const Module = require("module");
const { realDataRoots, isUnderRealFolder } = require("./lib/real-folder.cjs");

const realAppendFileSync = fs.appendFileSync;
const log = (...parts) => {
  if (process.env.SEAM_LOG) realAppendFileSync(process.env.SEAM_LOG, parts.join(" ") + "\n");
};

// The extra roots only ever add to the defaults, so an override cannot weaken the guard.
const ROOTS = [...realDataRoots(), ...JSON.parse(process.env.SEAM_REAL_ROOTS || "[]")];

const asString = (p) =>
  typeof p === "string"
    ? p
    : p instanceof URL
      ? p.protocol === "file:"
        ? fileURLToPath(p)
        : ""
      : Buffer.isBuffer(p)
        ? p.toString()
        : "";

function isReal(p) {
  const s = asString(p);
  return s !== "" && isUnderRealFolder(s, ROOTS);
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
const { O_WRONLY, O_RDWR, O_CREAT, O_TRUNC, O_APPEND } = fs.constants;
const writeMode = (flags) =>
  typeof flags === "number" && (flags & (O_WRONLY | O_RDWR | O_CREAT | O_TRUNC | O_APPEND)) !== 0;

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
  ["lchown", [0]],
  ["lchmod", [0]],
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

const RealWriteStream = fs.WriteStream;
fs.WriteStream = class extends RealWriteStream {
  constructor(p, ...rest) {
    guard("WriteStream", p);
    super(p, ...rest);
  }
};

function guardSqlite(loaded) {
  // SQL can name another file: VACUUM INTO writes one, ATTACH opens one for writing.
  const SQL_FILE = /(?:VACUUM\s+(?:\w+\s+)?INTO|ATTACH(?:\s+DATABASE)?)\s+(['"])(.+?)\1/gi;
  const guardSql = (sql) => {
    if (typeof sql !== "string") return;
    for (const match of sql.matchAll(SQL_FILE)) guard("sqlite-sql", match[2]);
  };
  class GuardedDatabase extends loaded {
    constructor(filename, options) {
      if (typeof filename === "string" && filename !== ":memory:" && !options?.readonly) {
        guard("sqlite-open", filename);
      }
      super(filename, options);
    }
    backup(dest, ...rest) {
      guard("sqlite-backup", dest);
      return super.backup(dest, ...rest);
    }
    exec(sql) {
      guardSql(sql);
      return super.exec(sql);
    }
    prepare(sql) {
      guardSql(sql);
      return super.prepare(sql);
    }
    pragma(sql, ...rest) {
      guardSql(sql);
      return super.pragma(sql, ...rest);
    }
  }
  GuardedDatabase.__seamGuarded = true;
  return GuardedDatabase;
}

let inactiveElectron;
// Electron's own show() activates the app, which takes focus from whatever the operator is doing.
// Every window is created hidden and shown inactive instead, at the size the app asked for.
function guardElectron(electron) {
  if (inactiveElectron) return inactiveElectron;
  const RealWindow = electron.BrowserWindow;
  // Not a subclass: BrowserWindow.getAllWindows() leaves out instances of one.
  const InactiveWindow = new Proxy(RealWindow, {
    construct(target, [options = {}, ...rest]) {
      const window = Reflect.construct(
        target,
        [
          {
            ...options,
            show: false,
            webPreferences: { ...options.webPreferences, backgroundThrottling: false },
          },
          ...rest,
        ],
        target,
      );
      // An accessory app's window can open behind others. A covered window stops painting.
      window.setAlwaysOnTop(true, "floating");
      if (options.show !== false) window.showInactive();
      return window;
    },
  });
  RealWindow.prototype.show = function () {
    this.showInactive();
  };
  RealWindow.prototype.focus = function () {
    log("dropped focus");
  };
  electron.app.focus = () => log("dropped app.focus");
  const realEmit = RealWindow.prototype.emit;
  // Electron's own listeners (visibilityChanged) throw when an event reaches a destroyed window.
  RealWindow.prototype.emit = function (name, ...args) {
    if (name !== "closed" && this.isDestroyed()) {
      log("dropped-event-on-destroyed-window", String(name));
      return false;
    }
    return realEmit.call(this, name, ...args);
  };
  inactiveElectron = new Proxy(electron, {
    get: (target, key, receiver) =>
      key === "BrowserWindow" ? InactiveWindow : Reflect.get(target, key, receiver),
  });
  return inactiveElectron;
}

const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  const loaded = realLoad.call(this, request, parent, isMain);
  if (request === "better-sqlite3" && !loaded.__seamGuarded) return guardSqlite(loaded);
  if (request === "electron" && process.type === "browser") return guardElectron(loaded);
  return loaded;
};

// The app finds the client through its install and lockfile paths. Reads that fail with ENOENT
// make the client look closed, so no state depends on whether League is open on this machine.
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
// The client reads as installed but not running: the app bundle exists, its lockfile and the
// Riot metadata do not.
const realExistsSync = fs.existsSync;
fs.existsSync = (p) => {
  if (hidden(p)) return asString(p).endsWith("LeagueClient.app");
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

const EVAL_FLAGS = new Set(["-e", "--eval", "-p", "--print", "-pe"]);
const requiresSeam = (argv) =>
  argv.some(
    (arg, i) =>
      ((arg === "-r" || arg === "--require") && path.resolve(argv[i + 1] ?? "") === __filename) ||
      arg === `--require=${__filename}`,
  );
// Node drops `-e <code>` from an inherited execArgv only when it is process.execArgv itself. A
// copy keeps it, the child runs the parent's eval code instead of its module, and forks again.
function childExecArgv(given) {
  const argv = [];
  const source = given ?? process.execArgv;
  for (let i = 0; i < source.length; i++) {
    if (given === undefined && EVAL_FLAGS.has(source[i])) i++;
    else if (given === undefined && /^--(eval|print)=/.test(source[i])) continue;
    else argv.push(source[i]);
  }
  return requiresSeam(argv) ? argv : ["-r", __filename, ...argv];
}
const MAX_FORK_DEPTH = 4;
const cp = require("child_process");
const realFork = cp.fork;
cp.fork = function (modulePath, args, options) {
  const argList = Array.isArray(args) ? args : [];
  const opts = { ...(Array.isArray(args) || args === undefined ? options : args) };
  const depth = Number(process.env.SEAM_FORK_DEPTH ?? 0);
  // NaN fails every comparison, so a non-numeric value would turn the cap off
  if (!Number.isInteger(depth) || depth < 0 || depth >= MAX_FORK_DEPTH) {
    log("blocked-fork depth", depth);
    throw new Error(`seam refused fork: already ${depth} forks deep`);
  }
  opts.execArgv = childExecArgv(opts.execArgv);
  opts.env = { ...(opts.env ?? process.env), SEAM_FORK_DEPTH: String(depth + 1) };
  return realFork.call(this, modulePath, argList, opts);
};

// The names and addresses that reach this machine: localhost, all of 127.0.0.0/8, 0.0.0.0, ::1
function isLoopback(given) {
  let host = String(given).toLowerCase();
  if (host.startsWith("["))
    host = host.slice(1, host.indexOf("]") === -1 ? undefined : host.indexOf("]"));
  else if (host.split(":").length === 2) host = host.split(":")[0];
  if (host === "localhost" || host === "::1" || host === "0:0:0:0:0:0:0:1" || host === "0.0.0.0") {
    return true;
  }
  const octets = host.split(".");
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  );
}
// A running game serves its API on 2999 with no login, so no socket, whatever called it, may
// connect to that port. http, https, fetch, net and tls all end in Socket.connect. The port is
// SEAM_LIVE_PORT so a test can stand a listener in for it, and run-electron pins it to 2999.
const net = require("net");
const realSocketConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const options = first !== null && typeof first === "object" ? first : { port: first };
  const guarded = Number(process.env.SEAM_LIVE_PORT || 2999);
  if (Number(options.port) === guarded) {
    log("blocked-live-port", String(options.host ?? "localhost"), String(options.port));
    const error = new Error(`seam refused the live client port ${options.port}`);
    error.code = "ECONNREFUSED";
    process.nextTick(() => this.destroy(error));
    return this;
  }
  return realSocketConnect.apply(this, args);
};

// The hosts game-assets.ts and dragon.ts fetch from. With SEAM_WEB_FAKE=<loopback url>, a request
// for https://<host>/<path> goes to <loopback url>/<host>/<path>, and everything else stays blocked.
const WEB_HOSTS = new Set([
  "ddragon.leagueoflegends.com",
  "raw.communitydragon.org",
  "cdn.communitydragon.org",
]);
const webFake = (() => {
  const given = process.env.SEAM_WEB_FAKE;
  if (!given) return null;
  let base;
  try {
    base = new URL(given);
  } catch {
    throw new Error(`seam refuses SEAM_WEB_FAKE, which is not a URL`);
  }
  if (!/^https?:$/.test(base.protocol) || !isLoopback(base.hostname)) {
    throw new Error(`seam refuses SEAM_WEB_FAKE=${given}, which is not a loopback http URL`);
  }
  return base.origin + base.pathname.replace(/\/$/, "");
})();
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : (input.url ?? String(input));
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    // an unparseable URL is not loopback and gets blocked below
  }
  if (webFake && WEB_HOSTS.has(host)) {
    const target = new URL(url);
    log("web-fake", host, target.pathname);
    return realFetch(`${webFake}/${host}${target.pathname}${target.search}`, init);
  }
  if (isLoopback(host)) return realFetch(input, init);
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
      if (!isLoopback(host)) {
        log("request-blocked", lib, String(host));
        throw new Error(`seam blocked network: ${host}`);
      }
      return orig.apply(this, args);
    };
  }
}

// SEAM_CLOCK_LIVE=1 leaves Date.now running, so a backoff measured against it can end. Dates built
// with new Date() and Date() stay fixed.
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
      if (key === "now")
        return process.env.SEAM_CLOCK_LIVE === "1" ? () => RealDate.now() : () => fixed;
      return Reflect.get(target, key, receiver);
    },
  });
}

const fault = (kind, error) => {
  const text = `${kind} ${error instanceof Error ? error.stack || error.message : String(error)}`;
  log("fault", text.replaceAll("\n", "\n  "));
  if (process.env.SEAM_RUN_DIR) {
    try {
      realAppendFileSync(
        path.join(process.env.SEAM_RUN_DIR, "logs", "main.log"),
        `FATAL ${text}\n`,
      );
    } catch (error) {
      log("main.log unwritable", String(error));
    }
  }
};
// A listener also stops Electron from opening its "JavaScript error in the main process" dialog.
process.on("uncaughtException", (error) => fault("uncaughtException", error));
process.on("unhandledRejection", (reason) => fault("unhandledRejection", reason));

if (process.type === "browser") {
  const { app: electronApp, dialog, shell } = require("electron");
  const userData = electronApp.getPath("userData");
  log("userData", userData);
  if (isReal(userData)) {
    log("userData-is-real", userData);
    electronApp.exit(3);
  }
  const realTrash = shell.trashItem.bind(shell);
  shell.trashItem = async (target) => {
    guard("trashItem", target);
    return realTrash(target);
  };
  if (process.platform === "darwin" && process.env.SEAM_DOCK !== "show") {
    electronApp.setActivationPolicy("accessory");
    electronApp.dock?.hide();
  }
  dialog.showErrorBox = (title, content) => fault("showErrorBox", `${title}: ${content}`);
  if (process.env.SEAM_COVER === "1") {
    electronApp.once("browser-window-created", () => {
      setTimeout(() => {
        const { BaseWindow, screen } = require("electron");
        const cover = new BaseWindow({
          ...screen.getPrimaryDisplay().bounds,
          show: false,
          focusable: false,
          backgroundColor: "#ff00ff",
        });
        cover.setAlwaysOnTop(true, "screen-saver");
        cover.showInactive();
        log("cover shown over the app window");
      }, 500);
    });
  }
}

log("seam loaded pid", process.pid);
