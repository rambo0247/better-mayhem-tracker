import fs from "node:fs";
import path from "node:path";
import { PARITY_DIR } from "./lib/data.ts";
import { startElectron } from "./run-electron.ts";
import { applyState, resolveVars, STATES } from "./states.ts";

/**
 * Proves a hover state holds a real `:hover`, not a painted look: applies the state, then reads
 * the target's `:hover` match and the computed style of the hovered link against its siblings.
 * Writes hover-probe.json beside the run.
 */
const NAV = 'nav a[href$="/champions"]';
const STYLE_KEYS = ["backgroundColor", "color", "borderLeftColor", "boxShadow", "opacity"] as const;

const out = path.join(PARITY_DIR, "out", process.argv[2] ?? "hover-probe");
fs.mkdirSync(out, { recursive: true });
const state = STATES.find((s) => s.id === "overlay-hover-nav-link")!;
const running = await startElectron({
  data: "fixture",
  runDir: path.join(out, "run"),
  viewport: state.viewport,
});
try {
  await applyState(running.ctx, state, await resolveVars(running.page));
  const result = await running.page.evaluate(
    ({ nav, keys }) => {
      const style = (el: Element) => {
        const cs = getComputedStyle(el);
        return Object.fromEntries(keys.map((k) => [k, cs[k]]));
      };
      const hovered = document.querySelector(nav)!;
      const others = [...document.querySelectorAll("nav a")].filter((a) => a !== hovered);
      return {
        hoveredMatchesHover: hovered.matches(":hover"),
        hoveredStyle: style(hovered),
        othersMatchingHover: others.filter((a) => a.matches(":hover")).length,
        otherStyles: others.slice(0, 4).map((a) => ({
          href: a.getAttribute("href"),
          active: a.getAttribute("aria-current"),
          ...style(a),
        })),
      };
    },
    { nav: NAV, keys: [...STYLE_KEYS] },
  );
  fs.writeFileSync(path.join(out, "hover-probe.json"), JSON.stringify(result, null, 1));
  console.log(JSON.stringify(result, null, 1));
  // The hover colour is the active link's own, so the background is what sets the hovered link apart
  const sameBackground = result.otherStyles.some(
    (other) => other.backgroundColor === result.hoveredStyle.backgroundColor,
  );
  if (!result.hoveredMatchesHover || result.othersMatchingHover !== 0 || sameBackground) {
    console.error("the hover state is not a real :hover on the Champions link alone");
    process.exitCode = 1;
  }
} finally {
  const report = await running.close();
  if (report.faults.length > 0 || report.leaks.length > 0) {
    console.error(JSON.stringify(report));
    process.exitCode = 1;
  }
}
