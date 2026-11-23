import { plugin } from "bun";
import { mock } from "bun:test";
import { readFileSync } from "node:fs";
import { transformWithOxc } from "vite";
import { transform } from "@solidjs/compiler";
import { renderToString } from "@solidjs/web";
import type { Component } from "solid-js";

// Page tests run without a DOM: pages are compiled for the server, rendered to
// a string, and read as text. The hooks that would reach the Rust side answer
// from `ipc`, in the order the page asks.
plugin({
  name: "solid-ssr",
  setup(build) {
    build.onLoad(
      { filter: /\/tauri\/src\/(?!.*\.test\.)(?!testing\/).*\.tsx$/ },
      async ({ path }) => {
        const stripped = await transformWithOxc(readFileSync(path, "utf8"), path, {
          jsx: "preserve",
          lang: "tsx",
        });
        return {
          contents: transform(stripped.code, { generate: "ssr", filename: path }).code,
          loader: "js",
        };
      },
    );
  },
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
  return renderToString(() => page({})).replaceAll("&#8230;", "…");
}
