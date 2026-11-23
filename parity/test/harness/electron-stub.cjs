// Preloaded before parity/seam.cjs by seam-overlays.test.ts, in plain node. It stands in for
// Electron's main process (process.type "browser", a fake `electron` module) and records every
// write, spawn, clipboard use and dialog the run attempts, so the test can read what the seam
// let through. Not app code.
const Module = require("module");
const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const { EventEmitter } = require("events");

const record = {
  writes: [],
  spawns: [],
  clipboard: [],
  dialogs: [],
  shell: [],
  tripped: [],
  overlayLoad: null,
};
globalThis.__harness = record;

const WRITERS = [
  "writeFile",
  "appendFile",
  "mkdir",
  "rm",
  "rmdir",
  "unlink",
  "truncate",
  "rename",
  "copyFile",
  "cp",
  "symlink",
  "link",
  "mkdtemp",
];
const spy = (owner, key, label) => {
  const real = owner[key];
  if (typeof real !== "function") return;
  owner[key] = function (...args) {
    record.writes.push(`${label}:${String(args[0])}`);
    return real.apply(this, args);
  };
};
for (const name of WRITERS) {
  spy(fs, name + "Sync", name + "Sync");
  spy(fs, name, name);
  spy(fs.promises, name, "promises." + name);
}
spy(fs, "createWriteStream", "createWriteStream");
for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
  const real = cp[name];
  cp[name] = function (...args) {
    record.spawns.push(`${name}:${String(args[0])}`);
    return real.apply(this, args);
  };
}

const recorder = (bucket) =>
  new Proxy(
    {},
    {
      get(target, key) {
        if (key in target) return target[key];
        return async () => {
          record[bucket].push(String(key));
        };
      },
    },
  );

const windows = [];
class FakeWindow extends EventEmitter {
  constructor() {
    super();
    windows.push(this);
    this.visible = false;
    this.webContents = { sent: [], send: (...sent) => this.webContents.sent.push(sent) };
  }
  static getAllWindows() {
    return windows;
  }
  isDestroyed() {
    return false;
  }
  isVisible() {
    return this.visible;
  }
  setAlwaysOnTop() {}
  showInactive() {
    this.visible = true;
  }
  show() {
    this.visible = true;
  }
  focus() {}
}

class FakeApp extends EventEmitter {
  getPath() {
    return process.env.HARNESS_USER_DATA;
  }
  getName() {
    return "better-mayhem-tracker";
  }
  getVersion() {
    return "1.2.1";
  }
  setActivationPolicy() {}
  focus() {}
  quit() {
    record.tripped.push("app.quit");
  }
  exit() {}
}
const app = new FakeApp();
app.dock = { hide() {} };

class FakeTray extends EventEmitter {
  setToolTip() {}
  setContextMenu() {}
}

const electron = {
  app,
  BrowserWindow: FakeWindow,
  Tray: FakeTray,
  Menu: {
    buildFromTemplate: (template) => ({
      items: template.map((entry) => ({
        enabled: true,
        visible: true,
        checked: false,
        ...entry,
        submenu: entry.submenu ? { items: entry.submenu } : undefined,
      })),
    }),
    getApplicationMenu: () => null,
  },
  ipcMain: {
    handlers: new Map(),
    handle(channel, listener) {
      this.handlers.set(channel, listener);
    },
  },
  dialog: recorder("dialogs"),
  clipboard: recorder("clipboard"),
  shell: recorder("shell"),
};

const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "electron") return electron;
  if (request.endsWith("seam-overlays.cjs")) {
    // The seam's write guard has to be in place before the overlay hooks load
    const [root] = JSON.parse(process.env.SEAM_REAL_ROOTS);
    try {
      fs.mkdirSync(path.join(root, "probe-at-overlay-load"));
      record.overlayLoad = { guardActive: false };
    } catch (error) {
      record.overlayLoad = { guardActive: /seam refused/.test(String(error)) };
    }
  }
  return realLoad.call(this, request, parent, isMain);
};
process.type = "browser";
