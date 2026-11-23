import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { flush } from "solid-js";
import { render } from "@solidjs/web";
import { fake } from "../../test/fakeApi";
import type { UpdateInfo } from "../lib/types";
import UpdateDialog from "./UpdateDialog";

const RELEASE = (version: string) => ({
  version,
  body: `Notes for ${version}`,
  publishedAt: "2026-11-01T00:00:00Z",
  url: `https://github.com/x/y/releases/tag/v${version}`,
});

const base: UpdateInfo = {
  hasUpdate: true,
  current: "1.2.1",
  latest: "1.3.0",
  url: "https://github.com/x/y/releases/tag/v1.3.0",
  assetUrl: "https://github.com/x/y/releases/download/v1.3.0/app.exe",
  assetSize: 50 * 1024 * 1024,
  releases: [RELEASE("1.3.0")],
};

let host: HTMLDivElement;
let dispose: () => void;
let closed: number;

function mount(update: UpdateInfo, installing = false) {
  dispose = render(
    () => <UpdateDialog update={update} installing={installing} onClose={() => closed++} />,
    host,
  );
  flush();
}

const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
  flush();
};
const button = (label: string) =>
  [...host.querySelectorAll("button")].find((b) => b.textContent?.includes(label)) as
    | HTMLButtonElement
    | undefined;

beforeEach(() => {
  fake.reset();
  closed = 0;
  host = document.createElement("div");
  document.body.append(host);
});
afterEach(() => {
  dispose();
  host.remove();
});

describe("UpdateDialog", () => {
  test("manual: offers the update with its version", () => {
    mount(base);
    expect(host.textContent).toContain("Update Available");
    expect(host.textContent).toContain("Version 1.3.0 is ready to install.");
    expect(button("Update & Restart")?.disabled).toBe(false);
    expect(host.textContent).not.toContain("Downloading");
  });

  test("manual: several releases say how many were skipped", () => {
    mount({
      ...base,
      releases: [RELEASE("1.3.0"), RELEASE("1.2.5")],
      moreVersions: true,
    });
    expect(host.textContent).toContain("2 versions of changes since your install, plus earlier");
  });

  test("a release with no installer cannot be installed here", () => {
    mount({ ...base, assetUrl: undefined });
    expect(button("Update & Restart")?.disabled).toBe(true);
  });

  test("downloading: shows progress against the asset size", async () => {
    fake.returns.set("downloadUpdate", new Promise(() => {}));
    mount(base);
    await settle();
    button("Update & Restart")!.click();
    await settle();
    fake.emit("onUpdateProgress", 40);
    flush();
    expect(host.textContent).toContain("Downloading");
    expect(host.textContent).toContain("40%");
    expect(host.textContent).toContain("of 50.0 MB");
    expect(button("Updating...")?.disabled).toBe(true);
    expect(button("Not Now")?.disabled).toBe(true);
    expect(fake.calls.at(-1)?.args).toEqual([base.assetUrl]);
  });

  test("launch install: starts out downloading with its own wording", () => {
    mount(base, true);
    expect(host.textContent).toContain("Updating");
    expect(host.textContent).toContain("The program restarts on its own when it's done.");
    expect(host.textContent).toContain("Downloading");
  });

  test("error: a failed download shows the message and a manual link", async () => {
    fake.returns.set("downloadUpdate", Promise.resolve({ success: false, error: "Disk full" }));
    mount(base);
    await settle();
    button("Update & Restart")!.click();
    await settle();
    await settle();
    expect(host.textContent).toContain("Disk full");
    expect(host.textContent).toContain("Download manually");
    expect(button("Update & Restart")?.disabled).toBe(false);
  });

  test("error: a failed launch install becomes an ordinary offer", async () => {
    mount(base, true);
    await settle();
    fake.emit("onUpdateInstallFailed", "Download stalled");
    flush();
    expect(host.textContent).toContain("Update Available");
    expect(host.textContent).toContain("Download stalled");
    expect(host.textContent).not.toContain("Downloading");
  });
});
