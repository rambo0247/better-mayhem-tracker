const [kind, mbArg] = process.argv.slice(2);
const mb = Number(mbArg);
const hold: Uint8Array[] = [];
const fill = (size: number) => {
  const buffer = new Uint8Array(size * 1024 * 1024);
  for (let i = 0; i < buffer.length; i += 4096) buffer[i] = 1;
  hold.push(buffer);
};
if (kind === "parent") {
  fill(mb);
  const child = Bun.spawn(["bun", import.meta.path, "child", String(mb)], { stdin: "ignore" });
  const second = Bun.spawn(["bun", import.meta.path, "idle", "0"], { stdin: "ignore" });
  process.on("SIGTERM", () => {
    child.kill();
    second.kill();
    process.exit(0);
  });
} else if (kind === "child" || kind === "idle-big") fill(mb);
setInterval(() => void hold.length, 1000);
