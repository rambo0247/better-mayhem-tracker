// Fails when the generated bindings drift from Electron's contract in
// src/shared/api.ts: a channel, an event, an argument, or a field.
//
// Names compare as text: INVOKE_CHANNELS and RendererEvents are flat literal
// blocks on both sides. Shapes compare in the compiler. TypeScript 7 has no JS
// compiler API, so the script writes one type assertion per method and event,
// runs `tsc --noEmit` on them, and reads the path of every mismatch out of the
// errors.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const TAURI_DIR = path.resolve(import.meta.dir, "..");
export const DEFAULT_BINDINGS = path.join(TAURI_DIR, "src", "bindings.ts");
export const DEFAULT_SHARED = path.resolve(TAURI_DIR, "..", "src", "shared", "api.ts");

function block(source: string, start: RegExp, file: string): string {
  const match = start.exec(source);
  if (!match) throw new Error(`${file}: no match for ${start}`);
  const from = match.index + match[0].length;
  const end = source.indexOf("\n}", from);
  return source.slice(from, end);
}

/** `method: "channel"` pairs of a channel map. */
export function parseChannels(source: string, name: string, file: string): Map<string, string> {
  const body = block(source, new RegExp(`export const ${name} = \\{`), file);
  return new Map([...body.matchAll(/^\s*(\w+): "([^"]+)",?$/gm)].map((m) => [m[1], m[2]]));
}

export function parseEvents(source: string, file: string): string[] {
  const body = block(source, /export interface RendererEvents \{/, file);
  return [...body.matchAll(/^\s*"([^"]+)":/gm)].map((m) => m[1]);
}

const TYPE_LEVEL_DIFF = `
type Eq<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type OrSelf<X, P> = [X] extends [never] ? P : X;
type Nullish = null | undefined;
type IsObject<T> = [T] extends [readonly unknown[]]
  ? false
  : [T] extends [(...args: never[]) => unknown]
    ? false
    : [T] extends [object]
      ? true
      : false;
type OptionalKeys<T> = { [K in keyof T]-?: {} extends Pick<T, K> ? K : never }[keyof T];
type StringKeys<T> = keyof T & string;
type ObjectDiff<A, B, P extends string> =
  | { [K in Exclude<StringKeys<A>, StringKeys<B>>]: \`\${P}.\${K}: missing from the bindings\` }[Exclude<StringKeys<A>, StringKeys<B>>]
  | { [K in Exclude<StringKeys<B>, StringKeys<A>>]: \`\${P}.\${K}: not in api.ts\` }[Exclude<StringKeys<B>, StringKeys<A>>]
  | { [K in StringKeys<A> & StringKeys<B>]: Eq<K extends OptionalKeys<A> ? 1 : 0, K extends OptionalKeys<B> ? 1 : 0> extends true
        ? Diff<A[K], B[K], \`\${P}.\${K}\`>
        : \`\${P}.\${K}: optional on one side only\` }[StringKeys<A> & StringKeys<B>];
type ArrayDiff<A extends readonly unknown[], B extends readonly unknown[], P extends string> =
  number extends A["length"]
    ? number extends B["length"] ? Diff<A[number], B[number], \`\${P}[]\`> : P
    : Eq<A["length"], B["length"]> extends true
      ? { [K in keyof A & \`\${number}\`]: Diff<A[K], K extends keyof B ? B[K] : never, \`\${P}[\${K}]\`> }[keyof A & \`\${number}\`]
      : \`\${P}: \${A["length"]} arguments in api.ts, \${B["length"]} in the bindings\`;
type Inner<A, B, P extends string> = [A] extends [readonly unknown[]]
  ? [B] extends [readonly unknown[]] ? ArrayDiff<A, B, P> : P
  : Eq<Extract<A, Nullish>, Extract<B, Nullish>> extends true
    ? Eq<A, Exclude<A, Nullish>> extends true
      ? IsObject<A> extends true ? IsObject<B> extends true ? ObjectDiff<A, B, P> : P : P
      : Diff<Exclude<A, Nullish>, Exclude<B, Nullish>, P>
    : \`\${P}: null or undefined on one side only\`;
type Diff<A, B, P extends string> = Eq<A, B> extends true ? never : OrSelf<Inner<A, B, P>, P>;
// Joins every mismatch into one literal, since tsc reports one member of a union
type UnionToIntersection<U> = (U extends unknown ? (k: U) => void : never) extends (k: infer I) => void ? I : never;
type LastOf<U> = UnionToIntersection<U extends unknown ? () => U : never> extends () => infer R ? R : never;
type Join<U, Acc extends string = ""> = [U] extends [never]
  ? Acc
  : LastOf<U> extends infer L extends string
    ? Join<Exclude<U, L>, Acc extends "" ? L : \`\${Acc}\${typeof SEPARATOR}\${L}\`>
    : Acc;
declare const SEPARATOR: " ;; ";
type Problems<U> = [U] extends [never] ? never : Join<U>;
type Check<T extends never> = T;
`;

export interface CheckResult {
  ok: boolean;
  commands: number;
  events: number;
  problems: string[];
}

function importPath(from: string, file: string): string {
  const relative = path.relative(from, file).replace(/\\/g, "/").replace(/\.ts$/, "");
  return relative.startsWith(".") ? relative : `./${relative}`;
}

export function checkContract(options: { bindings?: string; shared?: string } = {}): CheckResult {
  const bindingsFile = path.resolve(options.bindings ?? DEFAULT_BINDINGS);
  const sharedFile = path.resolve(options.shared ?? DEFAULT_SHARED);
  const bindings = fs.readFileSync(bindingsFile, "utf8");
  const shared = fs.readFileSync(sharedFile, "utf8");
  const problems: string[] = [];

  const expectedChannels = parseChannels(shared, "INVOKE_CHANNELS", sharedFile);
  const actualChannels = parseChannels(bindings, "CHANNELS", bindingsFile);
  for (const [method, channel] of expectedChannels) {
    const actual = actualChannels.get(method);
    if (actual === undefined) problems.push(`${method}: missing from the bindings`);
    else if (actual !== channel)
      problems.push(`${method}: channel ${actual}, api.ts has ${channel}`);
  }
  for (const method of actualChannels.keys()) {
    if (!expectedChannels.has(method)) problems.push(`${method}: not in api.ts`);
  }
  const expectedEvents = parseEvents(shared, sharedFile);
  const actualEvents = parseEvents(bindings, bindingsFile);
  for (const event of expectedEvents) {
    if (!actualEvents.includes(event)) problems.push(`event ${event}: missing from the bindings`);
  }
  for (const event of actualEvents) {
    if (!expectedEvents.includes(event)) problems.push(`event ${event}: not in api.ts`);
  }

  const methods = [...expectedChannels.keys()].filter((m) => actualChannels.has(m));
  const events = expectedEvents.filter((e) => actualEvents.includes(e));
  // Inside node_modules, so the bindings' own imports resolve from the copy
  const scratch = fs.mkdtempSync(path.join(TAURI_DIR, "node_modules", ".contract-check-"));
  try {
    const lines = [
      `import type { ElectronAPI, RendererEvents as SharedEvents } from "${importPath(scratch, sharedFile)}";`,
      `import type { createCommands, RendererEvents as BoundEvents } from "${importPath(scratch, bindingsFile)}";`,
      `type Commands = ReturnType<typeof createCommands>;`,
      TYPE_LEVEL_DIFF,
      ...methods.flatMap((m, i) => [
        `type A${i} = Check<Problems<Diff<Parameters<ElectronAPI["${m}"]>, Parameters<Commands["${m}"]>, "${m} arguments">>>;`,
        `type R${i} = Check<Problems<Diff<Awaited<ReturnType<ElectronAPI["${m}"]>>, Awaited<ReturnType<Commands["${m}"]>>, "${m} result">>>;`,
      ]),
      ...events.map(
        (e, i) =>
          `type E${i} = Check<Problems<Diff<SharedEvents["${e}"], BoundEvents["${e}"], "event ${e}">>>;`,
      ),
    ];
    fs.writeFileSync(path.join(scratch, "check.ts"), `${lines.join("\n")}\n`);
    fs.writeFileSync(
      path.join(scratch, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "bundler",
          lib: ["ES2023", "DOM"],
          types: [],
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          noUnusedLocals: false,
          noErrorTruncation: true,
        },
        files: ["check.ts"],
      }),
    );
    const tsc = path.join(
      TAURI_DIR,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "tsc.exe" : "tsc",
    );
    const run = spawnSync(tsc, ["-p", path.join(scratch, "tsconfig.json")], {
      encoding: "utf8",
      shell: process.platform === "win32",
    });
    if (run.error) throw run.error;
    const output = `${run.stdout}${run.stderr}`;
    const found = output
      .split("\n")
      .filter((line) =>
        /(does not satisfy the constraint|is not assignable to type) 'never'/.test(line),
      );
    for (const line of found) {
      const literal = /Type '"(.*)"' (?:does not satisfy|is not assignable)/.exec(line)?.[1];
      for (const problem of literal?.split(" ;; ") ?? []) {
        if (!problems.includes(problem)) problems.push(problem);
      }
    }
    if (run.status !== 0 && found.length === 0) {
      problems.push(`tsc failed on the contract assertions:\n${output.trim()}`);
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  return { ok: problems.length === 0, commands: methods.length, events: events.length, problems };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const value = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
  const result = checkContract({ bindings: value("--bindings"), shared: value("--shared") });
  if (result.ok) {
    console.log(`contract matches, ${result.commands} commands, ${result.events} events`);
  } else {
    for (const problem of result.problems) console.error(`contract mismatch: ${problem}`);
    process.exit(1);
  }
}
