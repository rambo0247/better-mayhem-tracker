type Listener = (...args: never[]) => void;

// A stand-in for window.api that records calls and lets a test fire the
// events the main process would send. Installed before any component imports
// api-shim, which reads window.api once at import.
export const fake = {
  calls: [] as { method: string; args: unknown[] }[],
  listeners: new Map<string, Set<Listener>>(),
  returns: new Map<string, unknown>(),
  emit(event: string, ...args: unknown[]) {
    for (const fn of this.listeners.get(event) ?? []) (fn as (...a: unknown[]) => void)(...args);
  },
  reset() {
    this.calls = [];
    this.listeners.clear();
    this.returns.clear();
  },
};

const target: Record<string, unknown> = { platform: "darwin", locale: undefined };

(window as unknown as { api: unknown }).api = new Proxy(target, {
  get(t, key) {
    if (typeof key !== "string" || key in t) return t[key as string];
    if (key.startsWith("on")) {
      return (fn: Listener) => {
        const set = fake.listeners.get(key) ?? new Set();
        set.add(fn);
        fake.listeners.set(key, set);
        return () => set.delete(fn);
      };
    }
    return (...args: unknown[]) => {
      fake.calls.push({ method: key, args });
      return Promise.resolve(fake.returns.get(key));
    };
  },
});
