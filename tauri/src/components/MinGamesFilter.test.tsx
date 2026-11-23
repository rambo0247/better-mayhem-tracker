import { afterEach, expect, test } from "bun:test";
import { createSignal, flush } from "solid-js";
import { mount } from "../../test/render";
import MinGamesFilter from "./MinGamesFilter";

let view: ReturnType<typeof mount> | undefined;
afterEach(() => view?.dispose());

function setup(initial: number | undefined) {
  const [min, setMin] = createSignal(initial);
  view = mount(() => <MinGamesFilter value={min()} onChange={setMin} max={20} />);
  const [slider, field] = view.container.querySelectorAll("input");
  const type = (input: HTMLInputElement, text: string) => {
    input.value = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flush();
  };
  return { min, setMin, slider: slider!, field: field!, type };
}

test("the field starts on the minimum", () => {
  const { field } = setup(5);
  expect(field.value).toBe("5");
});

test("a number being typed stays while it passes through no minimum", () => {
  const { min, field, type } = setup(undefined);
  type(field, "1");
  expect([field.value, min()]).toEqual(["1", undefined]);
  type(field, "15");
  expect([field.value, min()]).toEqual(["15", 15]);
});

test("the field follows the slider and Reset", () => {
  const { min, setMin, slider, field, type } = setup(undefined);
  type(field, "15");
  type(slider, "8");
  expect([field.value, min()]).toEqual(["8", 8]);
  setMin(undefined);
  flush();
  expect(field.value).toBe("");
});
