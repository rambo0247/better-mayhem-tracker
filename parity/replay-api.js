// A stand-in for the Electron preload's `window.api` that answers from the T05 IPC goldens
// (parity/goldens/FORMAT.md), so Electron's own built renderer runs inside the Tauri webview
// before any Rust command exists. `run-tauri.ts` puts the bundle in `__BMT_REPLAY__` ahead
// of this script in the webview's initialization script, which runs before any page script.
(function install(root) {
  const STORE_KEY = "__bmtReplay";

  // canon.ts's canonicalize without clock masking, which call arguments never need
  const sortKeys = (value) => {
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value))
      return value.map((item) => (item === undefined ? null : sortKeys(item)));
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) out[key] = sortKeys(value[key]);
    }
    return out;
  };
  const canonical = (value) => JSON.stringify(sortKeys(value === undefined ? null : value));

  // A trailing undefined is not recorded (FORMAT.md, `args`)
  const recordedArgs = (args) => {
    const out = [...args];
    while (out.length > 0 && out[out.length - 1] === undefined) out.pop();
    return out;
  };

  class ReplayMiss extends Error {
    constructor(method, args) {
      super(`ReplayMiss: ${method}(${JSON.stringify(args)})`);
      this.name = "ReplayMiss";
    }
  }

  const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

  function answer(outcome) {
    if (outcome.kind === "error") throw new Error(outcome.invokeMessage);
    if (outcome.kind === "void") return undefined;
    return clone(outcome.result);
  }

  /**
   * @param bundle { platform, locale, methods: {method: channel}, events: {method: event},
   *   goldens: {channel: [{case, group, seq, args, outcome}]}, emit?: [{event, payload}] }
   * @param storage Where settings written and write-group cursors live, so they survive the
   *   reload every state does. sessionStorage in the webview.
   */
  function createReplayApi(bundle, storage) {
    const saved = storage?.getItem(STORE_KEY);
    const state = saved ? JSON.parse(saved) : { settings: {}, cursors: {} };
    const save = () => storage?.setItem(STORE_KEY, JSON.stringify(state));
    const misses = [];

    // Exact arguments first, the read group before write groups, then the case named default
    function find(channel, args) {
      const cases = bundle.goldens[channel] ?? [];
      const key = canonical(args);
      const exact = cases
        .filter((c) => canonical(c.args) === key)
        .sort(
          (a, b) => (a.group === "read" ? 0 : 1) - (b.group === "read" ? 0 : 1) || a.seq - b.seq,
        );
      if (exact.length > 0 && exact[0].group === "read") return exact[0];
      if (exact.length > 0) {
        const cursorKey = `${channel}|${key}`;
        const at = Math.min(state.cursors[cursorKey] ?? 0, exact.length - 1);
        state.cursors[cursorKey] = at + 1;
        save();
        return exact[at];
      }
      return cases.find((c) => c.case === "default");
    }

    function request(method, channel) {
      return async (...called) => {
        const args = recordedArgs(called);
        if (method === "getSetting" && Object.hasOwn(state.settings, args[0])) {
          return state.settings[args[0]];
        }
        let golden = find(channel, args);
        if (!golden && method === "setSetting") {
          golden = (bundle.goldens[channel] ?? []).find(
            (c) => c.args[0] === args[0] && c.outcome.kind !== "error",
          );
        }
        if (!golden) {
          const miss = new ReplayMiss(method, args);
          misses.push(miss.message);
          throw miss;
        }
        const result = answer(golden.outcome);
        if (method === "setSetting") {
          state.settings[args[0]] = args[1];
          save();
        }
        return result;
      };
    }

    const listeners = new Map();
    const emitted = new Set();
    function subscribe(event) {
      return (callback) => {
        const set = listeners.get(event) ?? new Set();
        listeners.set(event, set);
        set.add(callback);
        if (!emitted.has(event)) {
          emitted.add(event);
          const lines = (bundle.emit ?? []).filter((line) => line.event === event);
          setTimeout(() => {
            for (const line of lines) for (const listener of set) listener(clone(line.payload));
          }, 0);
        }
        return () => {
          set.delete(callback);
        };
      };
    }

    const api = { platform: bundle.platform, locale: bundle.locale };
    for (const [method, channel] of Object.entries(bundle.methods)) {
      api[method] = request(method, channel);
    }
    for (const [method, event] of Object.entries(bundle.events)) api[method] = subscribe(event);
    Object.defineProperty(api, "__misses", { value: misses });
    return api;
  }

  root.createBmtReplayApi = createReplayApi;
  if (root.__BMT_REPLAY__ && typeof root.window !== "undefined") {
    root.api = createReplayApi(root.__BMT_REPLAY__, root.sessionStorage);
  }
})(globalThis);
