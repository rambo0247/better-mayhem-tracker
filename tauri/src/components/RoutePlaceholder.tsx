import { onSettled } from "solid-js";
import { reportFirstContent } from "../lib/perf";

// What a route shows until its page unit lands: nothing, so the chrome around
// it can be compared with Electron's on its own
export default function RoutePlaceholder(props: { page: string }) {
  onSettled(() => reportFirstContent());
  return <section data-placeholder={props.page} aria-label={`${props.page} is not ported yet`} />;
}
