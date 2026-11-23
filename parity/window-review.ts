/**
 * T10's review media and live checks for the window shell on macOS: the traffic lights, the
 * tray, the app menu, close to tray, Show Window, a second launch, the hidden launch, F12, and
 * every way of quitting.
 *
 *   bun parity/window-review.ts [--data fixture] [--out parity/out/review]
 *
 * Tauri's pictures are drawn in-process by AppKit (`cacheDisplayInRect:`) from the title bar
 * view, over WebKit's snapshot of the page, so nothing reads the screen. Electron's window
 * chrome cannot be captured without Screen Recording, so its side is the page and a model of
 * the traffic light frames: the ones Electron's layout code gives for its
 * `trafficLightPosition`. Every check prints PASS or FAIL and lands in `T10-review.json`.
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PARITY_DIR, REPO_DIR } from "./lib/data.ts";
import { type RunningElectron, startElectron } from "./run-electron.ts";
import { type RunningTauri, startTauri } from "./run-tauri.ts";
import { settle } from "./settle.ts";

interface Frame {
  x: number;
  y: number;
  width: number;
  height: number;
  name?: string;
}

interface Check {
  name: string;
  pass: boolean;
  detail: unknown;
}

const args = process.argv.slice(2);
const value = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const data = value("--data") ?? "fixture";
const out = path.resolve(value("--out") ?? path.join(PARITY_DIR, "out", "review"));
const work = path.join(out, "T10-work");
fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });

const checks: Check[] = [];
const check = (name: string, pass: boolean, detail: unknown) => {
  checks.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${name} ${JSON.stringify(detail)}`);
};
const video: { file: string; caption: string; seconds: number }[] = [];
const file = (name: string) => path.join(work, name);
const FONT = "/System/Library/Fonts/Supplemental/Arial.ttf";
const MONO = "/System/Library/Fonts/Menlo.ttc";
const magick = (...argv: string[]) => execFileSync("magick", argv, { stdio: "pipe" });
/** Electron's side wherever its traffic lights are a model: Screen Recording is not granted. */
const ELECTRON_MODELED = "Electron 1.2.1 (chrome modeled)";

async function tauriPicture(tauri: RunningTauri, target: "titlebar" | "tray", name: string) {
  const response = await tauri.driver.call("shell-shot", { target });
  const meta = JSON.parse(response.headers.get("x-bmt-image")!);
  fs.writeFileSync(file(name), new Uint8Array(await response.arrayBuffer()));
  return { file: file(name), meta };
}

/**
 * What the Tauri window shows: the webview's own snapshot with AppKit's title bar, buttons
 * included, drawn over it where the window places it.
 */
async function tauriShot(tauri: RunningTauri, _target: "window", name: string) {
  const page = file(`${name}.page.png`);
  // WebKit refuses a snapshot until a window shown a moment ago has drawn again
  for (let attempt = 1; ; attempt++) {
    try {
      await tauri.ctx.engine.screenshot(page);
      break;
    } catch (error) {
      if (attempt === 5) throw error;
      await Bun.sleep(500);
    }
  }
  const bar = await tauriPicture(tauri, "titlebar", `${name}.titlebar.png`);
  const [width] = execFileSync("magick", ["identify", "-format", "%w %h", page], {
    encoding: "utf8",
  })
    .trim()
    .split(" ")
    .map(Number);
  const scale = width! / 1280;
  const [x, y] = bar.meta.origin as [number, number];
  magick(
    page,
    "(",
    bar.file,
    "-resize",
    `${bar.meta.points[0] * scale}x${bar.meta.points[1] * scale}!`,
    ")",
    "-geometry",
    `+${x * scale}+${y * scale}`,
    "-composite",
    file(name),
  );
  return { file: file(name), meta: { width: width!, points: [1280, 820], titlebar: bar.meta } };
}

const tauriState = (tauri: RunningTauri) =>
  tauri.driver.json<{
    visible: boolean;
    minimized: boolean;
    maximized: boolean;
    devtoolsOpen: boolean;
    phase: string;
    launchedHidden: boolean;
    tray: { rect: string } | null;
    buttons: Frame[] | null;
  }>("shell-state");

const electronState = (electron: RunningElectron) =>
  electron.app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    return window
      ? {
          visible: window.isVisible(),
          devtoolsOpen: window.webContents.isDevToolsOpened(),
          trafficLightPosition: window.getWindowButtonPosition(),
          frame: window.getBounds(),
        }
      : null;
  });

/** A blank panel the size of a window picture, for a window that is not on screen. */
function absent(name: string, text: string, like: string) {
  const [w, h] = execFileSync("magick", ["identify", "-format", "%w %h", like], {
    encoding: "utf8",
  })
    .trim()
    .split(" ");
  magick(
    "-size",
    `${w}x${h}`,
    "xc:#1b1d24",
    "-fill",
    "#9aa0ac",
    "-pointsize",
    "64",
    "-gravity",
    "center",
    "-font",
    FONT,
    "-annotate",
    "+0+0",
    text,
    file(name),
  );
  return file(name);
}

/**
 * Text set in a fixed box, wrapped to its width, so a long line wraps instead of running off
 * either edge.
 */
const textBox = (width: number, height: number, pointsize: number, text: string) => [
  "(",
  "-size",
  `${width}x${height}`,
  "-background",
  "#0f1115",
  "-fill",
  "#e8e8e8",
  "-font",
  FONT,
  "-pointsize",
  String(pointsize),
  "-gravity",
  "center",
  `caption:${text}`,
  ")",
];

/** Two pictures side by side, each under its label and scaled to `width`. */
function pair(name: string, left: string, right: string, labels: [string, string], width = 960) {
  const scaled = [left, right].map((src, i) => {
    const target = file(`${name}-${i}.png`);
    magick(
      ...textBox(width, 64, 22, labels[i]!),
      "(",
      src,
      "-resize",
      `${width}x`,
      ")",
      "-background",
      "#0f1115",
      "-append",
      target,
    );
    return target;
  });
  magick(
    ...scaled,
    "-background",
    "#0f1115",
    "-gravity",
    "west",
    "-splice",
    "16x0",
    "+append",
    file(name),
  );
  return file(name);
}

/**
 * A 1920x1080 video frame. Every frame is 8-bit RGB: ffmpeg's fps filter drops a frame wherever
 * the input's pixel format changes, and ImageMagick keeps a 16-bit source at 16 bits.
 */
function captioned(name: string, src: string, caption: string) {
  const target = file(name);
  magick(
    ...textBox(1840, 80, 30, caption),
    "-gravity",
    "center",
    "-extent",
    "1920x80",
    "(",
    src,
    "-resize",
    "1920x1000",
    "-background",
    "#0f1115",
    "-gravity",
    "center",
    "-extent",
    "1920x1000",
    ")",
    "-append",
    "-alpha",
    "off",
    "-depth",
    "8",
    `PNG24:${target}`,
  );
  return target;
}

function frame(src: string, caption: string, seconds = 4) {
  const target = captioned(`frame-${String(video.length).padStart(2, "0")}.png`, src, caption);
  video.push({ file: target, caption, seconds });
}

/** Outlines `frames` (in points) on a picture taken at `scale` pixels per point. */
function outline(src: string, target: string, scale: number, sets: [Frame[], string][]) {
  const draws = sets.flatMap(([frames, color]) =>
    frames.flatMap((f) => [
      "-stroke",
      color,
      "-strokewidth",
      "1",
      "-fill",
      "none",
      "-draw",
      `rectangle ${f.x * scale - 0.5},${f.y * scale - 0.5} ${(f.x + f.width) * scale - 0.5},${(f.y + f.height) * scale - 0.5}`,
    ]),
  );
  magick(src, ...draws, target);
}

/**
 * Electron's `WindowButtonsProxy redraw`: the container is the button height plus twice the
 * margin, and each button sits `margin.y` above its bottom, `padding` apart from the left margin.
 */
function electronButtons(position: { x: number; y: number }, size = 14, padding = 9): Frame[] {
  const container = size + 2 * position.y;
  const top = container - position.y - size;
  return ["close", "minimize", "zoom"].map((name, i) => ({
    name,
    x: position.x + i * (size + padding),
    y: top,
    width: size,
    height: size,
  }));
}

interface NativeItem {
  separator?: boolean;
  title?: string;
  key?: string | null;
  modifiers?: string[];
  hidden: boolean;
  alternate?: boolean;
  submenu?: NativeItem[] | null;
}

interface ElectronItem {
  type: string;
  label: string;
  accelerator: string | null;
  visible: boolean;
  submenu: ElectronItem[] | null;
}

/**
 * What AppKit puts in any app's menu on this macOS on its own, which no Electron or Tauri menu
 * code asks for: the Option alternate of Close Window, the Edit menu's tail, and the hidden
 * alternates. Electron's live NSMenu cannot be read here (no in-process access to Electron's
 * AppKit), so these are listed rather than compared.
 */
function appKitAdded(menu: string, item: NativeItem, index: number, items: NativeItem[]) {
  if (item.hidden) return "hidden alternate";
  if (menu === "File" && item.title === "Close All" && item.alternate) return "Option alternate";
  if (menu === "Edit") {
    const tail = ["AutoFill", "Start Dictation…", "Emoji & Symbols"];
    if (item.title && tail.includes(item.title)) return "Edit menu tail";
    if (item.separator && items[index + 1]?.title === "AutoFill") return "Edit menu tail";
  }
  return null;
}

/** Electron's accelerator as an AppKit key equivalent: modifiers and key, lowercased. */
function keyOf(accelerator: string | null) {
  if (!accelerator) return null;
  const parts = accelerator.split("+");
  const key = parts.pop()!;
  const names: Record<string, string> = {
    Command: "Cmd",
    Cmd: "Cmd",
    CommandOrControl: "Cmd",
    CmdOrCtrl: "Cmd",
    Control: "Ctrl",
    Ctrl: "Ctrl",
    Alt: "Alt",
    Option: "Alt",
    Shift: "Shift",
  };
  const order = ["Fn", "Ctrl", "Alt", "Shift", "Cmd"];
  const mods = parts.map((p) => names[p] ?? p).sort((a, b) => order.indexOf(a) - order.indexOf(b));
  // Chromium writes Plus as the = key, the unshifted key it is on
  const char = key === "Plus" ? "=" : key.toLowerCase();
  return `${mods.join("+")}+${char}`;
}

const nativeKey = (item: NativeItem) =>
  item.key
    ? `${(item.modifiers ?? []).join("+")}+${item.key === " " ? "space" : item.key.toLowerCase()}`
    : null;

/**
 * Walks Electron's default menu against the NSMenu AppKit holds, item by item, after setting
 * aside what AppKit adds. Toggle Full Screen is AppKit's too: it shows Fn+F and keeps the
 * Ctrl+Cmd+F the menu asked for as a hidden alternate.
 */
function compareAppMenu(electron: ElectronItem[], native: NativeItem[], menu = "") {
  const added: string[] = [];
  const mismatches: string[] = [];
  const kept = native.filter((item, i) => {
    const why = appKitAdded(menu, item, i, native);
    if (why)
      added.push(
        `${menu} > ${item.separator ? "separator" : item.title} ${nativeKey(item) ?? ""} (${why})`.replace(
          "  ",
          " ",
        ),
      );
    return !why;
  });
  const wanted = electron.filter((item) => item.visible);
  if (wanted.length !== kept.length) {
    mismatches.push(
      `${menu || "menu bar"}: ${wanted.length} items in Electron, ${kept.length} in AppKit`,
    );
  }
  wanted.forEach((e, i) => {
    const n = kept[i];
    if (!n) return;
    const where = `${menu || "menu bar"} #${i}`;
    if (e.type === "separator" || n.separator) {
      if (!(e.type === "separator" && n.separator))
        mismatches.push(`${where}: ${e.label || e.type} vs ${n.title ?? "separator"}`);
      return;
    }
    if (n.title !== e.label)
      mismatches.push(`${where}: title ${JSON.stringify(n.title)} vs ${JSON.stringify(e.label)}`);
    let key = nativeKey(n);
    const want = keyOf(e.accelerator);
    if (key !== want && n.key === "f" && n.modifiers?.join("+") === "Fn") {
      const alternate = native.find(
        (a) => a.hidden && a.title === n.title && nativeKey(a) === want,
      );
      if (alternate) {
        added.push(`${menu} > ${n.title} shows Fn+f, keeps ${want} as a hidden alternate (AppKit)`);
        key = want;
      }
    }
    if (key !== want) mismatches.push(`${where} ${e.label}: key ${key} vs ${want}`);
    if (e.submenu || n.submenu) {
      const sub = compareAppMenu(e.submenu ?? [], n.submenu ?? [], e.label);
      added.push(...sub.added);
      mismatches.push(...sub.mismatches);
    }
  });
  return { added, mismatches };
}

/** JSON with keys sorted, since the Rust dump and Electron's order keys differently. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}

function textPanel(name: string, text: string) {
  magick(
    "-size",
    "1100x420",
    "xc:#1b1d24",
    "-fill",
    "#e8e8e8",
    "-font",
    MONO,
    "-pointsize",
    "30",
    "-annotate",
    "+40+70",
    text,
    file(name),
  );
  return file(name);
}

function waitExit(child: ChildProcess, ms: number) {
  return new Promise<number | null | "timeout">((resolve) => {
    if (child.exitCode !== null) return resolve(child.exitCode);
    const timer = setTimeout(() => resolve("timeout"), ms);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

const logTail = (tauri: RunningTauri) =>
  fs.readFileSync(path.join(tauri.runDir, "tauri.log"), "utf8").trim().split("\n").slice(-4);

const dataRoot = (name: string) => {
  const root = path.join(work, "roots", name);
  fs.mkdirSync(root, { recursive: true });
  return root;
};

async function startTauriHere(name: string, extra: Partial<Parameters<typeof startTauri>[0]> = {}) {
  return startTauri({
    data,
    renderer: "electron",
    runDir: path.join(work, "runs", name),
    ...extra,
    env: { BMT_DATA_ROOT: dataRoot(name), ...extra.env },
  });
}

const electron = await startElectron({ data, runDir: path.join(work, "runs", "electron") });
const tauri = await startTauriHere("tauri");
const viewport = { width: 1280, height: 820 };
try {
  await settle(electron.ctx.engine, viewport);
  await settle(tauri.ctx.engine, viewport);

  // Traffic lights
  const eState = (await electronState(electron))!;
  const eFrames = electronButtons(eState.trafficLightPosition);
  const tState = await tauriState(tauri);
  const tFrames = tState.buttons ?? [];
  const deltas = tFrames.map((t, i) => ({
    name: t.name,
    dx: t.x - eFrames[i]!.x,
    dy: t.y - eFrames[i]!.y,
    dw: t.width - eFrames[i]!.width,
    dh: t.height - eFrames[i]!.height,
  }));
  check(
    "traffic lights sit on Electron's frames within 0.5 pt",
    tFrames.length === 3 &&
      deltas.every((d) =>
        Object.values(d).every((v) => typeof v === "string" || Math.abs(v) <= 0.5),
      ),
    { electron: eFrames, tauri: tFrames },
  );

  await electron.ctx.engine.screenshot(file("electron-page.png"));
  const tWindow = await tauriShot(tauri, "window", "tauri-window.png");
  const scale = tWindow.meta.width / tWindow.meta.points[0];
  const tInfo = await tauri.driver.json<{ inner: [number, number] }>("info");
  tWindow.meta.points = tInfo.inner;
  check(
    "Tauri window frame matches Electron's",
    tWindow.meta.points[0] === eState.frame.width && tWindow.meta.points[1] === eState.frame.height,
    {
      tauri: tWindow.meta.points,
      electron: [eState.frame.width, eState.frame.height],
    },
  );
  const crop = (src: string, target: string, w: number, h: number) =>
    magick(src, "-crop", `${w * scale}x${h * scale}+0+0`, "+repage", target);
  crop(file("electron-page.png"), file("electron-tl.png"), 120, 44);
  crop(tWindow.file, file("tauri-tl.png"), 120, 44);
  outline(file("electron-tl.png"), file("electron-tl-marked.png"), scale, [[eFrames, "#ff4040"]]);
  outline(file("tauri-tl.png"), file("tauri-tl-marked.png"), scale, [
    [eFrames, "#ff4040"],
    [tFrames, "#40ff80"],
  ]);
  for (const name of ["electron-tl-marked", "tauri-tl-marked"]) {
    magick(file(`${name}.png`), "-filter", "point", "-resize", "400%", file(`${name}-big.png`));
  }
  const tl = pair(
    "traffic-lights.png",
    file("electron-tl-marked-big.png"),
    file("tauri-tl-marked-big.png"),
    [
      `${ELECTRON_MODELED}: page only; red = the frames trafficLightPosition {16,15} gives`,
      "Tauri (T10): webview + AppKit title bar; green = measured, red = Electron's",
    ],
  );
  fs.copyFileSync(tl, path.join(out, "T10-review-traffic-lights.png"));
  outline(file("electron-page.png"), file("electron-page-modeled.png"), scale, [
    [eFrames, "#ff4040"],
  ]);
  crop(file("electron-page-modeled.png"), file("electron-strip.png"), 1280, 60);
  crop(tWindow.file, file("tauri-strip.png"), 1280, 60);
  const stripWidth = 1280 * scale;
  magick(
    ...textBox(stripWidth, 56, 32, `${ELECTRON_MODELED}: page, red = modeled traffic lights`),
    file("electron-strip.png"),
    ...textBox(stripWidth, 56, 32, "Tauri (T10): webview + AppKit title bar"),
    file("tauri-strip.png"),
    "-background",
    "#0f1115",
    "-append",
    path.join(out, "T10-review-title-bar.png"),
  );
  frame(
    pair("launch.png", file("electron-page-modeled.png"), tWindow.file, [
      `${ELECTRON_MODELED}: red = its traffic light frames`,
      "Tauri (T10)",
    ]),
    "Launch: the header doubles as the title bar, traffic lights inset at 16,15",
    5,
  );
  frame(
    tl,
    "Traffic lights, 4x: green (Tauri, measured) covers red (Electron's modeled frames)",
    5,
  );

  // Tray
  const menus = await tauri.driver.json<{ tray: any; appMenu: any }>("shell-menus");
  const baselineDir = path.join(PARITY_DIR, "out", "baseline");
  const eTray = JSON.parse(fs.readFileSync(path.join(baselineDir, "tray-menu.json"), "utf8"));
  const eApp = JSON.parse(fs.readFileSync(path.join(baselineDir, "app-menu.json"), "utf8"));
  fs.writeFileSync(file("tray-menu.json"), JSON.stringify(menus.tray, null, 1));
  fs.writeFileSync(file("app-menu.json"), JSON.stringify(menus.appMenu, null, 1));
  check(
    "tray menu items equal Electron's dump",
    canonical(menus.tray.items) === canonical(eTray.items),
    menus.tray.items.map((i: any) => i.label || i.type),
  );
  check("tray tooltip", menus.tray.tooltip === eTray.tooltip, menus.tray.tooltip);
  const productName = (text: string) =>
    text.replaceAll("better-mayhem-tracker", "Better Mayhem Tracker");
  const native = await tauri.driver.json<NativeItem[]>("shell-native-menu");
  fs.writeFileSync(file("app-menu-native.json"), JSON.stringify(native, null, 1));
  const menuCompare = compareAppMenu(JSON.parse(productName(JSON.stringify(eApp.menu))), native);
  fs.writeFileSync(file("app-menu-compare.json"), JSON.stringify(menuCompare, null, 1));
  check(
    "app menu as AppKit holds it equals Electron's default menu, beside AppKit's own items",
    menuCompare.mismatches.length === 0,
    menuCompare,
  );
  frame(
    textPanel(
      "app-menu.png",
      `App menu, read back from AppKit's NSMenu\n\nequal to Electron's default menu: ${menuCompare.mismatches.length === 0}\n\nAppKit adds on its own: Close All,\nAutoFill, Start Dictation, Emoji & Symbols,\nFn+F on Toggle Full Screen`,
    ),
    "App menu: AppKit's live menu equals Electron's default menu item for item",
    4,
  );
  // The status item button as AppKit draws it, and Electron's file at the 16 pt it draws it
  const trayIcon = (await tauriPicture(tauri, "tray", "tauri-tray.png")).file;
  const [iconW, iconH] = execFileSync("magick", [trayIcon, "-trim", "-format", "%w %h", "info:"], {
    encoding: "utf8",
  })
    .split(" ")
    .map(Number);
  check(
    "tray icon draws at 16 pt, as Electron's tray.png",
    iconW === 32 && iconH! >= 30 && iconH! <= 32,
    {
      pixels: [iconW, iconH],
    },
  );
  const iconPanel = (name: string, src: string) => {
    magick(src, "-filter", "point", "-resize", "600%", file(`${name}-big.png`));
    return file(`${name}-big.png`);
  };
  magick(
    "-size",
    "68x44",
    "xc:none",
    path.join(REPO_DIR, "assets", "tray@2x.png"),
    "-gravity",
    "center",
    "-composite",
    file("electron-tray.png"),
  );
  const menuText = (dump: any) =>
    [
      `tooltip: ${dump.tooltip}`,
      ...dump.items.map((i: any) => (i.type === "separator" ? "  ----------" : `  ${i.label}`)),
      `double-click: ${dump.interaction.doubleClick.registered ? dump.interaction.doubleClick.calls.join(" + ") : "not reported"}`,
    ].join("\n");
  const withIcon = (name: string, text: string, icon: string) => {
    magick(
      textPanel(`${name}-text.png`, text),
      icon,
      "-gravity",
      "east",
      "-geometry",
      "+40+0",
      "-composite",
      file(`${name}.png`),
    );
    return file(`${name}.png`);
  };
  const trayPanel = pair(
    "tray.png",
    withIcon(
      "electron-tray-panel",
      menuText(eTray),
      iconPanel("electron-tray", file("electron-tray.png")),
    ),
    withIcon("tauri-tray-panel", menuText(menus.tray), iconPanel("tauri-tray", trayIcon)),
    [
      "Electron 1.2.1: T04's menu dump, assets/tray@2x.png at 16 pt",
      "Tauri (T10): live menu, the status item as AppKit draws it",
    ],
    1100,
  );
  fs.copyFileSync(trayPanel, path.join(out, "T10-review-tray.png"));
  frame(trayPanel, "Tray: Show Window, separator, Quit; macOS opens it on a left click", 4);

  // Close to tray, then Show Window
  await electron.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
  await tauri.engine.evaluate(() => (window as any).__TAURI_INTERNALS__.invoke("window:close"));
  await Bun.sleep(600);
  const eClosed = (await electronState(electron))!;
  const tClosed = await tauriState(tauri);
  check(
    "close hides to the tray in both",
    !eClosed.visible && !tClosed.visible && tClosed.phase === "Running",
    {
      electron: eClosed.visible,
      tauri: tClosed,
    },
  );
  const hiddenPair = pair(
    "closed.png",
    absent(
      "electron-hidden.png",
      "hidden to the tray\nisVisible() = false",
      file("electron-page.png"),
    ),
    absent("tauri-hidden.png", "hidden to the tray\nis_visible() = false", tWindow.file),
    ["Electron 1.2.1 after close", "Tauri (T10) after close"],
  );
  frame(
    hiddenPair,
    "Close: minimize_to_tray is on, so the window hides and the app keeps running",
    3,
  );

  // Electron's Show Window handler is show then focus (T04's probe); Tauri runs its own item
  await electron.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.show());
  await tauri.driver.json("shell-tray", { action: "tray-show-window" });
  await Bun.sleep(800);
  const eShown = (await electronState(electron))!;
  const tShown = await tauriState(tauri);
  check("Show Window brings it back", eShown.visible && tShown.visible, {
    electron: eShown.visible,
    tauri: tShown.visible,
  });
  await electron.ctx.engine.screenshot(file("electron-shown.png"));
  outline(file("electron-shown.png"), file("electron-shown-modeled.png"), scale, [
    [eFrames, "#ff4040"],
  ]);
  const tBack = await tauriShot(tauri, "window", "tauri-shown.png");
  const back = pair("shown.png", file("electron-shown-modeled.png"), tBack.file, [
    `${ELECTRON_MODELED} after Show Window`,
    "Tauri (T10) after Show Window",
  ]);
  magick(
    file("closed.png"),
    back,
    "-background",
    "#0f1115",
    "-splice",
    "0x24",
    "-append",
    path.join(out, "T10-review-close-to-tray.png"),
  );
  frame(back, "Tray > Show Window: the window comes back", 3);

  // A second launch hands over and exits 0
  await tauri.engine.evaluate(() => (window as any).__TAURI_INTERNALS__.invoke("window:close"));
  await Bun.sleep(500);
  const secondOut = file("second-launch.out");
  const outFd = fs.openSync(secondOut, "w");
  const second = spawn(tauri.facts.binary as string, tauri.args, {
    cwd: tauri.runDir,
    env: tauri.env,
    stdio: ["ignore", outFd, outFd],
  });
  const secondCode = await waitExit(second, 20_000);
  fs.closeSync(outFd);
  await Bun.sleep(800);
  const afterSecond = await tauriState(tauri);
  const secondWrote = fs.readFileSync(secondOut, "utf8");
  const firstLog = fs.readFileSync(path.join(tauri.runDir, "tauri.log"), "utf8");
  check(
    "a second launch exits 0 and shows the first window",
    secondCode === 0 && afterSecond.visible,
    {
      code: secondCode,
      firstVisible: afterSecond.visible,
    },
  );
  check(
    "a second launch writes no log line, in its own output or the first's log",
    secondWrote === "" &&
      !firstLog.includes(`[bmt pid=${second.pid}]`) &&
      firstLog.split("\n").filter((l) => l.includes("first instance started")).length === 1,
    { secondPid: second.pid, secondOutput: secondWrote },
  );
  fs.writeFileSync(
    path.join(out, "second-launch.log"),
    `second launch pid ${second.pid} exited ${secondCode}, wrote ${JSON.stringify(secondWrote)}\n` +
      `first window visible after: ${afterSecond.visible}\n`,
  );
  frame(
    pair(
      "second.png",
      absent("second-hidden.png", "window in the tray", tWindow.file),
      (await tauriShot(tauri, "window", "tauri-second.png")).file,
      [
        "Tauri (T10) before: hidden",
        `Tauri (T10): second launch exited ${secondCode}; the first window shows`,
      ],
    ),
    "Second launch: it hands over to the running app and exits 0",
    3,
  );

  // F12
  await electron.page.keyboard.press("F12");
  await tauri.engine.press("F12");
  // The inspector opens and closes on its own schedule, slower on a loaded machine
  const devtoolsReach = async (open: boolean) => {
    for (let waited = 0; ; waited += 250) {
      const state = await tauriState(tauri);
      if (state.devtoolsOpen === open || waited >= 5_000) return state;
      await Bun.sleep(250);
    }
  };
  const tDev = await devtoolsReach(true);
  const eDev = (await electronState(electron))!;
  check("F12 opens the devtools", tDev.devtoolsOpen, {
    electron: eDev.devtoolsOpen,
    tauri: tDev.devtoolsOpen,
  });
  await tauri.engine.press("F12");
  await electron.page.keyboard.press("F12");
  const tDevClosed = await devtoolsReach(false);
  check("F12 again closes them", !tDevClosed.devtoolsOpen, tDevClosed.devtoolsOpen);
  frame(
    textPanel(
      "devtools.png",
      `F12\n\nTauri:    devtools open = ${tDev.devtoolsOpen}\nElectron: devtools open = ${eDev.devtoolsOpen}\n  (Playwright's key never reaches\n   before-input-event)\n\nF12 again\nTauri:    devtools open = ${tDevClosed.devtoolsOpen}`,
    ),
    "F12 toggles Tauri's devtools; Playwright's synthetic F12 never reaches Electron's before-input-event, so Electron reads false",
    4,
  );

  // Quit from the tray with a final fetch that never answers: bounded at 5 s
} finally {
  await electron.close();
  await tauri.close();
}

{
  const stuck = await startTauriHere("quit", { env: { BMT_PARITY_FINAL_FETCH_MS: "60000" } });
  await settle(stuck.ctx.engine, viewport);
  const started = Date.now();
  await stuck.driver.json("shell-tray", { action: "tray-quit" }).catch(() => {});
  const code = await waitExit(stuck.child, 15_000);
  const seconds = (Date.now() - started) / 1000;
  const tail = logTail(stuck);
  check(
    "tray Quit waits on a hung final fetch for 5 s, then exits 0",
    code === 0 &&
      seconds >= 4.9 &&
      seconds < 6.5 &&
      tail.some((l) => l.includes("Final fetch on quit failed: Error: timed out")) &&
      tail.at(-1)!.endsWith("Shutting down"),
    { code, seconds, tail },
  );
  fs.copyFileSync(path.join(stuck.runDir, "tauri.log"), path.join(out, "quit-final-fetch.log"));
  frame(
    textPanel(
      "quit.png",
      `Tray > Quit, final fetch stand-in hangs 60 s\n\nexit code ${code} after ${seconds.toFixed(2)} s\n\n${tail.map((l) => l.replace(/^\[bmt pid=\d+\] /, "")).join("\n")}`,
    ),
    "Quit: the final fetch is capped at 5 s, then Shutting down and exit 0",
    4,
  );
}

{
  const quits = await startTauriHere("close-quits", {
    env: { BMT_PARITY_MINIMIZE_TO_TRAY: "false" },
  });
  await settle(quits.ctx.engine, viewport);
  await quits.engine
    .evaluate(() => (window as any).__TAURI_INTERNALS__.invoke("window:close"))
    .catch(() => {});
  const code = await waitExit(quits.child, 15_000);
  const tail = logTail(quits);
  check(
    "close with minimize_to_tray false quits, log ends Shutting down",
    code === 0 && tail.at(-1)!.endsWith("Shutting down"),
    { code, tail },
  );
  fs.copyFileSync(path.join(quits.runDir, "tauri.log"), path.join(out, "close-quits.log"));
  frame(
    textPanel(
      "close-quits.png",
      `minimize_to_tray = "false", close the window\n\nexit code ${code}\n\n${tail.map((l) => l.replace(/^\[bmt pid=\d+\] /, "")).join("\n")}`,
    ),
    "Close with minimize_to_tray off: the app quits",
    3,
  );
}

const lines = (tauri: RunningTauri) =>
  fs
    .readFileSync(path.join(tauri.runDir, "tauri.log"), "utf8")
    .split("\n")
    .filter((l) => /^\[bmt pid=|^\[parity\]/.test(l))
    .map((l) => l.replace(/^\[bmt pid=\d+\] /, ""));

/** The lines a quit through the final fetch logs, in Electron's order. */
function quitOrder(log: string[], fetch: "finished" | "timed out" | "none") {
  const at = (text: string) => log.findIndex((l) => l.includes(text));
  const shutdown = at("Shutting down");
  if (shutdown !== log.length - 1) return false;
  if (fetch === "none") return at("Fetching games before quit...") === -1;
  const fetching = at("Fetching games before quit...");
  const settled =
    fetch === "finished"
      ? at("stand-in final fetch finished")
      : at("Final fetch on quit failed: Error: timed out");
  return fetching !== -1 && fetching < settled && settled < shutdown;
}

{
  // Electron's close is not prevented here, so its window goes at once while the fetch runs
  const quits = await startTauriHere("close-quits-client", {
    env: { BMT_PARITY_MINIMIZE_TO_TRAY: "false", BMT_PARITY_FINAL_FETCH_MS: "3000" },
  });
  await settle(quits.ctx.engine, viewport);
  const started = Date.now();
  await quits.engine
    .evaluate(() => (window as any).__TAURI_INTERNALS__.invoke("window:close"))
    .catch(() => {});
  const right = await tauriState(quits);
  const rightMs = Date.now() - started;
  const code = await waitExit(quits.child, 15_000);
  const seconds = (Date.now() - started) / 1000;
  const log = lines(quits);
  check(
    "close with the setting false and a client hides the window at once, then quits through the fetch",
    !right.visible && right.phase === "FinalFetch" && code === 0 && quitOrder(log, "finished"),
    { afterMs: rightMs, visible: right.visible, phase: right.phase, code, seconds, log },
  );
  fs.copyFileSync(path.join(quits.runDir, "tauri.log"), path.join(out, "close-quits-client.log"));
  frame(
    textPanel(
      "close-quits-client.png",
      `minimize_to_tray = "false", client connected, close\n\n${rightMs} ms later: visible ${right.visible}, ${right.phase}\nexit ${code} after ${seconds.toFixed(2)} s\n\n${log.slice(-3).join("\n")}`,
    ),
    "Close with the setting off and a client: the window goes at once, the fetch runs, then exit",
    4,
  );
}

/** AppKit's terminate:, which the Dock's Quit and logout send, scheduled on the run loop. */
async function dockQuit(name: string, fetchMs: number, fetch: "finished" | "timed out") {
  const app = await startTauriHere(name, { env: { BMT_PARITY_FINAL_FETCH_MS: String(fetchMs) } });
  await settle(app.ctx.engine, viewport);
  const started = Date.now();
  await app.driver.json("shell-terminate");
  const code = await waitExit(app.child, 15_000);
  const seconds = (Date.now() - started) / 1000;
  const log = lines(app);
  const bound = fetch === "timed out" ? seconds >= 4.9 && seconds < 6.5 : seconds < 4;
  check(
    `terminate: (Dock Quit, logout) runs the final fetch (${fetch}), then Shutting down and exit 0`,
    code === 0 && bound && quitOrder(log, fetch),
    { code, seconds, log },
  );
  fs.copyFileSync(path.join(app.runDir, "tauri.log"), path.join(out, `${name}.log`));
  return { code, seconds, log };
}

{
  const hung = await dockQuit("dock-quit-hung", 60_000, "timed out");
  const quick = await dockQuit("dock-quit", 1_000, "finished");
  frame(
    textPanel(
      "dock-quit.png",
      `AppKit terminate: (Dock Quit, logout)\n\nfetch answers in 1 s: exit ${quick.code} after ${quick.seconds.toFixed(2)} s\nfetch hangs: exit ${hung.code} after ${hung.seconds.toFixed(2)} s\n\n${hung.log.slice(-3).join("\n")}`,
    ),
    "Dock Quit and logout: NSTerminateLater while the final fetch runs, then exit 0",
    5,
  );
}

/** A real signal to the process, as `kill` and a system shutdown send. */
async function signalQuit(name: string, signal: NodeJS.Signals, fetchMs?: number) {
  const app = await startTauriHere(name, {
    env: fetchMs ? { BMT_PARITY_FINAL_FETCH_MS: String(fetchMs) } : {},
  });
  await settle(app.ctx.engine, viewport);
  const started = Date.now();
  process.kill(app.child.pid!, signal);
  const code = await waitExit(app.child, 15_000);
  const seconds = (Date.now() - started) / 1000;
  const log = lines(app);
  const fetch = fetchMs ? "finished" : "none";
  check(
    `${signal} quits through the ${fetchMs ? "final fetch" : "quit path"}, exit 0, log ends Shutting down`,
    code === 0 && app.child.signalCode === null && quitOrder(log, fetch),
    { code, signal: app.child.signalCode, seconds, log },
  );
  fs.copyFileSync(path.join(app.runDir, "tauri.log"), path.join(out, `${name}.log`));
  return { code, seconds, log };
}

{
  const term = await signalQuit("sigterm", "SIGTERM", 1_000);
  const int = await signalQuit("sigint", "SIGINT");
  frame(
    textPanel(
      "signals.png",
      `SIGTERM, client connected: exit ${term.code} after ${term.seconds.toFixed(2)} s\nSIGINT, no client:        exit ${int.code} after ${int.seconds.toFixed(2)} s\n\n${term.log.slice(-3).join("\n")}`,
    ),
    "SIGTERM and SIGINT quit as Electron's app.quit() does: fetch, Shutting down, exit 0",
    4,
  );
}

{
  const hidden = await startTauriHere("hidden", { args: ["--hidden"] });
  await Bun.sleep(1000);
  const state = await tauriState(hidden);
  check(
    "--hidden starts with no window and a tray icon",
    !state.visible && state.launchedHidden && state.tray !== null,
    state,
  );
  fs.writeFileSync(path.join(out, "hidden-launch.log"), JSON.stringify(state, null, 1));
  frame(
    textPanel(
      "hidden.png",
      `launched with --hidden\n\nwindow visible: ${state.visible}\ntray icon: ${state.tray ? "present" : "missing"}`,
    ),
    "--hidden (the login item): the app comes up in the tray only",
    3,
  );
  await hidden.close();
}

fs.writeFileSync(path.join(out, "T10-review.json"), JSON.stringify(checks, null, 1));
fs.writeFileSync(
  path.join(work, "frames.txt"),
  video.map((f) => `file '${f.file}'\nduration ${f.seconds}`).join("\n") + "\n",
);
// Each still is its own looped input cut to its length, so every frame plays for exactly its
// seconds; the concat demuxer stretched the last one
execFileSync("ffmpeg", [
  "-y",
  "-loglevel",
  "error",
  ...video.flatMap((f) => [
    "-loop",
    "1",
    "-framerate",
    "30",
    "-t",
    String(f.seconds),
    "-i",
    f.file,
  ]),
  "-filter_complex",
  `${video.map((_, i) => `[${i}:v]`).join("")}concat=n=${video.length}:v=1:a=0,format=yuv420p[v]`,
  "-map",
  "[v]",
  "-c:v",
  "libx264",
  path.join(out, "T10-review.mp4"),
]);
const total = video.reduce((sum, f) => sum + f.seconds, 0);
console.log(
  `wrote ${out}/T10-review-*.png and T10-review.mp4 (${total} s, ${video.length} frames)`,
);
const failed = checks.filter((c) => !c.pass);
console.log(`${checks.length - failed.length} pass, ${failed.length} fail`);
process.exit(failed.length ? 1 : 0);
