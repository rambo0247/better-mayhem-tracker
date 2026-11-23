(() => {
  const out = [];
  const walk = (el, path) => {
    const r = el.getBoundingClientRect();
    if (r.width || r.height) {
      out.push([
        path,
        el.tagName,
        +r.x.toFixed(2),
        +r.y.toFixed(2),
        +r.width.toFixed(2),
        +r.height.toFixed(2),
      ]);
    }
    [...el.children].forEach((child, i) => walk(child, path + "/" + i));
  };
  walk(document.body, "b");
  return JSON.stringify(out);
})();
