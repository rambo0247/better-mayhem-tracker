// Run after electron-stub.cjs and parity/seam.cjs. Drives every hook seam-overlays.cjs offers,
// with handlers that trip a wire if they are ever really called, then prints what happened.
const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const { ipcMain, BrowserWindow, Menu, Tray, clipboard, dialog } = require("electron");

const record = globalThis.__harness;
const hooks = globalThis.__parity;
const scratch = process.env.HARNESS_USER_DATA;

const tripwire = (name) => async () => {
  record.tripped.push(name);
  clipboard.writeImage();
  dialog.showSaveDialog();
  fs.writeFileSync(path.join(scratch, name), "x");
  cp.spawn("true");
  return { success: true };
};
const EXPORTS = { exportCardImage: "export:card-image", copyCardImage: "export:copy-card-image" };
for (const [method, channel] of Object.entries(EXPORTS)) {
  ipcMain.handle(channel, tripwire(method));
}
ipcMain.handle("app:check-update", async () => ({ hasUpdate: true, latestVersion: "1.3.0" }));
ipcMain.handle("app:update-notes", async () => null);

const invoke = (channel, ...args) => ipcMain.handlers.get(channel)({}, ...args);
const attempt = async (run) => {
  try {
    return { returned: await run() };
  } catch (error) {
    return { threw: String(error.message) };
  }
};
const never = (promise) =>
  Promise.race([
    promise.then(() => "settled"),
    new Promise((r) => setTimeout(() => r("pending"), 100)),
  ]);

(async () => {
  const win = new BrowserWindow({});
  const tray = new Tray("icon.png");
  tray.setToolTip("Better Mayhem Tracker");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "Show Window",
        click: () => {
          win.show();
          win.focus();
        },
      },
      { type: "separator" },
      { label: "Quit", click: () => require("electron").app.quit() },
    ]),
  );
  tray.on("double-click", () => {
    win.show();
    win.focus();
  });

  const results = {};
  results.defaultCopy = await invoke(EXPORTS.copyCardImage, {});
  results.defaultSave = await invoke(EXPORTS.exportCardImage, {});
  results.realCallCopy = await attempt(() => hooks.realCall({ method: "copyCardImage" }));
  results.realCallSave = await attempt(() => hooks.realCall({ method: "exportCardImage" }));
  results.realCallOther = await attempt(() => hooks.realCall({ method: "checkForUpdate" }));

  hooks.value({ method: "copyCardImage", value: { success: true } });
  results.valueCopy = await invoke(EXPORTS.copyCardImage, {});
  hooks.hold({ method: "exportCardImage" });
  results.holdSave = await never(invoke(EXPORTS.exportCardImage, {}));
  hooks.reset();
  results.afterReset = await invoke(EXPORTS.copyCardImage, {});

  hooks.github("update-available");
  results.launchInstall = await attempt(() => hooks.launchInstall());
  hooks.emit({ channel: "update:progress", payload: 42 });
  results.emitted = win.webContents.sent;
  results.notes = await attempt(() => hooks.notes({ from: "1.0.0", scenario: "notes-multi" }));
  results.menus = hooks.menus();
  results.probe = hooks.probeTray();

  console.log(JSON.stringify({ record, results }));
})();
