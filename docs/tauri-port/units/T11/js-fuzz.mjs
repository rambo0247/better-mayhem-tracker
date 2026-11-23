// Writes Node's answers for the JavaScript semantics db/js.rs ports, for the
// ignored `js_semantics_match_node` test in tauri/src-tauri/tests/db_compat.rs.
// Built on the T11 verifier's gen.mjs and gen2.mjs.
//   node js-fuzz.mjs <out dir>
// numbers.txt: "<f64 bits hex> <String(x)>" per line.
// json.json: [{ text, want, wantBound }], where want is
// JSON.stringify(JSON.parse(text)) and wantBound is the same with every lone
// surrogate replaced by U+FFFD, as better-sqlite3 binds it.
// to-number.json: [[text, <f64 bits hex of Number(text)>]], NaN as "nan".
import fs from "node:fs";

const out = process.argv[2];
let seed = 12345;
const rnd = () => {
  seed = (seed * 1103515245 + 12345) >>> 0;
  return seed;
};
const unit = () => rnd() / 2 ** 32;
const dv = new DataView(new ArrayBuffer(8));
const bits = (x) => {
  dv.setFloat64(0, x);
  return dv.getBigUint64(0).toString(16);
};

const nums = [];
for (let i = 0; i < 200000; i++) {
  dv.setUint32(0, rnd());
  dv.setUint32(4, rnd());
  const x = dv.getFloat64(0);
  if (Number.isFinite(x)) nums.push(x);
}
for (let i = 0; i < 100000; i++) nums.push((rnd() % 100000) / [1, 10, 100, 1000, 7, 3][i % 6]);
for (let i = 0; i < 50000; i++) nums.push(rnd() * 2 ** (rnd() % 40));
const kinds = [
  () => Math.round(unit() * 40) / Math.max(1, Math.round(unit() * 15)),
  () => unit(),
  () => Math.round(unit() * 1e7) / 100,
  () => unit() * 1e12,
  () => Math.floor(unit() * 2 ** 53),
  () => unit() * 1e-5,
];
for (const kind of kinds) for (let i = 0; i < 50000; i++) nums.push(kind());
nums.push(0, -0, 5e-324, -5e-324, Number.MAX_VALUE, Number.MIN_VALUE, 2 ** 53, 2 ** 53 + 2, 1e21, 1e-7, 123e-20);
fs.writeFileSync(`${out}/numbers.txt`, nums.map((x) => `${bits(x)} ${String(x)}`).join("\n"));

const wellFormed = (v) =>
  typeof v === "string"
    ? v.toWellFormed()
    : Array.isArray(v)
      ? v.map(wellFormed)
      : v && typeof v === "object"
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k.toWellFormed(), wellFormed(x)]))
        : v;

const texts = [];
for (let i = 0; i < 100000; i++) {
  const x = nums[i];
  texts.push(JSON.stringify([x]), `[${x.toPrecision(21)}]`, `[${x.toExponential(19)}]`);
}
for (let i = 350000; i < nums.length; i += 3) texts.push(JSON.stringify([nums[i]]));
const UNITS = [0x41, 0x7f, 0xe9, 0x2028, 0xd800, 0xd83d, 0xdbff, 0xdc00, 0xde00, 0xdfff, 0x1f, 0x22, 0x5c];
for (let i = 0; i < 20000; i++) {
  let s = "";
  for (let n = rnd() % 6; n >= 0; n--) s += String.fromCharCode(UNITS[rnd() % UNITS.length]);
  const escaped = [...Array(s.length).keys()]
    .map((j) => (rnd() % 2 ? `\\u${s.charCodeAt(j).toString(16).padStart(4, "0")}` : JSON.stringify(s[j]).slice(1, -1)))
    .join("");
  texts.push(`["${escaped}"]`, `{"${escaped}":1}`);
}
const KEYS = ["0", "1", "2", "9", "10", "01", "-1", "1.5", "a", "b", "4294967294", "4294967295", "__proto__", "length"];
for (let i = 0; i < 20000; i++) {
  const keys = [];
  for (let n = rnd() % 6; n >= 0; n--) keys.push(KEYS[rnd() % KEYS.length]);
  texts.push(`{${keys.map((k, j) => `"${k}":${j}`).join(",")}}`);
}
texts.push(
  '{"a":1,"b":2,"a":3}',
  "[1e400,-1e400]",
  "[-0,0.0,-0.0,1E2,1e-7,123456789012345678901234567890]",
  `[${"[".repeat(120)}${"]".repeat(120)}]`,
  '{"participants":[{"stats":{"kills":1.0}}],"x":1.0000000000000002}',
  '["\\ud800\\u0041","\\ud83d\\nx","\\uD83D\\uDE00","\\ud83d\\ud83d\\ude00"]',
);

const PIECES = [
  ..."0123456789", ".", "e", "E", "+", "-", "x", "X", "o", "O", "b", "B", "a", "f", "F", "_", ",",
  " ", "\t", "\n", "\r", "\v", "\f", "\u00a0", "\u0085", "\u1680", "\u180e", "\u2000", "\u200a",
  "\u2028", "\u2029", "\u202f", "\u205f", "\u3000", "\ufeff", "\u200b", "\u0000",
  "Infinity", "infinity", "inf", "NaN", "nan", "0x", "0o", "0b", "1e", "e5", "00", "9007199254740993",
];
const strings = new Set(["", " ", "2450", " 2450 ", "0x10", "-0x10", "0x+1", "inf", "1e3", "1_000", ".5", "5.", "+.5", "-.e1", "0x1fffffffffffff1", "0b" + "1".repeat(70), "0o777777777777777777777"]);
while (strings.size < 200000) {
  let s = "";
  for (let n = rnd() % 5; n >= 0; n--) s += PIECES[rnd() % PIECES.length];
  strings.add(s);
}
const toNumber = [...strings].map((s) => {
  const x = Number(s);
  return [s, Number.isNaN(x) ? "nan" : bits(x)];
});
fs.writeFileSync(`${out}/to-number.json`, JSON.stringify(toNumber));

const results = texts.map((text) => {
  try {
    const v = JSON.parse(text);
    return { text, want: JSON.stringify(v), wantBound: JSON.stringify(wellFormed(v)) };
  } catch (e) {
    return { text, want: `THROW ${e.message}`, wantBound: `THROW ${e.message}` };
  }
});
fs.writeFileSync(`${out}/json.json`, JSON.stringify(results));
console.log(nums.length, "numbers,", results.length, "json cases");
