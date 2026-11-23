// A stand-in for the Electron preload's `window.api` that answers from the T05 IPC goldens
// (parity/goldens/FORMAT.md), so Electron's own built renderer runs inside the Tauri webview
// before any Rust command exists. `run-tauri.ts` puts the bundle in `__BMT_REPLAY__` ahead
// of this script in the webview's initialization script, which runs before any page script.
(function install(root) {
  const STORE_KEY = "__bmtReplay";
  // states.ts applyState writes the running state's id here
  const STATE_KEY = "__bmtReplayState";

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
   * @param storage Where settings written, write-group cursors, calls and misses live, so they
   *   survive the reload every state does. sessionStorage in the webview, which applyState
   *   clears before each state's first step.
   */
  function createReplayApi(bundle, storage) {
    const fresh = () => ({ settings: {}, cursors: {}, misses: [], calls: [] });
    // Read again on every call, because applyState clears sessionStorage while the page lives
    let state = fresh();
    const load = () => {
      if (!storage) return state;
      const saved = storage.getItem(STORE_KEY);
      state = saved ? JSON.parse(saved) : fresh();
      return state;
    };
    const save = () => storage?.setItem(STORE_KEY, JSON.stringify(state));

    const bySeq = (a, b) => a.seq - b.seq;

    // The running state's own call list (FORMAT.md, "Per-state call lists") answers first, by
    // exact arguments. A call it lacks falls back to the general rule and counts as a miss.
    function find(channel, args) {
      const key = canonical(args);
      const index = bundle.states?.[storage?.getItem(STATE_KEY) ?? ""];
      if (!index) return byFormat(channel, key);
      const listed = index.find((c) => c.channel === channel && canonical(c.args) === key);
      const golden = listed && (bundle.goldens[channel] ?? []).find((c) => c.case === listed.case);
      if (golden) return { golden, exact: true };
      const fallback = byFormat(channel, key);
      return fallback && { ...fallback, exact: false, unlisted: true };
    }

    // FORMAT.md version 1, "Matching a call to a golden": equal canonical arguments, the
    // lowest seq on a tie, and a write group's cases in seq order behind one cursor per
    // channel. Otherwise the case named default.
    function byFormat(channel, key) {
      const cases = bundle.goldens[channel] ?? [];
      const exact = cases.filter((c) => canonical(c.args) === key).sort(bySeq);
      if (exact.length === 0) {
        const fallback = cases.find((c) => c.case === "default");
        return fallback && { golden: fallback, exact: false };
      }
      // A per-state case (group "state") is a read, recorded by record-states.ts
      const isWrite = (c) => c.group !== "read" && c.group !== "state";
      if (!isWrite(exact[0])) return { golden: exact[0], exact: true };
      const writes = cases.filter(isWrite).sort(bySeq);
      const cursor = state.cursors[channel] ?? 0;
      const next = writes.findIndex((c, i) => i >= cursor && exact.includes(c));
      if (next < 0) return { golden: exact[0], exact: true };
      state.cursors[channel] = next + 1;
      return { golden: writes[next], exact: true };
    }

    function request(method, channel) {
      return async (...called) => {
        load();
        const args = recordedArgs(called);
        const call = `${method}(${JSON.stringify(args)})`;
        if (method === "getSetting" && Object.hasOwn(state.settings, args[0])) {
          state.calls.push(`${call} -> written earlier`);
          save();
          return state.settings[args[0]];
        }
        const found = find(channel, args);
        state.calls.push(`${call} -> ${found ? found.golden.case : "miss"}`);
        // A default answer is data recorded for other arguments, and an answer the state's
        // list lacks is a guess, so both count as misses
        if (!found || !found.exact) {
          const kind = !found ? "ReplayMiss" : found.unlisted ? "unlisted" : "default";
          state.misses.push(`${kind}: ${call}`);
        }
        if (found && method === "setSetting" && found.golden.outcome.kind !== "error") {
          state.settings[args[0]] = args[1];
        }
        save();
        if (!found) throw new ReplayMiss(method, args);
        return answer(found.golden.outcome);
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
    Object.defineProperty(api, "__misses", { get: () => [...load().misses] });
    Object.defineProperty(api, "__calls", { get: () => [...load().calls] });
    return api;
  }

  root.createBmtReplayApi = createReplayApi;
  if (root.__BMT_REPLAY__ && typeof root.window !== "undefined") {
    root.api = createReplayApi(root.__BMT_REPLAY__, root.sessionStorage);
  }
})(globalThis);
