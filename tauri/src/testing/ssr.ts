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
export const route = {
  params: {} as Record<string, string>,
  state: null as unknown,
  navigations: [] as { to: string; options?: unknown }[],
};

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
  useNavigate: () => (to: string, options?: unknown) => {
    route.navigations.push({ to, options });
  },
}));

export const loaded = (data: unknown): IpcAnswer => ({ data, loading: false });
export const pending: IpcAnswer = { data: null, loading: true };

// The page mounted on these answers, one per useIpc call in call order
export function mountPage(page: Component, ...answers: IpcAnswer[]) {
  ipc.answers = answers;
  ipc.calls = 0;
  return mount(() => page({}));
}

// What the page draws for these answers
export function html(page: Component, ...answers: IpcAnswer[]): string {
  const view = mountPage(page, ...answers);
  const out = view.container.innerHTML.replaceAll("<!---->", "");
  view.dispose();
  return out;
}
