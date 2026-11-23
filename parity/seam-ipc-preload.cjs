const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("__bmtRawInvoke", async (channel, ...args) => {
  try {
    await ipcRenderer.invoke(channel, ...args);
    return { ok: true };
  } catch (error) {
    return { ok: false, name: error?.name ?? "Error", message: String(error?.message ?? error) };
  }
});
