import { settle } from "./render";

// The app's dropdowns (components/Select.tsx) are a button that opens a
// listbox on document.body. These drive them the way a player does.

export function dropdowns(root: ParentNode): HTMLButtonElement[] {
  return [...root.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="listbox"]')];
}

// The dropdown whose shown choice, or one of whose choices, includes `text`
export function dropdown(root: ParentNode, text: string): HTMLButtonElement {
  const found = dropdowns(root).find((b) => b.textContent?.includes(text));
  if (!found) throw new Error(`no dropdown showing "${text}"`);
  return found;
}

// The visible label of the chosen option
export function shown(button: HTMLButtonElement): string {
  return button.firstElementChild?.textContent ?? "";
}

export async function open(button: HTMLButtonElement) {
  if (button.getAttribute("aria-expanded") !== "true") button.click();
  await settle();
  return document.getElementById(button.getAttribute("aria-controls")!)!;
}

export async function optionLabels(button: HTMLButtonElement): Promise<string[]> {
  const list = await open(button);
  const labels = [...list.querySelectorAll('[role="option"]')].map((o) => o.textContent ?? "");
  button.click();
  await settle();
  return labels;
}

export async function pick(button: HTMLButtonElement, label: string) {
  const list = await open(button);
  const option = [...list.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (o) => o.textContent === label,
  );
  if (!option) throw new Error(`no option "${label}"`);
  option.click();
  await settle();
}
