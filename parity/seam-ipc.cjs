// Loaded by seam.cjs when SEAM_IPC is set. Records every ipcMain.handle call and every
// webContents.send, and stubs the OS calls a handler can make so a recording never opens a
// dialog, a Finder window, or touches the clipboard.
const { app, ipcMain, dialog, shell, clipboard, session } = require("electron");
const path = require("path");
const crypto = require("crypto");

const records = [];
let nextCall = 1;
const activeCalls = [];
const started = process.hrtime.bigint();
const since = () => Number(process.hrtime.bigint() - started) / 1e6;

// What the next dialog answers. null means the user cancelled it.
const control = { save: null, open: null, runDir: null };

function toJson(value) {
  const nonFinite = [];
  const walk = (v, where) => {
    if (v === undefined) return undefined;
    if (typeof v === "number" && !Number.isFinite(v)) {
      nonFinite.push(where);
      return null;
    }
    if (v === null || typeof v !== "object") return v;
    if (v instanceof Date) return v.toISOString();
    if (Buffer.isBuffer(v) || v instanceof Uint8Array) {
      return { $bytes: Buffer.from(v).toString("base64") };
    }
    if (typeof v.toJSON === "function") return walk(v.toJSON(), where);
    if (Array.isArray(v)) return v.map((item, i) => walk(item, `${where}[${i}]`) ?? null);
    const out = {};
    for (const [key, item] of Object.entries(v)) {
      const next = walk(item, `${where}.${key}`);
      if (next !== undefined) out[key] = next;
    }
    return out;
  };
  return { json: walk(value, "$"), nonFinite };
}

const activeCall = () => activeCalls[activeCalls.length - 1] ?? null;
const effect = (api, args) =>
  records.push({
    k: "effect",
    t: since(),
    call: activeCall(),
    api,
    args: args.map((a) => toJson(a).json ?? null),
  });

const realHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) =>
  realHandle(channel, async (event, ...args) => {
    const id = nextCall++;
    activeCalls.push(id);
    records.push({ k: "start", t: since(), id, channel, args: args.map((a) => toJson(a).json) });
    try {
      const result = await handler(event, ...args);
      const { json, nonFinite } = toJson(result);
      records.push({
        k: "end",
        t: since(),
        id,
        ok: true,
        void: result === undefined,
        result: json ?? null,
        nonFinite,
      });
      return result;
    } catch (error) {
      records.push({
        k: "end",
        t: since(),
        id,
        ok: false,
        name: error?.name ?? "Error",
        message: error?.message ?? String(error),
      });
      throw error;
    } finally {
      activeCalls.splice(activeCalls.lastIndexOf(id), 1);
    }
  });

app.on("web-contents-created", (_event, contents) => {
  const send = contents.send.bind(contents);
  contents.send = (channel, ...args) => {
    const { json } = toJson(args.length > 1 ? args : args[0]);
    records.push({
      k: "send",
      t: since(),
      call: activeCall(),
      channel,
      hasPayload: args.length > 0,
      payload: json ?? null,
      wc: contents.id,
    });
    return send(channel, ...args);
  };
});

dialog.showSaveDialog = async (...args) => {
  effect("dialog.showSaveDialog", [args[args.length - 1]]);
  return control.save
    ? { canceled: false, filePath: control.save }
    : { canceled: true, filePath: undefined };
};
dialog.showOpenDialog = async (...args) => {
  effect("dialog.showOpenDialog", [args[args.length - 1]]);
  return control.open
    ? { canceled: false, filePaths: [control.open] }
    : { canceled: true, filePaths: [] };
};
shell.openPath = async (target) => {
  effect("shell.openPath", [target]);
  return "";
};
shell.openExternal = async (url) => {
  effect("shell.openExternal", [url]);
};
shell.showItemInFolder = (target) => effect("shell.showItemInFolder", [target]);
clipboard.write = (data) => {
  effect("clipboard.write", [{ keys: Object.keys(data ?? {}) }]);
};
clipboard.writeImage = (image) => {
  effect("clipboard.writeImage", [{ size: image?.getSize?.() }]);
};
app.setLoginItemSettings = (settings) => effect("app.setLoginItemSettings", [settings]);

// The update scenario: the app believes it is installed, GitHub is a local server, and nothing
// may spawn a process, so a download that somehow verified still could not swap the app.
if (process.env.SEAM_GITHUB) {
  Object.defineProperty(app, "isPackaged", { get: () => true, configurable: true });
  const guardedFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = new URL(typeof input === "string" ? input : (input.url ?? String(input)));
    const ours =
      url.hostname === "api.github.com" ||
      (url.hostname === "github.com" &&
        url.pathname.startsWith("/rambo0247/better-mayhem-tracker/"));
    if (!ours) return guardedFetch(input, init);
    return guardedFetch(
      `${process.env.SEAM_GITHUB}/${url.hostname}${url.pathname}${url.search}`,
      init,
    );
  };
  const cp = require("child_process");
  for (const name of ["spawn", "spawnSync", "exec", "execFile", "execSync", "execFileSync"]) {
    cp[name] = (command) => {
      effect(`child_process.${name}`, [String(command)]);
      throw new Error("seam blocked a process spawn during the update scenario");
    };
  }
}

app.whenReady().then(() => {
  // Lets the driver call ipcRenderer.invoke for a channel window.api does not expose, and read
  // the message the renderer sees for a rejection.
  session.defaultSession.registerPreloadScript({
    type: "frame",
    filePath: path.join(__dirname, "seam-ipc-preload.cjs"),
  });
});

globalThis.__bmtIpc = {
  control,
  drain() {
    return records.splice(0, records.length);
  },
  sha256: (buffer) => crypto.createHash("sha256").update(buffer).digest("hex"),
};
