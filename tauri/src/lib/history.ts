import { hashHistory, type RouterHistory } from "@solidjs/router";

// hashHistory hands back only the path, so a page opened with navigate(to,
// { state }) would lose that state on Back and Forward. HashRouter kept it in
// the history entry, and so does this.
export function hashHistoryWithState(): RouterHistory {
  const history = hashHistory();
  return {
    ...history,
    get() {
      const { _depth, ...state } = window.history.state ?? {};
      return {
        value: window.location.hash.slice(1),
        state: Object.keys(state).length > 0 ? state : undefined,
      };
    },
  };
}
