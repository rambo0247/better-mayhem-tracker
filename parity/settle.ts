import type { Page } from "playwright";

export const KILL_SWITCH_CSS =
  "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;scroll-behavior:auto!important}";

export const QUIET_MS = 1200;
export const SETTLE_TIMEOUT_MS = 15_000;

export interface SettleReport {
  ms: number;
  timedOut: boolean;
  pendingImages: number;
}

/**
 * Waits until the page has stopped changing: fonts loaded, every image decoded, the
 * client status label past "Connecting...", and QUIET_MS without a DOM mutation. Then
 * it freezes animation and parks the mouse in the corner so no hover is left behind.
 */
export async function settle(
  page: Page,
  viewport: { width: number; height: number },
): Promise<SettleReport> {
  const started = Date.now();
  const report = await page.evaluate(
    async ({ quiet, timeout }) => {
      await document.fonts.ready;
      let lastMutation = performance.now();
      const observer = new MutationObserver(() => (lastMutation = performance.now()));
      observer.observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
      const deadline = performance.now() + timeout;
      let timedOut = false;
      let pending = 0;
      for (;;) {
        const images = [...document.images];
        // Lazy images far below the fold never load, so only the ones near the viewport count
        pending = images.filter((image) => {
          if (image.complete) return false;
          const box = image.getBoundingClientRect();
          return box.bottom > -innerHeight && box.top < 2 * innerHeight;
        }).length;
        const status = document.querySelector('[role="status"][aria-label^="League client:"]');
        const connecting = status?.getAttribute("aria-label")?.includes("Connecting") ?? false;
        if (pending > 0 || connecting) lastMutation = performance.now();
        if (performance.now() - lastMutation > quiet) break;
        if (performance.now() > deadline) {
          timedOut = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      observer.disconnect();
      const decodeWithin = (image: HTMLImageElement) =>
        Promise.race([
          image.decode().catch(() => {}),
          new Promise((resolve) => setTimeout(resolve, 3000)),
        ]);
      await Promise.all([...document.images].filter((image) => image.complete).map(decodeWithin));
      return { timedOut, pending };
    },
    { quiet: QUIET_MS, timeout: SETTLE_TIMEOUT_MS },
  );
  await page.addStyleTag({ content: KILL_SWITCH_CSS });
  await page.mouse.move(viewport.width - 2, viewport.height - 2);
  await page.waitForTimeout(300);
  return { ms: Date.now() - started, timedOut: report.timedOut, pendingImages: report.pending };
}
