export type Ecosystem = "npm" | "crate";

const EXACT_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

export function isExactPin(eco: Ecosystem, spec: string): boolean {
  return (
    EXACT_VERSION.test(eco === "crate" ? spec.replace(/^=\s*/, "") : spec) &&
    (eco === "npm" || spec.startsWith("="))
  );
}

export function pinnedVersion(eco: Ecosystem, spec: string): string {
  return eco === "crate" ? spec.replace(/^=\s*/, "") : spec;
}
