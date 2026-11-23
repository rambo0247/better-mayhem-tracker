import { invoke } from "@tauri-apps/api/core";
import { render } from "@solidjs/web";

render(() => <div />, document.getElementById("root")!);

requestAnimationFrame(() => {
  requestAnimationFrame(() => void invoke("first_paint"));
});
