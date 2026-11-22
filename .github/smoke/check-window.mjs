// Smoke test for a packaged build, run by CI after launching the app with
// --remote-debugging-port=9333. Connects to the window over Chromium's
// debugging protocol, checks the title bar is right for this OS, and saves a
// screenshot to the path given as the first argument.
import fs from "fs";

const out = process.argv[2] ?? "window.png";

let page;
for (let i = 0; i < 60 && !page; i++) {
  try {
    const targets = await (await fetch("http://127.0.0.1:9333/json")).json();
    page = targets.find((t) => t.type === "page");
  } catch {
    // The app is still starting
  }
  if (!page) await new Promise((r) => setTimeout(r, 1000));
}
if (!page) throw new Error("The app never opened a window on the debugging port");

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
let nextId = 0;
const pending = new Map();
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  pending.get(message.id)?.(message);
};
const send = (method, params = {}) =>
  new Promise((resolve) => {
    pending.set(++nextId, resolve);
    ws.send(JSON.stringify({ id: nextId, method, params }));
  });

// Long enough for the first page to render its data
await new Promise((r) => setTimeout(r, 8000));

const evaluated = await send("Runtime.evaluate", {
  expression: `JSON.stringify({
    title: document.title,
    platform: window.api.platform,
    brand: document.querySelector("header span")?.textContent,
    windowControls: ["Minimize", "Maximize", "Close"].filter(
      (t) => document.querySelector('button[title="' + t + '"]'),
    ),
    status: document.querySelector('[role="status"]')?.getAttribute("aria-label"),
  })`,
  returnByValue: true,
});
const state = JSON.parse(evaluated.result.result.value);
console.log(JSON.stringify(state, null, 2));

const shot = await send("Page.captureScreenshot", { format: "png" });
fs.writeFileSync(out, Buffer.from(shot.result.data, "base64"));
ws.close();

// Windows draws its own window controls; macOS uses its native traffic lights
const expectedControls = process.platform === "darwin" ? 0 : 3;
const problems = [];
if (state.platform !== process.platform) problems.push(`platform is ${state.platform}`);
if (state.title !== "Better Mayhem Tracker") problems.push(`title is ${state.title}`);
if (state.brand !== "Better Mayhem Tracker") problems.push(`header says ${state.brand}`);
if (state.windowControls.length !== expectedControls) {
  problems.push(
    `expected ${expectedControls} window controls, found ${state.windowControls.length}`,
  );
}
if (!state.status) problems.push("no League client status in the header");
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log("Window check passed");
