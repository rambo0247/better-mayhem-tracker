// Counts the React patterns a Solid port must not carry, per file, and fails
// when tauri/src has any. `bun scripts/react-isms.ts` checks tauri/src and
// prints the React tree's counts beside it for reference.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export const PATTERNS = [
  "destructured props",
  "onChange on text inputs",
  "return null",
  "React hooks",
  "useEffect with []",
  "className",
  "camelCase style keys",
  "numeric style sizes",
] as const;

export type Pattern = (typeof PATTERNS)[number];
export type Counts = Record<Pattern, number>;

// React 19's use(promise or context) is a bare `use(` call
const REACT_HOOKS =
  /\buse(?:State|Effect|LayoutEffect|InsertionEffect|Memo|Callback|Ref|Context|Reducer|SyncExternalStore|Id|Transition|DeferredValue|ImperativeHandle|Optimistic|ActionState|FormStatus)\b|\buse(?=\s*\()/g;

// A type annotation or type parameters, as they sit between a name and `=`
// or before a parameter list
const TYPE = String.raw`(?:\s*:[^=;]*?)?`;
const GENERIC = String.raw`(?:<[^>]*>\s*)?`;

// Props destructured where a component takes or reads them: `function Card({`,
// `const Card = ({`, `const Card: Component<P> = <T,>({`, `export default ({`,
// and `const { title } = props` in the body
const DESTRUCTURED = new RegExp(
  [
    String.raw`\bfunction(?:\s+[A-Z]\w*)?\s*${GENERIC}\(\s*\{`,
    String.raw`\bconst\s+[A-Z]\w*${TYPE}\s*=\s*(?:async\s*)?${GENERIC}\(\s*\{`,
    String.raw`\bexport\s+default\s+(?:async\s*)?${GENERIC}\(\s*\{`,
    String.raw`\b(?:const|let|var)\s*\{[^}]*\}\s*=\s*props\b`,
  ].join("|"),
  "g",
);

// Text-like inputs, where Solid's onChange is the commit event and React's is
// every keystroke
const TEXT_INPUT_TYPES = new Set([
  "text",
  "search",
  "number",
  "range",
  "email",
  "password",
  "url",
  "tel",
]);

// Matched with hyphens dropped, so `marginTop` and `"margin-top"` both count
const SIZE_KEYS =
  /^(?:width|height|minwidth|maxwidth|minheight|maxheight|top|left|right|bottom|inset\w*|margin\w*|padding\w*|gap|rowgap|columngap|fontsize|border\w*radius|border\w*width|flexbasis)$/i;

// The end of the JSX tag that starts at `start`, skipping `>` inside braces and strings
function tagEnd(source: string, start: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < source.length; i++) {
    const c = source[i]!;
    if (quote) {
      if (c === quote && source[i - 1] !== "\\") quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0 && source[i - 1] !== "=") return i;
  }
  return source.length;
}

// The text between the braces that open at `open`
function braced(source: string, open: number): string {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(open + 1, i);
  }
  return source.slice(open + 1);
}

// The arguments of the call whose `(` is at `open`
function parenthesised(source: string, open: number): string {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "(") depth++;
    else if (source[i] === ")" && --depth === 0) return source.slice(open + 1, i);
  }
  return source.slice(open + 1);
}

function textInputOnChange(source: string): number {
  let count = 0;
  for (const match of source.matchAll(/<(input|textarea)\b/g)) {
    const tag = source.slice(match.index, tagEnd(source, match.index));
    if (!/\bonChange\s*=/.test(tag)) continue;
    const type = tag.match(/\btype\s*=\s*["']([\w-]+)["']/)?.[1] ?? "text";
    if (match[1] === "textarea" || TEXT_INPUT_TYPES.has(type)) count++;
  }
  return count;
}

function styleObjects(source: string): string[] {
  return [...source.matchAll(/\bstyle\s*=\s*\{\s*\{/g)].map((m) =>
    braced(source, source.indexOf("{", source.indexOf("{", m.index) + 1)),
  );
}

// Keys and values at the top level of an object literal's text
function entries(object: string): { key: string; value: string }[] {
  const out: { key: string; value: string }[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  const parts: string[] = [];
  for (let i = 0; i < object.length; i++) {
    const c = object[i]!;
    if (quote) {
      if (c === quote && object[i - 1] !== "\\") quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if ("({[".includes(c)) depth++;
    else if (")}]".includes(c)) depth--;
    else if (c === "," && depth === 0) {
      parts.push(object.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(object.slice(start));
  for (const part of parts) {
    const m = part.match(/^\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z_$][\w$]*))\s*:\s*([\s\S]*)$/);
    if (m) out.push({ key: (m[1] ?? m[2] ?? m[3])!, value: m[4]!.trim() });
  }
  return out;
}

interface FunctionBody {
  start: number;
  end: number;
  component: boolean;
}

// The block body of every function and arrow, and whether it is a component:
// named with a capital (`function Card`, `const Card = () => {`) or the
// default export. Unnamed arrows (callbacks) are not.
function functionBodies(source: string): FunctionBody[] {
  const bodies: FunctionBody[] = [];
  const add = (open: number, component: boolean) => {
    const body = braced(source, open);
    bodies.push({ start: open, end: open + body.length + 1, component });
  };
  for (const m of source.matchAll(/\bfunction\b\s*([A-Za-z_$][\w$]*)?\s*(?:<[^>]*>)?\s*\(/g)) {
    const params = source.indexOf("(", m.index + 8);
    const close = params + parenthesised(source, params).length + 1;
    const open = source.indexOf("{", close);
    if (open < 0) continue;
    const component = m[1]
      ? /^[A-Z]/.test(m[1])
      : /\bexport\s+default\s*$/.test(source.slice(0, m.index));
    add(open, component);
  }
  const head = new RegExp(
    String.raw`(?:\bconst\s+([A-Za-z_$][\w$]*)${TYPE}\s*=|\b(export\s+default))\s*(?:async\s*)?${GENERIC}(?:\([^()]*(?:\([^()]*\)[^()]*)*\)|[A-Za-z_$][\w$]*)${TYPE}\s*$`,
  );
  for (const m of source.matchAll(/=>\s*\{/g)) {
    const before = source.slice(Math.max(0, m.index - 400), m.index);
    const named = head.exec(before);
    const component = !!named && (named[2] !== undefined || /^[A-Z]/.test(named[1]!));
    add(source.indexOf("{", m.index), component);
  }
  return bodies;
}

// An early `return null` (or `return (null)`) whose nearest function is a
// component: Solid runs a component once, so it renders nothing for good.
// A helper returning null is fine.
function componentReturnNull(source: string): number {
  const bodies = functionBodies(source);
  let count = 0;
  for (const m of source.matchAll(/\breturn\s*(?:\(\s*null\s*\)|null)\s*(?:;|$|\n|\})/gm)) {
    const inside = bodies.filter((b) => b.start < m.index && m.index < b.end);
    const nearest = inside.reduce<FunctionBody | null>(
      (best, b) => (!best || b.start > best.start ? b : best),
      null,
    );
    if (nearest?.component) count++;
  }
  return count;
}

function useEffectWithEmptyDeps(source: string): number {
  let count = 0;
  for (const match of source.matchAll(/\buseEffect\s*\(/g)) {
    const args = parenthesised(source, source.indexOf("(", match.index));
    if (/,\s*\[\s*\]\s*,?\s*$/.test(args)) count++;
  }
  return count;
}

export function countReactIsms(source: string): Counts {
  const styles = styleObjects(source).flatMap(entries);
  return {
    "destructured props": [...source.matchAll(DESTRUCTURED)].length,
    "onChange on text inputs": textInputOnChange(source),
    "return null": componentReturnNull(source),
    "React hooks": [...source.matchAll(REACT_HOOKS)].length,
    "useEffect with []": useEffectWithEmptyDeps(source),
    className: [...source.matchAll(/\bclassName\b/g)].length,
    "camelCase style keys": styles.filter((s) => /^[a-z]+[A-Z]/.test(s.key)).length,
    // React appends px to a number; Solid writes it as given, so a size must be a string
    "numeric style sizes": styles.filter(
      (s) => SIZE_KEYS.test(s.key.replace(/-/g, "")) && !/^["'`]/.test(s.value),
    ).length,
  };
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

export function countTree(dir: string): { perFile: Map<string, Counts>; totals: Counts } {
  const perFile = new Map<string, Counts>();
  const totals = Object.fromEntries(PATTERNS.map((p) => [p, 0])) as Counts;
  for (const file of sourceFiles(dir)) {
    const counts = countReactIsms(readFileSync(file, "utf8"));
    perFile.set(relative(dir, file), counts);
    for (const p of PATTERNS) totals[p] += counts[p];
  }
  return { perFile, totals };
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "..");
  const solid = countTree(join(root, "src"));
  const reactDir = join(root, "..", "src", "renderer");
  const react = statSync(reactDir, { throwIfNoEntry: false }) ? countTree(reactDir) : null;

  console.log(`${"pattern".padEnd(26)}${"tauri/src".padStart(10)}${"React".padStart(8)}`);
  for (const p of PATTERNS) {
    const reference = react ? String(react.totals[p]) : "-";
    console.log(`${p.padEnd(26)}${String(solid.totals[p]).padStart(10)}${reference.padStart(8)}`);
  }
  const offenders = [...solid.perFile].filter(([, counts]) => PATTERNS.some((p) => counts[p] > 0));
  for (const [file, counts] of offenders) {
    const found = PATTERNS.filter((p) => counts[p] > 0).map((p) => `${p} ${counts[p]}`);
    console.error(`src/${file}: ${found.join(", ")}`);
  }
  if (offenders.length > 0) process.exit(1);
}
