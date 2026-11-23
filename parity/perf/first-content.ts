/** First Match History row in `parity/states.ts` (`match-history-default`). A test keeps them equal. */
export const MATCH_ROW_SELECTOR = "button.group.relative.flex.w-full";

const now = () => performance.timeOrigin + performance.now();
export const wallClockMs = now;

/**
 * Injected before any page script runs. `row` is when the element is in the DOM with a
 * box, which a covered window cannot hold back. `frames` is two animation frames later,
 * which it can.
 */
export function watchScript(selector: string): string {
  return `(() => {
    if (window.__bmtPerf) return;
    const record = (window.__bmtPerf = {});
    const stamp = () => performance.timeOrigin + performance.now();
    const check = () => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      const box = el.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) return false;
      record.row = stamp();
      record.text = el.innerText.slice(0, 300);
      record.visibility = document.visibilityState;
      requestAnimationFrame(() => requestAnimationFrame(() => { record.frames = stamp(); }));
      return true;
    };
    if (check()) { record.immediate = true; return; }
    const observer = new MutationObserver(() => { if (check()) observer.disconnect(); });
    observer.observe(document, { childList: true, subtree: true });
  })()`;
}

type Pending = { resolve: (value: any) => void; reject: (error: Error) => void };

export class Cdp {
  private ws!: WebSocket;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  readonly events: Array<(method: string, params: any, sessionId?: string) => void> = [];

  static async connect(url: string): Promise<Cdp> {
    const cdp = new Cdp();
    cdp.ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      cdp.ws.onopen = () => resolve();
      cdp.ws.onerror = () => reject(new Error(`websocket ${url} failed`));
    });
    cdp.ws.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== undefined) {
        const pending = cdp.pending.get(message.id);
        cdp.pending.delete(message.id);
        if (message.error) pending?.reject(new Error(message.error.message));
        else pending?.resolve(message.result);
      } else
        for (const listener of cdp.events)
          listener(message.method, message.params, message.sessionId);
    };
    return cdp;
  }

  send(method: string, params: object = {}, sessionId?: string): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  close() {
    this.ws.close();
  }
}

async function browserEndpoint(port: number, deadline: number): Promise<string> {
  while (now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      return ((await response.json()) as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl;
    } catch {
      await Bun.sleep(5);
    }
  }
  throw new Error(`no DevTools endpoint on ${port}`);
}

export interface ElectronFirstContent {
  /** ms from spawn to the row in the DOM with a box */
  domMs: number;
  /** ms from spawn to two animation frames after that, or null when the window never painted */
  framesMs: number | null;
  rowText: string;
  visibility: string;
  hasFocus: boolean;
  /** The row was already there when the probe attached, so domMs is an upper bound. */
  lateAttach: boolean;
}

/**
 * Attaches to every page the app opens before its scripts run, then polls for the row.
 * `spawnedAtMs` is `wallClockMs()` just before the process spawned.
 */
export async function measureElectronFirstContent(options: {
  port: number;
  spawnedAtMs: number;
  selector?: string;
  timeoutMs?: number;
  frameWaitMs?: number;
}): Promise<ElectronFirstContent> {
  const selector = options.selector ?? MATCH_ROW_SELECTOR;
  const deadline = options.spawnedAtMs + (options.timeoutMs ?? 30_000);
  const cdp = await Cdp.connect(await browserEndpoint(options.port, deadline));
  const source = watchScript(selector);
  const sessions = new Set<string>();

  const inject = async (sessionId: string, waiting: boolean) => {
    sessions.add(sessionId);
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source }, sessionId).catch(() => {});
    if (!waiting) {
      await cdp.send("Runtime.evaluate", { expression: source }, sessionId).catch(() => {});
    }
    if (waiting) await cdp.send("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(() => {});
  };
  cdp.events.push((method, params) => {
    if (method !== "Target.attachedToTarget") return;
    if (params.targetInfo.type === "page") void inject(params.sessionId, params.waitingForDebugger);
    else if (params.waitingForDebugger) {
      void cdp.send("Runtime.runIfWaitingForDebugger", {}, params.sessionId).catch(() => {});
    }
  });
  await cdp.send("Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
  });
  const existing = (await cdp.send("Target.getTargets")) as {
    targetInfos: Array<{ targetId: string; type: string; attached: boolean }>;
  };
  for (const target of existing.targetInfos) {
    if (target.type !== "page" || target.attached) continue;
    const { sessionId } = await cdp.send("Target.attachToTarget", {
      targetId: target.targetId,
      flatten: true,
    });
    await inject(sessionId, false);
  }

  const read = async (sessionId: string) => {
    const result = await cdp
      .send(
        "Runtime.evaluate",
        {
          expression:
            "JSON.stringify({ perf: window.__bmtPerf || null, visibility: document.visibilityState, focus: document.hasFocus() })",
        },
        sessionId,
      )
      .catch(() => null);
    return result?.result?.value
      ? (JSON.parse(result.result.value) as {
          perf: { row?: number; frames?: number; text?: string; visibility?: string } | null;
          visibility: string;
          focus: boolean;
        })
      : null;
  };

  try {
    let found: { perf: any; visibility: string; focus: boolean } | null = null;
    while (now() < deadline && !found) {
      for (const sessionId of sessions) {
        const state = await read(sessionId);
        if (state?.perf?.row !== undefined) {
          found = state as typeof found;
          break;
        }
      }
      if (!found) await Bun.sleep(20);
    }
    if (!found) throw new Error(`no ${selector} within ${options.timeoutMs ?? 30_000} ms`);

    const frameDeadline = now() + (options.frameWaitMs ?? 1500);
    let latest = found;
    while (latest.perf.frames === undefined && now() < frameDeadline) {
      await Bun.sleep(25);
      for (const sessionId of sessions) {
        const state = await read(sessionId);
        if (state?.perf?.row === found.perf.row) latest = state as typeof found;
      }
    }
    return {
      domMs: found.perf.row - options.spawnedAtMs,
      framesMs: latest.perf.frames === undefined ? null : latest.perf.frames - options.spawnedAtMs,
      rowText: String(found.perf.text ?? ""),
      visibility: String(found.perf.visibility ?? found.visibility),
      hasFocus: latest.focus,
      lateAttach: Boolean(found.perf.immediate),
    };
  } finally {
    cdp.close();
  }
}

export interface TimedLine {
  atMs: number;
  text: string;
}

export interface TauriFirstContent {
  /** ms from spawn to the line reaching the probe */
  arrivedMs: number;
  /** ms the app reported against its own start */
  reportedMs: number;
  /** The first row's text, from `row=` on the line, or null when the line has none. */
  rowText: string | null;
}

/**
 * With `BMT_PERF=1` the Tauri build logs `first-content N ms` once the first Match History
 * row is painted, on stdout and in `BMT_PERF_LOG`. A run proves it opened the fixture copy
 * only if the line ends with `row=` and the row's text as a JSON string.
 */
export function parseTauriLines(lines: TimedLine[], spawnedAtMs: number): TauriFirstContent | null {
  for (const line of lines) {
    const match = /\bfirst-content (\d+(?:\.\d+)?) ms\b(?:.*\brow=(".*"))?/.exec(line.text);
    if (!match) continue;
    let rowText: string | null;
    try {
      rowText = match[2] === undefined ? null : String(JSON.parse(match[2]));
    } catch {
      rowText = null;
    }
    return { arrivedMs: line.atMs - spawnedAtMs, reportedMs: Number(match[1]), rowText };
  }
  return null;
}
