import { expect, test } from "bun:test";
import { normalizeDom } from "./normalize-dom";

function tree(html: string) {
  const div = document.createElement("div");
  div.innerHTML = html;
  return normalizeDom(div);
}

const b = { tag: "b", attrs: {}, children: ["3"] };

test("a space between inline elements is kept, as the browser draws it", () => {
  expect(tree("<b>3</b> games")).toEqual([b, " games"]);
  expect(tree("<b>3</b>games")).toEqual([b, "games"]);
  expect(tree("<b>3</b>\n  <i>x</i>")).toEqual([b, " ", { tag: "i", attrs: {}, children: ["x"] }]);
});

test("whitespace runs collapse to one space, across split text nodes too", () => {
  const div = document.createElement("div");
  div.append("a  ", document.createComment(""), "  b");
  expect(normalizeDom(div)).toEqual(["a b"]);
});
