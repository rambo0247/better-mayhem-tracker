import { expect, test } from "bun:test";
import { countReactIsms, PATTERNS } from "./react-isms";

const REACT = `
import { useEffect, useState } from "react";
export default function Card({ title, size }: Props) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    load();
  }, []);
  if (!title) return null;
  return (
    <div className="card" style={{ width: size, marginTop: "4px" }}>
      <input type="text" value={title} onChange={(e) => setOpen(e.target.value === "")} />
    </div>
  );
}
`;

const SOLID = `
import { createSignal, Show } from "solid-js";
export default function Card(props: Props) {
  const [open, setOpen] = createSignal(false);
  return (
    <Show when={props.title}>
      <div class="card" style={{ width: \`\${props.size}px\`, "margin-top": "4px" }}>
        <input type="text" value={props.title} onInput={(e) => setOpen(e.currentTarget.value === "")} />
        <select onChange={() => setOpen(true)} />
        <input type="checkbox" onChange={() => setOpen(true)} />
      </div>
    </Show>
  );
}
`;

test("each React pattern is found in a fixture that has it", () => {
  const counts = countReactIsms(REACT);
  expect(counts).toEqual({
    "destructured props": 1,
    "onChange on text inputs": 1,
    "return null": 1,
    "React hooks": 4,
    "useEffect with []": 1,
    className: 1,
    "camelCase style keys": 1,
    "numeric style sizes": 1,
  });
});

test("the Solid way of writing the same component counts zero", () => {
  const counts = countReactIsms(SOLID);
  for (const pattern of PATTERNS) expect([pattern, counts[pattern]]).toEqual([pattern, 0]);
});
