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

/** Splits a parameter list at its top-level commas. */
function splitTopLevel(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if ("([{<".includes(c)) depth++;
    else if (")]}".includes(c) || (c === ">" && list[i - 1] !== "=")) depth--;
    if (c === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else current += c;
  }
  if (current.trim()) parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** Each `name: (a: T, b?: U) => ...` member's parameter names, in order. */
export function parseParameterNames(source: string, file: string): Map<string, string[]> {
  const body = block(source, /export interface ElectronAPI \{/, file);
  const out = new Map<string, string[]>();
  for (const match of body.matchAll(/^ {2}(\w+): \(/gm)) {
    let depth = 1;
    let i = match.index + match[0].length;
    const from = i;
    for (; i < body.length && depth > 0; i++) {
      if (body[i] === "(") depth++;
      else if (body[i] === ")") depth--;
    }
    const names = splitTopLevel(body.slice(from, i - 1)).map((p) => /^(\w+)\??:/.exec(p)?.[1] ?? p);
    out.set(match[1], names);
  }
  return out;
}

export interface Wrapper {
  params: string[];
  named: string;
  positional: string[];
}

/** Each generated wrapper's parameters, the named object it sends, and its positional list. */
export function parseWrappers(source: string, file: string): Map<string, Wrapper> {
  const body = block(source, /export const createCommands = \(call: Transport\) => \(\{/, file);
  const out = new Map<string, Wrapper>();
  const wrapper =
    /^ {2}(\w+): \((.*)\): Promise<.*> =>\n {4}call<.*?>\("[^"]+", (\{[^}]*\}), \[([^\]]*)\]\)/gm;
  for (const m of body.matchAll(wrapper)) {
    const params = splitTopLevel(m[2]).map((p) => /^(\w+)\??:/.exec(p)?.[1] ?? p);
    out.set(m[1], { params, named: m[3], positional: splitTopLevel(m[4]) });
  }
  return out;
}

/** Argument names and order, which a function type does not carry. */
export function checkArgumentNames(
  expected: Map<string, string[]>,
  wrappers: Map<string, Wrapper>,
  methods: string[],
): string[] {
  const problems: string[] = [];
  const list = (names: string[]) => `(${names.join(", ")})`;
  for (const method of methods) {
    const names = expected.get(method);
    const wrapper = wrappers.get(method);
    if (!names || !wrapper) {
      problems.push(
        `${method}: no ${names ? "wrapper in the bindings" : "signature in api.ts"} to read its arguments from`,
      );
      continue;
    }
    if (list(names) !== list(wrapper.params)) {
      problems.push(
        `${method} arguments: api.ts names ${list(names)}, the bindings ${list(wrapper.params)}`,
      );
    }
    const named = wrapper.params.length === 0 ? "{}" : `{ ${wrapper.params.join(", ")} }`;
    if (wrapper.named !== named) {
      problems.push(
        `${method}: the wrapper sends ${wrapper.named}, not its arguments by name, ${named}`,
      );
    }
    if (list(wrapper.positional) !== list(wrapper.params)) {
      problems.push(
        `${method}: the wrapper passes [${wrapper.positional.join(", ")}] as Electron's positions, not [${wrapper.params.join(", ")}]`,
      );
    }
  }
  return problems;
}

/**
 * Every problem in tsc's output. A Check line carries the problems as one literal; any other
 * error, a Check line whose literal cannot be read, or a failing exit with nothing read, is a
 * problem in itself, so the check never passes on output it did not understand.
 */
export function parseDiagnostics(output: string, status: number | null): string[] {
  const problems: string[] = [];
  for (const line of output.split("\n").filter((l) => /error TS\d+:/.test(l))) {
    const isCheck = /(does not satisfy the constraint|is not assignable to type) 'never'/.test(
      line,
    );
    const literal = isCheck
      ? /Type '"(.*)"' (?:does not satisfy|is not assignable)/.exec(line)?.[1]
      : undefined;
    if (literal === undefined) {
      problems.push(`tsc: ${line.trim()}`);
      continue;
    }
    for (const problem of literal.replace(/\\"/g, '"').split(" ;; ")) {
      if (!problems.includes(problem)) problems.push(problem);
    }
  }
  if (status !== 0 && problems.length === 0) {
    problems.push(
      `tsc exited ${status} with no diagnostic the check could read:\n${output.trim()}`,
    );
  }
  return problems;
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
type UnionToIntersection<U> = (U extends unknown ? (k: U) => void : never) extends (k: infer I) => void ? I : never;
type IsUnion<T> = [T] extends [UnionToIntersection<T>] ? false : true;
type LastOf<U> = UnionToIntersection<U extends unknown ? () => U : never> extends () => infer R ? R : never;
type Join<U, Sep extends string, Acc extends string = ""> = [U] extends [never]
  ? Acc
  : LastOf<U> extends infer L extends string
    ? Join<Exclude<U, L>, Sep, Acc extends "" ? L : \`\${Acc}\${Sep}\${L}\`>
    : Acc;
type OptionalKeys<T> = { [K in keyof T]-?: {} extends Pick<T, K> ? K : never }[keyof T];
type StringKeys<T> = keyof T & string;
type ShowKey<T, K extends keyof T> = K extends OptionalKeys<T> ? \`\${K & string}?\` : K & string;
// A type as text: primitives and literals in full, objects by their keys
type ShowOne<T> = [T] extends [string]
  ? string extends T ? "string" : \`"\${T & string}"\`
  : [T] extends [number]
    ? number extends T ? "number" : \`\${T & number}\`
    : [T] extends [boolean]
      ? \`\${T & boolean}\`
      : [T] extends [null]
        ? "null"
        : [T] extends [undefined]
          ? "undefined"
          : [T] extends [void]
            ? "void"
            : [T] extends [readonly (infer E)[]]
              ? \`\${ShowFlat<E>}[]\`
              : [T] extends [(...args: never[]) => unknown]
                ? "function"
                : \`{ \${Join<{ [K in keyof T]-?: ShowKey<T, K> }[keyof T], ", ">} }\`;
type ShowFlat<T> = IsUnion<T> extends true ? "(union)" : ShowOne<T>;
type Show<T> = [T] extends [never] ? "never" : [boolean] extends [T] ? Join<ShowOne<Exclude<T, boolean>> | "boolean", " | "> : Join<T extends unknown ? ShowOne<T> : never, " | ">;
type Differs<A, B, P extends string> = \`\${P}: \${Show<A>} in api.ts, \${Show<B>} in the bindings\`;
type Side<A, B> = \`optional in \${A extends 1 ? "api.ts" : "the bindings"}, required in \${A extends 1 ? "the bindings" : "api.ts"}\`;
type ObjectDiff<A, B, P extends string> =
  | { [K in Exclude<StringKeys<A>, StringKeys<B>>]: \`\${P}.\${K}: missing from the bindings\` }[Exclude<StringKeys<A>, StringKeys<B>>]
  | { [K in Exclude<StringKeys<B>, StringKeys<A>>]: \`\${P}.\${K}: not in api.ts\` }[Exclude<StringKeys<B>, StringKeys<A>>]
  | { [K in StringKeys<A> & StringKeys<B>]: Eq<K extends OptionalKeys<A> ? 1 : 0, K extends OptionalKeys<B> ? 1 : 0> extends true
        ? Diff<A[K], B[K], \`\${P}.\${K}\`>
        : \`\${P}.\${K}: \${Side<K extends OptionalKeys<A> ? 1 : 0, 0>}\` }[StringKeys<A> & StringKeys<B>];
// Members of a union of objects, each matched to an equal member on the other side
type Unmatched<A, B> = A extends unknown ? (true extends (B extends unknown ? Eq<A, B> : never) ? never : A) : never;
type UnionDiff<A, B, P extends string> =
  | (Unmatched<A, B> extends infer M ? M extends unknown ? \`\${P}: api.ts's member \${ShowOne<M>} has no match in the bindings\` : never : never)
  | (Unmatched<B, A> extends infer M ? M extends unknown ? \`\${P}: the bindings' member \${ShowOne<M>} is not in api.ts\` : never : never);
type Count<T extends readonly unknown[]> = Required<T>["length"];
type TupleDiff<A extends readonly unknown[], B extends readonly unknown[], P extends string> =
  Eq<Count<A>, Count<B>> extends true
    ? { [K in keyof Required<A> & \`\${number}\`]: Eq<K extends OptionalKeys<A> ? 1 : 0, K extends OptionalKeys<B> ? 1 : 0> extends true
          ? Diff<Required<A>[K], K extends keyof Required<B> ? Required<B>[K] : never, \`\${P}[\${K}]\`>
          : \`\${P}[\${K}]: \${Side<K extends OptionalKeys<A> ? 1 : 0, 0>}\` }[keyof Required<A> & \`\${number}\`]
    : \`\${P}: \${Count<A> & number} arguments in api.ts, \${Count<B> & number} in the bindings\`;
type ArrayDiff<A extends readonly unknown[], B extends readonly unknown[], P extends string> =
  number extends A["length"]
    ? number extends B["length"] ? Diff<A[number], B[number], \`\${P}[]\`> : Differs<A, B, P>
    : number extends B["length"] ? Differs<A, B, P> : TupleDiff<A, B, P>;
type Inner<A, B, P extends string> = [A] extends [readonly unknown[]]
  ? [B] extends [readonly unknown[]] ? ArrayDiff<A, B, P> : Differs<A, B, P>
  : Eq<Extract<A, Nullish>, Extract<B, Nullish>> extends true
    ? Eq<A, Exclude<A, Nullish>> extends true
      ? IsUnion<A> extends true ? UnionOrLeaf<A, B, P>
        : IsUnion<B> extends true ? UnionOrLeaf<A, B, P>
        : IsObject<A> extends true ? IsObject<B> extends true ? ObjectDiff<A, B, P> : Differs<A, B, P> : Differs<A, B, P>
      : Diff<Exclude<A, Nullish>, Exclude<B, Nullish>, P>
    : Differs<A, B, P>;
type UnionOrLeaf<A, B, P extends string> = [Extract<A | B, object>] extends [never] ? Differs<A, B, P> : UnionDiff<A, B, P>;
type Diff<A, B, P extends string> = Eq<A, B> extends true ? never : OrSelf<Inner<A, B, P>, Differs<A, B, P>>;
// Joins every mismatch into one literal, since tsc reports one member of a union
declare const SEPARATOR: " ;; ";
type Problems<U> = [U] extends [never] ? never : Join<U, typeof SEPARATOR>;
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
    const names = parseParameterNames(shared, sharedFile);
    const label = (problem: string) =>
      problem.replace(/^(\w+) arguments\[(\d+)\]/, (whole, method: string, index: string) => {
        const name = names.get(method)?.[Number(index)];
        return name ? `${whole} ${name}` : whole;
      });
    for (const problem of parseDiagnostics(`${run.stdout}${run.stderr}`, run.status)) {
      problems.push(label(problem));
    }
    problems.push(...checkArgumentNames(names, parseWrappers(bindings, bindingsFile), methods));
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
