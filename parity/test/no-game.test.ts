import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gameRunning } from "../lib/no-game.ts";

test.skipIf(process.platform === "win32")(
  "a running process with the watched name reads as a running game, and its exit clears it",
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bmt-nogame-"));
    const fake = path.join(dir, "BmtFakeGameProcess");
    fs.symlinkSync("/bin/sleep", fake);
    const child = spawn(fake, ["30"], { stdio: "ignore" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(gameRunning(process.platform, "BmtFakeGameProcess")).toBe(true);
    child.kill();
    await new Promise((resolve) => child.on("exit", resolve));
    expect(gameRunning(process.platform, "BmtFakeGameProcess")).toBe(false);
  },
);
