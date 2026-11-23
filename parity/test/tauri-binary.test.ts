import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { tauriBinary } from "../run-tauri.ts";

const NEW = "Better Mayhem Tracker";
const OLD = "better-mayhem-tracker-tauri";

function target(names: Record<string, number>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bmt-binary-"));
  fs.mkdirSync(path.join(dir, "debug"));
  for (const [name, seconds] of Object.entries(names)) {
    const file = path.join(dir, "debug", name);
    fs.writeFileSync(file, "");
    fs.utimesSync(file, seconds, seconds);
  }
  return dir;
}

function pick(dir: string, platform: NodeJS.Platform = "darwin") {
  const lines: string[] = [];
  const file = tauriBinary("", { targetDir: dir, platform, log: (line) => lines.push(line) });
  return { file: path.basename(file), lines };
}

describe("tauriBinary", () => {
  test("takes the mainBinaryName a tauri build leaves", () => {
    expect(pick(target({ [NEW]: 100 }))).toEqual({ file: NEW, lines: [] });
  });

  test("takes cargo's name a plain cargo build leaves", () => {
    expect(pick(target({ [OLD]: 100 }))).toEqual({ file: OLD, lines: [] });
  });

  test("takes the newer of the two and says which", () => {
    const dir = target({ [NEW]: 100, [OLD]: 200 });
    const [newName, oldName] = [path.join(dir, "debug", NEW), path.join(dir, "debug", OLD)];
    expect(pick(dir)).toEqual({
      file: OLD,
      lines: [`Both ${newName} and ${oldName} exist; using the newer ${oldName}`],
    });
    expect(pick(target({ [NEW]: 300, [OLD]: 200 })).file).toBe(NEW);
  });

  test("adds .exe on Windows", () => {
    expect(pick(target({ [`${NEW}.exe`]: 100 }), "win32").file).toBe(`${NEW}.exe`);
  });

  test("names both paths when neither exists", () => {
    const dir = target({});
    expect(() => pick(dir)).toThrow(
      `Neither ${path.join(dir, "debug", NEW)} nor ${path.join(dir, "debug", OLD)} exists`,
    );
  });
});
