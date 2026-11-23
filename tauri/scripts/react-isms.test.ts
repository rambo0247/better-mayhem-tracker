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

test.each([
  [
    "a typed arrow",
    "const Card: Component<Props> = ({ title }) => <p>{title}</p>;",
    "destructured props",
  ],
  [
    "a generic arrow",
    "const List = <T,>({ items }: ListProps<T>) => <ul />;",
    "destructured props",
  ],
  [
    "a default-export arrow",
    "export default ({ title }: Props) => <p>{title}</p>;",
    "destructured props",
  ],
  [
    "props destructured in the body",
    "function Card(props: Props) {\n  const { title, size } = props;\n  return <p>{title}</p>;\n}",
    "destructured props",
  ],
  [
    "return (null)",
    "function Card(props: Props) {\n  if (!props.on) return (null);\n  return <p />;\n}",
    "return null",
  ],
  [
    "return null with no semicolon",
    "function Card(props: Props) {\n  if (!props.on) return null\n  return <p />;\n}",
    "return null",
  ],
  [
    "an arrow component's return null",
    "const Card = (props: Props) => {\n  if (!props.on) return null;\n  return <p />;\n};",
    "return null",
  ],
  [
    "React 19's use()",
    "function Card(props: Props) {\n  const data = use(props.promise);\n  return <p>{data}</p>;\n}",
    "React hooks",
  ],
  ["useOptimistic", "const [shown, add] = useOptimistic(items, merge);", "React hooks"],
  [
    "a number on a kebab size key",
    '<div style={{ "margin-top": 4, "padding-left": 2 }} />',
    "numeric style sizes",
  ],
] as const)("%s is counted", (_label, source, pattern) => {
  const counts = countReactIsms(source);
  expect([pattern, counts[pattern] > 0]).toEqual([pattern, true]);
});

test("a helper returning null is not an early return", () => {
  const source = `
function percentileLabel(challenge: Challenge): string | null {
  if (challenge.level === "NONE") return null;
  return "top";
}
export default function Card(props: Props) {
  const rows = () => props.items.map((item) => {
    if (!item) return null;
    return item.name;
  });
  return <p>{rows()}</p>;
}
`;
  expect(countReactIsms(source)["return null"]).toBe(0);
});
