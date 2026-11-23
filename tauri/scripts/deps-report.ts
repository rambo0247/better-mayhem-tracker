import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isExactPin, pinnedVersion, type Ecosystem } from "./pin";

const root = resolve(import.meta.dir, "..");

type Dep = { eco: Ecosystem; name: string; pinned: string };
type Row = Dep & {
  latest: string | null;
  prerelease: string | null;
  expected: string | null;
  status: string;
};

// Decisions the operator accepted in plan Appendix E, keyed by package name.
const WAIVERS: Record<string, string> = {
  rustls: "E4: reqwest and tokio-tungstenite need rustls ^0.23",
};

function npmDeps(): Dep[] {
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  const out: Dep[] = [];
  for (const section of ["dependencies", "devDependencies"]) {
    for (const [name, pinned] of Object.entries<string>(pkg[section] ?? {})) {
      out.push({ eco: "npm", name, pinned });
    }
  }
  return out;
}

function crateDeps(): Dep[] {
  const manifest = Bun.TOML.parse(
    readFileSync(resolve(root, "src-tauri/Cargo.toml"), "utf8"),
  ) as Record<string, any>;
  const tables: Record<string, any>[] = [manifest["dependencies"], manifest["build-dependencies"]];
  for (const target of Object.values<any>(manifest["target"] ?? {})) {
    tables.push(target["dependencies"], target["build-dependencies"]);
  }
  const out = new Map<string, Dep>();
  for (const table of tables) {
    for (const [name, spec] of Object.entries<any>(table ?? {})) {
      const raw = typeof spec === "string" ? spec : spec.version;
      if (typeof raw === "string") out.set(name, { eco: "crate", name, pinned: raw });
    }
  }
  return [...out.values()];
}

const isPre = (v: string) => v.includes("-");
const newer = (a: string, b: string) => Bun.semver.order(a, b) === 1;

function pick(versions: string[], latest: string | null) {
  let prerelease: string | null = null;
  for (const v of versions) {
    if (isPre(v) && (prerelease === null || newer(v, prerelease))) prerelease = v;
  }
  const expected = prerelease && (!latest || newer(prerelease, latest)) ? prerelease : latest;
  return { prerelease, expected };
}

async function npmVersions(name: string) {
  const res = await fetch(`https://registry.npmjs.org/${name.replace("/", "%2F")}`);
  if (!res.ok) throw new Error(`npm ${res.status}`);
  const doc: any = await res.json();
  const latest: string | null = doc["dist-tags"]?.latest ?? null;
  return { latest, ...pick(Object.keys(doc.versions ?? {}), latest) };
}

async function crateVersions(name: string) {
  const res = await fetch(`https://crates.io/api/v1/crates/${name}`, {
    headers: { "User-Agent": "better-mayhem-tracker-deps-report" },
  });
  if (!res.ok) throw new Error(`crates.io ${res.status}`);
  const doc: any = await res.json();
  const live: string[] = doc.versions.filter((v: any) => !v.yanked).map((v: any) => v.num);
  const stable = live.filter((v) => !isPre(v));
  const latest = stable.reduce<string | null>(
    (best, v) => (best === null || newer(v, best) ? v : best),
    null,
  );
  return { latest, ...pick(live, latest) };
}

async function check(dep: Dep): Promise<Row> {
  try {
    const found = dep.eco === "npm" ? await npmVersions(dep.name) : await crateVersions(dep.name);
    const matches =
      isExactPin(dep.eco, dep.pinned) && pinnedVersion(dep.eco, dep.pinned) === found.expected;
    const waiver = WAIVERS[dep.name];
    const status = matches
      ? "ok"
      : waiver
        ? `waived (${waiver})`
        : isExactPin(dep.eco, dep.pinned)
          ? `BREAKS RULE, expected ${found.expected}`
          : `BREAKS RULE, not an exact pin, expected ${found.expected}`;
    return { ...dep, ...found, status };
  } catch (error) {
    return {
      ...dep,
      latest: null,
      prerelease: null,
      expected: null,
      status: `unknown (${(error as Error).message})`,
    };
  }
}

const rows = await Promise.all([...npmDeps(), ...crateDeps()].map(check));
rows.sort((a, b) => a.eco.localeCompare(b.eco) || a.name.localeCompare(b.name));

const cell = (v: string | null) => v ?? "none";
console.log(["eco", "name", "latest", "newest prerelease", "pinned", "status"].join("\t"));
for (const r of rows) {
  console.log([r.eco, r.name, cell(r.latest), cell(r.prerelease), r.pinned, r.status].join("\t"));
}
const broken = rows.filter((r) => r.status.startsWith("BREAKS"));
console.log(`\n${rows.length} dependencies, ${broken.length} break the version rule`);
