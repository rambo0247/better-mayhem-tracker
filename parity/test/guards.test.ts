import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { isUnderRealFolder, realDataRoots } from "../lib/real-folder.ts";
import { diffHashes, hashAppFiles, takeSnapshot } from "../snapshot.ts";

const seam = path.resolve(import.meta.dir, "../seam.cjs");

// The first node a CI runner starts took 1.8 s against bun's 5 s default, and a loaded Mac
// stretches it further. Every test here spawns one.
setDefaultTimeout(30_000);

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bmt-guard-"));
}

describe("real folder paths", () => {
  test("default roots name the installed app's folders on this platform", () => {
    const mac = realDataRoots("darwin", {}, "/Users/p");
    expect(mac).toContain("/Users/p/Library/Application Support/better-mayhem-tracker");
    const win = realDataRoots(
      "win32",
      { APPDATA: "C:\\Users\\p\\AppData\\Roaming" },
      "C:\\Users\\p",
    );
    expect(win.some((root) => root.toLowerCase().endsWith("better-mayhem-tracker"))).toBe(true);
  });

  test("a path inside, the root itself, and a case variant are all refused", () => {
    const roots = ["/x/Application Support/better-mayhem-tracker"];
    expect(
      isUnderRealFolder("/x/Application Support/better-mayhem-tracker/data/matches.db", roots),
    ).toBe(true);
    expect(isUnderRealFolder("/x/Application Support/better-mayhem-tracker", roots)).toBe(true);
    expect(isUnderRealFolder("/x/application support/BETTER-MAYHEM-TRACKER/logs", roots)).toBe(
      true,
    );
    expect(
      isUnderRealFolder("/x/Application Support/better-mayhem-tracker-spike/data", roots),
    ).toBe(false);
  });

  test("a symlink into the folder is refused", () => {
    const dir = scratch();
    const real = path.join(dir, "real");
    fs.mkdirSync(real);
    fs.symlinkSync(real, path.join(dir, "link"));
    expect(isUnderRealFolder(path.join(dir, "link", "data"), [real])).toBe(true);
  });

  test("a dangling symlink into the folder is refused, directly, through a relative link, or as a parent", () => {
    const dir = scratch();
    const real = path.join(dir, "real");
    fs.mkdirSync(real);
    fs.symlinkSync(path.join(real, "data", "new.db"), path.join(dir, "dangling"));
    fs.symlinkSync("dangling", path.join(dir, "relative"));
    fs.symlinkSync(path.join(real, "not-yet"), path.join(dir, "dangling-dir"));
    expect(isUnderRealFolder(path.join(dir, "dangling"), [real])).toBe(true);
    expect(isUnderRealFolder(path.join(dir, "relative"), [real])).toBe(true);
    expect(isUnderRealFolder(path.join(dir, "dangling-dir", "x.db"), [real])).toBe(true);
    fs.symlinkSync(path.join(dir, "nowhere"), path.join(dir, "dangling-elsewhere"));
    fs.symlinkSync("loop-b", path.join(dir, "loop-a"));
    fs.symlinkSync("loop-a", path.join(dir, "loop-b"));
    expect(isUnderRealFolder(path.join(dir, "dangling-elsewhere"), [real])).toBe(false);
    expect(isUnderRealFolder(path.join(dir, "loop-a"), [real])).toBe(false);
  });
});

describe("snapshot", () => {
  test("refuses an output under the real folder and writes nothing", () => {
    const dir = scratch();
    const real = path.join(dir, "real");
    fs.mkdirSync(path.join(real, "data"), { recursive: true });
    const target = path.join(real, "snap");
    expect(() => takeSnapshot({ source: real, out: target, realRoots: [real] })).toThrow(
      /real data folder/,
    );
    expect(fs.existsSync(target)).toBe(false);
  });

  test("copies the database with .backup and the caches, leaving the source as it was", () => {
    const dir = scratch();
    const source = path.join(dir, "source");
    fs.mkdirSync(path.join(source, "data"), { recursive: true });
    fs.mkdirSync(path.join(source, "asset-cache", "16.1"), { recursive: true });
    spawnSync("sqlite3", [
      path.join(source, "data", "matches.db"),
      "create table t(a); insert into t values (7);",
    ]);
    fs.writeFileSync(path.join(source, "data", "champion-cache.json"), "{}");
    fs.writeFileSync(path.join(source, "asset-cache", "16.1", "a.png"), "png");
    const before = fs.readFileSync(path.join(source, "data", "matches.db"));

    const out = path.join(dir, "out");
    const result = takeSnapshot({ source, out, realRoots: [path.join(dir, "elsewhere")] });
    expect(result.caches).toEqual(["data/champion-cache.json", "asset-cache/"]);
    const rows = spawnSync("sqlite3", [
      "-readonly",
      result.database,
      "select a from t",
    ]).stdout.toString();
    expect(rows.trim()).toBe("7");
    expect(fs.existsSync(path.join(out, "asset-cache", "16.1", "a.png"))).toBe(true);
    expect(fs.readFileSync(path.join(source, "data", "matches.db")).equals(before)).toBe(true);
  });
});

test("hashing a source before and after a snapshot shows it unchanged", () => {
  const dir = scratch();
  const source = path.join(dir, "source");
  fs.mkdirSync(path.join(source, "data"), { recursive: true });
  spawnSync("sqlite3", [path.join(source, "data", "matches.db"), "create table t(a);"]);
  const before = hashAppFiles(source);
  takeSnapshot({ source, out: path.join(dir, "out"), realRoots: [path.join(dir, "elsewhere")] });
  expect(diffHashes(before, hashAppFiles(source))).toEqual({ changed: [], removed: [], added: [] });
  fs.appendFileSync(path.join(source, "data", "matches.db"), "x");
  expect(diffHashes(before, hashAppFiles(source)).changed).toEqual(["data/matches.db"]);
});

test("a snapshot of a WAL database a live writer holds open leaves every source file as it was", async () => {
  const dir = scratch();
  const source = path.join(dir, "source");
  fs.mkdirSync(path.join(source, "data"), { recursive: true });
  const db = path.join(source, "data", "matches.db");
  const holder = path.join(dir, "holder.ts");
  fs.writeFileSync(
    holder,
    `import { Database } from "bun:sqlite";
     const db = new Database(process.argv[2]);
     db.run("PRAGMA journal_mode=WAL");
     db.run("PRAGMA wal_autocheckpoint=0");
     db.run("create table x(a)");
     for (let i = 0; i < 200; i++) db.run("insert into x values (?)", [i]);
     console.log("ready");
     setInterval(() => db.query("select 1").get(), 1000);`,
  );
  const child = spawn("bun", [holder, db], { stdio: ["ignore", "pipe", "inherit"] });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the writer never became ready")), 15_000);
      child.on("exit", (code) => reject(new Error(`the writer exited with ${code}`)));
      child.stdout!.on("data", (chunk: Buffer) => {
        if (chunk.toString().includes("ready")) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    expect(fs.statSync(db + "-wal").size).toBeGreaterThan(0);
    expect(fs.existsSync(db + "-shm")).toBe(true);

    const before = hashAppFiles(source);
    expect([...before.keys()].sort()).toEqual(
      ["data/matches.db", "data/matches.db-shm", "data/matches.db-wal"].sort(),
    );
    const result = takeSnapshot({ source, out: path.join(dir, "out"), realRoots: [dir + "-x"] });
    expect(diffHashes(before, hashAppFiles(source))).toEqual({
      changed: [],
      removed: [],
      added: [],
    });
    const rows = spawnSync("sqlite3", ["-readonly", result.database, "select count(*) from x"]);
    expect(rows.stdout.toString().trim()).toBe("200");
    expect(fs.readdirSync(path.join(dir, "out", "data"))).toEqual(["matches.db"]);

    spawnSync("sqlite3", ["-readonly", db, "select count(*) from x"]);
    expect(diffHashes(before, hashAppFiles(source)).changed).toContain("data/matches.db-shm");
  } finally {
    child.kill();
  }
}, 30_000);

test("the snapshot CLI refuses a --verify log in the real folder before it reads or creates anything", () => {
  const home = fs.realpathSync(scratch());
  const real = realDataRoots(process.platform, {}, home)[0]!;
  fs.mkdirSync(path.join(real, "data"), { recursive: true });
  fs.writeFileSync(path.join(real, "data", "matches.db"), "not opened");
  const out = path.join(home, "snap");
  const result = spawnSync(
    "bun",
    [
      path.resolve(import.meta.dir, "../snapshot.ts"),
      "--out",
      out,
      "--verify",
      path.join(real, "verify.log"),
    ],
    { env: { ...process.env, HOME: home, XDG_CONFIG_HOME: "" }, encoding: "utf8", timeout: 30_000 },
  );
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("verify log refused");
  expect(fs.existsSync(out)).toBe(false);
  expect(fs.readdirSync(real)).toEqual(["data"]);
});

test("--data refuses the real folder and its data folder, though they hold a database", () => {
  const home = fs.realpathSync(scratch());
  const real = realDataRoots(process.platform, {}, home)[0]!;
  fs.mkdirSync(path.join(real, "data"), { recursive: true });
  fs.writeFileSync(path.join(real, "data", "matches.db"), "not opened");
  const data = path.resolve(import.meta.dir, "../lib/data.ts");
  const outcomes = [real, path.join(real, "data")].map((spec) => {
    const result = spawnSync(
      "bun",
      [
        "-e",
        `import { resolveDataRoot } from ${JSON.stringify(data)};
         try { console.log("accepted " + resolveDataRoot(${JSON.stringify(spec)})); }
         catch (e) { console.log(e.message); }`,
      ],
      {
        env: { ...process.env, HOME: home, XDG_CONFIG_HOME: "" },
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    return result.stdout.trim();
  });
  expect(outcomes).toEqual(Array(2).fill(expect.stringContaining("data folder refused")));
  expect(fs.readdirSync(path.join(real, "data"))).toEqual(["matches.db"]);
});

test("diff and determinism refuse an output in the real folder before they create anything", () => {
  const home = fs.realpathSync(scratch());
  const real = realDataRoots(process.platform, {}, home)[0]!;
  fs.mkdirSync(real, { recursive: true });
  const runs = path.join(home, "runs");
  fs.mkdirSync(runs);
  const png = new PNG({ width: 2, height: 2 });
  fs.writeFileSync(path.join(runs, "a.png"), PNG.sync.write(png));
  png.data[0] = 255;
  fs.writeFileSync(path.join(runs, "b.png"), PNG.sync.write(png));
  const run = (script: string, args: string[]) =>
    spawnSync("bun", [path.resolve(import.meta.dir, "..", script), ...args], {
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: "" },
      encoding: "utf8",
      timeout: 30_000,
    });
  const diff = run("diff.ts", [
    path.join(runs, "a.png"),
    path.join(runs, "b.png"),
    "--out",
    path.join(real, "new", "x"),
  ]);
  expect(diff.status).not.toBe(0);
  expect(diff.stderr).toContain("diff output refused");
  const determinism = run("determinism.ts", [runs, path.join(real, "run-2")]);
  expect(determinism.status).not.toBe(0);
  expect(determinism.stderr).toContain("diff folder refused");
  expect(fs.readdirSync(real)).toEqual([]);
});

describe("seam", () => {
  function run(script: string, env: Record<string, string> = {}) {
    const dir = scratch();
    const log = path.join(dir, "seam.log");
    const real = path.join(dir, "real");
    fs.mkdirSync(path.join(real, "data"), { recursive: true });
    const result = spawnSync(
      "node",
      ["-r", seam, "-e", script.replaceAll("REAL", JSON.stringify(real))],
      {
        env: { ...process.env, SEAM_LOG: log, SEAM_REAL_ROOTS: JSON.stringify([real]), ...env },
        encoding: "utf8",
        timeout: 25_000,
      },
    );
    return { result, real, log: fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "" };
  }

  test("aborts a write under a folder mapped as real and logs it, whichever API writes", () => {
    const script = `
      const fs = require("fs"); const path = require("path"); const real = REAL;
      const attempts = [
        () => fs.writeFileSync(path.join(real, "data", "a"), "x"),
        () => fs.appendFileSync(path.join(real, "b"), "x"),
        () => fs.mkdirSync(path.join(real, "c")),
        () => fs.openSync(path.join(real, "d"), "w"),
        () => fs.createWriteStream(path.join(real, "e")),
        () => fs.renameSync(__filename || "/nonexistent", path.join(real, "f")),
        () => fs.copyFileSync("/etc/hosts", path.join(real, "g")),
        () => fs.rmSync(path.join(real, "data"), { recursive: true }),
      ];
      let blocked = 0;
      for (const attempt of attempts) { try { attempt(); } catch (e) { if (/seam refused/.test(e.message)) blocked++; } }
      fs.promises.writeFile(path.join(real, "h"), "x").catch((e) => { if (/seam refused/.test(e.message)) blocked++; console.log("blocked", blocked); });
    `;
    const { result, real, log } = run(script);
    expect(result.stdout.trim()).toBe("blocked 9");
    expect(fs.readdirSync(real)).toEqual(["data"]);
    expect(fs.readdirSync(path.join(real, "data"))).toEqual([]);
    expect(log.match(/blocked-write/g)?.length).toBe(9);
  });

  test("allows writes elsewhere and reads under the real folder", () => {
    const script = `
      const fs = require("fs"); const os = require("os"); const path = require("path");
      const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "seam-ok-"));
      fs.writeFileSync(path.join(elsewhere, "ok"), "fine");
      fs.readdirSync(REAL);
      console.log("ok");
    `;
    const { result, log } = run(script);
    expect(result.stdout.trim()).toBe("ok");
    expect(log).not.toContain("blocked-write");
  });

  test("hides League paths, blocks outside fetch, freezes the clock", () => {
    const script = `
      const fs = require("fs");
      (async () => {
        let hidden = false, fetched = false;
        try { fs.readdirSync("/Applications/League of Legends.app"); } catch (e) { hidden = e.code === "ENOENT"; }
        try { await fetch("https://ddragon.leagueoflegends.com/api/versions.json"); } catch (e) { fetched = /seam blocked/.test(e.message); }
        console.log(JSON.stringify({ hidden, fetched, now: Date.now(), made: new Date().toISOString(), arg: new Date(5).getTime() }));
      })();
    `;
    const { result, log } = run(script, {
      SEAM_FIXED_TIME: String(Date.UTC(2026, 10, 23, 2, 0, 0)),
    });
    expect(JSON.parse(result.stdout)).toEqual({
      hidden: true,
      fetched: true,
      now: Date.UTC(2026, 10, 23, 2, 0, 0),
      made: "2026-11-23T02:00:00.000Z",
      arg: 5,
    });
    expect(log).toContain("fetch-blocked https://ddragon.leagueoflegends.com/api/versions.json");
  });
  test("loopback names and addresses reach this machine and nothing else does", () => {
    const script = `
      const http = require("http");
      const attempt = (host, port) => {
        try {
          const req = http.get({ host, port: 1, timeout: 500 }, () => {});
          req.on("error", () => {});
          req.destroy();
          return "allowed";
        } catch (e) { return /seam blocked/.test(e.message) ? "blocked" : "other " + e.message; }
      };
      const urls = async (list) => {
        const out = {};
        for (const url of list) {
          try { await fetch(url, { signal: AbortSignal.timeout(500) }); out[url] = "allowed"; }
          catch (e) { out[url] = /seam blocked/.test(e.message) ? "blocked" : "allowed"; }
        }
        return out;
      };
      (async () => {
        const hosts = {};
        for (const host of ["localhost", "127.0.0.1", "127.0.0.2", "127.255.255.254", "::1", "[::1]", "0.0.0.0",
          "128.0.0.1", "127.0.0.256", "127.0.0.1.example.com", "localhost.example.com", "10.0.0.1", "example.com", "::2", "::ffff:8.8.8.8"]) {
          hosts[host] = attempt(host);
        }
        const fetched = await urls(["http://127.0.0.2:1/", "http://[::1]:1/", "http://0.0.0.0:1/", "http://128.0.0.1:1/", "https://example.com/"]);
        console.log(JSON.stringify({ hosts, fetched }));
        process.exit(0);
      })();
    `;
    const { result } = run(script);
    const { hosts, fetched } = JSON.parse(result.stdout);
    const reach = [
      "localhost",
      "127.0.0.1",
      "127.0.0.2",
      "127.255.255.254",
      "::1",
      "[::1]",
      "0.0.0.0",
    ];
    for (const host of Object.keys(hosts)) {
      expect([host, hosts[host]]).toEqual([host, reach.includes(host) ? "allowed" : "blocked"]);
    }
    expect(fetched).toEqual({
      "http://127.0.0.2:1/": "allowed",
      "http://[::1]:1/": "allowed",
      "http://0.0.0.0:1/": "allowed",
      "http://128.0.0.1:1/": "blocked",
      "https://example.com/": "blocked",
    });
  });
  test("every way of connecting to the live client's port is refused, and another port still connects", () => {
    const script = `
      const http = require("http"), https = require("https"), net = require("net"), tls = require("tls");
      const hosts = ["127.0.0.1", "localhost", "[::1]", "127.0.0.2", "0.0.0.0"];
      const bare = (h) => h.replace("[", "").replace("]", "");
      const server = net.createServer((socket) => { hits++; socket.destroy(); });
      let hits = 0;
      const refused = (error) => /seam refused the live client port/.test(String(error?.message ?? error));
      const settle = (run) => new Promise((resolve) => {
        const done = (value) => resolve(value);
        try {
          const target = run(done);
          target?.on?.("error", (error) => done(refused(error) ? "refused" : "failed"));
          setTimeout(() => done("open"), 700);
        } catch (error) { done(refused(error) ? "refused" : "failed"); }
      });
      server.listen(0, "127.0.0.1", async () => {
        const live = server.address().port;
        process.env.SEAM_LIVE_PORT = String(live);
        const forms = {
          httpString: (h) => http.get("http://" + h + ":" + live + "/liveclientdata/allgamedata"),
          httpUrl: (h) => http.get(new URL("http://" + h + ":" + live + "/")),
          httpOptions: (h) => http.request({ host: bare(h), port: live }),
          httpsString: (h) => https.get("https://" + h + ":" + live + "/", { rejectUnauthorized: false }),
          httpsOptions: (h) => https.request({ hostname: bare(h), port: live, rejectUnauthorized: false }),
          netPortHost: (h) => net.connect(live, bare(h)),
          netOptions: (h) => net.connect({ port: live, host: bare(h) }),
          netPortOnly: () => net.connect(live),
          netString: (h) => net.connect(String(live), bare(h)),
          socketConnect: (h) => new net.Socket().connect(live, bare(h)),
          tlsConnect: (h) => tls.connect(live, bare(h), { rejectUnauthorized: false }),
          tlsOptions: (h) => tls.connect({ port: live, host: bare(h), rejectUnauthorized: false }),
        };
        const results = {};
        for (const [name, make] of Object.entries(forms)) {
          for (const host of name === "netPortOnly" ? ["-"] : hosts) {
            const outcome = await settle(() => make(host));
            results[name + " " + host] = outcome === "refused" ? "refused" : "reached";
          }
        }
        results.fetch = {};
        for (const host of hosts) {
          try { await fetch("http://" + host + ":" + live + "/", { signal: AbortSignal.timeout(700) }); results.fetch[host] = "reached"; }
          catch (error) { results.fetch[host] = refused(error) || refused(error?.cause) ? "refused" : "failed"; }
        }
        const before = hits;
        process.env.SEAM_LIVE_PORT = String(live + 1);
        await settle(() => net.connect(live, "127.0.0.1").on("connect", () => {}));
        await new Promise((resolve) => setTimeout(resolve, 200));
        console.log(JSON.stringify({ results, hitsWhileGuarded: before, hitsAfter: hits }));
        process.exit(0);
      });
    `;
    const { result, log } = run(script);
    const { results, hitsWhileGuarded, hitsAfter } = JSON.parse(result.stdout);
    const reached = Object.entries(results).filter(
      ([name, outcome]) => name !== "fetch" && outcome !== "refused",
    );
    expect(reached).toEqual([]);
    expect(Object.values(results.fetch)).toEqual(Array(5).fill("refused"));
    expect(hitsWhileGuarded).toBe(0);
    expect(hitsAfter).toBeGreaterThan(0);
    expect(log).toContain("blocked-live-port");
  });
  async function runAsync(script: string, env: Record<string, string>) {
    const dir = scratch();
    const child = spawn("node", ["-r", seam, "-e", script], {
      env: { ...process.env, SEAM_LOG: path.join(dir, "seam.log"), ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    return { code, stdout, stderr };
  }

  test("SEAM_WEB_FAKE sends the Data Dragon and CommunityDragon hosts to a loopback server and blocks the rest", async () => {
    const seen: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        const url = new URL(request.url);
        seen.push(url.pathname + url.search);
        return new Response("fake");
      },
    });
    try {
      const script = `
        (async () => {
          const out = {};
          for (const url of [
            "https://ddragon.leagueoflegends.com/api/versions.json",
            "https://raw.communitydragon.org/latest/content-metadata.json?x=1",
            "https://cdn.communitydragon.org/latest/champion/1/splash-art/centered",
            "https://example.com/",
            "https://ddragon.leagueoflegends.com.example.com/api/versions.json",
            "https://api.github.com/repos/x/y/releases",
          ]) {
            try { out[url] = await (await fetch(url)).text(); }
            catch (e) { out[url] = /seam blocked/.test(e.message) ? "blocked" : "failed " + e.message; }
          }
          console.log(JSON.stringify(out));
        })();
      `;
      const on = await runAsync(script, { SEAM_WEB_FAKE: `http://127.0.0.1:${server.port}` });
      expect(JSON.parse(on.stdout)).toEqual({
        "https://ddragon.leagueoflegends.com/api/versions.json": "fake",
        "https://raw.communitydragon.org/latest/content-metadata.json?x=1": "fake",
        "https://cdn.communitydragon.org/latest/champion/1/splash-art/centered": "fake",
        "https://example.com/": "blocked",
        "https://ddragon.leagueoflegends.com.example.com/api/versions.json": "blocked",
        "https://api.github.com/repos/x/y/releases": "blocked",
      });
      expect(seen).toEqual([
        "/ddragon.leagueoflegends.com/api/versions.json",
        "/raw.communitydragon.org/latest/content-metadata.json?x=1",
        "/cdn.communitydragon.org/latest/champion/1/splash-art/centered",
      ]);

      seen.length = 0;
      const off = await runAsync(script, {});
      expect(Object.values(JSON.parse(off.stdout))).toEqual(Array(6).fill("blocked"));
      expect(seen).toEqual([]);
    } finally {
      server.stop(true);
    }
  });

  test("SEAM_WEB_FAKE refuses a value that is not a loopback http URL", async () => {
    for (const value of [
      "https://example.com",
      "http://127.0.0.1.example.com:8080",
      "http://8.8.8.8",
      "ftp://127.0.0.1",
      "not a url",
    ]) {
      const result = await runAsync("console.log('started')", { SEAM_WEB_FAKE: value });
      expect([value, result.code === 0, result.stdout.includes("started")]).toEqual([
        value,
        false,
        false,
      ]);
      expect(result.stderr).toContain("seam refuses SEAM_WEB_FAKE");
    }
  });

  test("SEAM_CLOCK_LIVE leaves Date.now running while new Date() stays fixed", () => {
    const fixed = Date.UTC(2020, 0, 1, 0, 0, 0);
    const script = `
      const before = Date.now();
      console.log(JSON.stringify({ now: before, made: new Date().getTime(), later: Date.now() >= before }));
    `;
    const frozen = JSON.parse(run(script, { SEAM_FIXED_TIME: String(fixed) }).result.stdout);
    expect(frozen).toEqual({ now: fixed, made: fixed, later: true });
    const live = JSON.parse(
      run(script, { SEAM_FIXED_TIME: String(fixed), SEAM_CLOCK_LIVE: "1" }).result.stdout,
    );
    expect(live.now).toBeGreaterThan(fixed + 24 * 60 * 60 * 1000);
    expect(live.made).toBe(fixed);
  });
});
