import { mock } from "bun:test";
import type { Component } from "solid-js";
import { mount } from "../../test/render";

// Page tests mount the page into the preloaded happy-dom window and read its
// markup. The hooks that would reach the Rust side answer from `ipc`, in the
// order the page asks.
// The shared setup does not expose happy-dom's ResizeObserver, which
// FriendDetail measures its champion list with
Object.assign(globalThis, {
  ResizeObserver: (window as never as typeof globalThis).ResizeObserver,
});

export interface IpcAnswer {
  data: unknown;
  loading: boolean;
}

export const ipc = { answers: [] as IpcAnswer[], calls: 0 };
export const route = { params: {} as Record<string, string>, state: null as unknown };

mock.module("../lib/api-shim", () => ({
  api: {
    platform: "darwin",
    onGamesUpdated: () => () => {},
    getAllSummonerPuuids: async () => [],
    getChampionData: async () => ({}),
    getMatchFilterOptions: async () => ({}),
  },
}));
mock.module("../lib/perf", () => ({ reportFirstContent: () => {} }));
mock.module("../hooks/useIpc", () => ({
  useIpc: () => {
    const answer = ipc.answers[ipc.calls++]!;
    return { data: () => answer.data, loading: () => answer.loading, refetch: async () => {} };
  },
}));
mock.module("@solidjs/router", () => ({
  useParams: () => route.params,
  useLocation: () => ({ state: route.state }),
  useNavigate: () => () => {},
}));

export const loaded = (data: unknown): IpcAnswer => ({ data, loading: false });
export const pending: IpcAnswer = { data: null, loading: true };

// What the page draws for these answers, one per useIpc call in call order
export function html(page: Component, ...answers: IpcAnswer[]): string {
  ipc.answers = answers;
  ipc.calls = 0;
  const view = mount(() => page({}));
  const out = view.container.innerHTML.replaceAll("<!---->", "");
  view.dispose();
  return out;
}
