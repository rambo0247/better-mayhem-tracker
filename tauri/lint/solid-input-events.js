const TEXT_TYPES = new Set(["text", "search", "email", "url", "tel", "password", "number"]);

function attribute(node, name) {
  return node.attributes.find(
    (attr) =>
      attr.type === "JSXAttribute" && attr.name.type === "JSXIdentifier" && attr.name.name === name,
  );
}

function staticValue(attr) {
  const value = attr.value?.type === "JSXExpressionContainer" ? attr.value.expression : attr.value;
  if (value?.type === "Literal" && typeof value.value === "string") return value.value;
  return undefined;
}

function entersText(node) {
  if (node.name.name === "textarea") return true;
  const type = attribute(node, "type");
  if (!type) return !node.attributes.some((attr) => attr.type === "JSXSpreadAttribute");
  const value = staticValue(type);
  return value === undefined || TEXT_TYPES.has(value.toLowerCase());
}

const rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Solid's onChange fires when a value is committed, React's fires on every keystroke. Use onInput where the user types text.",
    },
    messages: {
      useOnInput:
        "onChange on <{{element}}> fires on commit in Solid, not per keystroke as in React. Use onInput for text entry.",
    },
    schema: [],
  },
  create(context) {
    return {
      JSXOpeningElement(node) {
        if (node.name.type !== "JSXIdentifier") return;
        if (node.name.name !== "input" && node.name.name !== "textarea") return;
        const handler = attribute(node, "onChange");
        if (handler && entersText(node)) {
          context.report({
            node: handler,
            messageId: "useOnInput",
            data: { element: node.name.name },
          });
        }
      },
    };
  },
};

export default {
  meta: { name: "solid-input-events" },
  rules: { "no-onchange-on-text-input": rule },
};
