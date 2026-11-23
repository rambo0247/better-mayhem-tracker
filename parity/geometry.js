(() => {
  // Paint servers and other SVG definitions draw nothing where they sit. WebKit still gives
  // their children boxes and Chromium does not (the register in README.md).
  const DEFINITIONS = new Set([
    "defs",
    "pattern",
    "clipPath",
    "mask",
    "symbol",
    "marker",
    "linearGradient",
    "radialGradient",
    "filter",
  ]);
  const truncates = (el) => {
    if (el.scrollWidth <= el.clientWidth) return false;
    const style = getComputedStyle(el);
    return style.textOverflow === "ellipsis" && style.overflowX !== "visible";
  };
  const out = [];
  const walk = (el, path, inEllipsis) => {
    if (el instanceof SVGElement && DEFINITIONS.has(el.tagName)) return;
    const r = el.getBoundingClientRect();
    // A clipping wrapper the Tauri UI adds around one element (ChampionIcon's
    // crop) stands in for that element: Electron drew it as the element alone.
    const stand = el.hasAttribute("data-parity-skip") ? el.firstElementChild : null;
    if (r.width || r.height) {
      const row = [
        path,
        (stand ?? el).tagName,
        +r.x.toFixed(2),
        +r.y.toFixed(2),
        +r.width.toFixed(2),
        +r.height.toFixed(2),
      ];
      if (inEllipsis) row.push("ellipsis");
      // Register rule E needs to know when an image is drawn at other than its natural size
      if (!stand && el.tagName === "IMG" && el.naturalWidth > 0) {
        row.push({ image: [el.naturalWidth, el.naturalHeight] });
      }
      out.push(row);
    }
    const childInEllipsis = inEllipsis || (el !== document.body && truncates(el));
    [...(stand ?? el).children].forEach((child, i) => walk(child, path + "/" + i, childInEllipsis));
  };
  walk(document.body, "b", false);
  return JSON.stringify(out);
})();
