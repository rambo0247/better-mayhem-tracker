import type { Page } from "playwright";

export const KILL_SWITCH_CSS =
  "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;scroll-behavior:auto!important}::-webkit-scrollbar{display:none!important}";

export const QUIET_MS = 1200;
export const SETTLE_TIMEOUT_MS = 15_000;

export interface SettleReport {
  ms: number;
  timedOut: boolean;
  pendingImages: number;
  decodeFailures: number;
  /** The first few images that did not decode, so a run names what failed */
  failedImages: string[];
  /** What still moved when the wait ran out, for a page that never settled */
  stuckOn?: string;
}

export async function settle(
  page: Page,
  viewport: { width: number; height: number },
  options: { parkMouse?: boolean } = {},
): Promise<SettleReport> {
  const started = Date.now();
  const report = await page.evaluate(
    async ({ quiet, timeout }) => {
      await document.fonts.ready;
      let lastMutation = performance.now();
      let lastChanged = "";
      const describe = (node: any) => {
        const element = node instanceof Element ? node : node?.parentElement;
        if (!element) return String(node?.nodeName);
        const label = element.getAttribute("aria-label") ?? element.textContent ?? "";
        return `${element.tagName.toLowerCase()}.${[...element.classList].slice(0, 3).join(".")} "${label.slice(0, 60)}"`;
      };
      const observer = new MutationObserver((records) => {
        lastMutation = performance.now();
        const last = records.at(-1);
        if (last) lastChanged = `${last.type} on ${describe(last.target)}`;
      });
      observer.observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
      const deadline = performance.now() + timeout;
      let timedOut = false;
      let pending: number;
      let stuckOn: string | undefined;
      for (;;) {
        const images = [...document.images];
        // A lazy image loads when the engine decides it is near enough, and engines differ on
        // how near, so one outside the viewport may never load and is not waited for. Others
        // count within a screen of the viewport.
        pending = images.filter((image) => {
          if (image.complete) return false;
          const box = image.getBoundingClientRect();
          if (image.loading === "lazy") {
            return (
              box.bottom > 0 && box.top < innerHeight && box.right > 0 && box.left < innerWidth
            );
          }
          return box.bottom > -innerHeight && box.top < 2 * innerHeight;
        }).length;
        const status = document.querySelector('[role="status"][aria-label^="League client:"]');
        const connecting = status?.getAttribute("aria-label")?.includes("Connecting") ?? false;
        const holdsConnecting = (window as any).__paritySkipConnecting === true;
        if (pending > 0 || (connecting && !holdsConnecting)) lastMutation = performance.now();
        if (performance.now() - lastMutation > quiet) break;
        if (performance.now() > deadline) {
          timedOut = true;
          stuckOn = `${pending} images pending, connecting ${connecting}, last change ${Math.round(performance.now() - lastMutation)} ms ago: ${lastChanged}`;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      observer.disconnect();
      const failed: string[] = [];
      const decodeWithin = (image: HTMLImageElement) =>
        Promise.race([
          image.decode().catch(() => failed.push(image.currentSrc || image.src)),
          new Promise((resolve) =>
            setTimeout(() => {
              failed.push(`${image.currentSrc || image.src} (3 s)`);
              resolve(undefined);
            }, 3000),
          ),
        ]);
      await Promise.all([...document.images].filter((image) => image.complete).map(decodeWithin));
      return {
        timedOut,
        pending,
        stuckOn,
        decodeFailures: failed.length,
        failedImages: failed.slice(0, 5),
      };
    },
    { quiet: QUIET_MS, timeout: SETTLE_TIMEOUT_MS },
  );
  await page.addStyleTag({ content: KILL_SWITCH_CSS });
  if (options.parkMouse !== false) await page.mouse.move(viewport.width - 2, viewport.height - 2);
  await page.waitForTimeout(300);
  return {
    ms: Date.now() - started,
    timedOut: report.timedOut,
    pendingImages: report.pending,
    decodeFailures: report.decodeFailures,
    failedImages: report.failedImages,
    stuckOn: report.stuckOn,
  };
}
