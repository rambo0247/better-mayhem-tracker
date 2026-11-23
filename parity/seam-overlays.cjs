// Loaded by seam.cjs. Not app code.
// 1. Points the updater's GitHub requests, the releases page on api.github.com and the
//    asset downloads on github.com, at fake-github.ts, one scenario at a time. The app
//    still sees github.com URLs, so its download-URL prefix check runs unchanged.
// 2. Lets a run replace the answer to any IPC channel, so a dialog that needs update,
//    recovery or export data gets synthetic state and never the real data folder.
// 3. Records the tray, its menus, and the application menu for menus.ts.
// Everything is reached from a run through globalThis.__parity, by the drive.ts `main` step.

const REPO_PATH = "/repos/rambo0247/better-mayhem-tracker/releases";
const RELEASES_URL =
  /^https:\/\/api\.github\.com(\/repos\/rambo0247\/better-mayhem-tracker\/releases)(\?.*)?$/;
const DOWNLOAD_URL =
  /^https:\/\/github\.com(\/rambo0247\/better-mayhem-tracker\/releases\/download\/.*)$/;
const MAX_BODY_CHARS = 4_000;
const DEFAULT_SCENARIO = "up-to-date";

const CHANNELS = {
  getRecoveryReport: "backup:recovery-report",
  checkForUpdate: "app:check-update",
  downloadUpdate: "app:download-update",
  getLaunchInstall: "app:launch-install",
  getUpdateNotes: "app:update-notes",
  exportCardImage: "export:card-image",
  copyCardImage: "export:copy-card-image",
};

// A function in a template has no JSON form; its source stands in for it.
function serializeTemplate(template) {
  return template.map((entry) => {
    const out = {};
    for (const [key, value] of Object.entries(entry)) {
      if (typeof value === "function") out[key] = { $function: value.toString() };
      else if (key === "submenu" && Array.isArray(value)) out[key] = serializeTemplate(value);
      else out[key] = value;
    }
    return out;
  });
}

function serializeMenu(menu) {
  return menu.items.map((item) => ({
    type: item.type,
    label: item.label,
    role: item.role ?? null,
    enabled: item.enabled,
    visible: item.visible,
    checked: item.checked,
    accelerator: item.accelerator ?? null,
    submenu: item.submenu ? serializeMenu(item.submenu) : null,
  }));
}

function parseVersion(version) {
  const m = String(version)
    .trim()
    .replace(/^v/, "")
    .match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return pa ? 1 : pb ? -1 : 0;
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

// Mirrors toReleaseNote in src/main/updater.ts
function toReleaseNote(release) {
  const body = String(release.body ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/^[ \t]*\*\*Full Changelog\*\*:.*$/gim, "")
    .trim();
  return {
    version: String(release.tag_name).replace(/^v/, ""),
    publishedAt: typeof release.published_at === "string" ? release.published_at : "",
    body: body.length > MAX_BODY_CHARS ? `${body.slice(0, MAX_BODY_CHARS)}…` : body,
    url: typeof release.html_url === "string" ? release.html_url : "",
  };
}

// Where a request to GitHub goes instead, or null for any other URL
function rewriteGithubUrl(url, base, scenario) {
  const download = DOWNLOAD_URL.exec(url);
  if (download) return base + download[1];
  const releases = RELEASES_URL.exec(url);
  if (!releases) return null;
  const target = new URL(base + releases[1] + (releases[2] ?? ""));
  target.searchParams.set("scenario", scenario);
  return target.toString();
}

module.exports = {
  rewriteGithubUrl,
  serializeMenu,
  serializeTemplate,
  compareVersions,
  toReleaseNote,
};

if (process.versions.electron) {
  const { app, ipcMain, BrowserWindow, Menu, Tray } = require("electron");

  const originals = new Map();
  const overrides = new Map();
  let scenario = DEFAULT_SCENARIO;

  const realHandle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, listener) => {
    originals.set(channel, listener);
    return realHandle(channel, (event, ...args) => {
      const replacement = overrides.get(channel);
      return replacement ? replacement(event, ...args) : listener(event, ...args);
    });
  };

  const github = process.env.SEAM_GITHUB;
  const guardedFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = typeof input === "string" ? input : (input.url ?? String(input));
    const target = github ? rewriteGithubUrl(url, github, scenario) : null;
    return guardedFetch(target ?? input, init);
  };

  const recorded = { menus: [], trays: [] };

  const buildFromTemplate = Menu.buildFromTemplate;
  Menu.buildFromTemplate = function (template) {
    const menu = buildFromTemplate.call(this, template);
    recorded.menus.push({ menu, template });
    return menu;
  };

  const trackTray = (tray) => {
    let entry = recorded.trays.find((t) => t.tray === tray);
    if (!entry) {
      entry = { tray, tooltip: null, menu: null, events: [] };
      recorded.trays.push(entry);
    }
    return entry;
  };
  const patchTray = (name, record) => {
    const original = Tray.prototype[name];
    Tray.prototype[name] = function (...args) {
      record(trackTray(this), args);
      return original.apply(this, args);
    };
  };
  patchTray("setToolTip", (entry, [text]) => (entry.tooltip = text));
  patchTray("setContextMenu", (entry, [menu]) => (entry.menu = menu));
  for (const name of ["on", "once", "addListener"]) {
    patchTray(name, (entry, [event, handler]) => entry.events.push({ event, handler, name }));
  }

  // Safe answers for the two calls that would otherwise open a save dialog or write the
  // operator's clipboard. A state that wants an export result replaces them.
  const defaults = () => {
    const refuse = async () => ({ success: false, error: "Exports are off in parity runs" });
    overrides.set(CHANNELS.exportCardImage, refuse);
    overrides.set(CHANNELS.copyCardImage, refuse);
  };
  defaults();

  const channelOf = (method) => {
    const channel = CHANNELS[method];
    if (!channel) throw new Error(`no channel known for ${method}`);
    return channel;
  };

  const window = () => BrowserWindow.getAllWindows()[0];

  // Calls a handler with the window's show and focus replaced, so reading what it does
  // never puts the app in front of the operator.
  const withoutWindowEffects = (action) => {
    const win = window();
    const calls = [];
    if (win) {
      win.show = () => calls.push("show");
      win.focus = () => calls.push("focus");
    }
    try {
      action();
    } finally {
      if (win) {
        delete win.show;
        delete win.focus;
      }
    }
    return calls;
  };

  const probeQuit = (action) => {
    const calls = [];
    app.quit = () => calls.push("app.quit");
    try {
      action();
    } finally {
      delete app.quit;
    }
    return calls;
  };

  const source = (fn) => (typeof fn === "function" ? fn.toString() : null);

  globalThis.__parity = {
    reset() {
      overrides.clear();
      scenario = DEFAULT_SCENARIO;
      defaults();
      return "ok";
    },
    github(name) {
      scenario = name;
      return scenario;
    },
    value({ method, value }) {
      overrides.set(channelOf(method), async () => value);
      return "ok";
    },
    hold({ method }) {
      overrides.set(channelOf(method), () => new Promise(() => {}));
      return "ok";
    },
    // What the launch check would be installing, taken from the real checkForUpdate
    async launchInstall() {
      const info = await originals.get(CHANNELS.checkForUpdate)(null);
      overrides.set(CHANNELS.getLaunchInstall, async () => info);
      return info;
    },
    // What getUpdateNotes answers when the app launched on a newer version than `from`
    async notes({ from, scenario: name }) {
      const url = `${github}${REPO_PATH}?per_page=20&scenario=${name}`;
      const page = await (await guardedFetch(url)).json();
      const published = page.filter(
        (r) => r && !r.draft && !r.prerelease && typeof r.tag_name === "string",
      );
      const to = app.getVersion();
      const value = {
        from,
        to,
        url: `https://github.com/rambo0247/better-mayhem-tracker/releases/tag/v${to}`,
        releases: published
          .filter(
            (r) => compareVersions(r.tag_name, from) > 0 && compareVersions(r.tag_name, to) <= 0,
          )
          .map(toReleaseNote),
      };
      overrides.set(CHANNELS.getUpdateNotes, async () => value);
      return value;
    },
    emit({ channel, payload }) {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send(channel, payload);
      }
      return "ok";
    },
    async realCall({ method, args = [] }) {
      return originals.get(channelOf(method))(null, ...args);
    },
    menus() {
      const appMenu = Menu.getApplicationMenu();
      const templateOf = (menu) => recorded.menus.find((m) => m.menu === menu)?.template ?? null;
      return {
        platform: process.platform,
        appName: app.getName(),
        appMenu: appMenu ? serializeMenu(appMenu) : null,
        trays: recorded.trays.map((t) => ({
          tooltip: t.tooltip,
          menu: t.menu ? serializeMenu(t.menu) : null,
          template: t.menu && templateOf(t.menu) ? serializeTemplate(templateOf(t.menu)) : null,
          events: t.events.map((e) => ({
            event: e.event,
            via: e.name,
            handler: source(e.handler),
          })),
        })),
      };
    },
    // What each tray handler does, read by running it with the window and quit stubbed
    probeTray() {
      return recorded.trays.map((t) => {
        const doubleClick = t.events.find((e) => e.event === "double-click");
        const items = t.menu ? t.menu.items : [];
        const win = window();
        const visibleBefore = win ? win.isVisible() : null;
        const out = {
          doubleClick: doubleClick
            ? { registered: true, calls: withoutWindowEffects(() => t.tray.emit("double-click")) }
            : { registered: false, calls: [] },
          click: t.events.some((e) => e.event === "click") ? "registered" : "none",
          items: [],
          windowVisibleBefore: visibleBefore,
        };
        for (const item of items.filter((i) => i.type !== "separator")) {
          const calls = [];
          const effects = withoutWindowEffects(() => {
            calls.push(...probeQuit(() => item.click()));
          });
          out.items.push({ label: item.label, calls: [...effects, ...calls] });
        }
        return out;
      });
    },
  };
}
