const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("__bmtRawInvoke", async (channel, ...args) => {
  try {
    await ipcRenderer.invoke(channel, ...args);
    return { ok: true };
  } catch (error) {
    return { ok: false, name: error?.name ?? "Error", message: String(error?.message ?? error) };
  }
});

// The page's own clock is Playwright's and ticks in whole milliseconds, so timing is read here.
contextBridge.exposeInMainWorld("__bmtTimedInvoke", async (channel, ...args) => {
  const start = performance.now();
  try {
    await ipcRenderer.invoke(channel, ...args);
  } catch {
    // a rejection still took time, and the case is recorded elsewhere
  }
  return performance.now() - start;
});
