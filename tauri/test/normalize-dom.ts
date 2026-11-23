// A rendered tree reduced to what both renders must agree on: element tags,
// attributes (class as a sorted set of tokens, style as sorted declarations)
// and text, with whitespace runs collapsed to one space but kept, since a
// space between two inline elements is drawn. Generated ids and the url(#id)
// references to them are blanked, since each renderer mints its own.

export type DomNode = string | { tag: string; attrs: Record<string, string>; children: DomNode[] };

function normalizeAttr(name: string, value: string): string {
  if (name === "class") return [...new Set(value.split(/\s+/).filter(Boolean))].sort().join(" ");
  if (name === "style") {
    return value
      .split(";")
      .map((d) => d.trim().replace(/\s*:\s*/, ":"))
      .filter(Boolean)
      .sort()
      .join(";");
  }
  if (name === "id") return "#";
  return value.replace(/url\(#[^)]*\)/g, "url(#)");
}

export function normalizeDom(node: Node, ignore: readonly string[] = []): DomNode[] {
  const out: DomNode[] = [];
  for (const child of node.childNodes) {
    if (child.nodeType === 3 || child.nodeType === 4) {
      const text = child.textContent ?? "";
      if (!text) continue;
      const last = out[out.length - 1];
      if (typeof last === "string") out[out.length - 1] = (last + text).replace(/\s+/g, " ");
      else out.push(text.replace(/\s+/g, " "));
      continue;
    }
    if (child.nodeType !== 1) continue;
    const el = child as Element;
    const attrs: Record<string, string> = {};
    for (const name of el.getAttributeNames().sort()) {
      if (ignore.includes(name)) continue;
      const value = normalizeAttr(name, el.getAttribute(name) ?? "");
      if (name === "class" && !value) continue;
      attrs[name] = value;
    }
    // A form control's live value is a property. React mirrors it into the
    // value attribute and Solid does not, which nothing on screen shows.
    if (["INPUT", "SELECT", "TEXTAREA"].includes(el.tagName)) {
      delete attrs.value;
      attrs[":value"] = (el as HTMLInputElement).value;
    }
    out.push({ tag: el.tagName.toLowerCase(), attrs, children: normalizeDom(el, ignore) });
  }
  return out;
}
