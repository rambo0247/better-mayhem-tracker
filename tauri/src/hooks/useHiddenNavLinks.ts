import { onSettled } from "solid-js";
import { hiddenNavLinks, loadHiddenNavLinks } from "../lib/navLinks";

/** The header links the user has switched off in Settings, kept current */
export function useHiddenNavLinks() {
  onSettled(() => {
    loadHiddenNavLinks().catch(() => {});
  });
  return hiddenNavLinks;
}
