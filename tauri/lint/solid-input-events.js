const TEXT_ELEMENTS = new Set(["input", "textarea"]);

const rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Solid's onChange fires when a value is committed, React's fires on every keystroke. Use onInput on input and textarea.",
    },
    messages: {
      useOnInput:
        "onChange on <{{element}}> fires on commit in Solid, not per keystroke as in React. Use onInput.",
    },
    schema: [],
  },
  create(context) {
    return {
      JSXOpeningElement(node) {
        if (node.name.type !== "JSXIdentifier" || !TEXT_ELEMENTS.has(node.name.name)) return;
        for (const attr of node.attributes) {
          if (
            attr.type === "JSXAttribute" &&
            attr.name.type === "JSXIdentifier" &&
            attr.name.name === "onChange"
          ) {
            context.report({
              node: attr,
              messageId: "useOnInput",
              data: { element: node.name.name },
            });
          }
        }
      },
    };
  },
};

export default {
  meta: { name: "solid-input-events" },
  rules: { "no-onchange-on-text-input": rule },
};
