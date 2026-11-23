import { afterEach, expect, test } from "bun:test";
import snapshots from "../../test/v1-dom-snapshots.json";
import { CASES } from "../../test/parity-cases";
import type { DomNode } from "../../test/normalize-dom";
import { mount } from "../../test/render";
import ChampionIcon from "./ChampionIcon";

// Electron drew the portrait with object-view-box: inset(6%), which shows the
// middle 88% of the art and drops its dark frame. The Solid tile has to show
// the same window of the art in a box of the same size.

let view: ReturnType<typeof mount> | undefined;
afterEach(() => view?.dispose());

const REACT = snapshots as unknown as Record<string, DomNode[]>;
const v1Img = (id: string) => (REACT[id] as [Exclude<DomNode, string>])[0];
const INSET = Number(/inset\(([\d.]+)%\)/.exec(v1Img("ChampionIcon").attrs.style!)![1]) / 100;

// A length in the img's style, in px, for a tile `tile` px wide
function length(value: string, tile: number): number {
  const calc = /^calc\((-?[\d.]+)% \/ ([\d.]+)\)$/.exec(value);
  if (calc) return ((Number(calc[1]) / 100) * tile) / Number(calc[2]);
  const px = /^(-?[\d.]+)px$/.exec(value);
  if (px) return Number(px[1]);
  throw new Error(`unexpected length ${value}`);
}

for (const size of [24, 32, 40, 72]) {
  test(`a ${size} px tile shows the art inside React's inset`, () => {
    view = mount(() => <ChampionIcon championId={1} size={size} />);
    const tile = view.container.firstElementChild as HTMLElement;
    expect(tile.tagName).toBe("SPAN");
    expect([tile.style.width, tile.style.height]).toEqual([`${size}px`, `${size}px`]);
    for (const cls of ["relative", "block", "overflow-hidden"]) {
      expect(tile.classList.contains(cls)).toBe(true);
    }

    const art = tile.firstElementChild as HTMLImageElement;
    expect(art.style.position).toBe("absolute");
    expect(art.style.maxWidth).toBe("none");
    for (const [offset, extent] of [
      [art.style.left, art.style.width],
      [art.style.top, art.style.height],
    ] as const) {
      const drawn = length(extent!, size);
      const shift = length(offset!, size);
      // The part of the art inside the tile, as fractions of the art
      expect(-shift / drawn).toBeCloseTo(INSET, 6);
      expect((size - shift) / drawn).toBeCloseTo(1 - INSET, 6);
    }
  });
}

for (const c of CASES.filter((c) => c.file === "ChampionIcon")) {
  test(`${c.id} tile carries what React's img did`, () => {
    const img = v1Img(c.id);
    view = mount(() => <ChampionIcon {...(c.props as { championId: number })} />);
    const tile = view.container.firstElementChild as HTMLElement;
    const art = tile.firstElementChild as HTMLImageElement;

    const own = ["relative", "block", "overflow-hidden"];
    const classes = [...tile.classList].filter((cls) => !own.includes(cls)).sort();
    expect(classes.join(" ")).toBe(img.attrs.class!);
    expect(tile.getAttribute("title") ?? undefined).toBe(img.attrs.title);
    expect(tile.style.width).toBe(`${img.attrs.width}px`);
    expect(tile.style.height).toBe(`${img.attrs.height}px`);
    expect(art.getAttribute("src")).toBe(img.attrs.src!);
    expect(art.getAttribute("alt")).toBe(img.attrs.alt!);
  });
}
